// @gcu/condenser — grid compatibility + volume-weighted resample (micro join).
//
// A regular grid axis = { origin, pitch, count }, origin = block-0 CENTROID
// (condenser convention). Cell i spans world [origin+(i-0.5)·pitch,
// origin+(i+0.5)·pitch].
//
// Two grids are COMPATIBLE (per axis) when they share a common lattice
// g = gcd(pitchA, pitchB) (both pitches integer multiples of g) AND their
// origins are phase-aligned on g (offset an integer multiple of g). Then every
// cell decomposes exactly into g-cells and a source→target resample is EXACT
// (integer g-unit overlap weights, no float fuzz):
//   - source coarser than target → refine-replicate,
//   - source finer  → aggregate,
//   - non-nested but common-lattice (e.g. 10 & 12 on g=2) → exact mixed weights.
// Incompatible (no small common lattice, or off-phase) → refused with a reason.
//
// v1: axis-aligned grids. Rotated grids must share azimuth (not modelled here).

const REL = 1e-6;                                          // relative tolerance

// tolerant Euclidean gcd of two positive floats
export function floatGcd(a, b, tol) {
  a = Math.abs(a); b = Math.abs(b);
  if (a < b) { const t = a; a = b; b = t; }
  let guard = 0;
  while (b > tol && guard++ < 1000) { const r = a % b; a = b; b = r; }
  return a;
}

// Per-axis source→target overlap map. Returns { ok, reason } or
// { ok:true, g, sp, tp, map:[[{t,w}...] per source index], nested }.
// map[si] = target cells overlapping source cell si, w = overlap in g-units.
export function axisMap(src, tgt, opts = {}) {
  // degenerate (single-plane) axis: trivial pass-through
  if (src.count === 1 && tgt.count === 1) return { ok: true, g: 1, sp: 1, tp: 1, map: [[{ t: 0, w: 1 }]], nested: true };
  if (!(src.pitch > 0) || !(tgt.pitch > 0)) return { ok: false, reason: 'a single-plane axis cannot join a multi-cell axis' };
  const tol = opts.tol || REL * Math.max(src.pitch, tgt.pitch, 1);
  const g = floatGcd(src.pitch, tgt.pitch, tol);
  if (!(g > tol)) return { ok: false, reason: 'no common lattice (pitches share no usable factor)' };
  const sp = Math.round(src.pitch / g), tp = Math.round(tgt.pitch / g);
  const capped = opts.cap || 4096;
  if (sp > capped || tp > capped) return { ok: false, reason: `pitches ${src.pitch} and ${tgt.pitch} share no small common lattice (would need a ${g} unit grid)` };
  // g-units measured from the target lattice low face (cell-0 low boundary)
  const ref = tgt.origin - tgt.pitch / 2;
  const srcLow0 = src.origin - src.pitch / 2;
  const phaseF = (srcLow0 - ref) / g;
  if (Math.abs(phaseF - Math.round(phaseF)) > 1e-4) return { ok: false, reason: `origins off-phase by ${(+(phaseF - Math.round(phaseF)) * g).toFixed(4)} on the ${g} lattice` };
  const p0 = Math.round(phaseF);
  const map = new Array(src.count);
  for (let si = 0; si < src.count; si++) {
    const lo = p0 + si * sp, hi = lo + sp;
    const t0 = Math.floor(lo / tp), t1 = Math.floor((hi - 1) / tp);
    const lst = [];
    for (let ti = Math.max(0, t0); ti <= Math.min(tgt.count - 1, t1); ti++) {
      const ov = Math.min(hi, (ti + 1) * tp) - Math.max(lo, ti * tp);
      if (ov > 0) lst.push({ t: ti, w: ov });
    }
    map[si] = lst;
  }
  return { ok: true, g, sp, tp, map, nested: (sp % tp === 0 || tp % sp === 0) };
}

// Are two whole grids (each { x, y, z } of axes) compatible? → { ok, reason,
// axes:[ax,ay,az], nested }. Uses each axis as source vs the other as target
// (symmetric compatibility — direction doesn't change compatibility).
export function gridsCompatible(A, B, opts = {}) {
  const axes = [];
  let nested = true;
  for (const k of ['x', 'y', 'z']) {
    const m = axisMap(A[k], B[k], opts);
    if (!m.ok) return { ok: false, reason: `${k.toUpperCase()}: ${m.reason}` };
    axes.push(m); nested = nested && m.nested;
  }
  return { ok: true, axes, nested };
}

