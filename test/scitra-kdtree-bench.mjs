// scitra KDTree vs scipy.spatial.KDTree — correctness + performance.
//
// Correctness: brute-force-compute kNN/ball-query for small N, verify
// scitra matches. (scipy's tests do the same thing — both implementations
// solve the same well-defined math problem, so brute-force is the right
// reference for any correct implementation.)
//
// Performance: scipy times come from test/perf_scipy_kdtree.py (numpy
// single-threaded BLAS, scipy native KDTree). scitra runs side-by-side
// on independently generated data of the same shape.

import { execSync } from 'node:child_process';
import { KDTree, cdist } from '../ext/scitra/index.js';

function bench(fn, warmup = 2, samples = 10) {
  for (let i = 0; i < warmup; i++) fn();
  const ts = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)];
}

// ── correctness via brute-force on small N ────────────────────────────

function bruteKnn(points, query, k) {
  // points: array of arrays, query: array, k: int
  const distSq = points.map((p, i) => {
    let s = 0;
    for (let j = 0; j < p.length; j++) {
      const d = p[j] - query[j];
      s += d * d;
    }
    return { i, sq: s };
  });
  distSq.sort((a, b) => a.sq - b.sq);
  return {
    idx: distSq.slice(0, k).map(x => x.i),
    dist: distSq.slice(0, k).map(x => Math.sqrt(x.sq)),
  };
}

function bruteBall(points, query, r) {
  const r2 = r * r;
  const idx = [];
  for (let i = 0; i < points.length; i++) {
    let s = 0;
    for (let j = 0; j < points[i].length; j++) {
      const d = points[i][j] - query[j];
      s += d * d;
    }
    if (s <= r2) idx.push(i);
  }
  return idx.sort((a, b) => a - b);
}

function makeRng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePoints(n, d, seed) {
  const rng = makeRng(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < d; j++) row.push(rng() * 100);
    pts.push(row);
  }
  return pts;
}

console.log('## Correctness checks vs brute-force\n');

let allPassed = true;
const correctnessCases = [
  { n: 50,  d: 2,  k: 10 },
  { n: 100, d: 3,  k: 5  },
  { n: 200, d: 5,  k: 7  },
  { n: 500, d: 10, k: 20 },
];

for (const { n, d, k } of correctnessCases) {
  const pts = makePoints(n, d, 1 + n + d);
  const tree = new KDTree(pts);
  const query = pts[Math.floor(n / 2)].map(v => v + 1.234);  // off-center

  const sciRes = tree.query(query, k);
  const bruteRes = bruteKnn(pts, query, k);

  // Indices must match (same distances ⇒ same neighbors, deterministic when no ties)
  let idxMatch = true;
  for (let i = 0; i < k; i++) {
    if (sciRes.idx[i] !== bruteRes.idx[i]) { idxMatch = false; break; }
  }
  // Distances must match to high precision
  let maxDistErr = 0;
  for (let i = 0; i < k; i++) {
    const e = Math.abs(sciRes.dist[i] - bruteRes.dist[i]);
    if (e > maxDistErr) maxDistErr = e;
  }

  // Ball query
  const r = 15;
  const sciBall = Array.from(tree.query_ball_point(query, r)).sort((a, b) => a - b);
  const bruteBallRes = bruteBall(pts, query, r);
  let ballMatch = sciBall.length === bruteBallRes.length;
  for (let i = 0; i < sciBall.length && ballMatch; i++) {
    if (sciBall[i] !== bruteBallRes[i]) ballMatch = false;
  }

  const tag = idxMatch && maxDistErr < 1e-10 && ballMatch ? '✓' : '✗';
  if (tag === '✗') allPassed = false;
  console.log(`  ${tag} n=${n} d=${d} k=${k}: kNN ${idxMatch ? 'OK' : 'FAIL'}, dist err ${maxDistErr.toExponential(2)}, ball |brute|=${bruteBallRes.length} |scitra|=${sciBall.length} ${ballMatch ? 'OK' : 'FAIL'}`);
}
console.log(allPassed ? '\n  All correctness checks passed.\n' : '\n  ✗ Some failed.\n');

// ── perf bench ────────────────────────────────────────────────────────

console.log('Running scipy reference (single-thread)…');
let scipy;
try {
  const out = execSync('python test/perf_scipy_kdtree.py', {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  scipy = JSON.parse(out.trim());
  console.log('  scipy ready\n');
} catch (e) {
  console.log('  scipy unavailable:', e.message.slice(0, 100));
  scipy = null;
}

const K = scipy ? scipy.k : 10;
const NUM_BATCH = scipy ? scipy.num_batch : 100;

const cases = scipy ? scipy.cases : [
  { n: 100, d: 2 }, { n: 1000, d: 3 }, { n: 10000, d: 3 },
];

console.log(`## kNN k=${K}, batch=${NUM_BATCH} — ms/call, median\n`);
console.log('| n      | d  | build (sci/sct) | kNN 1 (sci/sct) | kNN batch (sci/sct) | ball (sci/sct) | pairs (sci/sct) |');
console.log('|--------|----|-----------------|-----------------|---------------------|----------------|-----------------|');

let sink = 0;
for (const c of cases) {
  const { n, d } = c;
  const pts = makePoints(n, d, 1 + n + d);
  const queryRng = makeRng(99 + n + d);
  const queries = [];
  for (let i = 0; i < NUM_BATCH; i++) {
    const row = [];
    for (let j = 0; j < d; j++) row.push(queryRng() * 100);
    queries.push(row);
  }
  const singleQ = queries[0];

  const tBuild = bench(() => {
    const t = new KDTree(pts);
    sink += t.n;
  }, 1, 5);

  const tree = new KDTree(pts);

  const tQuery1 = bench(() => {
    const r = tree.query(singleQ, K);
    sink += r.idx[0];
  }, 2, 30);

  const tQueryBatch = bench(() => {
    for (const q of queries) {
      const r = tree.query(q, K);
      sink += r.idx[0];
    }
  }, 1, 10);

  const r_ball = c.r_ball ?? 5;
  const tBall1 = bench(() => {
    const r = tree.query_ball_point(singleQ, r_ball);
    sink += r.length;
  }, 2, 30);

  let tPairs = null;
  if (n <= 10000 && c.r_pair != null) {
    tPairs = bench(() => {
      const r = tree.query_pairs(c.r_pair);
      sink += r.length;
    }, 1, 5);
  }

  const f = (v) => v == null ? '   n/a   ' : v.toFixed(3).padStart(9);
  const pair = (a, b) => `${f(a)} / ${f(b)}`;

  console.log(`| ${String(n).padStart(6)} | ${String(d).padStart(2)} | ${pair(c.build_ms, tBuild)} | ${pair(c.query1_ms, tQuery1)} | ${pair(c.query_batch_ms, tQueryBatch)}    | ${pair(c.ball1_ms, tBall1)} | ${pair(c.pairs_ms, tPairs)} |`);
}

console.log('\nsink:', sink);
