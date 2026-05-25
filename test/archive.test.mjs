// @gcu/archive — foundation tests (format detection + source/sink adapters
// + ZIP list/read/extract). All fixtures built programmatically with fflate
// so the tests are self-contained.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';   // for building .zst test fixtures (Node 22+ native zstd)

import {
  detectFormat, magicForFormat,
  normalizeSource, normalizeSink,
  listZip, readZip,
  listTar, readTar, writeTar,
  gunzipBytes, gzipBytes,
  unzstdBytes, zstdBytes,
  archive,
} from '../ext/archive/src/main.js';

// We import fflate's zipSync only here, to BUILD the test fixtures —
// the production code uses the vendored bundle's strip-stripped version.
import { zipSync } from '../ext/archive/vendor/fflate.module.mjs';

const enc = (s) => new TextEncoder().encode(s);

// ── detectFormat ────────────────────────────────────────────────────────

test('detectFormat: zip magic', () => {
  // PK\x03\x04 + minimal padding so length checks pass.
  const u = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal(detectFormat(u), 'zip');
});

test('detectFormat: gzip magic', () => {
  const u = new Uint8Array([0x1f, 0x8b, 0x08, 0]);
  assert.equal(detectFormat(u), 'gz');
});

test('detectFormat: zstd magic', () => {
  const u = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
  assert.equal(detectFormat(u), 'zst');
});

test('detectFormat: xz magic', () => {
  const u = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  assert.equal(detectFormat(u), 'xz');
});

test('detectFormat: bz2 magic', () => {
  const u = new Uint8Array([0x42, 0x5a, 0x68]);
  assert.equal(detectFormat(u), 'bz2');
});

test('detectFormat: tar ustar header at offset 257', () => {
  const u = new Uint8Array(512);
  // Set "ustar" at offset 257.
  u.set(enc('ustar'), 257);
  assert.equal(detectFormat(u), 'tar');
});

test('detectFormat: unknown bytes → null', () => {
  assert.equal(detectFormat(new Uint8Array([0, 1, 2, 3, 4])), null);
  assert.equal(detectFormat(null), null);
  assert.equal(detectFormat(new Uint8Array(0)), null);
});

test('detectFormat: ArrayBuffer input', () => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint8(0, 0x50);
  new DataView(buf).setUint8(1, 0x4B);
  assert.equal(detectFormat(buf), 'zip');
});

// ── magicForFormat (extension fallback) ─────────────────────────────────

test('magicForFormat: compound extensions', () => {
  assert.equal(magicForFormat('foo.tar.gz'), 'tar.gz');
  assert.equal(magicForFormat('foo.tar.zst'), 'tar.zst');
  assert.equal(magicForFormat('foo.tar.xz'), 'tar.xz');
  assert.equal(magicForFormat('foo.tar.bz2'), 'tar.bz2');
  assert.equal(magicForFormat('foo.tgz'), 'tar.gz');
  assert.equal(magicForFormat('foo.tzst'), 'tar.zst');
});

test('magicForFormat: single extensions', () => {
  assert.equal(magicForFormat('foo.zip'), 'zip');
  assert.equal(magicForFormat('foo.tar'), 'tar');
  assert.equal(magicForFormat('foo.gz'), 'gz');
  assert.equal(magicForFormat('foo.zst'), 'zst');
});

test('magicForFormat: unknown / missing → null', () => {
  assert.equal(magicForFormat('foo.exe'), null);
  assert.equal(magicForFormat('LICENSE'), null);
  assert.equal(magicForFormat(null), null);
  assert.equal(magicForFormat(42), null);
});

// ── normalizeSource ─────────────────────────────────────────────────────

test('normalizeSource: Uint8Array passthrough', async () => {
  const u = new Uint8Array([1, 2, 3]);
  const s = normalizeSource(u);
  assert.equal(s.name, null);
  assert.deepEqual(await s.bytes(), u);
});

test('normalizeSource: ArrayBuffer wraps to Uint8Array', async () => {
  const buf = new Uint8Array([1, 2, 3]).buffer;
  const s = normalizeSource(buf);
  assert.deepEqual(await s.bytes(), new Uint8Array([1, 2, 3]));
});

