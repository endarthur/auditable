// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/adder/src/  Build: node ext/adder/build.js
// @gcu/adder — MicroPython extension for Auditable
// Python cells, mpy tagged template, AdderFinder import hook.

// -- bridge.js --

// Python source strings bootstrapped at interpreter init time
//
// AdderFinder is replaced by MicroPython's native registerJsModule().
// Extensions are registered at interpreter init time via
// mp.registerJsModule(name, exports) for each entry in
// window._auditableExtensions. No sys.meta_path hack needed.

const BRIDGE_PY = `
def _exec_cell(code, ns):
    """Execute cell in namespace. Returns last expression value or None."""
    lines = code.rstrip().splitlines()
    i = len(lines) - 1
    while i >= 0 and (not lines[i].strip() or lines[i].strip().startswith('#')):
        i -= 1
    if i >= 0 and len(lines[i]) > 0 and lines[i][0] not in (' ', chr(9)):
        last = lines[i]
        try:
            compile(last, '<expr>', 'eval')
            body = chr(10).join(lines[:i])
            if body.strip():
                exec(compile(body, '<cell>', 'exec'), ns)
            return eval(compile(last, '<cell>', 'eval'), ns)
        except SyntaxError:
            pass
    exec(compile(code, '<cell>', 'exec'), ns)
    return None

def _build_async_wrapper(code, defines):
    """Wrap cell code in async def with global declarations for defines.
    The wrapper function is exec'd with ns as globals, so 'global' pushes
    assignments back to ns — no __main__ pollution."""
    lines = code.rstrip().splitlines()
    # detect last expression
    last_expr = None
    i = len(lines) - 1
    while i >= 0 and (not lines[i].strip() or lines[i].strip().startswith('#')):
        i -= 1
    if i >= 0 and len(lines[i]) > 0 and lines[i][0] not in (' ', chr(9)):
        last = lines[i]
        try:
            compile(last, '<expr>', 'eval')
            last_expr = last
            lines = lines[:i]
        except SyntaxError:
            pass
    # build async def
    parts = ['async def _adder_cell():']
    if defines:
        parts.append('    global ' + ', '.join(defines))
    for line in lines:
        parts.append(('    ' + line) if line.strip() else '')
    if last_expr:
        parts.append('    global _adder_last_expr')
        parts.append('    _adder_last_expr = ' + last_expr)
    return chr(10).join(parts)
`;

// -- highlight.js --

// Python syntax tokenizer + completions

const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
];

const PYTHON_BUILTINS = [
  'abs', 'all', 'any', 'bin', 'bool', 'bytes', 'callable', 'chr',
  'dict', 'dir', 'divmod', 'enumerate', 'filter', 'float', 'format',
  'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'hex', 'id',
  'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list',
  'locals', 'map', 'max', 'min', 'next', 'object', 'oct', 'open',
  'ord', 'pow', 'print', 'range', 'repr', 'reversed', 'round', 'set',
  'setattr', 'slice', 'sorted', 'str', 'sum', 'super', 'tuple', 'type',
  'vars', 'zip',
];

const _kwSet = new Set(PYTHON_KEYWORDS);
const _builtinSet = new Set(PYTHON_BUILTINS);

// string prefixes: f, r, b, u and combinations
const _strPrefixRe = /^[fFrRbBuU]{0,3}$/;

