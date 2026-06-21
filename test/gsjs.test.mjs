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
import { realize, makeTransform, STATUS } from '../ext/gsjs/realize.js';
import { kriging } from '../ext/gsjs/index.js';
import { kt3d } from '../ext/gslib/index.js';
import { stats, histogram, swath, gradeTonnage } from '../ext/gsjs/aggregate.js';
import { cpuBackend, getBackend, setBackend } from '../ext/gsjs/backend.js';

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
  const sw = swath(est, st, grid, { axis: 'x' });
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
