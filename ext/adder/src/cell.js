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

// ── findUses: walk the AST for Name nodes ──

export function pythonFindUses(code, allDefined) {
  const selfDefines = pythonParseNames(code);
  const uses = new Set();
  try {
    const ast = adderParse(code);
    _collectNames(ast, allDefined, selfDefines, uses);
  } catch {
    // parse error — fall back to regex scan (better than no DAG wiring)
    for (const name of allDefined) {
      if (!selfDefines.has(name) && new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(code)) uses.add(name);
    }
  }
  return uses;
}

function _collectNames(node, allDefined, selfDefines, uses) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Name' && allDefined.has(node.id) && !selfDefines.has(node.id)) uses.add(node.id);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) { for (const item of val) _collectNames(item, allDefined, selfDefines, uses); }
    else if (val && typeof val === 'object' && val.type) _collectNames(val, allDefined, selfDefines, uses);
  }
}

// ── execute: run Python cell code ──

export async function pythonExecute(code, scopeIn, cell) {
  // capture print output
  const outputParts = [];
  const printFn = (text) => outputParts.push(text);

  // parse
  const ast = adderParse(code);

  // create scope with builtins + upstream variables + cell context
  const scope = new AdderScope();
  const builtins = adderBuiltins(printFn);
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  for (const [k, v] of Object.entries(scopeIn)) scope.set(k, v);

  // inject cell context (ui, std, load, display, etc.) if available
  // these are the same builtins JS code cells get, created by _createCellContext
  const hasCtx = !!cell._ctx;
  if (hasCtx) {
    const ctx = cell._ctx;
    // override print to render directly to the output DOM (not buffered)
    // so print output coexists with canvases and other DOM content
    scope.set('print', (...args) => {
      let sep = ' ', end = '\n';
      if (args.length > 0 && args[args.length - 1]?._kw) { const kw = args.pop(); if (kw.sep !== undefined) sep = kw.sep; if (kw.end !== undefined) end = kw.end; }
      const text = args.map(pyStr).join(sep) + end;
      ctx.display(text.endsWith('\n') ? text.slice(0, -1) : text);
      return null;
    });
    // expose key builtins — skip internal/DOM-only ones
    const expose = ['ui', 'std', 'load', 'install', 'installBinary', 'display', 'invalidation', 'worker', 'workerPool', 'notebook'];
    for (const name of expose) {
      if (ctx[name] !== undefined) scope.set(name, ctx[name]);
    }
  }

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
  if (hasCtx) {
    // output already rendered to DOM via display() — show last expression too
    if (lastExpr !== undefined && lastExpr !== null) {
      if (typeof lastExpr === 'object' && typeof lastExpr._repr_html_ === 'function') cell._ctx.display(lastExpr);
      else cell._ctx.display(pyRepr(lastExpr));
    }
    return { defines };
  }
  // no cell context (standalone/test mode) — return output as string
  const parts = [];
  const printOutput = outputParts.join('');
  if (printOutput) parts.push(printOutput.endsWith('\n') ? printOutput.slice(0, -1) : printOutput);
  if (lastExpr !== undefined && lastExpr !== null) {
    parts.push(pyRepr(lastExpr));
  }
  return { defines, output: parts.length ? parts.join('\n') : undefined };
}

function _jsonReplacer(key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
