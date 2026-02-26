/**
 * Validate gslib.atra against original Gslib90 Fortran executables.
 *
 * Run: node test/gslib-validate.js
 *
 * Tests:
 *   1. sgsim: unconditional simulation (20 realizations, aggregate stats)
 *   2. kb2d:  2D kriging — 4 configs (isotropic, anisotropic, nested, nested aniso)
 *   3. kt3d:  3D kriging — 8 configs (isotropic, anisotropic, nested, SK, block,
 *             sparse, clustered, Gaussian)
 *
 * NOTE: Fortran uses f32 for most variables, our atra uses f64.
 * For sgsim, the f32/f64 difference propagates through the RNG so
 * node-by-node values diverge — we compare aggregate statistics.
 * For kb2d/kt3d, kriging is deterministic so results should be very close.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { bundle } from '../ext/atra/atrac.js';

// ── paths ───────────────────────────────────────────────────────────

const GSLIB90 = join(tmpdir(), 'gslib90', 'Gslib90');

// ── helpers ─────────────────────────────────────────────────────────

function writeF64(memory, off, vals) {
  const f = new Float64Array(memory.buffer); const i = off / 8;
  for (let k = 0; k < vals.length; k++) f[i + k] = vals[k];
}
function readF64(memory, off, n) {
  return Array.from(new Float64Array(memory.buffer, off, n));
}
function writeI32(memory, off, vals) {
  const a = new Int32Array(memory.buffer); const i = off / 4;
  for (let k = 0; k < vals.length; k++) a[i + k] = vals[k];
}
function readI32(memory, off, n) {
  return Array.from(new Int32Array(memory.buffer, off, n));
}

function stats(arr) {
  let sum = 0, sum2 = 0, n = arr.length;
  for (const v of arr) { sum += v; sum2 += v * v; }
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  const sorted = [...arr].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const min = sorted[0], max = sorted[n - 1];
  const p10 = sorted[Math.floor(n * 0.1)];
  const p90 = sorted[Math.floor(n * 0.9)];
  return { mean, variance, std: Math.sqrt(variance), median, min, max, p10, p90, n };
}

function printRow(label, fv, av) {
  const diff = av - fv;
  console.log(`  ${label.padEnd(8)} ${fv.toFixed(4).padStart(10)}  ${av.toFixed(4).padStart(10)}  ${diff >= 0 ? '+' : ''}${diff.toFixed(4)}`);
}

// ── shared comparison ───────────────────────────────────────────────

function compareKriging(label, fResult, aResult, nTotal, threshold = 0.01) {
  const UNEST = -999.0;
  let maxEstDiff = 0, maxVarDiff = 0;
  let nCompared = 0, nUnestF = 0, nUnestA = 0, nDisagree = 0;

  const firstN = Math.min(20, nTotal);
  console.log(`\nFirst ${firstN} nodes:`);
  console.log('  Node  F_est      A_est      F_var      A_var      est_diff   var_diff');

  for (let i = 0; i < nTotal; i++) {
    const fe = fResult.estimates[i], ae = aResult.estimates[i];
    const fv = fResult.variances[i], av = aResult.variances[i];
    const fIsUnest = Math.abs(fe - UNEST) < 1.0;
    const aIsUnest = Math.abs(ae - UNEST) < 1.0;

    if (fIsUnest) nUnestF++;
    if (aIsUnest) nUnestA++;

    if (fIsUnest && aIsUnest) {
      if (i < firstN) console.log(`  ${String(i).padStart(4)}  UNEST      UNEST`);
      continue;
    }
    if (fIsUnest || aIsUnest) {
      nDisagree++;
      if (i < firstN) console.log(`  ${String(i).padStart(4)}  ${fIsUnest ? 'UNEST     ' : fe.toFixed(4).padStart(10)} ${aIsUnest ? 'UNEST     ' : ae.toFixed(4).padStart(10)}  ** DISAGREE **`);
      continue;
    }

    const ed = Math.abs(fe - ae), vd = Math.abs(fv - av);
    if (ed > maxEstDiff) maxEstDiff = ed;
    if (vd > maxVarDiff) maxVarDiff = vd;
    nCompared++;

    if (i < firstN) {
      console.log(`  ${String(i).padStart(4)}  ${fe.toFixed(4).padStart(10)} ${ae.toFixed(4).padStart(10)} ${fv.toFixed(4).padStart(10)} ${av.toFixed(4).padStart(10)} ${ed.toFixed(6).padStart(10)} ${vd.toFixed(6).padStart(10)}`);
    }
  }

  console.log(`\n  Compared ${nCompared} nodes (F:${nUnestF} unest, A:${nUnestA} unest${nDisagree ? `, ${nDisagree} disagree` : ''})`);
  console.log(`  Max estimate diff: ${maxEstDiff.toFixed(6)}`);
  console.log(`  Max variance diff: ${maxVarDiff.toFixed(6)}`);

  const estOk = maxEstDiff < threshold;
  const varOk = maxVarDiff < threshold;
  const unestOk = nDisagree === 0;
  console.log(`  Estimates match: ${estOk ? 'PASS' : 'FAIL'} (threshold ${threshold})`);
  console.log(`  Variances match: ${varOk ? 'PASS' : 'FAIL'} (threshold ${threshold})`);
  if (nDisagree > 0) console.log(`  UNEST agreement: FAIL (${nDisagree} nodes disagree)`);

  return estOk && varOk && unestOk;
}

// ── gslib.atra compilation (shared) ─────────────────────────────────

let _cached = null;
async function getGslib() {
  if (_cached) return _cached;
  const src = readFileSync(new URL('../ext/gslib/gslib.atra', import.meta.url), 'utf8');
  const js = bundle(src, { name: 'gslib' });
  const tmpPath = join(tmpdir(), `gslib_val_${Date.now()}.js`);
  writeFileSync(tmpPath, js);
  try {
    const mod = await import('file://' + tmpPath.replace(/\\/g, '/'));
    _cached = mod;
    return mod;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 1: SGSIM — unconditional, 20 realizations via different seeds
// ═══════════════════════════════════════════════════════════════════

const SGSIM_NX = 20, SGSIM_NY = 20, SGSIM_NZ = 1;
const SGSIM_NXYZ = SGSIM_NX * SGSIM_NY * SGSIM_NZ;
const SGSIM_SEEDS = [69069, 12345, 54321, 98765, 11111, 22222, 33333, 44444,
                     55555, 66666, 77777, 88888, 99999, 13579, 24680, 36912,
                     48260, 73951, 86420, 97531];

function runFortranSgsim(seed) {
  const workdir = join(tmpdir(), `gslib_val_f_${Date.now()}_${seed}`);
  mkdirSync(workdir, { recursive: true });

  const par = `                  Parameters for SGSIM
                  ********************

START OF PARAMETERS:
none                          -file with data
1  2  0  3  5  0              -  columns for X,Y,Z,vr,wt,sec.var.
-1.0       1.0e21             -  trimming limits
0                             -transform the data (0=no, 1=yes)
sgsim.trn                     -  file for output trans table
0                             -  consider ref. dist (0=no, 1=yes)
histsmth.out                  -  file with ref. dist distribution
1  2                          -  columns for vr and wt
-3.0    3.0                   -  zmin,zmax(tail extrapolation)
1      -3.0                   -  lower tail option, parameter
1       3.0                   -  upper tail option, parameter
0                             -debugging level: 0,1,2,3
sgsim.dbg                     -file for debugging output
sgsim.out                     -file for simulation output
1                             -number of realizations to generate
${SGSIM_NX}    0.5    1.0               -nx,xmn,xsiz
${SGSIM_NY}    0.5    1.0               -ny,ymn,ysiz
${SGSIM_NZ}    0.5    1.0               -nz,zmn,zsiz
${seed}                         -random number seed
0     10                       -min and max original data for sim
12                            -number of simulated nodes to use
1                             -assign data to nodes (0=no, 1=yes)
0     3                       -multiple grid search (0=no, 1=yes),num
0                             -maximum data per octant (0=not used)
20.0  20.0  20.0              -maximum search radii (hmax,hmin,vert)
 0.0   0.0   0.0              -angles for search ellipsoid
5     5     1                  -size of covariance lookup table
0     0.0                     -ktype: 0=SK,1=OK,2=LVM,3=EXDR,4=COLC
none                          -  file with LVM, EXDR, or COLC variable
0                             -  column for secondary variable
1    0.0                      -nst, nugget effect
1    1.0  0.0   0.0   0.0     -it,cc,ang1,ang2,ang3
          10.0  10.0  10.0    -a_hmax, a_hmin, a_vert
`;

  writeFileSync(join(workdir, 'sgsim.par'), par);
  try {
    execSync(`echo sgsim.par | "${join(GSLIB90, 'sgsim.exe')}"`, {
      cwd: workdir, timeout: 30000, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    console.error(`  Fortran sgsim failed (seed=${seed}):`, e.stderr?.slice(0, 200) || e.message);
    return null;
  }

  const outFile = readFileSync(join(workdir, 'sgsim.out'), 'utf8');
  const values = [];
  let dataStart = false;
  for (const line of outFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'value') { dataStart = true; continue; }
    if (!dataStart) continue;
    const num = parseFloat(trimmed);
    if (!isNaN(num)) values.push(num);
  }

  // cleanup
  try { rmSync(workdir, { recursive: true }); } catch {}
  return values;
}

async function runAtraSgsim(seed) {
  const mod = await getGslib();
  const memory = new WebAssembly.Memory({ initial: 64 });
  const lib = mod.instantiate({ memory });

  const NX = SGSIM_NX, NY = SGSIM_NY, NZ = SGSIM_NZ;
  const NXYZ = SGSIM_NXYZ;
  const NDMAX = 10, NODMAX = 12;
  const NCTX = 5, NCTY = 5, NCTZ = 0;
  const RADIUS = 20.0;

  let off = 65536;
  const alloc = (nf64 = 0, ni32 = 0) => {
    const o = off;
    off += nf64 * 8 + ni32 * 4;
    off = (off + 7) & ~7;
    return o;
  };

  const NEQ_MAX = NDMAX + NODMAX + 2;
  const MAXCTX = 2 * NCTX + 1;
  const MAXCTY = 2 * NCTY + 1;
  const MAXCTZ = NCTZ === 0 ? 1 : 2 * NCTZ + 1;
  const COVTAB_SIZE = MAXCTX * MAXCTY * MAXCTZ;
  const MAX_LOOKU = COVTAB_SIZE;
  const NSB_MAX = NX * NY * NZ + 10;

  const X = alloc(20), Y = alloc(20), Z = alloc(20);
  const VR = alloc(20), SEC = alloc(20), LVM = alloc(NXYZ);
  const pIT = alloc(0, 4), pCC = alloc(4), pAA = alloc(4);
  const ROTMAT = alloc(18);
  const NISB = alloc(0, NSB_MAX), SUPOUT = alloc(20);
  const IXSBTOSR = alloc(0, NSB_MAX), IYSBTOSR = alloc(0, NSB_MAX), IZSBTOSR = alloc(0, NSB_MAX);
  const COVTAB = alloc(COVTAB_SIZE);
  const IXNODE = alloc(0, MAX_LOOKU), IYNODE = alloc(0, MAX_LOOKU), IZNODE = alloc(0, MAX_LOOKU);
  const IXV = alloc(0, 13);
  const SIM = alloc(NXYZ), ORDER = alloc(NXYZ), CLOSE = alloc(NDMAX);
  const ICNODE = alloc(0, NODMAX);
  const CNODEX = alloc(NODMAX), CNODEY = alloc(NODMAX), CNODEZ = alloc(NODMAX), CNODEV = alloc(NODMAX);
  const A = alloc(NEQ_MAX * (NEQ_MAX + 1) / 2);
  const R = alloc(NEQ_MAX), RR = alloc(NEQ_MAX), S_ = alloc(NEQ_MAX);
  const VRA = alloc(NEQ_MAX), VREA = alloc(NEQ_MAX);
  const COVRES = alloc(2), GETIDXRES = alloc(0, 2), INOCT = alloc(0, 8);
  const LT = alloc(0, 64), UT = alloc(0, 64);
  const TMP = alloc(MAX_LOOKU);
  const CT_TMP = alloc(MAX_LOOKU), CT_ORDER = alloc(MAX_LOOKU), CT_RESULT = alloc(2);
  const SU_IDX2 = alloc(0, 2), SU_IXARR = alloc(0, 20), NSBTOSR_BUF = alloc(0, 1);
  const tmpX = alloc(20), tmpY = alloc(20), tmpZ = alloc(20), tmpVR_ = alloc(20);

  const needed = Math.ceil(off / 65536);
  if (memory.buffer.byteLength / 65536 < needed)
    memory.grow(needed - memory.buffer.byteLength / 65536 + 1);

  writeF64(memory, LVM, new Array(NXYZ).fill(0.0));
  writeI32(memory, pIT, [1]);
  writeF64(memory, pCC, [1.0]);
  writeF64(memory, pAA, [10.0]);

  lib.gslib.setrot(0, 0, 0, 1, 1, 0, ROTMAT);
  lib.gslib.setrot(0, 0, 0, 1, 1, 1, ROTMAT);

  lib.gslib.setsupr(
    NX, 0.5, 1.0, NY, 0.5, 1.0, NZ, 0.5, 1.0,
    0, tmpX, tmpY, tmpZ, tmpVR_, TMP,
    NISB, SU_IDX2, SU_IXARR, LT, UT, NX, NY, NZ, SUPOUT
  );

  const supout = readF64(memory, SUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6], supout[1], supout[7], supout[2], supout[8],
    1, ROTMAT, RADIUS * RADIUS, NSBTOSR_BUF, IXSBTOSR, IYSBTOSR, IZSBTOSR
  );
  const nsbtosr = readI32(memory, NSBTOSR_BUF, 1)[0];

  lib.gslib.ctable(
    1, 0.0, pIT, pCC, pAA, 0, 1, ROTMAT, RADIUS * RADIUS,
    NX, NY, NZ, 1.0, 1.0, 1.0, NCTX, NCTY, NCTZ,
    COVTAB, COVRES, CT_TMP, CT_ORDER, IXNODE, IYNODE, IZNODE, LT, UT, CT_RESULT
  );

  const ctres = readF64(memory, CT_RESULT, 2);
  const nlooku = ctres[0], cbb = ctres[1];

  writeI32(memory, IXV, [seed, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  lib.gslib.sgsim(
    NX, NY, NZ, 0.5, 0.5, 0.5, 1.0, 1.0, 1.0,
    0, X, Y, Z, VR, SEC, LVM, 0.0,
    0, NDMAX, RADIUS,
    0, 0, 0, 1, 1,
    0, NODMAX, 0,
    1, 0.0, pIT, pCC, pAA,
    0, ROTMAT, RADIUS * RADIUS, 1,
    nsbtosr, IXSBTOSR, IYSBTOSR, IZSBTOSR, NISB, SUPOUT,
    NCTX, NCTY, NCTZ, nlooku, COVTAB, IXNODE, IYNODE, IZNODE, cbb,
    IXV, SIM, ORDER, CLOSE, ICNODE,
    CNODEX, CNODEY, CNODEZ, CNODEV,
    A, R, RR, S_, VRA, VREA,
    COVRES, GETIDXRES, INOCT, LT, UT, TMP
  );

  return readF64(memory, SIM, NXYZ);
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 2: KB2D — 2D kriging (deterministic, parameterized)
// ═══════════════════════════════════════════════════════════════════

// cfg: { name, data, nx, ny, nxdis, nydis, ndmin, ndmax, radius,
//         ktype, skmean, nst, c0, structures: [{it, cc, ang, a_max, a_min}] }

const KB2D_DATA_DEFAULT = [
  [1.0, 1.0,  0.5],
  [3.0, 2.0,  1.2],
  [5.0, 5.0, -0.3],
  [2.0, 7.0,  0.8],
  [7.0, 3.0,  1.5],
  [8.0, 8.0, -0.1],
  [4.0, 9.0,  0.4],
  [9.0, 1.0,  2.0],
];

const KB2D_TESTS = [
  {
    name: '2a: isotropic spherical OK',
    data: KB2D_DATA_DEFAULT,
    nx: 10, ny: 10, nxdis: 1, nydis: 4,
    ndmin: 1, ndmax: 8, radius: 20.0,
    ktype: 0, skmean: 0.0,
    nst: 1, c0: 0.0,
    structures: [{ it: 1, cc: 1.0, ang: 0.0, a_max: 10.0, a_min: 10.0 }],
  },
  {
    name: '2b: anisotropic spherical',
    data: KB2D_DATA_DEFAULT,
    nx: 10, ny: 10, nxdis: 1, nydis: 4,
    ndmin: 1, ndmax: 8, radius: 20.0,
    ktype: 0, skmean: 0.0,
    nst: 1, c0: 0.0,
    structures: [{ it: 1, cc: 0.5, ang: 45.0, a_max: 15.0, a_min: 5.0 }],
  },
  {
    name: '2c: nested nugget+sph+exp',
    data: KB2D_DATA_DEFAULT,
    nx: 10, ny: 10, nxdis: 1, nydis: 4,
    ndmin: 1, ndmax: 8, radius: 20.0,
    ktype: 0, skmean: 0.0,
    nst: 2, c0: 0.2,
    structures: [
      { it: 1, cc: 0.5, ang: 0.0, a_max: 8.0, a_min: 8.0 },
      { it: 2, cc: 0.3, ang: 0.0, a_max: 20.0, a_min: 20.0 },
    ],
  },
  {
    name: '2d: nested anisotropic',
    data: KB2D_DATA_DEFAULT,
    nx: 10, ny: 10, nxdis: 1, nydis: 4,
    ndmin: 1, ndmax: 8, radius: 20.0,
    ktype: 0, skmean: 0.0,
    nst: 2, c0: 0.1,
    structures: [
      { it: 1, cc: 0.4, ang: 30.0, a_max: 10.0, a_min: 3.0 },
      { it: 3, cc: 0.5, ang: 120.0, a_max: 25.0, a_min: 10.0 },
    ],
  },
];

function runFortranKb2d(cfg) {
  const workdir = join(tmpdir(), `gslib_val_kb2d_${Date.now()}`);
  mkdirSync(workdir, { recursive: true });

  let dataStr = 'kb2d test data\n3\nx\ny\nvalue\n';
  for (const [x, y, v] of cfg.data) {
    dataStr += `${x.toFixed(4)}  ${y.toFixed(4)}  ${v.toFixed(4)}\n`;
  }
  writeFileSync(join(workdir, 'data.dat'), dataStr);

  // Build structure lines for par file
  // kb2d format: one line per structure: it  cc  ang  a_max  a_min
  const structLines = cfg.structures.map(s =>
    `${s.it}     ${s.cc.toFixed(1)}  ${s.ang.toFixed(1)}  ${s.a_max.toFixed(1)}  ${s.a_min.toFixed(1)}    -it, cc, ang, a_max, a_min`
  ).join('\n');

  const par = `                  Parameters for KB2D
                  ********************

START OF PARAMETERS:
data.dat                      -file with data
1  2  3                       -  columns for X, Y, and variable
-1.0e21    1.0e21             -  trimming limits
0                             -debugging level: 0,1,2,3
kb2d.dbg                      -file for debugging output
kb2d.out                      -file for kriged output
${cfg.nx}    0.5    1.0              -nx,xmn,xsiz
${cfg.ny}    0.5    1.0              -ny,ymn,ysiz
${cfg.nxdis}     ${cfg.nydis}                       -nxdis,nydis
${cfg.ndmin}     ${cfg.ndmax}                       -ndmin,ndmax
${cfg.radius.toFixed(1)}                          -maximum search radius
${cfg.ktype}     ${cfg.skmean.toFixed(1)}                     -0=SK, 1=OK, (mean if SK)
${cfg.nst}     ${cfg.c0.toFixed(1)}                     -nst, nugget effect
${structLines}
`;

  writeFileSync(join(workdir, 'kb2d.par'), par);
  try {
    execSync(`echo kb2d.par | "${join(GSLIB90, 'kb2d.exe')}"`, {
      cwd: workdir, timeout: 30000, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    console.error(`  Fortran kb2d failed [${cfg.name}]:`, e.stderr?.slice(0, 300) || e.message);
    return null;
  }

  const outFile = readFileSync(join(workdir, 'kb2d.out'), 'utf8');
  const lines = outFile.split('\n');
  let headerLines = 0, ncol = 0;
  const estimates = [], variances = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    headerLines++;
    if (headerLines === 2) { ncol = parseInt(trimmed); continue; }
    if (headerLines <= 2 + ncol) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      estimates.push(parseFloat(parts[0]));
      variances.push(parseFloat(parts[1]));
    }
  }

  try { rmSync(workdir, { recursive: true }); } catch {}
  return { estimates, variances };
}

async function runAtraKb2d(cfg) {
  const mod = await getGslib();
  const memory = new WebAssembly.Memory({ initial: 16 });
  const lib = mod.instantiate({ memory });

  const { nx: NX, ny: NY, nxdis: NXDIS, nydis: NYDIS, ndmax: NDMAX, radius: RADIUS } = cfg;
  const nd = cfg.data.length;

  let off = 65536;
  const alloc = (nf64 = 0, ni32 = 0) => {
    const o = off;
    off += nf64 * 8 + ni32 * 4;
    off = (off + 7) & ~7;
    return o;
  };

  const X = alloc(20), Y = alloc(20), VR = alloc(20);
  const nst = cfg.nst;
  const pIT = alloc(0, nst + 4), pCC = alloc(nst + 4), pAA = alloc(nst + 4);
  const EST = alloc(NX * NY), ESTV = alloc(NX * NY);
  // Rotation: 9 f64 per structure
  const ROTMAT = alloc(9 * nst);
  const XA = alloc(NDMAX + 1), YA = alloc(NDMAX + 1);
  const VRA = alloc(NDMAX + 1), DIST = alloc(NDMAX + 1), NUMS = alloc(NDMAX + 1);
  const NEQ = NDMAX + 1;
  const KR = alloc(NEQ), KRR = alloc(NEQ), KS = alloc(NEQ);
  const KA = alloc(NEQ * (NEQ + 1) / 2);
  const XDB = alloc(NXDIS * NYDIS), YDB = alloc(NXDIS * NYDIS);
  const COVRES = alloc(2), KSOLRES = alloc(1);

  const needed = Math.ceil(off / 65536);
  if (memory.buffer.byteLength / 65536 < needed)
    memory.grow(needed - memory.buffer.byteLength / 65536 + 1);

  writeF64(memory, X, cfg.data.map(d => d[0]));
  writeF64(memory, Y, cfg.data.map(d => d[1]));
  writeF64(memory, VR, cfg.data.map(d => d[2]));

  // Variogram structures
  writeI32(memory, pIT, cfg.structures.map(s => s.it));
  writeF64(memory, pCC, cfg.structures.map(s => s.cc));
  writeF64(memory, pAA, cfg.structures.map(s => s.a_max));

  // Rotation matrices — one per structure
  for (let is = 0; is < nst; is++) {
    const s = cfg.structures[is];
    const anis = s.a_min / s.a_max;
    lib.gslib.setrot(s.ang, 0, 0, anis, 1.0, is, ROTMAT);
  }

  lib.gslib.kb2d(
    NX, NY, 0.5, 0.5, 1.0, 1.0,
    NXDIS, NYDIS,
    nd, X, Y, VR,
    cfg.ndmin, NDMAX, RADIUS,
    cfg.ktype, cfg.skmean,
    nst, cfg.c0,
    pIT, pCC, pAA,
    0, ROTMAT,
    EST, ESTV,
    XA, YA, VRA, DIST, NUMS,
    KR, KRR, KS, KA,
    XDB, YDB, COVRES, KSOLRES
  );

  return {
    estimates: readF64(memory, EST, NX * NY),
    variances: readF64(memory, ESTV, NX * NY),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  TEST 3: KT3D — 3D kriging (deterministic, parameterized)
// ═══════════════════════════════════════════════════════════════════

// cfg: { name, data, nx, ny, nz, nxdis, nydis, nzdis, ndmin, ndmax, radius,
//         sang1, sang2, sang3, sanis1, sanis2,
//         ktype, skmean, nst, c0,
//         structures: [{it, cc, ang1, ang2, ang3, ahmax, ahmin, avert}] }

const KT3D_DATA_DEFAULT = [
  [1.0, 1.0, 0.5, 0.5],
  [3.0, 2.0, 0.5, 1.2],
  [5.0, 5.0, 0.5, -0.3],
  [2.0, 7.0, 0.5, 0.8],
  [7.0, 3.0, 0.5, 1.5],
  [8.0, 8.0, 0.5, -0.1],
  [4.0, 9.0, 1.5, 0.4],
  [9.0, 1.0, 1.5, 2.0],
  [1.0, 5.0, 1.5, 0.3],
  [6.0, 6.0, 2.5, -0.5],
  [3.0, 3.0, 2.5, 1.1],
  [8.0, 4.0, 2.5, 0.7],
];

const KT3D_DATA_SPARSE = [
  [2.0, 2.0, 0.5, 1.0],
  [8.0, 2.0, 0.5, 0.5],
  [2.0, 8.0, 0.5, -0.2],
  [8.0, 8.0, 0.5, 0.8],
];

const KT3D_DATA_CLUSTERED = [
  [4.0, 4.0, 0.5, 1.0],
  [4.5, 4.0, 0.5, 1.1],
  [4.0, 4.5, 0.5, 0.9],
  [4.5, 4.5, 0.5, 1.2],
  [5.0, 4.0, 0.5, 0.8],
  [4.0, 5.0, 0.5, 1.0],
  [5.0, 5.0, 0.5, 0.7],
  [5.0, 4.5, 0.5, 1.1],
];

function kt3dDefaults(overrides) {
  return {
    data: KT3D_DATA_DEFAULT,
    nx: 10, ny: 10, nz: 3,
    nxdis: 1, nydis: 1, nzdis: 1,
    ndmin: 1, ndmax: 12, radius: 20.0,
    sang1: 0, sang2: 0, sang3: 0, sanis1: 1.0, sanis2: 1.0,
    ktype: 1, skmean: 0.0,
    nst: 1, c0: 0.1,
    structures: [{ it: 1, cc: 0.9, ang1: 0, ang2: 0, ang3: 0, ahmax: 15, ahmin: 15, avert: 15 }],
    ...overrides,
  };
}

const KT3D_TESTS = [
  kt3dDefaults({ name: '3a: isotropic spherical OK' }),
  kt3dDefaults({
    name: '3b: anisotropic search+vario',
    sang1: 45, sanis1: 7.0 / 20.0, sanis2: 1.0,
    structures: [{ it: 1, cc: 0.9, ang1: 45, ang2: 0, ang3: 0, ahmax: 15, ahmin: 5, avert: 15 }],
  }),
  kt3dDefaults({
    name: '3c: nested sph+exp',
    nst: 2, c0: 0.1,
    structures: [
      { it: 1, cc: 0.5, ang1: 0, ang2: 0, ang3: 0, ahmax: 10, ahmin: 10, avert: 10 },
      { it: 2, cc: 0.4, ang1: 60, ang2: 0, ang3: 0, ahmax: 30, ahmin: 15, avert: 30 },
    ],
  }),
  kt3dDefaults({
    name: '3d: simple kriging',
    ktype: 0, skmean: 0.5,
  }),
  kt3dDefaults({
    name: '3e: block kriging',
    nxdis: 3, nydis: 3, nzdis: 1,
  }),
  kt3dDefaults({
    name: '3f: sparse/ndmin stress',
    data: KT3D_DATA_SPARSE,
    nx: 10, ny: 10, nz: 1,
    ndmin: 2, ndmax: 4, radius: 5.0,
    sang1: 0, sang2: 0, sang3: 0, sanis1: 1.0, sanis2: 1.0,
    nst: 1, c0: 0.1,
    structures: [{ it: 1, cc: 0.9, ang1: 0, ang2: 0, ang3: 0, ahmax: 10, ahmin: 10, avert: 10 }],
  }),
  kt3dDefaults({
    name: '3g: clustered near-singular',
    data: KT3D_DATA_CLUSTERED,
    nx: 10, ny: 10, nz: 1,
    ndmin: 1, ndmax: 8, radius: 20.0,
    nst: 1, c0: 0.05,
    structures: [{ it: 1, cc: 0.95, ang1: 0, ang2: 0, ang3: 0, ahmax: 3, ahmin: 3, avert: 3 }],
    // Near-singular system: Fortran f32 solver diverges from f64 — relax threshold
    threshold: 0.1,
  }),
  kt3dDefaults({
    name: '3h: Gaussian variogram',
    nst: 1, c0: 0.1,
    structures: [{ it: 3, cc: 0.9, ang1: 0, ang2: 0, ang3: 0, ahmax: 12, ahmin: 12, avert: 12 }],
  }),
];

function runFortranKt3d(cfg) {
  const workdir = join(tmpdir(), `gslib_val_kt3d_${Date.now()}`);
  mkdirSync(workdir, { recursive: true });

  let dataStr = 'kt3d test data\n4\nx\ny\nz\nvalue\n';
  for (const [x, y, z, v] of cfg.data) {
    dataStr += `${x.toFixed(4)}  ${y.toFixed(4)}  ${z.toFixed(4)}  ${v.toFixed(4)}\n`;
  }
  writeFileSync(join(workdir, 'data.dat'), dataStr);

  // Build structure lines — kt3d format: 2 lines per structure
  //   it  cc  ang1  ang2  ang3
  //       ahmax  ahmin  avert
  const structLines = cfg.structures.map(s =>
    `${s.it}    ${s.cc.toFixed(1)}  ${s.ang1.toFixed(1)}   ${s.ang2.toFixed(1)}   ${s.ang3.toFixed(1)}     -it,cc,ang1,ang2,ang3\n` +
    `         ${s.ahmax.toFixed(1)}  ${s.ahmin.toFixed(1)}  ${s.avert.toFixed(1)}     -a_hmax, a_hmin, a_vert`
  ).join('\n');

  // Search radii: radius is the max, apply anisotropy ratios
  const srad1 = cfg.radius * cfg.sanis1;
  const srad2 = cfg.radius * cfg.sanis2;

  const par = `                  Parameters for KT3D
                  ********************

START OF PARAMETERS:
data.dat                      -file with data
0  1  2  3  4  0              -  columns for DH,X,Y,Z,var,sec var
-1.0e21    1.0e21             -  trimming limits
0                             -option: 0=grid, 1=cross, 2=jackknife
data.dat                      -  jackknife file (not used)
0  0  0  0  0                 -  columns (not used)
0                             -debugging level: 0,1,2,3
kt3d.dbg                      -file for debugging output
kt3d.out                      -file for kriged output
${cfg.nx}    0.5    1.0              -nx,xmn,xsiz
${cfg.ny}    0.5    1.0              -ny,ymn,ysiz
${cfg.nz}    0.5    1.0              -nz,zmn,zsiz
${cfg.nxdis}     ${cfg.nydis}     ${cfg.nzdis}                 -x,y,z block discretization
${cfg.ndmin}     ${cfg.ndmax}                      -ndmin, ndmax
0                             -max per octant (0=not used)
${cfg.radius.toFixed(1)}  ${srad1.toFixed(1)}  ${srad2.toFixed(1)}              -search radii
 ${cfg.sang1.toFixed(1)}   ${cfg.sang2.toFixed(1)}   ${cfg.sang3.toFixed(1)}              -search angles
${cfg.ktype}     ${cfg.skmean.toFixed(1)}                     -ktype(0=SK,1=OK,2=non-st SK), skmean
0 0 0 0 0 0 0 0 0             -drift terms
0                             -0=no external drift, 1=yes
noextdrift.dat                -  file with external drift variable
0                             -  column number
${cfg.nst}    ${cfg.c0.toFixed(1)}                      -nst, nugget effect
${structLines}
`;

  writeFileSync(join(workdir, 'kt3d.par'), par);
  try {
    execSync(`echo kt3d.par | "${join(GSLIB90, 'kt3d.exe')}"`, {
      cwd: workdir, timeout: 30000, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) {
    console.error(`  Fortran kt3d failed [${cfg.name}]:`, e.stderr?.slice(0, 300) || e.message);
    return null;
  }

  const outFile = readFileSync(join(workdir, 'kt3d.out'), 'utf8');
  const lines = outFile.split('\n');
  let headerLines = 0, ncol = 0;
  const estimates = [], variances = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    headerLines++;
    if (headerLines === 2) { ncol = parseInt(trimmed); continue; }
    if (headerLines <= 2 + ncol) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      estimates.push(parseFloat(parts[0]));
      variances.push(parseFloat(parts[1]));
    }
  }

  try { rmSync(workdir, { recursive: true }); } catch {}
  return { estimates, variances };
}

async function runAtraKt3d(cfg) {
  const mod = await getGslib();
  const memory = new WebAssembly.Memory({ initial: 64 });
  const lib = mod.instantiate({ memory });

  const { nx: NX, ny: NY, nz: NZ, ndmax: NDMAX, radius: RADIUS } = cfg;
  const nd = cfg.data.length;
  const NXYZ = NX * NY * NZ;
  const nst = cfg.nst;
  const MDT_MAX = 10;
  const NEQ_MAX = NDMAX + MDT_MAX;

  let off = 65536;
  const alloc = (nf64 = 0, ni32 = 0) => {
    const o = off;
    off += nf64 * 8 + ni32 * 4;
    off = (off + 7) & ~7;
    return o;
  };

  // Data (generous allocation)
  const X = alloc(nd + 20), Y = alloc(nd + 20), Z = alloc(nd + 20);
  const VR = alloc(nd + NXYZ + 20), VE = alloc(nd + NXYZ + 20);
  // Variogram
  const pIT = alloc(0, nst + 4), pCC = alloc(nst + 4), pAA = alloc(nst + 4);
  // Rotation: nst structures + 1 search = (nst+1) * 9 f64
  const ROTMAT = alloc(9 * (nst + 1));
  // Drift flags
  const IDRIF = alloc(0, 9);
  // Super block
  const maxsbx = NX > 1 ? Math.min(Math.floor(NX / 2), 50) : 1;
  const maxsby = NY > 1 ? Math.min(Math.floor(NY / 2), 50) : 1;
  const maxsbz = NZ > 1 ? Math.min(Math.floor(NZ / 2), 50) : 1;
  const MAXSB = maxsbx * maxsby * maxsbz;
  const NISB = alloc(0, MAXSB + 10), SUPOUT = alloc(20);
  const SBTOSR_SIZE = 8 * MAXSB;
  const IXSBTOSR = alloc(0, SBTOSR_SIZE), IYSBTOSR = alloc(0, SBTOSR_SIZE), IZSBTOSR = alloc(0, SBTOSR_SIZE);
  // Output
  const EST = alloc(NXYZ), ESTV = alloc(NXYZ);
  // Scratch
  const XA = alloc(NDMAX), YA = alloc(NDMAX), ZA = alloc(NDMAX);
  const VRA = alloc(NDMAX), VEA = alloc(NDMAX);
  const R = alloc(NEQ_MAX), RR = alloc(NEQ_MAX), S_ = alloc(NEQ_MAX);
  const KA = alloc(NEQ_MAX * NEQ_MAX);
  const ndisc = cfg.nxdis * cfg.nydis * cfg.nzdis;
  const XDB = alloc(Math.max(ndisc, 27)), YDB = alloc(Math.max(ndisc, 27)), ZDB = alloc(Math.max(ndisc, 27));
  const CLOSE = alloc(NDMAX);
  const COVRES = alloc(2);
  const INOCT = alloc(0, 8);
  const GETIDX = alloc(0, 2);
  const TMP = alloc(nd + 20);
  const IXARR = alloc(0, nd + 20), IDX2 = alloc(0, 2);
  const LT = alloc(0, 64), UT = alloc(0, 64);
  const NSBTOSR_BUF = alloc(0, 1);

  const needed = Math.ceil(off / 65536);
  if (memory.buffer.byteLength / 65536 < needed)
    memory.grow(needed - memory.buffer.byteLength / 65536 + 1);

  // Write data
  writeF64(memory, X, cfg.data.map(d => d[0]));
  writeF64(memory, Y, cfg.data.map(d => d[1]));
  writeF64(memory, Z, cfg.data.map(d => d[2]));
  writeF64(memory, VR, cfg.data.map(d => d[3]));
  writeF64(memory, VE, new Array(nd).fill(1.0));

  // Variogram structures
  writeI32(memory, pIT, cfg.structures.map(s => s.it));
  writeF64(memory, pCC, cfg.structures.map(s => s.cc));
  writeF64(memory, pAA, cfg.structures.map(s => s.ahmax));
  writeI32(memory, IDRIF, [0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // Rotation matrices — one per variogram structure
  for (let is = 0; is < nst; is++) {
    const s = cfg.structures[is];
    const anis1 = s.ahmin / s.ahmax;
    const anis2 = s.avert / s.ahmax;
    lib.gslib.setrot(s.ang1, s.ang2, s.ang3, anis1, anis2, is, ROTMAT);
  }
  // Search rotation at slot nst
  lib.gslib.setrot(cfg.sang1, cfg.sang2, cfg.sang3, cfg.sanis1, cfg.sanis2, nst, ROTMAT);

  // Super block search
  lib.gslib.setsupr(
    NX, 0.5, 1.0, NY, 0.5, 1.0, NZ, 0.5, 1.0,
    nd, X, Y, Z, VR, TMP,
    NISB, IDX2, IXARR, LT, UT,
    maxsbx, maxsby, maxsbz, SUPOUT
  );

  // VE needs same reorder as setsupr did to X,Y,Z,VR
  writeF64(memory, VE, new Array(nd).fill(1.0));

  const supout = readF64(memory, SUPOUT, 9);
  lib.gslib.picksup(
    supout[0], supout[6],
    supout[1], supout[7],
    supout[2], supout[8],
    nst, ROTMAT,
    RADIUS * RADIUS,
    NSBTOSR_BUF,
    IXSBTOSR, IYSBTOSR, IZSBTOSR
  );
  const nsbtosr = readI32(memory, NSBTOSR_BUF, 1)[0];

  // Init output to UNEST
  const unestArr = new Array(NXYZ).fill(-999.0);
  writeF64(memory, EST, unestArr);
  writeF64(memory, ESTV, unestArr);

  lib.gslib.kt3d(
    NX, NY, NZ, 0.5, 0.5, 0.5, 1.0, 1.0, 1.0,
    cfg.nxdis, cfg.nydis, cfg.nzdis,
    nd, X, Y, Z, VR, VE,
    cfg.ndmin, NDMAX, RADIUS,
    cfg.sang1, cfg.sang2, cfg.sang3, cfg.sanis1, cfg.sanis2,
    cfg.ktype, cfg.skmean,
    IDRIF,
    nst, cfg.c0, pIT, pCC, pAA,
    0, ROTMAT,
    nsbtosr, IXSBTOSR, IYSBTOSR, IZSBTOSR, NISB,
    SUPOUT,
    EST, ESTV,
    XA, YA, ZA, VRA, VEA,
    R, RR, S_, KA,
    XDB, YDB, ZDB,
    CLOSE, COVRES,
    INOCT, GETIDX,
    LT, UT
  );

  return {
    estimates: readF64(memory, EST, NXYZ),
    variances: readF64(memory, ESTV, NXYZ),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  let allPass = true;

  // ─── Test 1: SGSIM ───────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log('  TEST 1: sgsim — unconditional, 20 realizations');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Grid: ${SGSIM_NX}x${SGSIM_NY}x${SGSIM_NZ} = ${SGSIM_NXYZ} nodes`);
  console.log(`Variogram: spherical, c0=0, cc=1, range=10`);
  console.log(`SK, radius=20, ${SGSIM_SEEDS.length} seeds\n`);

  const allFortran = [], allAtra = [];
  const fMeans = [], aMeans = [], fVars = [], aVars = [];

  for (let i = 0; i < SGSIM_SEEDS.length; i++) {
    const seed = SGSIM_SEEDS[i];
    process.stdout.write(`  Seed ${seed} (${i + 1}/${SGSIM_SEEDS.length})...`);

    const fvals = runFortranSgsim(seed);
    const avals = await runAtraSgsim(seed);

    if (!fvals) { allPass = false; continue; }

    allFortran.push(...fvals);
    allAtra.push(...avals);
    const sf = stats(fvals), sa = stats(avals);
    fMeans.push(sf.mean); aMeans.push(sa.mean);
    fVars.push(sf.variance); aVars.push(sa.variance);
    console.log(` F(mean=${sf.mean.toFixed(3)}, var=${sf.variance.toFixed(3)})  A(mean=${sa.mean.toFixed(3)}, var=${sa.variance.toFixed(3)})`);
  }

  console.log(`\nAggregate over ${allFortran.length} values (${SGSIM_SEEDS.length} realizations x ${SGSIM_NXYZ} nodes):`);
  const sf = stats(allFortran), sa = stats(allAtra);
  console.log('           Fortran     Atra       Diff');
  console.log('           -------     ----       ----');
  printRow('mean', sf.mean, sa.mean);
  printRow('std', sf.std, sa.std);
  printRow('variance', sf.variance, sa.variance);
  printRow('min', sf.min, sa.min);
  printRow('max', sf.max, sa.max);
  printRow('p10', sf.p10, sa.p10);
  printRow('median', sf.median, sa.median);
  printRow('p90', sf.p90, sa.p90);

  const avgFMean = fMeans.reduce((a, b) => a + b, 0) / fMeans.length;
  const avgAMean = aMeans.reduce((a, b) => a + b, 0) / aMeans.length;
  const avgFVar = fVars.reduce((a, b) => a + b, 0) / fVars.length;
  const avgAVar = aVars.reduce((a, b) => a + b, 0) / aVars.length;

  console.log('\nPer-realization averages:');
  console.log(`  avg(mean):     Fortran=${avgFMean.toFixed(4)}  Atra=${avgAMean.toFixed(4)}`);
  console.log(`  avg(variance): Fortran=${avgFVar.toFixed(4)}  Atra=${avgAVar.toFixed(4)}`);

  const sgsimMeanOk = Math.abs(sf.mean - sa.mean) < 0.2;
  const sgsimVarOk = Math.abs(sf.variance - sa.variance) / Math.max(sf.variance, 0.01) < 0.3;
  console.log(`\n  Mean diff:     ${Math.abs(sf.mean - sa.mean).toFixed(4)} ${sgsimMeanOk ? 'PASS' : 'FAIL'}`);
  console.log(`  Variance ratio: ${(sa.variance / sf.variance).toFixed(4)} ${sgsimVarOk ? 'PASS' : 'FAIL'}`);
  if (!sgsimMeanOk || !sgsimVarOk) allPass = false;

  // ─── Test 2: KB2D ────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  TEST 2: kb2d — 2D kriging (' + KB2D_TESTS.length + ' configs)');
  console.log('══════════════════════════════════════════════════════════');

  for (const cfg of KB2D_TESTS) {
    console.log(`\n--- ${cfg.name} ---`);
    console.log(`Grid: ${cfg.nx}x${cfg.ny}, ${cfg.data.length} data, nst=${cfg.nst}, c0=${cfg.c0}`);
    const vDesc = cfg.structures.map(s =>
      `it=${s.it} cc=${s.cc} ang=${s.ang} amax=${s.a_max} amin=${s.a_min}`).join('; ');
    console.log(`Variogram: ${vDesc}`);

    console.log('  Running Fortran...');
    const fResult = runFortranKb2d(cfg);
    console.log('  Running Atra...');
    const aResult = await runAtraKb2d(cfg);

    if (fResult) {
      const ok = compareKriging(cfg.name, fResult, aResult, cfg.nx * cfg.ny);
      if (!ok) allPass = false;
    } else {
      console.log('  Fortran kb2d failed — skipping comparison');
      allPass = false;
    }
  }

  // ─── Test 3: KT3D ──────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  TEST 3: kt3d — 3D kriging (' + KT3D_TESTS.length + ' configs)');
  console.log('══════════════════════════════════════════════════════════');

  for (const cfg of KT3D_TESTS) {
    const NXYZ = cfg.nx * cfg.ny * cfg.nz;
    console.log(`\n--- ${cfg.name} ---`);
    console.log(`Grid: ${cfg.nx}x${cfg.ny}x${cfg.nz}=${NXYZ}, ${cfg.data.length} data, ktype=${cfg.ktype}, nst=${cfg.nst}, c0=${cfg.c0}`);
    if (cfg.nxdis > 1 || cfg.nydis > 1 || cfg.nzdis > 1)
      console.log(`Block: ${cfg.nxdis}x${cfg.nydis}x${cfg.nzdis}`);
    const vDesc = cfg.structures.map(s =>
      `it=${s.it} cc=${s.cc} a1=${s.ang1} ahmax=${s.ahmax} ahmin=${s.ahmin} avert=${s.avert}`).join('; ');
    console.log(`Variogram: ${vDesc}`);

    console.log('  Running Fortran...');
    const fResult = runFortranKt3d(cfg);
    console.log('  Running Atra...');
    const aResult = await runAtraKt3d(cfg);

    if (fResult) {
      const ok = compareKriging(cfg.name, fResult, aResult, NXYZ, cfg.threshold);
      if (!ok) allPass = false;
    } else {
      console.log('  Fortran kt3d failed — skipping comparison');
      allPass = false;
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  if (allPass) {
    console.log('  ALL VALIDATION TESTS PASSED');
  } else {
    console.log('  SOME VALIDATION TESTS FAILED');
    process.exit(1);
  }
  console.log('══════════════════════════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
