"""scipy KDTree reference timings. Generates random data, runs queries.

Usage: python test/perf_scipy_kdtree.py
Outputs JSON to stdout. Read by test/scitra-kdtree-bench.mjs.
"""
import os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import sys
import time
import json
import numpy as np
from scipy.spatial import KDTree


def median(times):
    return sorted(times)[len(times) // 2]


def bench(fn, warmup=2, samples=10):
    for _ in range(warmup):
        fn()
    ts = []
    for _ in range(samples):
        t0 = time.perf_counter()
        fn()
        ts.append((time.perf_counter() - t0) * 1000)  # ms
    return median(ts)


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

NUM_BATCH = 100        # batch queries
K = 10
BALL_R_FACTOR = 0.05   # ball radius as fraction of extent
PAIR_R_FACTOR = 0.02

results = []
for case in cases:
    n, d = case['n'], case['d']
    rng = np.random.default_rng(42 + n + d)
    pts = rng.random((n, d), dtype=np.float64) * 100
    queries = rng.random((NUM_BATCH, d), dtype=np.float64) * 100
    single_q = queries[0]

    # Build (median of fresh trees)
    t_build = bench(lambda: KDTree(pts, leafsize=16), samples=5)
    tree = KDTree(pts, leafsize=16)

    t_query1 = bench(lambda: tree.query(single_q, k=K), samples=30)
    t_query_batch = bench(lambda: tree.query(queries, k=K), samples=10)

    extent = 100.0
    r_ball = extent * BALL_R_FACTOR
    t_ball1 = bench(lambda: tree.query_ball_point(single_q, r_ball), samples=30)

    if n <= 10000:
        r_pair = extent * PAIR_R_FACTOR
        t_pairs = bench(lambda: list(tree.query_pairs(r=r_pair)), samples=5)
    else:
        t_pairs = None
        r_pair = None

    results.append({
        'n': n, 'd': d,
        'build_ms': t_build,
        'query1_ms': t_query1,
        'query_batch_ms': t_query_batch,
        'ball1_ms': t_ball1,
        'pairs_ms': t_pairs,
        'r_ball': r_ball,
        'r_pair': r_pair,
    })

print(json.dumps({'k': K, 'num_batch': NUM_BATCH, 'cases': results}))
