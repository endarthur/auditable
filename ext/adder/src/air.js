// @gcu/adder/air — AIR-powered runtime API.
// Same shape as the tree-walker API in @gcu/adder, but transpiles adder source
// to V8-hinted JavaScript via @gcu/air before execution (15-300x faster for
// numeric work, often 2-50x for general code).
//
// Requires @gcu/air as a peer dependency. If missing, run()/compile()/evalExpr()
// throw a clear install-instruction error.

import { adderParse, _adderParseExpr } from './parse.js';
import { _py } from './runtime.js';
import { adderBuiltins, setAdderVFS, getAdderVFS } from './builtins.js';
import { isIncomplete } from './runner.js';
import { lowerAdder } from './air-lower.js';

// Strip common leading whitespace — same rationale as @gcu/adder's runner.js.
function _dedent(code) {
  if (typeof code !== 'string' || code.indexOf('\n') === -1) return code;
  const lines = code.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^[ \t]*/);
    const n = m ? m[0].length : 0;
    if (n < min) min = n;
    if (min === 0) break;
  }
  if (!Number.isFinite(min) || min === 0) return code;
  return lines.map(l => l.slice(min)).join('\n');
}

const _AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// JS intrinsics that air.imports may surface but which resolve via the ambient
// global scope — filter them out of scopeKeys so they're not shadowed by undefined.
const _JS_INTRINSICS = new Set([
  'Math', 'console', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'TypeError', 'ValueError', 'RangeError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'globalThis',
]);

let _airCache = null;
async function _loadAir() {
  if (_airCache) return _airCache;
  try {
    _airCache = await import('@gcu/air');
    return _airCache;
  } catch (e) {
    throw new Error(
      '@gcu/adder/air requires @gcu/air as a peer dependency.\n' +
      'Install with: npm install @gcu/air'
    );
  }
}

// Mirror of runner.js but adapted for the AIR path (no AdderScope; we build
// the bindings map directly and pass it through scopeKeys).

class AdderRuntimeError extends Error {
  constructor(msg) { super(msg); this.name = 'AdderRuntimeError'; }
}

const _defaultStdout = (s) => {
  if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
  else if (typeof globalThis !== 'undefined' && globalThis.console) globalThis.console.log(s.replace(/\n$/, ''));
};
const _defaultStdin = () => { throw new AdderRuntimeError('input() called but no stdin was provided'); };

function _makePrintFn(opts) {
  const stdout = opts.stdout || _defaultStdout;
  return (s) => stdout(s);
}

function _makeInput(opts) {
  if (opts.input) return opts.input;
  const stdin = opts.stdin || _defaultStdin;
  const stdout = opts.stdout || _defaultStdout;
  return async (prompt) => {
    if (prompt != null) stdout(String(prompt));
    const line = await stdin();
    if (line == null) throw new AdderRuntimeError('EOF while reading input');
    return line;
  };
}

function _makeBindings(opts) {
  const printFn = _makePrintFn(opts);
  const builtins = adderBuiltins(printFn);
  if (opts.print) builtins.print = opts.print;
  builtins.input = _makeInput(opts);
  return {
    ...builtins,
    ...(opts.globals || {}),
    ...(opts.locals || {}),
  };
}

function _withVfs(opts, fn) {
  if (!opts.vfs) return fn();
  const prev = getAdderVFS();
  setAdderVFS(opts.vfs);
  try { return fn(); }
  finally { setAdderVFS(prev); }
}

// ── compile pipeline ──

async function _compileModule(ast, code) {
  // lowerAdder is owned by @gcu/adder; passes/emit/needsAsync come from @gcu/air (peer dep)
  const { runPasses, emitJS, needsAsync } = await _loadAir();
  const air = lowerAdder(ast, code);
  runPasses(air);
  // Determine which imports are concrete free names that need scope-key injection
  // (filter out JS intrinsics — they resolve via the ambient global).
  const imports = [...(air.imports || [])].filter(n => !_JS_INTRINSICS.has(n));
  const scopeKeys = ['_py', ...imports];
  const jsBody = emitJS(air, scopeKeys, []);
  const isAsync = needsAsync(air);
  const Ctor = isAsync ? _AsyncFunction : Function;
  const fn = new Ctor(...scopeKeys, jsBody);
  return { air, imports, fn };
}

function _callCompiled(compiled, opts) {
  const bindings = _makeBindings(opts);
  const args = [_py, ...compiled.imports.map(name => bindings[name])];
  return _withVfs(opts, () => compiled.fn(...args));
}

// ── public API ──

/**
 * Execute adder source as a module. Returns the resulting scope as a plain object
 * mapping bound names to values.
 *
 * @param {string} code - adder source code
 * @param {object} [opts] - see @gcu/adder run() for full option shape
 * @returns {Promise<Record<string, any>>} the module scope
 */
export async function run(code, opts = {}) {
  const src = _dedent(code);
  const ast = adderParse(src);
  const compiled = await _compileModule(ast, src);
  return await _callCompiled(compiled, opts);
}

/**
 * Evaluate a single adder expression and return its value.
 *
 * @param {string} code - adder expression (not a statement)
 * @param {object} [opts] - see @gcu/adder run() for full option shape
 * @returns {Promise<any>} the expression value
 */
export async function evalExpr(code, opts = {}) {
  // Wrap the expression as an assignment so the emitted code captures the value,
  // then pluck it from the returned scope.
  const wrapped = `__adder_expr_result = (${_dedent(code).trim()})`;
  const ast = adderParse(wrapped);
  const compiled = await _compileModule(ast, wrapped);
  const scope = await _callCompiled(compiled, opts);
  return scope?.__adder_expr_result;
}

/**
 * Compile once, run many. Compilation includes AIR lowering, passes, and JS
 * emission — amortize the cost by caching the compiled function.
 *
 * @param {string} code - adder source code
 * @returns {Promise<{ air: object, imports: string[], run(opts?): Promise<Record<string, any>> }>}
 */
export async function compile(code) {
  const src = _dedent(code);
  const ast = adderParse(src);
  const compiled = await _compileModule(ast, src);
  return {
    air: compiled.air,
    imports: compiled.imports.slice(),
    async run(opts = {}) {
      return await _callCompiled(compiled, opts);
    },
  };
}

export { isIncomplete, AdderRuntimeError };
