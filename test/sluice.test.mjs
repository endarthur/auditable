// @gcu/sluice — unit tests (node --test, zero framework, zero DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulator, count, sum, extent, welford, weightedStats,
  tdigest, quantile, quantileFromCentroids,
  topK, cardinality,
  histogram, cumulativeFromTop,
  collect, groupBy, binned,
  accumulatorFromSpec,
  fromText, fromBytes, fromBlob, sample, lines, parseCsv, filter, map, select,
  recipe, scan, scanState, chunks, NULL_SENTINELS,
  compileExpr, opFromSpec, opsFromSpecs,
} from '../ext/sluice/src/main.js';

// Feed an array of values to an accumulator, return its result.
function run(acc, values, weights) {
  const s = acc.create();
  values.forEach((v, i) => acc.push(s, v, weights ? weights[i] : 1));
  return acc.result(s);
}
function runToState(acc, values) {
  const s = acc.create();
  for (const v of values) acc.push(s, v);
  return s;
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── Protocol ──────────────────────────────────────────────────────────
test('accumulator() validates the protocol', () => {
  assert.throws(() => accumulator({ create() {}, push() {}, merge() {} }), /result/);
  const a = accumulator(count());
  assert.equal(typeof a.push, 'function');
});

// ── count / sum / extent ──────────────────────────────────────────────
test('count / sum / extent', () => {
  assert.equal(run(count(), [1, 2, 3]), 3);
  assert.equal(run(count(), [1, 1], [2, 3]), 5);              // weighted = sum of weights
  assert.deepEqual(run(sum(), [1, 2, 3]), { count: 3, sum: 6 });
  assert.deepEqual(run(sum(), [10, 20], [2, 1]), { count: 2, sum: 40 });
  assert.deepEqual(run(extent(), [5, -2, 9, 3]), { count: 4, min: -2, max: 9 });
  assert.deepEqual(run(extent(), [NaN]), { count: 0, min: null, max: null });
});

// ── Welford ───────────────────────────────────────────────────────────
test('welford mean/variance/std on a known dataset', () => {
  const r = run(welford(), [2, 4, 4, 4, 5, 5, 7, 9]);          // sum of sq dev = 32, n = 8
  assert.equal(r.count, 8);
  assert.equal(r.mean, 5);
  assert.ok(approx(r.variance, 32 / 7, 1e-9));                 // sample variance
  assert.ok(approx(r.std, Math.sqrt(32 / 7), 1e-9));
  assert.equal(r.min, 2); assert.equal(r.max, 9);
});

test('welford skips non-finite, counts zeros', () => {
  const r = run(welford(), [1, 0, NaN, 0, 2]);
  assert.equal(r.count, 4);                                    // NaN skipped
  assert.equal(r.zeros, 2);
});

test('welford MERGE == single pass (the parallel value-add)', () => {
  const data = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 100 + i * 0.3);
  const single = welford().result(runToState(welford(), data));
  const a = runToState(welford(), data.slice(0, 137));
  const b = runToState(welford(), data.slice(137, 642));
  const c = runToState(welford(), data.slice(642));
  const merged = welford().result(welford().merge(welford().merge(a, b), c));
  assert.ok(approx(merged.mean, single.mean, 1e-6), 'mean');
  assert.ok(approx(merged.variance, single.variance, 1e-4), 'variance');
  assert.ok(approx(merged.skewness, single.skewness, 1e-4), 'skewness');
  assert.ok(approx(merged.kurtosis, single.kurtosis, 1e-4), 'kurtosis');
  assert.equal(merged.count, single.count);
  assert.equal(merged.min, single.min); assert.equal(merged.max, single.max);
});

test('welford merge with an empty partition', () => {
  const a = runToState(welford(), [1, 2, 3]);
  const empty = welford().create();
  const r = welford().result(welford().merge(a, empty));
  assert.equal(r.count, 3); assert.equal(r.mean, 2);
});

