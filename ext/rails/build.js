#!/usr/bin/env node
// Bundles ext/rails/src/ ES modules into a single index.js for the browser
// concat loader. Mirrors the pattern used by ext/sideact/build.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

// Extract module paths from main.js (import statements only).
const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^import\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m && !importPaths.includes(m[1])) importPaths.push(m[1]);
}
// Append main.js itself at the end (harmless — it's just imports).
importPaths.push('main.js');

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  // Strip import lines (single-line and multi-line).
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  // Replace export function/const/let/class -> bare declaration.
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');

  // Strip export { ... } and export default.
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/rails/src/  Build: node ext/rails/build.js\n'
  + '// @gcu/rails \u2014 layout engine for docked tab-based workspaces\n'
  + '// Rails, stacks, tabs. Panels never reparent. Zero dependencies.\n';

const exportBlock = '\nexport { createRails, findTab, findStack, findRail, emptyState, validateState, freshId };\n';

const output = header + '\n' + chunks.join('\n\n') + '\n' + exportBlock;

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/rails/index.js (${(size / 1024).toFixed(1)} KB)`);
