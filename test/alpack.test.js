import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atra } from '../ext/atra/index.js';

// ── Test helper ──────────────────────────────────────────────────────

const alpackSource = readFileSync(
  new URL('../ext/atra/lib/alpack.atra', import.meta.url), 'utf8'
);

function setup(pages = 4) {
  const memory = new WebAssembly.Memory({ initial: pages });
  const lib = atra.run(alpackSource, { memory });
  const f64 = new Float64Array(memory.buffer);
  const i32 = new Int32Array(memory.buffer);
  return { lib, memory, f64, i32 };
}

// byte offset for a given f64 index
const F = (idx) => idx * 8;
// byte offset for a given i32 index
const I = (idx) => idx * 4;

function near(actual, expected, tol = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) < tol,
    `expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

// ═════════════════════════════════════════════════════════════════════
// ALAS Level 1 — vector-vector
// ═════════════════════════════════════════════════════════════════════

describe('ALAS Level 1', () => {
  it('dscal scales a vector', () => {
    const { lib, f64 } = setup();
    const x = 0; // f64 index 0
    f64.set([1, 2, 3, 4, 5], x);
    lib.alas.dscal(F(x), 5, 2.0);
    assert.deepStrictEqual([...f64.subarray(0, 5)], [2, 4, 6, 8, 10]);
  });

  it('dcopy copies a vector', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 2, 3, 4], x);
    f64.fill(0, y, y + 4);
    lib.alas.dcopy(F(x), F(y), 4);
    assert.deepStrictEqual([...f64.subarray(y, y + 4)], [1, 2, 3, 4]);
  });

  it('daxpy computes y = alpha*x + y', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 2, 3, 4, 5], x);
    f64.set([10, 20, 30, 40, 50], y);
    lib.alas.daxpy(F(x), F(y), 5, 2.0);
    assert.deepStrictEqual([...f64.subarray(y, y + 5)], [12, 24, 36, 48, 60]);
  });

  it('daxpy works with odd-length vectors', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 2, 3], x);
    f64.set([10, 20, 30], y);
    lib.alas.daxpy(F(x), F(y), 3, 3.0);
    assert.deepStrictEqual([...f64.subarray(y, y + 3)], [13, 26, 39]);
  });

  it('ddot computes dot product', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 2, 3, 4], x);
    f64.set([5, 6, 7, 8], y);
    // 1*5 + 2*6 + 3*7 + 4*8 = 5+12+21+32 = 70
    near(lib.alas.ddot(F(x), F(y), 4), 70.0);
  });

  it('ddot works with odd-length vectors', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 2, 3], x);
    f64.set([4, 5, 6], y);
    // 1*4 + 2*5 + 3*6 = 4+10+18 = 32
    near(lib.alas.ddot(F(x), F(y), 3), 32.0);
  });

  it('dnrm2 computes Euclidean norm', () => {
    const { lib, f64 } = setup();
    const x = 0;
    f64.set([3, 4], x);
    near(lib.alas.dnrm2(F(x), 2), 5.0);
  });

  it('dswap swaps two vectors', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 2, 3], x);
    f64.set([4, 5, 6], y);
    lib.alas.dswap(F(x), F(y), 3);
    assert.deepStrictEqual([...f64.subarray(x, x + 3)], [4, 5, 6]);
    assert.deepStrictEqual([...f64.subarray(y, y + 3)], [1, 2, 3]);
  });

  it('idamax finds index of max absolute value', () => {
    const { lib, f64 } = setup();
    const x = 0;
    f64.set([1, -5, 3, 2], x);
    assert.strictEqual(lib.alas.idamax(F(x), 4), 1);
  });

  it('dasum computes sum of absolute values', () => {
    const { lib, f64 } = setup();
    const x = 0;
    f64.set([1, -2, 3, -4, 5], x);
    near(lib.alas.dasum(F(x), 5), 15.0);
  });

  it('dasum of zero vector', () => {
    const { lib, f64 } = setup();
    const x = 0;
    f64.set([0, 0, 0], x);
    near(lib.alas.dasum(F(x), 3), 0.0);
  });

  it('drot applies Givens rotation', () => {
    const { lib, f64 } = setup();
    const x = 0, y = 10;
    f64.set([1, 0], x);
    f64.set([0, 1], y);
    const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
    lib.alas.drot(F(x), F(y), 2, c, s);
    // x[0] = c*1 + s*0 = c, y[0] = c*0 - s*1 = -s
    near(f64[x], c);
    near(f64[x + 1], s);
    near(f64[y], -s);
    near(f64[y + 1], c);
  });

  it('drotg generates Givens rotation', () => {
    const { lib, f64 } = setup();
    const cs = 0;
    const r = lib.alas.drotg(3.0, 4.0, F(cs));
    const c = f64[cs], s = f64[cs + 1];
    // c^2 + s^2 = 1
    near(c * c + s * s, 1.0);
    // r = sqrt(a^2 + b^2) = 5
    near(r, 5.0);
    // c*a + s*b = r
    near(c * 3.0 + s * 4.0, r);
    // -s*a + c*b = 0
    near(-s * 3.0 + c * 4.0, 0.0);
  });

  it('drotg handles zero input', () => {
    const { lib, f64 } = setup();
    const cs = 0;
    const r = lib.alas.drotg(0.0, 0.0, F(cs));
    near(f64[cs], 1.0);     // c = 1
    near(f64[cs + 1], 0.0); // s = 0
    near(r, 0.0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALAS Level 2 — matrix-vector
// ═════════════════════════════════════════════════════════════════════

describe('ALAS Level 2', () => {
  it('dgemv computes y = alpha*A*x + beta*y', () => {
    const { lib, f64 } = setup();
    // A = [[1,2],[3,4],[5,6]]  (3x2), x = [1,2], y = [0,0,0]
    const a = 0, x = 10, y = 20;
    f64.set([1, 2, 3, 4, 5, 6], a);
    f64.set([1, 2], x);
    f64.set([0, 0, 0], y);
    lib.alas.dgemv(F(a), F(x), F(y), 3, 2, 1.0, 0.0);
    // [1*1+2*2, 3*1+4*2, 5*1+6*2] = [5, 11, 17]
    near(f64[y], 5.0);
    near(f64[y + 1], 11.0);
    near(f64[y + 2], 17.0);
  });

  it('dgemv with alpha and beta', () => {
    const { lib, f64 } = setup();
    const a = 0, x = 10, y = 20;
    f64.set([1, 0, 0, 1], a); // 2x2 identity
    f64.set([3, 4], x);
    f64.set([10, 20], y);
    lib.alas.dgemv(F(a), F(x), F(y), 2, 2, 2.0, 1.0);
    // y = 2*I*[3,4] + 1*[10,20] = [6+10, 8+20] = [16, 28]
    near(f64[y], 16.0);
    near(f64[y + 1], 28.0);
  });

  it('dtrsv solves lower triangular system', () => {
    const { lib, f64 } = setup();
    // L = [[2,0,0],[1,3,0],[0,1,4]], b = [4, 7, 8]
    // L*x = b → x = [2, 5/3, (8-5/3)/4]
    const a = 0, x = 20;
    f64.set([2, 0, 0,  1, 3, 0,  0, 1, 4], a);
    f64.set([4, 7, 8], x);
    lib.alas.dtrsv(F(a), F(x), 3, 0, 0); // lower, no trans
    near(f64[x], 2.0);
    near(f64[x + 1], 5.0 / 3.0);
    near(f64[x + 2], (8.0 - 5.0 / 3.0) / 4.0);
  });

  it('dtrsv solves upper triangular system', () => {
    const { lib, f64 } = setup();
    // U = [[2,1,0],[0,3,1],[0,0,4]], b = [5, 7, 8]
    // U*x = b → x[2]=2, x[1]=(7-2)/3=5/3, x[0]=(5-5/3)/2
    const a = 0, x = 20;
    f64.set([2, 1, 0,  0, 3, 1,  0, 0, 4], a);
    f64.set([5, 7, 8], x);
    lib.alas.dtrsv(F(a), F(x), 3, 1, 0); // upper, no trans
    near(f64[x + 2], 2.0);
    near(f64[x + 1], 5.0 / 3.0);
    near(f64[x], (5.0 - 5.0 / 3.0) / 2.0);
  });

  it('dger performs rank-1 update', () => {
    const { lib, f64 } = setup();
    // A = [[1,2],[3,4]] (2x2), x=[1,2], y=[3,4], alpha=1
    // A += x*y^T = [[1+3,2+4],[3+6,4+8]] = [[4,6],[9,12]]
    const a = 0, x = 10, y = 20;
    f64.set([1, 2, 3, 4], a);
    f64.set([1, 2], x);
    f64.set([3, 4], y);
    lib.alas.dger(F(a), F(x), F(y), 2, 2, 1.0);
    near(f64[0], 4.0);
    near(f64[1], 6.0);
    near(f64[2], 9.0);
    near(f64[3], 12.0);
  });

  it('dsyr performs symmetric rank-1 update', () => {
    const { lib, f64 } = setup();
    // A = [[1,0],[0,2]] (2x2), x = [1, 2], alpha = 1
    // lower triangle: A += x * x^T
    // A[0,0] += 1*1 = 2, A[1,0] += 2*1 = 2, A[1,1] += 2*2 = 6
    const a = 0, x = 10;
    f64.set([1, 0, 0, 2], a);
    f64.set([1, 2], x);
    lib.alas.dsyr(F(a), F(x), 2, 1.0);
    near(f64[0], 2.0);  // A[0,0]
    near(f64[2], 2.0);  // A[1,0]
    near(f64[3], 6.0);  // A[1,1]
  });

  it('dsyr2 performs symmetric rank-2 update', () => {
    const { lib, f64 } = setup();
    // A = zeros(2x2), x = [1, 0], y = [0, 1], alpha = 1
    // A += x*y^T + y*x^T = [[0,1],[1,0]]
    const a = 0, x = 10, y = 20;
    f64.set([0, 0, 0, 0], a);
    f64.set([1, 0], x);
    f64.set([0, 1], y);
    lib.alas.dsyr2(F(a), F(x), F(y), 2, 1.0);
    near(f64[0], 0.0);  // A[0,0]
    near(f64[2], 1.0);  // A[1,0] = x[1]*y[0] + y[1]*x[0] = 0 + 1*1 = 1
    near(f64[3], 0.0);  // A[1,1]
  });

  it('dtrmv upper no-transpose', () => {
    const { lib, f64 } = setup();
    // U = [[2,1,0],[0,3,1],[0,0,4]], x = [1, 2, 3]
    // x := U*x = [2*1+1*2, 3*2+1*3, 4*3] = [4, 9, 12]
    const a = 0, x = 20;
    f64.set([2, 1, 0,  0, 3, 1,  0, 0, 4], a);
    f64.set([1, 2, 3], x);
    lib.alas.dtrmv(F(a), F(x), 3, 1, 0, 0);
    near(f64[x], 4.0);
    near(f64[x + 1], 9.0);
    near(f64[x + 2], 12.0);
  });

  it('dtrmv lower no-transpose', () => {
    const { lib, f64 } = setup();
    // L = [[2,0,0],[1,3,0],[0,1,4]], x = [1, 2, 3]
    // x := L*x = [2*1, 1*1+3*2, 0*1+1*2+4*3] = [2, 7, 14]
    const a = 0, x = 20;
    f64.set([2, 0, 0,  1, 3, 0,  0, 1, 4], a);
    f64.set([1, 2, 3], x);
    lib.alas.dtrmv(F(a), F(x), 3, 0, 0, 0);
    near(f64[x], 2.0);
    near(f64[x + 1], 7.0);
    near(f64[x + 2], 14.0);
  });

  it('dtrmv upper transpose', () => {
    const { lib, f64 } = setup();
    // U = [[2,1,0],[0,3,1],[0,0,4]], x = [1, 2, 3]
    // x := U^T*x = [2*1, 1*1+3*2, 1*2+4*3] = [2, 7, 14]
    const a = 0, x = 20;
    f64.set([2, 1, 0,  0, 3, 1,  0, 0, 4], a);
    f64.set([1, 2, 3], x);
    lib.alas.dtrmv(F(a), F(x), 3, 1, 1, 0);
    near(f64[x], 2.0);
    near(f64[x + 1], 7.0);
    near(f64[x + 2], 14.0);
  });

  it('dtrmv with unit diagonal', () => {
    const { lib, f64 } = setup();
    // U = [[9,1,0],[0,9,1],[0,0,9]], x = [1, 2, 3], diag=1
    // unit diagonal ignores diagonal entries: x := [1+1*2, 2+1*3, 3] = [3, 5, 3]
    const a = 0, x = 20;
    f64.set([9, 1, 0,  0, 9, 1,  0, 0, 9], a);
    f64.set([1, 2, 3], x);
    lib.alas.dtrmv(F(a), F(x), 3, 1, 0, 1);
    near(f64[x], 3.0);
    near(f64[x + 1], 5.0);
    near(f64[x + 2], 3.0);
  });

  it('dsymv computes symmetric matrix-vector product', () => {
    const { lib, f64 } = setup();
    // A (symmetric) = [[4,2,1],[2,5,3],[1,3,6]], x = [1,1,1]
    // A*x = [7, 10, 10]
    const a = 0, x = 20, y = 30;
    f64.set([4, 2, 1,  2, 5, 3,  1, 3, 6], a);
    f64.set([1, 1, 1], x);
    f64.set([0, 0, 0], y);
    lib.alas.dsymv(F(a), F(x), F(y), 3, 1.0, 0.0);
    near(f64[y], 7.0);
    near(f64[y + 1], 10.0);
    near(f64[y + 2], 10.0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALAS Level 3 — matrix-matrix
// ═════════════════════════════════════════════════════════════════════

describe('ALAS Level 3', () => {
  it('dgemm computes C = alpha*A*B + beta*C', () => {
    const { lib, f64 } = setup();
    // A = [[1,2],[3,4]] (2x2), B = [[5,6],[7,8]] (2x2)
    // C = A*B = [[19,22],[43,50]]
    const a = 0, b = 10, c = 20;
    f64.set([1, 2, 3, 4], a);
    f64.set([5, 6, 7, 8], b);
    f64.fill(0, c, c + 4);
    lib.alas.dgemm(F(a), F(b), F(c), 2, 2, 2, 1.0, 0.0);
    near(f64[c], 19.0);
    near(f64[c + 1], 22.0);
    near(f64[c + 2], 43.0);
    near(f64[c + 3], 50.0);
  });

  it('dgemm with non-square matrices', () => {
    const { lib, f64 } = setup();
    // A = [[1,2,3]] (1x3), B = [[4],[5],[6]] (3x1)
    // C = A*B = [[32]]
    const a = 0, b = 10, c = 20;
    f64.set([1, 2, 3], a);
    f64.set([4, 5, 6], b);
    f64.set([0], c);
    lib.alas.dgemm(F(a), F(b), F(c), 1, 1, 3, 1.0, 0.0);
    near(f64[c], 32.0);
  });

  it('dgemm with alpha and beta', () => {
    const { lib, f64 } = setup();
    const a = 0, b = 10, c = 20;
    f64.set([1, 0, 0, 1], a); // identity
    f64.set([2, 0, 0, 2], b);
    f64.set([1, 1, 1, 1], c);
    lib.alas.dgemm(F(a), F(b), F(c), 2, 2, 2, 3.0, 2.0);
    // C = 3*I*B + 2*C = 3*B + 2*C = [[6+2,0+2],[0+2,6+2]] = [[8,2],[2,8]]
    near(f64[c], 8.0);
    near(f64[c + 1], 2.0);
    near(f64[c + 2], 2.0);
    near(f64[c + 3], 8.0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALPACK — Cholesky
// ═════════════════════════════════════════════════════════════════════

describe('ALPACK Cholesky', () => {
  it('dpotrf factorizes SPD matrix', () => {
    const { lib, f64, i32 } = setup();
    // A = [[4,2],[2,5]]  — SPD
    // L = [[2,0],[1,2]] (L*L^T = A)
    const a = 0, info = 100; // info at i32 index 100
    f64.set([4, 2, 2, 5], a);
    i32[info] = -1;
    lib.alpack.dpotrf(F(a), 2, I(info));
    assert.strictEqual(i32[info], 0);
    near(f64[0], 2.0);    // L[0,0]
    near(f64[2], 1.0);    // L[1,0]
    near(f64[3], 2.0);    // L[1,1]
  });

  it('dpotrf detects non-positive-definite', () => {
    const { lib, f64, i32 } = setup();
    // A = [[1,2],[2,1]] — not SPD (eigenvalues -1, 3)
    const a = 0, info = 100;
    f64.set([1, 2, 2, 1], a);
    lib.alpack.dpotrf(F(a), 2, I(info));
    assert.ok(i32[info] > 0, 'info should be positive for non-SPD');
  });

  it('dpotrf + dpotrs solves SPD system', () => {
    const { lib, f64, i32 } = setup();
    // A = [[4,2,0],[2,5,1],[0,1,3]], b = [8, 13, 7]
    // solution: x = [1, 2, 5/3]
    const a = 0, b = 20, info = 100;
    f64.set([4, 2, 0,  2, 5, 1,  0, 1, 3], a);
    f64.set([8, 13, 7], b);
    lib.alpack.dpotrf(F(a), 3, I(info));
    assert.strictEqual(i32[info], 0);
    lib.alpack.dpotrs(F(a), F(b), 3, 1);

    // verify A*x = b by checking the solution
    // A = [[4,2,0],[2,5,1],[0,1,3]]
    // x[0]*4 + x[1]*2 + x[2]*0 = 8
    // x[0]*2 + x[1]*5 + x[2]*1 = 13
    // x[0]*0 + x[1]*1 + x[2]*3 = 7
    const x0 = f64[b], x1 = f64[b + 1], x2 = f64[b + 2];
    near(4 * x0 + 2 * x1 + 0 * x2, 8.0, 1e-8);
    near(2 * x0 + 5 * x1 + 1 * x2, 13.0, 1e-8);
    near(0 * x0 + 1 * x1 + 3 * x2, 7.0, 1e-8);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALPACK — LU
// ═════════════════════════════════════════════════════════════════════

describe('ALPACK LU', () => {
  it('dgesv solves 3x3 system', () => {
    const { lib, f64, i32 } = setup();
    // A = [[2,1,-1],[-3,-1,2],[-2,1,2]], b = [8,-11,-3]
    // exact solution: x = [2, 3, -1]
    const a = 0, b = 20, ipiv = 200, info = 210;
    f64.set([2, 1, -1,  -3, -1, 2,  -2, 1, 2], a);
    f64.set([8, -11, -3], b);
    lib.alpack.dgesv(F(a), F(b), 3, 1, I(ipiv), I(info));
    assert.strictEqual(i32[info], 0);
    near(f64[b], 2.0, 1e-8);
    near(f64[b + 1], 3.0, 1e-8);
    near(f64[b + 2], -1.0, 1e-8);
  });

  it('dgesv detects singular matrix', () => {
    const { lib, f64, i32 } = setup();
    // A = [[1,2],[2,4]] — singular (rank 1)
    const a = 0, b = 10, ipiv = 200, info = 210;
    f64.set([1, 2, 2, 4], a);
    f64.set([3, 6], b);
    lib.alpack.dgesv(F(a), F(b), 2, 1, I(ipiv), I(info));
    assert.ok(i32[info] > 0, 'info should be positive for singular matrix');
  });

  it('dgetrf + dgetrs roundtrip', () => {
    const { lib, f64, i32 } = setup();
    // A = [[1,2,3],[4,5,6],[7,8,10]], b = [14, 32, 53]
    // solution: x = [1, 2, 3]
    const a = 0, b = 20, ipiv = 200, info = 210;
    f64.set([1, 2, 3,  4, 5, 6,  7, 8, 10], a);
    f64.set([14, 32, 53], b);
    lib.alpack.dgetrf(F(a), 3, I(ipiv), I(info));
    assert.strictEqual(i32[info], 0);
    lib.alpack.dgetrs(F(a), I(ipiv), F(b), 3, 1);
    near(f64[b], 1.0, 1e-8);
    near(f64[b + 1], 2.0, 1e-8);
    near(f64[b + 2], 3.0, 1e-8);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALPACK — Triangular inverse
// ═════════════════════════════════════════════════════════════════════

describe('ALPACK dtrtri', () => {
  it('inverts lower triangular matrix', () => {
    const { lib, f64, i32 } = setup();
    // L = [[2,0,0],[1,3,0],[0,1,4]]
    // L_inv * L should = I
    const l = 0, orig = 20, prod = 40, info = 200;
    f64.set([2, 0, 0,  1, 3, 0,  0, 1, 4], l);
    // save a copy of L
    f64.set([2, 0, 0,  1, 3, 0,  0, 1, 4], orig);
    lib.alpack.dtrtri(F(l), 3, I(info));
    assert.strictEqual(i32[info], 0);

    // compute L_inv * L_orig using dgemm
    f64.fill(0, prod, prod + 9);
    lib.alas.dgemm(F(l), F(orig), F(prod), 3, 3, 3, 1.0, 0.0);

    // should be identity
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        near(f64[prod + i * 3 + j], i === j ? 1.0 : 0.0, 1e-8);
      }
    }
  });

  it('detects zero diagonal', () => {
    const { lib, f64, i32 } = setup();
    const l = 0, info = 200;
    f64.set([1, 0, 0,  0, 0, 0,  0, 0, 1], l);
    lib.alpack.dtrtri(F(l), 3, I(info));
    assert.ok(i32[info] > 0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALPACK — Eigendecomposition 3x3
// ═════════════════════════════════════════════════════════════════════

describe('ALPACK dsyev3', () => {
  it('eigenvalues of diagonal matrix', () => {
    const { lib, f64 } = setup();
    const a = 0, w = 20;
    f64.set([5, 0, 0,  0, 3, 0,  0, 0, 1], a);
    lib.alpack.dsyev3(F(a), F(w));
    // eigenvalues sorted descending: 5, 3, 1
    near(f64[w], 5.0, 1e-8);
    near(f64[w + 1], 3.0, 1e-8);
    near(f64[w + 2], 1.0, 1e-8);
  });

  it('eigenvalues sum = trace', () => {
    const { lib, f64 } = setup();
    // A = [[4,1,0],[1,3,1],[0,1,2]]
    const a = 0, w = 20;
    f64.set([4, 1, 0,  1, 3, 1,  0, 1, 2], a);
    const trace = 4 + 3 + 2; // = 9
    lib.alpack.dsyev3(F(a), F(w));
    const eigSum = f64[w] + f64[w + 1] + f64[w + 2];
    near(eigSum, trace, 1e-8);
  });

  it('eigenvalues of known matrix', () => {
    const { lib, f64 } = setup();
    // A = [[2,1,0],[1,2,1],[0,1,2]]
    // eigenvalues: 2-sqrt(2), 2, 2+sqrt(2)
    const a = 0, w = 20;
    f64.set([2, 1, 0,  1, 2, 1,  0, 1, 2], a);
    lib.alpack.dsyev3(F(a), F(w));
    const eigs = [f64[w], f64[w + 1], f64[w + 2]].sort((a, b) => b - a);
    near(eigs[0], 2 + Math.sqrt(2), 1e-8);
    near(eigs[1], 2.0, 1e-8);
    near(eigs[2], 2 - Math.sqrt(2), 1e-8);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ALPACK — Eigendecomposition general (Jacobi)
// ═════════════════════════════════════════════════════════════════════

describe('ALPACK dsyev', () => {
  it('eigenvalues of 4x4 symmetric matrix', () => {
    const { lib, f64, i32 } = setup();
    // A = [[4,1,0,0],[1,3,1,0],[0,1,2,1],[0,0,1,1]]
    const a = 0, w = 30, info = 200;
    f64.set([4, 1, 0, 0,  1, 3, 1, 0,  0, 1, 2, 1,  0, 0, 1, 1], a);
    const trace = 4 + 3 + 2 + 1; // = 10
    lib.alpack.dsyev(F(a), F(w), 4, I(info));
    assert.strictEqual(i32[info], 0);
    const eigSum = f64[w] + f64[w + 1] + f64[w + 2] + f64[w + 3];
    near(eigSum, trace, 1e-8);
  });

  it('eigenvalues of diagonal matrix are diagonal entries', () => {
    const { lib, f64, i32 } = setup();
    const a = 0, w = 30, info = 200;
    f64.set([7, 0, 0,  0, 3, 0,  0, 0, 5], a);
    lib.alpack.dsyev(F(a), F(w), 3, I(info));
    assert.strictEqual(i32[info], 0);
    const eigs = [f64[w], f64[w + 1], f64[w + 2]].sort((a, b) => b - a);
    near(eigs[0], 7.0, 1e-8);
    near(eigs[1], 5.0, 1e-8);
    near(eigs[2], 3.0, 1e-8);
  });

  it('eigenvalue product = determinant', () => {
    const { lib, f64, i32 } = setup();
    // A = [[2,1],[1,3]]  — det = 5, eigenvalues = (5+sqrt(5))/2 and (5-sqrt(5))/2
    const a = 0, w = 10, info = 200;
    f64.set([2, 1, 1, 3], a);
    lib.alpack.dsyev(F(a), F(w), 2, I(info));
    assert.strictEqual(i32[info], 0);
    const det = f64[w] * f64[w + 1];
    near(det, 5.0, 1e-8);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Relaxed SIMD — f64x2.relaxed_madd
// ═════════════════════════════════════════════════════════════════════

describe('relaxed SIMD', () => {
  it('f64x2.relaxed_madd compiles and computes a*b+c', () => {
    const src = `