// ── weightedStats ─────────────────────────────────────────────────────
test('weightedStats weighted mean + merge', () => {
  // weighted mean of [1,2,3] w [1,2,3] = (1+4+9)/6 = 14/6
  const r = run(weightedStats(), [1, 2, 3], [1, 2, 3]);
  assert.ok(approx(r.mean, 14 / 6, 1e-9));
  assert.equal(r.weight, 6);
  const a = runToStateW(weightedStats(), [[1, 1], [2, 2]]);
  const b = runToStateW(weightedStats(), [[3, 3]]);
  const m = weightedStats().result(weightedStats().merge(a, b));
  assert.ok(approx(m.mean, 14 / 6, 1e-9));
});
function runToStateW(acc, pairs) {
  const s = acc.create();
  for (const [v, w] of pairs) acc.push(s, v, w);
  return s;
}

// ── t-digest ──────────────────────────────────────────────────────────
test('tdigest quantiles approximate a uniform 0..9999', () => {
  const acc = tdigest();
  const s = acc.create();
  for (let i = 0; i < 10000; i++) acc.push(s, i);
  assert.ok(Math.abs(quantile(s, 0.5) - 5000) < 100, 'median');
  assert.ok(Math.abs(quantile(s, 0.1) - 1000) < 100, 'p10');
  assert.ok(Math.abs(quantile(s, 0.9) - 9000) < 100, 'p90');
  assert.equal(quantile(s, 0), 0 <= quantile(s, 0) ? quantile(s, 0) : 0); // min-ish
});

test('tdigest merge keeps the median', () => {
  const acc = tdigest();
  const a = acc.create(), b = acc.create();
  for (let i = 0; i < 5000; i++) acc.push(a, i);
  for (let i = 5000; i < 10000; i++) acc.push(b, i);
  const m = acc.merge(a, b);
  const out = acc.result(m);
  assert.equal(out.count, 10000);
  assert.ok(Math.abs(quantileFromCentroids(out.centroids, out.count, 0.5) - 5000) < 100);
});

// ── categorical ───────────────────────────────────────────────────────
test('topK counts, top(k), and overflow cap', () => {
  const acc = topK({ limit: 3 });
  const s = acc.create();
  for (const v of ['a', 'a', 'b', 'c', 'a', 'b']) acc.push(s, v);
  acc.push(s, 'd');                                            // 4th distinct -> overflow
  const r = acc.result(s);
  assert.equal(r.distinct, 3);
  assert.equal(r.overflow, true);
  assert.deepEqual(r.top(2), [['a', 3], ['b', 2]]);
  assert.equal(r.counts.d, undefined);
});

test('topK skips null/empty; cardinality reports distinct', () => {
  const r = run(cardinality(), ['x', '', 'y', null, 'x', undefined]);
  assert.equal(r.distinct, 2);
});

test('topK merge sums counts', () => {
  const acc = topK();
  const a = acc.create(), b = acc.create();
  ['a', 'a', 'b'].forEach((v) => acc.push(a, v));
  ['b', 'c'].forEach((v) => acc.push(b, v));
  const r = acc.result(acc.merge(a, b));
  assert.deepEqual(r.counts, { a: 2, b: 2, c: 1 });
});

// ── histogram ─────────────────────────────────────────────────────────
test('histogram bins, under/over, merge, cumulativeFromTop', () => {
  const acc = histogram({ min: 0, max: 10, bins: 5 });          // width 2
  const s = acc.create();
  for (const v of [0, 1, 3, 5, 7, 9, -1, 11]) acc.push(s, v);
  const r = acc.result(s);
  assert.deepEqual(Array.from(r.counts), [2, 1, 1, 1, 1]);      // [0,2):0,1 ; [2,4):3 ; …
  assert.equal(r.under, 1); assert.equal(r.over, 1);
  assert.equal(r.edges.length, 6);
  const cum = cumulativeFromTop(r.counts);
  assert.deepEqual(Array.from(cum), [6, 4, 3, 2, 1]);
  // merge
  const s2 = acc.create(); acc.push(s2, 1);
  const m = acc.result(acc.merge(s, s2));
  assert.equal(m.counts[0], 3);
});

// ── combinators ───────────────────────────────────────────────────────
test('collect fans one row out to many accumulators', async () => {
  const rows = [{ au: 1, lito: 'A' }, { au: 3, lito: 'B' }, { au: 5, lito: 'A' }];
  const acc = collect({ au: [welford(), (r) => r.au], lito: [topK(), (r) => r.lito] });
  const s = acc.create();
  for (const r of rows) acc.push(s, r);
  const out = acc.result(s);
  assert.equal(out.au.mean, 3);
  assert.deepEqual(out.lito.counts, { A: 2, B: 1 });
});

