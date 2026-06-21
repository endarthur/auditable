// @gcu/gsjs high-level API. The wasm runtime helpers (instantiate, alloc,
// write/read F64/I32, growMemory) come from ./_wasm.js — the generated module
// build.js emits from gslib.atra + gsjs.atra via atrac's bundleRecipe.
//
// kriging() mirrors @gcu/gslib's kt3d setup (memory, super-block search) but
// runs over a TARGET LIST with block-dimension CATEGORIES, and reads back the
// BlockEstimateTensor (per-target weights + sample indices + variance + status)
// instead of (est, estv). realize() (realize.js, the oracle) turns that into
// estimates. Three front doors:
//   kriging({ grid })                  — full regular grid (allocation-free)
//   kriging({ grid, mask })            — only active blocks (sparse output)
//   kriging({ points })                — arbitrary targets; per-point dims OK
//
// Scope v1: SK + OK. See spec_inbox/gsjs-SPEC.md. The public surface (realize,
// aggregations, backend, kriging, recipe, …) is assembled by src/main.js.

import { instantiate, alloc, writeF64, writeI32, readF64, readI32, growMemory } from './_wasm.js';

const _VARIO_TYPES = {
  spherical: 1, exponential: 2, gaussian: 3, power: 4, hole: 5,
  sph: 1, exp: 2, gau: 3, pow: 4, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5,
};

function _resolveGrid(g) {
  const nx = g.nx, ny = g.ny, nz = g.nz || 1;
  const xsiz = g.xsiz || 1, ysiz = g.ysiz || 1, zsiz = g.zsiz || 1;
  const xmn = g.xmn != null ? g.xmn : xsiz / 2;
  const ymn = g.ymn != null ? g.ymn : ysiz / 2;
  const zmn = g.zmn != null ? g.zmn : zsiz / 2;
  return { nx, ny, nz, xmn, ymn, zmn, xsiz, ysiz, zsiz, nxyz: nx * ny * nz };
}

function _parseVario(v) {
  const c0 = v.nugget || 0;
  const structs = v.structures || [];
  const nst = structs.length;
  const its = [], ccs = [], ranges = [], angs = [], ang2s = [], ang3s = [];
  const rangeMinors = [], rangeVerts = [];
  for (const s of structs) {
    const it = _VARIO_TYPES[s.type];
    if (it == null) throw new Error(`gsjs: unknown variogram type: ${s.type}`);
    its.push(it); ccs.push(s.contribution); ranges.push(s.range);
    angs.push(s.angle || 0); ang2s.push(s.angle2 || 0); ang3s.push(s.angle3 || 0);
    rangeMinors.push(s.rangeMinor != null ? s.rangeMinor : s.range);
    rangeVerts.push(s.rangeVert != null ? s.rangeVert : s.range);
  }
  return { nst, c0, its, ccs, ranges, angs, ang2s, ang3s, rangeMinors, rangeVerts };
}

// Resolve the target list + block-dimension categories from the opts. Returns
// the kernel inputs (gridmode/ntarg/tx/ty/tz/ncat/catd*/tcat) plus result
// metadata (coords, gridIndex, geometry for swath).
function _buildTargets(opts, g) {
  // ── full regular grid: generated on-the-fly in the kernel (no coord arrays) ──
  if (opts.grid && !opts.mask && !opts.points) {
    return {
      gridmode: 1, ntarg: g.nxyz,
      tx: [0], ty: [0], tz: [0], tcat: [0],
      catDims: [[g.xsiz, g.ysiz, g.zsiz]],
      coords: null, gridIndex: null, geom: { grid: g },
    };
  }

  // ── grid + mask: only active blocks become targets (sparse) ──
  if (opts.grid && opts.mask) {
    const m = opts.mask;
    const isActive = typeof m === 'function'
      ? (ix, iy, iz, x, y, z) => m(ix, iy, iz, x, y, z)
      : (ix, iy, iz, x, y, z, idx) => !!m[idx];
    const tx = [], ty = [], tz = [], gridIndex = [];
    let idx = 0;
    for (let iz = 0; iz < g.nz; iz++) {
      for (let iy = 0; iy < g.ny; iy++) {
        for (let ix = 0; ix < g.nx; ix++, idx++) {
          const x = g.xmn + ix * g.xsiz, y = g.ymn + iy * g.ysiz, z = g.zmn + iz * g.zsiz;
          if (isActive(ix, iy, iz, x, y, z, idx)) { tx.push(x); ty.push(y); tz.push(z); gridIndex.push(idx); }
        }
      }
    }
    const coords = new Float64Array(tx.length * 3);
    for (let i = 0; i < tx.length; i++) { coords[i * 3] = tx[i]; coords[i * 3 + 1] = ty[i]; coords[i * 3 + 2] = tz[i]; }
    return {
      gridmode: 0, ntarg: tx.length, tx, ty, tz, tcat: new Array(tx.length).fill(0),
      catDims: [[g.xsiz, g.ysiz, g.zsiz]],
      coords, gridIndex: Int32Array.from(gridIndex), geom: { coords },
    };
  }

  // ── arbitrary points: [x,y,z] | [x,y,z,dx,dy,dz], shared / explicit / auto-cat ──
  if (opts.points) {
    const pts = opts.points;
    const n = pts.length;
    const tx = new Array(n), ty = new Array(n), tz = new Array(n);
    const coords = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      tx[i] = pts[i][0]; ty[i] = pts[i][1]; tz[i] = pts[i][2];
      coords[i * 3] = tx[i]; coords[i * 3 + 1] = ty[i]; coords[i * 3 + 2] = tz[i];
    }
    let catDims, tcat;
    if (opts.dimCategories && opts.cats) {            // explicit categories
      catDims = opts.dimCategories.map((d) => [d[0], d[1], d[2]]);
      tcat = opts.cats;
    } else if (pts[0].length >= 6) {                  // per-point dims → auto-categorize
      catDims = []; tcat = new Array(n);
      const key2cat = new Map();
      for (let i = 0; i < n; i++) {
        const key = pts[i][3] + ',' + pts[i][4] + ',' + pts[i][5];
        let c = key2cat.get(key);
        if (c == null) { c = catDims.length; key2cat.set(key, c); catDims.push([pts[i][3], pts[i][4], pts[i][5]]); }
        tcat[i] = c;
      }
    } else {                                          // shared block size (default unit → point kriging w/ disc 1)
      const bs = opts.blockSize || [1, 1, 1];
      catDims = [[bs[0], bs[1], bs[2]]];
      tcat = new Array(n).fill(0);
    }
    return { gridmode: 0, ntarg: n, tx, ty, tz, tcat, catDims, coords, gridIndex: null, geom: { coords } };
  }

  throw new Error('gsjs.kriging: provide one of { grid } | { grid, mask } | { points }');
}

