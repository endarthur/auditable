// @gcu/gsjs — experimental variography (the input to krige()'s variogram model).
//
// experimental(data, opts) computes the directional / downhole experimental
// semivariogram (and its relatives) over lag bins. It's a faithful port of GSLIB
// `gamv` (ext/gslib, the frozen oracle) — same pair loop, lag-tolerance binning,
// direction cosines, and per-`ivtype` finalizers — so it validates bit-for-bit
// against `gslib.gamv`. The ESTIMATOR is a pluggable reduction over the pair
// iteration (the hard part is gathering the pairs; the estimator just swaps the
// accumulator), so the whole menu costs almost nothing once the loop exists.
//
// `faithful: true` reproduces GSLIB's truncated π (3.14159265) for bit-identical
// parity; the default is accurate Math.PI (the krige() pattern — this is the modern
// library, the truncation is a 1990s Fortran artifact). The π only shifts direction-
// boundary membership by ~1e-9 rad, so for real-valued coordinates the two agree.

import { KDTree } from '../../scitra/src/spatial/kdtree.js';   // inlined by build.js (the neigh.js pattern)

export const GAMV_PI = 3.14159265;   // GSLIB gamv's literal (distinct from setrot's 3.141592654)

// ── estimators: a reduction over pairs. `contrib(vrh, vrt)` returns the per-pair
// gam increment (or null to SKIP the pair — pairwise/log guard near zero), and
// `finalize(g, hm, tm, hv, tv, np)` turns the accumulated MEANS into γ. `hv`/`tv`
// (head/tail second moments) are only accumulated when `moments` is set. Names +
// formulas track GSLIB `gamv` ivtypes where one exists (oracle in parens). ──
const SQRT = Math.sqrt, ABS = Math.abs, LN = Math.log;
export const ESTIMATORS = {
  matheron:         { contrib: (h, t) => (h - t) * (h - t),                                   finalize: (g) => 0.5 * g },                                                   // ivtype 1
  madogram:         { contrib: (h, t) => ABS(h - t),                                          finalize: (g) => 0.5 * g },                                                   // ivtype 8
  covariance:       { contrib: (h, t) => h * t,                                               finalize: (g, hm, tm) => g - hm * tm },                                       // ivtype 3
  correlogram:      { contrib: (h, t) => h * t, moments: true,                                finalize: (g, hm, tm, hv, tv) => { const sh = SQRT(Math.max(hv - hm * hm, 0)), st = SQRT(Math.max(tv - tm * tm, 0)); return sh * st < 1e-10 ? 0 : (g - hm * tm) / (sh * st); } }, // ivtype 4
  generalRelative:  { contrib: (h, t) => (h - t) * (h - t),                                   finalize: (g, hm, tm) => { const a = 0.5 * (hm + tm); const a2 = a * a; return a2 < 1e-10 ? 0 : g / a2; } }, // ivtype 5
  pairwiseRelative: { contrib: (h, t) => (ABS(t + h) > 1e-10 ? (2 * (t - h) / (t + h)) ** 2 : null), finalize: (g) => 0.5 * g },                                            // ivtype 6
  logVariogram:     { contrib: (h, t) => (t > 1e-10 && h > 1e-10 ? (LN(t) - LN(h)) ** 2 : null),     finalize: (g) => 0.5 * g },                                            // ivtype 7
  // robust extras — no gamv oracle (hand-fixture validated):
  cressie:          { contrib: (h, t) => SQRT(ABS(h - t)),                                    finalize: (g, hm, tm, hv, tv, np) => 0.5 * (g ** 4) / (0.457 + 0.494 / np + 0.045 / (np * np)) }, // Cressie-Hawkins
  rodogram:         { contrib: (h, t) => SQRT(ABS(h - t)),                                    finalize: (g) => 0.5 * g },
};

