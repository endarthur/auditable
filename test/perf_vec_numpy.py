"""
NumPy reference numbers for test/vec-perf.mjs.

Run separately on the same machine that runs vec-perf.mjs:

    python test/perf_vec_numpy.py

For sizes ≤ 500 (matmul) or ≤ 200 (solve), prefer single-threaded OpenBLAS:

    OPENBLAS_NUM_THREADS=1 python test/perf_vec_numpy.py

OpenBLAS's thread pool spin-up dominates over actual LAPACK work at small N
on multi-core machines (e.g. 24 threads × 200×200 dgesv = 45ms vs 0.2ms
single-threaded — a 230× hit just from thread coordination overhead).
For big matmul (≥500×500), multi-threaded is faster.

Mirrors the JS workloads exactly so the numbers can be compared apples-to-apples.
"""
import time
import numpy as np


def bench(label, runs, fn):
    # Warmup.
    for _ in range(min(3, runs)):
        fn()
    start = time.perf_counter()
    for _ in range(runs):
        fn()
    elapsed = (time.perf_counter() - start) * 1000
    each = elapsed / runs
    print(f"  {label:<40}: {elapsed:.1f}ms total ({each:.4f}ms/run)")
    return each


# ─────────────────────────────────────────────────────────────────────
# Workload 1: vector add (op only, varying size)
# ─────────────────────────────────────────────────────────────────────

for N in [10_000, 100_000, 1_000_000]:
    print(f"\n=== {N:,} vector add (op only) ===")
    a = np.arange(N, dtype=np.float64)
    b = np.arange(N, dtype=np.float64)
    bench("numpy (op only, allocates result)", 1000, lambda: a + b)

# ─────────────────────────────────────────────────────────────────────
# Workload 2: sum reduction (op only)
# ─────────────────────────────────────────────────────────────────────

for N in [10_000, 100_000, 1_000_000]:
    print(f"\n=== sum of {N:,} elements ===")
    a = np.arange(N, dtype=np.float64)
    bench("numpy.sum", 1000, lambda: a.sum())

# ─────────────────────────────────────────────────────────────────────
# Workload 3: dot product
# ─────────────────────────────────────────────────────────────────────

for N in [10_000, 100_000]:
    print(f"\n=== dot product of {N:,} elements ===")
    a = np.arange(N, dtype=np.float64)
    b = np.arange(N, dtype=np.float64)
    bench("numpy.dot", 1000, lambda: np.dot(a, b))

# ─────────────────────────────────────────────────────────────────────
# Workload 4: matrix multiplication
# ─────────────────────────────────────────────────────────────────────

rng = np.random.default_rng(1)
for N in [50, 100, 200, 500]:
    print(f"\n=== {N}×{N} matmul ===")
    A = rng.random((N, N))
    B = rng.random((N, N))
    runs = 200 if N <= 100 else (50 if N <= 200 else 10)
    bench("numpy (BLAS dgemm)", runs, lambda: A @ B)

# ─────────────────────────────────────────────────────────────────────
# Workload 5: linear solve (LU + partial pivoting)
# ─────────────────────────────────────────────────────────────────────

for N in [50, 100, 200]:
    print(f"\n=== {N}×{N} solve(A, b) ===")
    # Diagonally dominant.
    A = rng.random((N, N)) - 0.5
    A += np.eye(N) * (N + 1)
    b = np.arange(N, dtype=np.float64)
    runs = 200 if N <= 100 else 50
    bench("numpy.linalg.solve", runs, lambda: np.linalg.solve(A, b))

# ─────────────────────────────────────────────────────────────────────
# Workload 6: 3×3 symmetric eigen
# ─────────────────────────────────────────────────────────────────────

print(f"\n=== 3×3 symmetric eigendecomposition ===")
sym3 = np.array([[10, 2, 0], [2, 8, 1], [0, 1, 6]], dtype=np.float64)
bench("numpy.linalg.eigh", 10000, lambda: np.linalg.eigh(sym3))

# ─────────────────────────────────────────────────────────────────────
# Workload 7: 20×20 symmetric eigen
# ─────────────────────────────────────────────────────────────────────

print(f"\n=== 20×20 symmetric eigendecomposition ===")
sym20 = rng.random((20, 20)) - 0.5
sym20 = (sym20 + sym20.T) / 2
sym20 += np.eye(20) * 5
bench("numpy.linalg.eigh", 200, lambda: np.linalg.eigh(sym20))
