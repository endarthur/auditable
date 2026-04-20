// @gcu/soft — high-level runtime API (tree-walker path).
// Companion: @gcu/soft/air exports the same API backed by AIR transpilation.

import { softParse } from './parse.js';
import { softEval, softString } from './eval.js';

// ── IO defaults ──

const _defaultStdout = (s) => {
  if (typeof process !== 'undefined' && process.stdout) process.stdout.write(s);
  else if (typeof globalThis !== 'undefined' && globalThis.console) globalThis.console.log(s.replace(/\n$/, ''));
};

class SoftRuntimeError extends Error {
  constructor(msg) { super(msg); this.name = 'SoftRuntimeError'; }
}

function _makeSayHandler(opts) {
  if (opts.say) return opts.say;                 // user wants raw values
  const stdout = opts.stdout || _defaultStdout;
  return (val) => stdout(softString(val) + '\n');
}

function _mergeBindings(opts) {
  // Soft's scope model is flat — merge locals over globals (Python convention).
  return { ...(opts.globals || {}), ...(opts.locals || {}) };
}

// ── public API ──

/**
 * Execute soft source. Returns the resulting scope mapping bound names to values.
 *
 * @param {string} code - soft source code
 * @param {object} [opts]
 * @param {object} [opts.globals]    - names injected into scope
 * @param {object} [opts.locals]     - names injected into scope (take precedence over globals)
 * @param {(val: any) => void} [opts.say]     - override for `say` (gets raw values)
 * @param {(s: string) => void} [opts.stdout] - where default say formatting writes
 * @param {(s: string) => void} [opts.stderr]
 * @param {() => string | Promise<string | null>} [opts.stdin]
 * @returns {{ scope: Record<string, any>, output: any[] }}
 */
export function run(code, opts = {}) {
  const result = softEval(code, {
    globals: _mergeBindings(opts),
    onSay: _makeSayHandler(opts),
    host: opts.host,
  });
  // softEval returns { output, scope } — normalize to { scope, output }.
  return { scope: result.scope, output: result.output };
}

/**
 * Evaluate a single soft expression and return its value. Soft tracks the
 * implicit result as `it`, so the final expression's value is what gets returned.
 *
 * @param {string} code - soft expression (may be a full program; we return the last `it`)
 * @param {object} [opts] - same shape as run()
 * @returns {any} the expression value (scope.it after evaluation)
 */
export function evalExpr(code, opts = {}) {
  const { scope } = run(code, opts);
  return scope.it;
}

/**
 * Compile once, run many. Parses source eagerly; AST is reused across runs.
 *
 * @param {string} code
 * @returns {{ ast: object, run(opts?): { scope, output } }}
 */
export function compile(code) {
  const ast = softParse(code);
  return {
    ast,
    run(opts = {}) {
      const result = softEval(ast, {
        globals: _mergeBindings(opts),
        onSay: _makeSayHandler(opts),
        host: opts.host,
      });
      return { scope: result.scope, output: result.output };
    },
  };
}

/**
 * Test if soft source parses completely. Returns true if the parser would want
 * more input (unclosed block, etc.).
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isIncomplete(code) {
  if (code == null || code === '' || /^\s*$/.test(code)) return true;
  try {
    softParse(code);
    return false;
  } catch (e) {
    const msg = (e && e.message) || '';
    // Soft errors on incomplete input look like "Expected end but got EOF at line N"
    return /\bEOF\b|but got $|[Uu]nexpected end/.test(msg);
  }
}

export { SoftRuntimeError };