test('groupBy stratifies + enforces maxGroups', () => {
  const rows = [{ g: 'x', v: 1 }, { g: 'y', v: 10 }, { g: 'x', v: 3 }];
  // groupBy's sub-accumulator receives the row; wrap a value-accumulator with
  // an extractor via collect so welford gets r.v.
  const acc2 = groupBy((r) => r.g, () => collect({ v: [welford(), (r) => r.v] }), {});
  const s2 = acc2.create();
  for (const r of rows) acc2.push(s2, r);
  const out = acc2.result(s2);
  assert.equal(out.groups.x.v.mean, 2);
  assert.equal(out.groups.y.v.mean, 10);
  assert.equal(out.overflow, false);

  const capped = groupBy((r) => r.g, () => count(), { maxGroups: 1 });
  const cs = capped.create();
  capped.push(cs, { g: 'a' }); capped.push(cs, { g: 'b' });
  assert.equal(capped.result(cs).overflow, true);
});

test('groupBy merge combines per key', () => {
  const acc = groupBy((r) => r.g, () => collect({ v: [welford(), (r) => r.v] }), {});
  const a = acc.create(), b = acc.create();
  acc.push(a, { g: 'x', v: 2 });
  acc.push(b, { g: 'x', v: 4 });
  acc.push(b, { g: 'y', v: 9 });
  const out = acc.result(acc.merge(a, b));
  assert.equal(out.groups.x.v.mean, 3);
  assert.equal(out.groups.y.v.mean, 9);
});

test('binned dense + sparse', () => {
  const dense = binned((r) => r.z, { min: 0, max: 10, bins: 5 }, () => collect({ g: [welford(), (r) => r.g] }));
  const ds = dense.create();
  for (const r of [{ z: 1, g: 10 }, { z: 1, g: 20 }, { z: 7, g: 5 }]) dense.push(ds, r);
  const dr = dense.result(ds);
  assert.equal(dr.length, 2);
  assert.equal(dr[0].center, 1); assert.equal(dr[0].value.g.mean, 15);

  const sparse = binned((r) => r.z, { binWidth: 5 }, () => count());
  const ss = sparse.create();
  for (const r of [{ z: 1 }, { z: 2 }, { z: 12 }]) sparse.push(ss, r);
  const sr = sparse.result(ss);
  assert.equal(sr.length, 2);
  assert.equal(sr[0].center, 2.5); assert.equal(sr[0].value, 2);
});

// ── runner: sources, parseCsv, ops, scan ──────────────────────────────
const CSV = 'X,Y,LITO\n1,10,A\n2,20,B\n3,30,A\n-9999,40,A\n';

test('sample reads first n non-comment lines', async () => {
  const lns = await sample(fromText('# c\nh1,h2\n1,2\n3,4\n'), 2);
  assert.deepEqual(lns, ['h1,h2', '1,2']);
});

test('parseCsv types numeric, honors NULL_SENTINELS', async () => {
  assert.ok(NULL_SENTINELS.has('-9999'));
  const acc = collect({ X: [welford(), (r) => r.X], LITO: [topK(), (r) => r.LITO] });
  const out = await scan(
    recipe(fromText(CSV), parseCsv({ columns: [{ name: 'X', type: 'numeric' }, { name: 'LITO', type: 'categorical' }] })),
    acc,
  );
  assert.equal(out.X.count, 3);                                // -9999 -> NaN, skipped
  assert.equal(out.X.mean, 2);
  assert.deepEqual(out.LITO.counts, { A: 3, B: 1 });            // categorical counts all 4
});

test('filter / map / select ops', async () => {
  const out = await scan(
    recipe(fromText(CSV), parseCsv({}), filter((r) => r.LITO === 'A' && Number.isFinite(r.X)), map((r) => ({ X2: r.X * 10 }))),
    collect({ X2: [sum(), (r) => r.X2] }),
  );
  assert.deepEqual(out.X2, { count: 2, sum: 40 });             // rows X=1,3 -> 10+30
});

test('fromBytes decodes utf-8 chunks', async () => {
  const bytes = new TextEncoder().encode('a,b\n1,2\n');
  const out = await scan(recipe(fromBytes(bytes), parseCsv({})), collect({ a: [sum(), (r) => r.a] }));
  assert.equal(out.a.sum, 1);
});

