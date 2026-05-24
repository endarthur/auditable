// Module load order matters. Don't reorder these without verifying:
//
//   1. Modules that subscribe to the hook bus at module-eval time
//      (editor, fs, mcp-adapter, init, …) use a direct `import * as hooks
//      from './hooks.js'` and call `hooks.on(...)`. NOT `window.auditable.
//      hooks.on(...)` — globals.js wires that wrapper at *its* own eval
//      time (line 43 below), so anything earlier sees `undefined` and the
//      subscription silently no-ops. See commit e086f5d for the cleanup
//      of three modules that hit this exact bug.
//
//   2. shim.js (line 41) must load BEFORE mcp-adapter.js (line 42).
//      mcp-adapter wraps `window.__auditable_mcp.onStateChange` at eval
//      time; shim.js installs the object.
//
//   3. AIR (added to the registry by build.js at the END, after this
//      manifest) loads LAST. Modules that read `window._airAnalyzer` /
//      `_airEmit` / `_airRegisterLowerer` etc. only do so inside function
//      bodies (dag.js, exec.js, cell-types.js, adder, soft), which run
//      well after AIR's browser-init block has populated those slots.
//
//   4. complete.js binds `window.CM6.ViewPlugin.define(...)` at eval time
//      (line 36 below). CM6 is prepended to the bundle as a classic IIFE
//      by build.js, so it's set up before *any* module runs — but the
//      prepend ordering is a build-side invariant; don't break it.

import './state.js';
import './hooks.js';
import './cell-types.js';
import './cm6.js';
import './fs.js';
import './stdlib-core.js';
import './stdlib.js';
import './python.js';
import './dag-core.js';
import './dag.js';
import './widgets.js';
import './engine.js';
import './serialize.js';
import './persist.js';
import './host.js';
import './surface.js';
import './markdown.js';
import './cell-builtins/text-compression.js';
import './cell-builtins/ui.js';
import './cell-builtins/file-io.js';
import './cell-builtins/modules.js';
import './cell-builtins/workers.js';
import './cell-builtins/shell.js';
import './cell-builtins/notebook-api.js';
import './cell-builtins/workshop.js';
import './cell-builtins/dialog.js';
import './cell-builtins/terminal-backend.js';
import './cell-builtins/terminal-backend-gcu.js';
import './cell-builtins/terminal.js';
import './cell-render.js';
import './cell-context.js';
import './exec.js';
import './cell-dom.js';
import './cell-ops.js';
import './editor.js';
import './settings.js';
import './update.js';
import './crypto.js';
import './save.js';
import './ui.js';
import './find.js';
import './split.js';
import './complete.js';
import './keyboard.js';
import './menubar.js';
import './goto.js'; // @optional
import './size-compare.js'; // @optional
import './shim.js';
import './mcp-adapter.js';
import './ipynb-bridge.js';
import './globals.js';
import './init.js';
