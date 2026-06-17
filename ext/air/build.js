#!/usr/bin/env node
// Bundles ext/air/src/ ES modules into a single index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

// Extract module paths from main.js (imports and re-exports)
const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) importPaths.push(m[1]);
}

// Collect the bundle's public surface across all source files, so the generated
// index.js can carry a real `export { … }` footer (lets @gcu/build and other
// consumers import air's API from the bundle instead of reaching into src/).
const exportedNames = new Set();

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = relPath.replace(/\//g, '_');

  // Collect exported names BEFORE stripping the `export` keywords below.
  // Declaration exports: export [async] function|const|let|var|class NAME
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    exportedNames.add(m[1]);
  }
  // Export-list blocks: export { A, B as C, … } (single- or multi-line; air has
  // no `export … from` re-exports, so every listed name is a local binding).
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
    for (let part of m[1].split(',')) {
      part = part.replace(/\/\/.*$/gm, '').trim(); // drop inline comments
      if (!part) continue;
      const name = part.split(/\s+as\s+/).pop().trim(); // exported-as name
      if (/^[A-Za-z0-9_$]+$/.test(name)) exportedNames.add(name);
    }
  }

  // Strip import lines (single-line and multi-line)
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  // Replace export function -> function, export const -> const, etc.
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');

  // Strip export { ... } and export default lines
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  // Trim leading/trailing blank lines
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');

  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/air/src/  Build: node ext/air/build.js\n'
  + '// @gcu/air \u2014 Auditable Intermediate Representation\n'
  + '// SSA IR for JS/TS analysis, type propagation, and optimized emission.\n';

const footer = '// -- bundle exports (generated) --\n\nexport {\n'
  + [...exportedNames].sort().map((n) => `  ${n},`).join('\n')
  + '\n};\n';

const output = header + '\n' + chunks.join('\n\n') + '\n\n' + footer;

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/air/index.js (${(size / 1024).toFixed(1)} KB)`);
