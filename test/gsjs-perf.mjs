// gsjs §8 perf wave — measure the backend hypothesis instead of extrapolating it.
//
// SPEC-neigh §8 claims (from the BLAS-1 finding, NOT measured for kriging's
// small-matrix-×-millions shape) that V8-winked JS likely WINS the per-block
// kriging solve because the per-block WASM boundary is pure overhead. This
// benchmarks the pure-JS krige() against the GSLIB kt3d WASM oracle on
// representative shapes (ndmax × block count), verifies they agree (correctness
// alongside speed), and is the re-runnable harness §8 asks for.
// Run: node test/gsjs-perf.mjs   (deopt check: see the trailing note)
//
// Not part of `npm test` — a manual measurement (like adder-perf.mjs / interp-perf.mjs).

import { krige, realize, STATUS } from '../ext/gsjs/index.js';
import { kt3d } from '../ext/gslib/index.js';   // gslib's own kriging = the correct WASM baseline
// (gsjs's old atra fork kriging() — NaN-broken past ~M=10⁴ — was removed; gsjs is pure JS now.)

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

// ── §8 measured conclusion (2026-06-22, after the kNN search optimization) ───
// Against the CORRECT WASM baseline (gslib.kt3d; the gsjs atra fork kriging() is
// NaN-buggy past ~M=10⁴ — only ever validated at N=8/M=16), all engines agree to
// ~1e-15. §8's "V8-winked JS wins" HOLDS for the common regime:
//   • The original naive search (gather EVERY sample in radius — ~209 to pick 8 —
//     then sort) made WASM ~1.5–2× faster. Replacing it with a bounded kNN in select()
//     (tie-safe: falls back to the full gather only on an exact ndmax-boundary tie,
//     so still bit-identical to brute force) flipped it:
//       ndmax 8  (typical):  JS ~0.9–2.3× WASM (FASTER on dense data)
//       ndmax 24:            JS ~0.6–0.9× WASM (≈parity)
//       ndmax 60 (solve-bound): JS ~0.7× WASM (WASM still wins the big dense solve)
//     Crossover ≈ ndmax 24; production resource estimation (ndmax 8–24) favours JS.
//   • Deopts are warmup/GC artifacts (tenuring, weak-object clearing, first-call type
//     feedback) + the cova-closure `wrong call target` (a per-call-closure / bench
//     artifact) — no steady-state hot-loop deopt. V8-winking holds once warm.
//   • Large-ndmax SOLVE is arithmetic-bound (O(neq³) dense GE), not allocation-bound
//     — an in-place solveGE measured NEUTRAL. So this is the kernel where atra/WASM
//     genuinely wins (compute-dense), and §8's per-kernel-by-shape model says route
//     it there. ROADMAP — but it must be BATCHED: a per-block atra call reincurs the
//     FFI boundary (millions of tiny calls = pure overhead, the thing the JS driver
//     avoids), so the win is either assembling many block systems in JS and solving
//     them in ONE atra call, or the whole-grid-loop-in-atra (= what kt3d/the atra fork
//     already are, and they DO win — once the fork's M>10⁴ scaling bug is fixed).
//     Wire it behind the backend seam (backend.js), shape-selected (small ndmax → JS,
//     large → batched atra). GPU (M-last) targets realize/aggregate for the 10M-block
//     tier (§8 — never the search).
//   • And krige() is CORRECT + robust at scale where the atra fork breaks, fully
//     gslib-decoupled — now also FASTER than WASM in the common case.
console.log('\nDeopt check: node --trace-deopt test/gsjs-perf.mjs 2>&1 | grep -i deopt | grep -iv "on stack replacement"');
