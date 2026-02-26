// gslib high-level API — appended to binary dist by build.js.
// Runtime helpers (alloc, writeF64, writeI32, readF64, readI32, growMemory)
// and instantiate() are in module scope from the binary dist.
//
// Config shapes:
//   kb2d({ data, grid, variogram, search, discretization?, ktype?, skmean? })
//   kt3d({ data, grid, variogram, search, discretization?, ktype?, skmean? })
//   sgsim({ grid, variogram, search, data? }) → { run(seed), dispose() }
//
// See ext/gslib/README.md for routine docs, CLAUDE.md for architecture.

// variogram model names → GSLIB integer codes (cova3 convention)
const _VARIO_TYPES = {
  spherical: 1, exponential: 2, gaussian: 3, power: 4, hole: 5,
  sph: 1, exp: 2, gau: 3, pow: 4,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5,
};

// Fill in grid defaults. GSLIB convention: xmn = xsiz/2 (cell-centered).
function _resolveGrid(g, is3d) {
  const nx = g.nx, ny = g.ny, nz = is3d ? (g.nz || 1) : 1;
  const xsiz = g.xsiz || 1, ysiz = g.ysiz || 1, zsiz = is3d ? (g.zsiz || 1) : 1;
  const xmn = g.xmn != null ? g.xmn : xsiz / 2;
  const ymn = g.ymn != null ? g.ymn : ysiz / 2;
  const zmn = is3d ? (g.zmn != null ? g.zmn : zsiz / 2) : zsiz / 2;
  return { nx, ny, nz, xmn, ymn, zmn, xsiz, ysiz, zsiz, nxyz: nx * ny * nz };
}

