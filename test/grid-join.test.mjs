// @gcu/condenser grid-join: compatibility, volume-weighted resample (replicate
// / aggregate / mixed / categorical / coverage), and the common lattice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floatGcd, axisMap, gridsCompatible, makeResampler, makeBoxAggregator, commonLattice } from '../ext/condenser/src/main.js';

const ax = (origin, pitch, count) => ({ origin, pitch, count });
const grid = (x, y, z) => ({ x, y, z });
const Z1 = ax(0, 0, 1);

test('floatGcd — tolerant Euclidean', () => {
  assert.equal(floatGcd(10, 15, 1e-6), 5);
  assert.equal(floatGcd(10, 12, 1e-6), 2);
  assert.equal(floatGcd(12.5, 10, 1e-6), 2.5);
  assert.equal(floatGcd(7, 5, 1e-6), 1);
  assert.equal(floatGcd(10, 20, 1e-6), 10);
});

test('axisMap — refine-replicate (coarse source → fine target)', () => {
  // source pitch 10 (cells [0,10],[10,20]) → target pitch 5 (4 cells), aligned
  const m = axisMap(ax(5, 10, 2), ax(2.5, 5, 4));
  assert.ok(m.ok); assert.equal(m.g, 5); assert.equal(m.sp, 2); assert.equal(m.tp, 1);
  assert.deepEqual(m.map[0], [{ t: 0, w: 1 }, { t: 1, w: 1 }]);   // source cell 0 → target 0,1
  assert.deepEqual(m.map[1], [{ t: 2, w: 1 }, { t: 3, w: 1 }]);
});

test('axisMap — aggregate (fine source → coarse target)', () => {
  const m = axisMap(ax(2.5, 5, 4), ax(5, 10, 2));
  assert.ok(m.ok); assert.equal(m.sp, 1); assert.equal(m.tp, 2);
  assert.deepEqual(m.map[0], [{ t: 0, w: 1 }]);   // two fine cells share one coarse
  assert.deepEqual(m.map[1], [{ t: 0, w: 1 }]);
  assert.deepEqual(m.map[2], [{ t: 1, w: 1 }]);
});

test('axisMap — non-nested common lattice (10 & 12 on g=2, mixed weights)', () => {
  // source 10 m, target 12 m, aligned low faces at 0
  const m = axisMap(ax(5, 10, 3), ax(6, 12, 3));
  assert.ok(m.ok); assert.equal(m.g, 2); assert.equal(m.nested, false);
  // source cell 0 [0,10] g-units [0,5]; target 0 [0,12]→[0,6] → overlap 5 in t0
  assert.deepEqual(m.map[0], [{ t: 0, w: 5 }]);
  // source cell 1 [10,20] g-units [5,10]; target0 [0,6]→ov 1, target1 [6,12]→[6,12]... wait
  assert.equal(m.map[1][0].t, 0); assert.equal(m.map[1][0].w, 1);   // 1 g-unit into t0
  assert.equal(m.map[1][1].t, 1); assert.equal(m.map[1][1].w, 4);   // 4 into t1
});

test('axisMap — off-phase refused', () => {
  const m = axisMap(ax(5, 10, 2), ax(3.5, 5, 4));   // target low face = 1, source = 0 → off-phase on g=5
  assert.equal(m.ok, false); assert.match(m.reason, /off-phase/);
});

test('gridsCompatible — nested / non-nested / incompatible', () => {
  assert.equal(gridsCompatible(grid(ax(5, 10, 2), ax(5, 10, 2), Z1), grid(ax(2.5, 5, 4), ax(2.5, 5, 4), Z1)).nested, true);
  assert.equal(gridsCompatible(grid(ax(5, 10, 3), ax(5, 10, 3), Z1), grid(ax(6, 12, 3), ax(6, 12, 3), Z1)).nested, false);
  assert.equal(gridsCompatible(grid(ax(5, 10, 2), ax(5, 10, 2), Z1), grid(ax(0, 14.142, 2), ax(0, 14.142, 2), Z1)).ok, false);
});

