// @gcu/archive — foundation tests (format detection + source/sink adapters
// + ZIP list/read/extract). All fixtures built programmatically with fflate
// so the tests are self-contained.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectFormat, magicForFormat,
  normalizeSource, normalizeSink,
  listZip, readZip,
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

test('archive.list: tar / gz / zst report not-yet-wired', async () => {
  for (const magic of [
    new Uint8Array([0x1f, 0x8b, 0, 0]),                            // gz
    new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),                       // zst
    (() => { const u = new Uint8Array(512); u.set(enc('ustar'), 257); return u; })(), // tar
  ]) {
    await assert.rejects(() => archive.list(magic), /not yet wired/);
  }
});

test('archive.list: unrecognized format throws', async () => {
  await assert.rejects(() => archive.list(new Uint8Array([0, 0, 0, 0])),
    /could not detect format/);
});
