#!/usr/bin/env node
// Bundle ext/patchbay/src/ into ext/patchbay/index.js — a single ES module.
// Concat strategy (like ext/abus/build.js): strip import/export statements,
// concatenate in dependency order, append an export footer.
//
// The MANIFEST lists files in concat order with the public names each exports.
// Files that don't exist yet are skipped (with a note) so the bundle builds
// cleanly at every phase of development; the footer only exports names from
// included files.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

const MANIFEST = [
  { file: 'sdk.js',      exports: ['defineModule', 'getModuleDef', 'hasModuleDef', 'listModuleDefs', 'clearModuleRegistry'] },
  { file: 'engine.js',   exports: ['createEngine'] },
  { file: 'styles.js',   exports: ['PANEL_STYLES', 'getStyle', 'listStyles'] },
  { file: 'store.js',    exports: ['FORMAT', 'VERSION', 'blankRack', 'serializeRack', 'deserializeRack', 'LooseFileStore'] },
  { file: 'pb.js',       exports: ['createPb'] },
  { file: 'stdlib.js',   exports: ['registerStdlib', 'STDLIB_MODULES'] },
  { file: 'render.js',   exports: [] },
  { file: 'interact.js', exports: [] },
  { file: 'mount.js',    exports: ['mountPatchbay'] },
];

function stripModuleSyntax(src) {
  // Normalize CRLF first — `$` line anchors don't span `\r`, which would leave
  // import/export lines un-stripped on Windows checkouts (see other ext builds).
  src = src.replace(/\r\n/g, '\n');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

const chunks = [];
const exported = [];
const skipped = [];
for (const { file, exports } of MANIFEST) {
  const full = path.join(srcDir, file);
  if (!fs.existsSync(full)) { skipped.push(file); continue; }
  const src = stripModuleSyntax(fs.readFileSync(full, 'utf8'));
  chunks.push(`// -- ${file} --\n\n${src}`);
  for (const name of exports) exported.push(name);
}

const header = `// @gcu/patchbay — Eurorack-style reactive dataflow surface engine
// Auto-generated from ext/patchbay/src/ — do not edit directly
`;
const footer = exported.length
  ? `\nexport {\n${exported.map((n) => '  ' + n).join(',\n')},\n};\n`
  : '\n';

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
if (skipped.length) console.log(`  (not yet present, skipped: ${skipped.join(', ')})`);
