// soft — ES module entry point (import order doubles as build manifest)
import './tokenize.js';
import './parse.js';
import './eval.js';
import './highlight.js';
import './cell.js';
import './tag.js';
export { soft } from './register.js';
