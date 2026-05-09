// @gcu/air — Auditable Intermediate Representation
// Module manifest (import order = concat order for build)
//
// AIR ships only the JS frontend. Adder, Soft, and any future frontends
// register their own lowerers via window._airRegisterLowerer at init.

import './types.js';
import './schema.js';
import './scope.js';
import './text.js';
import './validate.js';
import './lower/js.js';
import './passes.js';
import './emit-js.js';
import './api.js';
