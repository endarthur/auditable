// Geas archive builtin tests — call each builtin with a synthetic VFS +
// stdout/stderr capture, verify exit codes + side effects. Builtins
// dynamically import @gcu/archive; in tests, the '../../archive/index.js'
// candidate resolves directly through the filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveBuiltins } from '../ext/geas/src/builtins-archive.js';
import { archive } from '../ext/archive/src/main.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// ── Synthetic VFS + ctx ─────────────────────────────────────────────────
//
// The VFS mirrors the @gcu/vfs read/write/readdir/stat/mkdir/unlink/exists
// surface. readFile defaults to 'bytes' so binary round-trips cleanly —
// matches the lesson we already learned in the archive arc.

function makeVfs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set(['/']);
  for (const p of files.keys()) {
    let cur = p;
    while (cur !== '/' && cur.length > 0) {
      const slash = cur.lastIndexOf('/');
      cur = slash <= 0 ? '/' : cur.slice(0, slash);
      dirs.add(cur);
    }
  }
  return {
    async readFile(p, encoding) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      const bytes = files.get(p);
      if (encoding === 'utf8' || encoding === 'text') return dec(bytes);
      return bytes;  // default to bytes (Uint8Array)
    },
    async writeFile(p, bytes) {
      files.set(p, bytes instanceof Uint8Array ? bytes : enc(String(bytes)));
      let cur = p;
      while (cur !== '/' && cur.length > 0) {
        const slash = cur.lastIndexOf('/');
        cur = slash <= 0 ? '/' : cur.slice(0, slash);
        dirs.add(cur);
      }
    },
    async readdir(p) {
      const norm = p.replace(/\/+$/, '') || '/';
      if (!dirs.has(norm)) throw new Error(`ENOENT: ${p}`);
      const prefix = norm === '/' ? '/' : norm + '/';
      const names = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === norm) continue;
        const rest = d.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
      return [...names];
    },
    async stat(p) {
      if (files.has(p)) return { type: 'file', size: files.get(p).length };
      if (dirs.has(p)) return { type: 'directory' };
      throw new Error(`ENOENT: ${p}`);
    },
    async mkdir(p, opts) {
      const norm = p.replace(/\/+$/, '') || '/';
      if (opts && opts.recursive) {
        let cur = '';
        for (const seg of norm.split('/')) {
          if (!seg) continue;
          cur += '/' + seg;
          dirs.add(cur);
        }
      } else {
        dirs.add(norm);
      }
    },
    async unlink(p) { files.delete(p); },
    async exists(p) { return files.has(p) || dirs.has(p); },
    _files: files,
    _dirs: dirs,
  };
}

function makeCtx(vfs, opts = {}) {
  let stdoutBuf = '', stderrBuf = '';
  return {
    vfs,
    cwd: opts.cwd || '/',
    env: opts.env || {},
    stdin: opts.stdin || '',
    stdout: async (s) => { stdoutBuf += s; },
    stderr: async (s) => { stderrBuf += s; },
    _getStdout: () => stdoutBuf,
    _getStderr: () => stderrBuf,
  };
}

const builtins = archiveBuiltins();
const tar    = builtins.tar;
const gzip   = builtins.gzip;
const gunzip = builtins.gunzip;
const zstd   = builtins.zstd;
const unzstd = builtins.unzstd;
const zip    = builtins.zip;
const unzip  = builtins.unzip;

// ── tar ─────────────────────────────────────────────────────────────────

test('tar -tf lists archive entries', async () => {
  // archive.compress walks a dir and uses paths RELATIVE to that dir; no
  // basename prefix is applied. The tar/zip builtins DO add a basename
  // prefix on -c (matching CLI tar's behaviour). These tests use the
  // library directly to build fixtures, so entries are stem-relative.
  const vfs = makeVfs({
    '/work/x.txt': enc('hi'),
    '/work/y.txt': enc('hello'),
  });
  await archive.compress({ vfs, path: '/work' }, { vfs, path: '/data.tar' }, { format: 'tar' });
  const ctx = makeCtx(vfs);
  const code = await tar(['tar', '-tf', '/data.tar'], ctx);
  assert.equal(code, 0);
  assert.match(ctx._getStdout(), /^x\.txt$/m);
  assert.match(ctx._getStdout(), /^y\.txt$/m);
});

