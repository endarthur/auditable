# Built-in Modules

Adder ships with built-in modules that mirror their CPython equivalents. Most are thin wrappers over JavaScript APIs — faithful enough that standard Python idioms work, but not feature-complete reimplementations.

---

## math

Wrapper over JavaScript's `Math` object plus combinatorial functions.

```python
import math

math.sqrt(2)          # 1.4142135623730951
math.factorial(10)    # 3628800
math.gcd(12, 8)       # 4
math.radians(180)     # 3.141592653589793
```

**Constants:** `pi`, `e`, `tau`, `inf`, `nan`

**Trigonometry:** `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`

**Powers and logarithms:** `sqrt`, `exp`, `log`, `log2`, `log10`, `pow`, `hypot`

**Rounding:** `floor`, `ceil`, `trunc`, `fabs`, `copysign`

**Tests:** `isnan`, `isinf`, `isfinite`

**Conversion:** `radians`, `degrees`

**Combinatorial:** `factorial`, `gcd`, `comb`, `perm`

**Other:** `fsum`, `prod`, `fmod`, `remainder`, `ldexp`, `frexp`, `modf`

---

## json

```python
import json

text = json.dumps({"key": [1, 2, 3]}, indent=2)
data = json.loads(text)
```

`dumps` handles `Map` (→ Object) and `Set` (→ Array) automatically. `loads` delegates to `JSON.parse`.

---

## random

Seeded xoshiro128** PRNG — deterministic when seeded, fast, good statistical properties.

```python
import random

random.seed(42)
random.random()             # [0, 1)
random.randint(1, 6)        # inclusive both ends
random.uniform(0, 1)
random.choice(["a", "b", "c"])
random.shuffle(items)       # in-place
random.sample(population, k=3)
random.gauss(mu=0, sigma=1) # Box-Muller transform
```

---

## collections

```python
from collections import Counter, defaultdict, OrderedDict, namedtuple
```

### Counter

```python
c = Counter("abracadabra")
c.most_common(3)    # [["a", 5], ["b", 2], ["r", 2]]
c.update("xyz")
```

Backed by a plain Object. Supports `most_common(n)` and `update(iterable)`.

### defaultdict

```python
dd = defaultdict(list)
for word in words:
    dd[word[0]].append(word)
```

Backed by a `Map` with a `Proxy` that auto-creates missing keys via the factory function.

### OrderedDict

```python
od = OrderedDict([("a", 1), ("b", 2)])
```

Backed by a JS `Map` (which preserves insertion order natively).

### namedtuple

```python
Point = namedtuple("Point", ["x", "y"])
p = Point(3, 4)
p.x       # 3
p[0]      # 3
```

Returns a factory that produces Objects with named properties and index access.

---

## itertools

```python
from itertools import chain, product, combinations, permutations, islice
```

| Function | Description |
|----------|-------------|
| `chain(*iterables)` | Concatenate iterables |
| `product(*iterables)` | Cartesian product |
| `combinations(iter, r)` | r-length combinations |
| `permutations(iter, r)` | r-length permutations |
| `repeat(value, times)` | Repeat a value |
| `accumulate(iter, func)` | Running accumulation |
| `starmap(func, iter)` | `func(*args)` for each item |
| `islice(iter, start, stop, step)` | Slice an iterable |
| `zip_longest(*iters, fillvalue)` | Zip with fill for short iterables |
| `groupby(iter, key)` | Group consecutive elements |
| `count(start, step)` | Infinite counter |
| `cycle(iter)` | Infinite cycle |
| `pairwise(iter)` | Sliding pairs |

!!! note
    Unlike CPython, itertools functions return materialized lists (not lazy iterators). This is fine for typical notebook use but means you shouldn't call `product` on very large inputs.

---

## functools

```python
from functools import reduce, partial, lru_cache
```

### reduce

```python
total = reduce(lambda a, b: a + b, [1, 2, 3, 4])  # 10
```

### partial

```python
from functools import partial
add10 = partial(lambda a, b: a + b, 10)
add10(5)  # 15
```

### lru_cache

```python
@lru_cache
def fib(n):
    if n <= 1: return n
    return fib(n - 1) + fib(n - 2)

fib(100)
fib.cache_clear()
```

