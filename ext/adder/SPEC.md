# adder v2 — language specification

**A Python interpreter in JavaScript for auditable.**

Pure JS tree-walking interpreter — Python values ARE JS values. No FFI boundary, no marshalling, no WASM. Calling GSLIB, atra, or any JS function is just calling a function.

Package: `@gcu/adder`

---

## 1. Architecture

```
ext/adder/
  index.js           — BUILD OUTPUT (bundled from src/)
  build.js           — concatenates src/ modules into index.js
  src/
    parse.js         — tokenizer + recursive-descent parser → AST (1055 lines)
    eval.js          — tree-walking evaluator, AdderScope (1178 lines)
    builtins.js      — built-in functions, modules, format specs, VFS (1394 lines)
    cell.js          — pythonParseNames, pythonFindUses, pythonExecute (267 lines)
    highlight.js     — tokenizePython, pythonCompletions (179 lines)
    tag.js           — adder/mpy tagged template (59 lines)
    register.js      — cell type + tagged language registration (78 lines)
    main.js          — entry point (8 lines)
```

No `micropython.mjs`, no `micropython.wasm`, no `bridge.js`, no `init.js`. The entire interpreter is pure JavaScript — no binary dependencies.

---

## 2. Data model — Python values are JS values

| Python | JS representation | Notes |
|--------|------------------|-------|
| `int` | `number` | No BigInt. |
| `float` | `number` | Same IEEE 754 double as JS. |
| `bool` | `boolean` | `True` → `true`, `False` → `false` |
| `None` | `null` | |
| `str` | `string` | |
| `list` | `Array` | `append` → `push`, `len()` → `.length` |
| `tuple` | `Array` | No enforcement of immutability. |
| `dict` | plain `Object` (string keys) or `Map` (non-string keys) | See below. |
| `set` | `Set` | |
| `bytes` | `Uint8Array` | |
| `function` | `function` | Closures work naturally. |
| `class instance` | plain `Object` with `__adderClass__` | Prototype-based dispatch. |
| `range` | `AdderRange` | Iterable, has `.length`, `.includes()`. |

### Dict representation

Dict literals with all string keys produce a plain `Object`. Dict literals with any non-string key produce a `Map`. This maximizes JS interop — downstream JS cells can use dot access on Python dicts:

```python
# Python cell
config = {"host": "localhost", "port": 8080}
```
```js
// JS cell — config is a plain Object
display(config.host)  // works, no proxy
```

`Map` dicts (non-string keys) have full `keys()`, `values()`, `items()`, `get()`, `pop()`, `setdefault()`, `update()`, `clear()`, `copy()` methods. Plain `Object` dicts also expose these same methods via `_objDictMethods` dispatch.

### No FFI boundary

There is no "JS side" and "Python side." The interpreter evaluates Python AST nodes by performing JS operations. A Python function call `f(x, y)` is a JS function call. `await fetch(url)` is `await fetch(url)`. Variables are JS values stored in an `AdderScope` chain.

This means:
- Calling GSLIB: `result = kb2d({"data": samples, "grid": {...}})` — direct JS call
- Calling atra: `wasm = atra({"memory": mem}); result = wasm.function(args)` — direct
- Async: `response = await fetch(url)` — JS await, no Asyncify
- Callbacks: Python functions passed to JS code work as regular JS callbacks

---

## 3. Language

### 3.1 Expressions

**Arithmetic:** `+`, `-`, `*`, `/`, `//`, `%`, `**`, unary `-`, `+`, `~`

**Comparison:** `==`, `!=`, `<`, `>`, `<=`, `>=`

**Chained comparison:** `a < b < c` — single comparisons return dunder results directly (e.g. a BooleanMask from a custom `__gt__`), chained comparisons coerce to boolean.

**Logical:** `and`, `or`, `not` — short-circuit, return the determining value (not necessarily `True`/`False`).

**Bitwise:** `&`, `|`, `^`, `~`, `<<`, `>>`

**Conditional:** `x if cond else y`

**Membership:** `in`, `not in`

**Identity:** `is`, `is not`

**Walrus operator:** `:=` (named expression) — assigns and returns the value.

**String multiplication:** `"ab" * 3` → `"ababab"`. List repetition: `[0] * 5`.

**String `%` formatting:** `"hello %s" % name` — basic `%s`, `%d`, `%f`, `%e`, `%g`, `%x` format codes.

### 3.2 Assignment

