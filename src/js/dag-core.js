// ── DAG-CORE — pure code analysis and DAG operations (no DOM dependencies) ──
//
// Single source of truth for directives, name parsing, dependency analysis,
// and DAG construction. Zero imports — safe for Node.js headless use.
// dag.js re-exports everything and adds S.cells wrappers for the browser.

// ── directive helpers ──

function hasDirective(code, name) {
  return new RegExp(String.raw`^\s*(?:\/\/|#)\s*%${name}\b`, 'm').test(code);
}

function getDirective(code, name) {
  const m = code.match(new RegExp(String.raw`^\s*(?:\/\/|#)\s*%${name}\s+(.+)`, 'm'));
  return m ? m[1].trim() : null;
}

export const isManual    = code => hasDirective(code, 'manual');
export const isHidden    = code => hasDirective(code, 'hide');
export const isNorun     = code => hasDirective(code, 'norun');
export const isCollapsed = code => hasDirective(code, 'collapsed');
export const isBare      = code => hasDirective(code, 'bare');
export const parseCellName    = code => getDirective(code, 'cellName');
export const parseOutputId    = code => { const v = getDirective(code, 'outputId'); return v ? v.split(/\s+/)[0] : null; };
export const parseOutputClass = code => getDirective(code, 'outputClass');
export const isPrivate        = code => hasDirective(code, 'private');
export const isMcp            = code => /^\s*(?:\/\/|#)\s*%mcp(\s+r)?\s*$/m.test(code);
export const isMcpRw          = code => /^\s*(?:\/\/|#)\s*%mcp\s+rw\b/m.test(code);
export function parseMcpDescribe(code) {
  const m = code.match(/^\s*(?:\/\/|#)\s*%mcp\s+describe\s+"([^"]+)"/m);
  return m ? m[1] : null;
}
export const isMcpManifest = code => /^\s*(?:\/\/|#)\s*%mcp\s+manifest\b/m.test(code);
export function parseMcpFs(code) {
  const m = code.match(/^\s*(?:\/\/|#)\s*%mcp\s+fs(?::read)?\s+(.+)/m);
  if (!m) return null;
  const readOnly = /^\s*(?:\/\/|#)\s*%mcp\s+fs:read\b/m.test(code);
  const raw = m[1].trim();
  const prefix = raw === '*' ? '' : raw;
  return { prefix, readOnly };
}

// ── code analysis ──

function stripCommentsAndStrings(code) {
  let out = '', i = 0;
  while (i < code.length) {
    if (code[i] === "'") {
      out += '""'; i++;
      while (i < code.length && code[i] !== "'") { if (code[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (code[i] === '"') {
      out += '""'; i++;
      while (i < code.length && code[i] !== '"') { if (code[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (code[i] === '`') {
      i++;
      while (i < code.length && code[i] !== '`') {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          i += 2; let depth = 1; out += ' ';
          while (i < code.length && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) break; }
            out += code[i]; i++;
          }
          out += ' '; i++; continue;
        }
        i++;
      }
      i++; continue;
    }
    if (code[i] === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (code[i] === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length && !(code[i - 1] === '*' && code[i] === '/')) i++;
      i++; continue;
    }
    out += code[i]; i++;
  }
  return out;
}

function findMatchingBracket(str, start) {
  let depth = 1;
  for (let i = start + 1; i < str.length; i++) {
    if (str[i] === '{' || str[i] === '[') depth++;
    else if (str[i] === '}' || str[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractDestructuredNames(pattern, names) {
  let i = 0;
  while (i < pattern.length) {
    if (/[\s,]/.test(pattern[i])) { i++; continue; }
    if (pattern[i] === '.' && pattern[i + 1] === '.' && pattern[i + 2] === '.') {
      i += 3;
      const m = pattern.slice(i).match(/^(\w+)/);
      if (m) { names.add(m[1]); i += m[1].length; }
      continue;
    }
    if (pattern[i] === '{' || pattern[i] === '[') {
      const close = findMatchingBracket(pattern, i);
      if (close > 0) {
        extractDestructuredNames(pattern.slice(i + 1, close), names);
        i = close + 1;
      } else { i++; }
      continue;
    }
    const m = pattern.slice(i).match(/^(\w+)/);
    if (m) {
      i += m[1].length;
      while (i < pattern.length && /\s/.test(pattern[i])) i++;
      if (pattern[i] === ':') {
        i++;
        while (i < pattern.length && /\s/.test(pattern[i])) i++;
        if (pattern[i] === '{' || pattern[i] === '[') {
          const close = findMatchingBracket(pattern, i);
          if (close > 0) {
            extractDestructuredNames(pattern.slice(i + 1, close), names);
            i = close + 1;
          }
        } else {
          const rm = pattern.slice(i).match(/^(\w+)/);
          if (rm) { names.add(rm[1]); i += rm[1].length; }
        }
      } else {
        names.add(m[1]);
      }
      while (i < pattern.length && /\s/.test(pattern[i])) i++;
      if (pattern[i] === '=') {
        i++; let d = 0;
        while (i < pattern.length) {
          if (pattern[i] === '{' || pattern[i] === '[' || pattern[i] === '(') d++;
          else if (pattern[i] === '}' || pattern[i] === ']' || pattern[i] === ')') d--;
          else if (pattern[i] === ',' && d === 0) break;
          i++;
        }
      }
      continue;
    }
    i++;
  }
}

export function parseNames(code) {
  const defines = new Set();
  const stripped = stripCommentsAndStrings(code);
  let depth = 0, parenDepth = 0, i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (ch === '(') { parenDepth++; i++; continue; }
    if (ch === ')') { parenDepth--; i++; continue; }
    if (depth === 0 && parenDepth === 0) {
      const rest = stripped.slice(i);
      const dm = rest.match(/^(?:const|let|var)\s+(\w+)/);
      if (dm) {
        defines.add(dm[1]);
        let j = dm[0].length, d = 0, pd = 0, bd = 0;
        while (j < rest.length) {
          const ch = rest[j];
          if (ch === '{') d++; else if (ch === '}') d--;
          else if (ch === '(') pd++; else if (ch === ')') pd--;
          else if (ch === '[') bd++; else if (ch === ']') bd--;
          else if ((ch === ';' || ch === '\n') && d === 0 && pd === 0 && bd === 0) break;
          else if (ch === ',' && d === 0 && pd === 0 && bd === 0) {
            const after = rest.slice(j + 1).match(/^\s*(\w+)/);
            if (after) defines.add(after[1]);
          }
          j++;
        }
        i += j; continue;
      }
      const destruct = rest.match(/^(?:const|let|var)\s*[\{\[]/);
      if (destruct) {
        const openIdx = destruct[0].length - 1;
        const closeIdx = findMatchingBracket(rest, openIdx);
        if (closeIdx > 0) {
          extractDestructuredNames(rest.slice(openIdx + 1, closeIdx), defines);
          i += closeIdx + 1; continue;
        }
      }
      const fm = rest.match(/^function\s+(\w+)/);
      if (fm) { defines.add(fm[1]); i += fm[0].length; continue; }
    }
    i++;
  }
  return { defines };
}

export function findUses(code, allDefined, selfDefined) {
  const uses = new Set();
  const stripped = stripCommentsAndStrings(code);
  if (!selfDefined) selfDefined = parseNames(code).defines;
  const idRe = /\b([a-zA-Z_$]\w*)\b/g;
  let m;
  while ((m = idRe.exec(stripped))) {
    if (allDefined.has(m[1]) && !selfDefined.has(m[1])) uses.add(m[1]);
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

export function parseHtmlDefines(html) {
  const defines = new Set();
  const re = /<audit-(?:slider|dropdown|checkbox|text-input)\b[^>]*\bname="([^"]+)"/g;
  let m;
  while (m = re.exec(html)) defines.add(m[1]);
  return defines;
}

// ── parameterized DAG operations ──

/**
 * Build dependency graph from cells.
 * @param {Array} cells — ordered cell array
 * @param {Object} [cellTypes] — plugin type handlers (browser: window._cellTypes)
 * @param {Function} [analyzer] — optional AIR analyzer: (code, allDefined) → { defines, uses } | null
 * @returns {Map} allDefined — name → cell id
 */
export function buildDAG(cells, cellTypes, analyzer) {
  const allDefined = new Map();

  for (const c of cells) {
    if (c.type === 'code') {
      if (c.code !== c._parsedCode) {
        // Try AIR analysis first, fall back to regex
        let airResult = null;
        if (analyzer) {
          try { airResult = analyzer(c.code, null); } catch (e) { /* fallback */ }
        }
        if (airResult) {
          c.defines = airResult.defines;
          c._air = airResult.air;
          c._airAnalyzed = true;
        } else {
          c.defines = parseNames(c.code).defines;
          c._air = null;
          c._airAnalyzed = false;
        }
        c._parsedCode = c.code;
      }
    } else if (c.type === 'html') {
      if (c.code !== c._parsedCode) {
        c.defines = parseHtmlDefines(c.code);
        c._parsedCode = c.code;
      }
    } else if (c.type !== 'md' && c.type !== 'css' && !c._fallback) {
      const handler = cellTypes?.[c.type];
      if (handler?.parseNames && c.code !== c._parsedCode) {
        const result = handler.parseNames(c.code);
        c.defines = result instanceof Set ? result : new Set(result);
        c._parsedCode = c.code;
      }
    }
    if (c.defines) {
      for (const name of c.defines) allDefined.set(name, c.id);
    }
  }

  const definedNames = new Set(allDefined.keys());
  const definedKey = [...definedNames].sort().join(',');
  for (const c of cells) {
    if (c.type === 'code') {
      if (c.code !== c._usesCode || c._definedKey !== definedKey) {
        // If AIR analyzed this cell, re-analyze with full allDefined for accurate uses
        if (analyzer && c._airAnalyzed) {
          const airResult = analyzer(c.code, definedNames);
          if (airResult) {
            c.uses = airResult.uses;
            c._air = airResult.air;
          } else {
            c.uses = findUses(c.code, definedNames, c.defines);
            c._air = null;
            c._airAnalyzed = false;
          }
        } else {
          c.uses = findUses(c.code, definedNames, c.defines);
        }
        c._usesCode = c.code;
        c._definedKey = definedKey;
      }
    } else if (c.type === 'html' || c.type === 'md') {
      if (c.code !== c._usesCode || c._definedKey !== definedKey) {
        c.uses = findHtmlUses(c.code, definedNames);
        c._usesCode = c.code;
        c._definedKey = definedKey;
      }
    } else if (c.type !== 'css' && !c._fallback) {
      const handler = cellTypes?.[c.type];
      if (handler?.findUses) {
        if (c.code !== c._usesCode || c._definedKey !== definedKey) {
          const result = handler.findUses(c.code, definedNames);
          c.uses = result instanceof Set ? result : new Set(result);
          c._usesCode = c.code;
          c._definedKey = definedKey;
        }
      }
    }
  }

  return allDefined;
}

/**
 * BFS from dirty cells to find all downstream dependents. Returns IDs in document order.
 * @param {Array} cells — ordered cell array
 * @param {Array} dirtyIds — IDs of directly-triggered cells
 * @returns {Array} cell IDs that need execution
 */
export function topoSort(cells, dirtyIds) {
  const dependents = new Map();
  for (const c of cells) {
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
    const cell = cells.find(c => c.id === id);
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

  return cells.filter(c => needsRun.has(c.id)).map(c => c.id);
}
