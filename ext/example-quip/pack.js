#!/usr/bin/env node
// Packs the example-quip extension into a .gcupkg distributable.
//
// Layout produced — matches EXTENSION_SPEC §6.1:
//
//   example-quip@0.1.0.gcupkg            (ZIP)
//   ├── .gcupkg-meta.json
//   ├── package.json
//   ├── index.js                          (built bundle)
//   ├── adder.js                          (the @gcu/foo/adder secondary entry)
//   ├── surface.html                      (Works surface)
//   ├── LICENSE
//   ├── README.md
//   ├── SPEC.md
//   └── examples/
//       ├── manifest.json
//       └── quip-tour.txt
//
// Integrity: SHA-256 over sorted [index.js, adder.js] with NUL framing
// (§6.1's "Hash recipe" — the spec-recommended cover for an adapter-bearing
// extension).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = __dirname;

function read(rel) {
  return fs.readFileSync(path.join(pkgRoot, rel));
}
function maybeRead(rel) {
  const p = path.join(pkgRoot, rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

// Build index.js fresh before packing so the archive can't drift from
// the live source.
function build() {
  const { execSync } = require ? null : null;   // ESM — call out-of-process below
}
// Simpler: just require the build script to have been run; print a
// note if the artifact's older than its inputs.
function ensureFreshBuild() {
  const idx = path.join(pkgRoot, 'index.js');
  const srcDir = path.join(pkgRoot, 'src');
  if (!fs.existsSync(idx)) {
    console.error('pack: index.js missing — run `node build.js` first.');
    process.exit(1);
  }
  const idxMtime = fs.statSync(idx).mtimeMs;
  for (const f of fs.readdirSync(srcDir)) {
    const m = fs.statSync(path.join(srcDir, f)).mtimeMs;
    if (m > idxMtime) {
      console.warn(`pack: warning — ${f} is newer than index.js. Run \`node build.js\` to refresh.`);
    }
  }
}

// Read the adder bridge from the built bundle. The bundle is a single
// concat; the adder.js file we ship as a SECONDARY entry needs to be a
// small standalone module whose ONLY job is to look up the engine in
// _importCache and re-publish its exports as `quip`. We hand-write it
// rather than extracting from the bundle.
function adderJsContent() {
  return `// @example/quip — adder bridge.
//
// Loaded via load("@example/quip/adder") AFTER the engine has been
// loaded via load("@example/quip") (or auto-discovered by Slice 5's
// adapter-load: \`from quip import …\` in a /// adder cell finds it).

const _engine = (typeof window !== "undefined" && window._importCache)
  ? window._importCache["@example/quip"]
  : null;

if (!_engine) {
  throw new Error(
    "@example/quip: engine not in _importCache — " +
      "call load(\\"@example/quip\\") before this adapter."
  );
}

const _quip = {
  parse:   _engine.parseQuip,
  render:  _engine.renderQuip,
  compile: _engine.compileQuip,
  fromMap: _engine.makePhrases,
};

if (typeof window !== "undefined") {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: "@example/quip/adder",
      version: "0.1.0",
      description: "Python-shape adapter for the @example/quip engine.",
      exports: { quip: _quip },
    });
  } else {
    window._auditableExtensions = window._auditableExtensions || {};
    window._auditableExtensions["quip"] = _quip;
  }
}

export { _quip as quipAdder };
`;
}

ensureFreshBuild();

const indexJs   = read('index.js');
const adderJs   = Buffer.from(adderJsContent(), 'utf8');
const surface   = read('surface.html');
const license   = maybeRead('LICENSE') || Buffer.from('MIT — example only.\n', 'utf8');
const readme    = maybeRead('README.md') || Buffer.from('# @example/quip\n\nExample extension.\n', 'utf8');
const spec      = maybeRead('SPEC.md');
const tourTxt   = maybeRead('examples/quip-tour.txt');
const exManif   = maybeRead('examples/manifest.json');

// Also ship adder.js source AS-IS to /lib via the installer, plus
// surface.html (so the surface kind can spawn it).
const packageJson = read('package.json');

// Build the file map. Keys are archive paths (forward-slashed); values
// are Buffers.
const files = {
  'package.json': packageJson,
  'index.js':     indexJs,
  'adder.js':     adderJs,
  'surface.html': surface,
  'LICENSE':      license,
  'README.md':    readme,
};
if (spec)    files['SPEC.md']    = spec;
if (tourTxt) files['examples/quip-tour.txt'] = tourTxt;
if (exManif) files['examples/manifest.json'] = exManif;

// Integrity: SHA-256 over sorted [index.js, adder.js] with NUL framing.
const covers = ['adder.js', 'index.js'];
function sriHashOver(coverNames) {
  const h = crypto.createHash('sha256');
  for (const name of coverNames) {
    h.update(Buffer.from(name, 'utf8'));
    h.update(Buffer.from([0]));
    h.update(files[name]);
    h.update(Buffer.from([0]));
  }
  return 'sha256-' + h.digest('base64');
}
const integrity = sriHashOver(covers);

// Build .gcupkg-meta.json — last so the integrity covers everything else.
const pkgObj = JSON.parse(packageJson.toString('utf8'));
const meta = {
  gcupkgVersion: 1,
  name:        pkgObj.name,
  version:     pkgObj.version,
  description: pkgObj.description,
  spdx:        pkgObj.license,
  contributes: ['cellType', 'taggedLanguage', 'exports', 'globals', 'surface', 'contextMenu'],
  size:        { 'index.js': indexJs.length, 'adder.js': adderJs.length },
  integrity,
  integrityCovers: covers,
};
files['.gcupkg-meta.json'] = Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8');

// ── Minimal ZIP writer (deflate-raw per ZIP spec) ────────────────────
// Spec: PKZIP APPNOTE.TXT. We only need the subset that produces a
// readable .zip from a fixed file list — no compression options beyond
// deflate / store, no encryption, no multi-disk. Same payload shape
// auditable's stdlib unzipArchive consumes.
function makeZip(fileMap) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const t = _dosTime(new Date());
  for (const [name, content] of Object.entries(fileMap)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = _crc32(content);
    const compressed = zlib.deflateRawSync(content);
    const useDeflate = compressed.length < content.length;
    const data = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;

    // Local file header — 30 bytes + name
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(t.time, 10);
    local.writeUInt16LE(t.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);              // extra len
    nameBytes.copy(local, 30);

    localParts.push(local, data);

    // Central directory entry
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                  // version made by
    cd.writeUInt16LE(20, 6);                  // version needed
    cd.writeUInt16LE(0, 8);                   // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(t.time, 12);
    cd.writeUInt16LE(t.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);                  // extra len
    cd.writeUInt16LE(0, 32);                  // comment len
    cd.writeUInt16LE(0, 34);                  // disk #
    cd.writeUInt16LE(0, 36);                  // internal attrs
    cd.writeUInt32LE(0, 38);                  // external attrs
    cd.writeUInt32LE(offset, 42);             // offset to local header
    nameBytes.copy(cd, 46);
    centralParts.push(cd);

    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                   // disk #
  eocd.writeUInt16LE(0, 6);                   // disk where CD starts
  eocd.writeUInt16LE(Object.keys(fileMap).length, 8);
  eocd.writeUInt16LE(Object.keys(fileMap).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                  // comment len
  return Buffer.concat([...localParts, central, eocd]);
}

function _dosTime(d) {
  // ZIP DOS time/date — two's complement encoding for 1980-relative.
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function _crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (_crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Write the archive ───────────────────────────────────────────────
const archiveName = `${pkgObj.name.replace(/[@/]/g, '_')}@${pkgObj.version}.gcupkg`;
const archivePath = path.join(pkgRoot, archiveName);
fs.writeFileSync(archivePath, makeZip(files));
console.log(`Packed ${archiveName} (${(fs.statSync(archivePath).size / 1024).toFixed(1)} KB)`);
console.log(`Integrity: ${integrity}`);
console.log(`Files: ${Object.keys(files).join(', ')}`);