- Simple: `x = expr`
- Augmented: `+=`, `-=`, `*=`, `/=`, `//=`, `%=`, `**=`, `&=`, `|=`, `^=`, `<<=`, `>>=`, `@=`
- Multiple targets: `a = b = expr` (chained)
- Tuple unpacking: `a, b = 1, 2`
- Starred unpacking: `a, *b = [1, 2, 3, 4]`
- Annotated: `x: int = 5` (annotation parsed and preserved in AST, ignored at runtime)
- Delete: `del x`, `del obj.attr`, `del lst[i]`

### 3.3 Control flow

- `if` / `elif` / `else`
- `for` / `else` — `for/else` runs else block if loop completes without `break`
- `while` / `else` — same semantics. Hard limit: 1,000,000 iterations.
- `break`, `continue`, `pass`
- `return`
- `try` / `except` / `else` / `finally` — except can catch by type, with `as` binding
- `raise` — raises `AdderError` or re-raises
- `with` / `as` — context managers via `__enter__`/`__exit__` (or `enter`/`exit`)
- `assert test, msg`
- `async for`, `async with`

### 3.4 Functions

- `def` with positional, keyword, default arguments
- `*args`, `**kwargs`
- Keyword-only parameters (after `*` or `*args`)
- `lambda` with positional, `*args`, `**kwargs`
- Closures (captured via scope chain)
- `async def` / `await` — produces async JS functions. Top-level `await` works because cells run in async context.
- Docstrings — first string expression stored as `__doc__`, not executed.
- Return type annotations (`-> type`) — parsed, preserved in AST, ignored at runtime.

### 3.5 Generators

Generator functions (containing `yield` or `yield from`) are detected via AST scanning (`_hasYield`). They produce async generator objects:

- `yield value` — yields a value to the consumer
- `yield from iterable` — delegates to another iterable (sync or async)
- Generator objects implement `Symbol.asyncIterator` and are consumed via `for await` loops or by materializing with `list()`, `sorted()`, etc.
- Generator expressions: `(x**2 for x in range(10))` — lazy, async-iterable

The evaluator walks generator bodies statement-by-statement via `_evalGenStmt`, yielding from yield expressions encountered during execution. Control flow (`for`, `while`, `if`, `try`) inside generators works correctly.

### 3.6 Decorators

`@decorator` syntax on both functions and classes. User-defined decorators work — `@dec def fn(): ...` is `fn = dec(fn)`. Multiple decorators are applied innermost-first. Decorator expressions can be dotted names or arbitrary expressions.

Built-in support for `@property` (creates getter on prototype via `Object.defineProperty`; setter not supported). `@staticmethod` and `@classmethod` are not built-in but can be implemented as user-defined decorators.

### 3.7 Classes

```python
class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def distance(self, other):
        return math.sqrt((self.x - other.x)**2 + (self.y - other.y)**2)

    def __repr__(self):
        return f"Point({self.x}, {self.y})"
```

**Internal representation:** the evaluator creates a constructor function. Class body is evaluated in a class scope. Methods are bound to the prototype with automatic `self` injection — `cls.prototype.method = function(...args) { return originalFn(this, ...args) }`.

**Class variables:** non-function values from the class body are copied to each instance at construction time.

**Single inheritance:** `class Derived(Base):` — prototype chain via `Object.create(Base.prototype)`. `super()` resolves to the parent class; `super().__init__(...)` calls the parent constructor.

**Operator overloading via dunder methods:**

| Dunder | Operator |
|--------|----------|
| `__add__` | `+` |
| `__sub__` | `-` |
| `__mul__` | `*` |
| `__truediv__` | `/` |
| `__floordiv__` | `//` |
| `__mod__` | `%` |
| `__pow__` | `**` |
| `__and__` | `&` |
| `__or__` | `\|` |
| `__xor__` | `^` |
| `__lshift__` | `<<` |
| `__rshift__` | `>>` |
| `__matmul__` | `@` |
| `__neg__` | unary `-` |
| `__invert__` | `~` |
| `__eq__` | `==` |
| `__ne__` | `!=` |
| `__lt__` | `<` |
| `__le__` | `<=` |
| `__gt__` | `>` |
| `__ge__` | `>=` |
| `__contains__` | `in` |
| `__bool__` | truthiness |
| `__len__` | `len()` |
| `__getitem__` | `obj[key]` |
| `__setitem__` | `obj[key] = value` |
| `__getattr__` | fallback attribute access |
| `__repr__` | `repr()` |
| `__str__` | `str()` |
| `__call__` | `obj()` |
| `__init__` | constructor |
| `__enter__`, `__exit__` | `with` statement |
| `__hash__` | `hash()` |

