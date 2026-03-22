# @gcu/adder

A Python dialect as a first-class cell language in auditable. Pure JS tree-walking interpreter — no WASM, no external runtime. Python cells participate in the reactive DAG: define variables in Python, use them downstream in JS or other Python cells.

## quick start

```js
// in a code cell:
await load("@gcu/adder")
// or, to persist offline:
await install("@gcu/adder")
```

this registers the `adder` cell type. press `n` in command mode to convert a cell, or use the cell header button.

## architecture

```
ext/adder/
  index.js           — BUILD OUTPUT (bundled from src/)
  build.js           — concatenates src/ modules into index.js
  src/
    main.js          — entry point (import order for bundler)
    parse.js         — tokenizer + recursive-descent parser → AST
    eval.js          — tree-walking evaluator (async)
    builtins.js      — builtins, method dispatch, modules, format specs, VFS
    cell.js          — pythonParseNames, pythonFindUses, pythonExecute
    highlight.js     — tokenizePython, pythonCompletions
    tag.js           — adder/mpy tagged template
    register.js      — cell type, tagged language, plugin registration
```

### runtime

Pure JS — a single-pass tokenizer feeds a recursive-descent parser (`parse.js`) that produces an AST, which is then tree-walked by an async evaluator (`eval.js`). No compilation step, no WASM, no external binary.

### install workflow

`install("@gcu/adder")` installs one asset — the JS bundle (gzip-compressed). it's embedded in the notebook's `AUDITABLE-MODULES` block. the notebook works offline after install.

`load("@gcu/adder")` uses a dev-mode fallback (relative import) when the module isn't installed — works on a local dev server but not in saved notebooks opened from `file://`.

### data model

Python values ARE JS values — there is no FFI boundary:

| Python type | JS representation |
|-------------|-------------------|
| `int`, `float` | `number` |
| `str` | `string` |
| `bool` | `boolean` |
| `None` | `null` |
| `list`, `tuple` | `Array` |
| `dict` | plain `Object` (or `Map` for non-string keys) |
| `set` | `Set` |
| `range` | `AdderRange` (lazy, iterable) |
| `bytes` | `Uint8Array` |

since there's no FFI, values pass between Python and JS cells without conversion — a list defined in Python is a regular `Array` in downstream JS cells, and vice versa.

### scope model

`AdderScope` implements Python's LEGB scoping with a `vars` Map and parent chain. `global` and `nonlocal` declarations are tracked via Sets and resolved by walking the scope chain. each cell execution creates a fresh scope with builtins + upstream variables.

## adder cells

### DAG integration

adder cells are full DAG citizens:

- **defines** — `pythonParseNames(code)` parses the AST and walks module-scope statements to find assignments, function/class defs, and imports. descends into block statements (`for`, `if`, `with`, `try`, `while`) but stops at `def`/`class` (which create new scopes). falls back to regex on parse error.
- **uses** — `pythonFindUses(code, allDefined)` walks the AST for `Name` nodes, matching against names defined by other cells. self-defines are excluded. falls back to regex on parse error.
- **execution** — `pythonExecute(code, scopeIn, cell)` parses the code, creates an `AdderScope` with builtins + upstream scope, evaluates via `adderEval`, and extracts defined values back into JS scope.

### execution model

single unified path — parse AST, tree-walk evaluate:

1. parse source via `adderParse(code)` → AST
2. create `AdderScope` with builtins + upstream scope variables
3. inject cell context (`ui`, `std`, `load`, `display`, etc.) if running inside auditable
4. `await adderEval(ast, scope)` — the evaluator is always async
5. extract defined names from scope back to JS scope

`await` works natively (the evaluator is async JS). no sync/async split needed.

### output

in cell context: `print()` renders to DOM via `display()`, last expression value is also displayed. in standalone/test mode: stdout is buffered as a string, returned alongside defines.

### syntax checking

`adderParse(code)` — pure JS parser. returns `true` if the code parses without error, `false` on `SyntaxError`. instant — no interpreter initialization needed.

### syntax highlighting

Python cells use CodeMirror 6's built-in Python language mode (`@codemirror/lang-python`) for full-fidelity highlighting with 4-space indentation.

the `tokenizePython()` function in `highlight.js` is used for:
- `adder` and `mpy` tagged template highlighting in JS code cells
- completions (keywords + builtins)

it produces tokens: `kw`, `fn`, `id`, `str`, `num`, `cmt`, `dec`, `op`, `ws`.

### completions

`pythonCompletions(prefix)` returns case-insensitive prefix matches against Python keywords and builtins. does not include user-defined names.

## tagged template

inline Python in JS code cells via `adder` or `mpy` (back-compat alias):

```js
const { x, y } = await adder`
x = 42
y = x + 8
`
```

### value interpolation

JS values are injected as `_v0`, `_v1`, etc.:

```js
const scale = 2.5
const { result } = await adder`
result = ${scale} * 10
`
```

### return value

returns a plain JS object with all non-underscore-prefixed names from the scope. `_v0`, `_v1`, and other `_`-prefixed names are filtered out.

