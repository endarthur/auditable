// Python cell type handler: parseNames, findUses, execute
// adder v2 — pure JS interpreter, no WASM

import { adderParse } from './parse.js';
import { adderEval, AdderScope, AdderError } from './eval.js';
import { adderBuiltins, pyStr, pyRepr, _ensureFsModules, getAdderVFS, setAdderVFS } from './builtins.js';
import { _py } from './runtime.js';

// ── parseNames: extract module-scope defines from Python code ──
// Uses the AST to find assignments at module scope — descends into with/for/if/
// try/while (which don't create Python scopes) but NOT into def/class (which do).
// Falls back to regex for unparseable code.

export function pythonParseNames(code) {
  try {
    const ast = adderParse(code);
    const defines = new Set();
    _collectDefines(ast.body, defines);
    return defines;
  } catch {
    // parse error — fall back to regex (column-0 only)
    return _parseNamesRegex(code);
  }
}

// Walk AST statements, collecting assignment targets.
// Descends into block statements (with/for/if/try/while) but stops at def/class.
function _collectDefines(stmts, defines) {
  for (const node of stmts) {
    switch (node.type) {
      case 'Assign':
        for (const t of node.targets) _collectTargetNames(t, defines);
        break;
      case 'AugAssign':
        _collectTargetNames(node.target, defines);
        break;
      case 'AnnAssign':
        if (node.value) _collectTargetNames(node.target, defines);
        break;
      case 'FunctionDef':
      case 'AsyncFunctionDef':
        defines.add(node.name);
        break; // don't descend — new scope
      case 'ClassDef':
        defines.add(node.name);
        break; // don't descend — new scope
      case 'Import':
        for (const alias of node.names) defines.add(alias.alias || alias.module);
        break;
      case 'ImportFrom':
        for (const alias of node.names) defines.add(alias.alias || alias.name);
        break;
      case 'For':
      case 'AsyncFor':
        _collectTargetNames(node.target, defines);
        _collectDefines(node.body, defines);
        if (node.orelse) _collectDefines(node.orelse, defines);
        break;
      case 'While':
        _collectDefines(node.body, defines);
        if (node.orelse) _collectDefines(node.orelse, defines);
        break;
      case 'If':
        _collectDefines(node.body, defines);
        if (node.orelse) _collectDefines(node.orelse, defines);
        break;
      case 'With':
      case 'AsyncWith':
        for (const item of node.items) {
          if (item.optionalVar) _collectTargetNames(item.optionalVar, defines);
        }
        _collectDefines(node.body, defines);
        break;
      case 'Try':
        _collectDefines(node.body, defines);
        if (node.handlers) {
          for (const h of node.handlers) {
            if (h.name) defines.add(h.name);
            if (h.body) _collectDefines(h.body, defines);
          }
        }
        if (node.orelse) _collectDefines(node.orelse, defines);
        if (node.finalbody) _collectDefines(node.finalbody, defines);
        break;
      default:
        break;
    }
  }
}

// Extract names from assignment targets (Name, Tuple, List, Starred)
function _collectTargetNames(target, defines) {
  if (!target) return;
  if (target.type === 'Name') { defines.add(target.id); return; }
  if (target.type === 'Tuple' || target.type === 'List') {
    for (const elt of target.elts) _collectTargetNames(elt, defines);
    return;
  }
  if (target.type === 'Starred' && target.value) {
    _collectTargetNames(target.value, defines);
  }
}

