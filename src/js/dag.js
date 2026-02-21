import { S } from './state.js';

// ── REACTIVE DAG ──

export function isManual(code) {
  return /^\s*\/\/\s*%manual\b/.test(code);
}

export function parseNames(code) {
  // extract ONLY top-level variable definitions (brace depth 0)
  const defines = new Set();

  // strip strings and comments first
  const stripped = code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""');

  let depth = 0;
  let parenDepth = 0;
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (ch === '(') { parenDepth++; i++; continue; }
    if (ch === ')') { parenDepth--; i++; continue; }

    if (depth === 0 && parenDepth === 0) {
      // check for const/let/var
      const rest = stripped.slice(i);
      const dm = rest.match(/^(?:const|let|var)\s+(\w+)/);
      if (dm) {
        defines.add(dm[1]);
        // scan forward for comma-separated declarations: const W = 80, H = 60
        // skip initializer expressions tracking depth, grab identifiers after commas
        let j = dm[0].length;
        let d = 0, pd = 0, bd = 0;
        while (j < rest.length) {
          const ch = rest[j];
          if (ch === '{') d++;
          else if (ch === '}') d--;
          else if (ch === '(') pd++;
          else if (ch === ')') pd--;
          else if (ch === '[') bd++;
          else if (ch === ']') bd--;
          else if (ch === ';' || ch === '\n') {
            if (d === 0 && pd === 0 && bd === 0) break;
          }
          else if (ch === ',' && d === 0 && pd === 0 && bd === 0) {
            // next identifier after comma
            const after = rest.slice(j + 1).match(/^\s*(\w+)/);
            if (after) defines.add(after[1]);
          }
          j++;
        }
        i += j;
        continue;
      }
      // destructuring: const { a, b } = ... or const [ a, b ] = ...
      const destruct = rest.match(/^(?:const|let|var)\s*[\{\[]/);
      if (destruct) {
        // find the closing } or ] then extract identifiers
        const opener = rest[destruct[0].length - 1];
        const closer = opener === '{' ? '}' : ']';
        const closeIdx = rest.indexOf(closer, destruct[0].length);
        if (closeIdx > 0) {
          const inner = rest.slice(destruct[0].length, closeIdx);
          // split on commas, take last word of each part (handles renaming)
          inner.split(',').forEach(part => {
            const parts = part.trim().split(/\s*:\s*/);
            const name = (parts.length > 1 ? parts[1] : parts[0]).trim().match(/^\w+/);
            if (name) defines.add(name[0]);
          });
          i += closeIdx + 1;
          continue;
        }
      }
      // check for function declarations
      const fm = rest.match(/^function\s+(\w+)/);
      if (fm) {
        defines.add(fm[1]);
        i += fm[0].length;
        continue;
      }
    }
    i++;
  }

  return { defines };
}

export function findUses(code, allDefined) {
  // find identifiers that reference other cells' definitions
  const uses = new Set();
  // strip strings and comments to avoid false matches
  const stripped = code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '""');

  const idRe = /\b([a-zA-Z_$]\w*)\b/g;
  let m;
  while ((m = idRe.exec(stripped))) {
    if (allDefined.has(m[1]) && !parseNames(code).defines.has(m[1])) {
      uses.add(m[1]);
    }
  }
  return uses;
}

export function findHtmlUses(code, allDefined) {
  const uses = new Set();
  const re = /\$\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(code))) {
    const expr = m[1];
    const idRe = /\b([a-zA-Z_$]\w*)\b/g;
    let im;
    while ((im = idRe.exec(expr))) {
      if (allDefined.has(im[1])) uses.add(im[1]);
    }
  }
  return uses;
}

export function buildDAG() {
  // collect all defined names globally
  const allDefined = new Map(); // name -> cell id
  for (const c of S.cells) {
    if (c.type !== 'code') continue;
    const { defines } = parseNames(c.code);
    c.defines = defines;
    for (const name of defines) {
      allDefined.set(name, c.id);
    }
  }

  // find uses for each cell
  const definedNames = new Set(allDefined.keys());
  for (const c of S.cells) {
    if (c.type === 'code') {
      c.uses = findUses(c.code, definedNames);
    } else if (c.type === 'html') {
      c.uses = findHtmlUses(c.code, definedNames);
    }
  }

  return allDefined;
}

export function topoSort(dirtyIds) {
  // from dirty cells, find all downstream dependents
  const allDefined = new Map();
  for (const c of S.cells) {
    if (c.type !== 'code') continue;
    for (const name of (c.defines || [])) {
      allDefined.set(name, c.id);
    }
  }

  // build adjacency: cell A defines x, cell B uses x -> A -> B
  const adj = new Map();
  const cellMap = new Map();
  for (const c of S.cells) {
    cellMap.set(c.id, c);
    if (c.type === 'code' || c.type === 'html') adj.set(c.id, []);
  }
  for (const c of S.cells) {
    if (c.type !== 'code' && c.type !== 'html') continue;
    for (const name of (c.uses || [])) {
      const src = allDefined.get(name);
      if (src !== undefined && src !== c.id && adj.has(src)) {
        adj.get(src).push(c.id);
      }
    }
  }

  // BFS from dirty cells to find all affected
  const affected = new Set(dirtyIds);
  const queue = [...dirtyIds];
  while (queue.length) {
    const id = queue.shift();
    for (const dep of (adj.get(id) || [])) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  // topological order among affected, respecting document order
  return S.cells
    .filter(c => (c.type === 'code' || c.type === 'html') && affected.has(c.id))
    .map(c => c.id);
}
