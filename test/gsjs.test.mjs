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

// ── M1 gate: reconstruction equation vs the gslib.kt3d oracle ──
// Realization of gsjs.kriging's BlockEstimateTensor must equal gslib.kt3d.est
// to f64 on identical input. Unskip when gsjs.atra (the kriging fork) lands.
test.skip('reconstruction — realize(gsjs.kriging(...)) == gslib.kt3d.est (Walker Lake)', () => {
  // 1. load reference dataset (Walker Lake or a gslib ref .dat)
  // 2. run gslib.kt3d → est, estv
  // 3. run gsjs.kriging → BlockEstimateTensor
  // 4. realize(tensor, values) → realized
  // 5. assert |realized[i] - est[i]| < 1e-9 for every status===OK block
  // 6. assert kv[i] == estv[i] to f64
});