The evaluator checks for dunder methods on the left operand before falling back to JS operators.

**Interop:** class instances are plain JS objects — downstream JS cells access properties with dot notation, no proxy needed.

### 3.8 Data structures

- **List literals:** `[1, 2, 3]`
- **List comprehensions:** `[x**2 for x in range(10) if x % 2 == 0]` — nested generators supported
- **Dict literals:** `{"a": 1, "b": 2}` — dict unpacking with `**other`
- **Dict comprehensions:** `{k: v for k, v in items}`
- **Set literals:** `{1, 2, 3}`
- **Set comprehensions:** `{x**2 for x in range(10)}`
- **Tuple literals:** `(1, 2, 3)` — comma is the tuple operator, parens are grouping
- **Starred unpacking** in literals: `[*a, *b]`, `{**d1, **d2}`
- **Slicing:** `x[1:3]`, `x[::2]`, `x[::-1]` — works on strings, lists, bytes. Negative indices supported.
- **Ellipsis:** `...` — parsed as `Constant(null)`

### 3.9 Strings

- Single/double/triple-quoted
- f-strings: `f"result: {x:.3f}"` — with format specs, conversions (`!r`, `!s`, `!a`), nested braces
- Raw strings: `r"no\escape"`
- Byte strings: `b"bytes"` → not specially handled at parse level (b prefix consumed but result is a regular string token; `bytes()` conversion is explicit)
- String concatenation of adjacent literals: `"hello" " " "world"` → `"hello world"`
- Escape sequences: `\n`, `\t`, `\r`, `\\`, `\'`, `\"`, `\0`, `\a`, `\b`, `\f`, `\v`, `\xNN`, `\uNNNN`, `\UNNNNNNNN`, octal `\NNN`
- `.format()` method with positional and named fields
- `%` formatting: `"hello %s" % name`

### 3.10 Imports

- `import math`
- `from math import sqrt, sin`
- `import json as j`
- `from module import *`
- Relative imports: `from . import foo`, `from ..mod import bar`
- Dotted module names: `import os.path`

Module resolution order:
1. Built-in `adderModules` table
2. `window._auditableExtensions` (auditable plugin modules)
3. VFS import — searches `sys.path` for `name.py` or `name/__init__.py`

VFS imports parse and evaluate the module source in a fresh scope, caching the result in `sys.modules` to handle circular imports.

### 3.11 Scope model — LEGB

Python's LEGB rule (Local → Enclosing → Global → Built-in) implemented via `AdderScope` chain:

```js
class AdderScope {
  vars: Map        // local variables
  parent: AdderScope | null  // enclosing scope
  globals: Set     // names declared `global`
  nonlocals: Set   // names declared `nonlocal`
}
```

- `scope.get(name)` — walks the chain: check globals set → check nonlocals set → check local vars → recurse to parent
- `scope.set(name, value)` — respects `global` (writes to root scope) and `nonlocal` (writes to nearest enclosing scope that has the name)
- Function calls create a new `AdderScope` with the enclosing scope as parent
- Class bodies execute in a class scope (separate from the enclosing scope)
- Comprehensions execute in their own scope

### 3.12 Semantic differences from CPython

**Integer division:** `//` uses `Math.floor(a/b)` — floors toward negative infinity, matching Python semantics.

**Modulo:** `%` uses `((a % b) + b) % b` — result has sign of divisor, matching Python semantics.

**Truthiness:** Python truthiness rules — `0`, `0.0`, `""`, `[]`, `{}`, `set()`, `None`, `False`, `NaN` are falsy. Empty `Array` is falsy (unlike JS). Empty `Map`/`Set` is falsy. Checks `__bool__()` then `__len__()` dunders.

**Equality:** `==` on lists does deep structural comparison. `is` does identity comparison (`===`).

**`in` on dicts:** checks keys (via `key in obj` for plain Objects, `map.has(key)` for Maps).

**Loop limits:** `while` loops are capped at 1,000,000 iterations. `for` loops yield to the event loop every 1,000 iterations to prevent page lockup.

---

## 4. AST node types

The parser produces the following AST nodes. Every node has `line` and `col` fields for error reporting.

### Statements

