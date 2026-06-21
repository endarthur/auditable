// @gcu/gsjs high-level API — appended to the wasm bundle by build.js, so the
// runtime helpers (alloc, writeF64/I32, readF64/I32, growMemory, instantiate)
// are in module scope from the bundle.
//
// kriging() mirrors @gcu/gslib's kt3d wrapper (same memory/super-block setup)
// but reads back the BlockEstimateTensor — per-block kriging weights + original
// sample indices + variance + status — instead of (est, estv). realize() (from
// realize.js, the oracle) turns that tensor into estimates.
//
// Scope v1: SK + OK. See spec_inbox/gsjs-SPEC.md.

import { realize, makeTransform, STATUS } from './realize.js';
export { realize, makeTransform, STATUS };

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
    its.push(it);
    ccs.push(s.contribution);
    ranges.push(s.range);
    angs.push(s.angle || 0);
    ang2s.push(s.angle2 || 0);
    ang3s.push(s.angle3 || 0);
    rangeMinors.push(s.rangeMinor != null ? s.rangeMinor : s.range);
    rangeVerts.push(s.rangeVert != null ? s.rangeVert : s.range);
  }
  return { nst, c0, its, ccs, ranges, angs, ang2s, ang3s, rangeMinors, rangeVerts };
}

// 3D OK/SK kriging → BlockEstimateTensor + the (super-block-reordered) sample
// values that the tensor's indices reference. realize(result, result.values)
// reconstructs gslib.kt3d's est.
export function kriging(opts) {
  const data = opts.data;
  const nd = data.length;
  const g = _resolveGrid(opts.grid);
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

  const mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data
  const pX = alloc(st, nd + 20), pY = alloc(st, nd + 20), pZ = alloc(st, nd + 20);
  const pVR = alloc(st, nd + 20);
  // variogram
  const pIT = alloc(st, 0, v.nst + 4), pCC = alloc(st, v.nst + 4), pAA = alloc(st, v.nst + 4);
  // rotation: nst structures + 1 search
  const pROT = alloc(st, 9 * (v.nst + 1));
  // super block
  const maxsbx = g.nx > 1 ? Math.min(Math.floor(g.nx / 2), 50) : 1;
  const maxsby = g.ny > 1 ? Math.min(Math.floor(g.ny / 2), 50) : 1;
  const maxsbz = g.nz > 1 ? Math.min(Math.floor(g.nz / 2), 50) : 1;
  const MAXSB = maxsbx * maxsby * maxsbz;
  const pNISB = alloc(st, 0, MAXSB + 10), pSUPOUT = alloc(st, 20);
  const SBTOSR_SIZE = 8 * MAXSB;
  const pIXSB = alloc(st, 0, SBTOSR_SIZE), pIYSB = alloc(st, 0, SBTOSR_SIZE), pIZSB = alloc(st, 0, SBTOSR_SIZE);
  // tensor outputs (K = NDMAX stride)
  const pTIND = alloc(st, 0, g.nxyz * K), pTWT = alloc(st, g.nxyz * K);
  const pTKV = alloc(st, g.nxyz), pTNACT = alloc(st, 0, g.nxyz), pTSTAT = alloc(st, 0, g.nxyz);
  const pTDIST = alloc(st, g.nxyz * K);
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

  // write data
  writeF64(mem, pX, data.map((d) => d[0]));
  writeF64(mem, pY, data.map((d) => d[1]));
  writeF64(mem, pZ, data.map((d) => d[2]));
  writeF64(mem, pVR, data.map((d) => d[3]));

  // variogram
  writeI32(mem, pIT, v.its);
  writeF64(mem, pCC, v.ccs);
  writeF64(mem, pAA, v.ranges);

  // rotation matrices — one per structure
  for (let is = 0; is < v.nst; is++) {
    const anis1 = v.rangeMinors[is] / v.ranges[is];
    const anis2 = v.rangeVerts[is] / v.ranges[is];
    lib.gslib.setrot(v.angs[is], v.ang2s[is], v.ang3s[is], anis1, anis2, is, pROT);
  }
  // search rotation at slot nst
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, v.nst, pROT);

  // super-block search (reorders pX/pY/pZ/pVR in place into super-block order)
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
    wantDist,
    pTIND, pTWT, pTKV, pTNACT, pTSTAT, pTDIST,
    pXA, pYA, pZA, pVRA,
    pR, pRR, pS, pA,
    pXDB, pYDB, pZDB,
    pCLOSE, pCOVRES,
    pINOCT, pGETIDX,
    pLT, pUT
  );

  const statusI32 = readI32(mem, pTSTAT, g.nxyz);
  return {
    indices: readI32(mem, pTIND, g.nxyz * K),
    weights: readF64(mem, pTWT, g.nxyz * K),
    n_actual: readI32(mem, pTNACT, g.nxyz),
    kv: readF64(mem, pTKV, g.nxyz),
    status: Uint8Array.from(statusI32),
    distances: wantDist ? readF64(mem, pTDIST, g.nxyz * K) : null,
    sk_mean: ktype === 0 ? skmean : null,
    values: readF64(mem, pVR, nd),   // super-block-reordered; indices reference this
    K,
    n_blocks: g.nxyz,
  };
}
