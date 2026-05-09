"""Numpy-flavored CPython perf, comparable to natra+adder workloads.

Three variants per workload:
  pure   — list comprehensions, plain loops
  alloc  — np.array() inside the timed region (alloc + op)
  op     — pre-allocated arrays, only the operation timed

Output is one line per measurement: name:total_ms:each_ms
"""
import time
import numpy as np

def bench_pure(name, code, runs):
    for _ in range(min(3, runs)):
        exec(code, {"__name__": "__main__", "np": np})
    start = time.perf_counter()
    for _ in range(runs):
        exec(code, {"__name__": "__main__", "np": np})
    elapsed = (time.perf_counter() - start) * 1000
    each = elapsed / runs
    print(f"{name}:{elapsed:.1f}:{each:.3f}")

def bench_op(name, setup_code, op_code, runs):
    g = {"__name__": "__main__", "np": np}
    exec(setup_code, g)
    for _ in range(min(3, runs)):
        exec(op_code, g)
    start = time.perf_counter()
    for _ in range(runs):
        exec(op_code, g)
    elapsed = (time.perf_counter() - start) * 1000
    each = elapsed / runs
    print(f"{name}:{elapsed:.1f}:{each:.3f}")

# ── 10K vector add ─────────────────────────────────────────────
N1 = 10000

bench_pure("vec_add_10k_pure", f"""
n = {N1}
a = list(range(n))
b = list(range(n))
c = [a[i] + b[i] for i in range(n)]
""", 20)

bench_pure("vec_add_10k_numpy_alloc", f"""
n = {N1}
a = np.arange(n)
b = np.arange(n)
c = a + b
""", 100)

bench_op("vec_add_10k_numpy_op",
    f"""
n = {N1}
a = np.arange(n).astype(np.float64)
b = np.arange(n).astype(np.float64)
""",
    "c = a + b",
    1000)

# ── 100K element sum ───────────────────────────────────────────
N2 = 100_000

bench_pure("sum_100k_pure", f"""
n = {N2}
a = list(range(n))
total = 0
for x in a:
    total = total + x
""", 20)

bench_pure("sum_100k_numpy_alloc", f"""
n = {N2}
a = np.arange(n)
total = a.sum()
""", 100)

bench_op("sum_100k_numpy_op",
    f"""
n = {N2}
a = np.arange(n).astype(np.float64)
""",
    "total = a.sum()",
    1000)

# ── 10K dot product ────────────────────────────────────────────
N3 = 10000

bench_pure("dot_10k_pure", f"""
n = {N3}
a = list(range(n))
b = list(range(n))
s = 0
for i in range(n):
    s = s + a[i] * b[i]
""", 20)

bench_pure("dot_10k_numpy_alloc", f"""
n = {N3}
a = np.arange(n).astype(np.float64)
b = np.arange(n).astype(np.float64)
s = np.dot(a, b)
""", 100)

bench_op("dot_10k_numpy_op",
    f"""
n = {N3}
a = np.arange(n).astype(np.float64)
b = np.arange(n).astype(np.float64)
""",
    "s = np.dot(a, b)",
    1000)