```
Module(body)
FunctionDef(name, params, vararg, kwonly, kwarg, body, decorators, returns)
AsyncFunctionDef(name, params, vararg, kwonly, kwarg, body, decorators, returns)
ClassDef(name, bases, body, decorators)
Return(value)
Assign(targets, value)
AugAssign(target, op, value)
AnnAssign(target, annotation, value)
Delete(targets)
For(target, iter, body, orelse, isAsync)
While(test, body, orelse)
If(test, body, orelse)
With(items[{contextExpr, optionalVar}], body, isAsync)
Try(body, handlers[ExceptHandler], orelse, finalbody)
ExceptHandler(excType, name, body)
Raise(exc)
Assert(test, msg)
Import(names[{module, alias}])
ImportFrom(module, names[{name, alias}])
Global(names)
Nonlocal(names)
Expr(value)
Pass
Break
Continue
```

### Expressions

```
BinOp(left, op, right)
UnaryOp(op, operand)              — op: '-', '+', '~', 'not'
BoolOp(op, values)                — op: 'and', 'or'
Compare(left, ops, comparators)   — ops: '==', '!=', '<', '>', '<=', '>=', 'in', 'not in', 'is', 'is not'
IfExp(test, body, orelse)         — ternary: body if test else orelse
NamedExpr(target, value)          — walrus: target := value
Call(func, args, keywords[{name, value}])
Attribute(value, attr)
Subscript(value, slice)
Slice(lower, upper, step)
Name(id)
Constant(value)
List(elts)
Tuple(elts)
Dict(keys, values)                — keys[i] is null for **unpack entries
Set(elts)
ListComp(elt, generators)
SetComp(elt, generators)
DictComp(key, value, generators)
GeneratorExp(elt, generators)
JoinedStr(values)                 — f-string
FormattedValue(value, conversion, formatSpec)
Lambda(params, vararg, kwarg, body)
Starred(value)
Await(value)
Yield(value)
YieldFrom(value)
```

Comprehension generators: `{target, iter, ifs, isAsync}`.

---

## 5. Built-in functions

```python
print(*args, sep=" ", end="\n")     # renders to cell output via display()
len(x)                              # .length, .size, __len__(), or Object.keys().length
range(stop) / range(start, stop, step)  # AdderRange (lazy iterable)
enumerate(iterable, start=0)
zip(*iterables)
map(fn, *iterables)
filter(fn, iterable)
sorted(iterable, key=None, reverse=False)
reversed(iterable)
min(*args, key=None) / max(*args, key=None)
sum(iterable, start=0)
any(iterable) / all(iterable)
abs(x) / round(x, n=0) / pow(x, y, mod=None)
divmod(a, b)                        # returns [floor_div, py_mod]
int(x, base=10) / float(x) / str(x) / bool(x)
list(x) / tuple(x) / dict(x) / set(x)
type(x)                             # returns type name string
isinstance(x, t)                    # checks pyTypeName or instanceof
issubclass(c, t)                    # stub, returns False
hasattr(obj, name) / getattr(obj, name, default) / setattr(obj, name, value) / delattr(obj, name)
id(x)                               # sequential counter on objects
hash(x)                             # number identity, string hash, or 0
callable(x)
chr(n) / ord(c)
hex(n) / oct(n) / bin(n)
repr(x) / format(value, spec)
iter(x) / next(iter, default)
property(fget)                      # creates {__property__: true, fget}
object() / super()
vars(obj) / dir(obj)
open(path, mode)                    # VFS file object (see VFS section)
input()                             # raises NotImplementedError
```

### Exception constructors

These are functions (not classes) that return `AdderError` instances with the appropriate `pyType`:

```
ValueError, TypeError, KeyError, IndexError, AttributeError, RuntimeError,
StopIteration, ZeroDivisionError, NotImplementedError, AssertionError,
Exception, FileNotFoundError, FileExistsError, IsADirectoryError,
NotADirectoryError, PermissionError, OSError, IOError
```

Exception matching in `except` clauses walks the `_excParents` hierarchy — e.g. `except OSError` catches `FileNotFoundError`.

---

## 6. Format specification

f-strings and `format()` support Python-style format specs:

```
[[fill]align][sign][z][#][0][width][grouping_option][.precision][type]
```

**Align:** `<` (left), `>` (right), `^` (center), `=` (pad after sign)

**Sign:** `+` (always show), `-` (default, only negatives)

**Grouping:** `,` or `_` (thousands separator)

**Types:**
| Code | Meaning |
|------|---------|
| `d` | Integer |
| `f`, `F` | Fixed-point float (default precision 6) |
| `e`, `E` | Scientific notation |
| `g`, `G` | General float |
| `%` | Percentage (multiply by 100, append `%`) |
| `b` | Binary |
| `o` | Octal |
| `x`, `X` | Hexadecimal |
| `c` | Character (fromCodePoint) |
| `s` | String |
| `n` | Locale-aware number |

