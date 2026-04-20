// @gcu/soft/air — AIR-powered runtime API.
// Same shape as the tree-walker API in @gcu/soft, but transpiles soft source
// to V8-hinted JavaScript via @gcu/air before execution.
//
// Requires @gcu/air as a peer dependency.

import { softParse } from './parse.js';
import { softString } from './eval.js';
import { _soft } from './runtime.js';
import { isIncomplete } from './runner.js';

const _AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// JS intrinsics that resolve via the ambient global scope — keep them out of
// scopeKeys so they're not shadowed by undefined parameters.
const _JS_INTRINSICS = new Set([
  'Math', 'console', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'Promise', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity',
  'globalThis',
]);

let _airCache = null;
async function _loadAir() {
  if (_airCache) return _airCache;
  try {
    _airCache = await import('@gcu/air');
    return _airCache;
  } catch (e) {
    throw new Error(
      '@gcu/soft/air requires @gcu/air as a peer dependency.\n' +
      'Install with: npm install @gcu/air'
    );
  }
}

class SoftRuntimeError extends Error {
  constructor(msg) { super(msg); this.name = 'SoftRuntimeError'; }
}

const _defaultStdout = (s) => {
  if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
  else if (typeof globalThis !== 'undefined' && globalThis.console) globalThis.console.log(s.replace(/\n$/, ''));
};

function _makeSayHandler(opts) {
  if (opts.say) return opts.say;
  const stdout = opts.stdout || _defaultStdout;
  return (val) => stdout(softString(val) + '\n');
}

// AIR-transpiled soft code references _soft for runtime helpers, and treats
// `say` (plus any other builtin-looking names) as free imports that must be
// provided in scope. We inject `say` automatically based on opts.say/stdout.
// We also accumulate every `say`ed value into an output array so the return
// shape matches the tree-walker's { scope, output } for consistency.

async function _compileModule(ast, code) {
  const { lowerSoft, runPasses, emitJS, needsAsync } = await _loadAir();
  const air = lowerSoft(ast, code);
  runPasses(air);
  const imports = [...(air.imports || [])].filter(n => !_JS_INTRINSICS.has(n));
  const scopeKeys = ['_soft', ...imports];
  const jsBody = emitJS(air, scopeKeys, []);
  const isAsync = needsAsync(air);
  const Ctor = isAsync ? _AsyncFunction : Function;
  const fn = new Ctor(...scopeKeys, jsBody);
  return { air, imports, fn, isAsync };
}

async function _callCompiled(compiled, opts) {
  const output = [];
  const userSay = _makeSayHandler(opts);
  const say = (val) => { output.push(val); userSay(val); };
  const bindings = {
    say,
    ...(opts.globals || {}),
    ...(opts.locals || {}),
  };
  const args = [_soft, ...compiled.imports.map(name => bindings[name])];
  const r = compiled.fn(...args);
  const scope = compiled.isAsync ? await r : r;
  return { scope: scope || {}, output };
}

// ── public API ──

/**
 * Execute soft source via AIR transpilation. Returns { scope, output }.
 */
export async function run(code, opts = {}) {
  const ast = softParse(code);
  const compiled = await _compileModule(ast, code);
  return await _callCompiled(compiled, opts);
}

/**
 * Evaluate a single soft expression and return its value.
 * AIR doesn't track soft's implicit `it` the same way the tree-walker does,
 * so we wrap the source in `set __soft_expr_result to (...)` to capture it.
 */
export async function evalExpr(code, opts = {}) {
  const wrapped = `set __soft_expr_result to ${code}`;
  const { scope } = await run(wrapped, opts);
  return scope.__soft_expr_result;
}

/**
 * Compile once, run many.
 */
export async function compile(code) {
  const ast = softParse(code);
  const compiled = await _compileModule(ast, code);
  return {
    air: compiled.air,
    imports: compiled.imports.slice(),
    async run(opts = {}) {
      return await _callCompiled(compiled, opts);
    },
  };
}

export { isIncomplete, SoftRuntimeError };
