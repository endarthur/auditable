// @gcu/gsjs tests.
//
// The realization oracle (realize/makeTransform/STATUS) is testable today with
// closed-form values — it's pure JS, no atra/wasm. The full reconstruction
// equation (gsjs.kriging vs the gslib.kt3d oracle on Walker Lake) is the M1
// gate; its harness is stubbed + skipped until the atra fork lands.
//
// Spec: spec_inbox/gsjs-SPEC.md §"Realization formula" + §"Validation contract".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize, makeTransform, STATUS } from '../ext/gsjs/src/realize.js';
// The atra fork kriging() was removed (NaN-broken at scale, superseded by the pure-JS
// krige()). These reconstruction/pipeline/recipe-drift tests still validate the SAME
// thing — the kt3d oracle — now via krige(). `faithful: true` matches gslib's truncated
// π so the result is bit-identical to the WASM oracle (krige defaults to accurate π).
const kriging = (opts) => krige({ ...opts, faithful: true });
import { kt3d } from '../ext/gslib/index.js';
import { stats, histogram, swath, gradeTonnage } from '../ext/gsjs/src/aggregate.js';
import { cpuBackend, getBackend, setBackend } from '../ext/gsjs/src/backend.js';
import {
  recipe, variogram, search, ok, sk, sk_lvm, none, topcut, hgr,
  fromJSON, run, estimate, evaluate,
  createNeighborhood, indexSamples, select, setrot, sqdist, GSLIB_PI,
  leapfrogToRotmat, toRotmat, applyAnis, krige, qknaSummary, crossValidate,
  declusterCell, declusterSweep, experimental, buildLagVolume, directionalVariogram, mergeLagVolumes,
} from '../ext/gsjs/index.js';
import { instantiate as gslibInstantiate, alloc as gAlloc, readF64 as gReadF64, growMemory as gGrow,
  writeF64 as gWriteF64, writeI32 as gWriteI32 } from '../ext/gslib/index.js';

const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

// Build a small BlockEstimateTensor by hand. rows = per-block [ [idx,wt], ... ].
function tensor(rows, { sk_mean = null, distances = null } = {}) {
  const n_blocks = rows.length;
  const K = Math.max(1, ...rows.map((r) => r.length));
  const indices = new Int32Array(n_blocks * K);
  const weights = new Float64Array(n_blocks * K);
  const n_actual = new Int32Array(n_blocks);
  const status = new Uint8Array(n_blocks);
  const dist = distances ? new Float64Array(n_blocks * K) : null;
  for (let b = 0; b < n_blocks; b++) {
    n_actual[b] = rows[b].length;
    status[b] = STATUS.OK;
    for (let k = 0; k < rows[b].length; k++) {
      indices[b * K + k] = rows[b][k][0];
      weights[b * K + k] = rows[b][k][1];
      if (dist) dist[b * K + k] = distances[b][k];
    }
  }
  return { indices, weights, n_actual, status, distances: dist, sk_mean, K, n_blocks };
}

test('makeTransform — predicate closed forms', () => {
  const none = makeTransform('none');
  assert.equal(none(20), 20);

  const tc = makeTransform('topcut', { cap: 15 });
  assert.equal(tc(20), 15);
  assert.equal(tc(10), 10);

  // hgr_hard: cap only when BOTH beyond d_thresh AND above grade_thresh
  const hh = makeTransform('hgr_hard', { cap: 15, d_thresh: 50, grade_thresh: 12 });
  assert.equal(hh(20, 60), 15);   // far + high → capped
  assert.equal(hh(20, 40), 20);   // near + high → kept
  assert.equal(hh(10, 60), 10);   // far + low  → kept

  // hgr_soft: ramp from kept→capped over distance for above-threshold grades
  const hs = makeTransform('hgr_soft', { cap: 10, d_max: 100, grade_thresh: 12 });
  assert.equal(hs(8, 50), 8);                 // below grade_thresh → untouched
  assert.equal(hs(20, 0), 20);                // t=0 → full value
  assert.equal(hs(20, 100), 10);              // t=1 → fully capped
  assert.ok(close(hs(20, 50), 0.5 * 20 + 0.5 * 10)); // t=0.5 → 15
});

test('realize — OK (sk_mean null, weights sum to 1)', () => {
  const t = tensor([[[0, 0.6], [1, 0.4]]]);
  const out = realize(t, Float64Array.from([10, 20]));
  assert.ok(close(out[0], 0.6 * 10 + 0.4 * 20)); // 14
});

test('realize — global SK (scalar mean carries the slack weight)', () => {
  const t = tensor([[[0, 0.6], [1, 0.3]]], { sk_mean: 5 });
  const out = realize(t, Float64Array.from([10, 20]));
  // 0.6*10 + 0.3*20 + (1-0.9)*5 = 6 + 6 + 0.5 = 12.5
  assert.ok(close(out[0], 12.5));
});

test('realize — SK+LVM (per-block mean array)', () => {
  const t = tensor([[[0, 0.5]], [[1, 0.5]]], { sk_mean: Float64Array.from([4, 8]) });
  const out = realize(t, Float64Array.from([10, 20]));
  assert.ok(close(out[0], 0.5 * 10 + 0.5 * 4));  // 7
  assert.ok(close(out[1], 0.5 * 20 + 0.5 * 8));  // 14
});

test('realize — topcut reweights without re-kriging', () => {
  const t = tensor([[[0, 0.6], [1, 0.4]]]);
  const out = realize(t, Float64Array.from([10, 20]), { transform: 'topcut', params: { cap: 15 } });
  assert.ok(close(out[0], 0.6 * 10 + 0.4 * 15)); // 12
});

test('realize — hgr needs distances; padded tail ignored', () => {
  // block 0 uses 2 of K=3 slots; the padded slot must not contribute
  const t = tensor([[[0, 0.6], [1, 0.4], [9, 0.0]]], { distances: [[10, 80, 0]] });
  t.n_actual[0] = 2; // ignore the padded slot
  const out = realize(t, Float64Array.from([10, 20, 999]),
    { transform: 'hgr_hard', params: { cap: 15, d_thresh: 50, grade_thresh: 12 } });
  // sample 1 (z=20, d=80) far+high → capped to 15; sample 0 (z=10, d=10) kept
  assert.ok(close(out[0], 0.6 * 10 + 0.4 * 15)); // 12, padded 999 excluded
});

test('realize — hgr without distances throws', () => {
  const t = tensor([[[0, 1.0]]]);
  assert.throws(() => realize(t, Float64Array.from([10]), { transform: 'hgr_soft' }),
    /needs distances/);
});

// ── M1 gate: the reconstruction equation vs the gslib.kt3d oracle ──
// realize(gsjs.kriging(...)) must equal gslib.kt3d.est (and kv == estv) to f64
// on identical input. This is THE correctness contract: if it holds, the
// BlockEstimateTensor captured everything kt3d computed.
const SYNTH = {
  data: [
    [8, 8, 0, 2.1], [12, 30, 0, 3.4], [30, 10, 0, 1.2], [33, 33, 0, 4.0],
    [20, 20, 0, 2.8], [5, 25, 0, 3.1], [25, 5, 0, 1.9], [18, 38, 0, 3.6],
  ],
  grid: { nx: 4, ny: 4, nz: 1, xmn: 5, ymn: 5, zmn: 0, xsiz: 10, ysiz: 10, zsiz: 10 },
  variogram: { nugget: 0.1, structures: [{ type: 'spherical', contribution: 0.9, range: 30 }] },
  search: { radius: 50, ndmin: 1, ndmax: 8 },
};

function reconstruct(ktype, extra = {}) {
  const cfg = { ...SYNTH, ktype, ...extra };
  const ref = kt3d(cfg);
  const r = kriging(cfg);
  const realized = realize(r, r.values);
  let maxErr = 0, maxKv = 0, nOK = 0;
  for (let i = 0; i < r.n_blocks; i++) {
    if (r.status[i] !== STATUS.OK) continue;
    assert.notEqual(ref.est[i], -999, `block ${i}: gsjs OK but kt3d unestimated`);
    nOK++;
    maxErr = Math.max(maxErr, Math.abs(realized[i] - ref.est[i]));
    maxKv = Math.max(maxKv, Math.abs(r.kv[i] - ref.var[i]));
  }
  return { nOK, maxErr, maxKv };
}

test('reconstruction — OK == gslib.kt3d.est to f64', () => {
  const { nOK, maxErr, maxKv } = reconstruct('OK');
  assert.ok(nOK >= 12, `only ${nOK} OK blocks`);
  assert.ok(maxErr < 1e-9, `max est error ${maxErr}`);
  assert.ok(maxKv < 1e-9, `max kv error ${maxKv}`);
});

test('reconstruction — SK (scalar mean) == gslib.kt3d.est to f64', () => {
  const { nOK, maxErr, maxKv } = reconstruct('SK', { skmean: 2.5 });
  assert.ok(nOK >= 12, `only ${nOK} OK blocks`);
  assert.ok(maxErr < 1e-9, `max est error ${maxErr}`);
  assert.ok(maxKv < 1e-9, `max kv error ${maxKv}`);
});

test('OK weights sum to ~1 per estimated block (unbiasedness)', () => {
  const r = kriging({ ...SYNTH, ktype: 'OK' });
  for (let b = 0; b < r.n_blocks; b++) {
    if (r.status[b] !== STATUS.OK) continue;
    let sw = 0;
    for (let k = 0; k < r.n_actual[b]; k++) sw += r.weights[b * r.K + k];
    assert.ok(Math.abs(sw - 1) < 1e-9, `block ${b} Σw=${sw}`);
  }
});

// ── CPU aggregations (the default backend; oracle for a future GPU one) ──
// est [1,2,3,4] OK + a 5th block masked (INSUFFICIENT_DATA) — must not count.
const AGG_EST = Float64Array.from([1, 2, 3, 4, 5]);
const AGG_ST = Uint8Array.from([STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK, STATUS.INSUFFICIENT_DATA]);

test('aggregate.stats masks by status', () => {
  const s = stats(AGG_EST, AGG_ST);
  assert.deepEqual([s.n, s.sum, s.mean, s.min, s.max], [4, 10, 2.5, 1, 4]);
});

test('aggregate.histogram — fixed bins, masked', () => {
  const h = histogram(AGG_EST, AGG_ST, { min: 1, max: 4, nbins: 3 });
  assert.equal(h.n, 4);
  assert.deepEqual([...h.counts], [1, 1, 2]); // {1} {2} {3,4 (4 clamps into last bin)}
  assert.equal(h.edges[0], 1); assert.equal(h.edges[3], 4);
});

test('aggregate.gradeTonnage — exact, tonnage/metal/grade above cutoff', () => {
  const gt = gradeTonnage(AGG_EST, AGG_ST, { cutoffs: [0, 2, 4] });
  assert.deepEqual([...gt.tonnage], [4, 3, 1]);
  assert.deepEqual([...gt.metal], [10, 9, 4]);
  assert.deepEqual([...gt.grade], [2.5, 3, 4]);
});

