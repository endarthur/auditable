// @gcu/gsjs — M3c: the pure-JS kriging driver fed by the neighbourhood.
//
// SPEC-neigh §8 / §5.0(b): rather than spelunk the atra fork to decouple its inline
// search, gsjs grows its OWN kriging driver in JS — for each target the neighbourhood
// (select()) picks the samples, then this builds + solves the small dense kriging
// system here (cova3 ported to JS, a Gaussian-elimination solve), producing the same
// BlockEstimateTensor realize() consumes. Consequences:
//   - the rich neighbourhood (sectors / per-hole / bench / conventions) now drives
//     a real estimate — any sample set the policies return just works;
//   - everything stays in ORIGINAL sample order (the super-block permutation issue
//     §4.1 flagged simply doesn't arise — tensor.indices index the original data);
//   - it decouples from gslib's wasm kriging while staying validated against it: with
//     faithful:true + a moving ellipsoid, select() reproduces srchsupr's set and the
//     estimates match gslib.kt3d to tolerance (§8: bit-identical SELECTION, tolerance-
//     equal estimates). Swap a measured hot loop to atra/WASM later if needed.
//
// OK + SK; point or block kriging (block = discretized RHS + block-block cbb).
// Spec: spec_inbox/SPEC-neigh.md §5/§8.

import { setrot, sqdist, GSLIB_PI } from './orient.js';
import { createNeighborhood, indexSamples, select } from './neigh.js';
import { STATUS } from './realize.js';

const _VTYPE = {
  spherical: 1, exponential: 2, gaussian: 3, power: 4, hole: 5,
  sph: 1, exp: 2, gau: 3, pow: 4, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5,
};

// Port of gslib.cova3 (gslib.atra:546): variogram model → covariance evaluator.
// Each structure carries its own rotation (anisotropy); cmax is the sill (zero-lag
// covariance). Returns { cmax, cova(x1,y1,z1,x2,y2,z2) }.
function buildModel(variogram, pi) {
  const c0 = variogram.nugget || 0;
  const structs = (variogram.structures || []).map((s) => {
    const it = _VTYPE[s.type];
    if (it == null) throw new Error(`gsjs.krige: unknown variogram type '${s.type}'`);
    const aa = s.range;
    const rMinor = s.rangeMinor != null ? s.rangeMinor : aa;
    const rVert = s.rangeVert != null ? s.rangeVert : aa;
    return { it, cc: s.contribution, aa, rot: setrot(s.angle || 0, s.angle2 || 0, s.angle3 || 0, rMinor / aa, rVert / aa, pi) };
  });
  let cmax = c0;
  for (const s of structs) cmax += s.it === 4 ? 999 : s.cc;
  const cova = (x1, y1, z1, x2, y2, z2) => {  // eslint-disable-line no-shadow
    const hsq0 = sqdist(x1, y1, z1, x2, y2, z2, structs[0].rot);
    if (hsq0 < 1e-5) return cmax;                       // coincident → full sill
    let c = 0;
    for (let is = 0; is < structs.length; is++) {
      const s = structs[is];
      const h = Math.sqrt(is === 0 ? hsq0 : sqdist(x1, y1, z1, x2, y2, z2, s.rot));
      if (s.it === 1) { const hr = h / s.aa; if (hr < 1) c += s.cc * (1 - hr * (1.5 - 0.5 * hr * hr)); }
      else if (s.it === 2) c += s.cc * Math.exp(-3 * h / s.aa);
      else if (s.it === 3) c += s.cc * Math.exp(-3 * (h / s.aa) * (h / s.aa));
      else if (s.it === 4) c += cmax - s.cc * Math.pow(h, s.aa);
      else if (s.it === 5) c += s.cc * Math.cos(h / s.aa * 3.14159265);
    }
    return c;
  };
  return { cmax, cova, c0 };
}

