// @gcu/soft — npm entry (language core, no DOM/Auditable dependencies)
// This file is not part of the concat build (main.js is the concat manifest).
// For the Auditable cell-type handler, import '@gcu/soft/register' or the bundled build.

export { softTokenize, softSetLocale, softGetLocale } from './tokenize.js';
export { softParse } from './parse.js';
export { softEval, softString } from './eval.js';
export { _soft } from './runtime.js';
export { softTag } from './tag.js';
