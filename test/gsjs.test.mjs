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
import { kriging } from '../ext/gsjs/index.js';
import { kt3d } from '../ext/gslib/index.js';
import { stats, histogram, swath, gradeTonnage } from '../ext/gsjs/src/aggregate.js';
import { cpuBackend, getBackend, setBackend } from '../ext/gsjs/src/backend.js';
import {
  recipe, variogram, search, ok, sk, sk_lvm, none, topcut, hgr,
  fromJSON, run, estimate, evaluate,
  createNeighborhood, indexSamples, select, setrot, sqdist,
} from '../ext/gsjs/index.js';
import { instantiate as gslibInstantiate, alloc as gAlloc, readF64 as gReadF64, growMemory as gGrow } from '../ext/gslib/index.js';

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
  assert.equal(maxErr, 0, `recipe drift ${maxErr}`);
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
  assert.equal(maxErr, 0, `cap re-realize drift ${maxErr}`);
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
// broken by original index, capped at ndmax. Uses the SAME sqdist as select() —
// the point is identical metric, different algorithm (full scan vs kd-tree).
function bruteSelect(samples, target, R, radius, ndmax) {
  const r2 = radius * radius, cand = [];
  for (let i = 0; i < samples.length; i++) {
    const d2 = sqdist(target[0], target[1], target[2], samples[i][0], samples[i][1], samples[i][2], R);
    if (d2 <= r2) cand.push({ i, d2 });
  }
  cand.sort((a, b) => (a.d2 - b.d2) || (a.i - b.i));
  return cand.slice(0, ndmax).map((c) => c.i);
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
    const jsRot = setrot(a1, a2, a3, an1, an2);
    // BIT-IDENTICAL: atra's sin/cos ARE JS Math imports, and the port uses gslib's
    // exact truncated-pi literal (3.141592654), so the matrices agree to f64 ULP.
    // (The earlier ~1e-10 gap was Math.PI vs gslib's pi, not trig precision.)
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(wasmRot[i] - jsRot[i]) < 1e-15, `rot[${i}] ${wasmRot[i]} vs ${jsRot[i]}`);
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
  ];
  let checks = 0;
  for (const cfg of configs) {
    for (const ndmax of [4, 12, 1e9]) {
      const nb = createNeighborhood({ ...cfg, ndmin: 1, ndmax });
      indexSamples(nb, samples);
      for (let t = 0; t < 60; t++) {
        const target = [rng() * 500, rng() * 500, 0];
        const got = [...select(nb, target).ranks];
        const exp = bruteSelect(samples, target, nb.rotmat, cfg.radius, ndmax);
        assert.deepEqual(got, exp, `cfg ${JSON.stringify(cfg)} ndmax ${ndmax} target ${target}`);
        checks++;
      }
      // targets sitting EXACTLY on grid samples → maximal ties
      for (let gx = 100; gx <= 400; gx += 100) {
        const got = [...select(nb, [gx, gx, 0]).ranks];
        const exp = bruteSelect(samples, [gx, gx, 0], nb.rotmat, cfg.radius, ndmax);
        assert.deepEqual(got, exp, `tie target ${gx}`);
        checks++;
      }
    }
  }
  assert.ok(checks > 500, `only ${checks} comparisons`);
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
