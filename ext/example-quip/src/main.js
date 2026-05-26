// Concat order for build.js. Order matters: parse (no deps), then
// tokenize, then tag/adapter/cell, then register (touches everything).

import './parse.js';
import './tokenize.js';
import './tag.js';
import './adapter.js';
import './cell.js';
import './register.js';
