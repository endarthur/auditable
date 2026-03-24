# CPython Differences

Adder targets Python as she is written — the everyday subset — not the full CPython specification. This page documents where adder diverges from CPython behavior, what's missing, and what to watch for.

Most Python code pastes in and runs. The differences below matter at the edges.

---

## Numbers

**No arbitrary-precision integers.** All numbers are IEEE 754 doubles (`number`). Integers are exact up to 2^53; beyond that, precision is lost silently. `type(1)` returns `<class 'int'>` and `type(1.0)` returns `<class 'float'>`, but both are JS doubles internally.

```python
# CPython: 2 ** 100 = 1267650600228229401496703205376
# adder:   2 ** 100 = 1.2676506002282294e+30
```

**Complex numbers are supported.** `3+4j` creates a `Complex` object with `.real` and `.imag` attributes. Arithmetic (`+`, `-`, `*`, `/`, `**`), `abs()`, `conjugate()`, and the `complex()` builtin all work. `isinstance(1j, complex)` returns `True`. The `cmath` module is not available.

**Floor division and modulo use Python semantics**, not JS: `(-7) // 2` is `-4` (floors toward −∞), and `(-7) % 2` is `1` (result has the sign of the divisor). This matches CPython.

---

## Collections

**Tuples are not immutable.** Both `list` and `tuple` map to JS `Array`. You can `.append()` to a tuple — adder won't stop you. If your code depends on tuple immutability for correctness, use a different approach.

**Dict representation depends on key types.** Dicts with all-string keys become plain JS Objects (for seamless JS interop); dicts with any non-string key become `Map`. Both expose the same Python dict methods, but the JS representation differs:

```python
d1 = {"a": 1, "b": 2}     # → plain Object (dot access works from JS)
d2 = {1: "one", 2: "two"}  # → Map
```

This is usually invisible in Python code but matters when consuming dicts from JS cells.

**Empty lists are falsy**, matching CPython. This differs from JavaScript where `[]` is truthy. Adder checks `__bool__()` then `__len__()`, falling back to Python truthiness rules.

---

## Classes

**Multiple inheritance is supported** with C3 linearization (MRO). `class D(B, C)` works correctly. `super()` dispatches to the next class in the MRO. `@staticmethod` and `@classmethod` work as expected. No metaclasses, no `__new__`, no `__slots__`, no general descriptor protocol (`__get__`/`__set__`/`__delete__`).

**`@property` supports both getter and setter.** Use the standard `@prop.setter` decorator pattern:

```python
class Circle:
    def __init__(self, r):
        self._r = r
    @property
    def radius(self):
        return self._r
    @radius.setter
    def radius(self, value):
        self._r = max(0, value)
```

**Class variables are copied to instances.** Non-function class body assignments are copied to each new instance at construction time, rather than being shared through the prototype. This means mutating a class variable on one instance doesn't affect others — which is usually what you want, but differs from CPython's class/instance attribute lookup chain.

**`isinstance` walks the MRO.** `isinstance(x, int)` accepts builtin type objects and custom classes. The exception hierarchy (FileNotFoundError → OSError) is supported. `type()` returns callable type objects with `__name__`, matching CPython behavior.

---

## Generators

**Generators produce async iterators.** `yield` creates a generator object with `Symbol.asyncIterator`, not `Symbol.iterator`. This means:

