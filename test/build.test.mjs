// @gcu/build — phase 1 tests (SPEC §16)
//
// Synthetic fixtures run through the MEMORY adapter (no temp dirs, deterministic),
// then a behavioral round-trip against the real ext/adder package. Phase 1 scope:
// manifest walk, relative resolution, collision rename, named + side-effect import
// rewriting, named re-exports, default/dynamic bans, comment preservation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleMemory, bundle } from '../ext/build/src/main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Import a bundle's code string as an ES module (no relative externals → data URL).
async function importCode(code) {
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(url);
}

// ── 1. basic: named exports + re-export resolve and behave ──
test('basic: re-exports resolve to the right bindings', async () => {
  const sources = {
    'src/main.js': "export { hello } from './greet.js';\nexport { val } from './a.js';\n",
    'src/greet.js': "import { val } from './a.js';\nexport function hello(n){ return 'hi ' + n + ' ' + val; }\n",
    'src/a.js': "export const val = 42;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.deepEqual(Object.keys(m).sort(), ['hello', 'val']);
  assert.equal(m.hello('x'), 'hi x 42');
  assert.equal(m.val, 42);
});

// ── 2. side-effect import runs, in dependency order (deps before dependents) ──
test('side-effect import: module order is deps-before-dependents', async () => {
  const sources = {
    'src/main.js': "import './side.js';\nexport { go } from './use.js';\n",
    'src/use.js': "import { base } from './side.js';\nexport function go(){ return base * 2; }\n",
    'src/side.js': "export const base = 21;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  // side.js must appear before use.js in the emitted body
  assert.ok(r.code.indexOf('── src/side.js ──') < r.code.indexOf('── src/use.js ──'));
  const m = await importCode(r.code);
  assert.equal(m.go(), 42);
});

// ── 3. collision: two modules declare `cmp`; both rename and resolve ──
test('collision: colliding top-level names rename per-module', async () => {
  const sources = {
    'src/main.js': "export { fromA } from './a.js';\nexport { fromB } from './b.js';\n",
    'src/a.js': "const cmp = (x) => x + 1;\nexport function fromA(n){ const o = { cmp, raw: cmp(n) }; return o.raw; }\n",
    'src/b.js': "function cmp(x){ return x * 10; }\nexport function fromB(n){ return cmp(n); }\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  assert.ok(r.code.includes('cmp$a'));
  assert.ok(r.code.includes('cmp$b'));
  assert.ok(r.code.includes('cmp: cmp$a'), 'shorthand property expanded on rename');
  const m = await importCode(r.code);
  assert.equal(m.fromA(5), 6);
  assert.equal(m.fromB(5), 50);
  assert.equal(r.meta.renames.length, 2);
});

// ── 4. named import aliasing: refs to the alias rewrite to the target ──
test('aliased import: `import { x as y }` references rewrite', async () => {
  const sources = {
    'src/main.js': "export { run } from './use.js';\n",
    'src/use.js': "import { thing as t } from './lib.js';\nexport function run(){ return t() + 1; }\n",
    'src/lib.js': "export function thing(){ return 100; }\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.equal(m.run(), 101);
});

// ── 5. aliased re-export ──
test('aliased re-export: `export { a as b } from`', async () => {
  const sources = {
    'src/main.js': "export { inner as outer } from './x.js';\n",
    'src/x.js': "export const inner = 7;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.deepEqual(Object.keys(m), ['outer']);
  assert.equal(m.outer, 7);
});

// ── 6. inner-scope shadow is NOT renamed ──
test('shadowing: inner declaration of a colliding name is left alone', async () => {
  const sources = {
    'src/main.js': "export { fromA } from './a.js';\nexport { fromB } from './b.js';\n",
    'src/a.js': "const dup = 1;\nexport function fromA(){ return dup; }\n",
    'src/b.js': "const dup = 2;\nexport function fromB(){ function inner(){ const dup = 99; return dup; } return inner() + dup; }\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.equal(m.fromA(), 1);
  assert.equal(m.fromB(), 101); // inner dup (99) + module dup$b (2)
});

// ── 7. comment preservation ──
test('comments: JSDoc and license blocks survive byte-for-byte', () => {
  const sources = {
    'src/main.js': "export { f } from './a.js';\n",
    'src/a.js': "/*! license: MIT */\n/** @param {number} n */\nexport function f(n){ return n; } // trailing\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  assert.ok(r.code.includes('/*! license: MIT */'));
  assert.ok(r.code.includes('@param {number} n'));
  assert.ok(r.code.includes('// trailing'));
});

// ── 8. lint/bans (phase-1 errors) ──
test('error: export default is rejected (E005)', () => {
  const sources = {
    'src/main.js': "export { x } from './a.js';\n",
    'src/a.js': "const x = 1;\nexport default x;\n",
  };
  assert.throws(() => bundleMemory(sources, { entry: 'src/main.js' }), /E005/);
});

test('error: dynamic import() is rejected (E006)', () => {
  const sources = {
    'src/main.js': "export { x } from './a.js';\n",
    'src/a.js': "export const x = 1;\nexport function load(){ return import('./b.js'); }\n",
  };
  assert.throws(() => bundleMemory(sources, { entry: 'src/main.js' }), /E006/);
});

test('error: extension-less relative import is rejected (E003)', () => {
  const sources = {
    'src/main.js': "import './a';\nexport const x = 1;\n",
    'src/a.js': "export const y = 2;\n",
  };
  assert.throws(() => bundleMemory(sources, { entry: 'src/main.js' }), /E003/);
});

test('error: default import is rejected (E005)', () => {
  const sources = {
    'src/main.js': "import D from './a.js';\nexport const x = 1;\n",
    'src/a.js': "export const y = 2;\n",
  };
  assert.throws(() => bundleMemory(sources, { entry: 'src/main.js' }), /E005/);
});

// ── 9. external (escaping-src) imports are hoisted + deduped, verbatim ──
test('external: escaping-src imports hoist to top, deduped', async () => {
  const sources = {
    'src/main.js': "export { a } from './a.js';\nexport { b } from './b.js';\n",
    'src/a.js': "import { shared } from '../vendor/lib.js';\nexport function a(){ return shared; }\n",
    'src/b.js': "import { shared } from '../vendor/lib.js';\nexport function b(){ return shared + 1; }\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  // The escaping '../vendor/lib.js' (relative to src/) is rewritten to
  // './vendor/lib.js' for the root-level output, and deduped to a single import.
  const importCount = (r.code.match(/^import \{ shared \} from '\.\/vendor\/lib\.js';$/gm) || []).length;
  assert.equal(importCount, 1, 'duplicate external import collapsed to one');
  // import must be above the first section marker
  assert.ok(r.code.indexOf("from './vendor/lib.js'") < r.code.indexOf('── src/'));
});

// ── 10. determinism: identical input → byte-identical output ──
test('determinism: same input bundles byte-identically', () => {
  const sources = {
    'src/main.js': "export { f } from './a.js';\n",
    'src/a.js': "export function f(){ return 1; }\n",
  };
  const a = bundleMemory(sources, { entry: 'src/main.js' });
  const b = bundleMemory(sources, { entry: 'src/main.js' });
  assert.equal(a.code, b.code);
});

// ── phase 2: namespace imports (§7.3) ──
test('namespace import: `import * as ns` synthesizes a frozen object', async () => {
  const sources = {
    'src/main.js': "export { run } from './use.js';\n",
    'src/use.js': "import * as lib from './lib.js';\nexport function run(){ return lib.a() + lib.b; }\n",
    'src/lib.js': "export function a(){ return 1; }\nexport const b = 2;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  assert.ok(r.code.includes('Object.freeze('), 'namespace object synthesized');
  const m = await importCode(r.code);
  assert.equal(m.run(), 3);
});

test('namespace import: synthesized object is frozen', async () => {
  const sources = {
    'src/main.js': "export { frozen } from './use.js';\n",
    'src/use.js': "import * as lib from './lib.js';\nexport function frozen(){ try { lib.x = 9; } catch {} return Object.isFrozen(lib); }\n",
    'src/lib.js': "export const x = 1;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.equal(m.frozen(), true);
});

// ── phase 2: wildcard re-exports (§7.6) ──
test('wildcard re-export: `export *` enumerates source exports', async () => {
  const sources = {
    'src/main.js': "export * from './x.js';\nexport { extra } from './y.js';\n",
    'src/x.js': "export const p = 1;\nexport const q = 2;\n",
    'src/y.js': "export const extra = 9;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.deepEqual(Object.keys(m).sort(), ['extra', 'p', 'q']);
  assert.equal(m.p, 1); assert.equal(m.q, 2); assert.equal(m.extra, 9);
});

test('wildcard re-export: ambiguous name is omitted with W002', async () => {
  const sources = {
    'src/main.js': "export * from './x.js';\nexport * from './y.js';\n",
    'src/x.js': "export const dup = 1;\nexport const only = 5;\n",
    'src/y.js': "export const dup = 2;\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js' });
  const m = await importCode(r.code);
  assert.deepEqual(Object.keys(m).sort(), ['only']);
  assert.ok(r.warnings.some((w) => w.code === 'W002'), 'W002 emitted for ambiguous export *');
});

// ── phase 2: define (§10) ──
test('define: substitutes in expression position, not in strings', async () => {
  const sources = {
    'src/main.js': "export { v, s } from './a.js';\n",
    'src/a.js': "export const v = __VERSION__;\nexport const s = '__VERSION__ literal';\n",
  };
  const r = bundleMemory(sources, { entry: 'src/main.js', define: { __VERSION__: JSON.stringify('1.2.3') } });
  const m = await importCode(r.code);
  assert.equal(m.v, '1.2.3');
  assert.equal(m.s, '__VERSION__ literal');
});

test('define: bad key rejected (E015)', () => {
  const sources = { 'src/main.js': "export const x = 1;\n" };
  assert.throws(() => bundleMemory(sources, { entry: 'src/main.js', define: { version: '"1"' } }), /E015/);
});

test('define: collision with a declaration rejected (E007)', () => {
  const sources = { 'src/main.js': "export const __X__ = 1;\n" };
  assert.throws(() => bundleMemory(sources, { entry: 'src/main.js', define: { __X__: '2' } }), /E007/);
});

// ── 11. round-trip against real ext/adder ──
test('round-trip: bundled ext/adder behaves like its source', async () => {
  const dir = path.join(root, 'ext', 'adder');
  const r = bundle({ dir, entry: 'src/main.js', write: false });

  // Write the bundle as a sibling of index.js so its escaping-src externals
  // ('../../air/src/...') resolve, then import + compare to source.
  const tmp = path.join(dir, '__roundtrip_bundle.js');
  fs.writeFileSync(tmp, r.code);
  try {
    const srcMod = await import(pathToFileURL(path.join(dir, 'src', 'main.js')).href);
    const bunMod = await import(pathToFileURL(tmp).href);

    assert.deepEqual(Object.keys(bunMod).sort(), Object.keys(srcMod).sort(), 'export surface matches');
    const src = srcMod.adder, bun = bunMod.adder;
    assert.deepEqual(Object.keys(bun).sort(), Object.keys(src).sort(), 'adder shape matches');

    // sync, deterministic comparisons
    const code = 'x = 1\ndef foo(a, b):\n    return a + b\ny = foo(x, 2)\n';
    assert.deepEqual(
      [...src.pythonParseNames(code)].sort(),
      [...bun.pythonParseNames(code)].sort(),
      'pythonParseNames matches'
    );
    assert.deepEqual(
      src.tokenizePython('def f():\n    return 42\n'),
      bun.tokenizePython('def f():\n    return 42\n'),
      'tokenizePython matches'
    );

    // behavioral: run a small program through both tagged-template evaluators
    // and assert the bundle produces structurally identical results to source.
    const prog = ['total = 0\nfor i in range(5):\n    total += i\ntotal\n'];
    const [sres, bres] = await Promise.all([src.adderTag(prog), bun.adderTag(prog)]);
    assert.deepEqual(bres, sres, 'bundle and source produce identical results');
    assert.equal(bres.total, 10);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
