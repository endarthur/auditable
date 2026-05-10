"""
Standalone diagnostic for the slow numpy.linalg.solve numbers.

Tries: longer warmup, more iterations, min vs mean reporting,
scipy.linalg.solve comparison, and OPENBLAS_NUM_THREADS=1 (set the env
var in the shell before running to test that path).
"""
import time
import numpy as np

try:
    import scipy.linalg as sla
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False


def bench(label, fn, runs=500, warmup=20):
    """Returns dict with mean, min, std."""
    for _ in range(warmup):
        fn()
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t0)
    times = np.array(times) * 1000  # to ms
    print(f"  {label:<48}: mean={times.mean():.4f}  min={times.min():.4f}  "
          f"med={np.median(times):.4f}  std={times.std():.4f}  ms/run")
    return times


print(f"NumPy {np.__version__}; scipy={'yes' if HAVE_SCIPY else 'no'}")
print(f"OPENBLAS_NUM_THREADS = {__import__('os').environ.get('OPENBLAS_NUM_THREADS', '(unset)')}")
print()

rng = np.random.default_rng(42)

for N in [50, 100, 200, 500]:
    print(f"=== {N}×{N} solve(A, b) ===")

    A = rng.random((N, N)) - 0.5
    A += np.eye(N) * (N + 1)
    b = np.arange(N, dtype=np.float64)

    bench("numpy.linalg.solve", lambda: np.linalg.solve(A, b))

    if HAVE_SCIPY:
        bench("scipy.linalg.solve (default)",
              lambda: sla.solve(A, b))
        bench("scipy.linalg.solve (overwrite_a=True, overwrite_b=True)",
              lambda: sla.solve(A.copy(), b.copy(),
                                overwrite_a=True, overwrite_b=True))
        # Direct LAPACK dgesv to bypass scipy/numpy wrappers.
        from scipy.linalg.lapack import dgesv
        bench("scipy.linalg.lapack.dgesv (raw)",
              lambda: dgesv(A.copy(), b.copy(), overwrite_a=1, overwrite_b=1))

    print()

# A few more workloads to compare
print("=== 100K vector add ===")
N = 100_000
a = np.arange(N, dtype=np.float64)
b = np.arange(N, dtype=np.float64)
bench("numpy a + b (allocates)", lambda: a + b)
out = np.empty(N)
bench("numpy np.add(a, b, out=out)",
      lambda: np.add(a, b, out=out))

print()
print("=== 100×100 matmul ===")
A = rng.random((100, 100))
B = rng.random((100, 100))
bench("numpy A @ B", lambda: A @ B)
out = np.empty((100, 100))
bench("numpy np.matmul(A, B, out=out)",
      lambda: np.matmul(A, B, out=out))
