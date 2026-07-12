// @gcu/expr — a small, total, CSP-safe expression calculus over one record's
// fields. Two faces (value + boolean), two paths (tree-walk reference + compiled
// positional closures), analyzable (deps + validate). The shared "small tier" of
// the GCU expression stack; @gcu/over is the heavy cross-record DSL.
// Public surface (manifest-is-truth; @gcu/build bundles from here).
export { parse, asAst, tokenize, quoteIdent, CALLFNS, ExprParseError } from './parse.js';
export { evaluate, evalBool, constraintValid } from './eval.js';
export { compile, compileValue, compileBool } from './compile.js';
export { deps, validate, canMatch } from './analyze.js';
export { complete } from './complete.js';
export { isBlank, num, FN } from './runtime.js';