function _parseVario(v) {
  const c0 = v.nugget || 0;
  const structs = v.structures || [];
  const nst = structs.length;
  const its = [], ccs = [], ranges = [];
  const angs = [], ang2s = [], ang3s = [];
  const rangeMinors = [], rangeVerts = [];
  for (const s of structs) {
    const it = _VARIO_TYPES[s.type];
    if (it == null) throw new Error(`unknown variogram type: ${s.type}`);
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

// 2D ordinary/simple kriging. Returns { est, var } as Float64Arrays.
export function kb2d(opts) {
  const data = opts.data;
  const nd = data.length;
  const g = _resolveGrid(opts.grid, false);
  const v = _parseVario(opts.variogram);
  const search = opts.search;
  const NDMAX = search.ndmax || Math.min(nd, 20);
  const NDMIN = search.ndmin || 1;
  const RADIUS = search.radius;
  const disc = opts.discretization || {};
  const NXDIS = disc.nx || 1, NYDIS = disc.ny || 1;
  const ktype = opts.ktype === "SK" ? 0 : 1;
  const skmean = opts.skmean || 0;

  const mem = new WebAssembly.Memory({ initial: 4 });
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };

  // data arrays
  const pX = alloc(st, nd), pY = alloc(st, nd), pVR = alloc(st, nd);
  // variogram
  const pIT = alloc(st, 0, v.nst + 4), pCC = alloc(st, v.nst + 4), pAA = alloc(st, v.nst + 4);
  // output
  const pEST = alloc(st, g.nxyz), pESTV = alloc(st, g.nxyz);
  // rotation (9 f64 per structure)
  const pROT = alloc(st, 9 * v.nst);
  // scratch
  const pXA = alloc(st, NDMAX + 1), pYA = alloc(st, NDMAX + 1);
  const pVRA = alloc(st, NDMAX + 1), pDIST = alloc(st, NDMAX + 1), pNUMS = alloc(st, NDMAX + 1);
  const NEQ = NDMAX + 1;
  const pR = alloc(st, NEQ), pRR = alloc(st, NEQ), pS = alloc(st, NEQ);
  const pA = alloc(st, NEQ * (NEQ + 1) / 2);
  const pXDB = alloc(st, NXDIS * NYDIS), pYDB = alloc(st, NXDIS * NYDIS);
  const pCOVRES = alloc(st, 2), pKSOLRES = alloc(st, 1);

  growMemory(mem, st.off);

  // write data
  writeF64(mem, pX, data.map(d => d[0]));
  writeF64(mem, pY, data.map(d => d[1]));
  writeF64(mem, pVR, data.map(d => d[2]));

  // variogram params
  writeI32(mem, pIT, v.its);
  writeF64(mem, pCC, v.ccs);
  writeF64(mem, pAA, v.ranges);

  // rotation matrices
  for (let is = 0; is < v.nst; is++) {
    const anis = v.rangeMinors[is] / v.ranges[is];
    lib.gslib.setrot(v.angs[is], 0, 0, anis, 1.0, is, pROT);
  }

  lib.gslib.kb2d(
    g.nx, g.ny, g.xmn, g.ymn, g.xsiz, g.ysiz,
    NXDIS, NYDIS,
    nd, pX, pY, pVR,
    NDMIN, NDMAX, RADIUS,
    ktype, skmean,
    v.nst, v.c0,
    pIT, pCC, pAA,
    0, pROT,
    pEST, pESTV,
    pXA, pYA, pVRA, pDIST, pNUMS,
    pR, pRR, pS, pA,
    pXDB, pYDB, pCOVRES, pKSOLRES
  );

  return {
    est: readF64(mem, pEST, g.nxyz),
    var: readF64(mem, pESTV, g.nxyz),
  };
}

// 3D kriging (SK/OK, super block search). Returns { est, var } as Float64Arrays.
export function kt3d(opts) {
  const data = opts.data;
  const nd = data.length;
  const g = _resolveGrid(opts.grid, true);
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
  const MDT_MAX = 10;
  const NEQ_MAX = NDMAX + MDT_MAX;

  const mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data
  const pX = alloc(st, nd + 20), pY = alloc(st, nd + 20), pZ = alloc(st, nd + 20);
  const pVR = alloc(st, nd + g.nxyz + 20), pVE = alloc(st, nd + g.nxyz + 20);
  // variogram
  const pIT = alloc(st, 0, v.nst + 4), pCC = alloc(st, v.nst + 4), pAA = alloc(st, v.nst + 4);
  // rotation: nst + 1 (search)
  const pROT = alloc(st, 9 * (v.nst + 1));
  // drift
  const pIDRIF = alloc(st, 0, 9);
  // super block
  const maxsbx = g.nx > 1 ? Math.min(Math.floor(g.nx / 2), 50) : 1;
  const maxsby = g.ny > 1 ? Math.min(Math.floor(g.ny / 2), 50) : 1;
  const maxsbz = g.nz > 1 ? Math.min(Math.floor(g.nz / 2), 50) : 1;
  const MAXSB = maxsbx * maxsby * maxsbz;
  const pNISB = alloc(st, 0, MAXSB + 10), pSUPOUT = alloc(st, 20);
  const SBTOSR_SIZE = 8 * MAXSB;
  const pIXSB = alloc(st, 0, SBTOSR_SIZE), pIYSB = alloc(st, 0, SBTOSR_SIZE), pIZSB = alloc(st, 0, SBTOSR_SIZE);
  // output
  const pEST = alloc(st, g.nxyz), pESTV = alloc(st, g.nxyz);
  // scratch
  const pXA = alloc(st, NDMAX), pYA = alloc(st, NDMAX), pZA = alloc(st, NDMAX);
  const pVRA = alloc(st, NDMAX), pVEA = alloc(st, NDMAX);
  const pR = alloc(st, NEQ_MAX), pRR = alloc(st, NEQ_MAX), pS = alloc(st, NEQ_MAX);
  const pKA = alloc(st, NEQ_MAX * NEQ_MAX);
  const ndisc = NXDIS * NYDIS * NZDIS;
  const pXDB = alloc(st, Math.max(ndisc, 27)), pYDB = alloc(st, Math.max(ndisc, 27)), pZDB = alloc(st, Math.max(ndisc, 27));
  const pCLOSE = alloc(st, NDMAX);
  const pCOVRES = alloc(st, 2);
  const pINOCT = alloc(st, 0, 8);
  const pGETIDX = alloc(st, 0, 2);
  const pTMP = alloc(st, nd + 20);
  const pIXARR = alloc(st, 0, nd + 20), pIDX2 = alloc(st, 0, 2);
  const pLT = alloc(st, 0, 64), pUT = alloc(st, 0, 64);
  const pNSBBUF = alloc(st, 0, 1);

  growMemory(mem, st.off);

  // write data
  writeF64(mem, pX, data.map(d => d[0]));
  writeF64(mem, pY, data.map(d => d[1]));
  writeF64(mem, pZ, data.map(d => d[2]));
  writeF64(mem, pVR, data.map(d => d[3]));
  writeF64(mem, pVE, new Array(nd).fill(1.0));

  // variogram
  writeI32(mem, pIT, v.its);
  writeF64(mem, pCC, v.ccs);
  writeF64(mem, pAA, v.ranges);
  writeI32(mem, pIDRIF, [0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // rotation matrices — one per variogram structure
  for (let is = 0; is < v.nst; is++) {
    const anis1 = v.rangeMinors[is] / v.ranges[is];
    const anis2 = v.rangeVerts[is] / v.ranges[is];
    lib.gslib.setrot(v.angs[is], v.ang2s[is], v.ang3s[is], anis1, anis2, is, pROT);
  }
  // search rotation at slot nst
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, v.nst, pROT);

  // super block search
  lib.gslib.setsupr(
    g.nx, g.xmn, g.xsiz, g.ny, g.ymn, g.ysiz, g.nz, g.zmn, g.zsiz,
    nd, pX, pY, pZ, pVR, pTMP,
    pNISB, pIDX2, pIXARR, pLT, pUT,
    maxsbx, maxsby, maxsbz, pSUPOUT
  );

  // VE needs same reorder as setsupr did to X,Y,Z,VR
  writeF64(mem, pVE, new Array(nd).fill(1.0));

  const supout = readF64(mem, pSUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6],
    supout[1], supout[7],
    supout[2], supout[8],
    v.nst, pROT,
    RADIUS * RADIUS,
    pNSBBUF,
    pIXSB, pIYSB, pIZSB
  );
  const nsbtosr = readI32(mem, pNSBBUF, 1)[0];

  // init output to UNEST
  const unest = new Array(g.nxyz).fill(-999.0);
  writeF64(mem, pEST, unest);
  writeF64(mem, pESTV, unest);

  lib.gslib.kt3d(
    g.nx, g.ny, g.nz, g.xmn, g.ymn, g.zmn, g.xsiz, g.ysiz, g.zsiz,
    NXDIS, NYDIS, NZDIS,
    nd, pX, pY, pZ, pVR, pVE,
    NDMIN, NDMAX, RADIUS,
    sang1, sang2, sang3, sanis1, sanis2,
    ktype, skmean,
    pIDRIF,
    v.nst, v.c0, pIT, pCC, pAA,
    0, pROT,
    nsbtosr, pIXSB, pIYSB, pIZSB, pNISB,
    pSUPOUT,
    pEST, pESTV,
    pXA, pYA, pZA, pVRA, pVEA,
    pR, pRR, pS, pKA,
    pXDB, pYDB, pZDB,
    pCLOSE, pCOVRES,
    pINOCT, pGETIDX,
    pLT, pUT
  );

  return {
    est: readF64(mem, pEST, g.nxyz),
    var: readF64(mem, pESTV, g.nxyz),
  };
}

// Sequential Gaussian simulation. Returns { run(seed) → Float64Array, dispose() }.
// Setup (super blocks, covariance table) runs once; run() is cheap per realization.
export function sgsim(opts) {
  const g = _resolveGrid(opts.grid, true);
  const v = _parseVario(opts.variogram);
  const search = opts.search;
  const NDMAX = search.ndmax || 10;
  const NDMIN = search.ndmin || 0;
  const NODMAX = search.nodmax || 12;
  const RADIUS = search.radius;
  const sang1 = search.angle || 0, sang2 = search.angle2 || 0, sang3 = search.angle3 || 0;
  const sRadMin = search.radiusMinor != null ? search.radiusMinor : RADIUS;
  const sRadVert = search.radiusVert != null ? search.radiusVert : RADIUS;
  const sanis1 = sRadMin / RADIUS, sanis2 = sRadVert / RADIUS;

  // covariance table dimensions
  const NCTX = Math.min(Math.max(Math.ceil(RADIUS / (g.xsiz || 1)), 1), Math.floor((g.nx - 1) / 2));
  const NCTY = Math.min(Math.max(Math.ceil(RADIUS / (g.ysiz || 1)), 1), Math.floor((g.ny - 1) / 2));
  const NCTZ = g.nz <= 1 ? 0 : Math.min(Math.max(Math.ceil(RADIUS / (g.zsiz || 1)), 1), Math.floor((g.nz - 1) / 2));

  const data = opts.data || [];
  const nd = data.length;

  const NEQ_MAX = NDMAX + NODMAX + 2;
  const MAXCTX = 2 * NCTX + 1;
  const MAXCTY = 2 * NCTY + 1;
  const MAXCTZ = NCTZ === 0 ? 1 : 2 * NCTZ + 1;
  const COVTAB_SIZE = MAXCTX * MAXCTY * MAXCTZ;
  const MAX_LOOKU = COVTAB_SIZE;
  const NSB_MAX = g.nxyz + 10;
  const ndAlloc = Math.max(nd, 20);

  let mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data arrays
  const pX = alloc(st, ndAlloc), pY = alloc(st, ndAlloc), pZ = alloc(st, ndAlloc);
  const pVR = alloc(st, ndAlloc), pSEC = alloc(st, ndAlloc), pLVM = alloc(st, g.nxyz);
  // variogram
  const pIT = alloc(st, 0, v.nst + 4), pCC = alloc(st, v.nst + 4), pAA = alloc(st, v.nst + 4);
  const pROT = alloc(st, 9 * (v.nst + 1));
  // super block
  const pNISB = alloc(st, 0, NSB_MAX), pSUPOUT = alloc(st, 20);
  const pIXSB = alloc(st, 0, NSB_MAX), pIYSB = alloc(st, 0, NSB_MAX), pIZSB = alloc(st, 0, NSB_MAX);
  // covariance table
  const pCOVTAB = alloc(st, COVTAB_SIZE);
  const pIXNODE = alloc(st, 0, MAX_LOOKU), pIYNODE = alloc(st, 0, MAX_LOOKU), pIZNODE = alloc(st, 0, MAX_LOOKU);
  // RNG
  const pIXV = alloc(st, 0, 13);
  // simulation
  const pSIM = alloc(st, g.nxyz), pORDER = alloc(st, g.nxyz), pCLOSE = alloc(st, NDMAX);
  const pICNODE = alloc(st, 0, NODMAX);
  const pCNODEX = alloc(st, NODMAX), pCNODEY = alloc(st, NODMAX), pCNODEZ = alloc(st, NODMAX), pCNODEV = alloc(st, NODMAX);
  // kriging scratch
  const pA = alloc(st, NEQ_MAX * (NEQ_MAX + 1) / 2);
  const pR = alloc(st, NEQ_MAX), pRR = alloc(st, NEQ_MAX), pS = alloc(st, NEQ_MAX);
  const pVRA = alloc(st, NEQ_MAX), pVREA = alloc(st, NEQ_MAX);
  const pCOVRES = alloc(st, 2), pGETIDX = alloc(st, 0, 2), pINOCT = alloc(st, 0, 8);
  const pLT = alloc(st, 0, 64), pUT = alloc(st, 0, 64);
  const pTMP = alloc(st, MAX_LOOKU);
  const pCT_TMP = alloc(st, MAX_LOOKU), pCT_ORDER = alloc(st, MAX_LOOKU), pCT_RESULT = alloc(st, 2);
  const pSU_IDX2 = alloc(st, 0, 2), pSU_IXARR = alloc(st, 0, 20), pNSBBUF = alloc(st, 0, 1);
  const pTmpX = alloc(st, ndAlloc), pTmpY = alloc(st, ndAlloc), pTmpZ = alloc(st, ndAlloc), pTmpVR = alloc(st, ndAlloc);

  growMemory(mem, st.off);

  // zero LVM
  writeF64(mem, pLVM, new Array(g.nxyz).fill(0.0));

  // conditioning data
  if (nd > 0) {
    writeF64(mem, pX, data.map(d => d[0]));
    writeF64(mem, pY, data.map(d => d[1]));
    writeF64(mem, pZ, data.map(d => d[2]));
    writeF64(mem, pVR, data.map(d => d[3]));
  }

  // variogram
  writeI32(mem, pIT, v.its);
  writeF64(mem, pCC, v.ccs);
  writeF64(mem, pAA, v.ranges);

  // rotation matrices
  for (let is = 0; is < v.nst; is++) {
    const anis1 = v.rangeMinors[is] / v.ranges[is];
    const anis2 = v.rangeVerts[is] / v.ranges[is];
    lib.gslib.setrot(v.angs[is], v.ang2s[is], v.ang3s[is], anis1, anis2, is, pROT);
  }
  // search rotation
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, v.nst, pROT);

  // super block search
  lib.gslib.setsupr(
    g.nx, g.xmn, g.xsiz, g.ny, g.ymn, g.ysiz, g.nz, g.zmn, g.zsiz,
    nd, pTmpX, pTmpY, pTmpZ, pTmpVR, pTMP,
    pNISB, pSU_IDX2, pSU_IXARR, pLT, pUT, g.nx, g.ny, g.nz, pSUPOUT
  );

  const supout = readF64(mem, pSUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6], supout[1], supout[7], supout[2], supout[8],
    1, pROT, RADIUS * RADIUS, pNSBBUF, pIXSB, pIYSB, pIZSB
  );
  const nsbtosr = readI32(mem, pNSBBUF, 1)[0];

  // covariance table
  lib.gslib.ctable(
    v.nst, v.c0, pIT, pCC, pAA, 0, 1, pROT, RADIUS * RADIUS,
    g.nx, g.ny, g.nz, g.xsiz, g.ysiz, g.zsiz, NCTX, NCTY, NCTZ,
    pCOVTAB, pCOVRES, pCT_TMP, pCT_ORDER, pIXNODE, pIYNODE, pIZNODE, pLT, pUT, pCT_RESULT
  );

  const ctres = readF64(mem, pCT_RESULT, 2);
  const nlooku = ctres[0], cbb = ctres[1];

  return {
    run(seed) {
      const i32 = new Int32Array(mem.buffer);
      i32[pIXV / 4] = seed & 0x3FFFFFFF;
      for (let k = 1; k < 13; k++) i32[pIXV / 4 + k] = 0;

      lib.gslib.sgsim(
        g.nx, g.ny, g.nz, g.xmn, g.ymn, g.zmn, g.xsiz, g.ysiz, g.zsiz,
        nd, pX, pY, pZ, pVR, pSEC, pLVM, 0.0,
        NDMIN, NDMAX, RADIUS,
        sang1, sang2, sang3, sanis1, sanis2,
        0, NODMAX, 0,
        v.nst, v.c0, pIT, pCC, pAA,
        0, pROT, RADIUS * RADIUS, 1,
        nsbtosr, pIXSB, pIYSB, pIZSB, pNISB, pSUPOUT,
        NCTX, NCTY, NCTZ, nlooku, pCOVTAB, pIXNODE, pIYNODE, pIZNODE, cbb,
        pIXV, pSIM, pORDER, pCLOSE, pICNODE,
        pCNODEX, pCNODEY, pCNODEZ, pCNODEV,
        pA, pR, pRR, pS, pVRA, pVREA,
        pCOVRES, pGETIDX, pINOCT, pLT, pUT, pTMP
      );

      return new Float64Array(mem.buffer.slice(pSIM, pSIM + g.nxyz * 8));
    },
    dispose() {
      mem = null;
    },
  };
}

