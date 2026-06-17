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
import { discover, deriveEdges, topoOrder, make, findMakefile, globFiles, loadTargets, runRecipe, MAKEFILE_NAMES } from '../ext/make/make.js';

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
    const r1 = await make({ extDir: ext, noTargets: true, log: () => {} });
    assert.deepEqual(r1.order, ['core', 'app']);
    assert.deepEqual(r1.built, ['core', 'app']);
    const appIdx = pathToFileURL(path.join(ext, 'app', 'index.js')).href;
    let m = await import(appIdx);
    assert.equal(m.v, 42, 'core K (41) inlined into app, v = K + 1');

    // second run: nothing changed → skip both
    const r2 = await make({ extDir: ext, noTargets: true, log: () => {} });
    assert.deepEqual(r2.built, []);
    assert.deepEqual(r2.skipped, ['core', 'app']);

    // change core → core rebuilds AND app (downstream) rebuilds
    fs.writeFileSync(path.join(ext, 'core', 'src', 'k.js'), 'export const K = 100;\n');
    const r3 = await make({ extDir: ext, noTargets: true, log: () => {} });
    assert.deepEqual(r3.built, ['core', 'app'], 'a change to core re-bundles its dependents');
    m = await import(appIdx + '?v=3'); // cache-bust the ESM import
    assert.equal(m.v, 101);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('make: targets rebuild when a package they consume changes (the cascade)', async () => {
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

    const r1 = await make({ extDir: ext, targets, runTarget, log: () => {} });
    assert.deepEqual(r1.targets.built, ['bundle', 'site'], 'first run builds both targets');

    const r2 = await make({ extDir: ext, targets, runTarget, log: () => {} });
    assert.deepEqual(r2.targets.built, [], 'nothing changed → targets skip');

    // change core → core (+app) rebuild → bundle (consumes core) → site (deps bundle)
    fs.writeFileSync(path.join(ext, 'core', 'src', 'k.js'), 'export const K = 999;\n');
    const r3 = await make({ extDir: ext, targets, runTarget, log: () => {} });
    assert.ok(r3.built.includes('core'), 'core rebuilt');
    assert.deepEqual(r3.targets.built, ['bundle', 'site'], 'the change cascaded core → bundle → site');
    assert.deepEqual(ran, ['bundle', 'site', 'bundle', 'site']);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('make: --no-targets (targets:[]) skips the target phase', async () => {
  const ext = makeWorkspace();
  try {
    const r = await make({ extDir: ext, noTargets: true, run: () => {}, log: () => {} });
    assert.deepEqual(r.targets.built, []);
    assert.deepEqual(r.targets.order, []);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('make: injectable runner reports order without spawning', async () => {
  const ext = makeWorkspace();
  try {
    const ran = [];
    const r = await make({ extDir: ext, force: true, noTargets: true, run: (pkg) => ran.push(pkg.name), log: () => {} });
    assert.deepEqual(ran, ['core', 'app']);
    assert.deepEqual(r.built, ['core', 'app']);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

// ── make.yaml (declarative targets) ─────────────────────────────────────────

test('findMakefile: resolution order (make.yaml wins), warns on multiple', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-mk-'));
  try {
    assert.equal(findMakefile(dir), null, 'none present → null');
    fs.writeFileSync(path.join(dir, 'gcu-make.yaml'), 'targets:\n');
    assert.equal(path.basename(findMakefile(dir)), 'gcu-make.yaml', 'alias used when alone');
    fs.writeFileSync(path.join(dir, 'make.yaml'), 'targets:\n');
    let warned = '';
    assert.equal(path.basename(findMakefile(dir, (s) => { warned = s; })), 'make.yaml', 'canonical wins');
    assert.match(warned, /multiple makefiles/);
    assert.deepEqual(MAKEFILE_NAMES, ['make.yaml', 'gcu-make.yaml', 'makefile.yaml']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('globFiles: ** (any depth), * (one segment), literal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-glob-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ext', 'a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ext', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'top.js'), '');
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'deep.js'), '');
    fs.writeFileSync(path.join(dir, 'ext', 'a', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'ext', 'b', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'ext', 'b', 'other.js'), '');
    fs.writeFileSync(path.join(dir, 'root.txt'), '');
    const rel = (fs2) => fs2.map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
    assert.deepEqual(rel(globFiles(dir, ['src/**'])), ['src/sub/deep.js', 'src/top.js'], '** crosses /');
    assert.deepEqual(rel(globFiles(dir, ['ext/*/index.js'])), ['ext/a/index.js', 'ext/b/index.js'], '* is one segment');
    assert.deepEqual(rel(globFiles(dir, ['root.txt'])), ['root.txt'], 'literal');
    assert.deepEqual(rel(globFiles(dir, ['nope.js'])), [], 'missing literal → empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTargets: parses make.yaml → engine target shape (glob inputs, check→checkPaths)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-lt-'));
  try {
    fs.mkdirSync(path.join(dir, 'ext', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ext', 'x', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'build.js'), '');
    assert.equal(loadTargets(dir), null, 'no makefile → null (generic repo: packages only)');
    fs.writeFileSync(path.join(dir, 'make.yaml'),
      'targets:\n' +
      '  app:\n' +
      '    out: "app.html"\n' +
      '    deps:\n' +
      '      - "lib"\n' +
      '    cmd:\n' +
      '      - "node"\n' +
      '      - "build.js"\n' +
      '      - "--target=app"\n' +
      '    inputs:\n' +
      '      - "ext/*/index.js"\n' +
      '      - "build.js"\n' +
      '    check:\n' +
      '      - "app.html"\n');
    const t = loadTargets(dir);
    assert.equal(t.length, 1);
    assert.equal(t[0].name, 'app');
    assert.equal(t[0].out, 'app.html');
    assert.deepEqual(t[0].deps, ['lib']);
    assert.deepEqual(t[0].cmd, ['node', 'build.js', '--target=app']);
    assert.deepEqual(t[0].checkPaths, ['app.html']);
    const ins = t[0].inputs(dir).map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
    assert.deepEqual(ins, ['build.js', 'ext/x/index.js'], 'glob inputs resolve against root');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── run: recipes (in-process GCU-function builds) ───────────────────────────

test('make: run: recipe — pure transform, gcu-make owns I/O (single + multi-output)', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-recipe-'));
  try {
    fs.mkdirSync(path.join(r, 'ext'), { recursive: true }); // empty managed set
    fs.writeFileSync(path.join(r, 'src.txt'), 'hello');
    // a pure recipe module: recipe(inputs, opts) -> blob | { relpath: data }
    fs.writeFileSync(path.join(r, 'recipe.mjs'),
      'export function shout(inputs, opts) { return inputs[0].text.toUpperCase() + (opts.bang || ""); }\n' +
      'export function pair(inputs) { return { "out/a.txt": inputs[0].text, "out/b.txt": "B" }; }\n');
    fs.writeFileSync(path.join(r, 'make.yaml'),
      'targets:\n' +
      '  shout:\n' +
      '    out: "OUT.txt"\n' +
      '    run: "recipe.mjs#shout"\n' +
      '    opts:\n' +
      '      bang: "!"\n' +
      '    inputs:\n' +
      '      - "src.txt"\n' +
      '  pair:\n' +
      '    run: "recipe.mjs#pair"\n' +
      '    inputs:\n' +
      '      - "src.txt"\n');
    const res = await make({ extDir: path.join(r, 'ext'), force: true, log: () => {} });
    assert.ok(res.targets.built.includes('shout') && res.targets.built.includes('pair'));
    assert.equal(fs.readFileSync(path.join(r, 'OUT.txt'), 'utf8'), 'HELLO!', 'single blob → out:, opts passed');
    assert.equal(fs.readFileSync(path.join(r, 'out', 'a.txt'), 'utf8'), 'hello', 'map → keys rel to root, dirs made');
    assert.equal(fs.readFileSync(path.join(r, 'out', 'b.txt'), 'utf8'), 'B');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('runRecipe: a recipe returning Uint8Array writes binary to out', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-recipe-bin-'));
  try {
    fs.writeFileSync(path.join(r, 'in.bin'), 'x');
    fs.writeFileSync(path.join(r, 'recipe.mjs'),
      'export function magic() { return new Uint8Array([0, 97, 115, 109]); }\n');
    await runRecipe(
      { name: 'm', run: 'recipe.mjs#magic', out: 'out.wasm', opts: {}, inputs: () => [path.join(r, 'in.bin')] },
      r);
    const out = fs.readFileSync(path.join(r, 'out.wasm'));
    assert.deepEqual([...out], [0, 97, 115, 109], 'binary written verbatim (\\0asm)');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('atrac compileRecipe: the real atra recipe compiles a real .atra cart to wasm', async () => {
  const { compileRecipe } = await import('../ext/atra/atrac.js');
  const src = fs.readFileSync(path.join(root, 'ext', 'wasm4', 'cart-demo.atra'), 'utf8');
  const bytes = compileRecipe([{ path: 'cart.atra', text: src, bytes: new Uint8Array() }]);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 8);
  assert.deepEqual([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'wasm magic \\0asm');
});
