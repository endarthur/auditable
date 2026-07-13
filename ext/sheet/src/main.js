// sheet — ES module entry point (import order doubles as build manifest)
import './zip.js';
import './xml.js';
import './util.js';
import './reader.js';
import './table.js';
import './writer.js';
export { sheet } from './api.js';
export { census, openSheet } from './table.js';   // the table-document adapter (typed columns, no CSV round-trip)
