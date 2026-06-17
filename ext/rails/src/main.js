// @gcu/rails — package entry: build concat manifest + the curated public
// surface (the names the bundle exports; matches the old hand-written footer).

import './state.js';
import './render.js';
import './drag.js';
import './api.js';

export { createRails } from './api.js';
export { findTab, findStack, findRail, emptyState, validateState, freshId } from './state.js';