// Discretization-point offsets relative to the block CENTRE, for a block of
// (bxsiz,bysiz,bzsiz) split nxdis×nydis×nzdis. (gsjs.discr/kt3d emit the same
// points in a block-CORNER frame, i.e. +bxsiz/2, and translate the samples to
// match; this driver works in absolute coords so it wants centre-relative offsets
// — the `tl*` value, without gslib's +0.5·bsiz corner shift.)
function discr(bxsiz, bysiz, bzsiz, nxdis, nydis, nzdis) {
  const xdis = bxsiz / Math.max(nxdis, 1), ydis = bysiz / Math.max(nydis, 1), zdis = bzsiz / Math.max(nzdis, 1);
  const pts = [];
  let tlx = -0.5 * (bxsiz + xdis);
  for (let ix = 0; ix < nxdis; ix++) {
    tlx += xdis;
    let tly = -0.5 * (bysiz + ydis);
    for (let iy = 0; iy < nydis; iy++) {
      tly += ydis;
      let tlz = -0.5 * (bzsiz + zdis);
      for (let iz = 0; iz < nzdis; iz++) {
        tlz += zdis;
        pts.push([tlx, tly, tlz]);   // centre-relative offset
      }
    }
  }
  return pts;
}

// Solve A·x = b for the n×n system (A flat row-major) by Gaussian elimination with
// partial pivoting — the ktsol stand-in. Returns { x, singular }. The OK system is
// symmetric indefinite (a saddle point), so a plain Cholesky won't do; GE handles it.
// (Tried an in-place variant to cut the per-block copy — measured neutral: the
// large-ndmax solve is arithmetic-bound, not allocation-bound. Kept the clean,
// non-mutating form.)
function solveGE(A, b, n) {
  const M = Float64Array.from(A), x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(M[col * n + col]);
    for (let r = col + 1; r < n; r++) { const v = Math.abs(M[r * n + col]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) return { x: null, singular: true };
    if (piv !== col) {
      for (let c = 0; c < n; c++) { const t = M[col * n + c]; M[col * n + c] = M[piv * n + c]; M[piv * n + c] = t; }
      const t = x[col]; x[col] = x[piv]; x[piv] = t;
    }
    const diag = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / diag;
      if (f !== 0) { for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c]; x[r] -= f * x[col]; }
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let c = r + 1; c < n; c++) s -= M[r * n + c] * x[c];
    x[r] = s / M[r * n + r];
  }
  return { x, singular: false };
}

// Resolve the target list + block-dimension CATEGORIES (the front doors mirror
// kriging(): grid | grid+mask | points). Returns:
//   pts        — target centres [[x,y,z],…]
//   tcat       — per-target category index
//   catDims    — per-category block dimensions [[dx,dy,dz],…] ([0,0,0] = point)
//   gridIndex  — original grid linear index per target (mask mode) or null
//   geom       — { grid } | { coords } for swath
function _targets(opts) {
  if (opts.points) {
    const p0 = opts.points, n = p0.length;
    const pts = p0.map((p) => [p[0], p[1], p[2]]);
    let catDims, tcat;
    if (opts.dimCategories && opts.cats) {              // explicit categories
      catDims = opts.dimCategories.map((d) => [d[0], d[1], d[2]]);
      tcat = opts.cats;
    } else if (p0[0].length >= 6) {                     // per-point dims → auto-categorize
      catDims = []; tcat = new Array(n);
      const key2cat = new Map();
      for (let i = 0; i < n; i++) {
        const key = p0[i][3] + ',' + p0[i][4] + ',' + p0[i][5];
        let c = key2cat.get(key);
        if (c == null) { c = catDims.length; key2cat.set(key, c); catDims.push([p0[i][3], p0[i][4], p0[i][5]]); }
        tcat[i] = c;
      }
    } else {                                            // shared block size (default point)
      const bs = opts.blockSize || [0, 0, 0];
      catDims = [[bs[0], bs[1], bs[2]]];
      tcat = new Array(n).fill(0);
    }
    return { pts, tcat, catDims, gridIndex: null, geom: { coords: pts } };
  }
  if (opts.grid) {
    const g = opts.grid;
    const nz = g.nz || 1, xsiz = g.xsiz || 1, ysiz = g.ysiz || 1, zsiz = g.zsiz || 1;
    const xmn = g.xmn != null ? g.xmn : xsiz / 2, ymn = g.ymn != null ? g.ymn : ysiz / 2, zmn = g.zmn != null ? g.zmn : zsiz / 2;
    const gg = { ...g, nz, xsiz, ysiz, zsiz, xmn, ymn, zmn };
    const catDims = [[xsiz, ysiz, zsiz]];
    if (opts.mask) {
      const m = opts.mask;
      const active = typeof m === 'function' ? m : (ix, iy, iz, x, y, z, idx) => !!m[idx];
      const pts = [], gridIndex = [];
      let idx = 0;
      for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++, idx++) {
        const x = xmn + ix * xsiz, y = ymn + iy * ysiz, z = zmn + iz * zsiz;
        if (active(ix, iy, iz, x, y, z, idx)) { pts.push([x, y, z]); gridIndex.push(idx); }
      }
      return { pts, tcat: new Array(pts.length).fill(0), catDims, gridIndex: Int32Array.from(gridIndex), geom: { coords: pts } };
    }
    const pts = [];
    for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < g.ny; iy++) for (let ix = 0; ix < g.nx; ix++) pts.push([xmn + ix * xsiz, ymn + iy * ysiz, zmn + iz * zsiz]);
    return { pts, tcat: new Array(pts.length).fill(0), catDims, gridIndex: null, geom: { grid: gg } };
  }
  throw new Error('gsjs.krige: provide points or grid');
}

