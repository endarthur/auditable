#!/usr/bin/env node
// Bundles ext/geas/src/ ES modules into a single index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

// Extract module paths from main.js. Two forms:
//   './foo.js'              — relative inside ext/geas/src
//   '../../<pkg>/src/foo.js' — cross-package source (concatenated alongside
//                              geas's own sources so a single bundle gets
//                              both — used to surface @gcu/ed as a geas
//                              builtin without inlining its source twice).
const importEntries = [];
for (const line of mainSrc.split('\n')) {
  let m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) { importEntries.push({ rel: m[1], cross: null }); continue; }
  m = line.match(/^(?:import|export)\s+.*['"](\.\.\/\.\.\/[^/'"]+\/src\/[^'"]+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) { importEntries.push({ rel: null, cross: m[1] }); continue; }
}

const chunks = [];

// ── Prepend @gcu/archive's pre-built bundle ──────────────────────────
// geas's archive builtins (builtins-archive.js) need `archive` and
// `walkVfsTree` as in-scope identifiers — the dynamic-import fallback
// chain (#archive / @gcu/archive / relative paths) doesn't resolve inside
// the worker context that hosts geas (workers don't inherit the main
// thread's import map; relative paths against a blob: worker URL are
// opaque). Inlining the pre-built bundle keeps geas self-contained.
//
// We strip ONLY the trailing `export { ... }` block — the rest of the
// bundle already does its own collision isolation via fflate/fzstd IIFEs
// and aliased symbol names, so concatenating it verbatim is safe.
const archivePath = path.resolve(__dirname, '..', 'archive', 'index.js');
if (fs.existsSync(archivePath)) {
  let archiveSrc = fs.readFileSync(archivePath, 'utf8');
  archiveSrc = archiveSrc.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  archiveSrc = archiveSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push('// -- archive/index.js (pre-built bundle, prepended) --\n\n' + archiveSrc);
} else {
  console.warn('geas: ext/archive/index.js not found — archive builtins will fail at runtime');
}

for (const entry of importEntries) {
  const filePath = entry.rel
    ? path.join(srcDir, entry.rel)
    : path.resolve(srcDir, entry.cross);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(entry.rel || entry.cross);

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

const header = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/geas/src/  Build: node ext/geas/build.js\n'
  + '// @gcu/geas — the GCU shell. POSIX-syntax with typed-pipe extensions.\n';

const output = header + '\n' + chunks.join('\n\n')
  + '\n\nexport { tokenize, parse, parseWordParts, execute, defaultBuiltins, createShell, mkTyped, isTyped, NODE, createHeadlessAdapter, createTermAdapter, createXtermAdapter, adapterHooks, makeLineEditor, createGeasClient, setupGeasWorker, serveVFS, createVfsClient, createLoopback, procToWorker, geasProcEntry };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/geas/index.js (${(size / 1024).toFixed(1)} KB)`);