test('aggregate.swath — mean per axis slice', () => {
  // 2×2×1 grid; blocks 0,2 → ix=0 ; blocks 1,3 → ix=1
  const grid = { nx: 2, ny: 2, nz: 1, xmn: 5, ymn: 5, zmn: 0, xsiz: 10, ysiz: 10, zsiz: 10 };
  const est = Float64Array.from([1, 2, 3, 4]);
  const st = Uint8Array.from([STATUS.OK, STATUS.OK, STATUS.OK, STATUS.OK]);
  const sw = swath(est, st, { grid }, { axis: 'x' });
  assert.deepEqual([...sw.mean], [2, 3]);   // ix0: (1+3)/2 ; ix1: (2+4)/2
  assert.deepEqual([...sw.count], [2, 2]);
  assert.deepEqual([...sw.centers], [5, 15]);
});

test('backend seam — cpu default, realize + aggregations present, swappable', () => {
  assert.equal(getBackend().name, 'cpu');
  assert.equal(getBackend(), cpuBackend);
  for (const k of ['realize', 'stats', 'histogram', 'swath', 'gradeTonnage']) {
    assert.equal(typeof getBackend()[k], 'function', `cpu backend missing ${k}`);
  }
  const fake = { name: 'gpu-stub' };
  setBackend(fake);
  assert.equal(getBackend().name, 'gpu-stub');
  setBackend(null); // reset
  assert.equal(getBackend(), cpuBackend);
});

// End-to-end on the synthetic case: kriging → realize → aggregate, all CPU.
test('pipeline — kriging → realize → stats/GT (CPU, GPU-free)', () => {
  const r = kriging({ ...SYNTH, ktype: 'OK' });
  const est = realize(r, r.values);
  const s = stats(est, r.status);
  assert.ok(s.n >= 12 && s.mean > 1 && s.mean < 4, `stats off: ${JSON.stringify(s)}`);
  const gt = gradeTonnage(est, r.status, { cutoffs: [0, 2.5] });
  assert.ok(gt.tonnage[0] >= gt.tonnage[1], 'tonnage must be monotone in cutoff');
});

// ── targets + categories: mask / points / per-point dims, vs the oracle ──
test('mask — sparse run matches kt3d at active blocks only', () => {
  const ref = kt3d({ ...SYNTH, ktype: 'OK' });
  const { nx, ny, nz } = SYNTH.grid;
  const mask = new Array(nx * ny * nz).fill(false);
  for (let i = 0; i < mask.length; i++) if (i % nx < 2) mask[i] = true; // left half
  const r = kriging({ ...SYNTH, ktype: 'OK', mask });
  const realized = realize(r, r.values);
  assert.equal(r.n_targets, mask.filter(Boolean).length);
  let maxErr = 0, nOK = 0;
  for (let t = 0; t < r.n_targets; t++) {
    if (r.status[t] !== STATUS.OK) continue;
    nOK++;
    maxErr = Math.max(maxErr, Math.abs(realized[t] - ref.est[r.gridIndex[t]]));
  }
  assert.ok(nOK >= 6, `nOK ${nOK}`);
  assert.ok(maxErr < 1e-9, `mask maxErr ${maxErr}`);
});

function gridCentres(extra = []) {
  const { nx, ny, nz, xmn, ymn, zmn, xsiz, ysiz, zsiz } = SYNTH.grid;
  const pts = [];
  for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++)
    pts.push([xmn + ix * xsiz, ymn + iy * ysiz, zmn + iz * zsiz, ...extra]);
  return pts;
}
const PCFG = { data: SYNTH.data, variogram: SYNTH.variogram, search: SYNTH.search, ktype: 'OK' };

test('points — kriging at grid centres == kt3d (point, disc 1)', () => {
  const ref = kt3d({ ...SYNTH, ktype: 'OK' });
  const r = kriging({ ...PCFG, points: gridCentres() });
  const realized = realize(r, r.values);
  assert.equal(r.n_targets, ref.est.length);
  let maxErr = 0, nOK = 0;
  for (let t = 0; t < r.n_targets; t++) { if (r.status[t] !== STATUS.OK) continue; nOK++; maxErr = Math.max(maxErr, Math.abs(realized[t] - ref.est[t])); }
  assert.ok(nOK >= 12 && maxErr < 1e-9, `points nOK ${nOK} maxErr ${maxErr}`);
});

test('categories — auto-categorize; uniform per-point dims == kt3d', () => {
  const ref = kt3d({ ...SYNTH, ktype: 'OK' });
  const ru = kriging({ ...PCFG, points: gridCentres([10, 10, 10]) }); // uniform dims → 1 cat
  assert.equal(ru.n_categories, 1);
  const realized = realize(ru, ru.values);
  let maxErr = 0;
  for (let t = 0; t < ru.n_targets; t++) { if (ru.status[t] !== STATUS.OK) continue; maxErr = Math.max(maxErr, Math.abs(realized[t] - ref.est[t])); }
  assert.ok(maxErr < 1e-9, `uniform-dims maxErr ${maxErr}`);

  // mixed per-point dims → distinct categories, all estimates finite
  const rm = kriging({ ...PCFG, points: [[5, 5, 0, 10, 10, 10], [15, 5, 0, 20, 20, 10], [25, 25, 0, 10, 10, 10], [15, 25, 0, 5, 5, 5]] });
  assert.equal(rm.n_categories, 3); // (10,10,10),(20,20,10),(5,5,5)
  const rmz = realize(rm, rm.values);
  for (let t = 0; t < rm.n_targets; t++) if (rm.status[t] === STATUS.OK) assert.ok(Number.isFinite(rmz[t]), `target ${t} not finite`);
});

// ── recipe API: JSON round-trip + the executor (estimate → evaluate) ──
// SYNTH as host rows + the canonical compact vocab. The recipe layer adds NO
// numerical drift: run() must equal a hand-driven kriging()+realize() to f64.
const SROWS = SYNTH.data.map(([X, Y, Z, AU]) => ({ X, Y, Z, AU }));
const RVARIO = () => variogram([{ type: 'spherical', cc: 0.9, aa: 30 }], { c0: 0.1 });
const RSEARCH = () => search({ radius: 50, ndmin: 1, ndmax: 8 });
function baseRecipe(extra = {}) {
  return recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' }, source: 'synth.csv' },
    block_grid: { ...SYNTH.grid, discretization: [1, 1, 1] },
    default_model: ok({ variogram: RVARIO(), search: RSEARCH(), realization: none() }),
    output: { aggregations: [] },
    ...extra,
  });
}

test('recipe — builders emit compact GSLIB vocab; toJSON↔fromJSON round-trips', () => {
  const r = baseRecipe({ output: { distances: true, aggregations: [{ kind: 'stats' }, { kind: 'gradeTonnage', cutoffs: [0, 2.5] }] } });
  const j = r.toJSON();
  assert.equal(j.default_model.variogram.c0, 0.1);
  assert.deepEqual(j.default_model.variogram.structures[0].anis, [1, 1]);   // isotropic default
  assert.deepEqual(j.default_model.variogram.structures[0].ang, [0, 0, 0]);
  assert.equal(j.default_model.ktype, 'OK');
  assert.equal(j.output.distances, true);
  // round-trip is idempotent
  assert.deepEqual(fromJSON(j).toJSON(), j);
});

test('recipe — anis/ang translate to kriging rangeMinor/rangeVert/angles', () => {
  const r = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' } },
    block_grid: { ...SYNTH.grid },
    default_model: ok({
      variogram: variogram([{ type: 'spherical', cc: 1, aa: 100, anis: [0.5, 0.25], ang: [30, 10, 5] }]),
      search: search({ radius: 80, anis: [0.5, 0.25], ang: [30, 10, 5], ndmin: 1, ndmax: 8 }),
    }),
    output: {},
  });
  const s = r.toJSON().default_model.variogram.structures[0];
  assert.deepEqual(s.anis, [0.5, 0.25]);
  assert.deepEqual(s.ang, [30, 10, 5]);
});

test('recipe — run() == hand-driven kriging()+realize() to f64 (no drift)', () => {
  const r = baseRecipe();
  const res = run(r, { rows: SROWS });
  const tdir = kriging({ ...SYNTH, ktype: 'OK' });
  const edir = realize(tdir, tdir.values);
  let maxErr = 0, nOK = 0;
  for (let i = 0; i < res.estimates.length; i++) {
    if (res.status[i] !== STATUS.OK) continue;
    nOK++;
    maxErr = Math.max(maxErr, Math.abs(res.estimates[i] - edir[i]));
  }
  assert.ok(nOK >= 12, `only ${nOK} OK`);
  // recipe now runs on the JS krige() engine (faithful) vs the atra fork here —
  // both == kt3d, agreeing to machine eps (GE vs ktsol solver rounding).
  assert.ok(maxErr < 1e-9, `recipe drift ${maxErr}`);
});

test('recipe — evaluate() cap override re-realizes WITHOUT re-kriging (== direct topcut)', () => {
  const kr = estimate(baseRecipe(), { rows: SROWS });
  const capped = evaluate(kr, { _default: { transform: 'topcut', transform_params: { cap: 2.5 } } });
  const tdir = kriging({ ...SYNTH, ktype: 'OK' });
  const edir = realize(tdir, tdir.values, { transform: 'topcut', params: { cap: 2.5 } });
  let maxErr = 0;
  for (let i = 0; i < capped.estimates.length; i++) {
    if (capped.status[i] !== STATUS.OK) continue;
    maxErr = Math.max(maxErr, Math.abs(capped.estimates[i] - edir[i]));
  }
  assert.ok(maxErr < 1e-9, `cap re-realize drift ${maxErr}`);   // JS engine vs atra fork → machine eps
});

test('recipe — output.aggregations wired in run()', () => {
  const r = baseRecipe({
    output: {
      aggregations: [
        { kind: 'stats' },
        { kind: 'gradeTonnage', cutoffs: [0, 2.5] },
        { kind: 'swath', axis: 'x' },
        { kind: 'histogram', min: 0, max: 5, nbins: 5, name: 'h' },
      ],
    },
  });
  const res = run(r, { rows: SROWS });
  assert.ok(res.aggregations.stats.n >= 12);
  assert.ok(res.aggregations.gradeTonnage.tonnage[0] >= res.aggregations.gradeTonnage.tonnage[1]);
  assert.equal(res.aggregations.swath_x.mean.length, SYNTH.grid.nx);
  assert.equal(res.aggregations.h.counts.length, 5);
});

test('recipe — multi-domain: sift `where` selects samples, blockDomains selects blocks', () => {
  const { nx, ny, nz } = SYNTH.grid;
  const nxyz = nx * ny * nz;
  const blockDomains = new Array(nxyz);
  for (let iz = 0, idx = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++, idx++) blockDomains[idx] = ix < 2 ? 'HG' : 'LG';
  const rows = SROWS.map((rr, i) => ({ ...rr, D: i % 2 === 0 ? 'HG' : 'LG' }));
  const r = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU', domain: 'D' } },
    block_grid: { ...SYNTH.grid },
    domains: [
      { id: 'HG', where: "D == 'HG'", model: ok({ variogram: RVARIO(), search: RSEARCH() }) },
      { id: 'LG', where: "D == 'LG'", model: ok({ variogram: RVARIO(), search: RSEARCH() }) },
    ],
    output: { aggregations: [{ kind: 'stats' }] },
  });
  // `where` strings serialize to sift specs and round-trip
  const j = r.toJSON();
  assert.equal(j.domains[0].where.form, 'spec');
  assert.deepEqual(fromJSON(j).toJSON(), j);

  const res = run(r, { rows, blockDomains });
  assert.equal(res.domains.map((d) => d.id).join(','), 'HG,LG');
  const nOK = [...res.status].filter((s) => s === STATUS.OK).length;
  assert.ok(nOK >= 12, `multi-domain OK ${nOK}`);
  assert.equal(res.aggregations.stats.n, nOK);
});

