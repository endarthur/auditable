#!/usr/bin/env node
// Bundle ext/archive/src/ into ext/archive/index.js.
//
// Same concat pattern as @gcu/licenses and @gcu/yaml — imports/exports are
// stripped, every source file concatenated into a single scope, and a
// declarative footer re-exports the public surface. fflate is vendored at
// ext/archive/vendor/fflate.module.mjs and prepended verbatim (with its
// own exports rewritten to live in the bundle scope).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');
const vendorDir = path.join(__dirname, 'vendor');

const files = ['detect.js', 'source.js', 'sink.js', 'zip.js', 'tar.js', 'gz.js', 'zst.js', 'xz.js', 'bz2.js', 'walk.js', 'writer.js', 'api.js'];

const chunks = [];

// ── Vendor: fflate + fzstd ────────────────────────────────────────────
// Each vendored copy is the prebuilt ESM bundle from npm, wrapped in an
// IIFE that exposes a namespaced surface. The IIFE isolation matters
// because fflate and fzstd are by the same author and BOTH export
// `decompress` + `Decompress` — naive concat would silently shadow
// fflate's with fzstd's (or vice versa, depending on order). Below the
// IIFEs we alias the symbols our src/ files actually import; src/zip.js
// imports `unzipSync` from the fflate file, src/zst.js imports
// `decompress as fzstd_decompress` from the fzstd file. At dev/test time
// (Node --test) those imports resolve directly through ESM; at build time
// they're stripped and the references hit the aliases declared below.
//
// Versions pinned in vendor-licenses.json (fflate 0.8.2, fzstd 0.1.1).

function _stripVendorExports(src) {
  src = src.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export var /gm, 'var ');
  src = src.replace(/^export default /gm, 'const __vendor_default__ = ');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

// Names re-exported from each vendored IIFE. Keep tight — only the symbols
// our src/ files actually consume. Easy to extend when we want more of
// fflate's surface (e.g. Unzip streaming class for archive.stream).
const VENDORED_EXPORTS = {
  fflate:        ['unzipSync', 'zipSync', 'gzipSync', 'gunzipSync',
                  'Unzip', 'UnzipInflate', 'UnzipPassThrough',
                  'Zip', 'ZipDeflate', 'ZipPassThrough'],
  fzstd:         ['decompress', 'Decompress', 'ZstdErrorCode'],
  xzDecompress:  ['XzReadableStream'],
  seekBzip:      ['Bunzip'],
};

for (const [vname, vfile] of [
  ['fflate',        'fflate.module.mjs'],
  ['fzstd',         'fzstd.module.mjs'],
  ['xzDecompress',  'xz-decompress.module.mjs'],
  ['seekBzip',      'seek-bzip.module.mjs'],
]) {
  const p = path.join(vendorDir, vfile);
  if (!fs.existsSync(p)) {
    console.warn(`archive: vendor/${vfile} not found — ${vname}-dependent formats won't work in the bundle`);
    continue;
  }
  const stripped = _stripVendorExports(fs.readFileSync(p, 'utf8'));
  const exportList = VENDORED_EXPORTS[vname].join(', ');
  const wrapped =
    `const ${vname} = (() => {\n${stripped}\nreturn { ${exportList} };\n})();`;
  // Cosmetic license-file naming: vendored bundle is vname'd but on-disk
  // LICENSEs use the npm-package name (kebab-case for the multi-word ones).
  const licName = vname === 'xzDecompress' ? 'xz-decompress'
                : vname === 'seekBzip'     ? 'seek-bzip'
                : vname;
  chunks.push(`// -- vendor/${vfile} (MIT, see ext/archive/vendor/LICENSE-${licName}) --\n\n${wrapped}`);
}

// Alias bindings — let src/ code refer to the symbols it imported by name
// at dev time. fzstd's `decompress` and `Decompress` shadow fflate's by
// design (we want the zstd ones in our zst.js), so they get explicit
// _fzstd-prefixed names; the fflate counterparts stay unprefixed.
chunks.push(`// -- vendor alias bindings (collision-safe namespacing) --

const unzipSync = fflate.unzipSync;
const zipSync = fflate.zipSync;
const gzipSync_fflate = fflate.gzipSync;
const gunzipSync_fflate = fflate.gunzipSync;
const Unzip = fflate.Unzip;
const UnzipInflate = fflate.UnzipInflate;
const UnzipPassThrough = fflate.UnzipPassThrough;
const Zip = fflate.Zip;
const ZipDeflate = fflate.ZipDeflate;
const ZipPassThrough = fflate.ZipPassThrough;
const fzstd_decompress = fzstd.decompress;
const fzstd_Decompress = fzstd.Decompress;
const fzstd_ZstdErrorCode = fzstd.ZstdErrorCode;
const XzReadableStream = xzDecompress.XzReadableStream;
const Bunzip = seekBzip.Bunzip;
`);

for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/archive — archive format handling for the GCU stack
// Auto-generated from ext/archive/src/ + ext/archive/vendor/ — do not edit directly.
// fflate (MIT) vendored at ext/archive/vendor/fflate.module.mjs.
`;

const footer = `
export {
  detectFormat, magicForFormat,
  normalizeSource, normalizeSink,
  listZip, readZip,
  listTar, readTar, writeTar,
  gunzipBytes, gzipBytes,
  unzstdBytes, zstdBytes,
  unxzBytes, xzBytes,
  unbz2Bytes, bz2Bytes,
  walkVfsTree, buildEntryMap,
  createWriter,
  archive,
};
`;

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
