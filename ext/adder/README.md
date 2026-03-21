# @gcu/adder

MicroPython as a first-class cell language in auditable. Python cells participate in the reactive DAG — define variables in Python, use them downstream in JS or other Python cells.

## quick start

```js
// in a code cell:
await load("@gcu/adder")
// or, to persist offline:
await install("@gcu/adder")
```

this registers the `python` cell type. press `n` in command mode to convert a cell, or use the cell header button.

## architecture

```
ext/adder/
  index.js           — BUILD OUTPUT (bundled from src/)
  build.js           — concatenates src/ modules into index.js
  micropython.mjs    — vendored MicroPython v1.27.0 loader (patched)
  micropython.wasm   — vendored MicroPython v1.27.0 binary (patched)
  src/
    main.js          — entry point (import order for bundler)
    bridge.js        — Python bootstrap: _exec_cell, _build_async_wrapper
    init.js          — lazy interpreter init, stdout buffering, WASM resolution
    cell.js          — pythonParseNames, pythonFindUses, pythonExecute
    highlight.js     — tokenizePython, pythonCompletions
    tag.js           — mpy tagged template
    register.js      — cell type, tagged language, plugin registration
```

### runtime

vendored MicroPython v1.27.0 (JS + WASM). two patches applied to the upstream build:

- **`mp_js_hook` stdin fix** — prevents stdin prompt from blocking the event loop
- **`mp_hal_get_interrupt_char` arity** — fixes a parameter count mismatch

the interpreter is initialized lazily on first Python cell execution. a single `_mp` instance is shared across all cells — isolation is at the namespace level, not the interpreter level.

### install workflow

`install("@gcu/adder")` chain-installs three assets:

1. `@gcu/adder` — adder extension JS (gzip-compressed)
2. `@gcu/adder/micropython.mjs` — MicroPython loader (gzip-compressed)
3. `@gcu/adder/micropython.wasm` — MicroPython binary (gzip-compressed binary)

all three are embedded in the notebook's `AUDITABLE-MODULES` block. the notebook works offline after install.

`load("@gcu/adder")` uses a dev-mode fallback (relative import) when modules aren't installed — works on a local dev server but not in saved notebooks opened from `file://`.

### init sequence

1. `initInterpreter()` called (lazy, once)
2. resolve `micropython.mjs` — check `_installedModules` (decompress if needed), fallback to relative import
3. resolve `micropython.wasm` — check `_installedModules` (decompress if needed), omit if not found (MicroPython fetches default)
4. call `loadMicroPython()` with stdout/stderr callbacks
5. register all `window._auditableExtensions` via `mp.registerJsModule(name, exports)`
6. bootstrap `_exec_cell` and `_build_async_wrapper` helpers via `mp.runPython(BRIDGE_PY)`

**note:** extensions registered via `registerExtension()` after step 5 are NOT visible to Python. there is no mechanism to inject JS modules into an already-running interpreter. this means notebooks must `load("@gcu/adder")` after all extensions they want accessible from Python.

## Python cells

### DAG integration

Python cells are full DAG citizens:

- **defines** — `pythonParseNames(code)` extracts top-level names: `def`, `async def`, `class`, `import`, `from...import` (with `as`), tuple unpacking, simple/annotated assignment. only column-0 (unindented) lines are considered.
- **uses** — `pythonFindUses(code, allDefined)` strips comments and strings via `_stripPython()`, then word-boundary matches against all names defined by other cells. self-defines are excluded.
- **execution** — `pythonExecute(code, scopeIn, cell)` builds a Python namespace from upstream scope, runs the code, extracts defined values back into JS scope.

### execution model

two paths, selected by `await` detection (`/\bawait\b/.test(code)`):

**sync path** (no `await`):
1. build namespace dict `_adder_ns` from upstream JS scope
2. call `_exec_cell(code, _adder_ns)` — compiles and executes in the namespace
3. last-expression detection: if the last non-blank/non-comment line compiles as `eval`, it's separated and returned as the cell's display value
4. extract defined names from namespace back to JS scope

**async path** (has `await`):
1. build namespace dict, inject `sys.modules` for import resolution
2. `_build_async_wrapper(code, defines)` wraps code in `async def _adder_cell()` with `global` declarations for all defines
3. `exec()` the wrapper definition, then `await _adder_ns["_adder_cell"]()`
4. globals flow back to `_adder_ns` via the `global` declarations
5. last-expression capture via `_adder_last_expr` global

### output

cell output is assembled from:
1. **stdout** — lines captured via MicroPython's stdout callback during execution
2. **stderr** — lines captured via stderr callback
3. **last expression** — the return value of the last line (if it compiles as `eval`)

these are joined with newlines and rendered as plain text in the cell output area.

### namespace isolation

each cell execution creates a fresh `_adder_ns` dict. defines from upstream JS cells are injected as entries. after execution, defined Python values are extracted back to JS scope. the interpreter's `__main__` module is not used — all execution happens in isolated namespace dicts.

