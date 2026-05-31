// @gcu/flowsheet — unit + integration tests (node --test). Heavy focus on the
// lazy / content-addressed invariants: compute-once, change-recomputes-only-
// downstream, diamond-shared, version-bump, cycle/validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineNode, createRegistry, compatibleKinds,
  canonicalJson, hashParts,
  createMemoryCache, createNullCache,
  createEngine, inlineBackend,
} from '../ext/flowsheet/src/main.js';
import { collect, welford, recipe, fromText, parseCsv, scan, sample } from '../ext/sluice/src/main.js';
import { sniff } from '../ext/recon/src/main.js';

// A registry with const/add/mul, instrumented with a per-node run counter.
function fixture(runs = {}) {
  const reg = createRegistry();
  const tick = (ctx) => { runs[ctx.nodeId] = (runs[ctx.nodeId] || 0) + 1; };
  reg.register({ type: 'const', version: 1, outputs: { out: 'scalar' }, compute: (i, p, ctx) => { tick(ctx); return { out: p.value }; } });
  reg.register({ type: 'add', version: 1, inputs: { a: 'scalar', b: 'scalar' }, outputs: { out: 'scalar' }, compute: (i, p, ctx) => { tick(ctx); return { out: i.a + i.b }; } });
  reg.register({ type: 'mul', version: 1, inputs: { a: 'scalar', b: 'scalar' }, outputs: { out: 'scalar' }, compute: (i, p, ctx) => { tick(ctx); return { out: i.a * i.b }; } });
  return reg;
}
const approx = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ── primitives ────────────────────────────────────────────────────────
test('defineNode validates type + compute', () => {
  assert.throws(() => defineNode({ compute() {} }), /type/);
  assert.throws(() => defineNode({ type: 'x' }), /compute/);
  const d = defineNode({ type: 'x', compute: () => ({}) });
  assert.equal(d.version, 1);
});

test('canonicalJson is key-order stable; hashParts deterministic', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(hashParts('t', 'v1', { x: 1 }), hashParts('t', 'v1', { x: 1 }));
  assert.notEqual(hashParts('t', 'v1', { x: 1 }), hashParts('t', 'v1', { x: 2 }));
});

test('compatibleKinds', () => {
  assert.ok(compatibleKinds('scalar', 'scalar'));
  assert.ok(compatibleKinds('blockmodel', 'table'));   // §4a
  assert.ok(compatibleKinds('table', 'any'));
  assert.ok(!compatibleKinds('mesh', 'scalar'));
});

test('memory cache LRU eviction', () => {
  const c = createMemoryCache({ max: 2 });
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);   // 'b' is LRU → evicted
  assert.equal(c.size(), 2);
  assert.ok(c.has('a') && c.has('c') && !c.has('b'));
});

