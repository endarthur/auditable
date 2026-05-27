// Streaming archive writer — call addFile(path, bytes) / addDirectory(path)
// incrementally, then close() to flush. Memory benefit over archive.compress
// is real for ZIP (fflate's Zip class compresses each entry as it's added)
// and for tar (header + data + padding emit immediately, source bytes can
// be released). tar.gz still buffers the tar stream and pipes it through
// CompressionStream at close — true streaming gzip is a v0.2 enhancement.
//
// Sink semantics (single output file, not a directory):
//   - { vfs, path }   final bytes written at close()
//   - 'memory'        close() returns the Uint8Array directly
//   - WritableStream  chunks pushed as they're produced; closed at close()
//
// At dev time the fflate imports below resolve through ESM; at build time
// they're stripped and references land on the namespaced aliases declared
// after the vendored IIFEs (Zip, ZipDeflate, ZipPassThrough).

import { Zip, ZipDeflate, ZipPassThrough } from '../vendor/fflate.module.mjs';
import { writeTar } from './tar.js';
import { gzipBytes } from './gz.js';

const _nowSec = () => Math.floor(Date.now() / 1000);

// Helper: emit `chunk` to the destination — memory buffer / writable stream
// / VFS-deferred buffer. Same abstraction used by all format-specific
// writers below.
class _ChunkSink {
  constructor(sink) {
    this.sink = sink;
    this.chunks = [];        // for buffered sinks (memory, vfs)
    this.totalLen = 0;
    this._streamWriter = null;
    this._closed = false;

    if (typeof WritableStream !== 'undefined' && sink instanceof WritableStream) {
      this._streamWriter = sink.getWriter();
    }
  }
  async push(chunk) {
    if (this._closed) throw new Error('writer: push after close');
    if (this._streamWriter) {
      await this._streamWriter.write(chunk);
    } else {
      this.chunks.push(chunk);
      this.totalLen += chunk.length;
    }
  }
  async finalize() {
    if (this._closed) throw new Error('writer: close already called');
    this._closed = true;
    if (this._streamWriter) {
      await this._streamWriter.close();
      return undefined;   // stream sink owns the bytes
    }
    // Concat the accumulated chunks.
    const out = new Uint8Array(this.totalLen);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    this.chunks = null;

    if (this.sink === 'memory') return out;
    if (this.sink && typeof this.sink === 'object' && this.sink.vfs && typeof this.sink.path === 'string') {
      const r = this.sink.vfs.writeFile(this.sink.path, out);
      if (r && typeof r.then === 'function') await r;
      return { count: 1, paths: [this.sink.path] };
    }
    throw new TypeError('writer: sink must be { vfs, path } | "memory" | WritableStream');
  }
}

// ── ZIP writer ──────────────────────────────────────────────────────────
//
// fflate's Zip class is event-driven: you push files via .add(...), each
// file pushes its bytes via .push(bytes, final), and zip chunks come out
// of the top-level .ondata callback. Wire it to our ChunkSink.

class _ZipWriter {
  constructor(sink, opts) {
    this._sink = new _ChunkSink(sink);
    this._z = new Zip();
    this._z.ondata = (err, chunk, final) => {
      if (err) { this._pendingError = err; return; }
      if (chunk && chunk.length > 0) {
        // ondata is sync, but our sink.push is async. Queue the work via
        // _writePromise so addFile/close can await it.
        const p = this._sink.push(chunk).catch((e) => { this._pendingError = e; });
        this._writePromise = this._writePromise
          ? this._writePromise.then(() => p) : p;
      }
    };
    this._writePromise = null;
    this._pendingError = null;
    this._level = (opts && typeof opts.level === 'number')
      ? Math.max(0, Math.min(9, opts.level | 0)) : 6;
  }

