# adder (Python)

Adder is a Python dialect interpreter written in pure JavaScript. It runs Python syntax directly in auditable cells — no Pyodide, no Wasm, no network fetch. Python values are JS values, so cross-cell reactivity works seamlessly.

Adder targets Python as she is written — the subset of Python that people use day-to-day, implemented faithfully enough that most scripts paste in and run. It is not a CPython reimplementation; it's a purpose-built dialect where the differences are deliberate, documented, and mostly invisible in practice.

---

## Getting Started

Load the adder extension to enable Python cells:

```js
await load("@gcu/adder");
```

After loading, select **adder** from the cell type picker (or press ++n++ to cycle to it). Write Python as usual:

```python
# adder cell
data = [1, 2, 3, 4, 5]
total = sum(data)
mean = total / len(data)
```

Variables defined in adder cells are visible to downstream cells (both JS and other adder cells), just like regular code cells.

!!! tip "Offline use"
    Use `install("@gcu/adder")` instead of `load()` to embed the interpreter in the notebook. Saved copies work offline without a dev server.

---

## Data Model

Python values ARE JavaScript values — there is no FFI boundary:

| Python | JavaScript |
|--------|-----------|
| `int`, `float` | `number` |
| `str` | `string` |
| `bool` | `boolean` |
| `None` | `null` |
| `list`, `tuple` | `Array` |
| `dict` (string keys) | plain `Object` |
| `dict` (non-string keys) | `Map` |
| `set` | `Set` |
| `bytes` | `Uint8Array` |
| `range` | `AdderRange` (lazy, iterable) |

Since there is no FFI, values pass between Python and JS cells without conversion — a list defined in Python is a regular `Array` in downstream JS cells, and vice versa.

!!! tip
    Dicts with all string keys produce plain Objects, so you can use dot access from JS cells: `data.name` instead of `data["name"]`.

---

## Quick Taste

```python
import math
from functools import reduce

# standard Python idioms work
data = [3.2, 1.7, 4.8, 2.1, 5.5]
mean = sum(data) / len(data)
variance = sum((x - mean) ** 2 for x in data) / len(data)
std_dev = math.sqrt(variance)
print(f"mean={mean:.2f}, σ={std_dev:.2f}")
```

```python
# classes with operator overloading
class Vec:
    def __init__(self, x, y):
        self.x, self.y = x, y
    def __add__(self, other):
        return Vec(self.x + other.x, self.y + other.y)
    def __repr__(self):
        return f"Vec({self.x}, {self.y})"

a = Vec(1, 2) + Vec(3, 4)  # Vec(4, 6)
```

```python
# async just works — cells run in async context
import js
response = await js.fetch("https://api.example.com/data")
data = await response.json()
```

---

## Cross-Language Interop

Python functions are regular JS functions. No wrapping, no marshalling:

```python
# adder cell
def analyze(data):
    return sum(data) / len(data)
```

```js
// downstream JS cell
const result = analyze([1, 2, 3, 4, 5]);  // 3
```

JS libraries loaded via `load()` are available through the `js` module:

```python
import js
response = await js.fetch(url)
```

---

## Tagged Template

Use adder as a tagged template in JS cells for inline Python:

```js
const { x, y } = await adder`
x = 42
y = x + 8
`;
// x = 42, y = 50
```

JS values are injected via interpolation:

```js
const scale = 2.5;
const { result } = await adder`
result = ${scale} * 10
`;
// result = 25
```

The `mpy` tag is an alias for `adder`.

!!! warning "Tagged template limitations"
    `print()` inside a tagged template produces no visible output — use adder cells for interactive display. Error locations also lack Python line numbers in template mode.

---

## Directives

Adder cells use `#` instead of `//` for directives:

```python
# %manual
# This cell only runs on Ctrl+Enter
result = expensive_computation()
```

All standard directives work: `# %manual`, `# %norun`, `# %hide`, `# %mcp rw`, etc.

---

## Learn more

- [Language Guide](language.md) — control flow, functions, classes, comprehensions, async, imports
- [Built-in Modules](modules.md) — math, json, random, collections, itertools, os, pathlib, and more
- [CPython Differences](limits.md) — what's different, what's missing, what to watch for

!!! info "Not a replacement for atra"
    Adder is for glue code and scripting. Performance-critical numeric kernels belong in [atra](../extensions-atra.md). Adder can call atra functions seamlessly — that is the point.
