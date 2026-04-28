#!/usr/bin/env node
// Bundles ext/pdf3a/src/ ES modules into a single index.js for the browser
// concat loader. Mirrors the pattern used by ext/menu/build.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^import\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m && !importPaths.includes(m[1])) importPaths.push(m[1]);
}
importPaths.push('main.js');

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');

  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/pdf3a/src/  Build: node ext/pdf3a/build.js\n'
  + '// @gcu/pdf3a \u2014 PDF/A-3B enrichment for pdf-lib documents\n'
  + '// applyPdfA3, buildXmpMetadata. pdf-lib is a peer dependency.\n';

const exportBlock = '\nexport { applyPdfA3, buildXmpMetadata, pdfDate, srgbProfile, VALID_RELATIONSHIPS };\n';

const output = header + '\n' + chunks.join('\n\n') + '\n' + exportBlock;

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/pdf3a/index.js (${(size / 1024).toFixed(1)} KB)`);