// Experimental variogram computation.
// Returns { distance, value, npairs } — each Float64Array[ndir * (nlag+2)].
export function gamv(opts) {
  const data = opts.data;
  const nd = data.length;
  const is3d = data[0] && data[0].length > 3;
  const lags = opts.lags;
  const nlag = lags.n;
  const xlag = lags.size;
  const xltol = lags.tolerance != null ? lags.tolerance : xlag / 2;
  const dirs = opts.directions || [{ azimuth: 0, tolerance: 90 }];
  const ndir = dirs.length;
  const trim = opts.trim || {};
  const tmin = trim.min != null ? trim.min : -1e21;
  const tmax = trim.max != null ? trim.max : 1e21;
  // single variable, single variogram type (semivariogram)
  const nvarg = 1;
  const nlp2 = nlag + 2;
  const nsiz = ndir * nvarg * nlp2;

  const mem = new WebAssembly.Memory({ initial: 4 });
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };

  const pX = alloc(st, nd), pY = alloc(st, nd), pZ = alloc(st, nd), pVR = alloc(st, nd);
  const pAZM = alloc(st, ndir), pATOL = alloc(st, ndir), pBWH = alloc(st, ndir);
  const pDIP = alloc(st, ndir), pDTOL = alloc(st, ndir), pBWD = alloc(st, ndir);
  const pIVTAIL = alloc(st, 0, nvarg), pIVHEAD = alloc(st, 0, nvarg), pIVTYPE = alloc(st, 0, nvarg);
  const pNP = alloc(st, nsiz), pDIS = alloc(st, nsiz), pGAM = alloc(st, nsiz);
  const pHM = alloc(st, nsiz), pTM = alloc(st, nsiz), pHV = alloc(st, nsiz), pTV = alloc(st, nsiz);

  growMemory(mem, st.off);

  writeF64(mem, pX, data.map(d => d[0]));
  writeF64(mem, pY, data.map(d => d[1]));
  writeF64(mem, pZ, is3d ? data.map(d => d[2]) : new Array(nd).fill(0));
  writeF64(mem, pVR, data.map(d => is3d ? d[3] : d[2]));

  writeF64(mem, pAZM, dirs.map(d => d.azimuth || 0));
  writeF64(mem, pATOL, dirs.map(d => d.tolerance != null ? d.tolerance : 90));
  writeF64(mem, pBWH, dirs.map(d => d.bandwidthH != null ? d.bandwidthH : 1e21));
  writeF64(mem, pDIP, dirs.map(d => d.dip || 0));
  writeF64(mem, pDTOL, dirs.map(d => d.dipTolerance != null ? d.dipTolerance : 90));
  writeF64(mem, pBWD, dirs.map(d => d.bandwidthV != null ? d.bandwidthV : 1e21));
  writeI32(mem, pIVTAIL, [0]);
  writeI32(mem, pIVHEAD, [0]);
  writeI32(mem, pIVTYPE, [1]); // semivariogram

  lib.gslib.gamv(
    nd, pX, pY, pZ, pVR,
    nlag, xlag, xltol,
    ndir, pAZM, pATOL, pBWH, pDIP, pDTOL, pBWD,
    nvarg, pIVTAIL, pIVHEAD, pIVTYPE,
    tmin, tmax,
    pNP, pDIS, pGAM, pHM, pTM, pHV, pTV
  );

  return {
    distance: readF64(mem, pDIS, nsiz),
    value: readF64(mem, pGAM, nsiz),
    npairs: readF64(mem, pNP, nsiz),
    hm: readF64(mem, pHM, nsiz),
    tm: readF64(mem, pTM, nsiz),
  };
}

