// scitra.spatial.KDTree

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KDTree } from '../ext/scitra/src/spatial/kdtree.js';
import { cdist } from '../ext/scitra/src/spatial/distance.js';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── construction ────────────────────────────────────────────────────

test('KDTree: builds on small input', () => {
  const T = new KDTree([[0, 0], [1, 1], [2, 2]]);
  assert.equal(T.n, 3);
  assert.equal(T.d, 2);
});

test('KDTree: empty input', () => {
  const T = new KDTree([]);
  assert.equal(T.n, 0);
  // querying an empty tree returns empty result
  // (we still need a query point of the right dim — skip query test)
});

test('KDTree: single point', () => {
  const T = new KDTree([[5, 7]]);
  const r = T.query([0, 0], 1);
  assert.equal(r.idx[0], 0);
  assert.ok(close(r.dist[0], Math.sqrt(74)));
});

test('KDTree: rejects mismatched query dim', () => {
  const T = new KDTree([[1, 2], [3, 4]]);
  assert.throws(() => T.query([1, 2, 3]));
});

// ── nearest-neighbor query ──────────────────────────────────────────

test('KDTree: query k=1 finds the actual nearest point', () => {
  const points = [[0, 0], [10, 10], [3, 4], [-5, 2]];
  const T = new KDTree(points);
  const r = T.query([3, 4], 1);
  assert.equal(r.idx[0], 2);  // exact match at index 2
  assert.ok(close(r.dist[0], 0, 1e-12));
});

test('KDTree: query k=3 returns 3 nearest in ascending order', () => {
  const points = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const T = new KDTree(points);
  const r = T.query([0.5, 0], 3);
  assert.equal(r.idx.length, 3);
  // Distances should be non-decreasing
  for (let i = 1; i < r.dist.length; i++) {
    assert.ok(r.dist[i] >= r.dist[i - 1] - 1e-12);
  }
  // Nearest should be at index 0 or 1 (both equidistant: 0.5)
  assert.ok(r.idx[0] === 0 || r.idx[0] === 1);
  assert.ok(close(r.dist[0], 0.5));
});

test('KDTree: query k > n returns all available', () => {
  const T = new KDTree([[0, 0], [1, 1]]);
  const r = T.query([0, 0], 10);
  assert.equal(r.idx.length, 2);
});

test('KDTree: query results match brute-force cdist', () => {
  // Generate a random cluster, verify k-NN matches what cdist would say.
  const N = 200;
  const D = 3;
  const points = [];
  let seed = 42;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < N; i++) {
    const row = [];
    for (let k = 0; k < D; k++) row.push(rng() * 100);
    points.push(row);
  }
  const T = new KDTree(points);
  const query = [50, 50, 50];
  const r = T.query(query, 5);

  // Brute force
  const D2 = cdist([query], points);
  const indices = Array.from({ length: N }, (_, i) => i);
  indices.sort((a, b) => D2[a] - D2[b]);
  const expectedIdx = indices.slice(0, 5);
  const expectedDist = expectedIdx.map(i => D2[i]);

  for (let i = 0; i < 5; i++) {
    assert.equal(r.idx[i], expectedIdx[i],
      `k-NN result idx[${i}]: got ${r.idx[i]}, expected ${expectedIdx[i]}`);
    assert.ok(close(r.dist[i], expectedDist[i], 1e-9),
      `k-NN result dist[${i}]: got ${r.dist[i]}, expected ${expectedDist[i]}`);
  }
});

test('KDTree: query in 1D', () => {
  const T = new KDTree([[1], [3], [5], [7], [9]]);
  const r = T.query([4], 2);
  // Two nearest to 4: 3 (dist 1) and 5 (dist 1)
  assert.equal(r.idx.length, 2);
  assert.ok(close(r.dist[0], 1));
  assert.ok(close(r.dist[1], 1));
});

// ── radius query ────────────────────────────────────────────────────

