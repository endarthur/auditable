// .gcupkg consumer tests — round-trip a tiny package built in-memory
// through parseGcupkg + installGcupkg, assert layout, lockfile, and
// _installedModules entries all land correctly.
//
// Uses fflate's zipSync to build fixtures (the production code uses
// @gcu/archive which wraps fflate; either side of the round-trip pulls
// from the same vendored bundle).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { zipSync } from '../ext/archive/vendor/fflate.module.mjs';
import * as archiveLib from '../ext/archive/src/main.js';
import { parseGcupkg, installGcupkg } from '../src/js/gcupkg.js';

// Node ≥ 19 exposes crypto.subtle globally, but earlier versions need a
// hook. Make sure it's there for the SHA-256 integrity check.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

// ── In-memory VFS — just enough surface to satisfy installGcupkg ────────
function makeVfs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files, dirs,
    async readFile(path, enc) {
      if (!files.has(path)) throw new Error('ENOENT ' + path);
      const b = files.get(path);
      return enc === 'utf8' ? new TextDecoder().decode(b) : b;
    },
    async writeFile(path, content) {
      const bytes = content instanceof Uint8Array ? content
        : typeof content === 'string' ? new TextEncoder().encode(content)
        : new Uint8Array(content);
      files.set(path, bytes);
    },
    async mkdir(path, _opts) { dirs.add(path); },
  };
}

// ── Build a minimal gcupkg ──────────────────────────────────────────────
//
// Lays out the same shape carotte's pack-gcupkg.js produces — package.json,
// index.js, adder.js, LICENSE, README.md, examples/, .gcupkg-meta.json.
function buildFixture(opts = {}) {
  const name = opts.name || '@test/sample';
  const version = opts.version || '0.1.0';
  const indexJs = enc(opts.indexJs || 'export const hello = "world";');
  const adderJs = opts.adderJs === null
    ? null
    : enc(opts.adderJs || '// adder bridge\nexport const sample = {};');
  const licenseText = enc('MIT — example only.');
  const readmeText = enc('# Sample\n\nA test gcupkg.');
  const exampleTxt = enc('/// auditable\n/// title: sample\n\n/// code\nconsole.log("hello")\n');
  const examplesManifest = enc(JSON.stringify({
    examples: [{ file: 'demo.txt', title: 'Demo', category: 'test' }],
  }));
  const packageJson = enc(JSON.stringify({
    name, version, license: 'MIT', main: 'index.js',
    exports: { '.': './index.js', './adder': './adder.js' },
  }, null, 2));

  const meta = {
    gcupkgVersion: 1,
    name, version,
    spdx: 'MIT',
    homepage: opts.homepage || 'https://example.test/sample',
    requires: { auditable: opts.requires || '>=0.0.0' },
    contributes: ['exports'],
    bundles: {
      docs:     !!opts.docs,
      examples: 1,
      vendorLicenses: 0,
    },
    size: {
      'index.js': indexJs.length,
      ...(adderJs ? { 'adder.js': adderJs.length } : {}),
    },
    ...(opts.integrity ? { integrity: opts.integrity } : {}),
    ...(opts.integrityCovers ? { integrityCovers: opts.integrityCovers } : {}),
  };
  const metaBytes = enc(JSON.stringify(meta, null, 2) + '\n');

  const entries = {
    'package.json': packageJson,
    'index.js': indexJs,
    'LICENSE': licenseText,
    'README.md': readmeText,
    'examples/demo.txt': exampleTxt,
    'examples/manifest.json': examplesManifest,
    '.gcupkg-meta.json': metaBytes,
  };
  if (adderJs) entries['adder.js'] = adderJs;
  if (opts.docs) {
    entries['docs/index.md'] = enc('# Sample docs\n\nWelcome.');
  }
  return { bytes: zipSync(entries), entries, meta };
}

// ── parse ───────────────────────────────────────────────────────────────