// Cell declustering.
// Returns { weights, cellSize, weightedMean }.
export function declus(opts) {
  const data = opts.data;
  const nd = data.length;
  const is3d = data[0] && data[0].length > 3;
  const cellRange = opts.cellRange;
  const ncell = opts.ncell || 25;
  const noff = opts.noff || 8;
  const aniso = opts.anisotropy || {};
  const anisy = aniso.y || 1, anisz = aniso.z || 1;
  const iminmax = opts.criterion === "max" ? 1 : 0;
  const trim = opts.trim || {};
  const tmin = trim.min != null ? trim.min : -1e21;
  const tmax = trim.max != null ? trim.max : 1e21;

  // max possible cells per offset
  const cmax = cellRange[1];
  const span = nd + 10;
  const maxcells = span * span * span;
  const ncellt = Math.max(maxcells, nd * 10);

  const mem = new WebAssembly.Memory({ initial: 4 });
  const lib = instantiate({ memory: mem });
  const st = { off: 0 };

  const pX = alloc(st, nd), pY = alloc(st, nd), pZ = alloc(st, nd);
  const pVR = alloc(st, nd), pWT = alloc(st, nd);
  const pWTOPT = alloc(st, nd), pRESULT = alloc(st, 2);
  const pCELLWTS = alloc(st, 0, ncellt), pIDX = alloc(st, 0, nd);

  growMemory(mem, st.off);

  writeF64(mem, pX, data.map(d => d[0]));
  writeF64(mem, pY, data.map(d => d[1]));
  writeF64(mem, pZ, is3d ? data.map(d => d[2]) : new Array(nd).fill(0));
  writeF64(mem, pVR, data.map(d => is3d ? d[3] : d[2]));

  lib.gslib.declus(
    nd, pX, pY, pZ, pVR, pWT,
    tmin, tmax,
    ncell, noff, cellRange[0], cellRange[1], anisy, anisz,
    iminmax,
    pWTOPT, pRESULT, pCELLWTS, pIDX
  );

  const result = readF64(mem, pRESULT, 2);
  return {
    weights: readF64(mem, pWTOPT, nd),
    cellSize: result[0],
    weightedMean: result[1],
  };
}

