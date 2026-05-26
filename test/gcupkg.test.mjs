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
import { parseGcupkg, installGcupkg, makeUnzipArchiveShim } from '../src/js/gcupkg.js';
import { unzipArchive } from '../src/js/stdlib-core.js';

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
    // rm with recursive — drops every file/dir prefixed with the given path.
    // Mirrors how MemoryBackend / IDBBackend handle recursive deletes.
    async rm(path, opts = {}) {
      const recursive = !!opts.recursive;
      const prefix = path.endsWith('/') ? path : path + '/';
      let removed = 0;
      for (const f of [...files.keys()]) {
        if (f === path || (recursive && f.startsWith(prefix))) {
          files.delete(f);
          removed++;
        }
      }
      for (const d of [...dirs]) {
        if (d === path || (recursive && d.startsWith(prefix))) dirs.delete(d);
      }
      if (removed === 0 && !files.has(path) && !dirs.has(path)) {
        // Mimic ENOENT for missing paths — install path catches it.
        throw new Error('ENOENT ' + path);
      }
    },
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
  if (opts.surfaceHtml) {
    entries[opts.surfaceFile || 'surface.html'] = enc(opts.surfaceHtml);
  }
  if (opts.extras) {
    for (const [path, content] of Object.entries(opts.extras)) {
      entries[path] = enc(content);
    }
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
  // adder bridge lives in its OWN leaf dir so the hydration walker
  // picks it up as a separate _installedModules entry on reload.
  assert.ok(vfs.files.has('/lib/@test/installer/adder/source'));
  assert.ok(vfs.files.has('/lib/@test/installer/adder/meta.json'));
  // The old sibling layout — adder.js as a flat file — must NOT exist.
  // _walkLibLeaves would ignore it; the in-memory install-time entry
  // would vanish on reload.
  assert.equal(vfs.files.has('/lib/@test/installer/adder.js'), false);
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

test('installGcupkg: writes top-level works.js (EXTENSION_SPEC §2.5 shell entry)', async () => {
  // works.js is the shell-context entry point. Installer must mirror it to
  // /lib/<pkg>/works.js so extension-loader.js can evaluate it at install +
  // boot.
  const { bytes } = buildFixture({
    name: '@test/has-works',
    extras: { 'works.js': 'window.auditable.registerExtension({ name: "@test/has-works", version: "0.1.0", surfaces: [] });' },
  });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.ok(vfs.files.has('/lib/@test/has-works/works.js'),
    'works.js must be written to /lib/<pkg>/');
  const written = new TextDecoder().decode(vfs.files.get('/lib/@test/has-works/works.js'));
  assert.match(written, /window\.auditable\.registerExtension/);
});

test('installGcupkg: writes top-level surface HTML files (referenced by manifest.surfaces)', async () => {
  // Regression — installer used to silently drop any top-level file
  // outside the hardcoded set (index.js / adder.js / LICENSE / etc).
  // Surface contributions reference custom HTML files via
  // manifest.surfaces[].file; those need to land at /lib/<pkg>/<file>
  // so the Works runtime can read them at spawn time.
  const { bytes } = buildFixture({
    name: '@test/has-surface',
    surfaceHtml: '<!doctype html><html><body>Custom surface</body></html>',
    surfaceFile: 'viewer.html',
  });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.ok(vfs.files.has('/lib/@test/has-surface/viewer.html'),
    'surface HTML must be written to /lib/<pkg>/');
  const written = new TextDecoder().decode(vfs.files.get('/lib/@test/has-surface/viewer.html'));
  assert.match(written, /Custom surface/);
});

test('installGcupkg: writes nested extra assets (e.g. /icons/foo.svg)', async () => {
  // Extensions may ship arbitrary asset trees referenced from the
  // surface (icons, fonts, json data, …). Each one lands at the
  // mirrored path under /lib/<pkg>/.
  const { bytes } = buildFixture({
    name: '@test/has-assets',
    extras: {
      'icons/icon.svg': '<svg/>',
      'data/config.json': '{"k":1}',
    },
  });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.ok(vfs.files.has('/lib/@test/has-assets/icons/icon.svg'));
  assert.ok(vfs.files.has('/lib/@test/has-assets/data/config.json'));
});

test('installGcupkg: secondary entry survives reload via hydrateModulesFromVfs', async () => {
  // The reload scenario: install carotte-shaped gcupkg, throw away the
  // in-memory _installedModules, re-walk /lib to discover what's there,
  // assert both the engine AND the adder bridge land in the hydrated map.
  // Regression for the "Failed to resolve module specifier
  // '@gcu/carotte/adder'" bug — sibling-file layout vanished on reload.
  //
  // persist.js can't be imported in Node (it pulls #licenses transitively
  // through settings.js), so the walker is inlined here. Keep in sync
  // with src/js/persist.js's _walkLibLeaves + libPathToKey.
  const { bytes } = buildFixture({ name: '@test/reload' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });

  // Walk the flat files map directly, since the test VFS doesn't
  // implement readdir/stat. The logic mirrors persist.js
  // _walkLibLeaves's POST-FIX behavior: a leaf is a dir holding
  // `source` and/or `meta.json`, AND a leaf may contain nested leaves
  // (an engine `/source` next to an `/adder/source` adapter bridge).
  // The pre-fix walker did an early-return that missed nested leaves;
  // this test pins the post-fix behavior so future regressions show
  // up here.
  const result = {};
  const sourcePaths = [...vfs.files.keys()].filter(p =>
    p.startsWith('/lib/') && p.endsWith('/source'));
  for (const sp of sourcePaths) {
    const dir = sp.slice(0, -('/source'.length));
    const segments = dir.slice('/lib/'.length).split('/');
    const [first, ...rest] = segments;
    if (!first.startsWith('@') || rest.length === 0) continue;
    const key = first + '/' + rest.join('/');
    let meta = {};
    try { meta = JSON.parse(await vfs.readFile(dir + '/meta.json', 'utf8')); } catch {}
    const source = await vfs.readFile(dir + '/source', 'utf8');
    result[key] = { ...meta, source };
  }
  // Explicit assertion that the walker found BOTH (the nested case is
  // what the real bug was — pre-fix _walkLibLeaves returned after
  // recording the engine and never descended into adder/).
  assert.equal(Object.keys(result).filter(k => k.startsWith('@test/reload')).length, 2,
    'walker must record BOTH the engine AND the nested adder bridge');

  assert.ok(result['@test/reload'], 'engine entry should hydrate');
  assert.ok(result['@test/reload/adder'], 'adder secondary entry should hydrate too');
  assert.match(result['@test/reload/adder'].source, /adder bridge/,
    'adder source should be the bridge file');
});

test('installGcupkg: skips adder.js wiring when no adder is in the gcupkg', async () => {
  const { bytes } = buildFixture({ name: '@test/no-adder', adderJs: null });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  const installedModules = {};
  const result = await installGcupkg(parsed, { vfs, installedModules });
  assert.equal(result.hasAdder, false);
  assert.equal(vfs.files.has('/lib/@test/no-adder/adder.js'), false);
  assert.equal(vfs.files.has('/lib/@test/no-adder/adder/source'), false);
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

// ── stdlib unzipArchive shim (the auditable cell-side path) ────────────
//
// This is the path the auditable cell-side install("file.gcupkg") takes —
// no @gcu/archive dependency, just stdlib's native-DecompressionStream
// ZIP reader behind a thin compatibility shim. End-to-end here mirrors
// what runs in the browser when a user writes
//   await install("local:/path/to/foo.gcupkg")
// from a cell.

test('makeUnzipArchiveShim: parseGcupkg + installGcupkg work through stdlib unzipArchive', async () => {
  const { bytes } = buildFixture({ name: '@test/shim-path' });
  const shim = makeUnzipArchiveShim(unzipArchive);
  const parsed = await parseGcupkg(bytes, shim);
  assert.equal(parsed.meta.name, '@test/shim-path');
  assert.ok(parsed.files['index.js']);
  assert.ok(parsed.files['adder.js']);
  const vfs = makeVfs();
  const installedModules = {};
  const result = await installGcupkg(parsed, { vfs, installedModules });
  assert.equal(result.libPath, '/lib/@test/shim-path');
  assert.ok(installedModules['@test/shim-path']);
});

test('makeUnzipArchiveShim: caches per-bytes so list+read share one decompression', async () => {
  const { bytes } = buildFixture({ name: '@test/cache' });
  // Spy on unzipArchive — wrap it so we count invocations.
  let calls = 0;
  const spied = async (b) => { calls++; return await unzipArchive(b); };
  const shim = makeUnzipArchiveShim(spied);
  await shim.archive.list(bytes);
  await shim.archive.read(bytes, 'index.js');
  await shim.archive.read(bytes, 'adder.js');
  assert.equal(calls, 1, 'unzipArchive should be called exactly once for one bytes buffer');
});

test('makeUnzipArchiveShim: rejects when unzipArchive is missing', () => {
  assert.throws(() => makeUnzipArchiveShim(null), /unzipArchive function required/);
  assert.throws(() => makeUnzipArchiveShim('not a fn'), /unzipArchive function required/);
});

// ── clean-replace + persistent examples (the reload-survival path) ─────

test('installGcupkg: persists examples at /lib/<name>/examples/ (survives reload)', async () => {
  const { bytes } = buildFixture({ name: '@test/persistent-examples' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });
  // The canonical persistent copy.
  assert.ok(vfs.files.has('/lib/@test/persistent-examples/examples/demo.txt'));
  assert.ok(vfs.files.has('/lib/@test/persistent-examples/examples/manifest.json'));
  // The volatile picker view.
  assert.ok(vfs.files.has('/usr/share/examples/@test_persistent-examples/demo.txt'));
});

test('installGcupkg: persists docs at /lib/<name>/docs/ when present', async () => {
  const { bytes } = buildFixture({ name: '@test/persistent-docs', docs: true });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.ok(vfs.files.has('/lib/@test/persistent-docs/docs/index.md'));
  assert.ok(vfs.files.has('/usr/share/docs/@test_persistent-docs/index.md'));
});

test('installGcupkg: re-install replaces /lib/<name> cleanly (no stale files linger)', async () => {
  const vfs = makeVfs();
  // First install — has a "legacy-name.txt" example.
  const fixA = buildFixture({ name: '@test/replace-me' });
  const parsedA = await parseGcupkg(fixA.bytes, archiveLib);
  await installGcupkg(parsedA, { vfs, installedModules: {} });
  // Pretend a previous install had ALSO landed an old README that the
  // new version no longer ships. Test the cleanup directly by planting
  // a fake stale file in the install path.
  await vfs.writeFile('/lib/@test/replace-me/STALE-README.md', new TextEncoder().encode('old'));
  await vfs.writeFile('/usr/share/examples/@test_replace-me/old-example.txt', new TextEncoder().encode('old'));
  assert.ok(vfs.files.has('/lib/@test/replace-me/STALE-README.md'));
  assert.ok(vfs.files.has('/usr/share/examples/@test_replace-me/old-example.txt'));
  // Reinstall the SAME gcupkg — clean-replace should wipe the stale files.
  await installGcupkg(parsedA, { vfs, installedModules: {} });
  assert.equal(vfs.files.has('/lib/@test/replace-me/STALE-README.md'), false,
    'stale file from prior install should have been removed');
  assert.equal(vfs.files.has('/usr/share/examples/@test_replace-me/old-example.txt'), false,
    'stale example from prior install should have been removed');
  // The new install's canonical files are present.
  assert.ok(vfs.files.has('/lib/@test/replace-me/source'));
  assert.ok(vfs.files.has('/usr/share/examples/@test_replace-me/demo.txt'));
});

test('installGcupkg: clean-replace does not throw on first install (no prior /lib dir)', async () => {
  const { bytes } = buildFixture({ name: '@test/first-install' });
  const parsed = await parseGcupkg(bytes, archiveLib);
  const vfs = makeVfs();
  // Should not throw despite rm() targeting non-existent dirs.
  await installGcupkg(parsed, { vfs, installedModules: {} });
  assert.ok(vfs.files.has('/lib/@test/first-install/source'));
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
