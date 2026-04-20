// @gcu/soft — npm entry (language core, no DOM / Auditable dependencies).
// For the Auditable cell-type handler, import '@gcu/soft/register' or use
// the bundled build at '@gcu/soft/bundled'.

// ── high-level runtime API (tree-walker) ──
export { run, compile, evalExpr, isIncomplete, SoftRuntimeError } from './runner.js';

// ── language core ──
export { softTokenize, softSetLocale, softGetLocale } from './tokenize.js';
export { softParse } from './parse.js';
export { softEval, softString } from './eval.js';

// ── runtime helpers (used by AIR-transpiled soft code) ──
export { _soft } from './runtime.js';

// ── tagged template ──
export { softTag } from './tag.js';