test('recipe — domains[] requires ctx.blockDomains', () => {
  const r = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU', domain: 'D' } },
    block_grid: { ...SYNTH.grid },
    domains: [{ id: 'A', where: "D == 'A'", model: ok({ variogram: RVARIO(), search: RSEARCH() }) }],
    output: {},
  });
  assert.throws(() => run(r, { rows: SROWS }), /blockDomains/);
});

test('recipe — construction-time validation throws on bad models', () => {
  const good = { variogram: RVARIO(), search: RSEARCH() };
  // ndmax < ndmin
  assert.throws(() => baseRecipe({ default_model: ok({ variogram: RVARIO(), search: search({ radius: 50, ndmin: 8, ndmax: 2 }) }) }), /ndmax ≥ ndmin/);
  // negative range
  assert.throws(() => variogram([{ type: 'spherical', cc: 1, aa: -5 }]) && baseRecipe({ default_model: ok({ variogram: variogram([{ type: 'spherical', cc: 1, aa: -5 }]), search: RSEARCH() }) }), /range aa must be > 0/);
  // SK without numeric mean
  assert.throws(() => baseRecipe({ default_model: sk({ ...good, sk_mean: 'oops' }) }), /SK needs a numeric sk_mean/);
  // topcut without cap
  assert.throws(() => baseRecipe({ default_model: ok({ ...good, realization: { transform: 'topcut', transform_params: {} } }) }), /topcut needs cap/);
  // unknown aggregation
  assert.throws(() => baseRecipe({ output: { aggregations: [{ kind: 'bogus' }] } }), /unknown aggregation/);
});

test('recipe — SK scalar mean run() == kt3d SK', () => {
  const r = baseRecipe({ default_model: sk({ variogram: RVARIO(), search: RSEARCH(), sk_mean: 2.5 }) });
  const res = run(r, { rows: SROWS });
  const ref = kt3d({ ...SYNTH, ktype: 'SK', skmean: 2.5 });
  let maxErr = 0;
  for (let i = 0; i < res.estimates.length; i++) {
    if (res.status[i] !== STATUS.OK || ref.est[i] === -999) continue;
    maxErr = Math.max(maxErr, Math.abs(res.estimates[i] - ref.est[i]));
  }
  assert.ok(maxErr < 1e-9, `SK recipe drift ${maxErr}`);
});

test('recipe — hgr builder picks hard/soft; SK_LVM builds but run() rejects', () => {
  assert.equal(hgr({ cap: 30, d_thresh: 50, grade_thresh: 12 }).transform, 'hgr_hard');
  assert.equal(hgr({ cap: 30, d_max: 100, grade_thresh: 12 }).transform, 'hgr_soft');
  // SK_LVM is artifact-complete but not executable yet (kriging() has no ktype 2)
  const r = baseRecipe({ default_model: sk_lvm({ variogram: RVARIO(), search: RSEARCH(), sk_mean: 'MEAN' }) });
  assert.throws(() => run(r, { rows: SROWS }), /SK_LVM/);
});

test('recipe — function `where` works in-memory but refuses to serialize', () => {
  const { nx, ny, nz } = SYNTH.grid;
  const blockDomains = new Array(nx * ny * nz).fill('A');
  const r = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' } },
    block_grid: { ...SYNTH.grid },
    domains: [{ id: 'A', where: (row) => row.AU != null, model: ok({ variogram: RVARIO(), search: RSEARCH() }) }],
    output: {},
  });
  const res = run(r, { rows: SROWS, blockDomains });   // runs fine in memory
  assert.ok([...res.status].filter((s) => s === STATUS.OK).length >= 12);
  assert.throws(() => r.toJSON(), /can't be serialized/);  // but the artifact refuses it
});

// ── M3a: the search neighbourhood (moving ellipsoid, kd-tree backend) ──
// SPEC-neigh §4. The gate: select() is bit-identical to a brute-force ellipsoid
// scan (clustered data, ties, anisotropy, rotation). Plus a faithfulness check —
// the JS setrot/sqdist port matches gslib's frozen wasm originals.

function rng32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// brute-force reference: every sample inside the ellipsoid, distance-sorted, tie-
// broken by original index, then the SAME selection policies (ndmax cap, sector
// cap, per-hole cap, min separation) implemented independently by a full scan.
// Uses select()'s metric (sqdist/rotmat) but its own algorithm — bit-identity is
// the contract.
function bruteSelect(samples, target, nbhd) {
  const R = nbhd.rotmat, r2 = nbhd.radius * nbhd.radius, bh = nbhd._benchHalf, cand = [];
  for (let i = 0; i < samples.length; i++) {
    if (bh > 0 && Math.abs(samples[i][2] - target[2]) > bh) continue;   // bench band
    const d2 = sqdist(target[0], target[1], target[2], samples[i][0], samples[i][1], samples[i][2], R);
    if (d2 <= r2) cand.push({ i, d2 });
  }
  cand.sort((a, b) => (a.d2 - b.d2) || (a.i - b.i));
  const S = nbhd.sectors, phm = nbhd.perHoleMax, msd = nbhd.minSampleDistance, Rp = nbhd._rotPure;
  if (!S && phm == null && !(msd > 0)) return cand.slice(0, nbhd.ndmax).map((c) => c.i);
  const per = S ? new Int32Array(S.count) : null, perHole = phm != null ? new Map() : null;
  const ms2 = msd > 0 ? msd * msd : 0, keep = [];
  for (let k = 0; k < cand.length && keep.length < nbhd.ndmax; k++) {
    const c = cand[k], i = c.i, dx = samples[i][0] - target[0], dy = samples[i][1] - target[1], dz = samples[i][2] - target[2];
    let w = -1;
    if (S) {
      const x = Rp[0] * dx + Rp[1] * dy + Rp[2] * dz, y = Rp[3] * dx + Rp[4] * dy + Rp[5] * dz;
      let az = Math.atan2(y, x); if (az < 0) az += 2 * Math.PI;
      w = Math.floor(az / (2 * Math.PI / S.n)); if (w >= S.n) w = S.n - 1;
      if (S.hemispheres) { const z = Rp[6] * dx + Rp[7] * dy + Rp[8] * dz; if (z < 0) w += S.n; }
      if (per[w] >= S.maxPer) continue;
    }
    let hid;
    if (perHole) { hid = nbhd._holeId[i]; if ((perHole.get(hid) || 0) >= phm) continue; }
    if (ms2 > 0) {
      let close = false;
      for (const j of keep) { const ex = samples[i][0] - samples[j][0], ey = samples[i][1] - samples[j][1], ez = samples[i][2] - samples[j][2]; if (ex * ex + ey * ey + ez * ez < ms2) { close = true; break; } }
      if (close) continue;
    }
    if (S) per[w]++;
    if (perHole) perHole.set(hid, (perHole.get(hid) || 0) + 1);
    keep.push(i);
  }
  return keep;
}

test('neigh — JS setrot/sqdist match gslib wasm (faithful port)', () => {
  const mem = new WebAssembly.Memory({ initial: 4 });
  const lib = gslibInstantiate({ memory: mem });
  const st = { off: 65536 };
  const pRot = gAlloc(st, 9);
  gGrow(mem, st.off);
  for (const [a1, a2, a3, an1, an2] of [[30, 0, 0, 0.5, 0.3], [120, 20, 10, 0.7, 0.4], [0, 0, 0, 1, 1], [255, -15, 5, 0.6, 0.9]]) {
    lib.gslib.setrot(a1, a2, a3, an1, an2, 0, pRot);
    const wasmRot = gReadF64(mem, pRot, 9);
    // FAITHFUL mode (GSLIB_PI) is BIT-IDENTICAL: atra's sin/cos ARE JS Math imports,
    // and faithful uses gslib's exact truncated-pi literal, so the matrices agree to
    // f64 ULP. (The earlier ~1e-10 gap was Math.PI vs gslib's pi, not trig precision.)
    const jsRot = setrot(a1, a2, a3, an1, an2, GSLIB_PI);
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(wasmRot[i] - jsRot[i]) < 1e-15, `rot[${i}] ${wasmRot[i]} vs ${jsRot[i]}`);
    // The ACCURATE default (Math.PI) genuinely diverges from the oracle — so the
    // faithful flag is doing real work (and gsjs's default is the better π).
    const accRot = setrot(a1, a2, a3, an1, an2);
    if (a1 % 90 !== 0 || a2 !== 0 || a3 !== 0) {  // skip cases where the π factor cancels
      let maxDiff = 0; for (let i = 0; i < 9; i++) maxDiff = Math.max(maxDiff, Math.abs(wasmRot[i] - accRot[i]));
      assert.ok(maxDiff > 1e-12, `accurate π should differ from gslib oracle (got ${maxDiff})`);
    }
    for (const [x1, y1, z1, x2, y2, z2] of [[10, 20, 0, 35, 12, 5], [0, 0, 0, 100, 50, 20], [-5, 8, 3, 40, -10, 12]]) {
      const wasmD = lib.gslib.sqdist(x1, y1, z1, x2, y2, z2, 0, pRot);
      const jsD = sqdist(x1, y1, z1, x2, y2, z2, jsRot);
      // bit-identical rotmat (above) + identical formula → agree to f64 ULP.
      assert.ok(Math.abs(wasmD - jsD) <= 1e-9 * Math.abs(wasmD) + 1e-12, `sqdist ${wasmD} vs ${jsD}`);
    }
  }
});

test('neigh — select() is bit-identical to a brute-force ellipsoid scan', () => {
  const rng = rng32(99);
  // clustered samples + a regular grid (the grid forces exact-distance TIES, so
  // the deterministic tie-break is genuinely exercised).
  const samples = [];
  for (let c = 0; c < 5; c++) { const cx = rng() * 500, cy = rng() * 500; for (let k = 0; k < 14; k++) samples.push([cx + (rng() - 0.5) * 60, cy + (rng() - 0.5) * 60, 0]); }
  for (let gx = 50; gx <= 450; gx += 50) for (let gy = 50; gy <= 450; gy += 50) samples.push([gx, gy, 0]);

  const configs = [
    { radius: 120 },                                                        // isotropic
    { radius: 160, radiusMinor: 70, radiusVert: 999, angle: 30 },           // anisotropic + rotated (2D)
    { radius: 200, radiusMinor: 90, radiusVert: 140, angle: 115, angle2: 20, angle3: 10 }, // full 3D
    { radius: 160, sectors: { n: 4, maxPer: 3 } },                          // sectors
    { radius: 200, radiusMinor: 90, angle: 30, sectors: { n: 6, maxPer: 2 } }, // sectors + anisotropy + rotation
  ];
  let checks = 0;
  for (const cfg of configs) {
    for (const ndmax of [4, 12, 1e9]) {
      const nb = createNeighborhood({ ...cfg, ndmin: 1, ndmax });
      indexSamples(nb, samples);
      for (let t = 0; t < 60; t++) {
        const target = [rng() * 500, rng() * 500, 0];
        const got = [...select(nb, target).ranks];
        const exp = bruteSelect(samples, target, nb);
        assert.deepEqual(got, exp, `cfg ${JSON.stringify(cfg)} ndmax ${ndmax} target ${target}`);
        checks++;
      }
      // targets sitting EXACTLY on grid samples → maximal ties
      for (let gx = 100; gx <= 400; gx += 100) {
        const got = [...select(nb, [gx, gx, 0]).ranks];
        const exp = bruteSelect(samples, [gx, gx, 0], nb);
        assert.deepEqual(got, exp, `tie target ${gx}`);
        checks++;
      }
    }
  }
  assert.ok(checks > 800, `only ${checks} comparisons`);
});

