import { $, S } from '../js/state.js';
import { runAll } from '../js/exec.js';

// ── GLOBAL BINDINGS (app runtime) ──

window.$ = $;
window.S = S;
window.runAll = runAll;
