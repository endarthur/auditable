// @gcu/adder — npm entry (language core, no DOM / Auditable dependencies).
// This file is not part of the concat build (main.js is the concat manifest).
// For the Auditable cell-type handler, import '@gcu/adder/register' or use
// the bundled build at '@gcu/adder/bundled'.

// ── high-level runtime API (tree-walker) ──
// Most users start here. For faster execution, switch to '@gcu/adder/air' —
// same API shape, transpiles to JS via @gcu/air.
export { run, compile, evalExpr, isIncomplete, AdderRuntimeError } from './runner.js';

// ── language core (parse, evaluate) ──
export { adderTokenize, adderParse } from './parse.js';
export { adderEval, AdderScope } from './eval.js';

// ── builtins and runtime helpers ──
export {
  AdderRange, AdderError, Complex,
  pyTypeName, pyBool, pyRepr, pyStr, pyIter, pyCollect,
  adderGetAttr, adderBuiltins, pyFormatValue,
} from './builtins.js';
export { _py } from './runtime.js';

// ── tagged template ──
export { adderTag, mpy } from './tag.js';

// VFS setters (setAdderVFS / getAdderVFS) live at '@gcu/adder/vfs'.
// They mutate module-level state, so most users should pass a vfs to
// run()/compile() opts instead — those restore the prior VFS on exit.