// 3D indicator kriging.
// Returns { ccdf: Float64Array } — nxyz * ncut values.
export function ik3d(opts) {
  const data = opts.data;
  const nd = data.length;
  const g = _resolveGrid(opts.grid, true);
  const cutoffs = opts.cutoffs;
  const ncut = cutoffs.length;
  const variograms = opts.variograms; // array of ncut variograms
  const search = opts.search;
  const NDMAX = search.ndmax || Math.min(nd, 20);
  const NDMIN = search.ndmin || 1;
  const NOCT = search.noct || 0;
  const RADIUS = search.radius;
  const sang1 = search.angle || 0, sang2 = search.angle2 || 0, sang3 = search.angle3 || 0;
  const sRadMin = search.radiusMinor != null ? search.radiusMinor : RADIUS;
  const sRadVert = search.radiusVert != null ? search.radiusVert : RADIUS;
  const sanis1 = sRadMin / RADIUS, sanis2 = sRadVert / RADIUS;
  const ktype = opts.ktype === "SK" ? 0 : 1;
  const ivtype = opts.categorical ? 0 : 1;

  // find max structures across cutoffs
  const parsed = variograms.map(v => _parseVario(v));
  let MAXNST = 0;
  for (const p of parsed) MAXNST = Math.max(MAXNST, p.nst);
  MAXNST = Math.max(MAXNST, 1);

  const NEQ_MAX = NDMAX + 2;

  const mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data arrays
  const pX = alloc(st, nd + 20), pY = alloc(st, nd + 20), pZ = alloc(st, nd + 20);
  const pVR = alloc(st, nd * ncut + 20); // indicator data
  const pTHRESH = alloc(st, ncut), pGCDF = alloc(st, ncut);
  // per-cutoff variogram arrays
  const pNST = alloc(st, 0, ncut), pC0 = alloc(st, ncut);
  const pIT = alloc(st, 0, ncut * MAXNST), pCC = alloc(st, ncut * MAXNST), pAA = alloc(st, ncut * MAXNST);
  // rotation: MAXNST per cutoff + 1 for search
  const nrot = ncut * MAXNST + 1;
  const pROT = alloc(st, 9 * nrot);
  // super block
  const maxsbx = g.nx > 1 ? Math.min(Math.floor(g.nx / 2), 50) : 1;
  const maxsby = g.ny > 1 ? Math.min(Math.floor(g.ny / 2), 50) : 1;
  const maxsbz = g.nz > 1 ? Math.min(Math.floor(g.nz / 2), 50) : 1;
  const MAXSB = maxsbx * maxsby * maxsbz;
  const pNISB = alloc(st, 0, MAXSB + 10), pSUPOUT = alloc(st, 20);
  const SBTOSR_SIZE = 8 * MAXSB;
  const pIXSB = alloc(st, 0, SBTOSR_SIZE), pIYSB = alloc(st, 0, SBTOSR_SIZE), pIZSB = alloc(st, 0, SBTOSR_SIZE);
  // output
  const pCCDF_OUT = alloc(st, g.nxyz * ncut);
  // scratch
  const pXA = alloc(st, NDMAX), pYA = alloc(st, NDMAX), pZA = alloc(st, NDMAX);
  const pVRA = alloc(st, NDMAX);
  const pR = alloc(st, NEQ_MAX), pRR = alloc(st, NEQ_MAX), pS = alloc(st, NEQ_MAX);
  const pKA = alloc(st, NEQ_MAX * (NEQ_MAX + 1) / 2);
  const pCLOSE = alloc(st, NDMAX);
  const pCOVRES = alloc(st, 2);
  const pINOCT = alloc(st, 0, 8), pGETIDX = alloc(st, 0, 2);
  const pCCDF_SCRATCH = alloc(st, ncut), pCCDFO_SCRATCH = alloc(st, ncut);
  const pACTLOC = alloc(st, nd + 20);
  const pTMP = alloc(st, nd + 20);
  const pIXARR = alloc(st, 0, nd + 20), pIDX2 = alloc(st, 0, 2);
  const pLT = alloc(st, 0, 64), pUT = alloc(st, 0, 64);
  const pNSBBUF = alloc(st, 0, 1);

  growMemory(mem, st.off);

  // write data
  writeF64(mem, pX, data.map(d => d[0]));
  writeF64(mem, pY, data.map(d => d[1]));
  writeF64(mem, pZ, data.map(d => d[2]));
  writeF64(mem, pTHRESH, cutoffs);

  // indicator transform
  const indicators = new Float64Array(nd * ncut);
  for (let i = 0; i < nd; i++) {
    const val = data[i][3];
    for (let ic = 0; ic < ncut; ic++) {
      if (ivtype === 0) { // categorical
        indicators[i * ncut + ic] = val === cutoffs[ic] ? 1 : 0;
      } else { // continuous
        indicators[i * ncut + ic] = val <= cutoffs[ic] ? 1 : 0;
      }
    }
  }
  writeF64(mem, pVR, indicators);

  // global CDF (proportion below each cutoff)
  const gcdf = new Float64Array(ncut);
  for (let ic = 0; ic < ncut; ic++) {
    let count = 0;
    for (let i = 0; i < nd; i++) count += indicators[i * ncut + ic];
    gcdf[ic] = count / nd;
  }
  writeF64(mem, pGCDF, gcdf);

  // variogram params (interleaved by cutoff)
  const nst_arr = new Int32Array(ncut);
  const c0_arr = new Float64Array(ncut);
  const it_arr = new Int32Array(ncut * MAXNST);
  const cc_arr = new Float64Array(ncut * MAXNST);
  const aa_arr = new Float64Array(ncut * MAXNST);
  for (let ic = 0; ic < ncut; ic++) {
    const p = parsed[ic];
    nst_arr[ic] = p.nst;
    c0_arr[ic] = p.c0;
    for (let is = 0; is < p.nst; is++) {
      it_arr[ic * MAXNST + is] = p.its[is];
      cc_arr[ic * MAXNST + is] = p.ccs[is];
      aa_arr[ic * MAXNST + is] = p.ranges[is];
    }
  }
  writeI32(mem, pNST, nst_arr);
  writeF64(mem, pC0, c0_arr);
  writeI32(mem, pIT, it_arr);
  writeF64(mem, pCC, cc_arr);
  writeF64(mem, pAA, aa_arr);

  // rotation matrices — per cutoff, per structure
  for (let ic = 0; ic < ncut; ic++) {
    const p = parsed[ic];
    for (let is = 0; is < p.nst; is++) {
      const anis1 = p.rangeMinors[is] / p.ranges[is];
      const anis2 = p.rangeVerts[is] / p.ranges[is];
      lib.gslib.setrot(p.angs[is], p.ang2s[is], p.ang3s[is], anis1, anis2, ic * MAXNST + is, pROT);
    }
  }
  // search rotation
  const isrot = ncut * MAXNST;
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, isrot, pROT);

  // actloc: identity mapping (index = data index before super block reorder)
  const actlocArr = new Float64Array(nd);
  for (let i = 0; i < nd; i++) actlocArr[i] = i;
  writeF64(mem, pACTLOC, actlocArr);

  // super block
  lib.gslib.setsupr(
    g.nx, g.xmn, g.xsiz, g.ny, g.ymn, g.ysiz, g.nz, g.zmn, g.zsiz,
    nd, pX, pY, pZ, pACTLOC, pTMP,
    pNISB, pIDX2, pIXARR, pLT, pUT,
    maxsbx, maxsby, maxsbz, pSUPOUT
  );

  const supout = readF64(mem, pSUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6], supout[1], supout[7], supout[2], supout[8],
    isrot, pROT, RADIUS * RADIUS, pNSBBUF, pIXSB, pIYSB, pIZSB
  );
  const nsbtosr = readI32(mem, pNSBBUF, 1)[0];

  lib.gslib.ik3d(
    g.nx, g.ny, g.nz, g.xmn, g.ymn, g.zmn, g.xsiz, g.ysiz, g.zsiz,
    nd, pX, pY, pZ,
    ncut, pTHRESH, pGCDF, pVR,
    ivtype, ktype,
    MAXNST,
    pNST, pC0, pIT, pCC, pAA,
    isrot, pROT,
    NDMIN, NDMAX, NOCT,
    RADIUS,
    nsbtosr, pIXSB, pIYSB, pIZSB, pNISB,
    pSUPOUT,
    pCCDF_OUT,
    pXA, pYA, pZA, pVRA,
    pR, pRR, pS, pKA,
    pCLOSE, pCOVRES,
    pINOCT, pGETIDX,
    pCCDF_SCRATCH, pCCDFO_SCRATCH,
    pACTLOC,
    pLT, pUT
  );

  return {
    ccdf: readF64(mem, pCCDF_OUT, g.nxyz * ncut),
  };
}