test('normalizeSource: { vfs, path } reads via vfs.readFile', async () => {
  const vfs = {
    readFile: (p) => {
      if (p === '/data.zip') return new Uint8Array([0x50, 0x4B]);
      throw new Error('not found');
    },
  };
  const s = normalizeSource({ vfs, path: '/data.zip' });
  assert.equal(s.name, 'data.zip');
  assert.deepEqual(await s.bytes(), new Uint8Array([0x50, 0x4B]));
});

test('normalizeSource: { vfs, path } accepts strings (utf8 encode)', async () => {
  const vfs = { readFile: () => 'hello' };
  const s = normalizeSource({ vfs, path: '/foo.txt' });
  assert.deepEqual(await s.bytes(), enc('hello'));
});

test('normalizeSource: { fetch } uses injected fetchFn', async () => {
  const fetchFn = async (url) => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([0x50, 0x4B, 0x03, 0x04]).buffer,
  });
  const s = normalizeSource({ fetch: 'https://example.com/x.zip', fetchFn });
  assert.equal(s.name, 'x.zip');
  assert.deepEqual(await s.bytes(), new Uint8Array([0x50, 0x4B, 0x03, 0x04]));
});

test('normalizeSource: rejects unrecognized shapes', () => {
  assert.throws(() => normalizeSource(null));
  assert.throws(() => normalizeSource({}));
  assert.throws(() => normalizeSource(42));
});

// ── normalizeSink ───────────────────────────────────────────────────────

test('normalizeSink: memory sink collects writes', async () => {
  const sink = normalizeSink('memory');
  await sink.writeFile('a.txt', enc('hello'));
  await sink.writeFile('b/c.txt', enc('world'));
  const result = sink.result();
  assert.equal(result.size, 2);
  assert.deepEqual(result.get('a.txt'), enc('hello'));
  assert.deepEqual(result.get('b/c.txt'), enc('world'));
});

test('normalizeSink: vfs sink writes through vfs.writeFile + mkdir', async () => {
  const writes = [];
  const dirs = [];
  const vfs = {
    writeFile: async (p, bytes) => { writes.push({ path: p, bytes }); },
    mkdir:     async (p)        => { dirs.push(p); },
    exists:    async ()         => false,
  };
  const sink = normalizeSink({ vfs, path: '/out' });
  await sink.writeFile('a.txt', enc('hello'));
  await sink.mkdir('sub/dir');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/out/a.txt');
  assert.deepEqual(writes[0].bytes, enc('hello'));
  assert.ok(dirs.includes('/out/sub/dir'));
});

test('normalizeSink: rejects unknown sink shapes', () => {
  assert.throws(() => normalizeSink({}));
  assert.throws(() => normalizeSink('bogus'));
  assert.throws(() => normalizeSink(null));
});

// ── ZIP fixtures + list / read / extract ────────────────────────────────

function makeZipFixture() {
  // A small archive with a directory + nested file + a top-level file.
  return zipSync({
    'README.md': enc('# hello\n'),
    'data/sample.csv': enc('a,b,c\n1,2,3\n'),
    'data/notes.txt': enc('lorem ipsum'),
  });
}

test('listZip: enumerates entries', () => {
  const zip = makeZipFixture();
  const entries = listZip(zip);
  // fflate emits directories as zero-byte entries with trailing '/' when
  // present in the archive metadata; for fixtures built from a flat object
  // (no explicit dir entries), we just get files.
  const names = entries.map((e) => e.path).sort();
  assert.deepEqual(names, ['README.md', 'data/notes.txt', 'data/sample.csv']);
  const readme = entries.find((e) => e.path === 'README.md');
  assert.equal(readme.type, 'file');
  assert.equal(readme.size, enc('# hello\n').length);
});

test('readZip: single-entry extract', () => {
  const zip = makeZipFixture();
  const bytes = readZip(zip, 'README.md');
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes), '# hello\n');
});

test('readZip: missing entry → null', () => {
  const zip = makeZipFixture();
  assert.equal(readZip(zip, 'nope.md'), null);
});

// ── archive.* end-to-end ────────────────────────────────────────────────

