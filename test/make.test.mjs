// @gcu/make — derived-graph build orchestrator.
//
// Builds a throwaway workspace of two real packages with an inline edge
// (app inlines core) and drives @gcu/make over it: graph derivation, topo order,
// dependency-ordered build, incremental skip, and downstream-dirty propagation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover, deriveEdges, topoOrder, make } from '../ext/make/make.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildMain = pathToFileURL(path.join(root, 'ext', 'build', 'src', 'main.js')).href;

function writePkg(extDir, name, files, buildOpts = '') {
  const dir = path.join(extDir, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
  // build.js mentions 'build/src/main.js' (via the file URL) → discover() picks it up.
  fs.writeFileSync(path.join(dir, 'build.js'),
    `import { bundle } from '${buildMain}';\n` +
    `bundle({ at: import.meta.url, sourcemap: false, meta: false${buildOpts ? ', ' + buildOpts : ''} });\n`);
}

function makeWorkspace() {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-make-'));
  // core: a leaf
  writePkg(ext, 'core', { 'src/main.js': 'export { K } from "./k.js";\n', 'src/k.js': 'export const K = 41;\n' });
  // app: inlines core (edge app → core)
  writePkg(ext, 'app',
    { 'src/main.js': 'export { v } from "./x.js";\n', 'src/x.js': 'import { K } from "@gcu/core";\nexport const v = K + 1;\n' },
    `inline: ['@gcu/core']`);
  return ext;
}

test('discover + deriveEdges + topoOrder: app depends on core, built core-first', () => {
  const ext = makeWorkspace();
  try {
    const pkgs = discover(ext);
    assert.deepEqual(pkgs.map((p) => p.name).sort(), ['app', 'core']);
    const edges = deriveEdges(pkgs);
    assert.deepEqual([...edges.get('app')], ['core']);
    assert.deepEqual([...edges.get('core')], []);
    assert.deepEqual(topoOrder(pkgs, edges), ['core', 'app']);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('deriveEdges: deep-escaping import (../../dep/) yields the package name, not ".."', () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-make-deep-'));
  try {
    writePkg(ext, 'core', { 'src/main.js': 'export const K = 1;\n' });
    // app reaches core via a two-segment escaping path (the real over→dimensions shape)
    writePkg(ext, 'app',
      { 'src/main.js': 'export { v } from "./x.js";\n', 'src/x.js': 'import { K } from "../../core/src/main.js";\nexport const v = K;\n' });
    const pkgs = discover(ext);
    const edges = deriveEdges(pkgs);
    assert.deepEqual([...edges.get('app')], ['core'], 'captures "core", not ".."');
    assert.deepEqual(topoOrder(pkgs, edges), ['core', 'app']);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('topoOrder throws on a cycle', () => {
  const pkgs = [{ name: 'a' }, { name: 'b' }];
  const edges = new Map([['a', new Set(['b'])], ['b', new Set(['a'])]]);
  assert.throws(() => topoOrder(pkgs, edges), /cycle/);
});

test('make: builds in order, then skips unchanged, then rebuilds downstream of a change', async () => {
  const ext = makeWorkspace();
  try {
    // first run: builds both (core before app), app inlines core's K
    const r1 = make({ extDir: ext, noTargets: true, log: () => {} });
    assert.deepEqual(r1.order, ['core', 'app']);
    assert.deepEqual(r1.built, ['core', 'app']);
    const appIdx = pathToFileURL(path.join(ext, 'app', 'index.js')).href;
    let m = await import(appIdx);
    assert.equal(m.v, 42, 'core K (41) inlined into app, v = K + 1');

    // second run: nothing changed → skip both
    const r2 = make({ extDir: ext, noTargets: true, log: () => {} });
    assert.deepEqual(r2.built, []);
    assert.deepEqual(r2.skipped, ['core', 'app']);

    // change core → core rebuilds AND app (downstream) rebuilds
    fs.writeFileSync(path.join(ext, 'core', 'src', 'k.js'), 'export const K = 100;\n');
    const r3 = make({ extDir: ext, noTargets: true, log: () => {} });
    assert.deepEqual(r3.built, ['core', 'app'], 'a change to core re-bundles its dependents');
    m = await import(appIdx + '?v=3'); // cache-bust the ESM import
    assert.equal(m.v, 101);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('make: targets rebuild when a package they consume changes (the cascade)', () => {
  const ext = makeWorkspace();
  try {
    const ran = [];
    // 'bundle' consumes core's built index.js (the package→target input edge);
    // 'site' has no inputs of its own — it only rebuilds when its dep does.
    const targets = [
      { name: 'bundle', out: null, deps: [], inputs: () => [path.join(ext, 'core', 'index.js')] },
      { name: 'site', out: null, deps: ['bundle'], inputs: () => [] },
    ];
    const runTarget = (t) => ran.push(t.name);

    const r1 = make({ extDir: ext, targets, runTarget, log: () => {} });
    assert.deepEqual(r1.targets.built, ['bundle', 'site'], 'first run builds both targets');

    const r2 = make({ extDir: ext, targets, runTarget, log: () => {} });
    assert.deepEqual(r2.targets.built, [], 'nothing changed → targets skip');

    // change core → core (+app) rebuild → bundle (consumes core) → site (deps bundle)
    fs.writeFileSync(path.join(ext, 'core', 'src', 'k.js'), 'export const K = 999;\n');
    const r3 = make({ extDir: ext, targets, runTarget, log: () => {} });
    assert.ok(r3.built.includes('core'), 'core rebuilt');
    assert.deepEqual(r3.targets.built, ['bundle', 'site'], 'the change cascaded core → bundle → site');
    assert.deepEqual(ran, ['bundle', 'site', 'bundle', 'site']);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('make: --no-targets (targets:[]) skips the target phase', () => {
  const ext = makeWorkspace();
  try {
    const r = make({ extDir: ext, noTargets: true, run: () => {}, log: () => {} });
    assert.deepEqual(r.targets.built, []);
    assert.deepEqual(r.targets.order, []);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('make: injectable runner reports order without spawning', () => {
  const ext = makeWorkspace();
  try {
    const ran = [];
    const r = make({ extDir: ext, force: true, noTargets: true, run: (pkg) => ran.push(pkg.name), log: () => {} });
    assert.deepEqual(ran, ['core', 'app']);
    assert.deepEqual(r.built, ['core', 'app']);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});
