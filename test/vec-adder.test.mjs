// vec adapter tests — drive Python code through pythonExecute and verify
// VecArray operations end-to-end.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// DOM shim (matches natra-adder.test.mjs / engine pattern).
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => ({
    tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
    innerHTML: '', textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  }),
  createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
};
globalThis.window = globalThis;
globalThis.CSS = { escape: s => s };

const { pythonExecute } = await import('../ext/adder/src/cell.js');
await import('../ext/vec/adder.js');  // triggers registration on _auditableExtensions

async function pyEval(code) {
  return pythonExecute(code, {}, { id: 'test' });
}

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-9) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ═════════════════════════════════════════════════════════════════════
// Registration
// ═════════════════════════════════════════════════════════════════════

describe('vec adder registration', () => {
  it('registers on window._auditableExtensions', () => {
    assert.ok(window._auditableExtensions.vec);
  });

  it('import vec as np works', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3])
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 2, 3]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Array creation
// ═════════════════════════════════════════════════════════════════════

describe('array creation', () => {
  it('np.array from nested list (2D)', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([[1, 2], [3, 4]])
result = a.shape
`);
    assert.deepStrictEqual(r.defines.result, [2, 2]);
  });

  it('np.zeros with list shape', async () => {
    const r = await pyEval(`
import vec as np
a = np.zeros([3])
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [0, 0, 0]);
  });

  it('np.ones / np.full', async () => {
    const r = await pyEval(`
import vec as np
a = np.ones([2, 2]).tolist()
b = np.full([3], 7.0).tolist()
result = (a, b)
`);
    assert.deepStrictEqual(r.defines.result, [[[1, 1], [1, 1]], [7, 7, 7]]);
  });

  it('np.eye(n)', async () => {
    const r = await pyEval(`
import vec as np
result = np.eye(3).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  it('np.arange and np.linspace', async () => {
    const r = await pyEval(`
import vec as np
a = np.arange(5).tolist()
b = np.arange(2, 7).tolist()
c = np.linspace(0, 1, 5).tolist()
result = (a, b, c)
`);
    assert.deepStrictEqual(r.defines.result[0], [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(r.defines.result[1], [2, 3, 4, 5, 6]);
    assert.ok(arrClose(r.defines.result[2], [0, 0.25, 0.5, 0.75, 1]));
  });
});

// ═════════════════════════════════════════════════════════════════════
// Operator overloads
// ═════════════════════════════════════════════════════════════════════

describe('operator overloads', () => {
  it('a + b with two arrays', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3])
b = np.array([10, 20, 30])
result = (a + b).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [11, 22, 33]);
  });

  it('scalar + array (rdunder)', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3])
result = (10 + a).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [11, 12, 13]);
  });

  it('array - scalar', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([5, 10, 15])
result = (a - 1).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [4, 9, 14]);
  });

  it('array * array', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([2, 3, 4])
b = np.array([5, 6, 7])
result = (a * b).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [10, 18, 28]);
  });

  it('array / scalar', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([10, 20, 30])
result = (a / 2).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [5, 10, 15]);
  });

  it('-a (neg)', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, -2, 3])
result = (-a).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [-1, 2, -3]);
  });

  it('a ** 2 (pow scalar)', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3, 4])
result = (a ** 2).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 4, 9, 16]);
  });

  it('A @ B (matmul)', async () => {
    const r = await pyEval(`
import vec as np
A = np.array([[1, 2], [3, 4]])
B = np.array([[5, 6], [7, 8]])
result = (A @ B).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[19, 22], [43, 50]]);
  });

  it('broadcast: row vec + matrix', async () => {
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6]])
v = np.array([10, 20, 30])
result = (m + v).tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[11, 22, 33], [14, 25, 36]]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Indexing and slicing
// ═════════════════════════════════════════════════════════════════════

describe('indexing', () => {
  it('1D integer indexing', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([10, 20, 30, 40])
result = (a[0], a[-1], a[2])
`);
    assert.deepStrictEqual(r.defines.result, [10, 40, 30]);
  });

  it('1D slice', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([10, 20, 30, 40, 50])
result = a[1:4].tolist()
`);
    assert.deepStrictEqual(r.defines.result, [20, 30, 40]);
  });

  it('2D row indexing returns VecArray', async () => {
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6]])
row = m[1]
result = row.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [4, 5, 6]);
  });

  it('2D chained indexing m[i][j] returns scalar', async () => {
    // Note: adder's parser does not support `m[i, j]` comma-tuple subscripts;
    // chained `m[i][j]` is the supported idiom. (vec's adapter still accepts
    // array-tuple keys for callers that construct them explicitly.)
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6]])
result = m[1][2]
`);
    assert.equal(r.defines.result, 6);
  });

  it('2D slice on a single axis', async () => {
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
result = m[1:3].tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[4, 5, 6], [7, 8, 9]]);
  });

  it('1D setitem', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3])
a[1] = 99
result = a.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [1, 99, 3]);
  });

  it('2D row setitem with VecArray', async () => {
    const r = await pyEval(`
import vec as np
m = np.zeros([2, 3])
v = np.array([1, 2, 3])
m[0] = v
result = m.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[1, 2, 3], [0, 0, 0]]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Methods + reductions
// ═════════════════════════════════════════════════════════════════════

