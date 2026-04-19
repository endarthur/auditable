// @gcu/air — Auditable Intermediate Representation
// Module manifest (import order = concat order for build)

import './types.js';
import './lower/js.js';
import './lower/adder.js';
import './lower/soft.js';
import './passes.js';
import './emit-js.js';
import './api.js';