// Build a resampler from source axes → target axes. Returns { ok, reason } or a
// resampler with dense target accumulators. Numeric ops: mean (weighted), sum,
// count, coverage. Categorical: majority (weighted vote).
export function makeResampler(srcAxes, tgtAxes, opts = {}) {
  const X = axisMap(srcAxes.x, tgtAxes.x, opts);
  const Y = axisMap(srcAxes.y, tgtAxes.y, opts);
  const Z = axisMap(srcAxes.z, tgtAxes.z, opts);
  for (const [k, m] of [['X', X], ['Y', Y], ['Z', Z]]) if (!m.ok) return { ok: false, reason: `${k}: ${m.reason}` };
  const nx = tgtAxes.x.count, ny = tgtAxes.y.count, nz = tgtAxes.z.count;
  const cells = nx * ny * nz;
  const idxOf = (ti, tj, tk) => ti + nx * (tj + ny * tk);
  // full target-cell g-volume, for coverage (= tp_x·tp_y·tp_z)
  const fullW = X.tp * Y.tp * Z.tp;
  const nested = X.nested && Y.nested && Z.nested;
  return {
    ok: true, nx, ny, nz, cells, idxOf, fullW, nested, X, Y, Z,
    newAcc: () => ({ sum: new Float64Array(cells), w: new Float64Array(cells) }),
    // scatter one NUMERIC source cell (si,sj,sk index in the SOURCE lattice)
    scatter(si, sj, sk, v, wt, acc) {
      const xm = X.map[si], ym = Y.map[sj], zm = Z.map[sk];
      if (!xm || !ym || !zm) return;
      for (const { t: ti, w: wi } of xm) for (const { t: tj, w: wj } of ym) for (const { t: tk, w: wk } of zm) {
        const w = wi * wj * wk * wt; if (w <= 0) continue;
        const idx = idxOf(ti, tj, tk); acc.sum[idx] += v * w; acc.w[idx] += w;
      }
    },
    // finalize numeric → { out: Float64Array(cells), coverage: Float32Array, present: Uint8Array }
    finalize(acc, op = 'mean') {
      const out = new Float64Array(cells), coverage = new Float32Array(cells), present = new Uint8Array(cells);
      for (let i = 0; i < cells; i++) {
        const w = acc.w[i]; if (w <= 0) { out[i] = NaN; continue; }
        present[i] = 1; coverage[i] = Math.min(1, w / fullW);
        out[i] = op === 'sum' ? acc.sum[i] : op === 'count' ? acc.w[i] : op === 'coverage' ? coverage[i] : acc.sum[i] / w;   // mean default
      }
      return { out, coverage, present };
    },
    // categorical: separate vote accumulator (Map per touched cell)
    newCatAcc: () => new Map(),                             // idx → Map(code → weight)
    scatterCat(si, sj, sk, code, wt, votes) {
      const xm = X.map[si], ym = Y.map[sj], zm = Z.map[sk];
      if (!xm || !ym || !zm) return;
      for (const { t: ti, w: wi } of xm) for (const { t: tj, w: wj } of ym) for (const { t: tk, w: wk } of zm) {
        const w = wi * wj * wk * wt; if (w <= 0) continue;
        const idx = idxOf(ti, tj, tk);
        let m = votes.get(idx); if (!m) { m = new Map(); votes.set(idx, m); }
        m.set(code, (m.get(code) || 0) + w);
      }
    },
    finalizeCat(votes) {   // → { out: Int32Array(cells) of winning code (-1 empty), tie: Uint8Array }
      const out = new Int32Array(cells).fill(-1), tie = new Uint8Array(cells);
      for (const [idx, m] of votes) {
        let best = -1, bw = -1, tied = false;
        for (const [code, w] of m) { if (w > bw + 1e-9) { best = code; bw = w; tied = false; } else if (Math.abs(w - bw) <= 1e-9) tied = true; }
        out[idx] = best; tie[idx] = tied ? 1 : 0;
      }
      return { out, tie };
    },
  };
}

