// gsjs §8 perf wave — measure the backend hypothesis instead of extrapolating it.
//
// SPEC-neigh §8 claims (from the BLAS-1 finding, NOT measured for kriging's
// small-matrix-×-millions shape) that V8-winked JS likely WINS the per-block
// kriging solve because the per-block WASM boundary is pure overhead. We now have
// both engines — the pure-JS krige() and the atra/WASM fork kriging() — so this
// benchmarks them head-to-head on representative shapes (ndmax × block count),
// verifies they agree (correctness alongside speed), and is the re-runnable harness
// §8 asks for. Run: node test/gsjs-perf.mjs   (deopt check: see the trailing note)
//
// Not part of `npm test` — a manual measurement (like adder-perf.mjs / interp-perf.mjs).

import { krige, realize, STATUS } from '../ext/gsjs/index.js';
import { kt3d } from '../ext/gslib/index.js';   // gslib's own kriging = the correct WASM baseline
// NB: gsjs's atra fork kriging() has a memory/super-block sizing bug at scale
// (NaN past ~M=10⁴ — only ever validated at N=8/M=16); kt3d is the WASM oracle here.

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// N drillhole-ish samples scattered in [0,EXTENT]² (z=0), value = a smooth field.
function genData(N, EXTENT, seed) {
  const rng = mulberry32(seed);
  const d = [];
  for (let i = 0; i < N; i++) {
    const x = rng() * EXTENT, y = rng() * EXTENT;
    const v = 2 + Math.sin(x / 90) * Math.cos(y / 110) + 0.4 * rng();
    d.push([x, y, 0, v]);
  }
  return d;
}

const variogram = { nugget: 0.1, structures: [{ type: 'spherical', contribution: 0.9, range: 180 }] };

function timeIt(fn, minMs = 400) {
  fn(); fn();                                            // warm the JIT
  let reps = 0; const t0 = performance.now();
  do { fn(); reps++; } while (performance.now() - t0 < minMs);
  return (performance.now() - t0) / reps;
}

function agree(rj, ref) {   // ref = kt3d result { est }
  const ej = realize(rj, rj.values);
  let maxErr = 0, n = 0;
  for (let i = 0; i < rj.n_blocks; i++) { if (rj.status[i] !== STATUS.OK || ref.est[i] === -999) continue; n++; maxErr = Math.max(maxErr, Math.abs(ej[i] - ref.est[i])); }
  return { maxErr, n };
}

console.log('gsjs §8 — JS krige() vs WASM gslib.kt3d()  [blk/s = blocks per second; ratio = WASM_time / JS_time, >1 means JS faster]\n');
const EXTENT = 1200;
const header = ['ndmax', 'N', 'M(blocks)', 'disc', 'JS blk/s', 'WASM blk/s', 'ratio', 'agree'];
console.log(header.map((h, i) => h.padEnd([7, 7, 11, 6, 12, 12, 8, 10][i])).join(''));

for (const disc of [{ nx: 1, ny: 1, nz: 1 }, { nx: 4, ny: 4, nz: 1 }]) {
  for (const ndmax of [8, 24, 60]) {
    for (const [N, gridN] of [[400, 60], [1500, 100]]) {
      const data = genData(N, EXTENT, 1);
      const grid = { nx: gridN, ny: gridN, nz: 1, xmn: 5, ymn: 5, zmn: 0, xsiz: EXTENT / gridN, ysiz: EXTENT / gridN, zsiz: 10 };
      const M = gridN * gridN;
      const search = { radius: 280, ndmin: 1, ndmax };
      const jsOpts = { data, variogram, search, ktype: 'OK', grid, discretization: disc, faithful: true };
      const wOpts = { data, variogram, search, ktype: 'OK', grid, discretization: disc };
      const rj = krige(jsOpts), rw = kt3d(wOpts);
      const { maxErr } = agree(rj, rw);
      const tj = timeIt(() => krige(jsOpts));
      const tw = timeIt(() => kt3d(wOpts));
      const discS = `${disc.nx}³`.replace('³', `x${disc.ny}`);
      console.log([
        String(ndmax).padEnd(7), String(N).padEnd(7), String(M).padEnd(11), discS.padEnd(6),
        (M / tj * 1000).toFixed(0).padEnd(12), (M / tw * 1000).toFixed(0).padEnd(12),
        (tw / tj).toFixed(2).padEnd(8), maxErr.toExponential(1).padEnd(10),
      ].join(''));
    }
  }
}

// ── §8 measured conclusion (2026-06-22) ─────────────────────────────────────
// Against the CORRECT WASM baseline (gslib.kt3d; the gsjs atra fork kriging() is
// NaN-buggy past ~M=10⁴ — only ever validated at N=8/M=16), all engines agree to
// ~1e-15. Findings:
//   • gslib WASM (kt3d) is ~1.5–2× faster than the UNOPTIMIZED JS krige() end-to-end.
//   • §8's "V8 wins the per-block SOLVE" is too narrow for END-TO-END kriging: the
//     JS/WASM ratio climbs with ndmax (~0.44 at ndmax 8 → ~0.7–0.8 at ndmax 60),
//     i.e. JS is relatively weakest where the SEARCH dominates (small neighbourhoods)
//     and strongest where the SOLVE dominates (large ones). gslib's tuned super-block
//     search is the part to beat; the small solve is already near-competitive.
//   • Next levers (future): a bounded top-ndmax selection (heap, not a full sort of
//     every in-radius candidate) for the search; kill krige()'s residual deopts
//     (Insufficient-type-feedback / wrong-call-target — partly the fresh-cova-closure-
//     per-call bench artifact). GPU (M-last) targets the interactive 10M-block tier
//     via realize/aggregate (§8 — never the search).
//   • Strategic upside already banked: krige() is CORRECT + robust at scale where the
//     atra fork breaks, and fully gslib-decoupled — speed is the only gap, and it's
//     <2× before ANY tuning.
console.log('\nDeopt check: node --trace-deopt test/gsjs-perf.mjs 2>&1 | grep -iE "deopt.*(cova|solveGE|sqdist)"');
