#!/usr/bin/env node
// Bundles ext/soft/src/ ES modules into a single index.js

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
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

const chunks = [];

// air-lower.js imports types + ScopeChain + BaseLowerCtx from @gcu/air.
// Inline each up-front so the bundle is self-contained — keeps @gcu/soft
// usable without a hard runtime peer dependency on @gcu/air for npm
// consumers. Order matters: types → scope → base.
const airInlines = [
  ['../air/src/types.js', 'AIR type singletons'],
  ['../air/src/scope.js', 'AIR ScopeChain'],
  ['../air/src/lower/base.js', 'AIR shared LowerCtx'],
];
for (const [rel, descr] of airInlines) {
  const fullPath = path.join(__dirname, rel);
  if (fs.existsSync(fullPath)) {
    const src = stripModuleSyntax(fs.readFileSync(fullPath, 'utf8'));
    chunks.push(`// -- inlined: ${rel} (${descr}) --\n\n${src}`);
  }
}

for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  const src = stripModuleSyntax(fs.readFileSync(filePath, 'utf8'));
  const basename = path.basename(relPath);
  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/soft/src/  Build: node ext/soft/build.js\n'
  + '// @gcu/soft \u2014 English keyword programming language for Auditable\n'
  + '// Soft cells, tagged template, data query pipeline.\n';

const output = header + '\n' + chunks.join('\n\n') + '\n\nexport { soft };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/soft/index.js (${(size / 1024).toFixed(1)} KB)`);
