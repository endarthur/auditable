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
sizes = [int(s) for s in sys.argv[2].split(',')]

results = {}

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
