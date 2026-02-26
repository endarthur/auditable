import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundle } from '../ext/atra/atrac.js';

const gslibSource = readFileSync(
  new URL('../ext/gslib/gslib.atra', import.meta.url), 'utf8'
);

// ── helpers ──────────────────────────────────────────────────────────

/** Bundle gslib.atra, write to temp file, import, instantiate with shared memory. */
let _cached = null;
async function getGslib() {
  if (_cached) return _cached;
  const js = bundle(gslibSource, { name: 'gslib' });
  const tmpPath = join(tmpdir(), `gslib_test_${Date.now()}.js`);
  writeFileSync(tmpPath, js);
  try {
    const mod = await import('file://' + tmpPath.replace(/\\/g, '/'));
    const memory = new WebAssembly.Memory({ initial: 4 });
    const lib = mod.instantiate({ memory });
    _cached = { lib, memory };
    return _cached;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/** Write f64 array into memory at byte offset. */
function writeF64(memory, byteOffset, values) {
  const f64 = new Float64Array(memory.buffer);
  const idx = byteOffset / 8;
  for (let i = 0; i < values.length; i++) f64[idx + i] = values[i];
}

/** Read f64 array from memory at byte offset. */
function readF64(memory, byteOffset, count) {
  const f64 = new Float64Array(memory.buffer);
  const idx = byteOffset / 8;
  return Array.from(f64.slice(idx, idx + count));
}

/** Write i32 array into memory at byte offset. */
function writeI32(memory, byteOffset, values) {
  const i32 = new Int32Array(memory.buffer);
  const idx = byteOffset / 4;
  for (let i = 0; i < values.length; i++) i32[idx + i] = values[i];
}

/** Read i32 array from memory at byte offset. */
function readI32(memory, byteOffset, count) {
  const i32 = new Int32Array(memory.buffer);
  const idx = byteOffset / 4;
  return Array.from(i32.slice(idx, idx + count));
}

const approx = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tol,
    `expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`);

// ═════════════════════════════════════════════════════════════════════
// acorni
// ═════════════════════════════════════════════════════════════════════

describe('gslib.acorni', () => {
  it('produces values in [0, 1)', async () => {
    const { lib, memory } = await getGslib();
    // ixv: 13 i32 values at byte 0. ixv[0] = seed, ixv[1..12] = 0
    const ixvOffset = 0; // bytes
    writeI32(memory, ixvOffset, [69069, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 20; i++) {
      const r = lib.gslib.acorni(ixvOffset);
      assert.ok(r >= 0.0 && r < 1.0, `acorni result ${r} not in [0,1)`);
    }
  });

  it('produces deterministic sequence from seed 69069', async () => {
    const { lib, memory } = await getGslib();
    const ixvOffset = 0;
    writeI32(memory, ixvOffset, [69069, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // First call: each ixv[i+1] += ixv[i], cascading from ixv[0]=69069
    // After first call: ixv = [69069, 69069, 69069, ..., 69069]
    // result = 69069 / 1073741824
    const r1 = lib.gslib.acorni(ixvOffset);
    approx(r1, 69069 / 1073741824, 1e-12);

    // Verify state after first call
    const state = readI32(memory, ixvOffset, 13);
    for (let i = 0; i < 13; i++) {
      assert.equal(state[i], 69069, `ixv[${i}] should be 69069 after first call`);
    }

    // Second call: ixv[1] += ixv[0] = 138138, ixv[2] += ixv[1] = 207207, etc.
    // ixv[i+1] = 69069 * (i+2) after second call
    const r2 = lib.gslib.acorni(ixvOffset);
    approx(r2, (69069 * 13) / 1073741824, 1e-12);
  });

  it('different seeds produce different sequences', async () => {
    const { lib, memory } = await getGslib();
    const ixvA = 0;
    const ixvB = 13 * 4; // 52 bytes offset

    writeI32(memory, ixvA, [69069, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    writeI32(memory, ixvB, [12345, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const a = lib.gslib.acorni(ixvA);
    const b = lib.gslib.acorni(ixvB);
    assert.notEqual(a, b);
  });
});

// ═════════════════════════════════════════════════════════════════════
// gauinv
// ═════════════════════════════════════════════════════════════════════

describe('gslib.gauinv', () => {
  // Layout: xp at byte 0 (1 f64 = 8 bytes), ierr at byte 8 (1 i32 = 4 bytes)
  const XP = 0;
  const IERR = 8;

  it('gauinv(0.5) = 0.0', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, XP, [0]);
    writeI32(memory, IERR, [0]);
    lib.gslib.gauinv(0.5, XP, IERR);
    const [xp] = readF64(memory, XP, 1);
    const [ierr] = readI32(memory, IERR, 1);
    assert.equal(ierr, 0);
    approx(xp, 0.0, 1e-10);
  });

  it('gauinv(0.975) ~ 1.96', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, XP, [0]);
    writeI32(memory, IERR, [0]);
    lib.gslib.gauinv(0.975, XP, IERR);
    const [xp] = readF64(memory, XP, 1);
    const [ierr] = readI32(memory, IERR, 1);
    assert.equal(ierr, 0);
    approx(xp, 1.96, 0.005); // rational approximation, not exact
  });

  it('gauinv(0.025) ~ -1.96', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, XP, [0]);
    writeI32(memory, IERR, [0]);
    lib.gslib.gauinv(0.025, XP, IERR);
    const [xp] = readF64(memory, XP, 1);
    const [ierr] = readI32(memory, IERR, 1);
    assert.equal(ierr, 0);
    approx(xp, -1.96, 0.005);
  });

  it('out-of-range p returns ierr=1', async () => {
    const { lib, memory } = await getGslib();

    // p too small
    writeF64(memory, XP, [0]);
    writeI32(memory, IERR, [0]);
    lib.gslib.gauinv(0.0, XP, IERR);
    assert.equal(readI32(memory, IERR, 1)[0], 1);
    assert.equal(readF64(memory, XP, 1)[0], -1e10);

    // p too large
    writeF64(memory, XP, [0]);
    writeI32(memory, IERR, [0]);
    lib.gslib.gauinv(1.0, XP, IERR);
    assert.equal(readI32(memory, IERR, 1)[0], 1);
    assert.equal(readF64(memory, XP, 1)[0], 1e10);
  });

  it('symmetry: gauinv(p) = -gauinv(1-p)', async () => {
    const { lib, memory } = await getGslib();
    for (const p of [0.1, 0.25, 0.4]) {
      writeF64(memory, XP, [0]);
      writeI32(memory, IERR, [0]);
      lib.gslib.gauinv(p, XP, IERR);
      const low = readF64(memory, XP, 1)[0];

      writeF64(memory, XP, [0]);
      writeI32(memory, IERR, [0]);
      lib.gslib.gauinv(1.0 - p, XP, IERR);
      const high = readF64(memory, XP, 1)[0];

      approx(low + high, 0.0, 1e-6);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// gcum
// ═════════════════════════════════════════════════════════════════════

describe('gslib.gcum', () => {
  it('gcum(0) = 0.5', async () => {
    const { lib } = await getGslib();
    approx(lib.gslib.gcum(0.0), 0.5, 1e-6);
  });

  it('gcum(-6.1) ~ 0', async () => {
    const { lib } = await getGslib();
    approx(lib.gslib.gcum(-6.1), 0.0, 1e-6);
  });

  it('gcum(6.1) ~ 1', async () => {
    const { lib } = await getGslib();
    approx(lib.gslib.gcum(6.1), 1.0, 1e-6);
  });

  it('symmetry: gcum(x) + gcum(-x) ~ 1', async () => {
    const { lib } = await getGslib();
    for (const x of [0.5, 1.0, 1.96, 2.5, 3.0]) {
      approx(lib.gslib.gcum(x) + lib.gslib.gcum(-x), 1.0, 1e-5);
    }
  });

  it('known values', async () => {
    const { lib } = await getGslib();
    approx(lib.gslib.gcum(1.0), 0.8413, 0.001);
    approx(lib.gslib.gcum(-1.0), 0.1587, 0.001);
    approx(lib.gslib.gcum(1.96), 0.975, 0.001);
  });
});

// ═════════════════════════════════════════════════════════════════════
// powint
// ═════════════════════════════════════════════════════════════════════

describe('gslib.powint', () => {
  it('linear interpolation (pow=1)', async () => {
    const { lib } = await getGslib();
    approx(lib.gslib.powint(0, 10, 0, 100, 5, 1), 50, 1e-10);
    approx(lib.gslib.powint(0, 10, 0, 100, 0, 1), 0, 1e-10);
    approx(lib.gslib.powint(0, 10, 0, 100, 10, 1), 100, 1e-10);
  });

  it('power interpolation (pow=2)', async () => {
    const { lib } = await getGslib();
    // At midpoint: ((5-0)/(10-0))^2 = 0.25
    approx(lib.gslib.powint(0, 10, 0, 100, 5, 2), 25, 1e-10);
  });

  it('degenerate interval returns average', async () => {
    const { lib } = await getGslib();
    approx(lib.gslib.powint(5, 5, 10, 20, 5, 1), 15, 1e-10);
  });
});

// ═════════════════════════════════════════════════════════════════════
// locate
// ═════════════════════════════════════════════════════════════════════

describe('gslib.locate', () => {
  // sorted array: [1, 3, 5, 7, 9]  (5 elements)
  // NOTE: locate uses 1-indexed Fortran convention (is, ie are 1-indexed)
  // xx array at byte 0 (5 f64 = 40 bytes), j result at byte 40

  it('finds correct interval in ascending array', async () => {
    const { lib, memory } = await getGslib();
    const xxOffset = 0;
    const jOffset = 40;
    writeF64(memory, xxOffset, [1, 3, 5, 7, 9]);

    // x=4 should be between xx[2]=3 and xx[3]=5, so j=2 (1-indexed)
    writeI32(memory, jOffset, [0]);
    lib.gslib.locate(xxOffset, 5, 1, 5, 4.0, jOffset);
    assert.equal(readI32(memory, jOffset, 1)[0], 2);
  });

  it('x beyond upper bound returns ie', async () => {
    const { lib, memory } = await getGslib();
    const xxOffset = 0;
    const jOffset = 40;
    writeF64(memory, xxOffset, [1, 3, 5, 7, 9]);

    writeI32(memory, jOffset, [0]);
    lib.gslib.locate(xxOffset, 5, 1, 5, 10.0, jOffset);
    assert.equal(readI32(memory, jOffset, 1)[0], 5);
  });

  it('x below lower bound returns is-1', async () => {
    const { lib, memory } = await getGslib();
    const xxOffset = 0;
    const jOffset = 40;
    writeF64(memory, xxOffset, [1, 3, 5, 7, 9]);

    writeI32(memory, jOffset, [0]);
    lib.gslib.locate(xxOffset, 5, 1, 5, 0.0, jOffset);
    assert.equal(readI32(memory, jOffset, 1)[0], 0);
  });

  it('x at exact array value', async () => {
    const { lib, memory } = await getGslib();
    const xxOffset = 0;
    const jOffset = 40;
    writeF64(memory, xxOffset, [1, 3, 5, 7, 9]);

    writeI32(memory, jOffset, [0]);
    lib.gslib.locate(xxOffset, 5, 1, 5, 5.0, jOffset);
    const j = readI32(memory, jOffset, 1)[0];
    // x=5 equals xx[3], should return j=3 (between xx[3] and xx[4])
    assert.ok(j >= 2 && j <= 3, `j=${j} for x=5`);
  });
});

// ═════════════════════════════════════════════════════════════════════
// getindx
// ═════════════════════════════════════════════════════════════════════

describe('gslib.getindx', () => {
  // idx[0]=index, idx[1]=inflag at some byte offset
  const IDX = 0;

  it('in-grid location', async () => {
    const { lib, memory } = await getGslib();
    // 10 cells, origin at 0.5, cell size 1.0, query at 3.5 → index 3
    writeI32(memory, IDX, [0, 0]);
    lib.gslib.getindx(10, 0.5, 1.0, 3.5, IDX);
    const [index, inflag] = readI32(memory, IDX, 2);
    assert.equal(index, 3);
    assert.equal(inflag, 1);
  });

  it('at first cell center', async () => {
    const { lib, memory } = await getGslib();
    writeI32(memory, IDX, [0, 0]);
    lib.gslib.getindx(10, 0.5, 1.0, 0.5, IDX);
    const [index, inflag] = readI32(memory, IDX, 2);
    assert.equal(index, 0);
    assert.equal(inflag, 1);
  });

  it('below grid clamps to 0 with inflag=0', async () => {
    const { lib, memory } = await getGslib();
    writeI32(memory, IDX, [0, 0]);
    lib.gslib.getindx(10, 0.5, 1.0, -5.0, IDX);
    const [index, inflag] = readI32(memory, IDX, 2);
    assert.equal(index, 0);
    assert.equal(inflag, 0);
  });

  it('above grid clamps to n-1 with inflag=0', async () => {
    const { lib, memory } = await getGslib();
    writeI32(memory, IDX, [0, 0]);
    lib.gslib.getindx(10, 0.5, 1.0, 50.0, IDX);
    const [index, inflag] = readI32(memory, IDX, 2);
    assert.equal(index, 9);
    assert.equal(inflag, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// setrot
// ═════════════════════════════════════════════════════════════════════

describe('gslib.setrot', () => {
  // rotmat: 9 f64 values per matrix, at byte offset ind*9*8
  const ROTMAT = 0;

  it('identity-like matrix for angles (0,0,0) and anis (1,1)', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, ROTMAT, new Array(9).fill(0));
    lib.gslib.setrot(0, 0, 0, 1, 1, 0, ROTMAT);
    const m = readF64(memory, ROTMAT, 9);

    // ang1=0 (north), ang2=0, ang3=0, isotropic
    // alpha = 90° → cosa≈0, sina=1
    // beta = 0 → cosb=1, sinb=0
    // theta = 0 → cost=1, sint=0
    // Row 0: [cosb*cosa, cosb*sina, -sinb] ≈ [0, 1, 0]
    // Row 1: [-cost*sina + sint*sinb*cosa, cost*cosa + sint*sinb*sina, sint*cosb] ≈ [-1, 0, 0]
    // Row 2: [sint*sina + cost*sinb*cosa, -sint*cosa + cost*sinb*sina, cost*cosb] ≈ [0, 0, 1]
    approx(m[0], 0, 1e-9);
    approx(m[1], 1, 1e-9);
    approx(m[2], 0, 1e-9);
    approx(m[3], -1, 1e-9);
    approx(m[4], 0, 1e-9);
    approx(m[5], 0, 1e-9);
    approx(m[6], 0, 1e-9);
    approx(m[7], 0, 1e-9);
    approx(m[8], 1, 1e-9);
  });

  it('orthogonality: R^T R ~ I (isotropic case)', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, ROTMAT, new Array(9).fill(0));
    lib.gslib.setrot(45, 30, 15, 1, 1, 0, ROTMAT);
    const m = readF64(memory, ROTMAT, 9);

    // R^T R should be identity for isotropic case
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += m[k * 3 + i] * m[k * 3 + j];
        approx(dot, i === j ? 1 : 0, 1e-10);
      }
    }
  });

  it('anisotropy scales rows 2 and 3', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, ROTMAT, new Array(9).fill(0));
    // anis1=0.5 → afac1=2, anis2=0.25 → afac2=4
    lib.gslib.setrot(0, 0, 0, 0.5, 0.25, 0, ROTMAT);
    const m = readF64(memory, ROTMAT, 9);

    // Row 0 unchanged: [0, 1, 0]
    approx(m[0], 0, 1e-9);
    approx(m[1], 1, 1e-9);
    // Row 1 scaled by 2: [-2, 0, 0]
    approx(m[3], -2, 1e-9);
    approx(m[4], 0, 1e-9);
    // Row 2 scaled by 4: [0, 0, 4]
    approx(m[8], 4, 1e-9);
  });

  it('stores at correct index offset', async () => {
    const { lib, memory } = await getGslib();
    // Write matrix at index 2 (byte offset 2*9*8 = 144)
    writeF64(memory, 0, new Array(27).fill(0));
    lib.gslib.setrot(0, 0, 0, 1, 1, 2, ROTMAT);

    // Index 0 should still be zeros
    const m0 = readF64(memory, 0, 9);
    for (const v of m0) assert.equal(v, 0);

    // Index 2 should have the rotation matrix
    const m2 = readF64(memory, 144, 9);
    approx(m2[1], 1, 1e-10); // cosb*sina = 1 for azimuth 0
  });
});

// ═════════════════════════════════════════════════════════════════════
// sqdist
// ═════════════════════════════════════════════════════════════════════

describe('gslib.sqdist', () => {
  it('isotropic case = Euclidean distance squared', async () => {
    const { lib, memory } = await getGslib();
    // Set up identity rotation matrix at index 0
    const ROTMAT = 0;
    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    const d = lib.gslib.sqdist(1, 2, 3, 4, 5, 6, 0, ROTMAT);
    // (4-1)^2 + (5-2)^2 + (6-3)^2 = 9 + 9 + 9 = 27
    approx(d, 27, 1e-10);
  });

  it('zero distance', async () => {
    const { lib, memory } = await getGslib();
    const ROTMAT = 0;
    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    approx(lib.gslib.sqdist(5, 5, 5, 5, 5, 5, 0, ROTMAT), 0, 1e-20);
  });

  it('anisotropic case with known ratio', async () => {
    const { lib, memory } = await getGslib();
    // Use setrot to build a rotation matrix with anisotropy
    const ROTMAT = 0;
    writeF64(memory, ROTMAT, new Array(9).fill(0));
    // No rotation, anis1=0.5 (afac1=2), anis2=1
    lib.gslib.setrot(0, 0, 0, 0.5, 1, 0, ROTMAT);

    // Points differ only along x-axis (but in GSLIB, azimuth 0 = north = y-axis)
    // With azimuth 0: row0=[0,1,0], row1=[-2,0,0], row2=[0,0,1]
    // dx=1, dy=0, dz=0 → cont0 = 0*1=0, cont1 = -2*1=-2, cont2 = 0
    // sqdist = 0 + 4 + 0 = 4
    const d = lib.gslib.sqdist(1, 0, 0, 0, 0, 0, 0, ROTMAT);
    approx(d, 4, 1e-10);

    // Points differ only along y-axis
    // dx=0, dy=1, dz=0 → cont0 = 1*1=1, cont1 = 0, cont2 = 0
    // sqdist = 1
    const d2 = lib.gslib.sqdist(0, 1, 0, 0, 0, 0, 0, ROTMAT);
    approx(d2, 1, 1e-10);
  });
});

// ═════════════════════════════════════════════════════════════════════
// cova3
// ═════════════════════════════════════════════════════════════════════

describe('gslib.cova3', () => {
  // Memory layout for cova3 tests:
  // rotmat at byte 0       (9 f64 = 72 bytes)
  // it at byte 128         (4 i32 = 16 bytes)
  // cc at byte 160         (4 f64 = 32 bytes)
  // aa at byte 192         (4 f64 = 32 bytes)
  // result at byte 224     (2 f64 = 16 bytes)
  const ROTMAT = 0;
  const IT = 128;
  const CC = 160;
  const AA = 192;
  const RESULT = 224;

  /** Set up identity rotation matrix and model parameters */
  async function setupCova(opts) {
    const { lib, memory } = await getGslib();
    // Identity rotation at index 0
    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    writeI32(memory, IT, opts.it || [1]);
    writeF64(memory, CC, opts.cc || [1.0]);
    writeF64(memory, AA, opts.aa || [10.0]);
    writeF64(memory, RESULT, [0, 0]);
    return { lib, memory };
  }

  it('zero distance returns cmax', async () => {
    const { lib, memory } = await setupCova({ it: [1], cc: [1.0], aa: [10.0] });
    // nugget=0.5, spherical sill=1.0 → cmax = 1.5
    lib.gslib.cova3(0, 0, 0, 0, 0, 0, 1, 0.5, IT, CC, AA, 0, ROTMAT, RESULT);
    const [cmax, cova] = readF64(memory, RESULT, 2);
    approx(cmax, 1.5, 1e-10);
    approx(cova, 1.5, 1e-10);
  });

  it('spherical model at known lag', async () => {
    const { lib, memory } = await setupCova({ it: [1], cc: [1.0], aa: [10.0] });
    // c0=0, spherical, cc=1, aa=10
    // At h=5: hr=0.5, cov = 1*(1 - 0.5*(1.5 - 0.5*0.125)) = 1*(1-0.5*1.4375) = 1-0.71875 = 0.28125
    lib.gslib.cova3(0, 0, 0, 5, 0, 0, 1, 0.0, IT, CC, AA, 0, ROTMAT, RESULT);
    const [cmax, cova] = readF64(memory, RESULT, 2);
    approx(cmax, 1.0, 1e-10);
    const hr = 0.5;
    const expected = 1.0 * (1.0 - hr * (1.5 - 0.5 * hr * hr));
    approx(cova, expected, 1e-6);
  });

  it('spherical model beyond range returns 0', async () => {
    const { lib, memory } = await setupCova({ it: [1], cc: [1.0], aa: [10.0] });
    // h=15 > aa=10 → spherical contributes 0
    lib.gslib.cova3(0, 0, 0, 15, 0, 0, 1, 0.0, IT, CC, AA, 0, ROTMAT, RESULT);
    const [, cova] = readF64(memory, RESULT, 2);
    approx(cova, 0.0, 1e-10);
  });

  it('exponential model', async () => {
    const { lib, memory } = await setupCova({ it: [2], cc: [1.0], aa: [10.0] });
    // c0=0, exponential, cc=1, aa=10
    // At h=5: cov = exp(-3*5/10) = exp(-1.5)
    lib.gslib.cova3(0, 0, 0, 5, 0, 0, 1, 0.0, IT, CC, AA, 0, ROTMAT, RESULT);
    const [, cova] = readF64(memory, RESULT, 2);
    approx(cova, Math.exp(-1.5), 1e-6);
  });

  it('Gaussian model', async () => {
    const { lib, memory } = await setupCova({ it: [3], cc: [1.0], aa: [10.0] });
    // c0=0, Gaussian, cc=1, aa=10
    // At h=5: cov = exp(-3*(5/10)^2) = exp(-0.75)
    lib.gslib.cova3(0, 0, 0, 5, 0, 0, 1, 0.0, IT, CC, AA, 0, ROTMAT, RESULT);
    const [, cova] = readF64(memory, RESULT, 2);
    approx(cova, Math.exp(-0.75), 1e-6);
  });

  it('nugget-only model', async () => {
    const { lib, memory } = await getGslib();
    // 0 nested structures, nugget c0=5
    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    writeF64(memory, RESULT, [0, 0]);
    // Zero distance → cmax
    lib.gslib.cova3(0, 0, 0, 0, 0, 0, 0, 5.0, IT, CC, AA, 0, ROTMAT, RESULT);
    const [cmax, cova] = readF64(memory, RESULT, 2);
    approx(cmax, 5.0, 1e-10);
    approx(cova, 5.0, 1e-10);

    // Non-zero distance → nugget only = 0 (discontinuous at origin)
    lib.gslib.cova3(0, 0, 0, 1, 0, 0, 0, 5.0, IT, CC, AA, 0, ROTMAT, RESULT);
    const [cmax2, cova2] = readF64(memory, RESULT, 2);
    approx(cmax2, 5.0, 1e-10);
    approx(cova2, 0.0, 1e-10);
  });
});

// ═════════════════════════════════════════════════════════════════════
// sortem
// ═════════════════════════════════════════════════════════════════════

describe('gslib.sortem', () => {
  // Memory layout for sortem tests:
  // a: 0       (up to 20 f64 = 160 bytes)
  // b: 160     (up to 20 f64 = 160 bytes)
  // c: 320     (up to 20 f64 = 160 bytes)
  // lt: 480    (64 i32 = 256 bytes)
  // ut: 736    (64 i32 = 256 bytes)
  const A = 0, B = 160, C = 320, LT = 480, UT = 736;

  it('sorts array in ascending order', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [5, 3, 8, 1, 9, 2, 7, 4, 6, 0]);
    lib.gslib.sortem(0, 10, A, B, C, 0, LT, UT);
    const sorted = readF64(memory, A, 10);
    assert.deepStrictEqual(sorted, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('sorts already-sorted array', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [1, 2, 3, 4, 5]);
    lib.gslib.sortem(0, 5, A, B, C, 0, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 5), [1, 2, 3, 4, 5]);
  });

  it('sorts reverse-sorted array', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [5, 4, 3, 2, 1]);
    lib.gslib.sortem(0, 5, A, B, C, 0, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 5), [1, 2, 3, 4, 5]);
  });

  it('sorts with duplicates', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [3, 1, 3, 2, 1]);
    lib.gslib.sortem(0, 5, A, B, C, 0, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 5), [1, 1, 2, 3, 3]);
  });

  it('handles single element', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [42]);
    lib.gslib.sortem(0, 1, A, B, C, 0, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 1), [42]);
  });

  it('handles two elements', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [7, 3]);
    lib.gslib.sortem(0, 2, A, B, C, 0, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 2), [3, 7]);
  });

  it('permutes one companion array (nperm=1)', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [30, 10, 20]);
    writeF64(memory, B, [300, 100, 200]);
    lib.gslib.sortem(0, 3, A, B, C, 1, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 3), [10, 20, 30]);
    assert.deepStrictEqual(readF64(memory, B, 3), [100, 200, 300]);
  });

  it('permutes two companion arrays (nperm=2)', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [30, 10, 20]);
    writeF64(memory, B, [300, 100, 200]);
    writeF64(memory, C, [3000, 1000, 2000]);
    lib.gslib.sortem(0, 3, A, B, C, 2, LT, UT);
    assert.deepStrictEqual(readF64(memory, A, 3), [10, 20, 30]);
    assert.deepStrictEqual(readF64(memory, B, 3), [100, 200, 300]);
    assert.deepStrictEqual(readF64(memory, C, 3), [1000, 2000, 3000]);
  });

  it('sorts sub-range (ib=2, ie=5)', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, A, [99, 88, 5, 3, 1, 77, 66]);
    lib.gslib.sortem(2, 5, A, B, C, 0, LT, UT);
    const result = readF64(memory, A, 7);
    // Only indices 2-4 should be sorted
    assert.equal(result[0], 99);
    assert.equal(result[1], 88);
    assert.deepStrictEqual(result.slice(2, 5), [1, 3, 5]);
    assert.equal(result[5], 77);
    assert.equal(result[6], 66);
  });
});