  async addFile(path, bytes, opts) {
    if (this._pendingError) throw this._pendingError;
    const buf = bytes instanceof Uint8Array ? bytes
      : (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
    // Per-file level override falls back to the writer-wide level.
    // level=0 → STORE (no compression); else DEFLATE at that level.
    // EPUB needs this: mimetype MUST be stored, everything else deflated.
    const lvl = (opts && typeof opts.level === 'number')
      ? Math.max(0, Math.min(9, opts.level | 0))
      : this._level;
    const file = lvl === 0
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: lvl });
    this._z.add(file);
    file.push(buf, true);   // single-shot — all bytes for this file at once
    if (this._writePromise) await this._writePromise;
    if (this._pendingError) throw this._pendingError;
  }

  async addDirectory(path) {
    if (!path.endsWith('/')) path = path + '/';
    // fflate emits a directory entry from a ZipPassThrough with no data.
    const dir = new ZipPassThrough(path);
    this._z.add(dir);
    dir.push(new Uint8Array(0), true);
    if (this._writePromise) await this._writePromise;
    if (this._pendingError) throw this._pendingError;
  }

  async close() {
    if (this._pendingError) throw this._pendingError;
    this._z.end();
    if (this._writePromise) await this._writePromise;
    if (this._pendingError) throw this._pendingError;
    return this._sink.finalize();
  }
}

// ── tar writer ──────────────────────────────────────────────────────────
//
// True streaming: header + data + padding emit to the sink the moment
// addFile returns. close() pushes the 1024-byte end-of-archive marker.
// Building the header from scratch here would duplicate the implementation
// in tar.js, so we call writeTar with one entry at a time and SLICE OFF
// the end-of-archive marker, then emit a fresh marker only at close().

const _TAR_TRAILER = new Uint8Array(1024);  // shared zero-bytes block

class _TarWriter {
  constructor(sink) {
    this._sink = new _ChunkSink(sink);
  }

  async addFile(path, bytes) {
    const buf = bytes instanceof Uint8Array ? bytes
      : (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
    // writeTar({ path: bytes }) emits header + data (rounded to 512) + 1024
    // zero bytes. Drop the trailer; we emit it once at close().
    const full = writeTar({ [path]: buf });
    await this._sink.push(full.subarray(0, full.length - 1024));
  }

  async addDirectory(path) {
    if (!path.endsWith('/')) path = path + '/';
    const full = writeTar({ [path]: new Uint8Array(0) });
    await this._sink.push(full.subarray(0, full.length - 1024));
  }

  async close() {
    await this._sink.push(_TAR_TRAILER);
    return this._sink.finalize();
  }
}

// ── tar.gz writer ───────────────────────────────────────────────────────
//
// For v0.1: buffer the tar stream in memory, gzip it at close. This still
// gives the memory-saving "release input bytes after addFile" benefit, but
// the output isn't true-streaming. A future enhancement can wire
// CompressionStream incrementally for true streaming gzip.

class _TarGzWriter {
  constructor(sink) {
    this._inner = new _TarWriter('memory');
    this._sink = sink;
  }
  addFile(path, bytes)  { return this._inner.addFile(path, bytes); }
  addDirectory(path)    { return this._inner.addDirectory(path); }
  async close() {
    const tarBytes = await this._inner.close();   // Uint8Array
    const gz = await gzipBytes(tarBytes);
    const out = new _ChunkSink(this._sink);
    await out.push(gz);
    return out.finalize();
  }
}

// ── Public ──────────────────────────────────────────────────────────────

export function createWriter(sink, opts = {}) {
  if (!sink) throw new TypeError('createWriter: sink required');
  const format = opts.format;
  if (!format) throw new TypeError('createWriter: opts.format required (zip | tar | tar.gz)');
  if (format === 'zip')    return new _ZipWriter(sink, opts);
  if (format === 'tar')    return new _TarWriter(sink);
  if (format === 'tar.gz') return new _TarGzWriter(sink);
  if (format === 'tar.zst') {
    throw new Error('createWriter: tar.zst encode not available (fzstd is decode-only)');
  }
  if (format === 'gz' || format === 'zst') {
    throw new Error(`createWriter: ${format} is a single-stream format — use archive.${format === 'gz' ? 'gzip' : 'zstd'} for that`);
  }
  if (format === 'xz' || format === 'tar.xz') {
    throw new Error(`createWriter: ${format} encode not available (xz-decompress is decode-only)`);
  }
  if (format === 'bz2' || format === 'tar.bz2') {
    throw new Error(`createWriter: ${format} encode not available (seek-bzip is decode-only)`);
  }
  throw new Error(`createWriter: unsupported format '${format}'`);
}