test('archive.detect: zip from bytes', async () => {
  assert.equal(await archive.detect(makeZipFixture()), 'zip');
});

test('archive.detect: extension fallback when bytes ambiguous', async () => {
  // Source has a name but bytes don't match — should still resolve via name.
  const s = { vfs: { readFile: () => new Uint8Array([0]) }, path: '/empty.zip' };
  assert.equal(await archive.detect(s), 'zip');
});

test('archive.list: end-to-end', async () => {
  const entries = await archive.list(makeZipFixture());
  assert.equal(entries.length, 3);
});

test('archive.read: end-to-end', async () => {
  const bytes = await archive.read(makeZipFixture(), 'data/sample.csv');
  assert.equal(new TextDecoder().decode(bytes), 'a,b,c\n1,2,3\n');
});

test('archive.extract: into memory sink returns a Map', async () => {
  const result = await archive.extract(makeZipFixture(), 'memory');
  assert.ok(result instanceof Map);
  assert.equal(result.size, 3);
  assert.equal(new TextDecoder().decode(result.get('README.md')), '# hello\n');
});

test('archive.extract: into a vfs sink writes every entry', async () => {
  const written = new Map();
  const vfs = {
    writeFile: async (p, b) => written.set(p, b),
    mkdir:     async ()      => {},
    exists:    async ()      => false,
  };
  const r = await archive.extract(makeZipFixture(), { vfs, path: '/out' });
  assert.equal(r.count, 3);
  assert.ok(written.has('/out/README.md'));
  assert.ok(written.has('/out/data/sample.csv'));
});

test('archive.extract: overwrite=error throws on collision', async () => {
  const vfs = {
    writeFile: async () => {},
    mkdir:     async () => {},
    exists:    async () => true,    // every destination "exists"
  };
  await assert.rejects(
    () => archive.extract(makeZipFixture(), { vfs, path: '/out' }, { overwrite: 'error' }),
    /destination exists/
  );
});

test('archive.extract: overwrite=skip silently skips collisions', async () => {
  const writes = [];
  const vfs = {
    writeFile: async (p) => writes.push(p),
    mkdir:     async () => {},
    exists:    async () => true,
  };
  const r = await archive.extract(makeZipFixture(), { vfs, path: '/out' }, { overwrite: 'skip' });
  assert.equal(r.count, 0);
  assert.equal(writes.length, 0);
});

test('archive.extract: overwrite=rename auto-suffixes', async () => {
  const written = new Set();
  const vfs = {
    writeFile: async (p) => written.add(p),
    mkdir:     async () => {},
    // Reports collision only on the first canonical name; renamed names are free.
    exists:    async (p) => p.endsWith('README.md')
                          || p.endsWith('data/sample.csv')
                          || p.endsWith('data/notes.txt'),
  };
  const r = await archive.extract(makeZipFixture(), { vfs, path: '/out' }, { overwrite: 'rename' });
  assert.equal(r.count, 3);
  // Each entry should have been renamed because exists() returned true for the canonical name.
  assert.ok(r.paths.every((p) => /\(\d+\)/.test(p)), 'expected all paths to be renamed: ' + r.paths.join(', '));
});

test('archive.extract: filter callback excludes entries', async () => {
  const r = await archive.extract(makeZipFixture(), 'memory', {
    filter: (entry) => !entry.path.endsWith('.md'),
  });
  assert.equal(r.size, 2);
  assert.ok(!r.has('README.md'));
});

test('archive.list: xz / bz2 still report needs-Wasm', async () => {
  // xz magic bytes — we recognize the format but the lazy Wasm decoder
  // isn't wired yet.
  const xzMagic = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  await assert.rejects(() => archive.list(xzMagic), /lazy-loaded Wasm/);
});

// ── tar fixtures ────────────────────────────────────────────────────────
//
// We use our own writeTar to build the fixtures — but the read tests run on
// the produced bytes, so a buggy writer would surface as a mismatch in the
// roundtrip tests below. As a sanity belt, the parse-by-hand probe tests
// look at the raw bytes for known fields (magic, checksum, name).

function makeTarFixture() {
  return writeTar({
    'README.md':        enc('# hello\n'),
    'data/sample.csv':  enc('a,b,c\n1,2,3\n'),
    'data/notes.txt':   enc('lorem ipsum'),
    'empty-dir/':       new Uint8Array(0),
  });
}

