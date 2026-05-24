// @gcu/readline — ES module entry point (import order doubles as
// build manifest, matching the @gcu/geas pattern).
//
// Drop-in replacement for geas's makeLineEditor. See ../README.md
// and the api.js for the public surface.

import './keys.js';
import './editor.js';
import './render.js';
import './api.js';

export { parseKeys } from './keys.js';
export { createReadline } from './api.js';