// Sequential indicator simulation.
// Returns { run(seed) → Float64Array, dispose() }.
export function sisim(opts) {
  const g = _resolveGrid(opts.grid, true);
  const cutoffs = opts.cutoffs;
  const ncut = cutoffs.length;
  const variograms = opts.variograms;
  const search = opts.search;
  const NDMAX = search.ndmax || 10;
  const NDMIN = search.ndmin || 0;
  const NODMAX = search.nodmax || 12;
  const NOCT = search.noct || 0;
  const RADIUS = search.radius;
  const sang1 = search.angle || 0, sang2 = search.angle2 || 0, sang3 = search.angle3 || 0;
  const sRadMin = search.radiusMinor != null ? search.radiusMinor : RADIUS;
  const sRadVert = search.radiusVert != null ? search.radiusVert : RADIUS;
  const sanis1 = sRadMin / RADIUS, sanis2 = sRadVert / RADIUS;
  const ktype = opts.ktype === "SK" ? 0 : 1;
  const ivtype = opts.categorical ? 0 : 1;
  const tails = opts.tails || {};
  const ltail = tails.lower ? (tails.lower.type || 1) : 1;
  const ltpar = tails.lower ? (tails.lower.param || 0) : 0;
  const utail = tails.upper ? (tails.upper.type || 1) : 1;
  const utpar = tails.upper ? (tails.upper.param || 5) : 5;
  const cutRange = ncut > 1 ? cutoffs[ncut - 1] - cutoffs[0] : Math.abs(cutoffs[0]) || 1;
  const zmin = opts.zmin != null ? opts.zmin : cutoffs[0] - cutRange;
  const zmax = opts.zmax != null ? opts.zmax : cutoffs[ncut - 1] + cutRange;

  const data = opts.data || [];
  const nd = data.length;
  const globalCdf = opts.globalCdf || null;

  const parsed = variograms.map(v => _parseVario(v));
  let MAXNST = 0;
  for (const p of parsed) MAXNST = Math.max(MAXNST, p.nst);
  MAXNST = Math.max(MAXNST, 1);

  // covariance table dims
  const NCTX = Math.min(Math.max(Math.ceil(RADIUS / (g.xsiz || 1)), 1), Math.floor((g.nx - 1) / 2));
  const NCTY = Math.min(Math.max(Math.ceil(RADIUS / (g.ysiz || 1)), 1), Math.floor((g.ny - 1) / 2));
  const NCTZ = g.nz <= 1 ? 0 : Math.min(Math.max(Math.ceil(RADIUS / (g.zsiz || 1)), 1), Math.floor((g.nz - 1) / 2));
  const MAXCTX = 2 * NCTX + 1, MAXCTY = 2 * NCTY + 1, MAXCTZ = NCTZ === 0 ? 1 : 2 * NCTZ + 1;
  const COVTAB_SIZE = MAXCTX * MAXCTY * MAXCTZ;
  const MAX_LOOKU = COVTAB_SIZE;

  const NEQ_MAX = NDMAX + NODMAX + 2;
  const ndAlloc = Math.max(nd, 20);

  let mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data
  const pX = alloc(st, ndAlloc), pY = alloc(st, ndAlloc), pZ = alloc(st, ndAlloc);
  const pVR = alloc(st, ndAlloc * ncut + 20);
  const pTHRESH = alloc(st, ncut), pGCDF = alloc(st, ncut);
  // per-cutoff variogram arrays
  const pNST = alloc(st, 0, ncut), pC0 = alloc(st, ncut);
  const pIT = alloc(st, 0, ncut * MAXNST), pCC = alloc(st, ncut * MAXNST), pAA = alloc(st, ncut * MAXNST);
  const nrot = ncut * MAXNST + 1;
  const pROT = alloc(st, 9 * nrot);
  // super block
  const NSB_MAX = g.nxyz + 10;
  const pNISB = alloc(st, 0, NSB_MAX), pSUPOUT = alloc(st, 20);
  const pIXSB = alloc(st, 0, NSB_MAX), pIYSB = alloc(st, 0, NSB_MAX), pIZSB = alloc(st, 0, NSB_MAX);
  // covariance table (per-cutoff)
  const pCOVTAB = alloc(st, MAX_LOOKU * ncut);
  const pIXNODE = alloc(st, 0, MAX_LOOKU), pIYNODE = alloc(st, 0, MAX_LOOKU), pIZNODE = alloc(st, 0, MAX_LOOKU);
  const pCBB = alloc(st, ncut + 1);
  // RNG
  const pIXV = alloc(st, 0, 13);
  // simulation
  const pSIM = alloc(st, g.nxyz), pORDER = alloc(st, g.nxyz);
  const pCLOSE = alloc(st, NDMAX);
  const pICNODE = alloc(st, 0, NODMAX);
  const pCNODEX = alloc(st, NODMAX), pCNODEY = alloc(st, NODMAX), pCNODEZ = alloc(st, NODMAX), pCNODEV = alloc(st, NODMAX);
  // kriging scratch
  const pA = alloc(st, NEQ_MAX * (NEQ_MAX + 1) / 2);
  const pR = alloc(st, NEQ_MAX), pRR = alloc(st, NEQ_MAX), pS = alloc(st, NEQ_MAX);
  const pVRA = alloc(st, NEQ_MAX);
  const pCOVRES = alloc(st, 2), pGETIDX = alloc(st, 0, 2), pINOCT = alloc(st, 0, 8);
  const pCCDF_SCRATCH = alloc(st, ncut), pCCDFO_SCRATCH = alloc(st, ncut);
  const pBEYOND_RESULT = alloc(st, 1);
  const pACTLOC = alloc(st, Math.max(ndAlloc, g.nxyz) + 20);
  const pTMP = alloc(st, Math.max(ndAlloc, MAX_LOOKU) + 20);
  const pCT_TMP = alloc(st, MAX_LOOKU), pCT_ORDER = alloc(st, MAX_LOOKU);
  const pLT = alloc(st, 0, 64), pUT = alloc(st, 0, 64);
  const pSU_IDX2 = alloc(st, 0, 2), pSU_IXARR = alloc(st, 0, ndAlloc + 20);
  const pNSBBUF = alloc(st, 0, 1);

  growMemory(mem, st.off);

  writeF64(mem, pTHRESH, cutoffs);

  // indicator transform
  const indicators = new Float64Array(nd * ncut);
  for (let i = 0; i < nd; i++) {
    const val = data[i][3];
    for (let ic = 0; ic < ncut; ic++) {
      if (ivtype === 0) {
        indicators[i * ncut + ic] = val === cutoffs[ic] ? 1 : 0;
      } else {
        indicators[i * ncut + ic] = val <= cutoffs[ic] ? 1 : 0;
      }
    }
  }

  // global CDF
  const gcdf = new Float64Array(ncut);
  if (globalCdf) {
    for (let ic = 0; ic < ncut; ic++) gcdf[ic] = globalCdf[ic];
  } else {
    for (let ic = 0; ic < ncut; ic++) {
      let count = 0;
      for (let i = 0; i < nd; i++) count += indicators[i * ncut + ic];
      gcdf[ic] = nd > 0 ? count / nd : (ic + 1) / (ncut + 1);
    }
  }
  writeF64(mem, pGCDF, gcdf);

  // conditioning data
  if (nd > 0) {
    writeF64(mem, pX, data.map(d => d[0]));
    writeF64(mem, pY, data.map(d => d[1]));
    writeF64(mem, pZ, data.map(d => d[2]));
    writeF64(mem, pVR, indicators);
  }

  // variogram params
  const nst_arr = new Int32Array(ncut);
  const c0_arr = new Float64Array(ncut);
  const it_arr = new Int32Array(ncut * MAXNST);
  const cc_arr = new Float64Array(ncut * MAXNST);
  const aa_arr = new Float64Array(ncut * MAXNST);
  for (let ic = 0; ic < ncut; ic++) {
    const p = parsed[ic];
    nst_arr[ic] = p.nst;
    c0_arr[ic] = p.c0;
    for (let is = 0; is < p.nst; is++) {
      it_arr[ic * MAXNST + is] = p.its[is];
      cc_arr[ic * MAXNST + is] = p.ccs[is];
      aa_arr[ic * MAXNST + is] = p.ranges[is];
    }
  }
  writeI32(mem, pNST, nst_arr);
  writeF64(mem, pC0, c0_arr);
  writeI32(mem, pIT, it_arr);
  writeF64(mem, pCC, cc_arr);
  writeF64(mem, pAA, aa_arr);

  // rotation matrices
  for (let ic = 0; ic < ncut; ic++) {
    const p = parsed[ic];
    for (let is = 0; is < p.nst; is++) {
      const anis1 = p.rangeMinors[is] / p.ranges[is];
      const anis2 = p.rangeVerts[is] / p.ranges[is];
      lib.gslib.setrot(p.angs[is], p.ang2s[is], p.ang3s[is], anis1, anis2, ic * MAXNST + is, pROT);
    }
  }
  const isrot = ncut * MAXNST;
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, isrot, pROT);

  // actloc (identity)
  const actlocArr = new Float64Array(Math.max(nd, g.nxyz));
  for (let i = 0; i < nd; i++) actlocArr[i] = i;
  writeF64(mem, pACTLOC, actlocArr);

  // super block
  if (nd > 0) {
    lib.gslib.setsupr(
      g.nx, g.xmn, g.xsiz, g.ny, g.ymn, g.ysiz, g.nz, g.zmn, g.zsiz,
      nd, pX, pY, pZ, pACTLOC, pTMP,
      pNISB, pSU_IDX2, pSU_IXARR, pLT, pUT,
      g.nx, g.ny, g.nz, pSUPOUT
    );
  } else {
    writeF64(mem, pSUPOUT, [1, 1, 1, 0.5, 0.5, 0.5, g.nx * g.xsiz, g.ny * g.ysiz, g.nz * g.zsiz]);
  }

  const supout = readF64(mem, pSUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6], supout[1], supout[7], supout[2], supout[8],
    isrot, pROT, RADIUS * RADIUS, pNSBBUF, pIXSB, pIYSB, pIZSB
  );
  const nsbtosr = readI32(mem, pNSBBUF, 1)[0];

  // per-cutoff covariance table
  lib.gslib.ctable_i(
    ncut, MAXNST,
    pNST, pC0, pIT, pCC, pAA,
    0, isrot, pROT, RADIUS * RADIUS,
    g.nx, g.ny, g.nz, g.xsiz, g.ysiz, g.zsiz,
    NCTX, NCTY, NCTZ,
    pCOVTAB, pCOVRES,
    pCT_TMP, pCT_ORDER,
    pIXNODE, pIYNODE, pIZNODE,
    pLT, pUT, pCBB
  );

  const cbbArr = readF64(mem, pCBB, ncut + 1);
  const nlooku = cbbArr[0];

  return {
    run(seed) {
      const i32 = new Int32Array(mem.buffer);
      i32[pIXV / 4] = seed & 0x3FFFFFFF;
      for (let k = 1; k < 13; k++) i32[pIXV / 4 + k] = 0;

      lib.gslib.sisim(
        g.nx, g.ny, g.nz, g.xmn, g.ymn, g.zmn, g.xsiz, g.ysiz, g.zsiz,
        nd, pX, pY, pZ, pVR,
        ncut, pTHRESH, pGCDF,
        ivtype, ktype,
        MAXNST,
        pNST, pC0, pIT, pCC, pAA,
        0, isrot, pROT,
        RADIUS * RADIUS,
        NDMIN, NDMAX, RADIUS,
        NODMAX, NOCT,
        nsbtosr, pIXSB, pIYSB, pIZSB, pNISB,
        pSUPOUT,
        NCTX, NCTY, NCTZ, nlooku,
        pCOVTAB,
        pIXNODE, pIYNODE, pIZNODE,
        pCBB,
        ltail, ltpar, utail, utpar,
        zmin, zmax,
        pSIM, pORDER,
        pIXV,
        pCLOSE,
        pICNODE,
        pCNODEX, pCNODEY, pCNODEZ, pCNODEV,
        pA, pR, pRR, pS,
        pVRA,
        pCOVRES,
        pGETIDX, pINOCT,
        pCCDF_SCRATCH, pCCDFO_SCRATCH, pBEYOND_RESULT,
        pACTLOC,
        pLT, pUT
      );

      return new Float64Array(mem.buffer.slice(pSIM, pSIM + g.nxyz * 8));
    },
    dispose() {
      mem = null;
    },
  };
}

