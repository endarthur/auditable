#!/usr/bin/env node
// Bundles ext/adder/src/ ES modules into a single index.js

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

// Strip imports/exports and trim a source chunk for concat-bundling.
function stripModuleSyntax(src) {
  // Strip import lines (single-line and multi-line)
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  // Replace export declarations -> plain declarations
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');

  // Strip export { ... } and export default lines
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  // Trim leading/trailing blank lines
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

const chunks = [];

// air-lower.js imports types from ext/air/src/types.js. Inline those types
// up-front so the bundle is self-contained — costs ~2KB; saves declaring
// @gcu/air as a runtime peer dependency for npm consumers.
const airTypesPath = path.join(__dirname, '..', 'air', 'src', 'types.js');
if (fs.existsSync(airTypesPath)) {
  const airTypesSrc = stripModuleSyntax(fs.readFileSync(airTypesPath, 'utf8'));
  chunks.push(`// -- inlined: ../air/src/types.js (AIR type singletons) --\n\n${airTypesSrc}`);
}

for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  const src = stripModuleSyntax(fs.readFileSync(filePath, 'utf8'));
  const basename = path.basename(relPath);
  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/adder/src/  Build: node ext/adder/build.js\n'
  + '// @gcu/adder \u2014 Pure JS Python interpreter for Auditable\n'
  + '// Python cells, adder/mpy tagged template, tree-walking evaluator.\n';

const output = header + '\n' + chunks.join('\n\n') + '\n\nexport { adder };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/adder/index.js (${(size / 1024).toFixed(1)} KB)`);