test('tar -tvf lists with sizes', async () => {
  const vfs = makeVfs({ '/work/x.txt': enc('hi') });
  await archive.compress({ vfs, path: '/work' }, { vfs, path: '/data.tar' }, { format: 'tar' });
  const ctx = makeCtx(vfs);
  await tar(['tar', '-tvf', '/data.tar'], ctx);
  assert.match(ctx._getStdout(), /\s+2\s+x\.txt/);
});

test('tar -xf extracts to cwd', async () => {
  const vfs = makeVfs({ '/in/a.txt': enc('alpha'), '/in/b.txt': enc('beta') });
  await archive.compress({ vfs, path: '/in' }, { vfs, path: '/data.tar' }, { format: 'tar' });
  const ctx = makeCtx(vfs, { cwd: '/out' });
  await vfs.mkdir('/out', { recursive: true });
  const code = await tar(['tar', '-xf', '/data.tar'], ctx);
  assert.equal(code, 0);
  // Fixture entries are 'a.txt' / 'b.txt' (no leading 'in/' since
  // archive.compress walks-relative). Extracting to /out lands them at
  // /out/a.txt and /out/b.txt.
  assert.deepEqual(await vfs.readFile('/out/a.txt'), enc('alpha'));
});

test('tar -xf -C DIR extracts into the given dir', async () => {
  const vfs = makeVfs({ '/source/x.txt': enc('hi') });
  await archive.compress({ vfs, path: '/source' }, { vfs, path: '/data.tar' }, { format: 'tar' });
  await vfs.mkdir('/target', { recursive: true });
  const ctx = makeCtx(vfs);
  await tar(['tar', '-xf', '/data.tar', '-C', '/target'], ctx);
  assert.deepEqual(await vfs.readFile('/target/x.txt'), enc('hi'));
});

test('tar -czf creates a tar.gz from a directory (adds basename prefix)', async () => {
  // The tar -c builtin walks each source and PREFIXES entries with the
  // source's basename — so /proj's contents land under 'proj/' inside the
  // archive. Mirrors `cd ..; tar -czf out.tar.gz proj` convention.
  const vfs = makeVfs({
    '/proj/README.md': enc('# hello'),
    '/proj/src/main.js': enc('export {}'),
  });
  const ctx = makeCtx(vfs);
  const code = await tar(['tar', '-czf', '/out.tar.gz', '/proj'], ctx);
  assert.equal(code, 0);
  const entries = await archive.list({ vfs, path: '/out.tar.gz' });
  const files = entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  assert.deepEqual(files, ['proj/README.md', 'proj/src/main.js']);
});

test('tar -cf creates a plain tar', async () => {
  const vfs = makeVfs({ '/dir/x.txt': enc('hi') });
  const ctx = makeCtx(vfs);
  await tar(['tar', '-cf', '/out.tar', '/dir'], ctx);
  const bytes = await vfs.readFile('/out.tar');
  // ustar magic at offset 257.
  assert.equal(dec(bytes.subarray(257, 262)), 'ustar');
});