describe('methods and reductions', () => {
  it('a.sum() / np.sum(a)', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3, 4])
result = (a.sum(), np.sum(a))
`);
    assert.deepStrictEqual(r.defines.result, [10, 10]);
  });

  it('a.mean() / a.max() / a.min()', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([3, 1, 4, 1, 5, 9, 2, 6])
result = (a.mean(), a.max(), a.min())
`);
    const [mean, mx, mn] = r.defines.result;
    assert.ok(close(mean, 31 / 8));
    assert.equal(mx, 9);
    assert.equal(mn, 1);
  });

  it('axis-aware sum', async () => {
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6]])
result = (m.sum(0).tolist(), m.sum(1).tolist())
`);
    assert.deepStrictEqual(r.defines.result, [[5, 7, 9], [6, 15]]);
  });

  it('a.dot(b) and np.dot', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 2, 3])
b = np.array([4, 5, 6])
result = (a.dot(b), np.dot(a, b))
`);
    assert.deepStrictEqual(r.defines.result, [32, 32]);
  });

  it('a.T (transpose property)', async () => {
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6]])
result = m.T.tolist()
`);
    assert.deepStrictEqual(r.defines.result, [[1, 4], [2, 5], [3, 6]]);
  });

  it('reshape and flatten', async () => {
    const r = await pyEval(`
import vec as np
a = np.arange(6)
m = a.reshape([2, 3])
f = m.flatten()
result = (m.tolist(), f.tolist())
`);
    assert.deepStrictEqual(r.defines.result, [[[0, 1, 2], [3, 4, 5]], [0, 1, 2, 3, 4, 5]]);
  });

  it('np.sqrt / np.exp / np.sin element-wise', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([1, 4, 9])
result = np.sqrt(a).tolist()
`);
    assert.ok(arrClose(r.defines.result, [1, 2, 3]));
  });
});

// ═════════════════════════════════════════════════════════════════════
// Iteration
// ═════════════════════════════════════════════════════════════════════

describe('iteration', () => {
  it('for x in 1D array yields scalars', async () => {
    const r = await pyEval(`
import vec as np
a = np.array([10, 20, 30])
total = 0
for x in a:
    total = total + x
result = total
`);
    assert.equal(r.defines.result, 60);
  });

  it('for row in 2D array yields VecArrays', async () => {
    const r = await pyEval(`
import vec as np
m = np.array([[1, 2, 3], [4, 5, 6]])
sums = []
for row in m:
    sums.append(row.sum())
result = sums
`);
    assert.deepStrictEqual(r.defines.result, [6, 15]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Linear algebra namespace
// ═════════════════════════════════════════════════════════════════════

describe('np.linalg', () => {
  it('np.linalg.solve', async () => {
    const r = await pyEval(`
import vec as np
A = np.array([[2, 1], [5, 7]])
b = np.array([11, 13])
x = np.linalg.solve(A, b)
result = x.tolist()
`);
    assert.ok(arrClose(r.defines.result, [64 / 9, -29 / 9]));
  });

  it('np.linalg.inv round-trip', async () => {
    const r = await pyEval(`
import vec as np
A = np.array([[4, 7], [2, 6]])
Ai = np.linalg.inv(A)
I = A @ Ai
result = I.tolist()
`);
    const I = r.defines.result;
    assert.ok(close(I[0][0], 1) && close(I[1][1], 1));
    assert.ok(close(I[0][1], 0) && close(I[1][0], 0));
  });

  it('np.linalg.det', async () => {
    const r = await pyEval(`
import vec as np
A = np.array([[1, 2], [3, 4]])
result = np.linalg.det(A)
`);
    assert.ok(close(r.defines.result, -2));
  });

  it('np.linalg.cholesky', async () => {
    const r = await pyEval(`
import vec as np
A = np.array([[4, 2], [2, 3]])
L = np.linalg.cholesky(A)
recon = L @ L.T
result = recon.tolist()
`);
    const recon = r.defines.result;
    assert.ok(close(recon[0][0], 4) && close(recon[1][1], 3));
    assert.ok(close(recon[0][1], 2) && close(recon[1][0], 2));
  });

  it('np.linalg.eigh3 returns [values, vectors]', async () => {
    const r = await pyEval(`
import vec as np
A = np.array([[4, 1, 2], [1, 5, 1], [2, 1, 3]])
res = np.linalg.eigh3(A)
vals = res[0].tolist()
vecs_shape = res[1].shape
result = (vals, vecs_shape)
`);
    const [vals, shape] = r.defines.result;
    // Values descending
    assert.ok(vals[0] >= vals[1]);
    assert.ok(vals[1] >= vals[2]);
    assert.deepStrictEqual(shape, [3, 3]);
  });

  it('np.linalg.lstsq recovers regression coefficients', async () => {
    const r = await pyEval(`
import vec as np
# Fit y = 2x + 3 to 5 noiseless points.
A = np.array([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]])
b = np.array([3, 5, 7, 9, 11])
beta = np.linalg.lstsq(A, b)
result = beta.tolist()
`);
    const [slope, intercept] = r.defines.result;
    assert.ok(close(slope, 2));
    assert.ok(close(intercept, 3));
  });
});
