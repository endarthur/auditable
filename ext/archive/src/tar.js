import { autoRename } from './sink.js';

// POSIX ustar reader + writer. ~150 LOC inline implementation — the format
// is simple enough that vendoring a library would add more bytes than the
// implementation itself.
//
// Format recap:
//   - Archive = sequence of (header + data) records, each padded to 512.
//   - Header is 512 bytes; only the first ~500 are used. Trailing pad is NUL.
//   - Numeric fields are ASCII octal, NUL- or space-terminated.
//   - End of archive: two consecutive 512-byte blocks of all zeros.
//   - Typeflag '0' or '\0' = regular file; '5' = directory; others ignored.
//   - Paths up to 100 chars in `name`; longer ones use `prefix` (155 chars)
//     and join as `${prefix}/${name}`. Anything beyond ~255 chars needs
//     PAX/GNU long-link extensions (not implemented yet).
//
// All sizes / offsets are spec-mandated; magic numbers below are field
// boundaries within the 512-byte header, not arbitrary choices.

const BLOCK = 512;

// ── Helpers ─────────────────────────────────────────────────────────────

function _readString(block, off, len) {
  let end = off;
  while (end < off + len && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(off, end));
}

function _readOctal(block, off, len) {
  // The trailing byte is typically NUL or space; trim and parse.
  const s = _readString(block, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function _isAllZero(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function _writeString(block, off, maxLen, s) {
  const bytes = new TextEncoder().encode(String(s));
  const len = Math.min(bytes.length, maxLen);
  block.set(bytes.subarray(0, len), off);
  // Trailing space stays zero — that's the NUL terminator.
}

function _writeOctal(block, off, len, n) {
  // Right-aligned octal ASCII + trailing NUL (POSIX style).
  const s = Math.floor(n).toString(8);
  const fieldLen = len - 1;        // leave room for the NUL
  if (s.length > fieldLen) throw new Error(`tar: value ${n} too large for ${len}-byte field`);
  const padded = s.padStart(fieldLen, '0');
  for (let i = 0; i < fieldLen; i++) block[off + i] = padded.charCodeAt(i);
  block[off + fieldLen] = 0;
}

// Per POSIX, the checksum is the sum of all bytes in the header treating the
// chksum field itself as 8 spaces (0x20). Written back as octal (6 digits +
// NUL + space) so writers can be lenient.
function _computeChecksum(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += (i >= 148 && i < 156) ? 0x20 : block[i];
  }
  return sum;
}

// ── parseHeader ─────────────────────────────────────────────────────────

function _parseHeader(block) {
  if (_isAllZero(block)) return null;
  const name     = _readString(block, 0,   100);
  const mode     = _readOctal (block, 100, 8);
  const uid      = _readOctal (block, 108, 8);
  const gid      = _readOctal (block, 116, 8);
  const size     = _readOctal (block, 124, 12);
  const mtime    = _readOctal (block, 136, 12);
  const chksum   = _readOctal (block, 148, 8);
  const typeflag = String.fromCharCode(block[156]);
  const linkname = _readString(block, 157, 100);
  const magic    = _readString(block, 257, 6);
  const prefix   = _readString(block, 345, 155);
  const fullPath = prefix ? `${prefix}/${name}` : name;
  return { path: fullPath, mode, uid, gid, size, mtime, chksum, typeflag, linkname, magic };
}

// Treat the entry as a file when typeflag is '0' or NUL (the legacy zero
// byte from pre-POSIX tars). Treat as a directory when '5' or the path ends
// with '/'. Anything else (symlinks, fifos, pax extended headers, GNU long
// names) is silently skipped — recognized in `_isUnsupported` so the test
// suite can probe it.
function _isFile(h)      { return h.typeflag === '0' || h.typeflag === '\0' || h.typeflag === ''; }
function _isDirectory(h) { return h.typeflag === '5' || h.path.endsWith('/'); }

// ── Public read API ─────────────────────────────────────────────────────

export function listTar(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('listTar: bytes must be a Uint8Array');
  const out = [];
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const hdr = _parseHeader(bytes.subarray(off, off + BLOCK));
    if (!hdr) break;
    if (_isDirectory(hdr)) {
      out.push({ path: hdr.path.endsWith('/') ? hdr.path : hdr.path + '/', type: 'directory' });
    } else if (_isFile(hdr)) {
      out.push({ path: hdr.path, type: 'file', size: hdr.size, mtime: new Date(hdr.mtime * 1000) });
    }
    // Advance past header + data (data rounded up to BLOCK).
    const dataBlocks = Math.ceil(hdr.size / BLOCK);
    off += BLOCK * (1 + dataBlocks);
  }
  return out;
}

export function readTar(bytes, innerPath) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readTar: bytes must be a Uint8Array');
  if (typeof innerPath !== 'string' || !innerPath) {
    throw new TypeError('readTar: innerPath must be a non-empty string');
  }
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const hdr = _parseHeader(bytes.subarray(off, off + BLOCK));
    if (!hdr) break;
    if (_isFile(hdr) && hdr.path === innerPath) {
      return bytes.subarray(off + BLOCK, off + BLOCK + hdr.size);
    }
    const dataBlocks = Math.ceil(hdr.size / BLOCK);
    off += BLOCK * (1 + dataBlocks);
  }
  return null;
}

