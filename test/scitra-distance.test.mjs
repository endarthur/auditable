// scitra.spatial.distance — cdist, pdist, squareform

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cdist, pdist, squareform } from '../ext/scitra/src/spatial/distance.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const arrClose = (a, b, tol = 1e-9) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], tol)) return false;
  return true;
};

// ── cdist: euclidean ────────────────────────────────────────────────

test('cdist: 1D euclidean', () => {
  // X = [[0], [3]], Y = [[4]] → distances [4, 1]
  const D = cdist([[0], [3]], [[4]]);
  assert.equal(D.length, 2);
  assert.ok(close(D[0], 4));
  assert.ok(close(D[1], 1));
});

test('cdist: 2D euclidean', () => {
  // (0,0) → (3,4) = 5; (0,0) → (1,0) = 1
  const D = cdist([[0, 0]], [[3, 4], [1, 0]]);
  assert.equal(D.length, 2);
  assert.ok(close(D[0], 5));
  assert.ok(close(D[1], 1));
});

test('cdist: square self-distance has zero diagonal', () => {
  const X = [[1, 2], [3, 4], [5, 6]];
  const D = cdist(X, X);
  for (let i = 0; i < 3; i++) {
    assert.ok(close(D[i * 3 + i], 0, 1e-12));
  }
  // Symmetry
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(close(D[i * 3 + j], D[j * 3 + i], 1e-12));
    }
  }
});

// ── cdist: other metrics ────────────────────────────────────────────

test('cdist: sqeuclidean', () => {
  const D = cdist([[0, 0]], [[3, 4]], { metric: 'sqeuclidean' });
  assert.ok(close(D[0], 25));
});

test('cdist: manhattan / cityblock', () => {
  const D = cdist([[0, 0]], [[3, 4]], { metric: 'manhattan' });
  assert.ok(close(D[0], 7));
  const D2 = cdist([[0, 0]], [[3, 4]], { metric: 'cityblock' });
  assert.ok(close(D2[0], 7));
});

test('cdist: chebyshev', () => {
  const D = cdist([[0, 0]], [[3, 4]], { metric: 'chebyshev' });
  assert.ok(close(D[0], 4));  // max coord diff
});

test('cdist: minkowski p=1 equals manhattan', () => {
  const D1 = cdist([[0, 0]], [[3, 4]], { metric: 'minkowski', p: 1 });
  const D2 = cdist([[0, 0]], [[3, 4]], { metric: 'manhattan' });
  assert.ok(close(D1[0], D2[0], 1e-12));
});

test('cdist: minkowski p=2 equals euclidean', () => {
  const D1 = cdist([[0, 0]], [[3, 4]], { metric: 'minkowski', p: 2 });
  const D2 = cdist([[0, 0]], [[3, 4]]);
  assert.ok(close(D1[0], D2[0], 1e-12));
});

test('cdist: hamming', () => {
  // 4-d binary vectors: positions 0,2 differ
  const D = cdist([[1, 0, 1, 0]], [[0, 0, 0, 0]], { metric: 'hamming' });
  assert.ok(close(D[0], 0.5));
});

test('cdist: cosine of orthogonal = 1', () => {
  const D = cdist([[1, 0]], [[0, 1]], { metric: 'cosine' });
  assert.ok(close(D[0], 1, 1e-12));
});

test('cdist: cosine of identical = 0', () => {
  const D = cdist([[1, 2]], [[2, 4]], { metric: 'cosine' });
  assert.ok(close(D[0], 0, 1e-12));
});

test('cdist: mahalanobis with identity VI = euclidean', () => {
  const VI = [1, 0, 0, 1];  // d=2 identity
  const D1 = cdist([[0, 0]], [[3, 4]], { metric: 'mahalanobis', VI });
  const D2 = cdist([[0, 0]], [[3, 4]]);
  assert.ok(close(D1[0], D2[0], 1e-12));
});

test('cdist: weighted euclidean', () => {
  // weight axis-0 by 0, so distance = |y - 0| = sqrt(y²) on axis-1
  const D = cdist([[0, 0]], [[3, 4]], { w: [0, 1] });
  assert.ok(close(D[0], 4));
});

// ── cdist: custom metric callback ───────────────────────────────────

test('cdist: custom function metric', () => {
  // Sum-of-coords distance
  const D = cdist([[1, 2]], [[3, 4]], {
    metric: (a, b) => Math.abs(a[0] + a[1] - b[0] - b[1]),
  });
  assert.ok(close(D[0], 4));  // |1+2 - 3-4| = 4
});

// ── pdist ────────────────────────────────────────────────────────────

test('pdist: 3 points euclidean', () => {
  // (0,0), (3,4), (6,8): pairs are 5, 10, 5
  const D = pdist([[0, 0], [3, 4], [6, 8]]);
  assert.equal(D.length, 3);
  assert.ok(close(D[0], 5));
  assert.ok(close(D[1], 10));
  assert.ok(close(D[2], 5));
});

test('pdist: empty for n=1', () => {
  const D = pdist([[1, 2]]);
  assert.equal(D.length, 0);
});

test('pdist: matches cdist on the upper triangle', () => {
  const X = [[1, 2], [3, 4], [5, 6], [7, 8]];
  const D1 = pdist(X);
  const D2 = cdist(X, X);
  let idx = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      assert.ok(close(D1[idx], D2[i * 4 + j], 1e-12));
      idx++;
    }
  }
});

// ── squareform ───────────────────────────────────────────────────────

test('squareform: pdist → square → pdist roundtrip', () => {
  const X = [[1, 2], [3, 4], [5, 6], [7, 8]];
  const packed = pdist(X);
  const square = squareform(packed);
  const repacked = squareform(square);
  assert.ok(arrClose(packed, repacked, 1e-12));
});

test('squareform: square has zero diagonal', () => {
  const packed = new Float64Array([1, 2, 3]);  // n=3 → 3 pairs
  const square = squareform(packed);
  assert.equal(square.length, 9);
  for (let i = 0; i < 3; i++) assert.equal(square[i * 3 + i], 0);
});

test('squareform: square is symmetric', () => {
  const X = [[0, 0], [1, 1], [2, 0], [0, 2]];
  const sq = squareform(pdist(X));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      assert.equal(sq[i * 4 + j], sq[j * 4 + i]);
    }
  }
});

test('squareform: invalid length throws', () => {
  // length 5 is neither k(k-1)/2 nor k²
  assert.throws(() => squareform(new Float64Array(5)));
});

// ── input flexibility ───────────────────────────────────────────────

test('cdist: accepts ndarray-like { data, shape }', () => {
  const X = { data: new Float64Array([0, 0, 3, 4]), shape: [2, 2] };
  const Y = { data: new Float64Array([0, 0]), shape: [1, 2] };
  const D = cdist(X, Y);
  assert.equal(D.length, 2);
  assert.ok(close(D[0], 0));
  assert.ok(close(D[1], 5));
});

test('cdist: rejects mismatched dims', () => {
  assert.throws(() => cdist([[1, 2]], [[1, 2, 3]]));
});
