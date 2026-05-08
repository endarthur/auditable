// adder — ES module entry point (import order doubles as build manifest)
import './parse.js';
import './builtins.js';
import './eval.js';
import './runtime.js';
import './highlight.js';
import './air-lower.js';
import './cell.js';
import './tag.js';
export { adder } from './register.js';
