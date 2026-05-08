// soft — ES module entry point (import order doubles as build manifest)
import './tokenize.js';
import './parse.js';
import './eval.js';
import './runtime.js';
import './highlight.js';
import './air-lower.js';
import './cell.js';
import './tag.js';
export { soft } from './register.js';