`sys.modules` persists across cells (it's interpreter-global). `import foo` in one cell makes `foo` available to subsequent cells that also `import foo`, without re-importing.

### syntax checking

`syntaxCheck(code)` calls `compile(code, "<check>", "exec")` on the live MicroPython interpreter. returns `true` if the code parses, `false` on `SyntaxError`. the cell type system gates execution behind a successful syntax check — the cell shows a `syntax-pending` visual state while editing.

**note:** before the interpreter is initialized (no Python cell has run yet), `syntaxCheck` returns `true` unconditionally. the check only activates after the first Python cell triggers `initInterpreter()`.

### syntax highlighting

Python cells use CodeMirror 6's built-in Python language mode (`@codemirror/lang-python`) for full-fidelity highlighting with 4-space indentation. this is handled in `cm6.js` as a special case — other plugin cell types use a `StreamLanguage` wrapper around their `tokenize()` function.

the `tokenizePython()` function in `highlight.js` is used for:
- `mpy` tagged template highlighting in JS code cells
- completions (keywords + builtins)

it produces tokens: `kw`, `fn`, `id`, `str`, `num`, `cmt`, `dec`, `op`, `ws`.

### completions

`pythonCompletions(prefix)` returns case-insensitive prefix matches against Python keywords and builtins. does not include user-defined names or `sys.modules` entries.

## `mpy` tagged template

inline Python in JS code cells:

```js
const { x, y } = await mpy`
x = 42
y = x + 8
`
```

### value interpolation

JS values are injected as `_v0`, `_v1`, etc.:

```js
const scale = 2.5
const { result } = await mpy`
result = ${scale} * 10
`
```

### return value

returns a plain JS object with all non-underscore-prefixed names from the Python namespace. `_v0`, `_v1`, and other `_`-prefixed names are filtered out.

### known limitations

- **sync-only** — `mpy` uses `mp.runPython()`, not `runPythonAsync()`. `await` inside an `mpy` template will not work. Python cells support async; `mpy` does not.
- **stdout is discarded** — `print()` inside an `mpy` template produces no visible output. `flushStdout()` is called before and after execution to drain the buffer, but the captured lines are not returned or displayed. Python cells capture and display stdout; `mpy` does not.
- **no error location** — exceptions propagate to JS but without Python line numbers relative to the template.

### WASM-from-WASM limitation

MicroPython runs as WASM with Asyncify. It cannot call other WASM modules (e.g. GSLIB's `kb2d`) from Python — two failure modes:

1. **Synchronous call** (`js.globalThis._gslib.kb2d(...)`) — "RuntimeError: unreachable" (nested WASM stacks, Asyncify overflow)
2. **Async bridge** (`await promise_that_calls_wasm`) — "Assertion failed: proxy_c_to_js_call is running asynchronously" (the vendored MicroPython build's `proxy_c_to_js_call` in the Asyncify resume path lacks `{async: true}` on its ccall)

**Workaround:** use a thin JS bridge cell for WASM calls. Python exports data as JSON, JS calls the WASM function, JS serializes results as JSON, Python consumes them. See `example_adder_gslib` for the pattern.

**Fix:** patching the vendored `micropython.mjs`/`.wasm` to add `{async: true}` to the ccall in `proxy_call_python` would enable custom Promise resolution during Asyncify resume. This is a MicroPython/Emscripten build configuration change, not an adder bug.

## FFI: JS <-> Python

### JS values in Python

upstream JS scope variables are injected into the Python namespace. type mapping:

| JS type | Python type |
|---------|------------|
| `number` | `int` or `float` |
| `string` | `str` |
| `boolean` | `bool` |
| `null` | `None` |
| `Array` | `JsProxy` (use `list(x)` to convert) |
| `Object` | `JsProxy` (property access works) |

### Python values in JS

defined Python values are extracted back to JS scope. MicroPython's `JsProxy` handles most conversions. Python `int` becomes JS `number`, `str` becomes `string`, etc. Python `list`/`dict` stay as `JsProxy` objects — access with `.get()` or convert in Python before returning.

### calling Python functions from JS

Python `def` at column 0 creates a callable in JS scope:

```python
# python cell
def greet(name):
    return "hello, " + name
```

```js
// downstream JS cell
display(greet("auditable"))  // "hello, auditable"
```

### JS imports from Python

JS modules registered via `window._auditableExtensions` before interpreter init are importable:

```python
import my_extension
my_extension.do_something()
```

MicroPython does not support `sys.meta_path` finders — `registerJsModule()` is the only mechanism.

## tests

```
test/adder.test.mjs       — 40 pure JS tests (no WASM)
test/adder-wasm.test.mjs  — 51 WASM integration tests (requires --test-force-exit)
```

run with `npm test` (pure JS) and `npm run test:wasm` (WASM).

### coverage

- **pythonParseNames** — simple/annotated assignment, tuple unpacking, def/async def, class, import/from-import with as, indented scope skipping, keyword guard
- **pythonFindUses** — upstream refs, self-exclusion, string/comment stripping, function calls, triple-quoted strings
- **tokenizePython** — keywords, builtins, strings (single/triple/f-string), numbers (int/hex/float/complex), comments, decorators, operators
- **pythonCompletions** — keyword match, builtin match, case-insensitive, no-match
- **BRIDGE_PY** — `_exec_cell` last-expression detection, empty/comment code, expression-after-def
- **registerJsModule** — import, ImportError, sys.modules caching, namespace access, callable FFI
- **pythonExecute** — namespace building, define extraction, last-expression, globals cleanup, error recovery, function defines
- **mpy patterns** — namespace return, `_v` interpolation, `_`-prefix filtering, function extraction
- **stdout** — callback capture, buffering, ordering
- **output assembly** — print-only, expr-only, print+expr, assignment-only, defines+output
- **async** — Promise resolution, upstream scope, last-expression, no-last-expr, print+await
- **FFI marshalling** — number/string/boolean roundtrip, null-to-None, object property access
- **error handling** — SyntaxError, NameError, TypeError, ZeroDivisionError, recovery
- **namespace isolation** — independent cells, sys.modules persistence