test('neigh — ndmin status + ndmax cap + tie-break order', () => {
  const samples = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [100, 100, 0]];
  const nb = createNeighborhood({ radius: 30, ndmin: 2, ndmax: 2 });
  indexSamples(nb, samples);
  const s = select(nb, [0, 0, 0]);
  assert.equal(s.n, 2);                       // 3 inside radius, capped to ndmax
  assert.equal(s.status, STATUS.OK);
  assert.deepEqual([...s.ranks], [0, 1]);      // self (d=0), then [10,0,0]/[0,10,0] tie → lower index
  const far = select(nb, [100, 100, 0]);
  assert.equal(far.status, STATUS.INSUFFICIENT_DATA);  // only 1 inside, < ndmin
  assert.equal(far.n, 1);
});

test('neigh — anisotropic ellipsoid actually excludes (vs isotropic)', () => {
  const samples = [[0, 0, 0], [80, 0, 0], [0, 80, 0]];   // E and N at equal range
  indexSamples(createNeighborhood({ radius: 100, ndmin: 1, ndmax: 9 }), samples);
  const iso = select(indexSamples(createNeighborhood({ radius: 100 }), samples), [0, 0, 0]);
  assert.equal(iso.n, 3);                                 // isotropic: both reached
  // major axis E-W (angle 90 → azimuth East), minor N-S squeezed to 0.5 → N sample at 80 is out
  const an = createNeighborhood({ radius: 100, radiusMinor: 50, angle: 90, ndmin: 1, ndmax: 9 });
  indexSamples(an, samples);
  const r = select(an, [0, 0, 0]);
  assert.ok(r.n === 2 && [...r.ranks].includes(1) && ![...r.ranks].includes(2), `expected E kept, N dropped; got ${[...r.ranks]}`);
});

test('neigh — faithful flag threads gslib π; default is accurate (modern)', () => {
  const args = [35, 0, 0, 0.5, 1.0];  // angle 35, anis1=50/100, anis2=100/100
  const faithful = createNeighborhood({ radius: 100, radiusMinor: 50, angle: 35, faithful: true });
  const modern = createNeighborhood({ radius: 100, radiusMinor: 50, angle: 35 });
  assert.deepEqual([...faithful.rotmat], [...setrot(...args, GSLIB_PI)]);   // oracle-parity π
  assert.deepEqual([...modern.rotmat], [...setrot(...args)]);                // accurate default (Math.PI)
  assert.notDeepEqual([...modern.rotmat], [...faithful.rotmat]);             // the flag does real work
});

test('neigh — sectors decluster (cap per sector) + minFilled gates status', () => {
  // a dominant 5-point cluster in one direction + 3 isolated samples elsewhere.
  // (Exact sector membership depends on gslib's azimuth-from-North frame, so this
  // checks POLICY EFFECTS + cross-checks the validated brute-force, not hand-
  // computed sector indices.)
  const samples = [
    [30, 2, 0], [32, -1, 0], [34, 3, 0], [36, -2, 0], [38, 1, 0],  // dense cluster (idx 0–4)
    [2, 40, 0], [-40, 5, 0], [5, -38, 0],                          // isolated (idx 5–7)
  ];
  const base = createNeighborhood({ radius: 100, ndmin: 1, ndmax: 99 });
  indexSamples(base, samples);
  assert.equal(select(base, [0, 0, 0]).n, 8);            // all 8 within radius, no sectors

  const sec = createNeighborhood({ radius: 100, ndmin: 1, ndmax: 99, sectors: { n: 4, maxPer: 2 } });
  indexSamples(sec, samples);
  const r = select(sec, [0, 0, 0]);
  assert.deepEqual([...r.ranks], bruteSelect(samples, [0, 0, 0], sec));  // exact == validated reference
  assert.ok(r.n < 8, `sectors should decluster (got ${r.n})`);
  assert.equal(typeof r.filled, 'number');
  // the 5-cluster spans at most 2 sectors → contributes ≤ 2 × maxPer
  const fromCluster = [...r.ranks].filter((i) => i < 5).length;
  assert.ok(fromCluster <= 4, `cluster contributed ${fromCluster}, expected ≤ 2 sectors × maxPer`);

  // minFilled gate: demand more filled sectors than the geometry can provide → INSUFFICIENT
  const strict = createNeighborhood({ radius: 100, ndmin: 1, ndmax: 99, sectors: { n: 8, maxPer: 2, minFilled: 8 } });
  indexSamples(strict, samples);
  assert.equal(select(strict, [0, 0, 0]).status, STATUS.INSUFFICIENT_DATA);
  // minPer raises the bar for "filled": with minPer 2, single-sample sectors don't count
  const mp = createNeighborhood({ radius: 100, ndmin: 1, ndmax: 99, sectors: { n: 8, maxPer: 3, minPer: 2, minFilled: 3 } });
  indexSamples(mp, samples);
  const rmp = select(mp, [0, 0, 0]);
  assert.ok(rmp.filled < 3 && rmp.status === STATUS.INSUFFICIENT_DATA, `filled ${rmp.filled}`);
});

// ── orientation conventions (orient.js) ──
// The canonical form is the orthonormal rotation matrix (rows = major/semi-major/
// minor axes in world coords; X=East, Y=North, Z=up). Leapfrog is validated against
// hand-derived structural geometry; the gslib convention must equal the legacy path.

const vclose = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const dot3 = (m, i, j) => m[i * 3] * m[j * 3] + m[i * 3 + 1] * m[j * 3 + 1] + m[i * 3 + 2] * m[j * 3 + 2];

test('orient — leapfrog axes match hand-derived structural geometry', () => {
  const S = Math.SQRT1_2;
  // dip 45° toward East (dipAz 90), pitch 0 → major along strike. RHR strike for
  // dipAz 90 is North; down-dip is East-and-down.
  let R = leapfrogToRotmat({ dipAzimuth: 90, dip: 45, pitch: 0 });
  assert.ok(vclose(R.slice(0, 3), [0, 1, 0]), `major ${R.slice(0, 3)}`);      // North (strike)
  assert.ok(vclose(R.slice(3, 6), [S, 0, -S]), `semimaj ${R.slice(3, 6)}`);   // down-dip
  // pitch 90 → major swings to down-dip
  R = leapfrogToRotmat({ dipAzimuth: 90, dip: 45, pitch: 90 });
  assert.ok(vclose(R.slice(0, 3), [S, 0, -S]), `major@90 ${R.slice(0, 3)}`);
  // dip 30° toward North (dipAz 0), pitch 0 → major along strike = West (RHR)
  R = leapfrogToRotmat({ dipAzimuth: 0, dip: 30, pitch: 0 });
  assert.ok(vclose(R.slice(0, 3), [-1, 0, 0]), `major ${R.slice(0, 3)}`);     // West
  assert.ok(vclose(R.slice(3, 6), [0, Math.cos(Math.PI / 6), -0.5]), `semimaj ${R.slice(3, 6)}`); // down-dip N+down
});

test('orient — leapfrog R is orthonormal + a proper rotation (det +1)', () => {
  for (const p of [{ dip: 0, dipAzimuth: 0, pitch: 0 }, { dip: 60, dipAzimuth: 215, pitch: 35 }, { dip: 90, dipAzimuth: 130, pitch: 70 }]) {
    const R = leapfrogToRotmat(p);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(dot3(R, i, i) - 1) < 1e-12, `row ${i} not unit`);
    assert.ok(Math.abs(dot3(R, 0, 1)) < 1e-12 && Math.abs(dot3(R, 0, 2)) < 1e-12 && Math.abs(dot3(R, 1, 2)) < 1e-12, 'rows not orthogonal');
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    assert.ok(Math.abs(det - 1) < 1e-12, `det ${det}`);
  }
});

test('orient — gslib convention == legacy angle path (no regression)', () => {
  const legacy = createNeighborhood({ radius: 160, radiusMinor: 70, radiusVert: 120, angle: 30, angle2: 12, angle3: 5 });
  const named = createNeighborhood({ radius: 160, radiusMinor: 70, radiusVert: 120, convention: 'gslib', azimuth: 30, dip: 12, rake: 5 });
  assert.deepEqual([...named.rotmat], [...legacy.rotmat]);
  assert.deepEqual([...named._rotPure], [...legacy._rotPure]);
  // and the pure path equals setrot with anis folded in by applyAnis
  assert.deepEqual([...legacy.rotmat], [...applyAnis(setrot(30, 12, 5, 1, 1), 70 / 160, 120 / 160)]);
  // toRotmat('gslib') is just setrot at anis=1
  assert.deepEqual([...toRotmat('gslib', { azimuth: 30, dip: 12, rake: 5 })], [...setrot(30, 12, 5, 1, 1)]);
});

test('neigh — leapfrog convention runs + applies anisotropy on the right axis', () => {
  // shallow N-S elongation: dip 0 (horizontal), pitch 0 → major along strike (W);
  // make the strike axis long and the perpendicular short, confirm the ellipsoid
  // excludes the across-strike sample.
  const samples = [[0, 0, 0], [80, 0, 0], [0, 80, 0]];   // origin, E, N
  // dipAz 0 dip 0 → strike (major) = W/E line; radiusMinor squeezes the N-S (semimajor)
  const nb = createNeighborhood({ convention: 'leapfrog', dip: 0, dipAzimuth: 0, pitch: 0, radius: 100, radiusMinor: 50, ndmin: 1, ndmax: 9 });
  indexSamples(nb, samples);
  const r = select(nb, [0, 0, 0]);
  // major axis is E-W (strike), so the E sample (idx 1, along major, range 100) is in;
  // the N sample (idx 2, along the squeezed semi-major, range 50) is out at distance 80.
  assert.ok([...r.ranks].includes(1) && ![...r.ranks].includes(2), `expected E kept / N dropped; got ${[...r.ranks]}`);
});

// ── M3b: per-hole cap + min-distance thinning (post-gather selection policies) ──