Default alignment: `<` for strings, `>` for numbers. Zero-padding (`0`) sets fill to `'0'` and align to `=`.

---

## 7. Method dispatch

Attribute access on Python values dispatches to type-specific method tables.

### String methods

```
upper, lower, strip, lstrip, rstrip, split, rsplit, join, replace, find, rfind,
index, rindex, count, startswith, endswith, format, encode, capitalize, title,
swapcase, isdigit, isalpha, isalnum, isspace, isupper, islower, zfill, ljust,
rjust, center, expandtabs, partition, rpartition, removeprefix, removesuffix,
splitlines
```

### List methods

```
append, extend, insert, remove, pop, clear, index, count, sort, reverse, copy
```

`sort(key=None, reverse=False)` uses stable sort with key function support.

### Dict methods (Map and plain Object)

```
keys, values, items, get, pop, setdefault, update, clear, copy
```

### Set methods

```
add, remove, discard, pop, clear, union, intersection, difference,
symmetric_difference, update, issubset, issuperset, copy
```

### Range attributes

```
start, stop, step
```

### Object attribute resolution

For objects with `__adderClass__`:
1. Check if attribute is a function on the object — bind `self` for adder functions
2. Check `_objDictMethods` (keys, values, items, get, pop, etc.)
3. Check regular property access (`attr in obj`)
4. Check `__getattr__` dunder
5. Raise `AttributeError`

---

## 8. Modules

### 8.1 Core modules

All modules are registered in the `adderModules` export.

**`math`** — thin wrapper over JS `Math`:

```
pi, e, tau, inf, nan
sin, cos, tan, asin, acos, atan, atan2
sinh, cosh, tanh, asinh, acosh, atanh
sqrt, exp, log, log2, log10, pow, hypot
floor, ceil, trunc, fabs, copysign
isnan, isinf, isfinite
radians, degrees
factorial, gcd, comb, perm
fsum, prod, fmod, remainder, ldexp, frexp, modf
```

**`json`**:

```python
json.dumps(obj, indent=None)    # Map → Object, Set → Array via replacer
json.loads(s)                   # JSON.parse
```

**`random`** — seeded PRNG (xoshiro128**):

```python
random.random()
random.seed(n)
random.randint(a, b)            # inclusive on both ends
random.uniform(a, b)
random.choice(seq)
random.shuffle(lst)             # in-place
random.gauss(mu, sigma)         # Box-Muller transform
random.sample(population, k)
```

**`js`** — `Proxy` over `globalThis`:

```python
import js
response = await js.fetch("https://...")
js.console.log("hello")
```

Any attribute access on `js` forwards to the corresponding `globalThis` property.

**`itertools`**:

```python
itertools.chain(*iterables)
itertools.product(*iterables)
itertools.combinations(iterable, r)
itertools.permutations(iterable, r=None)
itertools.repeat(value, times=None)     # capped at 1000 if times not given
itertools.accumulate(iterable, func=None)
itertools.starmap(func, iterable)
itertools.islice(iterable, stop) / islice(iterable, start, stop, step=1)
itertools.zip_longest(*iterables, fillvalue=None)
itertools.groupby(iterable, key=None)
```

All return materialized lists (not lazy iterators).

**`functools`**:

```python
functools.reduce(fn, iterable, initial=None)
functools.partial(fn, *args)
functools.lru_cache(fn)           # JSON.stringify key, cache_clear() method
```

**`collections`**:

```python
collections.OrderedDict(items)    # Map (insertion-ordered)
collections.defaultdict(factory, items)  # Proxy over Map with auto-vivification
collections.Counter(iterable)     # plain Object with most_common(n), update()
collections.namedtuple(name, fields)  # factory returning plain Objects with __adderClass__
```

**`re`** — thin wrapper over JS `RegExp`:

```python
re.match(pattern, string)      # returns match object or None
re.search(pattern, string)
re.findall(pattern, string)
re.sub(pattern, repl, string, count=None)
re.split(pattern, string, maxsplit=None)
re.compile(pattern)            # returns compiled pattern with match/search/findall/sub/split
re.escape(s)
re.IGNORECASE, re.I            # = 'i'
re.MULTILINE, re.M             # = 'm'
re.DOTALL, re.S                # = 's'
```