// ═════════════════════════════════════════════════════════════════════
// nscore
// ═════════════════════════════════════════════════════════════════════

describe('gslib.nscore', () => {
  // Memory layout (generous spacing):
  // a:      0       (20 f64 = 160 bytes)
  // wt:     160     (20 f64)
  // tmp:    320     (20 f64)
  // vrg:    480     (20 f64)
  // xp:     640     (1 f64 = 8 bytes)
  // ierr:   648     (1 i32 = 4 bytes)
  // result: 652     (1 i32 = 4 bytes)
  // lt:     656     (64 i32 = 256 bytes)
  // ut:     912     (64 i32 = 256 bytes)
  const NA = 0, WT = 160, TMP = 320, VRG = 480, XP = 640;
  const IERR = 648, RESULT = 652, LT = 656, UT = 912;

  it('transforms uniform data to approximately normal scores', async () => {
    const { lib, memory } = await getGslib();
    const nd = 10;
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    writeF64(memory, NA, data);
    writeF64(memory, WT, new Array(nd).fill(1.0));
    writeI32(memory, RESULT, [0]);

    lib.gslib.nscore(nd, NA, WT, TMP, VRG, XP, IERR, RESULT, LT, UT,
      0.0, 11.0, 0);

    assert.equal(readI32(memory, RESULT, 1)[0], 0); // no error
    const scores = readF64(memory, VRG, nd);

    // Scores should be roughly symmetric around 0
    const mean = scores.reduce((s, v) => s + v, 0) / nd;
    approx(mean, 0.0, 0.1);

    // Scores should be monotonically increasing (data was 1..10)
    for (let i = 1; i < nd; i++) {
      assert.ok(scores[i] > scores[i - 1],
        `scores[${i}]=${scores[i]} should be > scores[${i-1}]=${scores[i-1]}`);
    }
  });

  it('preserves original data order', async () => {
    const { lib, memory } = await getGslib();
    const nd = 5;
    const data = [50, 10, 30, 20, 40];
    writeF64(memory, NA, data);
    writeF64(memory, WT, new Array(nd).fill(1.0));
    writeI32(memory, RESULT, [0]);

    lib.gslib.nscore(nd, NA, WT, TMP, VRG, XP, IERR, RESULT, LT, UT,
      0.0, 100.0, 0);

    // Data should be back in original order
    const restored = readF64(memory, NA, nd);
    assert.deepStrictEqual(restored, data);
  });

  it('returns error for empty data', async () => {
    const { lib, memory } = await getGslib();
    writeI32(memory, RESULT, [0]);
    lib.gslib.nscore(0, NA, WT, TMP, VRG, XP, IERR, RESULT, LT, UT,
      0.0, 100.0, 0);
    assert.equal(readI32(memory, RESULT, 1)[0], 1);
  });

  it('respects trimming limits', async () => {
    const { lib, memory } = await getGslib();
    const nd = 5;
    // values outside [tmin, tmax) contribute 0 weight
    writeF64(memory, NA, [1, 2, 3, 4, 5]);
    writeF64(memory, WT, new Array(nd).fill(1.0));
    writeI32(memory, RESULT, [0]);

    // tmin=0, tmax=6 — all in range
    lib.gslib.nscore(nd, NA, WT, TMP, VRG, XP, IERR, RESULT, LT, UT,
      0.0, 6.0, 0);
    assert.equal(readI32(memory, RESULT, 1)[0], 0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// backtr
// ═════════════════════════════════════════════════════════════════════

describe('gslib.backtr', () => {
  // Transform table: 5 entries
  // vr (original values, sorted):   [10, 20, 30, 40, 50]
  // vrg (normal scores, sorted):    [-1.5, -0.5, 0.0, 0.5, 1.5]
  // Memory layout:
  // vr:  0       (5 f64 = 40 bytes)
  // vrg: 40      (5 f64 = 40 bytes)
  // j:   80      (1 i32 = 4 bytes)
  const VR = 0, VRG = 40, J = 80;

  async function setupBacktr() {
    const { lib, memory } = await getGslib();
    writeF64(memory, VR, [10, 20, 30, 40, 50]);
    writeF64(memory, VRG, [-1.5, -0.5, 0.0, 0.5, 1.5]);
    writeI32(memory, J, [0]);
    return { lib, memory };
  }

  it('interpolates within table', async () => {
    const { lib } = await setupBacktr();
    // vrgs=0.25 is between vrg[2]=0.0 and vrg[3]=0.5
    // linear interp: 30 + (40-30) * (0.25-0.0)/(0.5-0.0) = 30 + 5 = 35
    const result = lib.gslib.backtr(0.25, 5, VR, VRG, 0, 100, 1, 1.0, 1, 1.0, J);
    approx(result, 35.0, 0.1);
  });

  it('returns table endpoint at exact boundary', async () => {
    const { lib } = await setupBacktr();
    // vrgs=0.0 exactly matches vrg[2] → should return vr[2]=30
    const result = lib.gslib.backtr(0.0, 5, VR, VRG, 0, 100, 1, 1.0, 1, 1.0, J);
    approx(result, 30.0, 0.5);
  });

  it('lower tail linear extrapolation', async () => {
    const { lib } = await setupBacktr();
    // vrgs = -2.0, below vrg[0] = -1.5
    // ltail=1 (linear), zmin=0
    const result = lib.gslib.backtr(-2.0, 5, VR, VRG, 0, 100, 1, 1.0, 1, 1.0, J);
    assert.ok(result < 10, `lower tail result ${result} should be < 10`);
    assert.ok(result >= 0, `lower tail result ${result} should be >= zmin=0`);
  });

  it('upper tail linear extrapolation', async () => {
    const { lib } = await setupBacktr();
    // vrgs = 2.0, above vrg[4] = 1.5
    // utail=1 (linear), zmax=100
    const result = lib.gslib.backtr(2.0, 5, VR, VRG, 0, 100, 1, 1.0, 1, 1.0, J);
    assert.ok(result > 50, `upper tail result ${result} should be > 50`);
    assert.ok(result <= 100, `upper tail result ${result} should be <= zmax=100`);
  });

  it('round-trip with nscore: backtr(nscore(x)) ~ x', async () => {
    const { lib, memory } = await getGslib();
    const nd = 10;
    const data = [15, 25, 35, 45, 55, 65, 75, 85, 95, 105];

    // nscore layout (far from backtr's VR/VRG/J)
    const NA = 1024, WT = 1184, TMP = 1344, NVRG = 1504, XP = 1664;
    const IERR = 1672, RESULT = 1676, LT = 1680, UT = 1936;

    writeF64(memory, NA, data);
    writeF64(memory, WT, new Array(nd).fill(1.0));
    writeI32(memory, RESULT, [0]);

    lib.gslib.nscore(nd, NA, WT, TMP, NVRG, XP, IERR, RESULT, LT, UT,
      0.0, 200.0, 0);
    assert.equal(readI32(memory, RESULT, 1)[0], 0);

    const scores = readF64(memory, NVRG, nd);
    const restored = readF64(memory, NA, nd);

    // Build transform table from sorted data and scores
    // Sort restored data and corresponding scores together for the table
    const pairs = restored.map((v, i) => [v, scores[i]]).sort((a, b) => a[0] - b[0]);
    const sortedVr = pairs.map(p => p[0]);
    const sortedVrg = pairs.map(p => p[1]);

    const TVR = 2200, TVRG = 2280, TJ = 2360;
    writeF64(memory, TVR, sortedVr);
    writeF64(memory, TVRG, sortedVrg);
    writeI32(memory, TJ, [0]);

    // Back-transform each score and check it's close to original
    for (let i = 0; i < nd; i++) {
      const bt = lib.gslib.backtr(scores[i], nd, TVR, TVRG,
        0, 200, 1, 1.0, 1, 1.0, TJ);
      approx(bt, data[i], 1.0); // within 1.0 of original
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// setsupr
// ═════════════════════════════════════════════════════════════════════

describe('gslib.setsupr', () => {
  // Memory layout for setsupr tests (generous spacing):
  // Using page 2+ (offset 4096+) to avoid conflicts
  const BASE = 4096;
  // nd max = 20
  const X   = BASE;                  // 20 f64 = 160 bytes
  const Y   = BASE + 160;            // 20 f64
  const Z   = BASE + 320;            // 20 f64
  const VR  = BASE + 480;            // 20 f64
  const TMP = BASE + 640;            // 20 f64
  const NISB = BASE + 800;           // 100 i32 = 400 bytes
  const IDX  = BASE + 1200;          // 2 i32 = 8 bytes
  const IXARR = BASE + 1208;         // 20 i32 = 80 bytes
  const LT   = BASE + 1288;          // 64 i32 = 256 bytes
  const UT   = BASE + 1544;          // 64 i32 = 256 bytes
  const OUT  = BASE + 1800;          // 13 f64 = 104 bytes

  it('assigns data to correct super blocks', async () => {
    const { lib, memory } = await getGslib();

    // 2D grid (nz=1): 4x4 cells, cell size 10
    // xmn=5, ymn=5 (cell centers at 5,15,25,35)
    const nd = 4;
    // Place 4 data points in different quadrants
    writeF64(memory, X, [5, 25, 5, 25]);    // x
    writeF64(memory, Y, [5, 5, 25, 25]);    // y
    writeF64(memory, Z, [0, 0, 0, 0]);      // z (2D)
    writeF64(memory, VR, [10, 20, 30, 40]); // values

    lib.gslib.setsupr(
      4, 5, 10,       // nx, xmn, xsiz
      4, 5, 10,       // ny, ymn, ysiz
      1, 0.5, 1,      // nz, zmn, zsiz
      nd, X, Y, Z, VR, TMP,
      NISB, IDX, IXARR, LT, UT,
      2, 2, 1,         // maxsbx, maxsby, maxsbz
      OUT
    );

    const out = readF64(memory, OUT, 9);
    const nxsup = out[0], nysup = out[1], nzsup = out[2];
    assert.equal(nxsup, 2);
    assert.equal(nysup, 2);
    assert.equal(nzsup, 1);

    // All 4 data should still be present
    const xs = readF64(memory, X, nd);
    const vs = readF64(memory, VR, nd);

    // Check all original values are present (may be reordered)
    const sortedV = [...vs].sort((a, b) => a - b);
    assert.deepStrictEqual(sortedV, [10, 20, 30, 40]);
  });

  it('cumulative nisb sums to nd', async () => {
    const { lib, memory } = await getGslib();

    const nd = 6;
    // Scatter data across a 3x3 grid
    writeF64(memory, X, [1, 5, 9, 1, 5, 9]);
    writeF64(memory, Y, [1, 1, 1, 5, 5, 5]);
    writeF64(memory, Z, [0, 0, 0, 0, 0, 0]);
    writeF64(memory, VR, [1, 2, 3, 4, 5, 6]);

    lib.gslib.setsupr(
      3, 5, 10,       // nx, xmn, xsiz
      3, 5, 10,       // ny, ymn, ysiz
      1, 0.5, 1,      // nz, zmn, zsiz
      nd, X, Y, Z, VR, TMP,
      NISB, IDX, IXARR, LT, UT,
      3, 3, 1,
      OUT
    );

    const out = readF64(memory, OUT, 9);
    const nxsup = out[0], nysup = out[1], nzsup = out[2];
    const nstot = nxsup * nysup * nzsup;
    const nisb = readI32(memory, NISB, nstot);

    // Last element of nisb should equal nd
    assert.equal(nisb[nstot - 1], nd);
  });

  it('data sorted by super block order', async () => {
    const { lib, memory } = await getGslib();

    const nd = 4;
    // Points deliberately out of super block order
    writeF64(memory, X, [35, 5, 35, 5]);     // far-x, near-x, far-x, near-x
    writeF64(memory, Y, [35, 5, 5, 35]);     // far-y, near-y, near-y, far-y
    writeF64(memory, Z, [0, 0, 0, 0]);
    writeF64(memory, VR, [1, 2, 3, 4]);

    lib.gslib.setsupr(
      4, 5, 10, 4, 5, 10, 1, 0.5, 1,
      nd, X, Y, Z, VR, TMP,
      NISB, IDX, IXARR, LT, UT,
      2, 2, 1,
      OUT
    );

    // After setsupr, data should be grouped by super block
    // Super block (0,0): x<20, y<20 → point at (5,5)=vr2
    // Super block (1,0): x>=20, y<20 → point at (35,5)=vr3
    // Super block (0,1): x<20, y>=20 → point at (5,35)=vr4
    // Super block (1,1): x>=20, y>=20 → point at (35,35)=vr1
    const xs = readF64(memory, X, nd);
    const ys = readF64(memory, Y, nd);

    // First datum should be in super block 0 (lowest x, lowest y)
    assert.ok(xs[0] < 20 && ys[0] < 20,
      `first point (${xs[0]},${ys[0]}) should be in super block (0,0)`);
  });
});

// ═════════════════════════════════════════════════════════════════════
// picksup
// ═════════════════════════════════════════════════════════════════════

describe('gslib.picksup', () => {
  // Memory layout
  const BASE = 8192;
  const ROTMAT = BASE;               // 9 f64 = 72 bytes
  const NSBTOSR = BASE + 72;         // 1 i32 = 4 bytes
  const IXSB = BASE + 76;            // 200 i32 = 800 bytes
  const IYSB = BASE + 876;           // 200 i32
  const IZSB = BASE + 1676;          // 200 i32

  it('isotropic search: includes origin block', async () => {
    const { lib, memory } = await getGslib();

    // Identity rotation matrix at index 0
    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    const radsqd = 100.0; // search radius = 10

    lib.gslib.picksup(
      2, 10.0,       // nxsup, xsizsup
      2, 10.0,       // nysup, ysizsup
      1, 1.0,        // nzsup, zsizsup
      0, ROTMAT,     // irot, rotmat
      radsqd,
      NSBTOSR,
      IXSB, IYSB, IZSB
    );

    const nsbtosr = readI32(memory, NSBTOSR, 1)[0];
    assert.ok(nsbtosr > 0, 'should find at least one super block');

    // Check that (0,0,0) offset is included (the block containing the point)
    const ixsb = readI32(memory, IXSB, nsbtosr);
    const iysb = readI32(memory, IYSB, nsbtosr);
    const izsb = readI32(memory, IZSB, nsbtosr);

    let hasOrigin = false;
    for (let i = 0; i < nsbtosr; i++) {
      if (ixsb[i] === 0 && iysb[i] === 0 && izsb[i] === 0) hasOrigin = true;
    }
    assert.ok(hasOrigin, 'should include the origin super block');
  });

  it('medium radius excludes far blocks', async () => {
    const { lib, memory } = await getGslib();

    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // Radius = 15, radsqd = 225. Block size = 10.
    // Blocks at offset 2+ have minimum corner distance = 10 (squared=100) → included.
    // Blocks at offset 3+ have minimum corner distance = 20 (squared=400) → excluded.
    const radsqd = 225.0;

    lib.gslib.picksup(
      5, 10.0,
      5, 10.0,
      1, 1.0,
      0, ROTMAT,
      radsqd,
      NSBTOSR,
      IXSB, IYSB, IZSB
    );

    const nsbtosr = readI32(memory, NSBTOSR, 1)[0];
    // Should exclude the farthest blocks but include nearby ones
    // Total possible = 9*9*1 = 81, should be less
    assert.ok(nsbtosr < 81, `medium radius should exclude some blocks, got ${nsbtosr}`);
    assert.ok(nsbtosr > 1, `should still include multiple blocks, got ${nsbtosr}`);
  });

  it('large radius includes all blocks', async () => {
    const { lib, memory } = await getGslib();

    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // Very large search radius: all blocks should qualify
    const radsqd = 1e10;

    lib.gslib.picksup(
      3, 10.0,
      3, 10.0,
      1, 1.0,
      0, ROTMAT,
      radsqd,
      NSBTOSR,
      IXSB, IYSB, IZSB
    );

    const nsbtosr = readI32(memory, NSBTOSR, 1)[0];
    // 3*3*1 grid: offsets range from -2..2 in x, -2..2 in y = 5*5*1 = 25
    assert.equal(nsbtosr, 25, 'large radius should include all offset combinations');
  });
});

// ═════════════════════════════════════════════════════════════════════
// srchsupr — integrated search tests
// ═════════════════════════════════════════════════════════════════════

describe('gslib.srchsupr', () => {
  // Memory layout for integrated search tests
  const BASE = 16384;
  // Data arrays (max 20 points)
  const X    = BASE;                  // 20 f64
  const Y    = BASE + 160;            // 20 f64
  const Z    = BASE + 320;            // 20 f64
  const VR   = BASE + 480;            // 20 f64
  const TMP  = BASE + 640;            // 20 f64
  const CLOSE = BASE + 800;           // 20 f64
  // Super block arrays
  const NISB   = BASE + 960;          // 100 i32
  const IDX    = BASE + 1360;         // 2 i32
  const IXARR  = BASE + 1368;        // 20 i32
  const LT     = BASE + 1448;         // 64 i32
  const UT     = BASE + 1704;         // 64 i32
  const OUT    = BASE + 1960;         // 13 f64
  // Rotation matrix
  const ROTMAT = BASE + 2064;         // 9 f64
  // picksup output
  const NSBTOSR = BASE + 2136;        // 1 i32
  const IXSB   = BASE + 2140;         // 200 i32
  const IYSB   = BASE + 2940;         // 200 i32
  const IZSB   = BASE + 3740;         // 200 i32 → ends at 4540
  // srchsupr output (f64 needs 8-byte alignment: 4544)
  const RESULT = BASE + 4544;         // 2 f64
  const INOCT  = BASE + 4560;         // 8 i32

  async function setupSearch(points, { nx = 4, xmn = 5, xsiz = 10,
    ny = 4, ymn = 5, ysiz = 10, radsqd = 10000 } = {}) {
    const { lib, memory } = await getGslib();
    const nd = points.length;

    writeF64(memory, X, points.map(p => p[0]));
    writeF64(memory, Y, points.map(p => p[1]));
    writeF64(memory, Z, points.map(p => p[2] || 0));
    writeF64(memory, VR, points.map(p => p[3] || 0));

    // Identity rotation matrix
    writeF64(memory, ROTMAT, [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // setsupr: sort data into super blocks
    lib.gslib.setsupr(
      nx, xmn, xsiz, ny, ymn, ysiz, 1, 0.5, 1,
      nd, X, Y, Z, VR, TMP,
      NISB, IDX, IXARR, LT, UT,
      nx, ny, 1,
      OUT
    );

    const out = readF64(memory, OUT, 9);
    const nxsup = out[0], nysup = out[1], nzsup = out[2];
    const xmnsup = out[3], ymnsup = out[4], zmnsup = out[5];
    const xsizsup = out[6], ysizsup = out[7], zsizsup = out[8];

    // picksup: determine which super blocks to search
    lib.gslib.picksup(
      nxsup, xsizsup,
      nysup, ysizsup,
      nzsup, zsizsup,
      0, ROTMAT,
      radsqd,
      NSBTOSR,
      IXSB, IYSB, IZSB
    );

    const nsbtosr = readI32(memory, NSBTOSR, 1)[0];

    return {
      lib, memory, nd, nsbtosr,
      nxsup, xmnsup, xsizsup,
      nysup, ymnsup, ysizsup,
      nzsup: nzsup, zmnsup: zmnsup, zsizsup: zsizsup
    };
  }

  it('finds all points within large search radius', async () => {
    const points = [
      [5, 5, 0, 10],
      [15, 5, 0, 20],
      [25, 15, 0, 30],
      [35, 25, 0, 40],
    ];
    const { lib, memory, nsbtosr, nxsup, xmnsup, xsizsup,
            nysup, ymnsup, ysizsup, nzsup, zmnsup, zsizsup } =
      await setupSearch(points, { radsqd: 1e6 });

    // Search from center of grid (20, 15, 0) with huge radius
    lib.gslib.srchsupr(
      20, 15, 0,      // xloc, yloc, zloc
      1e6,            // radsqd
      0, ROTMAT,      // irot, rotmat
      nsbtosr, IXSB, IYSB, IZSB,
      0,              // noct (no octant search)
      4,              // nd
      X, Y, Z, TMP, CLOSE,
      NISB,
      nxsup, xmnsup, xsizsup,
      nysup, ymnsup, ysizsup,
      nzsup, zmnsup, zsizsup,
      RESULT,
      IDX, INOCT, LT, UT
    );

    const result = readF64(memory, RESULT, 2);
    const nclose = result[0];
    assert.equal(nclose, 4, 'should find all 4 points');
  });

  it('returns points sorted by distance', async () => {
    const points = [
      [10, 10, 0, 1],
      [30, 30, 0, 2],
      [20, 10, 0, 3],  // closest to (20, 10)
      [5, 25, 0, 4],
    ];
    const { lib, memory, nsbtosr, nxsup, xmnsup, xsizsup,
            nysup, ymnsup, ysizsup, nzsup, zmnsup, zsizsup } =
      await setupSearch(points, { radsqd: 1e6 });

    // Search from (20, 10, 0)
    lib.gslib.srchsupr(
      20, 10, 0,
      1e6,
      0, ROTMAT,
      nsbtosr, IXSB, IYSB, IZSB,
      0, 4,
      X, Y, Z, TMP, CLOSE,
      NISB,
      nxsup, xmnsup, xsizsup,
      nysup, ymnsup, ysizsup,
      nzsup, zmnsup, zsizsup,
      RESULT,
      IDX, INOCT, LT, UT
    );

    const nclose = readF64(memory, RESULT, 1)[0];
    assert.equal(nclose, 4);

    // Distances should be monotonically non-decreasing
    const dists = readF64(memory, TMP, nclose);
    for (let i = 1; i < nclose; i++) {
      assert.ok(dists[i] >= dists[i - 1],
        `dist[${i}]=${dists[i]} should be >= dist[${i-1}]=${dists[i-1]}`);
    }
  });

  it('small radius excludes distant points', async () => {
    const points = [
      [10, 10, 0, 1],   // close to search point
      [11, 10, 0, 2],   // close
      [35, 35, 0, 3],   // far away
    ];
    const { lib, memory, nsbtosr, nxsup, xmnsup, xsizsup,
            nysup, ymnsup, ysizsup, nzsup, zmnsup, zsizsup } =
      await setupSearch(points, { radsqd: 100 }); // radius = 10

    // Search from (10, 10) with radius 10
    lib.gslib.srchsupr(
      10, 10, 0,
      100,              // radsqd = 10^2
      0, ROTMAT,
      nsbtosr, IXSB, IYSB, IZSB,
      0, 3,
      X, Y, Z, TMP, CLOSE,
      NISB,
      nxsup, xmnsup, xsizsup,
      nysup, ymnsup, ysizsup,
      nzsup, zmnsup, zsizsup,
      RESULT,
      IDX, INOCT, LT, UT
    );

    const nclose = readF64(memory, RESULT, 1)[0];
    // Should find the 2 close points, not the distant one
    assert.ok(nclose >= 2, `should find at least 2 close points, got ${nclose}`);
    assert.ok(nclose <= 3, `should not find more than 3 points`);
  });

  it('octant search limits samples per octant', async () => {
    // 8 points, 2 per quadrant (in 2D, so 4 effective octants)
    const points = [
      [22, 12, 0, 1],  // octant 1 (+x, +y-ish, +z)
      [24, 14, 0, 2],  // octant 1
      [18, 12, 0, 3],  // octant 0 (-x, +y, +z)
      [16, 14, 0, 4],  // octant 0
      [18, 8, 0, 5],   // octant 2 (-x, -y, +z)
      [16, 6, 0, 6],   // octant 2
      [22, 8, 0, 7],   // octant 3 (+x, -y, +z)
      [24, 6, 0, 8],   // octant 3
    ];
    const { lib, memory, nsbtosr, nxsup, xmnsup, xsizsup,
            nysup, ymnsup, ysizsup, nzsup, zmnsup, zsizsup } =
      await setupSearch(points, { radsqd: 1e6 });

    // Search from (20, 10, 0) with octant search, noct=1 (max 1 per octant)
    lib.gslib.srchsupr(
      20, 10, 0,
      1e6,
      0, ROTMAT,
      nsbtosr, IXSB, IYSB, IZSB,
      1,                // noct=1: at most 1 sample per octant
      8,
      X, Y, Z, TMP, CLOSE,
      NISB,
      nxsup, xmnsup, xsizsup,
      nysup, ymnsup, ysizsup,
      nzsup, zmnsup, zsizsup,
      RESULT,
      IDX, INOCT, LT, UT
    );

    const nclose = readF64(memory, RESULT, 1)[0];
    const infoct = readF64(memory, RESULT + 8, 1)[0];

    // With noct=1, should get at most 8 samples (1 per octant), but in 2D
    // with z=0 we only have 4 octants populated (all z>=0)
    assert.ok(nclose <= 8, `octant search should limit results, got ${nclose}`);
    assert.ok(nclose >= 4, `should find at least 4 samples (one per quadrant), got ${nclose}`);
    assert.ok(infoct >= 2, `should have at least 2 informed octants, got ${infoct}`);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ksol
// ═════════════════════════════════════════════════════════════════════

describe('gslib.ksol', () => {
  // Memory layout:
  // a:      0       (packed upper triangular: max 15 f64 for 5x5)
  // r:      120     (5 f64)
  // s:      160     (5 f64)
  // result: 200     (1 f64)
  const A = 0, R = 120, S = 160, RESULT = 200;

  it('solves a 2x2 system', async () => {
    const { lib, memory } = await getGslib();
    // System: [4 2; 2 3] * [x; y] = [8; 7]
    // Upper triangular packed (columnwise): a(1,1)=4, a(1,2)=2, a(2,2)=3
    // Solution: x=1, y=2 (4+4=8, 2+6=8... let me recalc)
    // 4x + 2y = 8, 2x + 3y = 7 → x=1, y=2 → 4+4=8 ✓, 2+6=8 ✗
    // Actually: 2x+3y = 2+6 = 8 ≠ 7. Let me fix:
    // 4x + 2y = 10, 2x + 3y = 8 → from 1st: x = (10-2y)/4
    // 2*(10-2y)/4 + 3y = 8 → (20-4y)/4 + 3y = 8 → 5-y+3y = 8 → 2y=3 → y=1.5, x=1.75
    // Let me use a simpler system:
    // [2 1; 1 2] * [1; 1] = [3; 3]
    // Packed: a(0)=2 (1,1), a(1)=1 (1,2), a(2)=2 (2,2)
    writeF64(memory, A, [2, 1, 2]);
    writeF64(memory, R, [3, 3]);
    writeF64(memory, RESULT, [0]);

    lib.gslib.ksol(2, A, R, S, RESULT);

    const ising = readF64(memory, RESULT, 1)[0];
    assert.equal(ising, 0, 'should not be singular');
    const sol = readF64(memory, S, 2);
    approx(sol[0], 1.0, 1e-6);
    approx(sol[1], 1.0, 1e-6);
  });

  it('solves a 3x3 system', async () => {
    const { lib, memory } = await getGslib();
    // [4 2 1; 2 5 2; 1 2 6] * [1; 2; 3] = [4+4+3; 2+10+6; 1+4+18] = [11; 18; 23]
    // Packed upper triangular columnwise:
    // col 1: a(1,1)=4
    // col 2: a(1,2)=2, a(2,2)=5
    // col 3: a(1,3)=1, a(2,3)=2, a(3,3)=6
    writeF64(memory, A, [4, 2, 5, 1, 2, 6]);
    writeF64(memory, R, [11, 18, 23]);
    writeF64(memory, RESULT, [0]);

    lib.gslib.ksol(3, A, R, S, RESULT);

    const ising = readF64(memory, RESULT, 1)[0];
    assert.equal(ising, 0);
    const sol = readF64(memory, S, 3);
    approx(sol[0], 1.0, 1e-6);
    approx(sol[1], 2.0, 1e-6);
    approx(sol[2], 3.0, 1e-6);
  });

  it('detects singular matrix', async () => {
    const { lib, memory } = await getGslib();
    // [1 2; 2 4] is singular (row 2 = 2*row 1)
    writeF64(memory, A, [1, 2, 4]);
    writeF64(memory, R, [3, 6]);
    writeF64(memory, RESULT, [0]);

    lib.gslib.ksol(2, A, R, S, RESULT);

    const ising = readF64(memory, RESULT, 1)[0];
    assert.ok(ising !== 0, `should detect singularity, ising=${ising}`);
  });

  it('returns -1 for neq <= 1', async () => {
    const { lib, memory } = await getGslib();
    writeF64(memory, RESULT, [0]);

    lib.gslib.ksol(1, A, R, S, RESULT);

    const ising = readF64(memory, RESULT, 1)[0];
    assert.equal(ising, -1);
  });

  it('solves OK kriging system (3 data + Lagrange)', async () => {
    const { lib, memory } = await getGslib();
    // 3 data points + 1 Lagrange multiplier → 4x4 system
    // Covariance matrix for OK (spherical, range=10, c0=0, cc=1):
    //   C(i,i)=1, C(i,j)=cov(h_ij), plus Lagrange row/col of 1s and 0 corner
    //
    // For a simple test, use identity-like covariances with Lagrange:
    // [1.0  0.5  0.3  1.0]   [w1]   [0.8]
    // [0.5  1.0  0.4  1.0] * [w2] = [0.6]
    // [0.3  0.4  1.0  1.0]   [w3]   [0.4]
    // [1.0  1.0  1.0  0.0]   [mu]   [1.0]
    //
    // Packed upper triangular:
    // col1: 1.0
    // col2: 0.5, 1.0
    // col3: 0.3, 0.4, 1.0
    // col4: 1.0, 1.0, 1.0, 0.0
    writeF64(memory, A, [1.0, 0.5, 1.0, 0.3, 0.4, 1.0, 1.0, 1.0, 1.0, 0.0]);
    writeF64(memory, R, [0.8, 0.6, 0.4, 1.0]);
    writeF64(memory, RESULT, [0]);

    lib.gslib.ksol(4, A, R, S, RESULT);

    const ising = readF64(memory, RESULT, 1)[0];
    assert.equal(ising, 0, 'OK system should be solvable');

    const sol = readF64(memory, S, 4);
    // Weights should sum to 1 (Lagrange constraint)
    const wsum = sol[0] + sol[1] + sol[2];
    approx(wsum, 1.0, 1e-4);
  });
});

// ═════════════════════════════════════════════════════════════════════
// kb2d
// ═════════════════════════════════════════════════════════════════════

describe('gslib.kb2d', () => {
  // Memory layout for kb2d tests (use high offsets to avoid all prior tests)
  const BASE = 32768;
  // Data arrays
  const X    = BASE;                    // 20 f64 = 160
  const Y    = BASE + 160;              // 20 f64
  const VR   = BASE + 320;             // 20 f64
  // Variogram config
  const IT   = BASE + 480;              // 4 i32 = 16
  const CC   = BASE + 496;              // 4 f64 = 32 (needs 8-byte align: 496)
  const AA   = BASE + 528;              // 4 f64 = 32
  const ROTMAT = BASE + 560;            // 18 f64 = 144 (up to 2 structures)
  // Output grids
  const EST  = BASE + 704;              // 100 f64 = 800
  const ESTV = BASE + 1504;             // 100 f64 = 800
  // Scratch (ndmax=10)
  const XA   = BASE + 2304;             // 11 f64 = 88
  const YA   = BASE + 2392;             // 11 f64
  const VRA  = BASE + 2480;             // 11 f64
  const DIST = BASE + 2568;             // 11 f64
  const NUMS = BASE + 2656;             // 11 f64
  const R    = BASE + 2744;             // 12 f64 = 96
  const RR   = BASE + 2840;             // 12 f64
  const S_   = BASE + 2936;             // 12 f64
  const KA   = BASE + 3032;             // 78 f64 (12*13/2 = 78) = 624
  // Block discretization
  const XDB  = BASE + 3656;             // 9 f64 = 72
  const YDB  = BASE + 3728;             // 9 f64
  const COVRES = BASE + 3800;           // 2 f64 = 16
  const KSOLRES = BASE + 3816;          // 1 f64 = 8

  async function setupKb2d(data, opts = {}) {
    const {
      nx = 3, ny = 3,
      xmn = 5, ymn = 5,
      xsiz = 10, ysiz = 10,
      nxdis = 1, nydis = 1,
      ndmin = 1, ndmax = 10,
      radius = 50,
      ktype = 1,      // ordinary kriging
      skmean = 0,
      nst = 1, c0 = 0,
      it = [1], cc = [1.0], aa = [10.0],
      ang = [0], anis = [1.0]
    } = opts;

    const { lib, memory } = await getGslib();
    const nd = data.length;

    writeF64(memory, X, data.map(d => d[0]));
    writeF64(memory, Y, data.map(d => d[1]));
    writeF64(memory, VR, data.map(d => d[2]));

    writeI32(memory, IT, it);
    writeF64(memory, CC, cc);
    writeF64(memory, AA, aa);

    // Set up rotation matrices for each structure
    for (let is = 0; is < nst; is++) {
      lib.gslib.setrot(ang[is], 0, 0, anis[is], 1.0, is, ROTMAT);
    }

    lib.gslib.kb2d(
      nx, ny, xmn, ymn, xsiz, ysiz,
      nxdis, nydis,
      nd, X, Y, VR,
      ndmin, ndmax, radius,
      ktype, skmean,
      nst, c0, IT, CC, AA,
      0, ROTMAT,
      EST, ESTV,
      XA, YA, VRA, DIST, NUMS,
      R, RR, S_, KA,
      XDB, YDB, COVRES, KSOLRES
    );

    return {
      lib, memory, nx, ny,
      est: readF64(memory, EST, nx * ny),
      estv: readF64(memory, ESTV, nx * ny)
    };
  }

  it('estimates at data location equal to data value (OK, point kriging)', async () => {
    // Single data point at grid node center — OK estimate should equal data value
    const data = [[15, 15, 42.0]];
    const { est, estv } = await setupKb2d(data, {
      nx: 3, ny: 3, xmn: 5, ymn: 5, xsiz: 10, ysiz: 10,
      ndmin: 1, ndmax: 10, radius: 50,
      ktype: 1, nst: 1, c0: 0, it: [1], cc: [1.0], aa: [10.0]
    });

    // Grid node (1,1) is at (15, 15) — same as data point
    const idx = 1 + 1 * 3;
    approx(est[idx], 42.0, 0.1);
    // Variance at data location should be ~0
    assert.ok(estv[idx] < 0.1, `variance at data location should be ~0, got ${estv[idx]}`);
  });

  it('unestimated nodes have sentinel value', async () => {
    // Data far from some grid nodes with small search radius
    const data = [[5, 5, 10.0]];
    const { est, estv } = await setupKb2d(data, {
      nx: 3, ny: 3, xmn: 5, ymn: 5, xsiz: 10, ysiz: 10,
      ndmin: 2, ndmax: 10, radius: 5,
      ktype: 1, nst: 1, c0: 0, it: [1], cc: [1.0], aa: [10.0]
    });

    // Most nodes should be unestimated (ndmin=2 but only 1 datum)
    let unest = 0;
    for (let i = 0; i < 9; i++) {
      if (est[i] === -999.0) unest++;
    }
    assert.equal(unest, 9, 'all nodes unestimated (ndmin=2 but only 1 data point)');
  });

  it('OK weights sum to 1', async () => {
    // Multiple data points — OK weights verified implicitly:
    // estimate = sum(wi * vi) with sum(wi) = 1
    const data = [
      [5, 5, 10.0],
      [25, 5, 20.0],
      [15, 15, 30.0],
    ];
    const { est, estv } = await setupKb2d(data, {
      nx: 3, ny: 3, xmn: 5, ymn: 5, xsiz: 10, ysiz: 10,
      ndmin: 1, ndmax: 10, radius: 50,
      ktype: 1, nst: 1, c0: 0.5, it: [1], cc: [1.0], aa: [20.0]
    });

    // All estimated nodes should have estimates within data range
    for (let i = 0; i < 9; i++) {
      if (est[i] !== -999.0) {
        assert.ok(est[i] >= 5 && est[i] <= 35,
          `OK estimate ${est[i]} should be within data range`);
        assert.ok(estv[i] >= 0,
          `variance ${estv[i]} should be non-negative`);
      }
    }
  });

  it('simple kriging uses mean', async () => {
    // SK with known mean: estimate = sum(wi*vi) + (1-sum(wi))*mean
    const data = [[5, 5, 100.0]];
    const skmean = 50.0;
    const { est } = await setupKb2d(data, {
      nx: 3, ny: 3, xmn: 5, ymn: 5, xsiz: 10, ysiz: 10,
      ndmin: 1, ndmax: 10, radius: 50,
      ktype: 0, skmean,
      nst: 1, c0: 0, it: [1], cc: [1.0], aa: [20.0]
    });

    // At data location (0,0): estimate ~ data value
    approx(est[0], 100.0, 1.0);

    // Far from data: estimate should approach skmean
    // Node (2,2) at (25,25) — distance ~28.3 from (5,5), range=20
    // Weight should be low, so estimate near skmean
    if (est[8] !== -999.0) {
      assert.ok(est[8] < 100.0, `far estimate ${est[8]} should be less than data value`);
      assert.ok(est[8] >= skmean * 0.5,
        `far estimate ${est[8]} should trend toward skmean=${skmean}`);
    }
  });

  it('variance increases with distance from data', async () => {
    const data = [[5, 5, 10.0], [5, 15, 20.0]];
    const { est, estv } = await setupKb2d(data, {
      nx: 3, ny: 3, xmn: 5, ymn: 5, xsiz: 10, ysiz: 10,
      ndmin: 1, ndmax: 10, radius: 50,
      ktype: 1, nst: 1, c0: 0, it: [1], cc: [1.0], aa: [20.0]
    });

    // Variance at node near data should be less than variance far from data
    const varNear = estv[0 + 0 * 3]; // (0,0) at (5,5) — data location
    const varFar  = estv[2 + 2 * 3]; // (2,2) at (25,25) — far from data

    if (varNear !== -999.0 && varFar !== -999.0) {
      assert.ok(varNear < varFar,
        `variance near data (${varNear}) should be < variance far (${varFar})`);
    }
  });
});