test('neigh — per-hole + min-distance are bit-identical to brute-force', () => {
  const rng = rng32(7);
  const samples = [], holeId = [];
  for (let h = 0; h < 12; h++) {                    // 12 drillholes × 6 samples down-hole
    const hx = rng() * 500, hy = rng() * 500;
    for (let k = 0; k < 6; k++) { samples.push([hx + (rng() - 0.5) * 8, hy + (rng() - 0.5) * 8, k * 10]); holeId.push(h); }
  }
  const configs = [
    { radius: 200, perHoleMax: 2 },
    { radius: 200, minSampleDistance: 15 },
    { radius: 200, perHoleMax: 3, minSampleDistance: 12 },
    { radius: 220, radiusVert: 60, angle: 40, perHoleMax: 2, minSampleDistance: 10, sectors: { n: 4, maxPer: 3 } }, // all policies at once
  ];
  let checks = 0;
  for (const cfg of configs) {
    for (const ndmax of [6, 20, 1e9]) {
      const nb = createNeighborhood({ ...cfg, ndmin: 1, ndmax });
      indexSamples(nb, samples, null, { holeId });
      for (let t = 0; t < 50; t++) {
        const target = [rng() * 500, rng() * 500, rng() * 60];
        assert.deepEqual([...select(nb, target).ranks], bruteSelect(samples, target, nb), `cfg ${JSON.stringify(cfg)} ndmax ${ndmax}`);
        checks++;
      }
    }
  }
  assert.ok(checks > 500, `only ${checks}`);
});

test('neigh — per-hole cap limits samples per drillhole', () => {
  const samples = [
    [10, 0, 0], [11, 0, 5], [12, 0, 10], [13, 0, 15],      // hole A (idx 0–3)
    [-10, 5, 0], [-11, 5, 5], [-12, 5, 10], [-13, 5, 15],  // hole B (idx 4–7)
  ];
  const holeId = [0, 0, 0, 0, 1, 1, 1, 1];
  const nb = createNeighborhood({ radius: 100, ndmin: 1, ndmax: 99, perHoleMax: 2 });
  indexSamples(nb, samples, null, { holeId });
  const r = select(nb, [0, 0, 0]);
  assert.equal(r.n, 4);                                    // 2 per hole × 2 holes
  assert.equal([...r.ranks].filter((i) => i < 4).length, 2);
  assert.equal([...r.ranks].filter((i) => i >= 4).length, 2);
});

test('neigh — perHoleMax without a bound holeId throws', () => {
  const nb = createNeighborhood({ radius: 100, perHoleMax: 2 });
  indexSamples(nb, [[0, 0, 0], [10, 0, 0]]);
  assert.throws(() => select(nb, [0, 0, 0]), /holeId/);
});

test('neigh — min-distance thins near-duplicate samples', () => {
  const samples = [
    [20, 0, 0], [21, 0, 0], [22, 0, 0], [20, 1, 0],        // tight cluster (idx 0–3)
    [-50, 0, 0], [0, 60, 0],                               // well separated (idx 4,5)
  ];
  const nb = createNeighborhood({ radius: 100, ndmin: 1, ndmax: 99, minSampleDistance: 5 });
  indexSamples(nb, samples);
  const r = select(nb, [0, 0, 0]);
  assert.equal(r.n, 3);                                    // cluster → 1 (nearest) + 2 separated
  assert.equal([...r.ranks].filter((i) => i < 4).length, 1);
  assert.ok([...r.ranks].includes(4) && [...r.ranks].includes(5));
});

// ── M3b: bench (2.5D) neighbourhood — vertical band + 2D horizontal ellipse ──

test('neigh — bench restricts to the vertical band + searches in 2D', () => {
  // 3 benches at z = 0/10/20; 5 samples each. Target on z=0, bench 6m thick.
  const samples = [];
  for (const z of [0, 10, 20]) for (const [x, y] of [[20, 0], [0, 20], [-20, 0], [0, -20], [15, 15]]) samples.push([x, y, z]);
  const nb = createNeighborhood({ type: 'bench', benchThickness: 6, radius: 50, ndmin: 1, ndmax: 99 });
  indexSamples(nb, samples);
  const r = select(nb, [0, 0, 0]);
  assert.equal(r.n, 5);                                   // only the z=0 bench
  assert.ok([...r.ranks].every((i) => samples[i][2] === 0), `off-bench leaked: ${[...r.ranks].map((i) => samples[i][2])}`);
  // z ignored in distance: a sample directly above (huge Δz) but horizontally
  // identical would be excluded by the band, not counted as "near".
  const mv = createNeighborhood({ radius: 50, ndmin: 1, ndmax: 99 });   // 3D contrast
  indexSamples(mv, samples);
  assert.ok(select(mv, [0, 0, 0]).n > r.n, 'moving 3D should reach other benches');
});

test('neigh — bench is bit-identical to brute-force (band + 2D + policies)', () => {
  const rng = rng32(31);
  const samples = [], holeId = [];
  for (let h = 0; h < 14; h++) {
    const hx = rng() * 400, hy = rng() * 400;
    for (let k = 0; k < 8; k++) { samples.push([hx + (rng() - 0.5) * 30, hy + (rng() - 0.5) * 30, k * 5]); holeId.push(h); }
  }
  const configs = [
    { type: 'bench', benchThickness: 8, radius: 120 },
    { type: 'bench', benchThickness: 12, radius: 150, radiusMinor: 70, azimuth: 35 },          // 2D anisotropy + rotation
    { type: 'bench', benchThickness: 10, radius: 140, perHoleMax: 2, sectors: { n: 4, maxPer: 2 } }, // + policies
  ];
  let checks = 0;
  for (const cfg of configs) {
    for (const ndmax of [5, 1e9]) {
      const nb = createNeighborhood({ ...cfg, ndmin: 1, ndmax });
      indexSamples(nb, samples, null, { holeId });
      for (let t = 0; t < 60; t++) {
        const target = [rng() * 400, rng() * 400, rng() * 35];
        assert.deepEqual([...select(nb, target).ranks], bruteSelect(samples, target, nb), `cfg ${JSON.stringify(cfg)} ndmax ${ndmax}`);
        checks++;
      }
    }
  }
  assert.ok(checks > 300, `only ${checks}`);
});

test('neigh — bench needs benchThickness > 0', () => {
  assert.throws(() => createNeighborhood({ type: 'bench', radius: 50 }), /benchThickness/);
});

// ── M3c: the pure-JS kriging driver fed by the neighbourhood ──
// The keystone: select() picks samples, krige() builds + solves the system in JS,
// realize() turns it into estimates. Validated == gslib.kt3d (the frozen oracle).

test('krige — JS driver == gslib.kt3d to f64 (OK + SK), neighbourhood-fed', () => {
  for (const ktype of ['OK', 'SK']) {
    const ref = kt3d({ ...SYNTH, ktype, skmean: 2.5 });
    const r = krige({ ...SYNTH, ktype, skmean: 2.5, faithful: true });   // faithful → matches gslib's π
    const est = realize(r, r.values);
    let maxErr = 0, maxKv = 0, nOK = 0;
    for (let i = 0; i < r.n_blocks; i++) {
      if (r.status[i] !== STATUS.OK || ref.est[i] === -999) continue;
      nOK++;
      maxErr = Math.max(maxErr, Math.abs(est[i] - ref.est[i]));
      maxKv = Math.max(maxKv, Math.abs(r.kv[i] - ref.var[i]));
    }
    assert.ok(nOK >= 12, `${ktype} only ${nOK} OK`);
    assert.ok(maxErr < 1e-9, `${ktype} est err ${maxErr}`);
    assert.ok(maxKv < 1e-9, `${ktype} kv err ${maxKv}`);
  }
});

test('krige — the neighbourhood drives the estimate (ndmax + conventions)', () => {
  // restricting ndmax feeds the solve fewer samples → a different (still valid) estimate
  const full = krige({ ...SYNTH, ktype: 'OK', points: [[15, 15, 0]] });
  const restricted = krige({ ...SYNTH, ktype: 'OK', search: { ...SYNTH.search, ndmax: 3 }, points: [[15, 15, 0]] });
  const ef = realize(full, full.values)[0], er = realize(restricted, restricted.values)[0];
  assert.ok(Number.isFinite(ef) && Number.isFinite(er));
  assert.ok(full.n_actual[0] > 3 && restricted.n_actual[0] <= 3, `na ${full.n_actual[0]} vs ${restricted.n_actual[0]}`);
  assert.notEqual(ef, er);
  // a leapfrog-convention search runs end-to-end and yields a finite OK estimate
  const lf = krige({ ...SYNTH, ktype: 'OK', points: [[15, 15, 0]], search: { radius: 50, ndmin: 1, ndmax: 8, convention: 'leapfrog', dip: 20, dipAzimuth: 60, pitch: 0 } });
  assert.equal(lf.status[0], STATUS.OK);
  assert.ok(Number.isFinite(realize(lf, lf.values)[0]));
});

test('krige — exact interpolator: estimate at a data location returns its value', () => {
  const r = krige({ ...SYNTH, ktype: 'OK', points: [[20, 20, 0]] });  // == sample idx 4 (value 2.8)
  assert.ok(Math.abs(realize(r, r.values)[0] - 2.8) < 1e-9);
  assert.ok(Math.abs(r.kv[0]) < 1e-9);                                 // zero kriging variance at data
});

test('krige — insufficient data → status, no weights', () => {
  const r = krige({ ...SYNTH, ktype: 'OK', search: { radius: 1, ndmin: 2, ndmax: 8 }, points: [[100, 100, 0]] });
  assert.equal(r.status[0], STATUS.INSUFFICIENT_DATA);
  assert.equal(r.n_actual[0], 0);
});

test('krige — block kriging (discretized) == gslib.kt3d est + var to f64', () => {
  for (const dsc of [{ nx: 3, ny: 3, nz: 1 }, { nx: 4, ny: 4, nz: 2 }, { nx: 5, ny: 5, nz: 1 }]) {
    for (const ktype of ['OK', 'SK']) {
      const ref = kt3d({ ...SYNTH, ktype, skmean: 2.5, discretization: dsc });
      const r = krige({ ...SYNTH, ktype, skmean: 2.5, faithful: true, discretization: dsc });
      const est = realize(r, r.values);
      let maxErr = 0, maxKv = 0, nOK = 0;
      for (let i = 0; i < r.n_blocks; i++) {
        if (r.status[i] !== STATUS.OK || ref.est[i] === -999) continue;
        nOK++;
        maxErr = Math.max(maxErr, Math.abs(est[i] - ref.est[i]));
        maxKv = Math.max(maxKv, Math.abs(r.kv[i] - ref.var[i]));
      }
      assert.ok(nOK >= 12, `disc ${JSON.stringify(dsc)} ${ktype} only ${nOK}`);
      assert.ok(maxErr < 1e-9, `disc ${JSON.stringify(dsc)} ${ktype} est ${maxErr}`);
      assert.ok(maxKv < 1e-9, `disc ${JSON.stringify(dsc)} ${ktype} kv ${maxKv}`);
    }
  }
  // block variance < point variance (block support reduces uncertainty)
  const pt = krige({ ...SYNTH, ktype: 'OK', faithful: true });
  const blk = krige({ ...SYNTH, ktype: 'OK', faithful: true, discretization: { nx: 4, ny: 4, nz: 1 } });
  assert.ok(blk.kv[5] < pt.kv[5], `block kv ${blk.kv[5]} should be < point kv ${pt.kv[5]}`);
});