// ── chunks: parallel scan-then-merge == single scan ───────────────────
test('chunks split at line boundaries; merged == single', async () => {
  // 500 rows; single welford over X vs 4-chunk merged welford over X.
  let csv = 'X,G\n';
  for (let i = 0; i < 500; i++) csv += `${i},${i % 3}\n`;
  const blob = new Blob([csv]);

  const accFor = () => collect({ X: [welford(), (r) => r.X] });
  const single = await scan(recipe(fromText(csv), parseCsv({})), accFor());

  const { header, sources } = await chunks(blob, 4);
  assert.deepEqual(header, ['X', 'G']);
  assert.ok(sources.length >= 1 && sources.length <= 4);
  const states = await Promise.all(
    sources.map((src) => scanState(recipe(src, parseCsv({ header })), accFor())),
  );
  const acc = accFor();
  const merged = acc.result(states.reduce((p, c) => acc.merge(p, c)));
  assert.equal(merged.X.count, single.X.count);
  assert.equal(merged.X.count, 500);
  assert.ok(approx(merged.X.mean, single.X.mean, 1e-6));
  assert.ok(approx(merged.X.variance, single.X.variance, 1e-3));
});

// ── serializability (the structuredClone contract) ────────────────────
test('accumulator state survives structuredClone (worker/cache transfer)', () => {
  const acc = collect({ x: [welford(), (r) => r.x], h: [histogram({ min: 0, max: 10, bins: 4 }), (r) => r.x] });
  const s = acc.create();
  for (const v of [1, 2, 3, 8]) acc.push(s, { x: v });
  const clone = structuredClone(s);                            // as if postMessage'd
  const out = acc.result(clone);
  assert.equal(out.x.count, 4);
  assert.equal(out.x.mean, 3.5);
  assert.equal(out.h.count, 4);
});

