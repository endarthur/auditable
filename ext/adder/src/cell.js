// Python cell type handler: parseNames, findUses, execute
// adder v2 — pure JS interpreter, no WASM

import { adderParse } from './parse.js';
import { adderEval, AdderScope, AdderError } from './eval.js';
import { adderBuiltins, pyStr, pyRepr } from './builtins.js';

// ── parseNames: extract top-level defines from Python code ──

export function pythonParseNames(code) {
  const defines = new Set();
  const lines = code.split('\n');

  for (const line of lines) {
    // only column-0 (not indented)
    if (line.length === 0 || line[0] === ' ' || line[0] === '\t') continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') continue;

    let m;

    // def foo(...): / async def foo(...):
    m = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z_]\w*)/);
    if (m) { defines.add(m[1]); continue; }

    // class Foo:
    m = trimmed.match(/^class\s+([a-zA-Z_]\w*)/);
    if (m) { defines.add(m[1]); continue; }

    // from foo import x, y as z
    m = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
    if (m) {
      const parts = m[1].split(',');
      for (const part of parts) {
        const asMatch = part.trim().match(/(\w+)\s+as\s+(\w+)/);
        if (asMatch) defines.add(asMatch[2]);
        else {
          const name = part.trim().match(/^([a-zA-Z_]\w*)/);
          if (name) defines.add(name[1]);
        }
      }
      continue;
    }

    // import foo [as bar]
    m = trimmed.match(/^import\s+(\w+)(?:\s+as\s+(\w+))?/);
    if (m) { defines.add(m[2] || m[1]); continue; }

    // tuple unpacking: x, y = ... or a, *b, c = ... (must not start with keyword)
    m = trimmed.match(/^(\*?[a-zA-Z_]\w*(?:\s*,\s*\*?[a-zA-Z_]\w*)+)\s*=/);
    if (m && !_isPyKeyword(m[1].split(',')[0].trim().replace(/^\*/, ''))) {
      const names = m[1].split(',');
      for (const n of names) {
        const name = n.trim().replace(/^\*/, '');
        if (name && /^[a-zA-Z_]\w*$/.test(name)) defines.add(name);
      }
      continue;
    }

    // simple assignment: x = ... or x: type = ...
    m = trimmed.match(/^([a-zA-Z_]\w*)\s*(?::[^=]+=|=)/);
    if (m && !_isPyKeyword(m[1])) { defines.add(m[1]); continue; }
  }

  return defines;
}

const _pyKeywords = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
]);

function _isPyKeyword(name) { return _pyKeywords.has(name); }

// ── findUses: find which names from other cells this code references ──

export function pythonFindUses(code, allDefined) {
  const selfDefines = pythonParseNames(code);
  const uses = new Set();

  // strip comments and strings
  const stripped = _stripPython(code);

  for (const name of allDefined) {
    if (selfDefines.has(name)) continue;
    // word-boundary match
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(stripped)) uses.add(name);
  }
  return uses;
}

function _stripPython(code) {
  let out = '', i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i];

    if (ch === '#') {
      while (i < len && code[i] !== '\n') i++;
      continue;
    }

    let prefixLen = 0;
    if (/[fFrRbBuU]/.test(ch)) {
      let j = i;
      while (j < len && /[fFrRbBuU]/.test(code[j])) j++;
      if (j < len && (code[j] === '"' || code[j] === "'")) {
        prefixLen = j - i;
      }
    }

    if (ch === '"' || ch === "'" || prefixLen > 0) {
      i += prefixLen;
      if (i < len && (code[i] === '"' || code[i] === "'")) {
        const q = code[i];
        if (code[i + 1] === q && code[i + 2] === q) {
          i += 3;
          while (i < len) {
            if (code[i] === '\\') { i += 2; continue; }
            if (code[i] === q && code[i + 1] === q && code[i + 2] === q) { i += 3; break; }
            i++;
          }
        } else {
          i++;
          while (i < len && code[i] !== q && code[i] !== '\n') {
            if (code[i] === '\\') { i += 2; continue; }
            i++;
          }
          if (i < len && code[i] === q) i++;
        }
        out += ' ';
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

// ── execute: run Python cell code ──

export async function pythonExecute(code, scopeIn, cell) {
  // capture print output
  const outputParts = [];
  const printFn = (text) => outputParts.push(text);

  // parse
  const ast = adderParse(code);

  // create scope with builtins + upstream variables
  const scope = new AdderScope();
  const builtins = adderBuiltins(printFn);
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  for (const [k, v] of Object.entries(scopeIn)) scope.set(k, v);

  // evaluate
  let lastExpr;
  try {
    lastExpr = await adderEval(ast, scope);
  } catch (e) {
    if (e instanceof AdderError) throw e;
    throw e;
  }

  // extract defines
  const defines = {};
  const cellDefines = pythonParseNames(code);
  for (const name of cellDefines) {
    if (scope.vars.has(name)) {
      defines[name] = scope.vars.get(name);
    }
  }

  // build output
  const parts = [];
  const printOutput = outputParts.join('');
  if (printOutput) parts.push(printOutput.endsWith('\n') ? printOutput.slice(0, -1) : printOutput);
  if (lastExpr !== undefined && lastExpr !== null) {
    parts.push(pyRepr(lastExpr));
  }
  const output = parts.length ? parts.join('\n') : undefined;

  return { defines, output };
}

function _jsonReplacer(key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