Cache keys are computed via `JSON.stringify(args)`.

---

## re

Regular expressions, delegating to JavaScript's `RegExp` engine.

```python
import re

m = re.match(r"(\d+)-(\d+)", "12-34")
m.group(1)     # "12"
m.groups()     # ["12", "34"]

re.findall(r"\w+", "hello world")   # ["hello", "world"]
re.sub(r"\d+", "N", "abc 123 def")  # "abc N def"
re.split(r"\s+", "a  b  c")         # ["a", "b", "c"]
```

**Functions:** `match`, `search`, `findall`, `sub`, `split`, `compile`, `escape`

**Flags:** `re.IGNORECASE` (`re.I`), `re.MULTILINE` (`re.M`), `re.DOTALL` (`re.S`)

**Match objects:** `.group(n)`, `.groups()`, `.start()`, `.end()`, `.span()`, `.string`

!!! info
    Python regex syntax and JS regex syntax differ in some edge cases (e.g., named groups use `(?P<name>...)` in Python but `(?<name>...)` in JS). Adder passes patterns directly to `RegExp`, so use JS syntax when in doubt.

---

## string

String constants:

```python
import string
string.ascii_lowercase   # "abcdefghijklmnopqrstuvwxyz"
string.ascii_uppercase   # "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
string.ascii_letters     # lowercase + uppercase
string.digits            # "0123456789"
string.hexdigits         # "0123456789abcdefABCDEF"
string.punctuation       # !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
string.whitespace        # space, tab, newline, etc.
```

---

## sys

```python
import sys
sys.version         # "3.12.0 (adder)"
sys.platform        # "auditable"
sys.maxsize         # Number.MAX_SAFE_INTEGER
sys.path            # [".", "lib", "/usr/lib/python"]
sys.modules         # import cache
sys.exit(0)         # raises SystemExit
```

---

## js

Proxy to `globalThis` — access any browser API directly:

```python
import js

# DOM access
el = js.document.querySelector("#output")
js.console.log("debug")

# fetch API
response = await js.fetch("https://api.example.com/data")
data = await response.json()

# any global
js.setTimeout(callback, 1000)
```

Every attribute lookup on `js` resolves to the corresponding property on `globalThis`.

---

## Filesystem Modules

When the notebook's virtual filesystem is available, these modules are created automatically:

### os / os.path

```python
import os

os.listdir(".")
os.mkdir("output")
os.makedirs("a/b/c", exist_ok=True)
os.remove("temp.txt")
os.rename("old.txt", "new.txt")
info = os.stat("data.csv")    # {st_size, st_mtime, st_mode, st_type}

os.path.join("data", "file.csv")
os.path.exists("data.csv")
os.path.splitext("file.txt")   # ["file", ".txt"]
os.path.basename("/a/b/c.txt") # "c.txt"
```

`os.walk(top)` is an async generator — use it in a `for` loop:

```python
for dirpath, dirnames, filenames in os.walk("."):
    for name in filenames:
        print(os.path.join(dirpath, name))
```

### pathlib

```python
from pathlib import Path

p = Path("data") / "output" / "results.csv"
p.name       # "results.csv"
p.stem       # "results"
p.suffix     # ".csv"
p.parent     # Path("data/output")

content = await p.read_text()
await p.write_text("new content")

if await p.exists():
    await p.unlink()

for child in await p.parent.iterdir():
    print(child)
```

Tilde expansion works: `Path("~")` resolves to `/home/nb`.

### shutil

```python
import shutil
shutil.copy("src.txt", "dst.txt")
shutil.copytree("src_dir", "dst_dir")
shutil.rmtree("old_dir")
shutil.move("a.txt", "archive/a.txt")
```

### glob

```python
from glob import glob
csv_files = glob("data/*.csv")
```

### open()

The built-in `open()` function works with VFS:

```python
# text mode (default)
with open("data.csv") as f:
    for line in f:
        print(line)

# binary mode
with open("image.png", "rb") as f:
    data = f.read()

# writing
with open("output.txt", "w") as f:
    f.write("hello\n")
```

Modes: `r`, `w`, `a`, `rb`, `wb`, `ab`. File objects are context managers and support iteration.
