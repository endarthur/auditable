// @gcu/ed — ES module entry. Build manifest order: leaf utilities
// first, then composites, then api.

import './buffer.js';
import './regex.js';
import './address.js';
import './commands.js';
import './api.js';

export { runEd } from './api.js';
