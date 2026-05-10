"""Numpy reference numbers for matmul + ddot. Single-thread OpenBLAS.

Usage: python test/perf_numpy_compare.py matmul 16,32,64,128,256,512,1024
       python test/perf_numpy_compare.py ddot 128,1024,8192,32768
"""
import os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
import sys
import time
import json
import numpy as np

mode = sys.argv[1]
# Parse sizes lazily — pca uses "NxP" tokens, others use plain integers
sizes_raw = sys.argv[2]

results = {}

if mode != 'pca':
    sizes = [int(s) for s in sizes_raw.split(',')]

if mode == 'matmul':
    for N in sizes:
        A = np.random.rand(N, N).astype(np.float64)
        B = np.random.rand(N, N).astype(np.float64)
        A32 = A.astype(np.float32)
        B32 = B.astype(np.float32)
        for _ in range(3):
            np.dot(A, B); np.dot(A32, B32)
        # Inner repeats: more for small N (where call overhead dominates)
        inner = max(1, min(50, 50_000_000 // (N * N * N + 1)))
        ts = []
        for _ in range(20):
            t0 = time.perf_counter()
            for _ in range(inner): np.dot(A, B)
            ts.append((time.perf_counter() - t0) / inner * 1e6)
        ts.sort()
        results[f'{N}_f64'] = ts[10]
        ts = []
        for _ in range(20):
            t0 = time.perf_counter()
            for _ in range(inner): np.dot(A32, B32)
            ts.append((time.perf_counter() - t0) / inner * 1e6)
        ts.sort()
        results[f'{N}_f32'] = ts[10]

elif mode == 'ddot':
    for n in sizes:
        x = np.random.rand(n).astype(np.float64)
        y = np.random.rand(n).astype(np.float64)
        x32 = x.astype(np.float32)
        y32 = y.astype(np.float32)
        for _ in range(3):
            np.dot(x, y); np.dot(x32, y32)
        inner = max(100, min(10000, 50_000_000 // n))
        ts = []
        for _ in range(20):
            t0 = time.perf_counter()
            for _ in range(inner): np.dot(x, y)
            ts.append((time.perf_counter() - t0) / inner * 1e6)
        ts.sort()
        results[f'{n}_f64'] = ts[10]
        ts = []
        for _ in range(20):
            t0 = time.perf_counter()
            for _ in range(inner): np.dot(x32, y32)
            ts.append((time.perf_counter() - t0) / inner * 1e6)
        ts.sort()
        results[f'{n}_f32'] = ts[10]

elif mode == 'pca':
    # sizes argv is comma-separated "NxP" specs
    cases = [tuple(map(int, s.split('x'))) for s in sizes_raw.split(',')]
    for N, P in cases:
        rng = np.random.default_rng(0)
        X = rng.standard_normal((N, P))
        Xc = X - X.mean(axis=0)
        for _ in range(3): np.linalg.svd(Xc, full_matrices=False)
        inner = max(1, min(10, 50_000_000 // (N * P * P + 1)))
        ts = []
        for _ in range(10):
            t0 = time.perf_counter()
            for _ in range(inner): np.linalg.svd(Xc, full_matrices=False)
            ts.append((time.perf_counter() - t0) / inner * 1000)
        ts.sort()
        results[f'{N}x{P}_svd'] = ts[5]
        def cov_pca():
            C = (Xc.T @ Xc) / (N - 1)
            return np.linalg.eigh(C)
        for _ in range(3): cov_pca()
        ts = []
        for _ in range(10):
            t0 = time.perf_counter()
            for _ in range(inner): cov_pca()
            ts.append((time.perf_counter() - t0) / inner * 1000)
        ts.sort()
        results[f'{N}x{P}_cov'] = ts[5]
    print(json.dumps(results)); sys.exit(0)

elif mode == 'svd':
    for N in sizes:
        # Square N×N. Both numpy.linalg.svd (LAPACK gesdd) and float32 path.
        A = np.random.rand(N, N).astype(np.float64)
        A32 = A.astype(np.float32)
        for _ in range(3):
            np.linalg.svd(A, full_matrices=False)
            np.linalg.svd(A32, full_matrices=False)
        inner = max(1, min(20, 5_000_000 // (N * N * N + 1)))
        ts = []
        for _ in range(15):
            t0 = time.perf_counter()
            for _ in range(inner): np.linalg.svd(A, full_matrices=False)
            ts.append((time.perf_counter() - t0) / inner * 1e6)
        ts.sort()
        results[f'{N}_f64'] = ts[7]
        ts = []
        for _ in range(15):
            t0 = time.perf_counter()
            for _ in range(inner): np.linalg.svd(A32, full_matrices=False)
            ts.append((time.perf_counter() - t0) / inner * 1e6)
        ts.sort()
        results[f'{N}_f32'] = ts[7]

print(json.dumps(results))
