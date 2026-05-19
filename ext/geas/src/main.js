// @gcu/geas — ES module entry point (import order doubles as build manifest).
//
// Side-effect imports below load every source module in dependency order so
// the concat-style bundle in `index.js` ends up with everything in scope.
// Public API is re-exported via api.js (a single export-from line, so the
// build script's "include each ./foo.js once" logic doesn't double-include).

import './ast-nodes.js';
import './lexer.js';
import './word-parts.js';
import './parser.js';
import './typed.js';
import './executor.js';
import './builtins-typed.js';
import './builtins.js';
import './adapters/headless.js';
import './adapters/term.js';
import './adapters/xterm.js';
import './worker/vfs-proxy.js';
import './worker/worker-shim.js';
import './worker/client.js';
import './worker/loopback.js';
export { tokenize, parse, parseWordParts, execute, defaultBuiltins, createShell, mkTyped, isTyped, NODE, createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback } from './api.js';