test('writeTar: emits proper ustar magic + checksum', () => {
  const u = writeTar({ 'foo.txt': enc('hi') });
  // ustar at offset 257.
  assert.equal(new TextDecoder().decode(u.subarray(257, 262)), 'ustar');
  // Checksum field at 148..155 contains 6 octal digits + NUL + space.
  // Recompute and compare with what we wrote.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : u[i];
  const written = parseInt(new TextDecoder().decode(u.subarray(148, 154)).trim(), 8);
  assert.equal(written, sum);
});

test('writeTar: file data is padded to 512-byte blocks', () => {
  const u = writeTar({ 'small.txt': enc('hi') });
  // Header (512) + data (rounded to 512) + 2 trailing zero blocks (1024).
  assert.equal(u.length, 512 + 512 + 1024);
  // Bytes 2..511 of the data region should be zero padding.
  for (let i = 514; i < 1024; i++) assert.equal(u[i], 0);
});

test('writeTar: empty archive (no entries) still has end-of-archive markers', () => {
  const u = writeTar({});
  assert.equal(u.length, 1024);
  for (let i = 0; i < 1024; i++) assert.equal(u[i], 0);
});

// ── listTar / readTar / extractTar ──────────────────────────────────────

test('detectFormat picks up a writeTar-produced archive', () => {
  assert.equal(detectFormat(makeTarFixture()), 'tar');
});

test('listTar: enumerates files + directories', () => {
  const entries = listTar(makeTarFixture());
  const files = entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  const dirs  = entries.filter((e) => e.type === 'directory').map((e) => e.path).sort();
  assert.deepEqual(files, ['README.md', 'data/notes.txt', 'data/sample.csv']);
  assert.deepEqual(dirs, ['empty-dir/']);
  const readme = entries.find((e) => e.path === 'README.md');
  assert.equal(readme.size, enc('# hello\n').length);
});

test('readTar: single-entry extract', () => {
  const bytes = readTar(makeTarFixture(), 'data/sample.csv');
  assert.equal(new TextDecoder().decode(bytes), 'a,b,c\n1,2,3\n');
});

test('readTar: missing entry → null', () => {
  assert.equal(readTar(makeTarFixture(), 'nope.txt'), null);
});

test('listTar: handles long paths via prefix+name split', () => {
  // 120-char path — exceeds the 100-byte `name` field, must use prefix.
  const longPath = 'aaaaaaaaaa/'.repeat(11) + 'leaf.txt';  // 11*11 + 8 = 129
  const u = writeTar({ [longPath]: enc('payload') });
  const entries = listTar(u);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, longPath);
  assert.deepEqual(readTar(u, longPath), enc('payload'));
});

test('writeTar: throws on paths >255 chars (PAX not implemented)', () => {
  // No '/' in the last 100 chars → impossible to split into prefix+name.
  const tooLong = 'a'.repeat(256);
  assert.throws(() => writeTar({ [tooLong]: enc('x') }), /PAX not yet supported/);
});

test('listTar: skips unsupported typeflags silently', () => {
  // Build a tar with one normal file + one symlink-typed entry. Symlink
  // entries have typeflag '2' and no data payload.
  const fileBlock = writeTar({ 'real.txt': enc('hi') }).subarray(0, 1024);  // header + data
  const symBlock = new Uint8Array(512);
  // Build a symlink header by hand.
  symBlock.set(new TextEncoder().encode('symlink.txt'), 0);
  symBlock[156] = '2'.charCodeAt(0);    // typeflag = symlink
  symBlock.set(new TextEncoder().encode('ustar'), 257);
  symBlock[263] = 0x30; symBlock[264] = 0x30;
  // Fill checksum — tar parser handles bad checksums leniently but we be neat.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : symBlock[i];
  const s = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < 6; i++) symBlock[148 + i] = s.charCodeAt(i);

  const combined = new Uint8Array(fileBlock.length + symBlock.length + 1024);
  combined.set(fileBlock, 0);
  combined.set(symBlock, fileBlock.length);
  // No trailing zero block needed for the test — the parser stops at the
  // first all-zero block, and we don't have one here, but we still want to
  // exercise that symlink entries are SKIPPED.

  const entries = listTar(combined);
  // Only the file should appear (symlink skipped).
  assert.equal(entries.filter((e) => e.path === 'real.txt').length, 1);
  assert.equal(entries.filter((e) => e.path === 'symlink.txt').length, 0);
});