// krige(opts) — kriging over a neighbourhood, in pure JS.
//   { data: [[x,y,z,value],...], variogram, search, ktype:'OK'|'SK', skmean?,
//     points | grid, discretization?:{nx,ny,nz}, blockSize?:[dx,dy,dz], faithful?, holeId? }
// discretization (+ block size from `grid` or `blockSize`) switches to block
// kriging; omitted → point kriging.
// `search` is the neighbourhood spec (radius/anis/angles/ndmin/ndmax + any policy:
// sectors / perHoleMax / minSampleDistance / convention / type:'bench'…). Returns a
// BlockEstimateTensor (indices in ORIGINAL data order; values = original data values)
// — feed straight to realize().
export function krige(opts) {
  const data = opts.data;
  const nd = data.length;
  const ktype = opts.ktype === 'SK' ? 0 : 1;            // 0 = SK, 1 = OK
  const mdt = ktype === 1 ? 1 : 0;
  const skmean = opts.skmean || 0;
  const wantDist = !!opts.distances;
  const pi = opts.faithful ? GSLIB_PI : Math.PI;
  const { cmax, cova, c0 } = buildModel(opts.variogram, pi);

  const disc = opts.discretization || {};
  const nxdis = disc.nx || 1, nydis = disc.ny || 1, nzdis = disc.nz || 1;

  const s = opts.search;
  const nbhd = createNeighborhood({
    radius: s.radius, radiusMinor: s.radiusMinor, radiusVert: s.radiusVert,
    angle: s.angle, angle2: s.angle2, angle3: s.angle3,
    convention: s.convention, dip: s.dip, dipAzimuth: s.dipAzimuth, pitch: s.pitch, rake: s.rake, azimuth: s.azimuth,
    ndmin: s.ndmin, ndmax: s.ndmax, sectors: s.sectors,
    perHoleMax: s.perHoleMax, minSampleDistance: s.minSampleDistance,
    type: s.type, benchThickness: s.benchThickness, faithful: opts.faithful,
  });
  indexSamples(nbhd, data, (row, k) => row[k], { holeId: opts.holeId });

  const { pts, tcat, catDims, geom, gridIndex } = _targets(opts);
  const ntarg = pts.length;
  const ncat = catDims.length;

  // disc-point offsets + block-block cbb are GEOMETRY-only → memoized per category
  // (shared = 1, sub-blocked = K, unique = N), so cost scales with distinct shapes.
  const catDiscOff = new Array(ncat), catCbb = new Array(ncat);
  for (let c = 0; c < ncat; c++) {
    const [dx, dy, dz] = catDims[c];
    const off = (dx > 0 || dy > 0 || dz > 0) ? discr(dx, dy, dz, nxdis, nydis, nzdis) : [[0, 0, 0]];
    catDiscOff[c] = off;
    let cbb = cmax;
    if (off.length > 1) {
      let acc = 0;
      for (let i = 0; i < off.length; i++) for (let j = 0; j < off.length; j++) {
        let cov = cova(off[i][0], off[i][1], off[i][2], off[j][0], off[j][1], off[j][2]);
        if (i === j) cov -= c0;
        acc += cov;
      }
      cbb = acc / (off.length * off.length);
    }
    catCbb[c] = cbb;
  }

  // per-target solve, collected then packed to a fixed stride K = max retained.
  const perTarget = new Array(ntarg);
  let K = 1;
  for (let t = 0; t < ntarg; t++) {
    const tx = pts[t][0], ty = pts[t][1], tz = pts[t][2];
    const sel = select(nbhd, [tx, ty, tz]);
    const na = sel.n;
    if (sel.status !== STATUS.OK) { perTarget[t] = { status: sel.status, na: 0 }; continue; }

    const discOff = catDiscOff[tcat[t]], ndb = discOff.length, cbb = catCbb[tcat[t]];
    const neq = mdt + na;
    const A = new Float64Array(neq * neq);
    const r = new Float64Array(neq);
    const dists = wantDist ? new Float64Array(na) : null;
    for (let i = 0; i < na; i++) {
      const si = sel.ranks[i], xi = data[si][0], yi = data[si][1], zi = data[si][2];
      if (wantDist) { const dx = xi - tx, dy = yi - ty, dz = zi - tz; dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz); }
      for (let j = i; j < na; j++) {
        const sj = sel.ranks[j];
        const cov = cova(xi, yi, zi, data[sj][0], data[sj][1], data[sj][2]);
        A[i * neq + j] = cov; A[j * neq + i] = cov;
      }
      // RHS: sample-to-block average covariance (point kriging → single centre point)
      if (ndb <= 1) {
        r[i] = cova(xi, yi, zi, tx, ty, tz);
      } else {
        let cb = 0;
        for (let d = 0; d < ndb; d++) {
          const dxp = tx + discOff[d][0], dyp = ty + discOff[d][1], dzp = tz + discOff[d][2];
          cb += cova(xi, yi, zi, dxp, dyp, dzp);
          const ex = xi - dxp, ey = yi - dyp, ez = zi - dzp;
          if (ex * ex + ey * ey + ez * ez < 1e-6) cb -= c0;   // self-correction (nugget)
        }
        r[i] = cb / ndb;
      }
    }
    if (mdt) { for (let i = 0; i < na; i++) { A[na * neq + i] = cmax; A[i * neq + na] = cmax; } r[na] = cmax; }

    const { x: sol, singular } = solveGE(A, r, neq);
    if (singular) { perTarget[t] = { status: STATUS.SINGULAR_SYSTEM, na: 0 }; continue; }
    let estv = cbb;                                     // block-block covariance
    for (let j = 0; j < neq; j++) estv -= sol[j] * r[j];
    perTarget[t] = { status: STATUS.OK, na, ranks: sel.ranks, weights: sol, kv: estv, dists };
    if (na > K) K = na;
  }

  // pack to the BlockEstimateTensor (padded to K).
  const indices = new Int32Array(ntarg * K);
  const weights = new Float64Array(ntarg * K);
  const n_actual = new Int32Array(ntarg);
  const kv = new Float64Array(ntarg);
  const status = new Uint8Array(ntarg).fill(STATUS.NOT_ATTEMPTED);
  const distances = wantDist ? new Float64Array(ntarg * K) : null;
  for (let t = 0; t < ntarg; t++) {
    const p = perTarget[t];
    status[t] = p.status;
    if (p.status !== STATUS.OK) continue;
    n_actual[t] = p.na; kv[t] = p.kv;
    for (let k = 0; k < p.na; k++) { indices[t * K + k] = p.ranks[k]; weights[t * K + k] = p.weights[k]; }
    if (wantDist) for (let k = 0; k < p.na; k++) distances[t * K + k] = p.dists[k];
  }

  return {
    indices, weights, n_actual, kv, status,
    distances,
    sk_mean: ktype === 0 ? skmean : null,
    values: Float64Array.from(data, (d) => d[3]),       // ORIGINAL order — indices reference this
    coords: pts, gridIndex, geom, K,
    n_targets: ntarg, n_blocks: ntarg, n_categories: ncat,
  };
}