### tagged template limitations

- **stdout is discarded** — `print()` inside a tagged template produces no visible output. adder cells capture and display stdout; the tag does not.
- **no error location** — exceptions propagate to JS but without Python line numbers relative to the template.

## modules

built-in modules available via `import`:

| module | description |
|--------|-------------|
| `math` | math constants and functions (pi, sin, sqrt, factorial, gcd, ...) |
| `json` | `dumps()`, `loads()` (Map/Set aware) |
| `js` | proxy to `globalThis` — access any browser API |
| `random` | `random()`, `randint()`, `uniform()`, `choice()`, `shuffle()`, `gauss()`, `sample()` (xoshiro128 PRNG) |
| `itertools` | `chain`, `product`, `combinations`, `permutations`, `repeat`, `accumulate`, `starmap`, `islice`, `zip_longest`, `groupby` |
| `functools` | `reduce`, `partial`, `lru_cache` |
| `collections` | `OrderedDict`, `defaultdict`, `Counter`, `namedtuple` |
| `re` | `match`, `search`, `findall`, `sub`, `split`, `compile`, `escape` (wraps JS RegExp) |
| `string` | `ascii_lowercase`, `digits`, `punctuation`, etc. |
| `sys` | `version`, `platform`, `path`, `modules`, `argv`, `exit` |
| `this` | the Zen of Python (and `this.gcu`) |

### VFS modules

when the notebook's virtual filesystem is available (`window._notebookVFS`), adder automatically wires it up and provides filesystem modules:

| module | description |
|--------|-------------|
| `os` | `listdir`, `mkdir`, `makedirs`, `remove`, `rename`, `stat`, `walk`, `getcwd`, `chdir` |
| `os.path` | `join`, `dirname`, `basename`, `splitext`, `exists`, `isfile`, `isdir`, `getsize` |
| `pathlib` | `Path` class with `read_text`, `write_text`, `exists`, `mkdir`, `glob`, `iterdir`, `/` operator |
| `shutil` | `copy`, `copytree`, `rmtree`, `move` |
| `glob` | `glob(pattern)` |

the built-in `open()` function also works when VFS is available, supporting text and binary modes with context managers (`with`).

## method dispatch

adder implements Python-style method dispatch on JS types:

- **str** — `upper`, `lower`, `strip`, `split`, `join`, `replace`, `find`, `startswith`, `endswith`, `format`, `encode`, `capitalize`, `title`, `zfill`, `partition`, `removeprefix`, `removesuffix`, `splitlines`, and more
- **list** — `append`, `extend`, `insert`, `remove`, `pop`, `clear`, `index`, `count`, `sort`, `reverse`, `copy`
- **dict** (Map and plain Object) — `keys`, `values`, `items`, `get`, `pop`, `setdefault`, `update`, `clear`, `copy`
- **set** — `add`, `remove`, `discard`, `pop`, `clear`, `union`, `intersection`, `difference`, `symmetric_difference`, `update`, `issubset`, `issuperset`, `copy`

format specs (`f"{x:.2f}"`, `format(x, "08d")`) are fully implemented.

## calling Python functions from JS

Python `def` at module scope creates a callable in JS scope:

```python
# adder cell
def greet(name):
    return "hello, " + name
```

```js
// downstream JS cell
display(greet("auditable"))  // "hello, auditable"
```

## what's not supported

- generators / `yield` (parsed but not evaluated)
- multiple inheritance
- metaclasses
- `match` / `case`
- `exec()` / `eval()`
- complex numbers

see `SPEC.md` for full language details.

## tests

```
test/adder.test.mjs        — pure JS tests (parseNames, findUses, tokenizer, completions)
test/adder-interp.test.mjs — interpreter tests (parse, eval, builtins, async, classes, etc.)
```

run with `npm test`.

### coverage

- **pythonParseNames** — simple/annotated assignment, tuple unpacking, def/async def, class, import/from-import with as, scope descent (for/if/try/with) without entering def/class, regex fallback
- **pythonFindUses** — upstream refs, self-exclusion, AST walk for Name nodes, regex fallback
- **tokenizePython** — keywords, builtins, strings (single/triple/f-string), numbers (int/hex/float), comments, decorators, operators
- **pythonCompletions** — keyword match, builtin match, case-insensitive, no-match
- **adderParse** — expressions, statements, control flow, classes, comprehensions, error recovery
- **adderEval** — assignments, operators, control flow, functions, classes, async/await, comprehensions, exception handling, decorators, dunders
- **builtins** — print, len, range, type conversions, sorted/reversed/enumerate/zip/map/filter, isinstance, format specs
- **modules** — math, json, random, itertools, functools, collections, re
- **tagged template** — namespace return, `_v` interpolation, `_`-prefix filtering
- **scope** — LEGB chain, global/nonlocal, closure capture
- **method dispatch** — str/list/dict/set methods
- **FFI** — number/string/boolean/null roundtrip, no conversion boundary
- **error handling** — SyntaxError, NameError, TypeError, ZeroDivisionError, recovery
