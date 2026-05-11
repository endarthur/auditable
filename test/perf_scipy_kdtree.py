"""scipy KDTree reference: generates points + queries to .bin files,
times scipy queries, writes results + reference indices/distances to JSON.

Usage: python test/perf_scipy_kdtree.py
Output files (relative to repo root):
  /tmp/scitra-bench/pts_<n>x<d>.bin       float64 little-endian points
  /tmp/scitra-bench/queries_<n>x<d>.bin   float64 LE query points
  /tmp/scitra-bench/results.json          timings + reference k-NN & ball results

JS-side bench (scitra-kdtree-bench.mjs) reads these and runs scitra on
the SAME data for apples-to-apples comparison.
"""
import os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import sys
import time
import json
import numpy as np
from scipy.spatial import KDTree

# Use a tempdir under the repo root for portability across OS
BENCH_DIR = os.path.join(os.path.dirname(__file__), '..', '.kdtree-bench-data')
os.makedirs(BENCH_DIR, exist_ok=True)


def bench(fn, warmup=2, samples=10):
    for _ in range(warmup):
        fn()
    ts = []
    for _ in range(samples):
        t0 = time.perf_counter()
        fn()
        ts.append((time.perf_counter() - t0) * 1000)  # ms
    ts.sort()
    return ts[len(ts) // 2]


cases = [
    {'n': 100,    'd': 2},
    {'n': 1000,   'd': 2},
    {'n': 1000,   'd': 3},
    {'n': 1000,   'd': 10},
    {'n': 10000,  'd': 3},
    {'n': 10000,  'd': 10},
    {'n': 100000, 'd': 3},
    {'n': 100000, 'd': 10},
]

NUM_BATCH = 100
K = 10
BALL_R_FACTOR = 0.05
PAIR_R_FACTOR = 0.02

results = []
for case in cases:
    n, d = case['n'], case['d']
    rng = np.random.default_rng(42 + n + d)
    pts = rng.random((n, d), dtype=np.float64) * 100
    queries = rng.random((NUM_BATCH, d), dtype=np.float64) * 100
    single_q = queries[0]

    # Save data to .bin (float64 LE, row-major)
    pts.tofile(os.path.join(BENCH_DIR, f'pts_{n}x{d}.bin'))
    queries.tofile(os.path.join(BENCH_DIR, f'queries_{n}x{d}.bin'))

    # Build
    t_build = bench(lambda: KDTree(pts, leafsize=16), samples=5)
    tree = KDTree(pts, leafsize=16)

    # Single kNN
    t_query1 = bench(lambda: tree.query(single_q, k=K), samples=30)
    dists_single, idxs_single = tree.query(single_q, k=K)

    # Batch kNN
    t_query_batch = bench(lambda: tree.query(queries, k=K), samples=10)
    dists_batch, idxs_batch = tree.query(queries, k=K)

    # Ball query
    extent = 100.0
    r_ball = extent * BALL_R_FACTOR
    t_ball1 = bench(lambda: tree.query_ball_point(single_q, r_ball), samples=30)
    ball_single = sorted(int(i) for i in tree.query_ball_point(single_q, r_ball))

    # Pair query (skip for very large n)
    if n <= 10000:
        r_pair = extent * PAIR_R_FACTOR
        t_pairs = bench(lambda: list(tree.query_pairs(r=r_pair)), samples=5)
        pairs = sorted(tuple(sorted(p)) for p in tree.query_pairs(r=r_pair))
        pairs_count = len(pairs)
        # Save just the count + first 20 pairs as smoke check (full list could be huge)
        pairs_sample = [list(p) for p in pairs[:20]]
    else:
        t_pairs = None
        r_pair = None
        pairs_count = None
        pairs_sample = None

    results.append({
        'n': n, 'd': d,
        'build_ms': t_build,
        'query1_ms': t_query1,
        'query_batch_ms': t_query_batch,
        'ball1_ms': t_ball1,
        'pairs_ms': t_pairs,
        'r_ball': r_ball,
        'r_pair': r_pair,
        # Reference results
        'idxs_single': [int(i) for i in idxs_single],
        'dists_single': [float(d) for d in dists_single],
        'idxs_batch_flat': [int(i) for i in idxs_batch.ravel()],
        'dists_batch_flat': [float(d) for d in dists_batch.ravel()],
        'ball_single': ball_single,
        'pairs_count': pairs_count,
        'pairs_sample': pairs_sample,
    })

with open(os.path.join(BENCH_DIR, 'results.json'), 'w') as f:
    json.dump({
        'k': K, 'num_batch': NUM_BATCH, 'cases': results, 'bench_dir': BENCH_DIR,
    }, f)

print(json.dumps({
    'k': K, 'num_batch': NUM_BATCH, 'cases': results, 'bench_dir': BENCH_DIR,
}))