Match objects: `group(n)`, `groups()`, `start()`, `end()`, `span()`, `string`.

**`string`**:

```
string.ascii_lowercase, string.ascii_uppercase, string.ascii_letters
string.digits, string.hexdigits, string.octdigits
string.punctuation, string.whitespace
```

**`this`** — contains the Zen of Python (`this.s`) and the GCU charter (`this.gcu`). `import this` prints the Zen as a side effect.

**`sys`**:

```python
sys.version           # '3.12.0 (adder)'
sys.version_info      # [3, 12, 0, 'adder', 0]
sys.platform          # 'auditable'
sys.maxsize           # Number.MAX_SAFE_INTEGER
sys.path              # ['.', 'lib', '/usr/lib/python']
sys.modules           # cache of imported VFS modules
sys.argv              # ['']
sys.exit(code=0)      # raises SystemExit
sys.stdout / stderr   # write() and flush() stubs
sys.getsizeof()       # returns 0
sys.getrecursionlimit() / setrecursionlimit()
sys.executable / prefix / exec_prefix / home
```

### 8.2 Filesystem modules (VFS-backed)

Created lazily by `_ensureFsModules()` when a VFS instance and path utilities are available. All filesystem operations are async.

**`os`**:

```python
os.sep                # '/'
os.linesep            # '\n'
os.name               # 'posix'
os.listdir(path='.')
os.mkdir(path)
os.makedirs(path, exist_ok=False)
os.remove(path) / os.unlink(path)
os.rmdir(path)
os.rename(src, dst)
os.stat(path)         # returns {st_size, st_mtime, st_mode, st_type}
os.getcwd()
os.chdir(path)
os.walk(top)          # async generator yielding (dirpath, dirnames, filenames)
```

**`os.path`**:

```python
os.path.join(*parts)
os.path.dirname(p)
os.path.basename(p)
os.path.splitext(p)   # returns [root, ext]
os.path.normpath(p)
os.path.relpath(p, start=None)
os.path.isabs(p)
os.path.exists(p)     # async
os.path.isfile(p)     # async
os.path.isdir(p)      # async
os.path.getsize(p)    # async
os.path.sep           # '/'
```

**`pathlib`**:

```python
from pathlib import Path

p = Path("/data/file.txt")
p.name                # 'file.txt'
p.stem                # 'file'
p.suffix              # '.txt'
p.parent              # Path('/data')
p.parts               # ['/', 'data', 'file.txt']

p / "subdir"          # __truediv__ → Path join
p.joinpath("a", "b")
p.with_suffix(".csv")
p.with_name("other.txt")

await p.read_text()
await p.read_bytes()
await p.write_text(data)
await p.write_bytes(data)
await p.exists()
await p.is_file()
await p.is_dir()
await p.mkdir(parents=False, exist_ok=False)
await p.unlink()
await p.rename(target)
await p.iterdir()     # returns list of Paths
await p.glob(pattern)
await p.touch()
await p.stat()
```

Path objects have `__truediv__`, `__str__`, `__repr__`, `__eq__`, `__hash__` dunders. `__adderClass__` is `'PosixPath'`.

Tilde expansion: `Path("~")` → `/home/nb`, `Path("~/data")` → `/home/nb/data`.

**`shutil`**:

```python
shutil.copy(src, dst)
shutil.copy2(src, dst)
shutil.copytree(src, dst)
shutil.rmtree(path)
shutil.move(src, dst)
```

**`glob`**:

```python
glob.glob(pattern)    # delegates to vfs.glob()
```

### 8.3 VFS integration

The adder interpreter can optionally use a Virtual Filesystem (VFS) for file I/O and module imports. The VFS is wired via `setAdderVFS(vfsInstance, pathUtils)`:

- `pythonExecute` auto-detects `window._notebookVFS` and wires it on first execution
- `_ensureFsModules()` creates the os/pathlib/shutil/glob modules lazily
- `setAdderVFS()` resets the working directory to `/home/nb` and clears the module cache
- VFS errors are mapped to Python exception types via `_mapVFSError()` (ENOENT → FileNotFoundError, etc.)

**File objects** (returned by `open()`):

```python
f = open("data.txt", "r")    # modes: r, w, a, rb, wb, ab
f.read(size=None)
f.readline()
f.readlines()
f.write(data)
f.writelines(lines)
f.close()                    # async — flushes writes to VFS
f.name                       # file path
f.closed                     # boolean

# context manager
with open("data.txt") as f:
    content = f.read()
```