function tokenizePython(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i];

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      const start = i;
      while (i < len && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n' || code[i] === '\r')) i++;
      tokens.push({ type: 'ws', text: code.slice(start, i) });
      continue;
    }

    // comment
    if (ch === '#') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }

    // decorator
    if (ch === '@' && (i === 0 || code[i - 1] === '\n')) {
      const start = i;
      i++;
      while (i < len && /[\w.]/.test(code[i])) i++;
      tokens.push({ type: 'dec', text: code.slice(start, i) });
      continue;
    }

    // strings — handle prefixes and triple/single quotes
    if (ch === '"' || ch === "'" || (_strPrefixRe.test(code.slice(Math.max(0, i - 3), i + 1).replace(/['"]/g, '')) && (code[i + 1] === '"' || code[i + 1] === "'"))) {
      // check for string prefix
      let prefixLen = 0;
      if (ch !== '"' && ch !== "'") {
        let j = i;
        while (j < len && /[fFrRbBuU]/.test(code[j])) j++;
        if (j < len && (code[j] === '"' || code[j] === "'")) {
          prefixLen = j - i;
        } else {
          // not a string, fall through to identifier
          prefixLen = 0;
        }
      }
      if (ch === '"' || ch === "'" || prefixLen > 0) {
        const start = i;
        i += prefixLen;
        if (i < len && (code[i] === '"' || code[i] === "'")) {
          const q = code[i];
          // triple quote?
          if (code[i + 1] === q && code[i + 2] === q) {
            i += 3;
            const end3 = q + q + q;
            while (i < len) {
              if (code[i] === '\\') { i += 2; continue; }
              if (code[i] === q && code[i + 1] === q && code[i + 2] === q) { i += 3; break; }
              i++;
            }
          } else {
            // single quote string
            i++;
            while (i < len && code[i] !== q && code[i] !== '\n') {
              if (code[i] === '\\') { i += 2; continue; }
              i++;
            }
            if (i < len && code[i] === q) i++;
          }
          tokens.push({ type: 'str', text: code.slice(start, i) });
          continue;
        }
      }
    }

    // numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      const start = i;
      if (ch === '0' && i + 1 < len && (code[i + 1] === 'x' || code[i + 1] === 'X' || code[i + 1] === 'o' || code[i + 1] === 'O' || code[i + 1] === 'b' || code[i + 1] === 'B')) {
        i += 2;
        while (i < len && /[\da-fA-F_]/.test(code[i])) i++;
      } else {
        while (i < len && /[\d_]/.test(code[i])) i++;
        if (i < len && code[i] === '.') { i++; while (i < len && /[\d_]/.test(code[i])) i++; }
        if (i < len && (code[i] === 'e' || code[i] === 'E')) { i++; if (i < len && (code[i] === '+' || code[i] === '-')) i++; while (i < len && /[\d_]/.test(code[i])) i++; }
      }
      if (i < len && (code[i] === 'j' || code[i] === 'J')) i++;
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }

    // identifiers / keywords / builtins
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < len && /[\w]/.test(code[i])) i++;
      const word = code.slice(start, i);

      // check if this is a string prefix followed by quote
      if (_strPrefixRe.test(word) && i < len && (code[i] === '"' || code[i] === "'")) {
        // rewind and let string handler deal with it
        i = start;
        // manually handle: prefix + string
        const strStart = i;
        i += word.length;
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
        tokens.push({ type: 'str', text: code.slice(strStart, i) });
        continue;
      }

      const type = _kwSet.has(word) ? 'kw' : _builtinSet.has(word) ? 'fn' : 'id';
      tokens.push({ type, text: code.slice(start, i) });
      continue;
    }

    // operators/punctuation
    const start = i;
    i++;
    tokens.push({ type: 'op', text: code.slice(start, i) });
  }

  return tokens;
}

function pythonCompletions(prefix) {
  const lc = prefix.toLowerCase();
  const results = [];
  for (const kw of PYTHON_KEYWORDS) {
    if (kw.toLowerCase().startsWith(lc)) results.push(kw);
  }
  for (const bi of PYTHON_BUILTINS) {
    if (bi.toLowerCase().startsWith(lc)) results.push(bi);
  }
  return results;
}

// -- init.js --

// Lazy interpreter initialization, stdout buffering, WASM resolution


let _mp = null;
let _initPromise = null;
let _stdoutBuffer = [];
let _stderrBuffer = [];

async function initInterpreter() {
  if (_mp) return _mp;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // resolve micropython.mjs source
    let loadMicroPython;
    if (window._installedModules?.['@gcu/adder/micropython.mjs']) {
      const entry = window._installedModules['@gcu/adder/micropython.mjs'];
      let src;
      if (typeof entry === 'object' && entry.compressed && !entry.binary) {
        const bytes = Uint8Array.from(atob(entry.source), c => c.charCodeAt(0));
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        src = await new Response(stream).text();
      } else {
        src = typeof entry === 'string' ? entry : entry.source;
      }
      const blob = new Blob([src], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      loadMicroPython = mod.loadMicroPython;
    } else {
      // dev-mode: relative import
      const mod = await import('./micropython.mjs');
      loadMicroPython = mod.loadMicroPython;
    }

    // resolve WASM URL
    let wasmUrl;
    if (window._installedModules?.['@gcu/adder/micropython.wasm']) {
      const entry = window._installedModules['@gcu/adder/micropython.wasm'];
      const type = entry.type || 'application/wasm';
      const bytes = Uint8Array.from(atob(entry.source), c => c.charCodeAt(0));
      if (entry.compressed) {
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
        wasmUrl = URL.createObjectURL(new Blob([decompressed], { type }));
      } else {
        wasmUrl = URL.createObjectURL(new Blob([bytes], { type }));
      }
    }

    const opts = {
      stdout: (text) => _stdoutBuffer.push(text),
      stderr: (text) => _stderrBuffer.push(text),
    };
    if (wasmUrl) opts.url = wasmUrl;

    _mp = await loadMicroPython(opts);

    // register Auditable extensions as importable JS modules
    const exts = window._auditableExtensions;
    if (exts) {
      for (const name of Object.keys(exts)) {
        _mp.registerJsModule(name, exts[name]);
      }
    }

    // bootstrap _exec_cell helper
    _mp.runPython(BRIDGE_PY);

    return _mp;
  })();

  return _initPromise;
}

function flushStdout() {
  const lines = _stdoutBuffer;
  _stdoutBuffer = [];
  return lines;
}

