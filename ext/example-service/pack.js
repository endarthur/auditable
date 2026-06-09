#!/usr/bin/env node
// Packs @example/service into a .gcupkg distributable — a SHELL-ONLY package
// (no notebook-context index.js). Layout (EXTENSION_SPEC §6.1 + §3.9):
//
//   example_service@0.1.0.gcupkg            (ZIP)
//   ├── .gcupkg-meta.json
//   ├── package.json        (declares the service under gcu.services)
//   ├── service.js          (the service entry — exports setupService)
//   ├── LICENSE
//   └── README.md
//
// Integrity: SHA-256 over [service.js] with NUL framing (§6.1 hash recipe).
//
// NB: the minimal ZIP writer below is duplicated from ext/example-quip/pack.js —
// a known dedup candidate for @gcu/build (the owned bundler/packer; see
// ext/build/SPEC.md), which will replace the hand-rolled pack scripts.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = __dirname;
const read = (rel) => fs.readFileSync(path.join(pkgRoot, rel));

const packageJson = read('package.json');
const pkgObj = JSON.parse(packageJson.toString('utf8'));

// File map — archive paths → Buffers. NO index.js (shell-only package).
const files = {
  'package.json': packageJson,
  'service.js':   read('service.js'),
  'LICENSE':      read('LICENSE'),
  'README.md':    read('README.md'),
};

// Integrity: SHA-256 over sorted integrityCovers with filename\0bytes\0 framing.
const covers = ['service.js'];
function sriHashOver(coverNames) {
  const h = crypto.createHash('sha256');
  for (const name of [...coverNames].sort()) {
    h.update(Buffer.from(name, 'utf8'));
    h.update(Buffer.from([0]));
    h.update(files[name]);
    h.update(Buffer.from([0]));
  }
  return 'sha256-' + h.digest('base64');
}
const integrity = sriHashOver(covers);

const meta = {
  gcupkgVersion: 1,
  name:        pkgObj.name,
  version:     pkgObj.version,
  description: pkgObj.description,
  spdx:        pkgObj.license,
  contributes: ['service'],
  size:        { 'service.js': files['service.js'].length },
  integrity,
  integrityCovers: covers,
};
files['.gcupkg-meta.json'] = Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8');

// ── Minimal ZIP writer (deflate-raw / store) ─────────────────────────
function makeZip(fileMap) {
  const localParts = [], centralParts = [];
  let offset = 0;
  const t = _dosTime(new Date());
  for (const [name, content] of Object.entries(fileMap)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = _crc32(content);
    const compressed = zlib.deflateRawSync(content);
    const useDeflate = compressed.length < content.length;
    const data = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(t.time, 10); local.writeUInt16LE(t.date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28); nameBytes.copy(local, 30);
    localParts.push(local, data);
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(t.time, 12); cd.writeUInt16LE(t.date, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46); centralParts.push(cd);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(fileMap).length, 8); eocd.writeUInt16LE(Object.keys(fileMap).length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}
function _dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
const _crcTable = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); tbl[n] = c >>> 0; }
  return tbl;
})();
function _crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (_crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

const archiveName = `${pkgObj.name.replace(/[@/]/g, '_')}@${pkgObj.version}.gcupkg`;
fs.writeFileSync(path.join(pkgRoot, archiveName), makeZip(files));
console.log(`Packed ${archiveName} (${(fs.statSync(path.join(pkgRoot, archiveName)).size / 1024).toFixed(1)} KB)`);
console.log(`Integrity: ${integrity}`);
console.log(`Files: ${Object.keys(files).join(', ')}`);