- `for` loops work (adder's `for` handles async iterators)
- `list()`, `sorted()`, and other builtins that consume iterables work
- But `next()` on a generator returns a Promise
- The coroutine protocol (`send`, `throw`, `close`) is not supported

**itertools functions are lazy**, returning async iterators like CPython. `itertools.count()`, `itertools.repeat()`, and `itertools.cycle()` produce infinite sequences. Use `islice()` or `break` to consume them. `list(itertools.chain(...))` materializes results when needed.

---

## Scope and Assignment

**`del` on local variables** works for object attributes and dict keys, but `del x` on a bare name may behave differently than CPython in some edge cases.

**Augmented assignment** (`+=`, `-=`, etc.) checks for `__iadd__` and other in-place dunders first, falling back to `__add__` etc. This matches CPython behavior for custom types.

**Comprehension variables don't leak.** Each comprehension has its own scope, matching Python 3 behavior (not Python 2).

---

## Strings

**Regex named groups use either syntax.** Both `(?P<name>...)` (Python syntax) and `(?<name>...)` (JS syntax) work — adder automatically translates Python-style named groups. Backreferences (`(?P=name)`) are also supported. `match.group("name")` and `match.groupdict()` work as expected.

**`str.maketrans()` / `str.translate()`** are not implemented.

**Bytes are `Uint8Array`**, not an immutable sequence. `b"hello"` produces a `Uint8Array`. Most bytes methods are not available — use `encode`/`decode` for conversions.

---

## Modules and Imports

**No standard library beyond built-ins.** Only the modules listed in [Built-in Modules](modules.md) are available. `import numpy` will fail unless numpy is available through the notebook's module system.

**Module search order:** built-in modules → auditable extensions → VFS files. Circular imports are handled (cached in `sys.modules`), but complex circular dependency patterns may behave differently than CPython.

**`from __future__ import` is not supported.** All features are always available.

**Relative imports** (`from . import x`) work within VFS module packages.

---

## Error Handling

**Exception hierarchy works for built-in exceptions.** `except OSError` catches `FileNotFoundError`, `PermissionError`, etc. Custom exception classes with inheritance also work in `try`/`except`.

**Basic tracebacks.** Adder captures a call stack trace on errors, including function names and line numbers. The traceback is attached to the error object but is not yet formatted as a full Python-style traceback.

**`SystemExit`** is raised by `sys.exit()` but not caught by the notebook runtime — it propagates as a regular error.

---

## Dynamic Code Execution

**`exec()` and `eval()` are supported.** `eval(expr)` evaluates a Python expression and returns the result. `exec(code)` executes statements in the caller's scope. Both see the enclosing scope.

```python
x = eval("2 + 3")      # 5
exec("y = 42")          # sets y in current scope
```

---

## Performance

**Tree-walking interpreter.** Adder parses and evaluates the AST directly — no bytecode, no JIT. Performance is adequate for glue code, data processing scripts, and moderate loops. For tight numeric loops over large arrays, use [atra](../extensions-atra.md) or [Web Workers](../builtins-ui.md#workerfn).

**`while` loops are capped at 1,000,000 iterations** by default. This prevents accidental infinite loops from locking the browser tab. Override with `# %loop-limit N` (set custom limit) or `# %noloop-limit` (disable entirely). `for` loops have no hard cap but yield to the event loop every 1,000 iterations.

**`lru_cache` keys are `JSON.stringify(args)`**, which is slow for complex arguments and doesn't distinguish objects with the same serialization.

---

## Not Supported

These Python features are not implemented:

| Feature | Notes |
|---------|-------|
| `match`/`case` | Structural pattern matching (3.10+) |
| Metaclasses | No `__new__`, no `type()` as metaclass |
| `__slots__` | All instances use plain objects |
| General descriptors | `__get__`/`__set__`/`__delete__` protocol; `@property`, `@staticmethod`, `@classmethod` work |
| `send`/`throw`/`close` on generators | Generator iteration only |
| Walrus in comprehension target | `:=` works in `if` conditions, not as iteration target |
| `__init_subclass__` | — |
| `__class_getitem__` | — |
| `__set_name__` | — |
| Type hints at runtime | Annotations parsed but ignored |
| Arbitrary-precision integers | All numbers are IEEE 754 doubles |

---

## Gotchas for Python Developers

!!! warning "Watch for these"

    1. **Large integers overflow silently** — `2 ** 100` gives a float approximation, not an exact integer
    2. **Tuples are mutable** — don't rely on tuple immutability for safety
    3. **Dict keys affect representation** — string-key dicts become Objects; this changes how JS cells see them
    4. **Generators are async** — `next()` returns a Promise; use `for` loops or `list()` instead

---

## What Works Well

Despite the differences, adder handles the vast majority of everyday Python:

- Data processing with list/dict comprehensions
- Statistical calculations with math and custom functions
- String parsing and formatting with f-strings and regex
- File I/O via VFS (os, pathlib, open)
- Class hierarchies with multiple inheritance, super(), operator overloading
- Complex number arithmetic
- Async operations (fetch, file I/O)
- Generator-based data pipelines
- Lazy itertools (count, cycle, chain, product, etc.)
- Dynamic code execution with exec/eval
- Cross-cell reactivity in the notebook DAG

If your Python script uses standard data structures, control flow, functions, and classes without relying on CPython internals — it will almost certainly run in adder unchanged.
