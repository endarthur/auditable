"""CPython: pure Python vs NumPy on typical array operations."""
import time
import numpy as np

def bench(name, fn, runs):
    for _ in range(min(3, runs)):
        fn()
    start = time.perf_counter()
    for _ in range(runs):
        fn()
    elapsed = (time.perf_counter() - start) * 1000
    each = elapsed / runs
    print(f"{name}: {elapsed:.1f}ms total ({each:.3f}ms/run)")
    return each

print("=== 10,000 element vector add ===")

def pure_add():
    n = 10000
    a = list(range(n))
    b = list(range(n))
    c = [a[i] + b[i] for i in range(n)]
    return c[-1]

def numpy_add():
    n = 10000
    a = np.arange(n, dtype=np.float64)
    b = np.arange(n, dtype=np.float64)
    c = a + b
    return c[-1]

def numpy_add_precreated():
    # Exclude allocation from measurement — just the op
    pass  # handled with closure

n = 10000
np_a = np.arange(n, dtype=np.float64)
np_b = np.arange(n, dtype=np.float64)

def numpy_addop_only():
    return (np_a + np_b)[-1]

bench("pure python list", pure_add, 20)
bench("numpy (with alloc)", numpy_add, 50)
bench("numpy (op only)", numpy_addop_only, 100)

print("\n=== sum of 100,000 elements ===")

def pure_sum():
    n = 100000
    a = list(range(n))
    total = 0
    for x in a:
        total += x
    return total

def numpy_sum():
    n = 100000
    a = np.arange(n, dtype=np.float64)
    return a.sum()

np_big = np.arange(100000, dtype=np.float64)
def numpy_sum_op():
    return np_big.sum()

bench("pure python", pure_sum, 20)
bench("numpy (with alloc)", numpy_sum, 100)
bench("numpy (op only)", numpy_sum_op, 200)

print("\n=== dot product of 10,000 elements ===")

def pure_dot():
    n = 10000
    a = list(range(n))
    b = list(range(n))
    return sum(a[i] * b[i] for i in range(n))

def numpy_dot():
    n = 10000
    a = np.arange(n, dtype=np.float64)
    b = np.arange(n, dtype=np.float64)
    return np.dot(a, b)

def numpy_dot_op():
    return np.dot(np_a, np_b)

bench("pure python", pure_dot, 20)
bench("numpy (with alloc)", numpy_dot, 100)
bench("numpy (op only)", numpy_dot_op, 200)