// ── archive.* end-to-end with tar ───────────────────────────────────────

test('archive.list: tar end-to-end', async () => {
  const entries = await archive.list(makeTarFixture());
  assert.ok(entries.find((e) => e.path === 'README.md' && e.type === 'file'));
});

test('archive.read: tar end-to-end', async () => {
  const bytes = await archive.read(makeTarFixture(), 'data/notes.txt');
  assert.equal(new TextDecoder().decode(bytes), 'lorem ipsum');
});

test('archive.extract: tar into memory sink', async () => {
  const result = await archive.extract(makeTarFixture(), 'memory');
  assert.ok(result instanceof Map);
  assert.equal(new TextDecoder().decode(result.get('README.md')), '# hello\n');
});

test('archive.extract: tar into vfs sink writes every entry', async () => {
  const written = new Map();
  const dirs = new Set();
  const vfs = {
    writeFile: async (p, b) => written.set(p, b),
    mkdir:     async (p)    => dirs.add(p),
    exists:    async ()     => false,
  };
  const r = await archive.extract(makeTarFixture(), { vfs, path: '/out' });
  assert.ok(written.has('/out/README.md'));
  assert.ok(written.has('/out/data/sample.csv'));
  assert.ok(written.has('/out/data/notes.txt'));
  assert.ok(dirs.has('/out/empty-dir'));
  assert.equal(r.count, 4);   // 3 files + 1 directory
});

test('archive.extract: tar overwrite=rename auto-suffixes', async () => {
  const written = new Set();
  const vfs = {
    writeFile: async (p) => written.add(p),
    mkdir:     async () => {},
    // Report collision for canonical paths only.
    exists:    async (p) => p.endsWith('README.md')
                          || p.endsWith('data/sample.csv')
                          || p.endsWith('data/notes.txt'),
  };
  const r = await archive.extract(makeTarFixture(), { vfs, path: '/out' }, { overwrite: 'rename' });
  // 3 files renamed + 1 directory.
  assert.equal(r.count, 4);
  const files = r.paths.filter((p) => !p.endsWith('/'));
  assert.ok(files.every((p) => /\(\d+\)/.test(p)), 'expected renamed: ' + files.join(', '));
});

// ── gz layer: gunzipBytes / gzipBytes ───────────────────────────────────

test('gzipBytes / gunzipBytes round-trip', async () => {
  const payload = enc('the quick brown fox jumps over the lazy dog '.repeat(20));
  const compressed = await gzipBytes(payload);
  // Magic bytes on the output.
  assert.equal(compressed[0], 0x1f);
  assert.equal(compressed[1], 0x8b);
  assert.ok(compressed.length < payload.length, 'expected gz to be smaller than source');
  const back = await gunzipBytes(compressed);
  assert.deepEqual(back, payload);
});

test('gunzipBytes: rejects non-Uint8Array', async () => {
  await assert.rejects(() => gunzipBytes('hi'), /Uint8Array/);
});

// ── tar.gz end-to-end via archive.* ─────────────────────────────────────

async function makeTarGzFixture() {
  return gzipBytes(makeTarFixture());
}

test('archive.detect: tar.gz reports gz (the outer layer)', async () => {
  const targz = await makeTarGzFixture();
  assert.equal(await archive.detect(targz), 'gz');
});

test('archive.list: tar.gz transparently unwraps gzip → tar', async () => {
  const targz = await makeTarGzFixture();
  const entries = await archive.list(targz);
  const files = entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  assert.deepEqual(files, ['README.md', 'data/notes.txt', 'data/sample.csv']);
});

test('archive.read: tar.gz extracts one entry', async () => {
  const targz = await makeTarGzFixture();
  const bytes = await archive.read(targz, 'data/notes.txt');
  assert.equal(new TextDecoder().decode(bytes), 'lorem ipsum');
});