test('krige — mask (sparse domain) == kt3d at active blocks; categories', () => {
  // sparse mask (left half) → only active blocks kriged, mapped back via gridIndex
  const ref = kt3d({ ...SYNTH, ktype: 'OK', discretization: { nx: 3, ny: 3, nz: 1 } });
  const { nx, ny, nz } = SYNTH.grid;
  const mask = new Array(nx * ny * nz).fill(false);
  for (let i = 0; i < mask.length; i++) if (i % nx < 2) mask[i] = true;
  const rm = krige({ ...SYNTH, ktype: 'OK', faithful: true, discretization: { nx: 3, ny: 3, nz: 1 }, mask });
  const em = realize(rm, rm.values);
  assert.equal(rm.n_targets, mask.filter(Boolean).length);
  let maxErr = 0, nOK = 0;
  for (let t = 0; t < rm.n_targets; t++) { if (rm.status[t] !== STATUS.OK) continue; nOK++; maxErr = Math.max(maxErr, Math.abs(em[t] - ref.est[rm.gridIndex[t]])); }
  assert.ok(nOK >= 6 && maxErr < 1e-9, `mask nOK ${nOK} maxErr ${maxErr}`);

  // per-point dims → categories. uniform dims = 1 category, matches the block grid.
  const centres = [];
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) centres.push([5 + ix * 10, 5 + iy * 10, 0, 10, 10, 10]);
  const rc = krige({ data: SYNTH.data, variogram: SYNTH.variogram, search: SYNTH.search, ktype: 'OK', faithful: true, discretization: { nx: 3, ny: 3, nz: 1 }, points: centres });
  assert.equal(rc.n_categories, 1);
  const ec = realize(rc, rc.values);
  let maxErr2 = 0;
  for (let t = 0; t < rc.n_targets; t++) if (rc.status[t] === STATUS.OK) maxErr2 = Math.max(maxErr2, Math.abs(ec[t] - ref.est[t]));
  assert.ok(maxErr2 < 1e-9, `uniform-cat maxErr ${maxErr2}`);

  // mixed per-point dims → distinct categories, all estimates finite
  const rmix = krige({ data: SYNTH.data, variogram: SYNTH.variogram, search: SYNTH.search, ktype: 'OK', discretization: { nx: 2, ny: 2, nz: 1 }, points: [[15, 15, 0, 10, 10, 10], [25, 25, 0, 20, 20, 10], [10, 30, 0, 5, 5, 5]] });
  assert.equal(rmix.n_categories, 3);
  assert.ok([...realize(rmix, rmix.values)].every(Number.isFinite));
});

test('recipe — neighbourhood policies (sectors) serialize + drive the JS engine', () => {
  const r = baseRecipe({
    default_model: ok({ variogram: RVARIO(), search: search({ radius: 50, ndmin: 1, ndmax: 8, sectors: { n: 4, maxPer: 3 } }) }),
  });
  assert.deepEqual(r.toJSON().default_model.search.sectors, { n: 4, maxPer: 3 });   // in the artifact
  assert.deepEqual(fromJSON(r.toJSON()).toJSON(), r.toJSON());                       // round-trips
  const res = run(r, { rows: SROWS });
  const nOK = [...res.status].filter((s) => s === STATUS.OK).length;
  assert.ok(nOK >= 12, `sectors recipe nOK ${nOK}`);                                 // runs end-to-end
});

test('recipe — per-hole cap (dh_id) + bench flow through to the engine', () => {
  const rows = SROWS.map((r, i) => ({ ...r, BHID: i % 3 }));     // group samples into 3 holes
  const r = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU', dh_id: 'BHID' } },
    block_grid: { ...SYNTH.grid },
    default_model: ok({ variogram: RVARIO(), search: search({ radius: 50, ndmin: 1, ndmax: 8, perHoleMax: 2 }) }),
    output: {},
  });
  assert.equal(r.toJSON().default_model.search.perHoleMax, 2);   // in the artifact
  assert.deepEqual(fromJSON(r.toJSON()).toJSON(), r.toJSON());   // round-trips
  assert.ok([...run(r, { rows }).status].filter((s) => s === STATUS.OK).length >= 12);

  // bench in the recipe (degenerate 2D band here, but the path is exercised)
  const rb = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' } },
    block_grid: { ...SYNTH.grid },
    default_model: ok({ variogram: RVARIO(), search: search({ radius: 50, ndmin: 1, ndmax: 8, benchThickness: 15 }) }),
    output: {},
  });
  assert.equal(rb.toJSON().default_model.search.benchThickness, 15);
  assert.ok([...run(rb, { rows: SROWS }).status].filter((s) => s === STATUS.OK).length >= 1);

  // perHoleMax without a dh_id column → the engine's holeId error
  const rx = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' } },
    block_grid: { ...SYNTH.grid },
    default_model: ok({ variogram: RVARIO(), search: search({ radius: 50, ndmin: 1, ndmax: 8, perHoleMax: 2 }) }),
    output: {},
  });
  assert.throws(() => run(rx, { rows: SROWS }), /holeId/);
});

test('recipe — model-level structural orientation (default) + gslib override + legacy ang', () => {
  // structural is the DEFAULT convention (dip/dipAzimuth/pitch); orients the domain
  const r = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' } },
    block_grid: { ...SYNTH.grid },
    default_model: ok({ orientation: { dip: 60, dipAzimuth: 90, pitch: 0 }, variogram: RVARIO(), search: RSEARCH() }),
    output: {},
  });
  const j = r.toJSON();
  assert.equal(j.default_model.convention, 'structural');
  assert.deepEqual(j.default_model.orientation, { dip: 60, dipAzimuth: 90, pitch: 0 });
  assert.deepEqual(fromJSON(j).toJSON(), j);
  assert.ok([...run(r, { rows: SROWS }).status].filter((s) => s === STATUS.OK).length >= 12);

  // explicit gslib convention
  const rg = recipe({
    data: { columns: { x: 'X', y: 'Y', z: 'Z', value: 'AU' } },
    block_grid: { ...SYNTH.grid },
    default_model: ok({ convention: 'gslib', orientation: { azimuth: 90, dip: 0, rake: 0 }, variogram: RVARIO(), search: RSEARCH() }),
    output: {},
  });
  assert.equal(rg.toJSON().default_model.convention, 'gslib');
  assert.ok([...run(rg, { rows: SROWS }).status].filter((s) => s === STATUS.OK).length >= 12);

  // legacy: no model orientation → per-part gslib path unchanged
  const rl = baseRecipe();
  assert.equal(rl.toJSON().default_model.orientation, undefined);
  assert.ok([...run(rl, { rows: SROWS }).status].filter((s) => s === STATUS.OK).length >= 12);
});

// ── QKNA diagnostics (slope of regression / kriging efficiency / negative weights) ──
// Formulas pinned to Deutsch & Deutsch 2012 (CCG Paper 306): slope b = Σλ·C̄(uᵢ,V) /
// ΣΣλᵢλⱼC(uᵢ,uⱼ) [Eq.9]; KE = (BV−KV)/BV with BV = C̄(V,V) = cbb [Eq.1-2]. SK is
// conditionally unbiased → slope ≡ 1; OK slope < 1 under limited search and rises
// monotonically toward 1 with more accessed data (the paper's headline observation).
test('krige — QKNA: SK slope ≡ 1, OK slope rises toward 1 with more data', () => {
  const data = [];
  for (let i = 0; i < 60; i++) { const x = (i * 37) % 100, y = (i * 53) % 100, z = (i * 17) % 30; data.push([x, y, z, 1 + Math.sin(x * 0.1) + Math.cos(y * 0.13)]); }
  const vario = { nugget: 0.3, structures: [{ type: 'spherical', contribution: 0.7, range: 25 }] };
  const pt = [[55, 45, 12]];

  // SK is conditionally unbiased → slope exactly 1 (Eq.9 numerator==denominator for SK)
  const skr = krige({ data, variogram: vario, search: { radius: 35, ndmin: 1, ndmax: 8 }, ktype: 'SK', skmean: 1, points: pt, diagnostics: true });
  assert.ok(Math.abs(skr.diagnostics.slope[0] - 1) < 1e-9, `SK slope ${skr.diagnostics.slope[0]} ≠ 1`);

  // OK slope monotonically increases with ndmax (conditional bias shrinks), all < 1 here
  const slopes = [2, 4, 8, 20].map((nd) => krige({ data, variogram: vario, search: { radius: 35, ndmin: 1, ndmax: nd }, ktype: 'OK', points: pt, diagnostics: true }).diagnostics.slope[0]);
  for (let i = 1; i < slopes.length; i++) assert.ok(slopes[i] > slopes[i - 1], `slope not monotone: ${slopes}`);
  assert.ok(slopes[0] < 0.9 && slopes[slopes.length - 1] < 1.0, `slopes out of band: ${slopes}`);
});

test('krige — QKNA: exact interpolator at data → slope 1, KE 1; OK weights sum to 1', () => {
  const data = [];
  for (let i = 0; i < 40; i++) { const x = (i * 37) % 100, y = (i * 53) % 100, z = (i * 17) % 30; data.push([x, y, z, 1 + Math.sin(x * 0.1)]); }
  const vario = { nugget: 0.1, structures: [{ type: 'spherical', contribution: 0.9, range: 40 }] };
  const search = { radius: 60, ndmin: 2, ndmax: 12 };

  // at a data location: kv→0 so KE = 1 − 0/cbb = 1, and slope = 1 (coincident sample)
  const at = krige({ data, variogram: vario, search, ktype: 'OK', points: [[data[5][0], data[5][1], data[5][2]]], diagnostics: true });
  assert.ok(Math.abs(at.diagnostics.slope[0] - 1) < 1e-6, `at-data slope ${at.diagnostics.slope[0]}`);
  assert.ok(Math.abs(at.diagnostics.ke[0] - 1) < 1e-6, `at-data KE ${at.diagnostics.ke[0]}`);

  // OK: weight to the mean ≈ 0 (Σλ = 1); negWeights ≥ 0
  const r = krige({ data, variogram: vario, search, ktype: 'OK', points: [[50, 50, 15], [12, 80, 5]], diagnostics: true });
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(r.diagnostics.weightMean[i]) < 1e-9, `OK weightMean ${r.diagnostics.weightMean[i]} ≠ 0`);
    assert.ok(r.diagnostics.negWeights[i] >= 0, `negWeights < 0`);
  }
});

test('krige — QKNA: diagnostics are opt-in (absent without the flag)', () => {
  const r = krige({ data: SYNTH.data, variogram: SYNTH.variogram, search: SYNTH.search, ktype: 'OK', grid: SYNTH.grid });
  assert.equal(r.diagnostics, null);
});

