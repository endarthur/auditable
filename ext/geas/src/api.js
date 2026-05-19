// Public API surface for @gcu/geas.
//
// v0.0.1 (Medium scope): lexer + parser only. Executor, builtins, terminal
// adapters, and the worker harness come in later iterations.
//
// Note on shape: uses `import { x } from './foo.js'; export { x };` rather
// than `export { x } from './foo.js'` so the concat-style build can strip
// both lines and leave api.js's contribution empty in the bundle — the
// footer in build.js then provides a single canonical export.

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { NODE } from './ast-nodes.js';
import { createHeadlessAdapter } from './adapters/headless.js';

export { tokenize, parse, NODE, createHeadlessAdapter };
