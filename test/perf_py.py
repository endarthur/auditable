"""CPython side of the benchmark. Runs each snippet N times with warmup."""
import time, sys

def bench(name, code, runs, setup=""):
    # Warmup
    for _ in range(min(3, runs)):
        exec(code, {"__name__": "__main__"})
    # Measure
    start = time.perf_counter()
    for _ in range(runs):
        exec(code, {"__name__": "__main__"})
    elapsed = (time.perf_counter() - start) * 1000  # ms
    each = elapsed / runs
    print(f"{name}:{elapsed:.1f}:{each:.3f}")

# Snippets (match what the JS benchmark runs)
bench("sum_1_10000", """
total = 0
for i in range(10000):
    total = total + i
""", 20)

bench("fib_25", """
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
fib(25)
""", 5)

bench("list_comp_10000", """
data = [i * 2 for i in range(10000)]
len(data)
""", 20)

bench("nested_100x100", """
total = 0
for i in range(100):
    for j in range(100):
        total = total + i * j
""", 10)

bench("string_concat_5000", """
s = ""
for i in range(5000):
    s = s + "x"
len(s)
""", 10)

bench("fib_memo_30", """
def fib_memo(n, memo):
    if n < 2:
        return n
    if n not in memo:
        memo[n] = fib_memo(n - 1, memo) + fib_memo(n - 2, memo)
    return memo[n]
fib_memo(30, {})
""", 20)
