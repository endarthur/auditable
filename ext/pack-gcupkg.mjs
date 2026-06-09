// Shared .gcupkg packer — builds a .gcupkg (ZIP) from a file map + computes the
// internal integrity (the .gcupkg-meta.json hash over integrityCovers). Used by
// build.js's `packages` target to pack auditable's first-party distributables
// into a catalog. The per-package pack.js scripts (ext/example-*/pack.js) predate
// this and hand-roll the same ZIP writer — a dedup @gcu/build will finish owning
// (ext/build/SPEC.md). This is the single library version.
//
// packGcupkg({ name, version, description, license, files, contributes,
//   integrityCovers }) → Buffer  (the .gcupkg bytes; deterministic given inputs
//   + the supplied `date`, so a deploy build can be reproducible).

import crypto from 'crypto';
import zlib from 'zlib';

// SHA-256 over sorted integrityCovers with filename\0bytes\0 framing (§6.1).
function sriOver(coverNames, files) {
  const h = crypto.createHash('sha256');
  for (const name of [...coverNames].sort()) {
    if (!files[name]) throw new Error(`pack-gcupkg: integrityCovers names a missing file: ${name}`);
    h.update(Buffer.from(name, 'utf8'));
    h.update(Buffer.from([0]));
    h.update(Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name]));
    h.update(Buffer.from([0]));
  }
  return 'sha256-' + h.digest('base64');
}

export function packGcupkg(spec) {
  const { name, version, description, license, contributes = [], integrityCovers } = spec;
  if (!name || !version) throw new Error('packGcupkg: name + version required');
  // Normalize file values to Buffers.
  const files = {};
  for (const [k, v] of Object.entries(spec.files || {})) {
    files[k] = Buffer.isBuffer(v) ? v : Buffer.from(v);
  }
  for (const req of ['package.json', 'LICENSE']) {
    if (!files[req]) throw new Error(`packGcupkg: required file missing: ${req}`);
  }
  const covers = integrityCovers && integrityCovers.length ? integrityCovers
    : (files['index.js'] ? ['index.js'] : Object.keys(files).filter((f) => f.endsWith('.js')));
  const integrity = sriOver(covers, files);

  const size = {};
  for (const c of covers) size[c] = files[c].length;
  const meta = {
    gcupkgVersion: 1, name, version,
    description: description || '',
    spdx: license || 'UNLICENSED',
    contributes, size, integrity, integrityCovers: covers,
  };
  files['.gcupkg-meta.json'] = Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8');

  return { bytes: makeZip(files, spec.date), integrity, files };
}

// SRI over the whole .gcupkg artifact bytes (the registry-level integrity field,
// distinct from the internal meta hash). Matches registry.js's sriOf.
export function sriOfBytes(bytes) {
  return 'sha256-' + crypto.createHash('sha256').update(bytes).digest('base64');
}

// ── Minimal ZIP writer (deflate-raw / store) ─────────────────────────
function makeZip(fileMap, date) {
  const localParts = [], centralParts = [];
  let offset = 0;
  const t = _dosTime(date || new Date());
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