// Resolve a direction spec to the precomputed unit vectors + tolerances gamv uses.
// `mode: 'downhole'` → omnidirectional + same-hole filter (closest-spaced, the nugget
// direction). Otherwise { azimuth, dip, atol, dtol, bandwidthH, bandwidthV }.
function _resolveDir(d, DEG) {
  const downhole = d.mode === 'downhole';
  const azm = downhole ? 0 : (d.azimuth || 0);
  const dip = downhole ? 0 : (d.dip || 0);
  const atol = downhole ? 90 : (d.atol != null ? d.atol : 90);
  const dtol = downhole ? 90 : (d.dtol != null ? d.dtol : 90);
  const azmuth = (90 - azm) * DEG, declin = (90 - dip) * DEG;
  return {
    name: d.name || (downhole ? 'downhole' : `az${azm}_dip${dip}`),
    sameHole: downhole,
    uvxazm: Math.cos(azmuth), uvyazm: Math.sin(azmuth),
    uvzdec: Math.cos(declin), uvhdec: Math.sin(declin),
    csatol: Math.cos((atol <= 0 ? 45 : atol) * DEG),
    csdtol: Math.cos((dtol <= 0 ? 45 : dtol) * DEG),
    bandwh: d.bandwidthH != null ? d.bandwidthH : 1e21,
    bandwd: d.bandwidthV != null ? d.bandwidthV : 1e21,
    omni: atol >= 90,
    azm, dip,
  };
}

