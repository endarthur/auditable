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
import './pkg-cmd.js';
import './profile-cmd.js';
import './builtins-archive.js';
import '../../ed/src/buffer.js';
import '../../ed/src/regex.js';
import '../../ed/src/address.js';
import '../../ed/src/commands.js';
import '../../ed/src/api.js';
import './ops.js';   // op descriptors + the man/op doc-projection — must precede builtins.js (it imports manCmd/opCmd)
import './builtins.js';
import './adapters/headless.js';
import './adapters/term.js';
import './adapters/xterm.js';
import './worker/vfs-proxy.js';
import './worker/host-proxy.js';
import './worker/worker-shim.js';
import './worker/client.js';
import './worker/loopback.js';
import './worker/proc-adapter.js';
export { tokenize, parse, parseWordParts, execute, defaultBuiltins, createShell, mkTyped, isTyped, NODE, createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, makeLineEditor, createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback, procToWorker, geasProcEntry } from './api.js';