test('recipe — output.diagnostics flows through; qknaSummary pools over OK blocks', () => {
  const r = baseRecipe({ output: { diagnostics: true, aggregations: [] } });
  assert.equal(r.toJSON().output.diagnostics, true);
  assert.deepEqual(fromJSON(r.toJSON()).toJSON(), r.toJSON());   // round-trips

  const kr = estimate(r, { rows: SROWS });
  const t = kr.domains[0].tensor;
  assert.ok(t.diagnostics && t.diagnostics.slope.length === t.n_blocks);

  const q = qknaSummary(kr);
  assert.ok(q.n >= 12, `pooled ${q.n} OK blocks`);
  assert.ok(Number.isFinite(q.meanSlope) && q.meanSlope > 0 && q.meanSlope <= 1.05, `meanSlope ${q.meanSlope}`);
  assert.ok(Number.isFinite(q.meanKE), `meanKE ${q.meanKE}`);
  assert.ok(q.meanNegWeights >= 0 && q.pctSlopeBelow95 >= 0 && q.pctSlopeBelow95 <= 100);

  // qknaSummary also accepts a bare krige() tensor
  const q2 = qknaSummary(t);
  assert.equal(q2.n, q.n);
});

// ── cross-validation (leave-one-out) ──
// The strong oracle: a CV estimate at sample i must equal a plain krige() at that
// location over data MINUS sample i (same neighbour set, same weights, same value).
test('crossValidate — LOO estimate == krige() over data minus that sample', () => {
  const data = [];
  for (let i = 0; i < 70; i++) { const x = (i * 37) % 100, y = (i * 53) % 100, z = (i * 17) % 30; data.push([x, y, z, 5 + 0.03 * x + Math.sin(x * 0.07)]); }
  const vario = { nugget: 0.05, structures: [{ type: 'spherical', contribution: 0.95, range: 40 }] };
  const search = { radius: 60, ndmin: 2, ndmax: 16 };
  const cv = crossValidate({ data, variogram: vario, search, ktype: 'OK' });

  for (const i of [10, 25, 40]) {
    const reduced = data.filter((_, k) => k !== i);
    const kr = krige({ data: reduced, variogram: vario, search, ktype: 'OK', points: [[data[i][0], data[i][1], data[i][2]]] });
    const est = realize(kr, kr.values)[0];           // Σ weights·values at the point
    assert.ok(Math.abs(cv.estimate[i] - est) < 1e-9, `CV[${i}] ${cv.estimate[i]} ≠ krige-without-self ${est}`);
    assert.ok(Math.abs(cv.kv[i] - kr.kv[0]) < 1e-9, `CV kv[${i}] mismatch`);
  }
  // mechanical invariants over all OK samples
  for (let i = 0; i < cv.n; i++) {
    if (cv.status[i] !== STATUS.OK) continue;
    assert.ok(Math.abs((cv.estimate[i] - cv.actual[i]) - cv.error[i]) < 1e-12, 'error = estimate − actual');
    assert.ok(Math.abs(cv.error[i] / Math.sqrt(cv.kv[i]) - cv.stderr[i]) < 1e-12, 'stderr = error/√kv');
  }
  assert.equal(cv.summary.nOk, 70);
  assert.ok(Math.abs(cv.summary.meanError) < 0.1, `meanError ${cv.summary.meanError} not ≈ 0`);
});

test('crossValidate — SK adds the weight-on-mean; sameHole excludes the whole hole', () => {
  const data = [];
  for (let i = 0; i < 64; i++) { const x = (i * 37) % 100, y = (i * 53) % 100, z = (i * 17) % 30; data.push([x, y, z, 8 + Math.sin(x * 0.07)]); }
  const vario = { nugget: 0.05, structures: [{ type: 'spherical', contribution: 0.95, range: 40 }] };
  const search = { radius: 60, ndmin: 2, ndmax: 16 };

  // SK estimate at i == Σλ·v + (1−Σλ)·skmean over data minus i
  const cv = crossValidate({ data, variogram: vario, search, ktype: 'SK', skmean: 8 });
  const i = 20;
  const reduced = data.filter((_, k) => k !== i);
  const kr = krige({ data: reduced, variogram: vario, search, ktype: 'SK', skmean: 8, points: [[data[i][0], data[i][1], data[i][2]]] });
  let est = 0, sw = 0;
  for (let k = 0; k < kr.n_actual[0]; k++) { est += kr.weights[k] * kr.values[kr.indices[k]]; sw += kr.weights[k]; }
  est += (1 - sw) * 8;
  assert.ok(Math.abs(cv.estimate[i] - est) < 1e-9, `SK CV[${i}] ${cv.estimate[i]} ≠ ${est}`);

  // sameHole: excluding the datum's whole hole removes near neighbours → different
  // estimates than plain LOO (and needs a holeId)
  const hole = data.map((_, k) => Math.floor(k / 8));
  const plain = crossValidate({ data, variogram: vario, search, ktype: 'OK', holeId: hole });
  const sh = crossValidate({ data, variogram: vario, search, ktype: 'OK', holeId: hole, sameHole: true });
  let differ = 0;
  for (let k = 0; k < data.length; k++) if (sh.status[k] === STATUS.OK && plain.status[k] === STATUS.OK && Math.abs(sh.estimate[k] - plain.estimate[k]) > 1e-9) differ++;
  assert.ok(differ > data.length / 2, `sameHole barely changed estimates (${differ})`);
  assert.throws(() => crossValidate({ data, variogram: vario, search, ktype: 'OK', sameHole: true }), /sameHole needs holeId/);
});

// ── cell declustering (GSLIB declus) ──
test('declusterCell — down-weights a dense cluster; Σweights = n; recovers background', () => {
  // 36 sparse background @ grade 1 on a 20-m grid + 64 clustered @ grade 10 (all in
  // one 20-m cell). Naive mean is dragged up; declustering should recover ≈ 1.
  const data = [];
  for (let x = 0; x <= 100; x += 20) for (let y = 0; y <= 100; y += 20) data.push([x, y, 0, 1.0]);
  for (let i = 0; i < 64; i++) data.push([48 + (i % 8) * 0.4, 48 + Math.floor(i / 8) * 0.4, 0, 10.0]);
  const n = data.length;

  const c = declusterCell({ data, cellSize: 20 });
  let sw = 0; for (const w of c.weights) sw += w;
  assert.ok(Math.abs(sw - n) < 1e-9, `Σweights ${sw} ≠ n=${n}`);
  assert.ok(c.naiveMean > 6, `naive ${c.naiveMean} should be inflated`);
  assert.ok(c.mean < 2, `declustered mean ${c.mean} should recover ≈1 background`);
  assert.ok(c.mean < c.naiveMean, 'declustered < naive for high-grade clustering');
  // the 64 clustered samples each get a small weight; a sparse sample gets ≈ a full one
  assert.ok(c.weights[0] > c.weights[n - 1] * 5, 'sparse sample out-weighs a clustered one');
});

test('declusterCell — uniform data → ~equal weights, declustered ≈ naive', () => {
  const data = [];
  for (let x = 0; x < 60; x += 10) for (let y = 0; y < 60; y += 10) data.push([x, y, 0, 2 + 0.01 * x]);
  const c = declusterCell({ data, cellSize: 10 });
  for (const w of c.weights) assert.ok(Math.abs(w - 1) < 1e-9, `uniform weight ${w} ≠ 1`);
  assert.ok(Math.abs(c.mean - c.naiveMean) < 1e-9, 'no clustering → declustered == naive');
});

test('declusterSweep — traces the curve; best=min picks a low-mean cell size', () => {
  const data = [];
  for (let x = 0; x <= 100; x += 20) for (let y = 0; y <= 100; y += 20) data.push([x, y, 0, 1.0]);
  for (let i = 0; i < 64; i++) data.push([48 + (i % 8) * 0.4, 48 + Math.floor(i / 8) * 0.4, 0, 10.0]);

  const sweep = declusterSweep({ data, sizes: [2, 5, 10, 20, 30, 50, 80] });
  assert.equal(sweep.means.length, 7);
  assert.ok(sweep.best.mean <= Math.min(...sweep.means) + 1e-9, 'best=min is the minimum of the curve');
  assert.ok(sweep.best.mean < sweep.naiveMean, 'best declustered mean beats naive');
  let sw = 0; for (const w of sweep.best.weights) sw += w; assert.ok(Math.abs(sw - data.length) < 1e-9);
  // max-pick selects the other extremum
  const up = declusterSweep({ data, sizes: [2, 5, 10, 20, 30, 50, 80], pick: 'max' });
  assert.ok(up.best.mean >= Math.max(...up.means) - 1e-9, 'best=max is the maximum of the curve');
});

// ── experimental variography — bit-for-bit vs gslib.gamv ──
// gamv with an arbitrary ivtype (the index.js wrapper hardcodes 1), so we can validate
// the whole estimator menu against the frozen oracle without editing ext/gslib.
function gamvIv(data, lags, dirs, ivtype) {
  const nd = data.length, is3d = data[0] && data[0].length > 3;
  const nlag = lags.n, xlag = lags.size, xltol = lags.tolerance != null ? lags.tolerance : xlag / 2;
  const ndir = dirs.length, nvarg = 1, nlp2 = nlag + 2, nsiz = ndir * nvarg * nlp2;
  const mem = new WebAssembly.Memory({ initial: 4 });
  const lib = gslibInstantiate({ memory: mem });
  const st = { off: 0 };
  const pX = gAlloc(st, nd), pY = gAlloc(st, nd), pZ = gAlloc(st, nd), pVR = gAlloc(st, nd);
  const pAZM = gAlloc(st, ndir), pATOL = gAlloc(st, ndir), pBWH = gAlloc(st, ndir);
  const pDIP = gAlloc(st, ndir), pDTOL = gAlloc(st, ndir), pBWD = gAlloc(st, ndir);
  const pIVTAIL = gAlloc(st, 0, nvarg), pIVHEAD = gAlloc(st, 0, nvarg), pIVTYPE = gAlloc(st, 0, nvarg);
  const pNP = gAlloc(st, nsiz), pDIS = gAlloc(st, nsiz), pGAM = gAlloc(st, nsiz);
  const pHM = gAlloc(st, nsiz), pTM = gAlloc(st, nsiz), pHV = gAlloc(st, nsiz), pTV = gAlloc(st, nsiz);
  gGrow(mem, st.off);
  gWriteF64(mem, pX, data.map(d => d[0])); gWriteF64(mem, pY, data.map(d => d[1]));
  gWriteF64(mem, pZ, is3d ? data.map(d => d[2]) : new Array(nd).fill(0));
  gWriteF64(mem, pVR, data.map(d => is3d ? d[3] : d[2]));
  gWriteF64(mem, pAZM, dirs.map(d => d.azimuth || 0)); gWriteF64(mem, pATOL, dirs.map(d => d.tolerance != null ? d.tolerance : 90)); gWriteF64(mem, pBWH, dirs.map(() => 1e21));
  gWriteF64(mem, pDIP, dirs.map(d => d.dip || 0)); gWriteF64(mem, pDTOL, dirs.map(d => d.dipTolerance != null ? d.dipTolerance : 90)); gWriteF64(mem, pBWD, dirs.map(() => 1e21));
  gWriteI32(mem, pIVTAIL, [0]); gWriteI32(mem, pIVHEAD, [0]); gWriteI32(mem, pIVTYPE, [ivtype]);
  lib.gslib.gamv(nd, pX, pY, pZ, pVR, nlag, xlag, xltol, ndir, pAZM, pATOL, pBWH, pDIP, pDTOL, pBWD,
    nvarg, pIVTAIL, pIVHEAD, pIVTYPE, -1e21, 1e21, pNP, pDIS, pGAM, pHM, pTM, pHV, pTV);
  return { value: gReadF64(mem, pGAM, nsiz), npairs: gReadF64(mem, pNP, nsiz) };
}

