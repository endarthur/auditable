// @gcu/dialog — package entry: build concat manifest + the curated public
// surface (the names the bundle exports; matches the old hand-written footer).

import './helpers.js';
import './dialog.js';
import './convenience.js';

export { Dialog, dismissAll, openCount } from './dialog.js';
export { confirm, prompt, alert } from './convenience.js';
