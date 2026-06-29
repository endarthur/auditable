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

// ── Prepend @gcu/licenses's pre-built bundle ─────────────────────────
// pkg-cmd.js needs fetchLicense/aggregateLicenses/formatTable in scope
// so it can enrich /lib/<pkg>/ with package.json + LICENSE at install
// time and render the `pkg licenses` table. Same reasoning as archive:
// worker context doesn't resolve the import map; inlining keeps geas
// self-contained.
// IIFE-wrap so internal symbols (notably `tokenize`, which collides with
// geas's lexer.js export) stay scoped to the bundle. Expose only the three
// symbols pkg-cmd.js actually consumes — fetchLicense, aggregateLicenses,
// formatTable — as top-level consts. pkg-cmd.js's _resolveLicensesSym helper
// picks them up via lexical scope (the typeof checks succeed).
const licensesPath = path.resolve(__dirname, '..', 'licenses', 'index.js');
if (fs.existsSync(licensesPath)) {
  let licensesSrc = fs.readFileSync(licensesPath, 'utf8');
  licensesSrc = licensesSrc.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  licensesSrc = licensesSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  // Prefix the exposed bindings so they don't collide with same-named
  // symbols elsewhere in the bundle (geas's lexer.js has `tokenize`;
  // builtins-typed.js has `formatTable`). pkg-cmd.js's _resolveLicensesSym
  // looks for both the bare name and the `_lic<Name>` prefix.
  const wrapped =
`// -- licenses/index.js (IIFE-wrapped — exposes _licFetchLicense / _licAggregateLicenses / _licFormatTable) --

const { _licFetchLicense, _licAggregateLicenses, _licFormatTable } = (() => {
${licensesSrc}
return {
  _licFetchLicense:     fetchLicense,
  _licAggregateLicenses: aggregateLicenses,
  _licFormatTable:      formatTable,
};
})();`;
  chunks.push(wrapped);
} else {
  console.warn('geas: ext/licenses/index.js not found — pkg licenses subcommand will fail at runtime');
}

// ── Prepend src/js/gcupkg.js — .gcupkg reader + installer ────────────
// pkg-cmd.js's `pkg install <file.gcupkg>` path needs parseGcupkg + installGcupkg
// in scope. Source lives in the auditable tree; concat-prepend it the same way
// (no name collisions — both functions are gcupkg-prefixed via the spec).
const gcupkgPath = path.resolve(__dirname, '..', '..', 'src', 'js', 'gcupkg.js');
if (fs.existsSync(gcupkgPath)) {
  let gcupkgSrc = fs.readFileSync(gcupkgPath, 'utf8');
  gcupkgSrc = gcupkgSrc.replace(/^export\s+(async\s+)?function\s/gm, '$1function ');
  gcupkgSrc = gcupkgSrc.replace(/^export\s+const\s/gm, 'const ');
  gcupkgSrc = gcupkgSrc.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  gcupkgSrc = gcupkgSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push('// -- src/js/gcupkg.js (prepended for `pkg install <file.gcupkg>`) --\n\n' + gcupkgSrc);
} else {
  console.warn('geas: src/js/gcupkg.js not found — pkg install <file.gcupkg> will fail at runtime');
}

for (const entry of importEntries) {
  const filePath = entry.rel
    ? path.join(srcDir, entry.rel)
    : path.resolve(srcDir, entry.cross);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(entry.rel || entry.cross);

  // Strip import lines (single-line and multi-line). Tolerate a trailing line
  // comment after the `;` — otherwise a commented import survives stripping and
  // lands as a dangling `import … from './x.js'` in the worker bundle (it can't
  // resolve relative paths against a blob: URL → the module fails to load).
  src = src.replace(/^import\s+.*['"].*['"];?\s*(?:\/\/.*)?$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*(?:\/\/.*)?$/gm, '');

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