test('tar -xkcd triggers the xkcd egg (text-only when fetch fails)', async () => {
  const vfs = makeVfs({});
  const ctx = makeCtx(vfs);
  // No real network in tests; fetch will hit a 404 or fail. We tolerate
  // both — the egg degrades to text-only output.
  const code = await tar(['tar', '--xkcd'], ctx);
  assert.equal(code, 0);
  assert.match(ctx._getStdout(), /Rob! You use Unix/);
  assert.match(ctx._getStdout(), /xkcd #1168/);
});

test('tar with -x AND -c flags together triggers the egg', async () => {
  const vfs = makeVfs({});
  const ctx = makeCtx(vfs);
  const code = await tar(['tar', '-xcf', '/data.tar'], ctx);
  assert.equal(code, 0);
  assert.match(ctx._getStdout(), /Rob!/);
});

test('tar with no -f flag prints a clear error', async () => {
  const ctx = makeCtx(makeVfs({}));
  const code = await tar(['tar', '-c'], ctx);
  assert.equal(code, 2);
  assert.match(ctx._getStderr(), /missing -f FILE/);
});

test('tar with no mode flag prints a clear error', async () => {
  const ctx = makeCtx(makeVfs({}));
  const code = await tar(['tar', '-f', '/x.tar'], ctx);
  assert.equal(code, 2);
  assert.match(ctx._getStderr(), /missing -c \/ -x \/ -t mode/);
});

// ── gzip / gunzip ───────────────────────────────────────────────────────

test('gzip FILE produces FILE.gz and removes the original', async () => {
  const vfs = makeVfs({ '/data.csv': enc('a,b,c\n1,2,3') });
  const ctx = makeCtx(vfs);
  await gzip(['gzip', '/data.csv'], ctx);
  assert.ok(vfs._files.has('/data.csv.gz'));
  assert.ok(!vfs._files.has('/data.csv'));   // original removed
  // The .gz starts with the gzip magic bytes.
  const gzBytes = vfs._files.get('/data.csv.gz');
  assert.equal(gzBytes[0], 0x1f);
  assert.equal(gzBytes[1], 0x8b);
});

test('gzip -k keeps the original file', async () => {
  const vfs = makeVfs({ '/data.csv': enc('a,b,c\n') });
  const ctx = makeCtx(vfs);
  await gzip(['gzip', '-k', '/data.csv'], ctx);
  assert.ok(vfs._files.has('/data.csv'));
  assert.ok(vfs._files.has('/data.csv.gz'));
});

test('gunzip FILE.gz produces FILE and removes the .gz', async () => {
  const vfs = makeVfs({ '/data.csv': enc('a,b,c\nhello') });
  await archive.gzip({ vfs, path: '/data.csv' }, { vfs, path: '/data.csv.gz' });
  await vfs.unlink('/data.csv');   // start with only the gz
  const ctx = makeCtx(vfs);
  await gunzip(['gunzip', '/data.csv.gz'], ctx);
  assert.ok(vfs._files.has('/data.csv'));
  assert.ok(!vfs._files.has('/data.csv.gz'));
  assert.deepEqual(await vfs.readFile('/data.csv'), enc('a,b,c\nhello'));
});

test('gunzip -k keeps the original .gz file', async () => {
  const vfs = makeVfs({ '/data.csv': enc('payload') });
  await archive.gzip({ vfs, path: '/data.csv' }, { vfs, path: '/data.csv.gz' });
  await vfs.unlink('/data.csv');
  const ctx = makeCtx(vfs);
  await gunzip(['gunzip', '-k', '/data.csv.gz'], ctx);
  assert.ok(vfs._files.has('/data.csv'));
  assert.ok(vfs._files.has('/data.csv.gz'));
});

test('gzip with no FILE returns a clear error (stdin not yet wired)', async () => {
  const vfs = makeVfs({});
  const ctx = makeCtx(vfs);
  const code = await gzip(['gzip'], ctx);
  assert.equal(code, 2);
  assert.match(ctx._getStderr(), /supply a FILE/);
});

// ── zstd / unzstd ───────────────────────────────────────────────────────

test('zstd without -d prints decode-only error', async () => {
  const vfs = makeVfs({ '/data.csv': enc('hi') });
  const ctx = makeCtx(vfs);
  const code = await zstd(['zstd', '/data.csv'], ctx);
  assert.equal(code, 1);
  assert.match(ctx._getStderr(), /decode-only/);
});

test('unzstd decodes a .zst file', async () => {
  // Build a real .zst with Node's native zstd (fzstd is decode-only here).
  const zlib = await import('node:zlib');
  const payload = enc('decompressed content');
  const compressed = new Uint8Array(zlib.zstdCompressSync(payload));
  const vfs = makeVfs({ '/data.csv.zst': compressed });
  const ctx = makeCtx(vfs);
  await unzstd(['unzstd', '/data.csv.zst'], ctx);
  assert.ok(vfs._files.has('/data.csv'));
  assert.deepEqual(await vfs.readFile('/data.csv'), payload);
  assert.ok(!vfs._files.has('/data.csv.zst'));   // removed by default
});

test('unzstd -k keeps the .zst', async () => {
  const zlib = await import('node:zlib');
  const compressed = new Uint8Array(zlib.zstdCompressSync(enc('hi')));
  const vfs = makeVfs({ '/data.zst': compressed });
  const ctx = makeCtx(vfs);
  await unzstd(['unzstd', '-k', '/data.zst'], ctx);
  assert.ok(vfs._files.has('/data'));
  assert.ok(vfs._files.has('/data.zst'));
});

// ── zip / unzip ─────────────────────────────────────────────────────────

test('zip creates a .zip from a directory (adds basename prefix)', async () => {
  // Mirrors tar -c — the zip builtin also basename-prefixes entries.
  const vfs = makeVfs({
    '/proj/main.js': enc('export {}'),
    '/proj/README.md': enc('# hi'),
  });
  const ctx = makeCtx(vfs);
  await zip(['zip', '-r', '/out.zip', '/proj'], ctx);
  const bytes = await vfs.readFile('/out.zip');
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4B);
  const entries = await archive.list({ vfs, path: '/out.zip' });
  const files = entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  assert.deepEqual(files, ['proj/README.md', 'proj/main.js']);
});