// Box → grid volume-weighted aggregator (sub-blocked reconcile). A sub-blocked
// model has no source LATTICE — it's a set of variable-size axis-aligned boxes.
// This scatters each box (world centroid + half-dims) onto a regular TARGET grid
// weighted by geometric OVERLAP VOLUME, so a sub-blocked model aggregates up to
// any compatible regular grid — the PARENT grid being the natural choice (each
// sub-block lands wholly in its parent cell). Reuses the same acc/finalize shape
// as makeResampler, so the reconcile Δ-map machinery is identical. The caller
// controls WHICH boxes scatter (a selection/filter): just skip the ones it wants
// excluded — volume weighting handles partial parent coverage correctly.
export function makeBoxAggregator(tgt, opts = {}) {
  const nx = tgt.x.count, ny = tgt.y.count, nz = tgt.z.count;
  const cells = nx * ny * nz;
  const idxOf = (ti, tj, tk) => ti + nx * (tj + ny * tk);
  // world volume of a full target cell (degenerate axes factor out as 1)
  const cellVol = ['x', 'y', 'z'].reduce((p, k) => p * (tgt[k].pitch > 0 ? tgt[k].pitch : 1), 1);
  // target cells overlapping world interval [lo,hi] on one axis → [{ i, ov }]
  const axisCells = (ax, lo, hi) => {
    if (!(ax.pitch > 0)) return [{ i: 0, ov: 1 }];           // single-plane axis: unit overlap (factors out)
    const low0 = ax.origin - ax.pitch / 2;
    const first = Math.floor((lo - low0) / ax.pitch);
    const last = Math.floor((hi - low0) / ax.pitch - 1e-9);
    const out = [];
    for (let i = Math.max(0, first); i <= Math.min(ax.count - 1, last); i++) {
      const cLo = low0 + i * ax.pitch, cHi = cLo + ax.pitch;
      const ov = Math.min(hi, cHi) - Math.max(lo, cLo);
      if (ov > 1e-12) out.push({ i, ov });
    }
    return out;
  };
  return {
    ok: true, nx, ny, nz, cells, idxOf, cellVol,
    newAcc: () => ({ sum: new Float64Array(cells), w: new Float64Array(cells) }),
    // scatter one box (world centroid cx,cy,cz + half-dims hx,hy,hz), value v,
    // extra weight wt (e.g. 0 to exclude). Accumulates v·overlapVol and overlapVol.
    scatterBox(cx, cy, cz, hx, hy, hz, v, wt, acc) {
      if (!(wt > 0) || !Number.isFinite(v)) return;
      const xs = axisCells(tgt.x, cx - hx, cx + hx);
      if (!xs.length) return;
      const ys = axisCells(tgt.y, cy - hy, cy + hy);
      if (!ys.length) return;
      const zs = axisCells(tgt.z, cz - hz, cz + hz);
      for (const X of xs) for (const Y of ys) for (const Z of zs) {
        const w = X.ov * Y.ov * Z.ov * wt; if (w <= 0) continue;
        const idx = idxOf(X.i, Y.i, Z.i); acc.sum[idx] += v * w; acc.w[idx] += w;
      }
    },
    // → { out: Float64Array (NaN where empty), coverage: Float32Array (w/cellVol),
    // present: Uint8Array }. op: 'mean' (default) | 'sum' | 'volume' | 'coverage'.
    finalize(acc, op = 'mean') {
      const out = new Float64Array(cells), coverage = new Float32Array(cells), present = new Uint8Array(cells);
      for (let i = 0; i < cells; i++) {
        const w = acc.w[i]; if (w <= 0) { out[i] = NaN; continue; }
        present[i] = 1; coverage[i] = cellVol > 0 ? Math.min(1, w / cellVol) : 1;
        out[i] = op === 'sum' ? acc.sum[i] : op === 'volume' ? w : op === 'coverage' ? coverage[i] : acc.sum[i] / w;
      }
      return { out, coverage, present };
    },
    // categorical: volume-weighted majority vote (parity with makeResampler)
    newCatAcc: () => new Map(),                              // idx → Map(code → volume)
    scatterCatBox(cx, cy, cz, hx, hy, hz, code, wt, votes) {
      if (!(wt > 0)) return;
      const xs = axisCells(tgt.x, cx - hx, cx + hx); if (!xs.length) return;
      const ys = axisCells(tgt.y, cy - hy, cy + hy); if (!ys.length) return;
      const zs = axisCells(tgt.z, cz - hz, cz + hz);
      for (const X of xs) for (const Y of ys) for (const Z of zs) {
        const w = X.ov * Y.ov * Z.ov * wt; if (w <= 0) continue;
        const idx = idxOf(X.i, Y.i, Z.i);
        let m = votes.get(idx); if (!m) { m = new Map(); votes.set(idx, m); }
        m.set(code, (m.get(code) || 0) + w);
      }
    },
    finalizeCat(votes) {
      const out = new Int32Array(cells).fill(-1), tie = new Uint8Array(cells);
      for (const [idx, m] of votes) {
        let best = -1, bw = -1, tied = false;
        for (const [code, w] of m) { if (w > bw + 1e-9) { best = code; bw = w; tied = false; } else if (Math.abs(w - bw) <= 1e-9) tied = true; }
        out[idx] = best; tie[idx] = tied ? 1 : 0;
      }
      return { out, tie };
    },
  };
}