const VARIO_FIELD = (() => {
  const rng = (() => { let a = 42; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const d = [];
  for (let i = 0; i < 140; i++) { const x = rng() * 100, y = rng() * 100; d.push([x, y, 5 + Math.sin(x * 0.1) + Math.cos(y * 0.08) + 0.5 * rng()]); }
  return d;
})();

test('experimental — bit-for-bit vs gslib.gamv across the estimator menu + directions', () => {
  const lags = { size: 8, n: 8 }, nlp2 = lags.n + 2;
  const dirCases = [{ azimuth: 0, tolerance: 90 }, { azimuth: 45, tolerance: 22.5 }, { azimuth: 90, tolerance: 30 }];
  const estMap = [['matheron', 1], ['covariance', 3], ['correlogram', 4], ['generalRelative', 5], ['pairwiseRelative', 6], ['logVariogram', 7], ['madogram', 8]];
  for (const [name, iv] of estMap) for (const dc of dirCases) {
    const ref = gamvIv(VARIO_FIELD, lags, [dc], iv);
    const r = experimental(VARIO_FIELD, { lags, directions: [{ azimuth: dc.azimuth, atol: dc.tolerance }], estimator: name, faithful: true });
    for (let il = 0; il < nlp2; il++) {
      const g = r.directions[0].lags[il];
      assert.equal(g.npair, ref.npairs[il], `${name} az${dc.azimuth}/${dc.tolerance} lag ${il}: npair`);
      if (ref.npairs[il] > 0) assert.ok(Math.abs(g.gamma - ref.value[il]) < 1e-9, `${name} az${dc.azimuth}/${dc.tolerance} lag ${il}: γ ${g.gamma} vs ${ref.value[il]}`);
    }
  }
});

test('experimental — 3D directional with dip vs gslib.gamv', () => {
  const rng = (() => { let a = 7; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const data = [];
  for (let i = 0; i < 120; i++) { const x = rng() * 80, y = rng() * 80, z = rng() * 40; data.push([x, y, z, 3 + Math.sin(x * 0.12) + 0.4 * rng()]); }
  const lags = { size: 7, n: 7 }, nlp2 = lags.n + 2;
  const dc = { azimuth: 30, tolerance: 25, dip: 45, dipTolerance: 20 };
  const ref = gamvIv(data, lags, [dc], 1);
  const r = experimental(data, { lags, directions: [{ azimuth: 30, atol: 25, dip: 45, dtol: 20 }], estimator: 'matheron', faithful: true });
  for (let il = 0; il < nlp2; il++) {
    const g = r.directions[0].lags[il];
    assert.equal(g.npair, ref.npairs[il], `3D lag ${il} npair`);
    if (ref.npairs[il] > 0) assert.ok(Math.abs(g.gamma - ref.value[il]) < 1e-9, `3D lag ${il} γ`);
  }
});

test('experimental — downhole mode == pooled per-hole gamv (same-hole pairs only)', () => {
  // 6 vertical holes, samples every 3 m; downhole variogram pools all same-hole pairs.
  const data = [], holeId = [];
  let id = 0;
  for (let hx = 0; hx < 60; hx += 12) for (let hy = 0; hy < 30; hy += 15) {
    id++;
    for (let z = 0; z < 60; z += 3) { data.push([hx, hy, z, 4 + Math.sin(z * 0.2) + 0.3 * ((z * 7) % 5) / 5]); holeId.push('H' + id); }
  }
  const lags = { size: 3, n: 10 }, nlp2 = lags.n + 2;
  const dh = experimental(data, { holeId, lags, directions: [{ mode: 'downhole' }], estimator: 'matheron', faithful: true });

  // pool gamv run per hole (omni) — binning is per-pair, so per-hole-pooled == one pass over same-hole pairs
  const holes = [...new Set(holeId)];
  const sumG = new Float64Array(nlp2), sumN = new Float64Array(nlp2);
  for (const h of holes) {
    const hd = data.filter((_, k) => holeId[k] === h);
    const g = gamvIv(hd, lags, [{ azimuth: 0, tolerance: 90 }], 1);
    for (let il = 0; il < nlp2; il++) if (g.npairs[il] > 0) { sumG[il] += g.value[il] * g.npairs[il]; sumN[il] += g.npairs[il]; }
  }
  for (let il = 0; il < nlp2; il++) {
    const g = dh.directions[0].lags[il];
    assert.equal(g.npair, sumN[il], `downhole lag ${il} npair`);
    if (sumN[il] > 0) assert.ok(Math.abs(g.gamma - sumG[il] / sumN[il]) < 1e-9, `downhole lag ${il} γ`);
  }
  // sanity: downhole excludes cross-hole pairs → fewer than the full omni
  const omni = experimental(data, { lags, directions: [{ atol: 90 }], estimator: 'matheron', faithful: true });
  const dhTotal = dh.directions[0].lags.reduce((s, l) => s + l.npair, 0);
  const omniTotal = omni.directions[0].lags.reduce((s, l) => s + l.npair, 0);
  assert.ok(dhTotal < omniTotal, 'downhole pairs ⊂ omni pairs');
  assert.throws(() => experimental(data, { lags, directions: [{ mode: 'downhole' }] }), /downhole.*holeId/);
});

test('experimental — Cressie + rodogram on a hand fixture (no gamv oracle)', () => {
  // one pair: (0,0)=2 and (10,0)=5, along azimuth 90 (narrow tol → single direction, np=1)
  const data = [[0, 0, 2], [10, 0, 5]];
  const lags = { size: 10, n: 3 };  // pair at d=10 → lag bin il=2 (centre 10), tol 5
  const dir = [{ azimuth: 90, atol: 10 }];
  const rodo = experimental(data, { lags, directions: dir, estimator: 'rodogram', faithful: true }).directions[0].lags[2];
  const cres = experimental(data, { lags, directions: dir, estimator: 'cressie', faithful: true }).directions[0].lags[2];
  assert.equal(rodo.npair, 1); assert.equal(cres.npair, 1);
  // rodogram γ = ½·|Δ|^½ ; Cressie γ = ½·(|Δ|^½)⁴ / (0.457 + 0.494/n + 0.045/n²), n=1
  assert.ok(Math.abs(rodo.gamma - 0.5 * Math.sqrt(3)) < 1e-12, `rodogram ${rodo.gamma}`);
  assert.ok(Math.abs(cres.gamma - 0.5 * 9 / 0.996) < 1e-12, `cressie ${cres.gamma}`);
});

// ── the lag-vector volume (the precompute-once / sweep-cheap substrate) ──
const VOL3D = (() => {
  const rng = (() => { let a = 11; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();
  const d = [];
  for (let i = 0; i < 200; i++) { const x = rng() * 100, y = rng() * 100, z = rng() * 40; d.push([x, y, z, 4 + Math.sin(x * 0.1) + 0.4 * rng()]); }
  return d;
})();

test('lagVolume — omni extraction is EXACT vs experimental() (+ kd-tree gathers every pair)', () => {
  const lags = { size: 8, n: 8 };
  for (const estimator of ['matheron', 'madogram', 'correlogram']) {
    const vol = buildLagVolume(VOL3D, { lags, estimator });
    const vo = directionalVariogram(vol, { atol: 90, dtol: 90 });
    const eo = experimental(VOL3D, { lags, directions: [{ atol: 90 }], estimator, faithful: true }).directions[0].lags;
    for (let lb = 0; lb < vol.nlb; lb++) {
      const e = eo[lb + 1];                                  // experimental il = volume lb + 1
      if (e.npair > 0) {
        assert.ok(Math.abs(vo.lags[lb].gamma - e.gamma) < 1e-9, `${estimator} omni lag ${lb}: γ ${vo.lags[lb].gamma} vs ${e.gamma}`);
        assert.equal(e.npair, vo.lags[lb].npair, `${estimator} omni lag ${lb}: np (both symmetric)`);
      }
    }
  }
});

test('lagVolume — directional approximates experimental() and CONVERGES with resolution', () => {
  const lags = { size: 8, n: 8 };
  const ed = experimental(VOL3D, { lags, directions: [{ azimuth: 45, dip: 0, atol: 25, dtol: 25 }], estimator: 'matheron', faithful: true }).directions[0].lags;
  const meanErr = (az, dp) => {
    const vol = buildLagVolume(VOL3D, { lags, estimator: 'matheron', azBins: az, dipBins: dp });
    const vd = directionalVariogram(vol, { azimuth: 45, dip: 0, atol: 25, dtol: 25 });
    let s = 0, n = 0;
    for (let lb = 1; lb <= 6; lb++) { const e = ed[lb + 1]; if (e.npair > 20 && e.gamma > 0) { s += Math.abs(vd.lags[lb].gamma - e.gamma) / e.gamma; n++; } }
    return s / n;
  };
  const coarse = meanErr(36, 18), fine = meanErr(90, 45);
  assert.ok(coarse < 0.08, `default-resolution directional err ${coarse} should be small`);
  assert.ok(fine < coarse + 1e-9, `finer cells converge: fine ${fine} ≤ coarse ${coarse}`);
});

test('lagVolume — mergeable (sums add; the parallel-fill contract)', () => {
  const vol = buildLagVolume(VOL3D, { lags: { size: 8, n: 8 }, estimator: 'matheron' });
  const m = mergeLagVolumes(vol, vol);
  for (let i = 0; i < vol.cells.length; i++) assert.ok(Math.abs(m.cells[i] - 2 * vol.cells[i]) < 1e-9, `merge additivity at ${i}`);
  assert.throws(() => mergeLagVolumes(vol, buildLagVolume(VOL3D, { lags: { size: 8, n: 6 }, estimator: 'matheron' })), /incompatible/);
});

test('lagVolume — downhole (sameHoleOnly) omni == experimental downhole', () => {
  const data = [], holeId = [];
  let id = 0;
  for (let hx = 0; hx < 60; hx += 15) for (let hy = 0; hy < 30; hy += 15) { id++; for (let z = 0; z < 48; z += 3) { data.push([hx, hy, z, 4 + Math.sin(z * 0.2)]); holeId.push('H' + id); } }
  const lags = { size: 3, n: 8 };
  const vol = buildLagVolume(data, { lags, estimator: 'matheron', holeId, sameHoleOnly: true });
  const vo = directionalVariogram(vol, { atol: 90, dtol: 90 });
  const ed = experimental(data, { holeId, lags, directions: [{ mode: 'downhole' }], estimator: 'matheron', faithful: true }).directions[0].lags;
  for (let lb = 0; lb < vol.nlb; lb++) { const e = ed[lb + 1]; if (e.npair > 0) assert.ok(Math.abs(vo.lags[lb].gamma - e.gamma) < 1e-9, `downhole lag ${lb} γ`); }
  assert.throws(() => buildLagVolume(data, { lags, estimator: 'matheron', sameHoleOnly: true }), /sameHoleOnly.*holeId/);
});
