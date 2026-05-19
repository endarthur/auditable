// @gcu/geas — ES module entry point (import order doubles as build manifest).
//
// Side-effect imports below load every source module in dependency order so
// the concat-style bundle in `index.js` ends up with everything in scope.
// Public API is re-exported via api.js (a single export-from line, so the
// build script's "include each ./foo.js once" logic doesn't double-include).

import './ast-nodes.js';
import './lexer.js';
import './parser.js';
import './adapters/headless.js';
export { tokenize, parse, NODE, createHeadlessAdapter } from './api.js';