test('parseGcupkg: round-trips a minimal fixture', async () => {
  const { bytes } = buildFixture();
  const parsed = await parseGcupkg(bytes, archiveLib);
  assert.equal(parsed.meta.name, '@test/sample');
  assert.equal(parsed.meta.version, '0.1.0');
  assert.equal(parsed.packageJson.name, '@test/sample');
  assert.ok(parsed.files['index.js']);
  assert.ok(parsed.files['adder.js']);
  assert.ok(parsed.files['LICENSE']);
});

test('parseGcupkg: rejects non-ZIP bytes', async () => {
  await assert.rejects(
    () => parseGcupkg(enc('not a zip at all'), archiveLib),
    /expected ZIP archive/,
  );
});

test('parseGcupkg: rejects missing required files', async () => {
  // ZIP with only a package.json, missing index.js + LICENSE + meta.
  const bytes = zipSync({ 'package.json': enc('{}') });
  await assert.rejects(
    () => parseGcupkg(bytes, archiveLib),
    /missing required file/,
  );
});

test('parseGcupkg: rejects unsupported gcupkgVersion', async () => {
  // Manually craft a meta with the wrong version.
  const goodMeta = JSON.parse(dec(buildFixture().entries['.gcupkg-meta.json']));
  goodMeta.gcupkgVersion = 99;
  const entries = { ...buildFixture().entries, '.gcupkg-meta.json': enc(JSON.stringify(goodMeta)) };
  await assert.rejects(
    () => parseGcupkg(zipSync(entries), archiveLib),
    /unsupported gcupkgVersion/,
  );
});

test('parseGcupkg: rejects mismatched name (meta vs package.json)', async () => {
  const orig = buildFixture();
  const meta = JSON.parse(dec(orig.entries['.gcupkg-meta.json']));
  meta.name = '@test/different';
  const entries = { ...orig.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };
  await assert.rejects(
    () => parseGcupkg(zipSync(entries), archiveLib),
    /name mismatch/,
  );
});

test('parseGcupkg: rejects garbage meta JSON', async () => {
  const entries = { ...buildFixture().entries, '.gcupkg-meta.json': enc('{ not json') };
  await assert.rejects(
    () => parseGcupkg(zipSync(entries), archiveLib),
    /invalid \.gcupkg-meta\.json/,
  );
});

// ── integrity verification ──────────────────────────────────────────────

async function _legacyHash(bytes) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return 'sha256-' + Buffer.from(bin, 'binary').toString('base64');
}

test('parseGcupkg: verifies legacy single-file integrity (carotte 0.1.0 shape)', async () => {
  const f = buildFixture();
  const indexHash = await _legacyHash(f.entries['index.js']);
  // Rewrite meta to include integrity but NOT integrityCovers — the legacy shape.
  const meta = JSON.parse(dec(f.entries['.gcupkg-meta.json']));
  meta.integrity = indexHash;
  const entries = { ...f.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };
  const parsed = await parseGcupkg(zipSync(entries), archiveLib);
  assert.equal(parsed.integrity.ok, true);
  assert.match(parsed.integrity.note || '', /legacy single-file/);
});

test('parseGcupkg: legacy integrity reports mismatch when bytes diverge', async () => {
  const f = buildFixture();
  const meta = JSON.parse(dec(f.entries['.gcupkg-meta.json']));
  meta.integrity = 'sha256-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const entries = { ...f.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };
  const parsed = await parseGcupkg(zipSync(entries), archiveLib);
  assert.equal(parsed.integrity.ok, false);
});