// Regex fallback for unparseable code (column-0 only, same as before)
function _parseNamesRegex(code) {
  const defines = new Set();
  const lines = code.split('\n');

  for (const line of lines) {
    if (line.length === 0 || line[0] === ' ' || line[0] === '\t') continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') continue;

    let m;
    m = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z_]\w*)/);
    if (m) { defines.add(m[1]); continue; }
    m = trimmed.match(/^class\s+([a-zA-Z_]\w*)/);
    if (m) { defines.add(m[1]); continue; }
    m = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
    if (m) {
      for (const part of m[1].split(',')) {
        const asMatch = part.trim().match(/(\w+)\s+as\s+(\w+)/);
        if (asMatch) defines.add(asMatch[2]);
        else { const name = part.trim().match(/^([a-zA-Z_]\w*)/); if (name) defines.add(name[1]); }
      }
      continue;
    }
    m = trimmed.match(/^import\s+(\w+)(?:\s+as\s+(\w+))?/);
    if (m) { defines.add(m[2] || m[1]); continue; }
    m = trimmed.match(/^(\*?[a-zA-Z_]\w*(?:\s*,\s*\*?[a-zA-Z_]\w*)+)\s*=/);
    if (m && !_isPyKeyword(m[1].split(',')[0].trim().replace(/^\*/, ''))) {
      for (const n of m[1].split(',')) {
        const name = n.trim().replace(/^\*/, '');
        if (name && /^[a-zA-Z_]\w*$/.test(name)) defines.add(name);
      }
      continue;
    }
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
    const expose = ['ui', 'std', 'load', 'install', 'installBinary', 'display', 'invalidation', 'worker', 'workerPool', 'notebook', 'vfs'];
    for (const name of expose) {
      if (ctx[name] !== undefined) scope.set(name, ctx[name]);
    }
  }

  // Wire VFS from auditable runtime (lazy, once)
  if (!getAdderVFS() && typeof window !== 'undefined' && window._notebookVFS) {
    setAdderVFS(window._notebookVFS, window._vfsPath);
  }
  _ensureFsModules();

  // run before-cell hooks
  const _hookStates = [];
  if (typeof window !== 'undefined' && window._adderCellHooks) {
    for (const h of window._adderCellHooks) _hookStates.push(h.before?.(scope, cell) ?? null);
  }

  // parse loop-limit directive
  if (code.includes('# %noloop-limit')) {
    scope.set('__loop_limit__', 0);
  } else {
    const _llm = code.match(/# %loop-limit\s+(\d+)/);
    if (_llm) scope.set('__loop_limit__', parseInt(_llm[1]));
  }

  // evaluate — try transpile path first, fall back to tree-walker on any failure
  let lastExpr;
  let usedTranspile = false;
  let defines = {};

  if (typeof window !== 'undefined' && window._airLowerAdder && window._airEmit) {
    try {
      const lowered = window._airLowerAdder(ast, code);
      if (lowered) {
        const air = lowered.air;
        const importNames = [...air.imports];
        const emittedJS = window._airEmit(air, importNames, [], {
          hinted: false,
          cellId: cell.id,
        });
        const AF = Object.getPrototypeOf(async function(){}).constructor;
        const allParams = ['_py', ...importNames];
        const fn = new AF(...allParams, emittedJS);

        // Resolve each import from scope
        const argValues = importNames.map(name => {
          if (scope.vars.has(name)) return scope.vars.get(name);
          return undefined;
        });

        const result = await fn(_py, ...argValues);
        usedTranspile = true;

        // Extract defines (excluding synthetic __lastExpr__)
        if (result && typeof result === 'object') {
          for (const [k, v] of Object.entries(result)) {
            if (k === '__lastExpr__') { lastExpr = v; continue; }
            defines[k] = v;
            scope.set(k, v); // also populate scope for hooks
          }
        }
      }
    } catch (e) {
      if (typeof window !== 'undefined' && window._airDebug) {
        console.warn('[AIR] adder transpile fallback for cell', cell.id, ':', e.message);
      }
      // fall through to tree-walker
      usedTranspile = false;
      defines = {};
    }
  }

  if (!usedTranspile) {
    try {
      lastExpr = await adderEval(ast, scope);
    } catch (e) {
      if (typeof window !== 'undefined' && window._adderCellHooks) {
        for (let i = 0; i < window._adderCellHooks.length; i++) {
          try { window._adderCellHooks[i].after?.(_hookStates[i], {}, scope); } catch {}
        }
      }
      if (e instanceof AdderError) throw e;
      throw e;
    }
    const cellDefines = pythonParseNames(code);
    for (const name of cellDefines) {
      if (scope.vars.has(name)) defines[name] = scope.vars.get(name);
    }
  }

  // run after-cell hooks
  if (typeof window !== 'undefined' && window._adderCellHooks) {
    for (let i = 0; i < window._adderCellHooks.length; i++) {
      window._adderCellHooks[i].after?.(_hookStates[i], defines, scope);
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

export { setAdderVFS };

function _jsonReplacer(key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
