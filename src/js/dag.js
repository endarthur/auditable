import { S } from './state.js';

// ── REACTIVE DAG ──

// ── directive helpers ──

function hasDirective(code, name) {
  return new RegExp(String.raw`^\s*\/\/\s*%${name}\b`, 'm').test(code);
}

function getDirective(code, name) {
  const m = code.match(new RegExp(String.raw`^\s*\/\/\s*%${name}\s+(.+)`, 'm'));
  return m ? m[1].trim() : null;
}

export const isManual    = code => hasDirective(code, 'manual');
export const isHidden    = code => hasDirective(code, 'hide');
export const isNorun     = code => hasDirective(code, 'norun');
export const isCollapsed = code => hasDirective(code, 'collapsed');
export const parseCellName    = code => getDirective(code, 'cellName');
export const parseOutputId    = code => { const v = getDirective(code, 'outputId'); return v ? v.split(/\s+/)[0] : null; };
export const parseOutputClass = code => getDirective(code, 'outputClass');

// ── code analysis ──

function stripCommentsAndStrings(code) {
  // single-pass: strings take precedence over comments (// inside "..." is not a comment)
  let out = '', i = 0;
  while (i < code.length) {
    // single-quoted string
    if (code[i] === "'") {
      out += '""';
      i++;
      while (i < code.length && code[i] !== "'") { if (code[i] === '\\') i++; i++; }
      i++; // skip closing quote
      continue;
    }
    // double-quoted string
    if (code[i] === '"') {
      out += '""';
      i++;
      while (i < code.length && code[i] !== '"') { if (code[i] === '\\') i++; i++; }
      i++; // skip closing quote
      continue;
    }
    // template literal: replace string parts with spaces but keep ${expr} content
    if (code[i] === '`') {
      i++;
      while (i < code.length && code[i] !== '`') {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          i += 2;
          let depth = 1;
          out += ' ';
          while (i < code.length && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) break; }
            out += code[i];
            i++;
          }
          out += ' ';
          i++; // skip closing }
          continue;
        }
        i++;
      }
      i++; // skip closing backtick
      continue;
    }
    // line comment
    if (code[i] === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    // block comment
    if (code[i] === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length && !(code[i - 1] === '*' && code[i] === '/')) i++;
      i++;
      continue;
    }
    out += code[i];
    i++;
  }
  return out;
}

export function parseNames(code) {
  // extract ONLY top-level variable definitions (brace depth 0)
  const defines = new Set();

  const stripped = stripCommentsAndStrings(code);

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

export function findUses(code, allDefined, selfDefined) {
  // find identifiers that reference other cells' definitions
  const uses = new Set();
  const stripped = stripCommentsAndStrings(code);
  if (!selfDefined) selfDefined = parseNames(code).defines;

  const idRe = /\b([a-zA-Z_$]\w*)\b/g;
  let m;
  while ((m = idRe.exec(stripped))) {
    if (allDefined.has(m[1]) && !selfDefined.has(m[1])) {
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
  // collect all defined names globally (only re-parse changed cells)
  const allDefined = new Map(); // name -> cell id
  for (const c of S.cells) {
    if (c.type !== 'code') continue;
    if (c.code !== c._parsedCode) {
      const { defines } = parseNames(c.code);
      c.defines = defines;
      c._parsedCode = c.code;
    }
    for (const name of c.defines) {
      allDefined.set(name, c.id);
    }
  }

  // find uses for each cell (invalidate if code changed or global names changed)
  const definedNames = new Set(allDefined.keys());
  const definedKey = [...definedNames].sort().join(',');
  for (const c of S.cells) {
    if (c.type === 'code') {
      if (c.code !== c._usesCode || c._definedKey !== definedKey) {
        c.uses = findUses(c.code, definedNames, c.defines);
        c._usesCode = c.code;
        c._definedKey = definedKey;
      }
    } else if (c.type === 'html') {
      if (c.code !== c._usesCode || c._definedKey !== definedKey) {
        c.uses = findHtmlUses(c.code, definedNames);
        c._usesCode = c.code;
        c._definedKey = definedKey;
      }
    }
  }

  return allDefined;
}

export function topoSort(dirtyIds) {
  // BFS from dirty cells to find all downstream dependents
  const dependents = new Map(); // varName -> Set<cellId>
  for (const c of S.cells) {
    if (!c.uses) continue;
    for (const name of c.uses) {
      if (!dependents.has(name)) dependents.set(name, new Set());
      dependents.get(name).add(c.id);
    }
  }

  const needsRun = new Set(dirtyIds);
  const queue = [...dirtyIds];
  while (queue.length) {
    const id = queue.shift();
    const cell = S.cells.find(c => c.id === id);
    if (!cell || !cell.defines) continue;
    for (const name of cell.defines) {
      const deps = dependents.get(name);
      if (!deps) continue;
      for (const depId of deps) {
        if (!needsRun.has(depId)) {
          needsRun.add(depId);
          queue.push(depId);
        }
      }
    }
  }

  // return in document order
  return S.cells.filter(c => needsRun.has(c.id)).map(c => c.id);
}