test('makeResampler — replicate: fine target inherits coarse source value', () => {
  const src = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);   // 2×2
  const tgt = grid(ax(2.5, 5, 4), ax(2.5, 5, 4), Z1); // 4×4
  const R = makeResampler(src, tgt); assert.ok(R.ok);
  const acc = R.newAcc();
  const sval = (si, sj) => (si + 2 * sj + 1) * 100;   // 100,200,300,400
  for (let sj = 0; sj < 2; sj++) for (let si = 0; si < 2; si++) R.scatter(si, sj, 0, sval(si, sj), 1, acc);
  const { out, present } = R.finalize(acc, 'mean');
  const g = (ti, tj) => out[R.idxOf(ti, tj, 0)];
  assert.equal(g(0, 0), 100); assert.equal(g(1, 0), 100);   // both inherit source (0,0)
  assert.equal(g(2, 0), 200); assert.equal(g(0, 2), 300); assert.equal(g(3, 3), 400);
  assert.equal(present[R.idxOf(3, 3, 0)], 1);
});

test('makeResampler — aggregate: coarse target = (weighted) mean of fine source', () => {
  const src = grid(ax(2.5, 5, 4), ax(2.5, 5, 4), Z1); // 4×4
  const tgt = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);   // 2×2
  const R = makeResampler(src, tgt); assert.ok(R.ok);
  // fill the 4 fine cells landing in coarse (0,0): source (0,0)(1,0)(0,1)(1,1) = 0,10,20,30
  const acc = R.newAcc();
  const v = { '0,0': 0, '1,0': 10, '0,1': 20, '1,1': 30 };
  for (const key in v) { const [si, sj] = key.split(',').map(Number); R.scatter(si, sj, 0, v[key], 1, acc); }
  const mean = R.finalize(acc, 'mean').out[R.idxOf(0, 0, 0)];
  assert.equal(mean, 15);                                   // (0+10+20+30)/4
  const sum = R.finalize(acc, 'sum').out[R.idxOf(0, 0, 0)];
  assert.equal(sum, 60);
  // weighted: weight (1,1)=3, others 1 → (0+10+20+90)/6 = 20
  const wacc = R.newAcc();
  for (const key in v) { const [si, sj] = key.split(',').map(Number); R.scatter(si, sj, 0, v[key], key === '1,1' ? 3 : 1, wacc); }
  assert.equal(R.finalize(wacc, 'mean').out[R.idxOf(0, 0, 0)], 20);
});

test('makeResampler — coverage < 1 on partial fill', () => {
  const src = grid(ax(2.5, 5, 4), ax(2.5, 5, 4), Z1);
  const tgt = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);
  const R = makeResampler(src, tgt);
  const acc = R.newAcc();
  // only 3 of the 4 fine cells in coarse (0,0)
  R.scatter(0, 0, 0, 1, 1, acc); R.scatter(1, 0, 0, 1, 1, acc); R.scatter(0, 1, 0, 1, 1, acc);
  const { coverage } = R.finalize(acc, 'mean');
  assert.equal(coverage[R.idxOf(0, 0, 0)], 0.75);
});

test('makeResampler — categorical majority + tie flag', () => {
  const src = grid(ax(2.5, 5, 4), ax(2.5, 5, 4), Z1);
  const tgt = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);
  const R = makeResampler(src, tgt);
  const votes = R.newCatAcc();
  R.scatterCat(0, 0, 0, 1, 1, votes); R.scatterCat(1, 0, 0, 1, 1, votes); R.scatterCat(0, 1, 0, 2, 1, votes); R.scatterCat(1, 1, 0, 1, 1, votes);
  const { out, tie } = R.finalizeCat(votes);
  assert.equal(out[R.idxOf(0, 0, 0)], 1); assert.equal(tie[R.idxOf(0, 0, 0)], 0);   // three 1s, one 2
  const votes2 = R.newCatAcc();
  R.scatterCat(0, 0, 0, 1, 1, votes2); R.scatterCat(1, 0, 0, 1, 1, votes2); R.scatterCat(0, 1, 0, 2, 1, votes2); R.scatterCat(1, 1, 0, 2, 1, votes2);
  assert.equal(R.finalizeCat(votes2).tie[R.idxOf(0, 0, 0)], 1);   // 2 vs 2
});

test('commonLattice — finest / coarsest / gcd cover the union', () => {
  const A = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);   // x span [0,20]
  const B = grid(ax(10, 20, 1), ax(10, 20, 1), Z1); // x span [0,20]
  const fine = commonLattice([A, B], { resolution: 'finest' });
  assert.ok(fine.ok); assert.equal(fine.x.pitch, 10); assert.equal(fine.x.count, 2); assert.equal(fine.x.origin, 5);
  const coarse = commonLattice([A, B], { resolution: 'coarsest' });
  assert.equal(coarse.x.pitch, 20); assert.equal(coarse.x.count, 1);
  const g = commonLattice([A, B], { resolution: 'gcd' });
  assert.equal(g.x.pitch, 10);   // gcd(10,20)=10
});