// experimental(data, opts) — data: [[x, y, z, value], ...] (or [[x, y, value], ...]).
//   opts = {
//     holeId,                              // parallel array (drillhole BHID) — for downhole dirs
//     lags: { size, n, tolerance? },       // global lag binning (tolerance defaults size/2)
//     directions: [ {name, azimuth, dip, atol?, dtol?, bandwidthH?, bandwidthV?}
//                 | {name?, mode:'downhole'} ],
//     estimator: 'matheron',               // any key of ESTIMATORS
//     trim: { min?, max? }, faithful?
//   }
// Returns { estimator, directions: [{ name, azm, dip, lags: [{ h, gamma, npair, hm, tm }] }] }
//   where lags is indexed by GSLIB lag bin (0 = coincident; il≥1 centred at (il−1)·size).
export function experimental(data, opts) {
  const nd = data.length;
  const is3d = data[0] && data[0].length > 3;
  const X = new Float64Array(nd), Y = new Float64Array(nd), Z = new Float64Array(nd), V = new Float64Array(nd);
  for (let i = 0; i < nd; i++) {
    const d = data[i];
    X[i] = d[0]; Y[i] = d[1];
    if (is3d) { Z[i] = d[2]; V[i] = d[3]; } else { Z[i] = 0; V[i] = d[2]; }
  }
  const holeId = opts.holeId || null;

  const L = opts.lags || {};
  const xlag = L.size, nlag = L.n;
  const xltol = L.tolerance != null && L.tolerance > 0 ? L.tolerance : 0.5 * xlag;
  const nlp2 = nlag + 2;
  const dismxs = ((nlag + 0.5 - 1e-10) * xlag) ** 2;

  const est = ESTIMATORS[opts.estimator || 'matheron'];
  if (!est) throw new Error(`gsjs.experimental: unknown estimator '${opts.estimator}'`);
  const wantMoments = !!est.moments;

  const trim = opts.trim || {};
  const tmin = trim.min != null ? trim.min : -1e21;
  const tmax = trim.max != null ? trim.max : 1e21;
  const DEG = (opts.faithful ? GAMV_PI : Math.PI) / 180;

  const dirSpecs = opts.directions || [{ azimuth: 0, atol: 90 }];
  const dirs = dirSpecs.map((d) => _resolveDir(d, DEG));
  const ndir = dirs.length;
  if (dirs.some((d) => d.sameHole) && !holeId) throw new Error('gsjs.experimental: downhole direction needs opts.holeId');

  // accumulators per [dir][lag]: np, dis, gam, hm, tm, hv, tv
  const sz = ndir * nlp2;
  const np = new Float64Array(sz), dis = new Float64Array(sz), gam = new Float64Array(sz);
  const hm = new Float64Array(sz), tm = new Float64Array(sz), hv = new Float64Array(sz), tv = new Float64Array(sz);
  const contrib = est.contrib;

  for (let i = 0; i < nd; i++) {
    for (let j = i; j < nd; j++) {
      const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i];
      const dxs = dx * dx, dys = dy * dy, dzs = dz * dz;
      let hsq = dxs + dys + dzs;
      if (hsq > dismxs) continue;
      if (hsq < 0) hsq = 0;
      const h = SQRT(hsq);

      // lag bins (overlapping when xltol > xlag/2): coincident → 0, else centred at (il−1)·xlag
      let lagbeg = -1, lagend = -1;
      if (h <= 1e-10) { lagbeg = 0; lagend = 0; }
      else {
        for (let il = 1; il < nlp2; il++) {
          const c = xlag * (il - 1);
          if (h >= c - xltol && h <= c + xltol) { if (lagbeg < 0) lagbeg = il; lagend = il; }
        }
      }
      if (lagend < 0) continue;

      for (let id = 0; id < ndir; id++) {
        const D = dirs[id];
        if (D.sameHole && holeId[i] !== holeId[j]) continue;

        let dxy = SQRT(Math.max(dxs + dys, 0));
        const dcazm = dxy < 1e-10 ? 1 : (dx * D.uvxazm + dy * D.uvyazm) / dxy;
        if (ABS(dcazm) < D.csatol) continue;
        if (ABS(D.uvxazm * dy - D.uvyazm * dx) > D.bandwh) continue;       // horizontal bandwidth
        if (dcazm < 0) dxy = -dxy;
        const dcdec = lagbeg === 0 ? 0 : (dxy * D.uvhdec + dz * D.uvzdec) / h;
        if (!(lagbeg === 0 || ABS(dcdec) >= D.csdtol)) continue;
        if (ABS(D.uvhdec * dz - D.uvzdec * dxy) > D.bandwd) continue;       // vertical bandwidth

        // tail/head by direction sign (symmetric estimators: only affects which mean is head/tail)
        let vrh, vrt, vrhpr, vrtpr;
        if (dcazm >= 0 && dcdec >= 0) { vrh = V[i]; vrt = V[j]; vrtpr = V[i]; vrhpr = V[j]; }
        else { vrh = V[j]; vrt = V[i]; vrtpr = V[j]; vrhpr = V[i]; }
        if (vrt < tmin || vrh < tmin || vrt > tmax || vrh > tmax) continue;

        const g0 = contrib(vrh, vrt);
        const g1 = D.omni ? contrib(vrhpr, vrtpr) : undefined;
        for (let il = lagbeg; il <= lagend; il++) {
          const ii = id * nlp2 + il;
          if (g0 != null) {
            np[ii] += 1; dis[ii] += h; hm[ii] += vrh; tm[ii] += vrt; gam[ii] += g0;
            if (wantMoments) { hv[ii] += vrh * vrh; tv[ii] += vrt * vrt; }
          }
          if (D.omni && g1 != null) {
            np[ii] += 1; dis[ii] += h; hm[ii] += vrhpr; tm[ii] += vrtpr; gam[ii] += g1;
            if (wantMoments) { hv[ii] += vrhpr * vrhpr; tv[ii] += vrtpr * vrtpr; }
          }
        }
      }
    }
  }

  // finalize: means then the estimator's γ
  const out = [];
  const fin = est.finalize;
  for (let id = 0; id < ndir; id++) {
    const lags = [];
    for (let il = 0; il < nlp2; il++) {
      const ii = id * nlp2 + il, n = np[ii];
      if (n > 0) {
        const mh = hm[ii] / n, mt = tm[ii] / n, mhv = hv[ii] / n, mtv = tv[ii] / n;
        lags.push({ h: dis[ii] / n, gamma: fin(gam[ii] / n, mh, mt, mhv, mtv, n), npair: n, hm: mh, tm: mt });
      } else {
        lags.push({ h: 0, gamma: 0, npair: 0, hm: 0, tm: 0 });
      }
    }
    out.push({ name: dirs[id].name, azm: dirs[id].azm, dip: dirs[id].dip, lags });
  }
  return { estimator: opts.estimator || 'matheron', directions: out };
}