export function kriging(opts) {
  const data = opts.data;
  const nd = data.length;
  const g = _resolveGrid(opts.grid || { nx: 1, ny: 1, nz: 1 });
  const v = _parseVario(opts.variogram);
  const search = opts.search;
  const NDMAX = search.ndmax || Math.min(nd, 20);
  const NDMIN = search.ndmin || 1;
  const RADIUS = search.radius;
  const sang1 = search.angle || 0, sang2 = search.angle2 || 0, sang3 = search.angle3 || 0;
  const sRadMin = search.radiusMinor != null ? search.radiusMinor : RADIUS;
  const sRadVert = search.radiusVert != null ? search.radiusVert : RADIUS;
  const sanis1 = sRadMin / RADIUS, sanis2 = sRadVert / RADIUS;
  const disc = opts.discretization || {};
  const NXDIS = disc.nx || 1, NYDIS = disc.ny || 1, NZDIS = disc.nz || 1;
  const ktype = opts.ktype === "SK" ? 0 : 1;
  const skmean = opts.skmean || 0;
  const wantDist = opts.distances ? 1 : 0;
  const K = NDMAX;
  const NEQ_MAX = NDMAX + 2;

  const T = _buildTargets(opts, g);
  const ntarg = T.ntarg, ncat = T.catDims.length;

  const mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data
  const pX = alloc(st, nd + 20), pY = alloc(st, nd + 20), pZ = alloc(st, nd + 20);
  const pVR = alloc(st, nd + 20);
  // variogram
  const pIT = alloc(st, 0, v.nst + 4), pCC = alloc(st, v.nst + 4), pAA = alloc(st, v.nst + 4);
  const pROT = alloc(st, 9 * (v.nst + 1));
  // super block
  const maxsbx = g.nx > 1 ? Math.min(Math.floor(g.nx / 2), 50) : 1;
  const maxsby = g.ny > 1 ? Math.min(Math.floor(g.ny / 2), 50) : 1;
  const maxsbz = g.nz > 1 ? Math.min(Math.floor(g.nz / 2), 50) : 1;
  const MAXSB = maxsbx * maxsby * maxsbz;
  const pNISB = alloc(st, 0, MAXSB + 10), pSUPOUT = alloc(st, 20);
  const SB = 8 * MAXSB;
  const pIXSB = alloc(st, 0, SB), pIYSB = alloc(st, 0, SB), pIZSB = alloc(st, 0, SB);
  // targets + categories
  const pTX = alloc(st, T.tx.length), pTY = alloc(st, T.ty.length), pTZ = alloc(st, T.tz.length);
  const pTCAT = alloc(st, 0, T.tcat.length);
  const pCDX = alloc(st, ncat), pCDY = alloc(st, ncat), pCDZ = alloc(st, ncat);
  const pCBBCAT = alloc(st, ncat);
  // tensor outputs (per target, K = NDMAX stride)
  const pTIND = alloc(st, 0, ntarg * K), pTWT = alloc(st, ntarg * K);
  const pTKV = alloc(st, ntarg), pTNACT = alloc(st, 0, ntarg), pTSTAT = alloc(st, 0, ntarg);
  const pTDIST = alloc(st, ntarg * K);
  // scratch
  const pXA = alloc(st, NDMAX), pYA = alloc(st, NDMAX), pZA = alloc(st, NDMAX), pVRA = alloc(st, NDMAX);
  const pR = alloc(st, NEQ_MAX), pRR = alloc(st, NEQ_MAX), pS = alloc(st, NEQ_MAX);
  const pA = alloc(st, NEQ_MAX * NEQ_MAX);
  const ndisc = NXDIS * NYDIS * NZDIS;
  const pXDB = alloc(st, Math.max(ndisc, 27)), pYDB = alloc(st, Math.max(ndisc, 27)), pZDB = alloc(st, Math.max(ndisc, 27));
  const pCLOSE = alloc(st, NDMAX);
  const pCOVRES = alloc(st, 2);
  const pINOCT = alloc(st, 0, 8), pGETIDX = alloc(st, 0, 2);
  const pTMP = alloc(st, nd + 20);
  const pIXARR = alloc(st, 0, nd + 20), pIDX2 = alloc(st, 0, 2);
  const pLT = alloc(st, 0, 64), pUT = alloc(st, 0, 64);
  const pNSBBUF = alloc(st, 0, 1);

  growMemory(mem, st.off);

  writeF64(mem, pX, data.map((d) => d[0]));
  writeF64(mem, pY, data.map((d) => d[1]));
  writeF64(mem, pZ, data.map((d) => d[2]));
  writeF64(mem, pVR, data.map((d) => d[3]));
  writeI32(mem, pIT, v.its); writeF64(mem, pCC, v.ccs); writeF64(mem, pAA, v.ranges);
  writeF64(mem, pTX, T.tx); writeF64(mem, pTY, T.ty); writeF64(mem, pTZ, T.tz);
  writeI32(mem, pTCAT, T.tcat);
  writeF64(mem, pCDX, T.catDims.map((d) => d[0]));
  writeF64(mem, pCDY, T.catDims.map((d) => d[1]));
  writeF64(mem, pCDZ, T.catDims.map((d) => d[2]));

  // rotation matrices (one per structure + search at slot nst)
  for (let is = 0; is < v.nst; is++) {
    lib.gslib.setrot(v.angs[is], v.ang2s[is], v.ang3s[is], v.rangeMinors[is] / v.ranges[is], v.rangeVerts[is] / v.ranges[is], is, pROT);
  }
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, v.nst, pROT);

  // super-block search (reorders pX/pY/pZ/pVR in place)
  lib.gslib.setsupr(
    g.nx, g.xmn, g.xsiz, g.ny, g.ymn, g.ysiz, g.nz, g.zmn, g.zsiz,
    nd, pX, pY, pZ, pVR, pTMP,
    pNISB, pIDX2, pIXARR, pLT, pUT,
    maxsbx, maxsby, maxsbz, pSUPOUT
  );
  const supout = readF64(mem, pSUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6], supout[1], supout[7], supout[2], supout[8],
    v.nst, pROT, RADIUS * RADIUS, pNSBBUF, pIXSB, pIYSB, pIZSB
  );
  const nsbtosr = readI32(mem, pNSBBUF, 1)[0];

  lib.gsjs.kriging(
    g.nx, g.ny, g.nz, g.xmn, g.ymn, g.zmn, g.xsiz, g.ysiz, g.zsiz,
    NXDIS, NYDIS, NZDIS,
    nd, pX, pY, pZ, pVR,
    NDMIN, NDMAX, RADIUS,
    ktype, skmean,
    v.nst, v.c0, pIT, pCC, pAA,
    0, pROT,
    nsbtosr, pIXSB, pIYSB, pIZSB, pNISB,
    pSUPOUT,
    T.gridmode, ntarg,
    pTX, pTY, pTZ,
    ncat, pCDX, pCDY, pCDZ, pTCAT,
    wantDist,
    pTIND, pTWT, pTKV, pTNACT, pTSTAT, pTDIST,
    pXA, pYA, pZA, pVRA,
    pR, pRR, pS, pA,
    pXDB, pYDB, pZDB,
    pCBBCAT,
    pCLOSE, pCOVRES,
    pINOCT, pGETIDX,
    pLT, pUT
  );

  const statusI32 = readI32(mem, pTSTAT, ntarg);
  return {
    indices: readI32(mem, pTIND, ntarg * K),
    weights: readF64(mem, pTWT, ntarg * K),
    n_actual: readI32(mem, pTNACT, ntarg),
    kv: readF64(mem, pTKV, ntarg),
    status: Uint8Array.from(statusI32),
    distances: wantDist ? readF64(mem, pTDIST, ntarg * K) : null,
    sk_mean: ktype === 0 ? skmean : null,
    values: readF64(mem, pVR, nd),       // super-block-reordered; indices reference this
    coords: T.coords,                    // target centres (null for gridmode → use grid)
    gridIndex: T.gridIndex,              // original grid linear index per target (mask mode)
    geom: T.geom,                        // { grid } or { coords } — for swath
    K,
    n_targets: ntarg,
    n_blocks: ntarg,                     // alias (realize/aggregate are per-index)
    n_categories: ncat,
  };
}