test('parseGcupkg: verifies multi-file integrityCovers (spec-recommended shape)', async () => {
  const f = buildFixture();
  // Hand-compute the spec-recommended hash for index.js + adder.js.
  const sorted = ['adder.js', 'index.js'];
  const nul = new Uint8Array([0]);
  const chunks = [];
  let total = 0;
  for (const n of sorted) {
    const nb = enc(n);
    chunks.push(nb, nul, f.entries[n], nul);
    total += nb.length + 1 + f.entries[n].length + 1;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', merged);
  const h8 = new Uint8Array(hashBuf);
  let bin = '';
  for (let i = 0; i < h8.length; i++) bin += String.fromCharCode(h8[i]);
  const fullHash = 'sha256-' + Buffer.from(bin, 'binary').toString('base64');

  const meta = JSON.parse(dec(f.entries['.gcupkg-meta.json']));
  meta.integrity = fullHash;
  meta.integrityCovers = ['index.js', 'adder.js'];
  const entries = { ...f.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };
  const parsed = await parseGcupkg(zipSync(entries), archiveLib);
  assert.equal(parsed.integrity.ok, true);
  assert.deepEqual(parsed.integrity.covered, ['index.js', 'adder.js']);
});

// ── install ─────────────────────────────────────────────────────────────

test('installGcupkg: writes index.js + adder.js + meta.json + lockfile to /lib', async () => {
  const { bytes } = buildFixture({ name: '@test/installer' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  const installedModules = {};
  const result = await installGcupkg(parsed, { vfs, installedModules });

  assert.equal(result.libPath, '/lib/@test/installer');
  assert.equal(result.hasAdder, true);
  assert.ok(vfs.files.has('/lib/@test/installer/source'));
  assert.ok(vfs.files.has('/lib/@test/installer/adder.js'));
  assert.ok(vfs.files.has('/lib/@test/installer/LICENSE'));
  assert.ok(vfs.files.has('/lib/@test/installer/package.json'));
  assert.ok(vfs.files.has('/lib/@test/installer/meta.json'));
  // Lockfile entry
  const lock = JSON.parse(await vfs.readFile('/lib/.gcu-lock.json', 'utf8'));
  assert.ok(lock.modules['@test/installer']);
  assert.equal(lock.modules['@test/installer'].version, '0.1.0');
  assert.equal(lock.modules['@test/installer'].kind, 'gcupkg');
  // _installedModules hydration so load() works post-install
  assert.ok(installedModules['@test/installer']);
  assert.ok(installedModules['@test/installer/adder']);
});

test('installGcupkg: places bare-name extension under /lib/local/', async () => {
  // No @scope/name pattern → falls into /lib/local/.
  const { bytes } = buildFixture({ name: 'bare-name' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  const result = await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.equal(result.libPath, '/lib/local/bare-name');
  assert.ok(vfs.files.has('/lib/local/bare-name/source'));
});

test('installGcupkg: writes examples to /usr/share/examples/<slug>/', async () => {
  const { bytes } = buildFixture({ name: '@test/examplez' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  const result = await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.equal(result.exampleRoot, '/usr/share/examples/@test_examplez');
  assert.equal(result.exampleCount, 1);
  assert.ok(vfs.files.has('/usr/share/examples/@test_examplez/demo.txt'));
  assert.ok(vfs.files.has('/usr/share/examples/@test_examplez/manifest.json'));
});

test('installGcupkg: writes docs to /usr/share/docs/<slug>/', async () => {
  const { bytes } = buildFixture({ name: '@test/docsy', docs: true });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  const result = await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.equal(result.docsRoot, '/usr/share/docs/@test_docsy');
  assert.equal(result.docsCount, 1);
  assert.ok(vfs.files.has('/usr/share/docs/@test_docsy/index.md'));
});

test('installGcupkg: skips adder.js wiring when no adder is in the gcupkg', async () => {
  const { bytes } = buildFixture({ name: '@test/no-adder', adderJs: null });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  const installedModules = {};
  const result = await installGcupkg(parsed, { vfs, installedModules });
  assert.equal(result.hasAdder, false);
  assert.equal(vfs.files.has('/lib/@test/no-adder/adder.js'), false);
  assert.equal(installedModules['@test/no-adder/adder'], undefined);
  assert.ok(installedModules['@test/no-adder']);  // engine still installed
});

test('installGcupkg: lockfile entry records license meta from gcupkg-meta', async () => {
  const { bytes } = buildFixture({ name: '@test/lic-meta' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });
  const lock = JSON.parse(await vfs.readFile('/lib/.gcu-lock.json', 'utf8'));
  assert.equal(lock.modules['@test/lic-meta'].license.spdx, 'MIT');
  assert.equal(lock.modules['@test/lic-meta'].license.spdxSource, 'gcupkg-meta');
});

test('installGcupkg: strictIntegrity refuses install on bad hash', async () => {
  const f = buildFixture();
  const meta = JSON.parse(dec(f.entries['.gcupkg-meta.json']));
  meta.integrity = 'sha256-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdea=';
  const entries = { ...f.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };
  const parsed = await parseGcupkg(zipSync(entries), archiveLib);
  const vfs = makeVfs();
  await assert.rejects(
    () => installGcupkg(parsed, { vfs, installedModules: {}, strictIntegrity: true }),
    /integrity mismatch/,
  );
});

test('installGcupkg: permissive mode installs broken-integrity packages with a warning record', async () => {
  const f = buildFixture();
  const meta = JSON.parse(dec(f.entries['.gcupkg-meta.json']));
  meta.integrity = 'sha256-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdea=';
  const entries = { ...f.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };
  const parsed = await parseGcupkg(zipSync(entries), archiveLib);
  const vfs = makeVfs();
  const result = await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.equal(result.integrity.ok, false);
  // Files still landed.
  assert.ok(vfs.files.has('/lib/@test/sample/source'));
});

test('installGcupkg: appends to an existing lockfile without clobbering other entries', async () => {
  const vfs = makeVfs();
  await vfs.writeFile('/lib/.gcu-lock.json', JSON.stringify({
    version: 1,
    modules: {
      'npm:something-else': { alias: 'npm:something-else', version: '2.0.0', kind: 'js' },
    },
  }));
  const { bytes } = buildFixture({ name: '@test/cohabitant' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  await installGcupkg(parsed, { vfs, installedModules: {} });
  const lock = JSON.parse(await vfs.readFile('/lib/.gcu-lock.json', 'utf8'));
  assert.ok(lock.modules['npm:something-else']);   // preserved
  assert.ok(lock.modules['@test/cohabitant']);     // added
});

// ── carotte-shaped end-to-end (smoke) ───────────────────────────────────

test('end-to-end: carotte-shaped fixture lands every artifact in the expected place', async () => {
  // Mirror the carotte shape — @gcu/<name> with adder.js, one example,
  // legacy single-file integrity (since carotte 0.1.0 emits that).
  const f = buildFixture({ name: '@gcu/carotteish' });
  const indexHash = await _legacyHash(f.entries['index.js']);
  const meta = JSON.parse(dec(f.entries['.gcupkg-meta.json']));
  meta.integrity = indexHash;
  const entries = { ...f.entries, '.gcupkg-meta.json': enc(JSON.stringify(meta)) };

  const parsed = await parseGcupkg(zipSync(entries), archiveLib);
  assert.equal(parsed.integrity.ok, true);

  const vfs = makeVfs();
  const installedModules = {};
  const result = await installGcupkg(parsed, { vfs, installedModules });

  assert.equal(result.libPath, '/lib/@gcu/carotteish');
  assert.equal(result.exampleRoot, '/usr/share/examples/@gcu_carotteish');
  assert.equal(result.hasAdder, true);
  // The user can now `load("@gcu/carotteish")` and `load("@gcu/carotteish/adder")`
  // from a cell — both keys resolve via the runtime cache.
  assert.ok(installedModules['@gcu/carotteish']);
  assert.ok(installedModules['@gcu/carotteish/adder']);
});