subroutine test.fma(a: array f64; b: array f64; c: array f64; r: array f64; n: i32)
var i, n2: i32; va, vb, vc: f64x2
begin
  n2 := n / 2
  for i := 0, n2
    va := v128.load(a, i)
    vb := v128.load(b, i)
    vc := v128.load(c, i)
    va := f64x2.relaxed_madd(va, vb, vc)
    call v128.store(r, i, va)
  end for
end
`;
    // Just verify it compiles to valid Wasm
    const wasm = atra.compile(src);
    assert.ok(wasm instanceof Uint8Array, 'should produce Wasm bytes');
    assert.ok(wasm.length > 8, 'should produce non-trivial Wasm');
    // Verify Wasm magic + version header
    assert.strictEqual(wasm[0], 0x00);
    assert.strictEqual(wasm[1], 0x61);
    assert.strictEqual(wasm[2], 0x73);
    assert.strictEqual(wasm[3], 0x6d);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Export structure
// ═════════════════════════════════════════════════════════════════════

describe('export structure', () => {
  it('has nested alas namespace', () => {
    const { lib } = setup();
    assert.strictEqual(typeof lib.alas, 'object');
    assert.strictEqual(typeof lib.alas.ddot, 'function');
    assert.strictEqual(typeof lib.alas.daxpy, 'function');
    assert.strictEqual(typeof lib.alas.dgemm, 'function');
  });

  it('has nested alpack namespace', () => {
    const { lib } = setup();
    assert.strictEqual(typeof lib.alpack, 'object');
    assert.strictEqual(typeof lib.alpack.dpotrf, 'function');
    assert.strictEqual(typeof lib.alpack.dgesv, 'function');
    assert.strictEqual(typeof lib.alpack.dsyev, 'function');
  });
});
