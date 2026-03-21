// Python cell type handler: parseNames, findUses, execute

import { initInterpreter, flushStdout, flushStderr } from './init.js';

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

    // tuple unpacking: x, y = ... (must not start with keyword)
    m = trimmed.match(/^([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)+)\s*=/);
    if (m && !_isPyKeyword(m[1].split(',')[0].trim())) {
      const names = m[1].split(',');
      for (const n of names) {
        const name = n.trim();
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

// ── PyProxy → native JS conversion ──
// PyProxy (MicroPython's FFI wrapper) has .toJs() that recursively converts
// list → Array, dict → Object, primitives pass through. We detect PyProxy by
// the _ref property and grab the toJs static method from its constructor.
let _toJs = null;

function pyToJs(val) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object' && typeof val !== 'function') return val;
  // detect PyProxy: has _ref, is not a plain object/array
  if (val._ref !== undefined && val.constructor && val.constructor.toJs) {
    if (!_toJs) _toJs = val.constructor.toJs;
    return _toJs(val);
  }
  return val;
}

// ── execute: run Python cell code ──

export async function pythonExecute(code, scopeIn, cell) {
  const mp = await initInterpreter();

  // drain any stale output
  flushStdout();
  flushStderr();

  try {
    // build namespace from upstream scope in Python
    mp.runPython('_adder_ns = {}');
    for (const [k, v] of Object.entries(scopeIn)) {
      mp.globals.set('_adder_inject_v', v);
      mp.runPython(`_adder_ns["${k}"] = _adder_inject_v`);
    }
    try { mp.globals.delete('_adder_inject_v'); } catch {}

    // execute cell code
    mp.globals.set('_adder_code', code);
    const hasAwait = /\bawait\b/.test(code);
    let lastExpr;

    if (hasAwait) {
      // async path: wrap in async def with global declarations
      // so assignments flow back to ns without polluting __main__
      const defines = [...pythonParseNames(code)];
      mp.globals.set('_adder_defines', defines);
      // inject sys.modules imports into ns so they resolve inside the wrapper
      mp.runPython('import sys as _adder_sys');
      mp.runPython('for _m in _adder_sys.modules: _adder_ns.setdefault(_m, _adder_sys.modules[_m])');
      // build and exec the async wrapper
      mp.runPython('_adder_wrapper = _build_async_wrapper(_adder_code, _adder_defines)');
      mp.runPython('exec(compile(_adder_wrapper, "<cell>", "exec"), _adder_ns)');
      // await the wrapper function
      await mp.runPythonAsync('await _adder_ns["_adder_cell"]()');
      // extract last expression if present
      mp.runPython('_adder_result = _adder_ns.get("_adder_last_expr", None)');
      lastExpr = mp.globals.get('_adder_result');
      try { mp.globals.delete('_adder_defines'); } catch {}
    } else {
      // sync path: use _exec_cell with isolated namespace
      await mp.runPythonAsync('_adder_result = _exec_cell(_adder_code, _adder_ns)');
      lastExpr = mp.globals.get('_adder_result');
    }

    // collect stdout/stderr captured during execution
    const stdout = flushStdout();
    const stderr = flushStderr();

    // extract defines from namespace — convert PyProxy to native JS
    // (list → Array, dict → Object) so downstream JS/WASM gets native types.
    // Functions stay as PyProxy (callable from JS via FFI).
    const defines = {};
    const cellDefines = pythonParseNames(code);
    for (const name of cellDefines) {
      try {
        mp.runPython(`_adder_extract = _adder_ns.get("${name}", None)`);
        const val = mp.globals.get('_adder_extract');
        if (val !== undefined && val !== null) defines[name] = pyToJs(val);
      } catch {
        // name not in namespace (e.g. import failed)
      }
    }

    // build output: stdout lines + last expression
    const parts = [];
    if (stdout.length) parts.push(stdout.join('\n'));
    if (stderr.length) parts.push(stderr.join('\n'));
    if (lastExpr !== undefined && lastExpr !== null) {
      const jsExpr = pyToJs(lastExpr);
      parts.push(typeof jsExpr === 'object' ? JSON.stringify(jsExpr, null, 2) : String(jsExpr));
    }
    const output = parts.length ? parts.join('\n') : undefined;

    // cleanup
    try { mp.globals.delete('_adder_ns'); } catch {}
    try { mp.globals.delete('_adder_code'); } catch {}
    try { mp.globals.delete('_adder_result'); } catch {}
    try { mp.globals.delete('_adder_extract'); } catch {}

    return { defines, output };

  } catch (e) {
    // drain any output from the failed execution
    flushStdout();
    flushStderr();
    // clean up globals
    try { mp.globals.delete('_adder_ns'); } catch {}
    try { mp.globals.delete('_adder_code'); } catch {}
    try { mp.globals.delete('_adder_result'); } catch {}
    try { mp.globals.delete('_adder_extract'); } catch {}
    throw e;
  }
}