function flushStderr() {
  const lines = _stderrBuffer;
  _stderrBuffer = [];
  return lines;
}

function getInterpreter() { return _mp; }

// -- cell.js --

// Python cell type handler: parseNames, findUses, execute


// ── parseNames: extract top-level defines from Python code ──

function pythonParseNames(code) {
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

function pythonFindUses(code, allDefined) {
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

async function pythonExecute(code, scopeIn, cell) {
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

    // extract defines from namespace
    const defines = {};
    const cellDefines = pythonParseNames(code);
    for (const name of cellDefines) {
      try {
        mp.runPython(`_adder_extract = _adder_ns.get("${name}", None)`);
        const val = mp.globals.get('_adder_extract');
        if (val !== undefined && val !== null) defines[name] = val;
      } catch {
        // name not in namespace (e.g. import failed)
      }
    }

    // build output: stdout lines + last expression
    const parts = [];
    if (stdout.length) parts.push(stdout.join('\n'));
    if (stderr.length) parts.push(stderr.join('\n'));
    if (lastExpr !== undefined && lastExpr !== null) parts.push(String(lastExpr));
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

// -- tag.js --

// mpy tagged template + self-registration


async function mpy(strings, ...values) {
  const mp = await initInterpreter();

  flushStdout(); // drain stale output

  // build code with _v0, _v1 placeholders, inject values via Python
  mp.runPython('_adder_ns = {}');
  let code = strings[0];
  for (let i = 0; i < values.length; i++) {
    const key = '_v' + i;
    mp.globals.set('_adder_inject_v', values[i]);
    mp.runPython(`_adder_ns["${key}"] = _adder_inject_v`);
    code += key + strings[i + 1];
  }
  try { mp.globals.delete('_adder_inject_v'); } catch {}

  // execute
  mp.globals.set('_adder_code', code);
  mp.runPython('_exec_cell(_adder_code, _adder_ns)');

  // extract results — get keys as JSON, filter out _-prefixed
  mp.runPython('import json as _adder_json; _adder_keys = _adder_json.dumps([k for k in _adder_ns if not k.startswith("_")])');
  const keysJson = mp.globals.get('_adder_keys');
  const keys = keysJson ? JSON.parse(keysJson) : [];

  const result = {};
  for (const k of keys) {
    mp.runPython(`_adder_extract = _adder_ns["${k}"]`);
    result[k] = mp.globals.get('_adder_extract');
  }

  // cleanup
  try { mp.globals.delete('_adder_ns'); } catch {}
  try { mp.globals.delete('_adder_code'); } catch {}
  try { mp.globals.delete('_adder_keys'); } catch {}
  try { mp.globals.delete('_adder_extract'); } catch {}

  flushStdout(); // drain any print output from mpy execution

  return result;
}

// -- register.js --

// Registration: cell type, tagged language, plugin, extension





const handler = {
  label: 'python',
  color: '#4B8BBE',
  shortcut: 'n',
  editDebounce: 500,
  parseNames: pythonParseNames,
  syntaxCheck: (code) => {
    const mp = getInterpreter();
    if (!mp) return true; // not initialized yet — allow execution
    try {
      mp.globals.set('_adder_check', code);
      mp.runPython('compile(_adder_check, "<check>", "exec")');
      try { mp.globals.delete('_adder_check'); } catch {}
      return true;
    } catch {
      try { mp.globals.delete('_adder_check'); } catch {}
      return false;
    }
  },
  findUses: pythonFindUses,
  execute: pythonExecute,
  tokenize: tokenizePython,
  completions: (prefix) => pythonCompletions(prefix),
  createEditor: (cell, onChange) => {
    if (!window._ctCreateEditor) return null;
    const wrap = document.createElement('div');
    wrap.className = 'editor-wrap';
    const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'python', onChange);
    return {
      el: wrap,
      getCode: () => editor.view.state.doc.toString(),
      setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
      destroy: () => editor.destroy(),
    };
  },
};

// guard: only register once (module may be re-imported from different blob URLs)
if (!window._cellTypes?.['python']) {
  // register cell type
  if (window.registerCellType) {
    window.registerCellType('python', handler, '@gcu/adder');
  } else if (window._cellTypes) {
    window._cellTypes['python'] = handler;
  }

  // register tagged language for mpy`` syntax highlighting
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages['mpy'] = {
    tokenize: tokenizePython,
    completions: pythonCompletions,
  };

  // register as plugin
  if (window.registerPlugin) {
    window.registerPlugin('@gcu/adder', { description: 'Python cells and mpy tagged template' });
  } else if (window._auditablePlugins) {
    window._auditablePlugins.set('@gcu/adder', { description: 'Python cells and mpy tagged template' });
  }

  // global mpy tag
  window.mpy = mpy;
}

const adder = {
  mpy,
  handler,
  pythonParseNames,
  pythonFindUses,
  tokenizePython,
  pythonCompletions,
};

export { adder };