Binary mode (`rb`, `wb`, `ab`) reads/writes `Uint8Array`. Text mode reads/writes strings.

**VFS module imports:** `import mymodule` searches `sys.path` for `mymodule.py` or `mymodule/__init__.py`, parses the source with adder's parser, evaluates in a fresh scope with builtins, and caches the result in `sys.modules`.

---

## 9. Error reporting

Errors include Python source line numbers. AST nodes store their source location (`line`, `col`). The evaluator wraps errors with location info:

```
AdderError {
  pyType: string    — 'NameError', 'TypeError', 'ValueError', etc.
  pyMessage: string — human-readable message
  adderLine: number — source line number
  message: string   — "pyType: pyMessage (line N)"
}
```

Exception hierarchy for `except` matching uses `_excParents`:
```
FileNotFoundError → OSError
FileExistsError → OSError
IsADirectoryError → OSError
NotADirectoryError → OSError
PermissionError → OSError
IOError → OSError
```

---

## 10. Integration with auditable

### 10.1 Cell executor

`pythonExecute(code, scopeIn, cell)` — the DAG-facing API:

1. Parses code to AST
2. Creates scope: builtins → upstream scope variables → cell context (ui, std, load, etc.)
3. Walks the AST via `adderEval`
4. Extracts top-level defines (names from `pythonParseNames`) from the scope
5. Returns `{ defines, output? }`

When a cell context (`cell._ctx`) is available, `print()` renders directly to the cell's output DOM via `ctx.display()`, and the last expression value is also displayed. Without a cell context (test/standalone mode), output is returned as a string.

Cell builtins exposed to Python: `ui`, `std`, `load`, `install`, `installBinary`, `display`, `invalidation`, `worker`, `workerPool`, `notebook`, `vfs`.

### 10.2 DAG integration

**`pythonParseNames(code)`** — extracts module-scope defines:
- Parses with `adderParse`, walks AST collecting assignment targets
- Descends into `with`/`for`/`if`/`try`/`while` (no new scope in Python)
- Stops at `def`/`class` (new scope — only the name itself is defined)
- Falls back to regex for unparseable code

**`pythonFindUses(code, allDefined)`** — finds cross-cell references:
- Parses with `adderParse`, walks AST for `Name` nodes
- Checks each name against `allDefined` set, excluding self-defines
- Falls back to regex scan for unparseable code

### 10.3 Syntax checking

`syntaxCheck(code)` — parses with `adderParse`, returns `true` if no `SyntaxError`. Used for live error indicators in the editor.

### 10.4 Tagged template

```js
const { x, y } = await adder`
x = 42
y = x + 8
`
```

The `adder` tag (and `mpy` alias):
1. Concatenates template strings with `_v0`, `_v1`, ... placeholders for interpolated values
2. Auto-dedents the code (strips common leading whitespace)
3. Parses and evaluates in a fresh scope with builtins + injected values
4. Returns a plain JS object with all non-underscore-prefixed names

Values are already JS values — no marshalling.

### 10.5 Registration

