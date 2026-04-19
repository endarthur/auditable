#!/usr/bin/env node
// Bundles ext/atra/src/ ES modules into a single index.js

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

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  // Strip import lines (single-line and multi-line)
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  // Replace export function -> function, export const -> const, etc.
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');

  // Strip export { ... } and export default lines
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  // Trim leading/trailing blank lines
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');

  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/atra/src/  Build: node ext/atra/build.js\n'
  + '// @auditable/atra — Arithmetic TRAnspiler\n'
  + '// Fortran/Pascal hybrid → WebAssembly bytecode. Single-file compiler.\n';

const output = header + '\n' + chunks.join('\n\n') + '\n\nexport { atra };\n';

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/atra/index.js (${(size / 1024).toFixed(1)} KB)`);

// ── Build atra libraries: alpack, gslib, raster ──
// Outputs are dual-written:
//   - ext/atra/lib/<name>.js          (for Auditable's @atra/* resolver and /// module: refs)
//   - ext/<name>/index.js             (for npm publishing as @gcu/<name>)
// Source stays at its canonical location (ext/atra/lib/alpack.atra for alpack,
// ext/<name>/<name>.atra for gslib/raster).

import { buildSrc, formatSrcJs, bundle } from './atrac.js';

const libDir = path.join(__dirname, 'lib');
const extDir = path.join(__dirname, '..');

function writeDual(primaryPath, secondaryPath, content, label) {
  fs.writeFileSync(primaryPath, content);
  const size = fs.statSync(primaryPath).size;
  console.log(`Built ${label} (${(size / 1024).toFixed(1)} KB)`);
  fs.mkdirSync(path.dirname(secondaryPath), { recursive: true });
  fs.writeFileSync(secondaryPath, content);
}

// ── alpack ──

const alpackPath = path.join(libDir, 'alpack.atra');
if (fs.existsSync(alpackPath)) {
  const atraSrc = fs.readFileSync(alpackPath, 'utf8');

  // Source distribution (for `load("@atra/alpack.src")` and @gcu/alpack/src)
  const srcOut = formatSrcJs(buildSrc(atraSrc));
  writeDual(
    path.join(libDir, 'alpack.src.js'),
    path.join(extDir, 'alpack', 'src.js'),
    srcOut,
    'ext/atra/lib/alpack.src.js → ext/alpack/src.js',
  );

  // Binary distribution (for `load("@atra/alpack")` and @gcu/alpack)
  const bundleOut = bundle(atraSrc, { name: 'alpack' });
  writeDual(
    path.join(libDir, 'alpack.js'),
    path.join(extDir, 'alpack', 'index.js'),
    bundleOut,
    'ext/atra/lib/alpack.js → ext/alpack/index.js',
  );
}

// ── gslib ──

const gslibAtraPath = path.join(extDir, 'gslib', 'gslib.atra');
if (fs.existsSync(gslibAtraPath)) {
  const gslibSrc = fs.readFileSync(gslibAtraPath, 'utf8');
  let out = bundle(gslibSrc, { name: 'gslib' });
  const gslibApiPath = path.join(extDir, 'gslib', 'api.js');
  if (fs.existsSync(gslibApiPath)) {
    out += '\n' + fs.readFileSync(gslibApiPath, 'utf8');
  }
  writeDual(
    path.join(libDir, 'gslib.js'),
    path.join(extDir, 'gslib', 'index.js'),
    out,
    'ext/atra/lib/gslib.js → ext/gslib/index.js',
  );
}

// ── raster ──

const rasterAtraPath = path.join(extDir, 'raster', 'raster.atra');
if (fs.existsSync(rasterAtraPath)) {
  const rasterSrc = fs.readFileSync(rasterAtraPath, 'utf8');
  let out = bundle(rasterSrc, { name: 'raster' });
  const apiPath = path.join(extDir, 'raster', 'api.js');
  if (fs.existsSync(apiPath)) out += '\n' + fs.readFileSync(apiPath, 'utf8');
  writeDual(
    path.join(libDir, 'raster.js'),
    path.join(extDir, 'raster', 'index.js'),
    out,
    'ext/atra/lib/raster.js → ext/raster/index.js',
  );
}