// ── the lag-vector volume — the precompute-once / sweep-cheap substrate (SPEC §2.2) ──
//
// A `lag-bin × direction-cell` grid of per-cell running SUMS (memory bounded by
// RESOLUTION, not N — pairs are consumed, never stored). Lag bins use the exact GSLIB
// binning (lag axis exact); direction cells are an azimuth×dip tessellation. Filled
// kd-tree-bounded (O(N·k), not O(N²)) and built for ONE estimator. It's a mergeable
// bounded accumulator (per-cell sums add → parallel/streaming free; the sluice pattern).
//
// buildLagVolume(data, opts) — opts as experimental()'s, plus { azBins=36, dipBins=18,
//   sameHoleOnly?, faithful? }. Returns an opaque volume (Float64Array cells + metadata).
const _ACC = 7;   // per cell: np, Σdist, Σγ-contrib, Σhead, Σtail, Σhead², Σtail²

export function buildLagVolume(data, opts) {
  const nd = data.length, is3d = data[0] && data[0].length > 3;
  const X = new Float64Array(nd), Y = new Float64Array(nd), Z = new Float64Array(nd), V = new Float64Array(nd);
  for (let i = 0; i < nd; i++) { const d = data[i]; X[i] = d[0]; Y[i] = d[1]; if (is3d) { Z[i] = d[2]; V[i] = d[3]; } else { Z[i] = 0; V[i] = d[2]; } }
  const holeId = opts.holeId || null;
  const sameHole = !!opts.sameHoleOnly;
  if (sameHole && !holeId) throw new Error('gsjs.buildLagVolume: sameHoleOnly needs opts.holeId');

  const L = opts.lags || {};
  const xlag = L.size, nlag = L.n;
  const xltol = L.tolerance != null && L.tolerance > 0 ? L.tolerance : 0.5 * xlag;
  const nlb = nlag + 1;                                   // lag bins 0..nlag (centre lb·xlag), coincident dropped
  const maxlag = (nlag + 0.5) * xlag;                     // gather radius
  const nazi = opts.azBins || 36;
  const ndip = is3d ? (opts.dipBins || 18) : 1;
  const dcell = nazi * ndip;
  const est = ESTIMATORS[opts.estimator || 'matheron'];
  if (!est) throw new Error(`gsjs.buildLagVolume: unknown estimator '${opts.estimator}'`);
  const contrib = est.contrib, wantMoments = !!est.moments;

  const cells = new Float64Array(nlb * dcell * _ACC);
  const TWO_PI = 2 * Math.PI, HALF_PI = Math.PI / 2;

  // kd-tree over raw coords (isotropic gather to maxlag, then exact distance/direction)
  const flat = new Float64Array(nd * 3);
  for (let i = 0; i < nd; i++) { flat[i * 3] = X[i]; flat[i * 3 + 1] = Y[i]; flat[i * 3 + 2] = Z[i]; }
  const tree = new KDTree({ data: flat, shape: [nd, 3] });
  const r = maxlag * (1 + 1e-9);

  for (let i = 0; i < nd; i++) {
    const nb = tree.query_ball_point([X[i], Y[i], Z[i]], r);
    for (let q = 0; q < nb.length; q++) {
      const j = nb[q];
      if (j <= i) continue;                                // each unordered pair once
      if (sameHole && holeId[i] !== holeId[j]) continue;
      const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i];
      const h = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (h <= 1e-10 || h > maxlag) continue;
      const g = contrib(V[i], V[j]);                       // all estimator contribs are symmetric in (h,t)
      if (g == null) continue;
      // accumulate SYMMETRICALLY (both orientations, as gamv omni does) so head/tail means are
      // symmetric → omni extraction is exact for the moment-using estimators (covariance/correlogram)
      // too, not just the difference-based ones.
      const vh = V[i], vt = V[j], sumV = vh + vt, sumV2 = vh * vh + vt * vt;
      const g2 = 2 * g, h2 = 2 * h;
      // direction cell (azimuth clockwise from N, dip above horizontal)
      const dxy = Math.sqrt(dx * dx + dy * dy);
      let azi = Math.atan2(dx, dy); if (azi < 0) azi += TWO_PI;
      const dip = Math.atan2(dz, dxy);
      let azb = (azi / (TWO_PI / nazi)) | 0; if (azb >= nazi) azb = nazi - 1;
      let dpb = ndip === 1 ? 0 : ((dip + HALF_PI) / (Math.PI / ndip)) | 0; if (dpb >= ndip) dpb = ndip - 1; if (dpb < 0) dpb = 0;
      const dc = dpb * nazi + azb;
      // exact GSLIB lag bins (overlapping when xltol > xlag/2)
      for (let lb = 0; lb < nlb; lb++) {
        if (Math.abs(h - lb * xlag) <= xltol) {
          const b = (lb * dcell + dc) * _ACC;
          cells[b] += 2; cells[b + 1] += h2; cells[b + 2] += g2; cells[b + 3] += sumV; cells[b + 4] += sumV;
          if (wantMoments) { cells[b + 5] += sumV2; cells[b + 6] += sumV2; }
        }
      }
    }
  }

  // per direction-cell centre unit vector (for the extraction cone)
  const dirVec = new Float64Array(dcell * 3);
  for (let dpb = 0; dpb < ndip; dpb++) for (let azb = 0; azb < nazi; azb++) {
    const ac = (azb + 0.5) * (TWO_PI / nazi);
    const dpc = ndip === 1 ? 0 : (-HALF_PI + (dpb + 0.5) * (Math.PI / ndip));
    const cd = Math.cos(dpc), k = (dpb * nazi + azb) * 3;
    dirVec[k] = Math.sin(ac) * cd; dirVec[k + 1] = Math.cos(ac) * cd; dirVec[k + 2] = Math.sin(dpc);
  }
  return { cells, nlb, dcell, nazi, ndip, xlag, nlag, estimator: opts.estimator || 'matheron', dirVec, is3d };
}