export async function extractTar(bytes, sink, opts) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('extractTar: bytes must be a Uint8Array');
  const overwrite = (opts && opts.overwrite) || 'error';
  const filter    = (opts && opts.filter)    || null;
  const progress  = (opts && opts.progress)  || null;
  const paths = [];

  // Best-effort progress total — sum data sizes from headers.
  let total = 0;
  {
    let probe = 0;
    while (probe + BLOCK <= bytes.length) {
      const hdr = _parseHeader(bytes.subarray(probe, probe + BLOCK));
      if (!hdr) break;
      if (_isFile(hdr)) total += hdr.size;
      probe += BLOCK * (1 + Math.ceil(hdr.size / BLOCK));
    }
  }

  let done = 0;
  let off = 0;
  while (off + BLOCK <= bytes.length) {
    const hdr = _parseHeader(bytes.subarray(off, off + BLOCK));
    if (!hdr) break;
    const dataBlocks = Math.ceil(hdr.size / BLOCK);

    if (filter && !filter({ path: hdr.path })) {
      off += BLOCK * (1 + dataBlocks);
      continue;
    }

    if (_isDirectory(hdr)) {
      const p = hdr.path.endsWith('/') ? hdr.path.slice(0, -1) : hdr.path;
      await sink.mkdir(p);
      paths.push(hdr.path.endsWith('/') ? hdr.path : hdr.path + '/');
    } else if (_isFile(hdr)) {
      let target = hdr.path;
      if (await sink.exists(target)) {
        if (overwrite === 'error')     throw new Error(`extract: destination exists — ${hdr.path}`);
        else if (overwrite === 'skip') { off += BLOCK * (1 + dataBlocks); continue; }
        else if (overwrite === 'rename') target = await autoRename(sink, hdr.path);
      }
      const data = bytes.subarray(off + BLOCK, off + BLOCK + hdr.size);
      await sink.writeFile(target, data);
      paths.push(target);
      done += hdr.size;
      if (progress) progress({ path: hdr.path, bytesDone: done, bytesTotal: total });
    }
    // Unsupported typeflags (symlink, pax, etc.) just get skipped — caller
    // sees them missing from the output. A future commit can warn.

    off += BLOCK * (1 + dataBlocks);
  }
  return { count: paths.length, paths };
}

// ── Public write API ────────────────────────────────────────────────────
//
// writeTar({ 'README.md': bytes, 'src/foo.js': bytes, ... }) → Uint8Array
//
// Mirrors fflate's zipSync shape so callers can swap between formats. For
// each entry: build a header block, append data (padded to 512), then the
// final two zero blocks. Directories are inferred from paths ending '/';
// otherwise emitted as type='5' when an entry's value is the empty
// Uint8Array AND the key ends with '/'.

export function writeTar(entries, opts) {
  if (!entries || typeof entries !== 'object') {
    throw new TypeError('writeTar: entries must be an object map');
  }
  const mtime = (opts && opts.mtime) || Math.floor(Date.now() / 1000);
  const mode = (opts && opts.mode) || 0o644;
  const chunks = [];

  for (const [path, data] of Object.entries(entries)) {
    const isDir = path.endsWith('/');
    const bytes = isDir ? new Uint8Array(0)
      : (data instanceof Uint8Array ? data : new Uint8Array(data));

    const header = _buildHeader(path, bytes.length, isDir ? '5' : '0',
      isDir ? (mode | 0o111) : mode, mtime);
    chunks.push(header);
    if (bytes.length > 0) {
      chunks.push(bytes);
      const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
      if (pad > 0) chunks.push(new Uint8Array(pad));
    }
  }
  // End-of-archive marker: two zero blocks.
  chunks.push(new Uint8Array(BLOCK * 2));

  // Concat.
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function _buildHeader(path, size, typeflag, mode, mtime) {
  // Split paths > 100 chars into prefix + name.
  let name = path, prefix = '';
  if (path.length > 100) {
    // Find a '/' such that the suffix fits in 100 bytes and the prefix in 155.
    let split = -1;
    for (let i = path.length - 100; i < path.length && i <= 155; i++) {
      if (path[i] === '/') { split = i; break; }
    }
    if (split < 0) throw new Error(`tar: path too long (>255 chars, PAX not yet supported): ${path}`);
    prefix = path.slice(0, split);
    name   = path.slice(split + 1);
  }

  const block = new Uint8Array(BLOCK);
  _writeString(block, 0,   100, name);
  _writeOctal (block, 100, 8,   mode);
  _writeOctal (block, 108, 8,   0);            // uid
  _writeOctal (block, 116, 8,   0);            // gid
  _writeOctal (block, 124, 12,  size);
  _writeOctal (block, 136, 12,  mtime);
  // chksum field stays zero for now — we'll fill below.
  block[156] = typeflag.charCodeAt(0);
  _writeString(block, 257, 6,   'ustar');
  block[263] = 0x30; block[264] = 0x30;        // version '00'
  if (prefix) _writeString(block, 345, 155, prefix);

  // Compute chksum + write back.
  const sum = _computeChecksum(block);
  // GNU convention: 6 octal digits + NUL + space. POSIX accepts either.
  const s = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < 6; i++) block[148 + i] = s.charCodeAt(i);
  block[154] = 0;     // NUL
  block[155] = 0x20;  // space
  return block;
}