test('unzip -l lists archive contents', async () => {
  const vfs = makeVfs({ '/proj/a.txt': enc('a'), '/proj/b.txt': enc('b') });
  // archive.compress entries are stem-relative — 'a.txt' / 'b.txt'.
  await archive.compress({ vfs, path: '/proj' }, { vfs, path: '/data.zip' }, { format: 'zip' });
  const ctx = makeCtx(vfs);
  await unzip(['unzip', '-l', '/data.zip'], ctx);
  assert.match(ctx._getStdout(), /^\s+1\s+a\.txt/m);
  assert.match(ctx._getStdout(), /^\s+1\s+b\.txt/m);
});

test('unzip extracts to cwd by default', async () => {
  const vfs = makeVfs({ '/in/x.txt': enc('hi') });
  await archive.compress({ vfs, path: '/in' }, { vfs, path: '/data.zip' }, { format: 'zip' });
  await vfs.mkdir('/work', { recursive: true });
  const ctx = makeCtx(vfs, { cwd: '/work' });
  await unzip(['unzip', '/data.zip'], ctx);
  // Fixture entry is 'x.txt' (stem-relative); cwd is /work → lands at /work/x.txt.
  assert.deepEqual(await vfs.readFile('/work/x.txt'), enc('hi'));
});

test('unzip -d DIR extracts to the given directory', async () => {
  const vfs = makeVfs({ '/in/x.txt': enc('hi') });
  await archive.compress({ vfs, path: '/in' }, { vfs, path: '/data.zip' }, { format: 'zip' });
  await vfs.mkdir('/dest', { recursive: true });
  const ctx = makeCtx(vfs);
  await unzip(['unzip', '-d', '/dest', '/data.zip'], ctx);
  assert.deepEqual(await vfs.readFile('/dest/x.txt'), enc('hi'));
});

test('unzip -p NAME prints one entry to stdout', async () => {
  const vfs = makeVfs({ '/in/README.md': enc('# Hello world\n') });
  await archive.compress({ vfs, path: '/in' }, { vfs, path: '/data.zip' }, { format: 'zip' });
  const ctx = makeCtx(vfs);
  // Fixture entry is 'README.md' (stem-relative), not 'in/README.md'.
  await unzip(['unzip', '-p', '/data.zip', 'README.md'], ctx);
  assert.equal(ctx._getStdout(), '# Hello world\n');
});