// directionalVariogram(volume, { azimuth, dip, atol, dtol }) — integrate the volume into a
// per-lag variogram using GSLIB gamv's selection (separate azimuth + dip wedges, NOT a single
// cone — so the sweep and the pinned exact value agree). OMNI (atol ≥ 90 & dtol ≥ 90) is exact
// (= experimental() omni γ; all cells, lag axis exact). Directional is the approximate live-
// sweep result (whole cells in/out) — converges with cell resolution; pin via experimental().
export function directionalVariogram(vol, dir) {
  const { cells, nlb, dcell, xlag, estimator, dirVec } = vol;
  const est = ESTIMATORS[estimator], fin = est.finalize;
  const DEG = Math.PI / 180;
  const azm = dir.azimuth || 0, dip = dir.dip || 0;
  const atol = dir.atol != null ? dir.atol : 90, dtol = dir.dtol != null ? dir.dtol : 90;
  const azmuth = (90 - azm) * DEG, declin = (90 - dip) * DEG;
  const uvxazm = Math.cos(azmuth), uvyazm = Math.sin(azmuth), uvzdec = Math.cos(declin), uvhdec = Math.sin(declin);
  const csatol = Math.cos((atol <= 0 ? 45 : atol) * DEG), csdtol = Math.cos((dtol <= 0 ? 45 : dtol) * DEG);
  // qualify each direction cell by gamv's dcazm/dcdec wedge tests on its centre vector
  const qual = new Uint8Array(dcell);
  for (let c = 0; c < dcell; c++) {
    const cx = dirVec[c * 3], cy = dirVec[c * 3 + 1], cz = dirVec[c * 3 + 2];
    let dxy = Math.sqrt(cx * cx + cy * cy);
    const dcazm = dxy < 1e-10 ? 1 : (cx * uvxazm + cy * uvyazm) / dxy;
    if (Math.abs(dcazm) < csatol) continue;
    if (dcazm < 0) dxy = -dxy;
    const dcdec = dxy * uvhdec + cz * uvzdec;            // |centre| = 1
    if (Math.abs(dcdec) < csdtol) continue;
    qual[c] = 1;
  }

  const lags = [];
  for (let lb = 0; lb < nlb; lb++) {
    let np = 0, sd = 0, sg = 0, sh = 0, st = 0, shv = 0, stv = 0;
    for (let c = 0; c < dcell; c++) {
      if (!qual[c]) continue;
      const b = (lb * dcell + c) * _ACC, n = cells[b];
      if (n === 0) continue;
      np += n; sd += cells[b + 1]; sg += cells[b + 2]; sh += cells[b + 3]; st += cells[b + 4]; shv += cells[b + 5]; stv += cells[b + 6];
    }
    if (np > 0) { const mh = sh / np, mt = st / np; lags.push({ h: sd / np, gamma: fin(sg / np, mh, mt, shv / np, stv / np, np), npair: np }); }
    else lags.push({ h: lb * xlag, gamma: 0, npair: 0 });
  }
  return { lags };
}