// Collocated cokriging.
// Returns { est, var } as Float64Arrays.
export function cokb3d(opts) {
  const primary = opts.data.primary;
  const secondary = opts.data.secondary;
  const nd = primary.length;
  const g = _resolveGrid(opts.grid, true);
  const varioP = _parseVario(opts.variograms.primary);
  const varioS = _parseVario(opts.variograms.secondary);
  const varioX = _parseVario(opts.variograms.cross);
  const search = opts.search;
  const NDMAXP = search.ndmaxPrimary || Math.min(nd, 16);
  const NDMAXS = search.ndmaxSecondary || Math.min(nd, 16);
  const NDMAX = NDMAXP + NDMAXS;
  const NDMIN = search.ndmin || 1;
  const RADIUS = search.radius;
  const sang1 = search.angle || 0, sang2 = search.angle2 || 0, sang3 = search.angle3 || 0;
  const sRadMin = search.radiusMinor != null ? search.radiusMinor : RADIUS;
  const sRadVert = search.radiusVert != null ? search.radiusVert : RADIUS;
  const sanis1 = sRadMin / RADIUS, sanis2 = sRadVert / RADIUS;
  const disc = opts.discretization || {};
  const NXDIS = disc.nx || 1, NYDIS = disc.ny || 1, NZDIS = disc.nz || 1;
  const ktype = opts.ktype === "SK" ? 0 : 1;
  const skmean = opts.skmean || {};
  const skmean1 = skmean.primary || 0;
  const skmean2 = skmean.secondary || 0;

  // 4 variogram model slots: pp=0, ps=1, sp=2, ss=3
  // ps and sp are the same cross-variogram
  const allVarios = [varioP, varioX, varioX, varioS]; // pp, ps, sp, ss
  let MAXNST = 0;
  for (const v of allVarios) MAXNST = Math.max(MAXNST, v.nst);
  MAXNST = Math.max(MAXNST, 1);

  const NEQ_MAX = NDMAX + 2;

  const mem = new WebAssembly.Memory({ initial: 64 });
  const lib = instantiate({ memory: mem });
  const st = { off: 65536 };

  // data (primary + secondary share coordinates)
  const pX = alloc(st, nd + 20), pY = alloc(st, nd + 20), pZ = alloc(st, nd + 20);
  const pVR1 = alloc(st, nd + 20), pVR2 = alloc(st, nd + 20);
  // variogram (4 slots)
  const nSlots = 4;
  const pNST = alloc(st, 0, nSlots), pC0 = alloc(st, nSlots);
  const pIT = alloc(st, 0, nSlots * MAXNST), pCC = alloc(st, nSlots * MAXNST), pAA = alloc(st, nSlots * MAXNST);
  const nrot = nSlots * MAXNST + 1;
  const pROT = alloc(st, 9 * nrot);
  // super block
  const maxsbx = g.nx > 1 ? Math.min(Math.floor(g.nx / 2), 50) : 1;
  const maxsby = g.ny > 1 ? Math.min(Math.floor(g.ny / 2), 50) : 1;
  const maxsbz = g.nz > 1 ? Math.min(Math.floor(g.nz / 2), 50) : 1;
  const MAXSB = maxsbx * maxsby * maxsbz;
  const pNISB = alloc(st, 0, MAXSB + 10), pSUPOUT = alloc(st, 20);
  const SBTOSR_SIZE = 8 * MAXSB;
  const pIXSB = alloc(st, 0, SBTOSR_SIZE), pIYSB = alloc(st, 0, SBTOSR_SIZE), pIZSB = alloc(st, 0, SBTOSR_SIZE);
  // output
  const pEST = alloc(st, g.nxyz), pESTV = alloc(st, g.nxyz);
  // scratch
  const pXA = alloc(st, NDMAX), pYA = alloc(st, NDMAX), pZA = alloc(st, NDMAX);
  const pVRA = alloc(st, NDMAX);
  const pIVA = alloc(st, 0, NDMAX);
  const pR = alloc(st, NEQ_MAX), pRR = alloc(st, NEQ_MAX), pS = alloc(st, NEQ_MAX);
  const pKA = alloc(st, NEQ_MAX * NEQ_MAX);
  const ndisc = NXDIS * NYDIS * NZDIS;
  const pXDB = alloc(st, Math.max(ndisc, 27)), pYDB = alloc(st, Math.max(ndisc, 27)), pZDB = alloc(st, Math.max(ndisc, 27));
  const pCLOSE = alloc(st, NDMAX);
  const pCOVRES = alloc(st, 2);
  const pINOCT = alloc(st, 0, 8), pGETIDX = alloc(st, 0, 2);
  const pACTLOC = alloc(st, nd + 20);
  const pTMP = alloc(st, nd + 20);
  const pIXARR = alloc(st, 0, nd + 20), pIDX2 = alloc(st, 0, 2);
  const pLT = alloc(st, 0, 64), pUT = alloc(st, 0, 64);
  const pNSBBUF = alloc(st, 0, 1);

  growMemory(mem, st.off);

  // write data
  writeF64(mem, pX, primary.map(d => d[0]));
  writeF64(mem, pY, primary.map(d => d[1]));
  writeF64(mem, pZ, primary.map(d => d[2]));
  writeF64(mem, pVR1, primary.map(d => d[3]));
  writeF64(mem, pVR2, secondary.map(d => d[3]));

  // variogram params for all 4 slots
  const nst_arr = new Int32Array(nSlots);
  const c0_arr = new Float64Array(nSlots);
  const it_arr = new Int32Array(nSlots * MAXNST);
  const cc_arr = new Float64Array(nSlots * MAXNST);
  const aa_arr = new Float64Array(nSlots * MAXNST);
  for (let iv = 0; iv < nSlots; iv++) {
    const v = allVarios[iv];
    nst_arr[iv] = v.nst;
    c0_arr[iv] = v.c0;
    for (let is = 0; is < v.nst; is++) {
      it_arr[iv * MAXNST + is] = v.its[is];
      cc_arr[iv * MAXNST + is] = v.ccs[is];
      aa_arr[iv * MAXNST + is] = v.ranges[is];
    }
  }
  writeI32(mem, pNST, nst_arr);
  writeF64(mem, pC0, c0_arr);
  writeI32(mem, pIT, it_arr);
  writeF64(mem, pCC, cc_arr);
  writeF64(mem, pAA, aa_arr);

  // rotation matrices per slot per structure
  for (let iv = 0; iv < nSlots; iv++) {
    const v = allVarios[iv];
    for (let is = 0; is < v.nst; is++) {
      const anis1 = v.rangeMinors[is] / v.ranges[is];
      const anis2 = v.rangeVerts[is] / v.ranges[is];
      lib.gslib.setrot(v.angs[is], v.ang2s[is], v.ang3s[is], anis1, anis2, iv * MAXNST + is, pROT);
    }
  }
  const isrot = nSlots * MAXNST;
  lib.gslib.setrot(sang1, sang2, sang3, sanis1, sanis2, isrot, pROT);

  // actloc identity
  const actlocArr = new Float64Array(nd);
  for (let i = 0; i < nd; i++) actlocArr[i] = i;
  writeF64(mem, pACTLOC, actlocArr);

  // super block
  lib.gslib.setsupr(
    g.nx, g.xmn, g.xsiz, g.ny, g.ymn, g.ysiz, g.nz, g.zmn, g.zsiz,
    nd, pX, pY, pZ, pACTLOC, pTMP,
    pNISB, pIDX2, pIXARR, pLT, pUT,
    maxsbx, maxsby, maxsbz, pSUPOUT
  );

  const supout = readF64(mem, pSUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6], supout[1], supout[7], supout[2], supout[8],
    isrot, pROT, RADIUS * RADIUS, pNSBBUF, pIXSB, pIYSB, pIZSB
  );
  const nsbtosr = readI32(mem, pNSBBUF, 1)[0];

  lib.gslib.cokb3d(
    g.nx, g.ny, g.nz, g.xmn, g.ymn, g.zmn, g.xsiz, g.ysiz, g.zsiz,
    NXDIS, NYDIS, NZDIS,
    nd, pX, pY, pZ, pVR1, pVR2,
    -1e21, 1e21,
    NDMIN, NDMAXP, NDMAXS,
    ktype, skmean1, skmean2,
    MAXNST,
    pNST, pC0, pIT, pCC, pAA,
    isrot, pROT,
    RADIUS,
    nsbtosr, pIXSB, pIYSB, pIZSB, pNISB,
    pSUPOUT,
    pEST, pESTV,
    pXA, pYA, pZA, pVRA,
    pIVA,
    pR, pRR, pS, pKA,
    pCLOSE,
    pXDB, pYDB, pZDB,
    pCOVRES,
    pINOCT, pGETIDX,
    pACTLOC,
    pLT, pUT
  );

  return {
    est: readF64(mem, pEST, g.nxyz),
    var: readF64(mem, pESTV, g.nxyz),
  };
}