// A common target lattice covering the union of N grids AND compatible with all.
// grids: [{x,y,z}]. resolution: 'finest' | 'coarsest' | 'gcd' | number(pitch,
// per-axis via {x,y,z}). Returns { ok, reason } or { x, y, z } target axes.
export function commonLattice(grids, opts = {}) {
  if (!grids.length) return { ok: false, reason: 'no grids' };
  const res = opts.resolution || 'finest';
  const out = {};
  for (const k of ['x', 'y', 'z']) {
    const ax = grids.map((G) => G[k]);
    const real = ax.filter((a) => a.pitch > 0);            // count-1 with a real pitch still counts
    if (!real.length) { out[k] = { origin: ax[0].origin, pitch: ax[0].pitch || 0, count: 1 }; continue; }
    const tol = REL * Math.max(...real.map((a) => a.pitch), 1);
    // common g across all real axes
    let g = real[0].pitch;
    for (const a of real) g = floatGcd(g, a.pitch, tol);
    if (!(g > tol)) return { ok: false, reason: `${k.toUpperCase()}: grids share no common lattice` };
    // all origins must share the same residue mod g (pairwise phase alignment)
    const low = (a) => a.origin - a.pitch / 2;
    const r0 = ((low(real[0]) % g) + g) % g;
    for (const a of real) {
      const r = ((low(a) % g) + g) % g;
      let d = Math.abs(r - r0); d = Math.min(d, g - d);
      if (d > 1e-4 + tol) return { ok: false, reason: `${k.toUpperCase()}: grids are off-phase (can't share a lattice)` };
    }
    // choose target pitch
    let tp;
    if (res === 'gcd') tp = g;
    else if (res === 'coarsest') tp = Math.max(...real.map((a) => a.pitch));
    else if (typeof res === 'object' && res && res[k] != null) tp = res[k];
    else if (typeof res === 'number') tp = res;
    else tp = Math.min(...real.map((a) => a.pitch));        // 'finest'
    const kk = Math.round(tp / g);
    if (Math.abs(kk * g - tp) > 1e-4 + tol || kk < 1) return { ok: false, reason: `${k.toUpperCase()}: resolution ${tp} is not a multiple of the common lattice ${g}` };
    tp = kk * g;
    // union extent (low faces / high faces)
    const uLo = Math.min(...ax.map((a) => a.origin - (a.pitch || 0) / 2));
    const uHi = Math.max(...ax.map((a) => a.origin + (a.count - 0.5) * (a.pitch || 0)));
    // anchor target low face at the shared residue near uLo
    const L = r0 + Math.floor((uLo - r0) / tp) * tp;
    const count = Math.max(1, Math.ceil((uHi - L) / tp - 1e-6));
    if (count > 65535) return { ok: false, reason: `${k.toUpperCase()}: ${count} cells at pitch ${tp} exceeds the grid limit` };
    out[k] = { origin: L + tp / 2, pitch: tp, count };
  }
  return { ok: true, ...out };
}