// mergeLagVolumes(a, b) — sum two compatible volumes (the mergeable-accumulator contract:
// parallel/streaming fill produces partials that combine by adding per-cell sums).
export function mergeLagVolumes(a, b) {
  if (a.cells.length !== b.cells.length || a.nlb !== b.nlb || a.dcell !== b.dcell) throw new Error('gsjs.mergeLagVolumes: incompatible volumes');
  const cells = new Float64Array(a.cells.length);
  for (let i = 0; i < cells.length; i++) cells[i] = a.cells[i] + b.cells[i];
  return { ...a, cells };
}

// ── fitModel — the CONSERVATIVE auto-fit SEED (SPEC §2.5) ──
//
// A careful starting point that embodies good practice and is honest about being a seed:
// nugget from the downhole variogram (not a global lstsq), a settable sill (never guessed),
// one free parameter per direction (the range), linked across directions, and a REPORT with
// warnings so the fit is judgeable — never a silent black box. It seeds the slider refinement;
// the human is the ceiling.

const _SHAPES = {
  spherical: (t) => (t >= 1 ? 1 : 1.5 * t - 0.5 * t * t * t),
  exponential: (t) => 1 - Math.exp(-3 * t),                  // practical range at a (1−e⁻³ ≈ 0.95)
  gaussian: (t) => 1 - Math.exp(-3 * t * t),
};

// nugget = intercept at h=0 of a pair-count-weighted line through the first few downhole lags.
function _nuggetFromDownhole(lags, k) {
  const pts = lags.filter((l) => l.npair > 0 && l.h > 0).slice(0, k || 3);
  if (pts.length === 0) return { nugget: 0, sparse: true };
  if (pts.length === 1) return { nugget: Math.max(0, pts[0].gamma), sparse: true };
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { const w = p.npair; sw += w; sx += w * p.h; sy += w * p.gamma; sxx += w * p.h * p.h; sxy += w * p.h * p.gamma; }
  const den = sw * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return { nugget: Math.max(0, sy / sw), sparse: true };
  const b = (sw * sxy - sx * sy) / den, a = (sy - b * sx) / sw;
  return { nugget: Math.max(0, a), sparse: pts.length < 3 };
}

// fit ONE structure's range (1 free param) to a direction by pair-count-weighted WLS — a
// bounded grid scan (robust, no opaque optimiser), returning the range + RMS weighted residual.
function _fitRange(lags, nugget, contribution, shape) {
  const pts = lags.filter((l) => l.npair > 0 && l.h > 0);
  if (pts.length === 0) return { range: NaN, residual: NaN, reached: false };
  let maxH = 0, maxG = 0; for (const p of pts) { if (p.h > maxH) maxH = p.h; if (p.gamma > maxG) maxG = p.gamma; }
  const rMin = maxH / 100, rMax = maxH * 3, N = 240;
  let bestR = rMin, bestE = Infinity;
  for (let i = 0; i <= N; i++) {
    const r = rMin + (rMax - rMin) * i / N;
    let e = 0, w = 0;
    for (const p of pts) { const m = nugget + contribution * shape(p.h / r); const d = p.gamma - m; e += p.npair * d * d; w += p.npair; }
    e /= w;
    if (e < bestE) { bestE = e; bestR = r; }
  }
  return { range: bestR, residual: Math.sqrt(bestE), reached: maxG >= 0.8 * (nugget + contribution) };
}