test('commonLattice — off-phase grids refused', () => {
  const A = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);      // low face 0
  const B = grid(ax(12, 10, 2), ax(12, 10, 2), Z1);    // low face 7 → residue 7 vs 0 mod 10
  const r = commonLattice([A, B]);
  assert.equal(r.ok, false); assert.match(r.reason, /off-phase/);
});

test('commonLattice — a resampler round-trips onto it', () => {
  const A = grid(ax(5, 10, 2), ax(5, 10, 2), Z1);
  const B = grid(ax(2.5, 5, 4), ax(2.5, 5, 4), Z1);
  const T = commonLattice([A, B], { resolution: 'finest' });   // → the 5 m lattice
  assert.equal(T.x.pitch, 5); assert.equal(T.x.count, 4);
  assert.ok(makeResampler(A, T).ok && makeResampler(B, T).ok);
});

test('makeBoxAggregator — sub-blocks aggregate to their parent cell (volume-weighted mean)', () => {
  // one 10×10×5 parent cell, centroid (5,5,2.5), filled by 8 sub-blocks (5×5×2.5)
  const parent = grid(ax(5, 10, 1), ax(5, 10, 1), ax(2.5, 5, 1));
  const A = makeBoxAggregator(parent);
  const acc = A.newAcc();
  const subs = [];
  let g = 0;
  for (const oz of [1.25, 3.75]) for (const oy of [2.5, 7.5]) for (const ox of [2.5, 7.5]) subs.push({ cx: ox, cy: oy, cz: oz, g: g++ });
  for (const s of subs) A.scatterBox(s.cx, s.cy, s.cz, 2.5, 2.5, 1.25, s.g, 1, acc);
  const f = A.finalize(acc);
  assert.equal(f.present[0], 1);
  assert.ok(Math.abs(f.out[0] - 3.5) < 1e-9, `equal-volume mean of 0..7 = 3.5, got ${f.out[0]}`);
  assert.ok(Math.abs(f.coverage[0] - 1) < 1e-9, `fully covered, got ${f.coverage[0]}`);
});

test('makeBoxAggregator — selection: excluded sub-blocks drop out, coverage falls', () => {
  const parent = grid(ax(5, 10, 1), ax(5, 10, 1), ax(2.5, 5, 1));
  const A = makeBoxAggregator(parent);
  const acc = A.newAcc();
  // 8 sub-blocks; scatter only the 4 in the lower z half (a "domain" filter)
  let idx = 0;
  for (const oz of [1.25, 3.75]) for (const oy of [2.5, 7.5]) for (const ox of [2.5, 7.5]) {
    const sel = oz < 2 ? 1 : 0;                              // lower half only
    A.scatterBox(ox, oy, oz, 2.5, 2.5, 1.25, 100 + idx, sel, acc); idx++;
  }
  const f = A.finalize(acc);
  assert.ok(Math.abs(f.coverage[0] - 0.5) < 1e-9, `half covered, got ${f.coverage[0]}`);
  assert.ok(f.out[0] >= 100 && f.out[0] <= 103, `mean over the selected 4, got ${f.out[0]}`);
});

test('makeBoxAggregator — a full block covering the parent = that block grade; sum/volume ops', () => {
  const parent = grid(ax(5, 10, 2), ax(5, 10, 1), ax(2.5, 5, 1));   // 2 parents along x
  const A = makeBoxAggregator(parent);
  const acc = A.newAcc();
  A.scatterBox(5, 5, 2.5, 5, 5, 2.5, 2.0, 1, acc);          // full 10×10×5 block in parent 0
  A.scatterBox(15, 5, 2.5, 2.5, 2.5, 2.5, 4.0, 1, acc);     // a 5×5×5 sub-block in parent 1 (quarter of the xy face)
  const mean = A.finalize(acc, 'mean');
  assert.ok(Math.abs(mean.out[0] - 2.0) < 1e-9, 'parent 0 = the full block grade');
  assert.ok(Math.abs(mean.out[1] - 4.0) < 1e-9, 'parent 1 mean = the only contributor');
  assert.ok(Math.abs(mean.coverage[0] - 1) < 1e-9 && Math.abs(mean.coverage[1] - 0.25) < 1e-9, 'coverage 1 vs 0.25');
  const vol = A.finalize(acc, 'volume');
  assert.ok(Math.abs(vol.out[0] - 500) < 1e-6, 'parent 0 overlap volume = 500');
  assert.ok(Math.abs(vol.out[1] - 125) < 1e-6, 'parent 1 overlap volume = 125');
});
