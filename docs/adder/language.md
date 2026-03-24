# Language Guide

This page covers adder's language features in detail with examples. For a quick overview, see the [adder introduction](index.md).

---

## Control Flow

### if / elif / else

```python
if x > 0:
    print("positive")
elif x == 0:
    print("zero")
else:
    print("negative")
```

### for loops

```python
for item in [1, 2, 3]:
    print(item)
```

`for`/`else` works — the `else` block runs if the loop completes without `break`:

```python
for n in candidates:
    if is_prime(n):
        print(f"found: {n}")
        break
else:
    print("no primes found")
```

### while loops

```python
while condition:
    step()
```

!!! info "Loop limits"
    `while` loops are capped at 1,000,000 iterations to prevent page lockup. `for` loops yield to the event loop every 1,000 iterations so the UI stays responsive.

### Exception handling

```python
try:
    result = risky_operation()
except ValueError as e:
    print(f"bad value: {e}")
except (TypeError, KeyError):
    print("type or key error")
else:
    print("no error")
finally:
    cleanup()
```

Exception types form a hierarchy — `except OSError` catches `FileNotFoundError`, `FileExistsError`, `IsADirectoryError`, and other OS-level errors.

### Context managers

```python
with open("data.csv") as f:
    content = f.read()
# f is automatically closed
```

Objects with `__enter__`/`__exit__` methods work as context managers. `async with` is supported for async context managers.

---

## Functions

### def and async def

```python
def greet(name, greeting="hello"):
    return f"{greeting}, {name}"

async def fetch_data(url):
    response = await js.fetch(url)
    return await response.json()
```

Top-level `await` works because cells run in async context — no need for `asyncio.run()`.

### Arguments

```python
def func(a, b, c=10, *args, keyword_only=True, **kwargs):
    pass
```

All argument styles work: positional, defaults, `*args`, keyword-only (after `*`), `**kwargs`.

### Lambdas

```python
squared = lambda x: x ** 2
pairs.sort(key=lambda p: p[1])
```

### Closures

```python
def make_counter(start=0):
    count = start
    def increment():
        nonlocal count
        count += 1
        return count
    return increment

c = make_counter()
c()  # 1
c()  # 2
```

### Decorators

```python
@timer
def slow_function():
    ...
```

Decorators apply innermost-first: `func = decorator(func)`.

---

## Classes

### Definition and inheritance

```python
class Shape:
    def __init__(self, name):
        self.name = name

    def area(self):
        raise NotImplementedError

class Circle(Shape):
    def __init__(self, radius):
        super().__init__("circle")
        self.radius = radius

    def area(self):
        return math.pi * self.radius ** 2

    def __repr__(self):
        return f"Circle(r={self.radius})"
```

Single inheritance via `class Derived(Base)`. Call `super().__init__()` to invoke the parent constructor.

### Operator overloading

```python
class Vec:
    def __init__(self, x, y):
        self.x, self.y = x, y

    def __add__(self, other):
        return Vec(self.x + other.x, self.y + other.y)

    def __mul__(self, scalar):
        return Vec(self.x * scalar, self.y * scalar)

    def __len__(self):
        return 2

    def __getitem__(self, i):
        return [self.x, self.y][i]
```

Supported dunders: `__add__`, `__sub__`, `__mul__`, `__truediv__`, `__floordiv__`, `__mod__`, `__pow__`, `__matmul__`, `__and__`, `__or__`, `__xor__`, `__lshift__`, `__rshift__`, `__neg__`, `__invert__`, `__eq__`, `__ne__`, `__lt__`, `__le__`, `__gt__`, `__ge__`, `__contains__`, `__bool__`, `__len__`, `__getitem__`, `__setitem__`, `__getattr__`, `__repr__`, `__str__`, `__call__`, `__hash__`, `__enter__`, `__exit__`, `__init__`.

Reflected operators (`__radd__`, etc.) are checked when the left operand doesn't handle the operation.

### Properties

```python
class Temperature:
    def __init__(self, celsius):
        self._c = celsius

    @property
    def fahrenheit(self):
        return self._c * 9 / 5 + 32
```

`@property` creates a read-only computed attribute.

---

## Data Structures

### Comprehensions

```python
squares = [x**2 for x in range(10)]
evens = [x for x in data if x % 2 == 0]
pairs = {k: v for k, v in items if v > 0}
unique = {x.lower() for x in words}
```

Nested comprehensions work:

```python
flat = [x for row in matrix for x in row]
```

### Generator expressions

```python
total = sum(x**2 for x in range(1000))
```

Generator expressions are lazy — they don't materialize the full sequence.

### Unpacking

```python
a, b, c = [1, 2, 3]
first, *rest = items
a, (b, c) = [1, [2, 3]]
```

### Slicing

```python
items[1:5]      # elements 1 through 4
items[::2]      # every other element
items[::-1]     # reversed
text[3:]        # from index 3 to end
```

### Walrus operator

```python
if (n := len(data)) > 10:
    print(f"large dataset: {n} items")
```

### F-strings

```python
name = "world"
pi = 3.14159
print(f"hello {name}")
print(f"pi = {pi:.3f}")
print(f"{'centered':^20}")
print(f"{42:08b}")
```

Full format spec support: fill, align, sign, width, grouping, precision, type.

---

## Generators

```python
def fibonacci():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b

fibs = [x for x in fibonacci() if x < 100]
```

`yield from` delegates to another iterable:

```python
def flatten(nested):
    for item in nested:
        if isinstance(item, list):
            yield from flatten(item)
        else:
            yield item
```

!!! note
    Generators produce async iterators internally. They work in `for` loops and comprehensions, but the coroutine protocol (`send`, `throw`, `close`) is not supported.

---

## Imports

### Built-in modules

```python
import math
from collections import Counter
from itertools import chain, islice
import json
```

### VFS modules

When `notebook.fs` is available, you can write Python files to the filesystem and import them:

```python
# write a module
import os
os.makedirs("lib", exist_ok=True)
with open("lib/helpers.py", "w") as f:
    f.write("def double(x): return x * 2\n")

# import it
from lib.helpers import double
double(21)  # 42
```

Module resolution searches `sys.path`: `.` (current directory), `lib`, then VFS root.

### JS interop via js module

```python
import js

# access any browser API
js.console.log("hello from Python")
element = js.document.querySelector("#output")
```

The `js` module is a proxy to `globalThis` — any attribute access resolves to the corresponding JS global.

---

## Scope

Adder follows Python's LEGB scope model:

- **L**ocal — current function
- **E**nclosing — outer function (closures)
- **G**lobal — module level (cell top-level)
- **B**uilt-in — `print`, `len`, `range`, etc.

```python
x = "global"

def outer():
    x = "enclosing"
    def inner():
        nonlocal x
        x = "modified"
    inner()
    print(x)  # "modified"

outer()
print(x)  # "global" (unchanged)
```

Use `global` to write to cell-level scope, `nonlocal` to write to the enclosing function scope.

---

## Async

### async def / await

```python
async def load_all(urls):
    results = []
    for url in urls:
        resp = await js.fetch(url)
        data = await resp.json()
        results.append(data)
    return results
```

### async for / async with

```python
async for chunk in stream:
    process(chunk)

async with connection as conn:
    await conn.execute(query)
```

Top-level `await` works in both adder cells and tagged templates.