// fitModel(experimental, opts) → { model?, fit, report }
//   opts = { sill?, nugget?: 'downhole'|number, downhole?: dirName, maxNuggetFraction?=1,
//            type?='spherical', roles?: { major, semi, minor }, orientation? }
export function fitModel(experimental, opts = {}) {
  const dirs = experimental.directions;
  const warnings = [];
  const type = opts.type || 'spherical';
  const shape = _SHAPES[type];
  if (!shape) throw new Error(`gsjs.fitModel: unknown structure type '${type}'`);

  // sill — a settable INPUT; only estimated (flagged) as a last resort
  let sill = opts.sill, sillEstimated = false;
  if (sill == null) {
    let s = 0, n = 0;
    for (const d of dirs) { const ls = d.lags.filter((l) => l.npair > 0); for (const l of ls.slice(Math.max(0, ls.length - 3))) { s += l.gamma; n++; } }
    sill = n ? s / n : 1; sillEstimated = true; warnings.push('sill-estimated');
  }

  // nugget — from the downhole variogram (or fixed), capped by maxNuggetFraction
  let nugget;
  if (typeof opts.nugget === 'number') nugget = opts.nugget;
  else {
    const dh = dirs.find((d) => d.name === (opts.downhole || 'downhole'));
    if (!dh) { nugget = 0; warnings.push('no-downhole-nugget-zero'); }
    else {
      const r = _nuggetFromDownhole(dh.lags); nugget = r.nugget; if (r.sparse) warnings.push('sparse-downhole');
      // unreliable anchor: the first downhole lag is already near the sill (lags too coarse to
      // resolve the near-0 rise) → the extrapolated nugget overshoots. Warn, don't pretend.
      const first = dh.lags.find((l) => l.npair > 0 && l.h > 0);
      if (first && sill > 0 && first.gamma > 0.6 * sill) warnings.push('coarse-downhole');
    }
  }
  const cap = (opts.maxNuggetFraction != null ? opts.maxNuggetFraction : 1) * sill;
  if (nugget > cap) { nugget = cap; warnings.push('nugget-capped'); }
  if (nugget < 0) nugget = 0;
  const contribution = Math.max(sill - nugget, 0);
  const nuggetFraction = sill > 0 ? nugget / sill : 0;
  if (nuggetFraction > 0.5) warnings.push('high-nugget');
  if (contribution < 0.01 * sill) warnings.push('pure-nugget');

  // one range per direction (linked: shared nugget/sill/type/contribution)
  const fitDirs = dirs.map((d) => {
    const { range, residual, reached } = _fitRange(d.lags, nugget, contribution, shape);
    if (!reached) warnings.push(`no-sill-reached:${d.name}`);
    if (sill > 0 && residual > 0.3 * sill) warnings.push(`poor-fit:${d.name}`);
    const npairs = d.lags.reduce((s, l) => s + l.npair, 0);
    return { name: d.name, azm: d.azm, dip: d.dip, range, contribution, residual, npairs };
  });

  const fit = { nugget, sill, type, estimator: experimental.estimator, directions: fitDirs };
  const report = { nuggetFraction, sillEstimated, warnings: [...new Set(warnings)] };

  // optional model assembly (orientation is the structural step — given roles + orientation)
  let model;
  if (opts.roles) {
    const byName = (n) => fitDirs.find((d) => d.name === n);
    const maj = byName(opts.roles.major), sem = byName(opts.roles.semi), min = byName(opts.roles.minor);
    if (maj && sem && min) {
      model = {
        c0: nugget,
        structures: [{
          type, cc: contribution, aa: maj.range,
          anis: [sem.range / maj.range, min.range / maj.range],
          ...(opts.orientation ? { convention: opts.orientation.convention || 'structural', orientation: opts.orientation } : { ang: [maj.azm, maj.dip, 0] }),
        }],
      };
    }
  }
  return { model, fit, report };
}