The module registers:
- Cell type `'adder'` via `registerCellType` (label: "adder", color: #4B8BBE, shortcut: `n`)
- Tagged languages `'adder'` and `'mpy'` in `window._taggedLanguages`
- Plugin `'@gcu/adder'` via `registerPlugin`
- Global tags `window.adder` and `window.mpy`

Guard: registration only happens once even if the module is re-imported from different blob URLs.

---

## 11. Tokenizer

The tokenizer (`adderTokenize`) produces a flat token stream with INDENT/DEDENT tokens for Python's significant whitespace.

### Token types

| Type | Meaning |
|------|---------|
| `NAME` | Identifier or keyword |
| `NUMBER` | Integer or float literal (value already parsed) |
| `STRING` | String literal (escapes already processed) |
| `FSTRING` | f-string (array of text strings and `{expr, spec, conv}` objects) |
| `OP` | Operator or punctuation |
| `NEWLINE` | Logical line terminator (suppressed inside brackets) |
| `INDENT` | Indentation increase |
| `DEDENT` | Indentation decrease |
| `EOF` | End of file |

### Indentation handling

- Tracks bracket depth — newlines inside `()`, `[]`, `{}` are suppressed
- Tracks indent stack — emits INDENT when indent increases, DEDENT(s) when it decreases
- Blank and comment-only lines are skipped in indentation tracking
- Tabs expand to the next multiple of 4 spaces
- Line continuations (`\` at end of line) are handled

### Number literals

Supports: decimal, hex (`0x`), octal (`0o`), binary (`0b`), float, scientific notation (`1e10`), complex suffix (`j`/`J`, treated as float), underscore separators (`1_000_000`).

### String prefixes

`f`, `r`, `b`, `u` and combinations (case-insensitive). If a prefix sequence is not followed by a quote, it's treated as an identifier.

### Operators

Single-character: `+`, `-`, `*`, `/`, `%`, `&`, `|`, `^`, `~`, `<`, `>`, `=`, `.`, `,`, `:`, `;`, `@`, `(`, `)`, `[`, `]`, `{`, `}`

Two-character: `**`, `//`, `<<`, `>>`, `<=`, `>=`, `==`, `!=`, `->`, `:=`, `+=`, `-=`, `*=`, `/=`, `%=`, `&=`, `|=`, `^=`, `@=`

Three-character: `**=`, `//=`, `<<=`, `>>=`

Ellipsis: `...`

---

## 12. Multiple backends from one AST

The parser produces an AST with type annotations preserved. The evaluator ignores annotations, but typed backends consume them. This makes adder's AST a universal intermediate form:

```
adder parser (shared)
    ↓ AST with annotations
    ├─→ eval       — tree-walking JS interpreter (untyped, default)
    ├─→ transpile  — emit JS source (untyped, fast)
    ├─→ patra      — emit atra → WASM (typed, @kernel)
    └─→ wgsl       — emit WebGPU compute shaders (typed, @gpu, future)
```

Each backend is selected by a decorator: no decorator = eval/transpile, `@kernel` = patra, `@gpu` = WGSL. The user writes Python, the decorator picks the target. Same syntax, same parser, same AST, different codegen.

Annotations are parsed and preserved even though the eval backend doesn't use them — they're the type information that compiled backends need. Adding a new backend is adding a new AST walker, not a new language.

### 12.1 Eval mode (shipped)

Tree-walking interpreter. Each AST node type has an eval handler. Best error messages (Python line numbers, native errors). Slower for tight loops (interpreted dispatch per node). Best for interactive development, small cells, debugging.

### 12.2 Transpile mode (planned)

Emit JS source from AST, wrapped in `AsyncFunction`, JIT-compiled by V8. Native performance for loops. Python-specific semantics (integer division, truthiness, `for/else`) handled by runtime helper functions emitted inline:

```js
const __floor_div = (a, b) => Math.floor(a / b);
const __py_mod = (a, b) => ((a % b) + b) % b;
const __py_bool = (v) => Array.isArray(v) ? v.length > 0 : !!v;
```

Both backends share the same parser, AST, and scope model. The cell executor could choose automatically (eval for small cells, transpile for loops) or the user could force it with a directive (`// %transpile`).

### 12.3 @kernel — patra (planned)

Python syntax for atra numeric kernels. The `@kernel` decorator marks functions for compilation to atra → WASM bytecode. The parser extracts `@kernel` blocks, sends them to `patra.transpile()` → `atra.run()`, injects WASM exports into the Python scope. The remaining code runs in the eval backend.

This works cleanly because there's no WASM-from-WASM problem — the eval backend is pure JS, so calling WASM functions from the remaining code is just calling JS functions.

---

## 13. What adder is NOT

- **Not a full CPython implementation.** No multiple inheritance, no metaclasses, no descriptor protocol (beyond `@property`), no `__slots__`, no `__new__`, no `exec()`/`eval()`, no complex numbers, no `match`/`case`.
- **Not a replacement for atra.** Adder is for glue code and scripting. Performance-critical numeric kernels belong in atra (or patra for Python syntax → atra). Adder can call atra functions seamlessly — that's the point.
- **Not trying to run pip packages.** The standard library is minimal and purpose-built. numpy, pandas, scipy are not targets.
- **Not Python.** It's adder — a Python-flavored language that runs in JS. Duck-typed over Python syntax, with JS values underneath.

---

## 14. Not yet implemented

- **Generator coroutine protocol** — `send()`, `throw()`, `close()` on generator objects. Generators work for iteration (`for await`, `list()`) but not as coroutines.
- **Transpile mode** — JS source emission from AST (section 12.2)
- **@kernel / patra** — typed Python → atra → WASM (section 12.3)
- Multiple inheritance, metaclasses, `__new__`, descriptors, `__slots__`
- `match`/`case` (Python 3.10+)
- `exec()`/`eval()`
- Complex numbers

---

*@gcu/adder v2 — Geoscientific Chaos Union, 2026.*