// ── accumulatorFromSpec (serializable cross-realm op contract) ─────────
test('accumulatorFromSpec: leaf welford', () => {
  const acc = accumulatorFromSpec({ kind: 'welford' });
  const r = run(acc, [2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(r.mean, 5);
});

test('accumulatorFromSpec: collect of per-column accumulators', () => {
  const spec = { kind: 'collect', fields: {
    au:   { column: 'au',   of: { kind: 'welford' } },
    lito: { column: 'lito', of: { kind: 'topK' } },
  } };
  // spec is plain JSON — survives a serialization round-trip (the worker case)
  const acc = accumulatorFromSpec(JSON.parse(JSON.stringify(spec)));
  const s = acc.create();
  for (const r of [{ au: 1, lito: 'A' }, { au: 3, lito: 'B' }, { au: 5, lito: 'A' }]) acc.push(s, r);
  const out = acc.result(s);
  assert.equal(out.au.mean, 3);
  assert.deepEqual(out.lito.counts, { A: 2, B: 1 });
});

test('accumulatorFromSpec: groupBy of collect (stratified)', () => {
  const spec = { kind: 'groupBy', column: 'g', of: {
    kind: 'collect', fields: { v: { column: 'v', of: { kind: 'welford' } } },
  } };
  const acc = accumulatorFromSpec(spec);
  const s = acc.create();
  for (const r of [{ g: 'x', v: 2 }, { g: 'y', v: 10 }, { g: 'x', v: 4 }]) acc.push(s, r);
  const out = acc.result(s);
  assert.equal(out.groups.x.v.mean, 3);
  assert.equal(out.groups.y.v.mean, 10);
});

test('accumulatorFromSpec: histogram + unknown kind throws', () => {
  const h = accumulatorFromSpec({ kind: 'histogram', min: 0, max: 10, bins: 5 });
  assert.equal(h.create().bins, 5);
  assert.throws(() => accumulatorFromSpec({ kind: 'nope' }), /unknown accumulator spec/);
  assert.throws(() => accumulatorFromSpec({ kind: 'groupBy', of: { kind: 'welford' } }), /column/);
});

test('gradeTonnage cumulative curve (via spec) + merge == single', () => {
  const spec = { kind: 'gradeTonnage', grade: 'g', gradeMin: 0, gradeMax: 2, bins: 4, blockVolume: 1000 };
  const rows = [{ g: 0.5 }, { g: 1.0 }, { g: 1.5 }, { g: 2.0 }];
  const acc = accumulatorFromSpec(JSON.parse(JSON.stringify(spec)));   // serializable
  const s = acc.create();
  for (const r of rows) acc.push(s, r);
  const out = acc.result(s);
  assert.equal(out.count, 4);
  assert.ok(approx(out.curve[0].tonnage, 4000) && approx(out.curve[0].metal, 5000) && approx(out.curve[0].grade, 1.25), 'cutoff 0');
  assert.ok(approx(out.curve[2].tonnage, 3000) && approx(out.curve[2].grade, 1.5), 'cutoff 1.0');
  // tonnage-weighted by a density column
  const dacc = accumulatorFromSpec({ kind: 'gradeTonnage', grade: 'g', gradeMin: 0, gradeMax: 2, bins: 4, blockVolume: 1000, density: 'rho' });
  const ds = dacc.create();
  dacc.push(ds, { g: 1.5, rho: 3 });          // tonnage = 1000 * 3 = 3000
  assert.ok(approx(dacc.result(ds).curve[0].tonnage, 3000));
  // parallel-merge equivalence
  const a = acc.create(); acc.push(a, rows[0]); acc.push(a, rows[1]);
  const b = acc.create(); acc.push(b, rows[2]); acc.push(b, rows[3]);
  const m = acc.result(acc.merge(a, b));
  assert.ok(approx(m.curve[0].tonnage, 4000) && approx(m.curve[2].grade, 1.5), 'merge == single');
});

test('chunks exposes raw Blob slices (for by-reference worker dispatch)', async () => {
  let csv = 'X,G\n';
  for (let i = 0; i < 200; i++) csv += `${i},${i % 3}\n`;
  const blob = new Blob([csv]);
  const { header, sources, blobs } = await chunks(blob, 4);
  assert.deepEqual(header, ['X', 'G']);
  assert.equal(blobs.length, sources.length);
  assert.ok(blobs.every((b) => typeof b.slice === 'function'));   // real Blobs
  // a chunk Blob scans like any source, via a spec-built accumulator
  const acc = accumulatorFromSpec({ kind: 'collect', fields: { X: { column: 'X', of: { kind: 'welford' } } } });
  const st = await scanState(recipe(fromBlob(blobs[0]), parseCsv({ header })), acc);
  assert.ok(acc.result(st).X.count > 0);
});

// ── row-expression ops (calc/filter) ─────────────────────────────────────
test('compileExpr: columns + helper vocabulary + Math in scope', () => {
  assert.equal(compileExpr('Au * 0.6 + ifnull(Cu, 0)')({ Au: 2, Cu: NaN }), 1.2);
  assert.equal(compileExpr('sqrt(x)')({ x: 9 }), 3);
  assert.equal(compileExpr('clamp(x, 0, 10)')({ x: 15 }), 10);
  assert.equal(compileExpr('cap(x, 5)')({ x: 9 }), 5);
  assert.equal(compileExpr('between(g, 1, 5)')({ g: 3 }), true);
  assert.equal(compileExpr('remap(x, 0, 10, 0, 100)')({ x: 3 }), 30);
});

test('opFromSpec: derive + filter fuse into a scan (serializable, streaming)', async () => {
  const csv = 'X,Au,Cu\n100,2,\n110,1,3\n120,5,0\n';
  const columns = [{ name: 'X', type: 'numeric' }, { name: 'Au', type: 'numeric' }, { name: 'Cu', type: 'numeric' }];
  const ops = opsFromSpecs([
    { kind: 'derive', name: 'AuEq', expr: 'Au * 0.6 + ifnull(Cu, 0)' },   // [1.2, 3.6, 3.0]
    { kind: 'filter', expr: 'AuEq >= 1.5' },                              // keeps [3.6, 3.0]
  ]);
  const acc = accumulatorFromSpec({ kind: 'collect', fields: { v: { column: 'AuEq', of: { kind: 'welford' } } } });
  const out = await scan(recipe(fromText(csv), parseCsv({ header: true, columns }), ...ops), acc);
  assert.equal(out.v.count, 2);
  assert.ok(Math.abs(out.v.mean - 3.3) < 1e-9);
});

test('opFromSpec: unknown kind throws', () => {
  assert.throws(() => opFromSpec({ kind: 'nope' }), /unknown op spec/);
});
