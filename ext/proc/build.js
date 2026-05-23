#!/usr/bin/env node
// Bundle ext/proc/src/ into ext/proc/index.js — a single ES module.
//
// Concat strategy (like ext/abus/build.js): strip import/export
// statements, concatenate in dependency order, append an export footer.
//
// node-worker-shim.js is intentionally NOT included in the bundle. It
// imports node:worker_threads which would blow up in the browser. It's
// exported separately via package.json's "./node" entry.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

// Order matters: protocol → channel → worker-bootstrap → process → pool → manager.
const files = [
  'protocol.js',
  'channel.js',
  'worker-bootstrap.js',
  'process.js',
  'pool.js',
  'manager.js',
];

const chunks = [];
for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/proc — process model for the browser (Phase A: function / module-call / module-service modes)
// Auto-generated from ext/proc/src/ — do not edit directly
`;

const footer = `
export {
  // protocol.js
  MSG,
  MODE,
  STATE,
  EXIT,
  makePidGen,
  serializeError,
  deserializeError,
  detectTransfer,
  attachMessage,
  // channel.js
  ReadablePort,
  WritablePort,
  // worker-bootstrap.js
  BOOTSTRAP_SOURCE,
  // process.js
  Process,
  // pool.js
  Pool,
  // manager.js
  ProcessManager,
};
`;

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
