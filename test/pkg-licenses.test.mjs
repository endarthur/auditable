// pkg license-integration tests.
//
// Covers the static plumbing of `pkg licenses` + `pkg list` SPDX column +
// `pkg help` text. The actual network round-trip (fetch package.json +
// LICENSE from a real CDN) is covered by examples-smoke.mjs once an
// example notebook exercises it; here we mock the VFS + skip the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// pkg-cmd.js resolves @gcu/licenses symbols from bundle scope first, then
// from globalThis (see _resolveLicensesSym). Inject before importing so
// the typeof checks find them either way.
import { aggregateLicenses, formatTable, fetchLicense } from '../ext/licenses/src/main.js';
globalThis.aggregateLicenses = aggregateLicenses;
globalThis.formatTable = formatTable;
globalThis.fetchLicense = fetchLicense;

const { _pkg } = await import('../ext/geas/src/pkg-cmd.js');

// ── tiny in-memory VFS that exposes just what pkg-cmd touches ──
function makeVfs() {
  const files = new Map();
  const dirs = new Set(['/', '/lib', '/sys', '/sys/licenses', '/var', '/var/modules']);
  return {
    files,
    dirs,
    async readFile(path, _enc) {
      if (!files.has(path)) throw new Error('ENOENT ' + path);
      return files.get(path);
    },
    async writeFile(path, content) { files.set(path, content); },
    async readdir(path) {
      const out = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(path + '/')) continue;
        const rest = f.slice(path.length + 1);
        out.add(rest.split('/')[0]);
      }
      for (const d of dirs) {
        if (!d.startsWith(path + '/')) continue;
        const rest = d.slice(path.length + 1);
        out.add(rest.split('/')[0]);
      }
      return [...out];
    },
    async stat(path) {
      if (files.has(path)) return { type: 'file' };
      if (dirs.has(path)) return { type: 'directory' };
      // Inferred directory if any file is under it
      for (const f of files.keys()) {
        if (f.startsWith(path + '/')) return { type: 'directory' };
      }
      for (const d of dirs) {
        if (d.startsWith(path + '/')) return { type: 'directory' };
      }
      throw new Error('ENOENT ' + path);
    },
    async mkdir(path, _opts) { dirs.add(path); },
    async rm(_path, _opts) {},
  };
}

function makeCtx(vfs) {
  const out = [];
  const err = [];
  return {
    vfs,
    out, err,
    async stdout(s) { out.push(s); },
    async stderr(s) { err.push(s); },
  };
}

// ── pkg help ─────────────────────────────────────────────────────────────

test('pkg help: lists the new licenses subcommand', async () => {
  const ctx = makeCtx(makeVfs());
  await _pkg(['pkg', 'help'], ctx);
  const text = ctx.out.join('');
  assert.match(text, /^\s*licenses\s/m);
  assert.match(text, /aggregate license table/);
});

test('pkg with no args: also shows help', async () => {
  const ctx = makeCtx(makeVfs());
  await _pkg(['pkg'], ctx);
  const text = ctx.out.join('');
  assert.match(text, /^\s*licenses\s/m);
});

// ── pkg list — SPDX column ──────────────────────────────────────────────

test('pkg list (empty): friendly message', async () => {
  const ctx = makeCtx(makeVfs());
  const rc = await _pkg(['pkg', 'list'], ctx);
  assert.equal(rc, 0);
  assert.match(ctx.out.join(''), /no modules installed/);
});

test('pkg list: shows SPDX from meta.license.spdx when present', async () => {
  const vfs = makeVfs();
  await vfs.writeFile('/lib/.gcu-lock.json', JSON.stringify({
    version: 1,
    modules: {
      'npm:left-pad': { alias: 'npm:left-pad', kind: 'js', size: 1234,
        license: { spdx: 'MIT', spdxSource: 'package.json' } },
      'npm:no-license': { alias: 'npm:no-license', kind: 'js', size: 5678 },
    },
  }));
  const ctx = makeCtx(vfs);
  const rc = await _pkg(['pkg', 'list'], ctx);
  assert.equal(rc, 0);
  const text = ctx.out.join('');
  assert.match(text, /npm:left-pad/);
  assert.match(text, /MIT/);
  assert.match(text, /npm:no-license/);
  // SPDX placeholder for entries lacking license info
  assert.match(text, /-\s+5678b/);
});

// ── pkg licenses — aggregates ───────────────────────────────────────────

test('pkg licenses (empty workspace): friendly message', async () => {
  const ctx = makeCtx(makeVfs());
  const rc = await _pkg(['pkg', 'licenses'], ctx);
  assert.equal(rc, 0);
  assert.match(ctx.out.join(''), /no licensed components found/);
});

test('pkg licenses: renders a tabular text format for /lib entries', async () => {
  const vfs = makeVfs();
  // A pkg-managed entry — aggregateLicenses' walkLib looks at /lib/<source>/<pkg@ver>/
  // with package.json + LICENSE alongside.
  await vfs.mkdir('/lib/npm', { recursive: true });
  await vfs.mkdir('/lib/npm/left-pad@1.3.0', { recursive: true });
  await vfs.writeFile('/lib/npm/left-pad@1.3.0/package.json',
    JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'MIT' }));
  await vfs.writeFile('/lib/npm/left-pad@1.3.0/LICENSE',
    'MIT License\n\nCopyright (c) 2014 azer\n\nPermission is hereby granted, free of charge…');

  const ctx = makeCtx(vfs);
  const rc = await _pkg(['pkg', 'licenses'], ctx);
  assert.equal(rc, 0);
  const text = ctx.out.join('');
  assert.match(text, /Package/);   // header
  assert.match(text, /SPDX/);
  assert.match(text, /Source/);
  assert.match(text, /Status/);
  assert.match(text, /left-pad@1\.3\.0/);
  assert.match(text, /MIT/);
  assert.match(text, /ok/);        // permissive status text
});

// ── pkg unknown subcommand ──────────────────────────────────────────────

test('pkg licensez (typo): unknown subcommand → exit 1', async () => {
  const ctx = makeCtx(makeVfs());
  const rc = await _pkg(['pkg', 'licensez'], ctx);
  assert.equal(rc, 1);
  assert.match(ctx.err.join(''), /unknown subcommand/);
});