// ── execution + caching ───────────────────────────────────────────────
test('pull resolves a chain', async () => {
  const eng = createEngine({ registry: fixture() });
  const p = { nodes: [
    { id: 'a', type: 'const', params: { value: 2 } },
    { id: 'b', type: 'const', params: { value: 3 } },
    { id: 's', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
  ] };
  assert.equal(await eng.pull(p, 's', 'out'), 5);
  assert.deepEqual(await eng.pull(p, 's'), { out: 5 });   // whole output object
});

test('caching: compute runs once across repeated pulls', async () => {
  const runs = {};
  const eng = createEngine({ registry: fixture(runs) });
  const p = { nodes: [
    { id: 'a', type: 'const', params: { value: 2 } },
    { id: 'b', type: 'const', params: { value: 3 } },
    { id: 's', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
  ] };
  await eng.pull(p, 's'); await eng.pull(p, 's'); await eng.pull(p, 's');
  assert.equal(runs.s, 1); assert.equal(runs.a, 1); assert.equal(runs.b, 1);
});

test('invalidation: a param change recomputes ONLY that node + downstream', async () => {
  const runs = {};
  const eng = createEngine({ registry: fixture(runs) });
  const mk = (bVal) => ({ nodes: [
    { id: 'a', type: 'const', params: { value: 2 } },
    { id: 'b', type: 'const', params: { value: bVal } },
    { id: 's', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
  ] });
  assert.equal(await eng.pull(mk(3), 's', 'out'), 5);
  assert.deepEqual([runs.a, runs.b, runs.s], [1, 1, 1]);
  assert.equal(await eng.pull(mk(4), 's', 'out'), 6);     // b changed
  assert.equal(runs.a, 1, 'a (upstream of unchanged) NOT recomputed');
  assert.equal(runs.b, 2, 'b recomputed');
  assert.equal(runs.s, 2, 's (downstream) recomputed');
});

test('laziness: pulling one branch does not compute an unrelated node', async () => {
  const runs = {};
  const eng = createEngine({ registry: fixture(runs) });
  const p = { nodes: [
    { id: 'a', type: 'const', params: { value: 2 } },
    { id: 'b', type: 'const', params: { value: 3 } },
    { id: 'used', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
    { id: 'unused', type: 'mul', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
  ] };
  await eng.pull(p, 'used');
  assert.equal(runs.used, 1);
  assert.equal(runs.unused, undefined, 'unrelated node never computed');
});

test('diamond: a shared upstream computes exactly once', async () => {
  const runs = {};
  const reg = fixture(runs);
  const eng = createEngine({ registry: reg });
  // a -> b, a -> c, (b,c) -> d
  const p = { nodes: [
    { id: 'a', type: 'const', params: { value: 5 } },
    { id: 'one', type: 'const', params: { value: 1 } },
    { id: 'b', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'one', port: 'out' } } },
    { id: 'c', type: 'mul', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'one', port: 'out' } } },
    { id: 'd', type: 'add', wiring: { a: { node: 'b', port: 'out' }, b: { node: 'c', port: 'out' } } },
  ] };
  assert.equal(await eng.pull(p, 'd', 'out'), 11);          // (5+1) + (5*1)
  assert.equal(runs.a, 1, 'shared upstream computed once despite two paths');
});

test('typeVersion bump invalidates cached results', async () => {
  const runs = {};
  const reg = fixture(runs);
  const eng = createEngine({ registry: reg });
  const p = { nodes: [
    { id: 'a', type: 'const', params: { value: 2 } },
    { id: 'b', type: 'const', params: { value: 3 } },
    { id: 's', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
  ] };
  const h1 = eng.hashOf(p, 's');
  await eng.pull(p, 's'); assert.equal(runs.s, 1);
  reg.register({ type: 'add', version: 2, inputs: { a: 'scalar', b: 'scalar' }, outputs: { out: 'scalar' }, compute: (i, _p, ctx) => { runs[ctx.nodeId] = (runs[ctx.nodeId] || 0) + 1; return { out: i.a + i.b }; } });
  const h2 = eng.hashOf(p, 's');
  assert.notEqual(h1, h2, 'version bump changes the hash');
  await eng.pull(p, 's'); assert.equal(runs.s, 2, 'recomputed after version bump');
});

test('async compute + opaque handle pass-through', async () => {
  const reg = createRegistry();
  reg.register({ type: 'src', version: 1, outputs: { h: 'table' }, compute: async () => ({ h: { kind: 'table', ref: 'vfs://x', rows: 99 } }) });
  reg.register({ type: 'rows', version: 1, inputs: { h: 'table' }, outputs: { n: 'scalar' }, compute: async (i) => ({ n: i.h.rows }) });
  const eng = createEngine({ registry: reg });
  const p = { nodes: [{ id: 's', type: 'src' }, { id: 'r', type: 'rows', wiring: { h: { node: 's', port: 'h' } } }] };
  assert.equal(await eng.pull(p, 'r', 'n'), 99);
});

test('engine survives aggressive eviction (recompute, never wrong)', async () => {
  const runs = {};
  const eng = createEngine({ registry: fixture(runs), cache: createMemoryCache({ max: 1 }) });
  const p = { nodes: [
    { id: 'a', type: 'const', params: { value: 2 } },
    { id: 'b', type: 'const', params: { value: 3 } },
    { id: 's', type: 'add', wiring: { a: { node: 'a', port: 'out' }, b: { node: 'b', port: 'out' } } },
  ] };
  assert.equal(await eng.pull(p, 's', 'out'), 5);          // correct despite max:1 churn
  assert.equal(await eng.pull(p, 's', 'out'), 5);
});

test('null cache forces recompute every pull', async () => {
  const runs = {};
  const eng = createEngine({ registry: fixture(runs), cache: createNullCache() });
  const p = { nodes: [{ id: 'a', type: 'const', params: { value: 1 } }] };
  await eng.pull(p, 'a'); await eng.pull(p, 'a');
  assert.equal(runs.a, 2);
});

// ── validation ────────────────────────────────────────────────────────
test('validate: cycle detected (and pull throws)', async () => {
  const eng = createEngine({ registry: fixture() });
  const p = { nodes: [
    { id: 'x', type: 'add', wiring: { a: { node: 'y', port: 'out' }, b: { node: 'y', port: 'out' } } },
    { id: 'y', type: 'add', wiring: { a: { node: 'x', port: 'out' }, b: { node: 'x', port: 'out' } } },
  ] };
  const v = eng.validate(p);
  assert.ok(!v.ok && v.errors.some((e) => e.error === 'cycle'));
  await assert.rejects(() => eng.pull(p, 'x'), /cycle/);
});

test('validate: dangling, unknown-type, unknown-port, kind-mismatch, duplicate-id', () => {
  const reg = fixture();
  reg.register({ type: 'meshsrc', version: 1, outputs: { m: 'mesh' }, compute: () => ({ m: {} }) });
  const eng = createEngine({ registry: reg });

  const dangling = eng.validate({ nodes: [{ id: 's', type: 'add', wiring: { a: { node: 'ghost', port: 'out' }, b: { node: 'ghost', port: 'out' } } }] });
  assert.ok(dangling.errors.some((e) => e.error === 'dangling-input'));

  const unknownType = eng.validate({ nodes: [{ id: 'z', type: 'nope' }] });
  assert.ok(unknownType.errors.some((e) => e.error === 'unknown-type'));

  const badPort = eng.validate({ nodes: [
    { id: 'a', type: 'const', params: { value: 1 } },
    { id: 's', type: 'add', wiring: { a: { node: 'a', port: 'WRONG' }, b: { node: 'a', port: 'out' } } },
  ] });
  assert.ok(badPort.errors.some((e) => e.error === 'unknown-output-port'));

  const mismatch = eng.validate({ nodes: [
    { id: 'm', type: 'meshsrc' },
    { id: 's', type: 'add', wiring: { a: { node: 'm', port: 'm' }, b: { node: 'm', port: 'm' } } },   // mesh → scalar
  ] });
  assert.ok(mismatch.errors.some((e) => e.error === 'kind-mismatch'));

  const dup = eng.validate({ nodes: [{ id: 'a', type: 'const' }, { id: 'a', type: 'const' }] });
  assert.ok(!dup.ok && dup.errors.some((e) => e.error === 'duplicate-id'));

  assert.ok(eng.validate({ nodes: [{ id: 'a', type: 'const', params: { value: 1 } }] }).ok);
});

// ── integration: flowsheet orchestrates sluice + recon ─────────────────────
test('integration: [source.text → recon.sniff → sluice stats], cached + reactive', async () => {
  const runs = {};
  const reg = createRegistry();
  reg.register({ type: 'source.text', version: 1, outputs: { source: 'any' }, compute: (i, p, ctx) => { runs[ctx.nodeId] = (runs[ctx.nodeId] || 0) + 1; return { source: fromText(p.text) }; } });
  reg.register({ type: 'recon.sniff', version: 1, inputs: { source: 'any' }, outputs: { manifest: 'any' }, compute: async (i) => ({ manifest: sniff(await sample(i.source, 50)) }) });
  reg.register({
    type: 'stats', version: 1, inputs: { source: 'any', manifest: 'any' }, outputs: { stats: 'scalar' },
    compute: async (i, p, ctx) => {
      runs[ctx.nodeId] = (runs[ctx.nodeId] || 0) + 1;
      const m = i.manifest;
      const acc = collect({ v: [welford(), (r) => r[p.column]] });
      return { stats: await scan(recipe(i.source, parseCsv({ delimiter: m.delimiter, columns: m.columns, header: true })), acc) };
    },
  });
  const eng = createEngine({ registry: reg });

  const mk = (text) => ({ nodes: [
    { id: 'src', type: 'source.text', params: { text } },
    { id: 'snf', type: 'recon.sniff', wiring: { source: { node: 'src', port: 'source' } } },
    { id: 'st', type: 'stats', params: { column: 'AU' }, wiring: { source: { node: 'src', port: 'source' }, manifest: { node: 'snf', port: 'manifest' } } },
  ] });

  const csv = 'AU,LITO\n1,A\n2,B\n3,A\n';
  const out = await eng.pull(mk(csv), 'st', 'stats');
  assert.equal(out.v.count, 3);
  assert.ok(approx(out.v.mean, 2));
  assert.equal(runs.src, 1, 'src shared by sniff + stats, computed once (diamond)');

  await eng.pull(mk(csv), 'st', 'stats');
  assert.equal(runs.st, 1, 'stats cached on identical pipeline');

  const out2 = await eng.pull(mk('AU\n10\n20\n'), 'st', 'stats');   // source changed
  assert.ok(approx(out2.v.mean, 15));
  assert.equal(runs.st, 2, 'stats recomputed after upstream source changed');
});
