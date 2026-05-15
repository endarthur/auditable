// ui.terminal() cell builtin — backend-pluggable terminal emulator.
//
// Mounts a VT/ANSI terminal in the cell's output and returns a handle that
// satisfies the canonical surface defined in `terminal-backend.js`. The
// default backend is @gcu/term; future backends (e.g. xterm.js) can drop in
// by registering themselves before the cell runs, and cells stick to the
// canonical surface to remain backend-portable.
//
// Switch backends globally via:
//   setDefaultBackend('xterm');     // once a third-party backend is loaded
// or per-call:
//   ui.terminal({ backend: 'xterm', ... })

import { getBackend, getDefaultBackend } from './terminal-backend.js';
// Side-effect import: registers the 'gcu-term' backend at module load.
import './terminal-backend-gcu.js';

export function makeTerminal(cell, ctx) {
  const { outputEl, invalidation } = ctx;

  return function terminal(opts = {}) {
    const backendName = opts.backend || getDefaultBackend();
    const create = getBackend(backendName);
    const handle = create(opts, outputEl);
    // Auto-dispose when the cell re-runs. Single subscription per terminal.
    invalidation.then(() => handle.dispose());
    return handle;
  };
}