test('archive.extract: tar.gz into memory sink', async () => {
  const targz = await makeTarGzFixture();
  const result = await archive.extract(targz, 'memory');
  assert.equal(new TextDecoder().decode(result.get('README.md')), '# hello\n');
});

// ── single-file .gz (no inner archive) ──────────────────────────────────

test('archive.list: single-file .gz reports synthetic 1-entry archive', async () => {
  const csv = enc('a,b,c\n1,2,3\n');
  const gz = await gzipBytes(csv);
  // Provide a name hint via the source wrapper.
  const entries = await archive.list({ vfs: { readFile: () => gz }, path: '/data.csv.gz' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'data.csv');
  assert.equal(entries[0].size, csv.length);
});

test('archive.read: single-file .gz returns decompressed bytes', async () => {
  const csv = enc('a,b,c\n1,2,3\n');
  const gz = await gzipBytes(csv);
  const bytes = await archive.read({ vfs: { readFile: () => gz }, path: '/data.csv.gz' }, 'data.csv');
  assert.deepEqual(bytes, csv);
});

test('archive.read: single-file .gz returns null for wrong innerPath', async () => {
  const gz = await gzipBytes(enc('hi'));
  const r = await archive.read({ vfs: { readFile: () => gz }, path: '/x.gz' }, 'not-the-name');
  assert.equal(r, null);
});

test('archive.extract: single-file .gz writes decompressed payload', async () => {
  const csv = enc('a,b,c\n');
  const gz = await gzipBytes(csv);
  const written = new Map();
  const vfs = {
    readFile: () => gz,
    writeFile: async (p, b) => written.set(p, b),
    mkdir: async () => {},
    exists: async () => false,
  };
  await archive.extract({ vfs, path: '/data.csv.gz' }, { vfs, path: '/out' });
  assert.ok(written.has('/out/data.csv'));
  assert.deepEqual(written.get('/out/data.csv'), csv);
});

// ── single-file gzip / gunzip helpers ───────────────────────────────────

test('archive.gzip: VFS source → VFS destination (file path)', async () => {
  const src = enc('hello world ' .repeat(50));
  const written = new Map();
  const vfs = {
    readFile:  (p) => p === '/data.csv' ? src : null,
    writeFile: async (p, b) => written.set(p, b),
  };
  const r = await archive.gzip(
    { vfs, path: '/data.csv' },
    { vfs, path: '/data.csv.gz' }
  );
  assert.equal(r.count, 1);
  assert.ok(written.has('/data.csv.gz'));
  // The bytes at the destination should be a valid gzip stream.
  const gz = written.get('/data.csv.gz');
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  assert.deepEqual(await gunzipBytes(gz), src);
});

test('archive.gunzip: VFS .gz source → VFS destination', async () => {
  const payload = enc('decompressed');
  const gz = await gzipBytes(payload);
  const written = new Map();
  const vfs = {
    readFile:  () => gz,
    writeFile: async (p, b) => written.set(p, b),
  };
  await archive.gunzip(
    { vfs, path: '/data.csv.gz' },
    { vfs, path: '/data.csv' }
  );
  assert.deepEqual(written.get('/data.csv'), payload);
});

test('archive.gzip + gunzip: memory sink returns 1-entry Map', async () => {
  const src = enc('hi');
  const compressed = await archive.gzip(src, 'memory');
  assert.equal(compressed.size, 1);
  // Key is the default 'data.gz' since the source had no name hint.
  const onlyKey = [...compressed.keys()][0];
  assert.match(onlyKey, /\.gz$/);
});

test('archive.gunzip: memory sink', async () => {
  const src = enc('payload');
  const gz = await gzipBytes(src);
  const result = await archive.gunzip(gz, 'memory');
  assert.equal(result.size, 1);
  const [, bytes] = [...result.entries()][0];
  assert.deepEqual(bytes, src);
});

// ── zst layer: unzstdBytes / decode ─────────────────────────────────────

// Build fixtures with Node's native zstd — Node 22+ supports it via zlib.
// fzstd is decode-only, so we can't use our own code to produce inputs.
const _zstdFromBytes = (u8) => new Uint8Array(zlib.zstdCompressSync(u8));

test('unzstdBytes: decode round-trips data compressed with native zstd', async () => {
  const payload = enc('zstd is decode-only in this build; native zstd writes the fixture');
  const compressed = _zstdFromBytes(payload);
  // Magic bytes 28 b5 2f fd.
  assert.equal(compressed[0], 0x28);
  assert.equal(compressed[1], 0xb5);
  assert.equal(compressed[2], 0x2f);
  assert.equal(compressed[3], 0xfd);
  const back = await unzstdBytes(compressed);
  assert.deepEqual(back, payload);
});

test('zstdBytes: throws the decode-only error', async () => {
  await assert.rejects(() => zstdBytes(enc('x')), /decode-only/);
});

test('unzstdBytes: rejects non-Uint8Array', async () => {
  await assert.rejects(() => unzstdBytes('hi'), /Uint8Array/);
});

// ── tar.zst end-to-end via archive.* ────────────────────────────────────

function makeTarZstFixture() {
  return _zstdFromBytes(makeTarFixture());
}

test('archive.detect: tar.zst reports zst (outer layer)', async () => {
  assert.equal(await archive.detect(makeTarZstFixture()), 'zst');
});

test('archive.list: tar.zst transparently unwraps zstd → tar', async () => {
  const entries = await archive.list(makeTarZstFixture());
  const files = entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  assert.deepEqual(files, ['README.md', 'data/notes.txt', 'data/sample.csv']);
});

test('archive.read: tar.zst extracts one entry', async () => {
  const bytes = await archive.read(makeTarZstFixture(), 'data/notes.txt');
  assert.equal(new TextDecoder().decode(bytes), 'lorem ipsum');
});

test('archive.extract: tar.zst into memory sink', async () => {
  const result = await archive.extract(makeTarZstFixture(), 'memory');
  assert.equal(new TextDecoder().decode(result.get('README.md')), '# hello\n');
});

// ── single-file .zst (no inner archive) ─────────────────────────────────

test('archive.list: single-file .zst reports 1-entry synthetic archive', async () => {
  const csv = enc('a,b,c\n1,2,3\n');
  const zst = _zstdFromBytes(csv);
  const entries = await archive.list({ vfs: { readFile: () => zst }, path: '/data.csv.zst' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'data.csv');
  assert.equal(entries[0].size, csv.length);
});

test('archive.read: single-file .zst returns decompressed bytes', async () => {
  const csv = enc('a,b,c\n1,2,3\n');
  const zst = _zstdFromBytes(csv);
  const bytes = await archive.read({ vfs: { readFile: () => zst }, path: '/data.csv.zst' }, 'data.csv');
  assert.deepEqual(bytes, csv);
});

test('archive.extract: single-file .zst writes decompressed payload', async () => {
  const csv = enc('a,b,c\n');
  const zst = _zstdFromBytes(csv);
  const written = new Map();
  const vfs = {
    readFile: () => zst,
    writeFile: async (p, b) => written.set(p, b),
    mkdir: async () => {},
    exists: async () => false,
  };
  await archive.extract({ vfs, path: '/data.csv.zst' }, { vfs, path: '/out' });
  assert.ok(written.has('/out/data.csv'));
  assert.deepEqual(written.get('/out/data.csv'), csv);
});

// ── single-file zstd / unzstd helpers ───────────────────────────────────

test('archive.unzstd: VFS source → VFS destination (file path)', async () => {
  const payload = enc('decompressed');
  const zst = _zstdFromBytes(payload);
  const written = new Map();
  const vfs = {
    readFile:  () => zst,
    writeFile: async (p, b) => written.set(p, b),
  };
  await archive.unzstd(
    { vfs, path: '/data.csv.zst' },
    { vfs, path: '/data.csv' }
  );
  assert.deepEqual(written.get('/data.csv'), payload);
});

test('archive.zstd: throws the decode-only error', async () => {
  await assert.rejects(
    () => archive.zstd(enc('hi'), 'memory'),
    /decode-only/
  );
});

test('archive.list: unrecognized format throws', async () => {
  await assert.rejects(() => archive.list(new Uint8Array([0, 0, 0, 0])),
    /could not detect format/);
});