test('KDTree: query_ball_point returns all points within radius', () => {
  const points = [[0, 0], [1, 0], [3, 0], [10, 0], [-2, 0]];
  const T = new KDTree(points);
  const ball = T.query_ball_point([0, 0], 2.5);
  // Within 2.5 of origin: idx 0 (0), 1 (1), 4 (-2)
  const set = new Set(Array.from(ball));
  assert.ok(set.has(0));
  assert.ok(set.has(1));
  assert.ok(set.has(4));
  assert.ok(!set.has(2));  // 3 > 2.5
  assert.ok(!set.has(3));  // 10
});

test('KDTree: query_ball_point with empty result', () => {
  const T = new KDTree([[100, 100]]);
  const ball = T.query_ball_point([0, 0], 1);
  assert.equal(ball.length, 0);
});

test('KDTree: query_ball_point matches brute-force', () => {
  const N = 100;
  let seed = 7;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const points = [];
  for (let i = 0; i < N; i++) points.push([rng() * 50, rng() * 50]);
  const T = new KDTree(points);
  const q = [25, 25];
  const r = 10;
  const ball = T.query_ball_point(q, r);

  // Brute force
  const expected = new Set();
  const D = cdist([q], points);
  for (let i = 0; i < N; i++) if (D[i] <= r) expected.add(i);

  assert.equal(ball.length, expected.size);
  for (const i of ball) assert.ok(expected.has(i));
});

// ── pair query ──────────────────────────────────────────────────────

test('KDTree: query_pairs finds all close pairs', () => {
  const points = [[0, 0], [0.5, 0], [10, 10], [10.4, 10]];
  const T = new KDTree(points);
  const pairs = T.query_pairs(1);
  // (0,1) dist 0.5; (2,3) dist 0.4. Should find both.
  const pairSet = new Set(pairs.map(([i, j]) => `${i},${j}`));
  assert.ok(pairSet.has('0,1'));
  assert.ok(pairSet.has('2,3'));
  assert.equal(pairs.length, 2);
});

test('KDTree: query_pairs returns i<j only', () => {
  const T = new KDTree([[0, 0], [0.1, 0], [0.2, 0]]);
  const pairs = T.query_pairs(0.5);
  for (const [i, j] of pairs) {
    assert.ok(i < j, `expected i < j, got [${i}, ${j}]`);
  }
});

// ── leaf size ────────────────────────────────────────────────────────

test('KDTree: leafsize affects build but not result', () => {
  const N = 50;
  let seed = 99;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const points = [];
  for (let i = 0; i < N; i++) points.push([rng() * 10, rng() * 10]);

  const T1 = new KDTree(points, { leafsize: 1 });
  const T2 = new KDTree(points, { leafsize: 32 });
  const q = [5, 5];
  const r1 = T1.query(q, 5);
  const r2 = T2.query(q, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(r1.idx[i], r2.idx[i]);
    assert.ok(close(r1.dist[i], r2.dist[i], 1e-12));
  }
});

// ── duplicate points ────────────────────────────────────────────────

test('KDTree: handles duplicate points', () => {
  const T = new KDTree([[0, 0], [0, 0], [0, 0], [1, 1]]);
  const r = T.query([0, 0], 4);
  assert.equal(r.idx.length, 4);
  // First three distances are 0, last is sqrt(2)
  assert.ok(close(r.dist[0], 0));
  assert.ok(close(r.dist[1], 0));
  assert.ok(close(r.dist[2], 0));
  assert.ok(close(r.dist[3], Math.sqrt(2)));
});

test('KDTree: high-d (5D) random data', () => {
  const N = 100, D = 5;
  let seed = 11;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const points = [];
  for (let i = 0; i < N; i++) {
    const row = [];
    for (let k = 0; k < D; k++) row.push(rng());
    points.push(row);
  }
  const T = new KDTree(points);
  const q = new Array(D).fill(0.5);
  const r = T.query(q, 3);
  // Brute-force verification
  const flat = [q];
  const D2 = cdist(flat, points);
  const idx = Array.from({ length: N }, (_, i) => i)
    .sort((a, b) => D2[a] - D2[b]).slice(0, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(r.idx[i], idx[i]);
  }
});
