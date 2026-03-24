# UI Builtins

Every code cell receives a `ui` object and several other injected builtins. These are per-cell — they are **not** propagated to downstream cells via scope.

## Display

### `ui.display(...values)`

Output values to the cell's output area. Accepts strings, numbers, objects, DOM elements. Objects are serialized as JSON (pretty-printed). Strings and numbers are followed by a newline; DOM elements are appended directly without extra whitespace.

`print()` is a top-level alias for `ui.display()`.

```js
ui.display("hello", 42, { x: 1, y: 2 })

// or equivalently:
print("result:", someValue)
```

### `ui.canvas(w?, h?)`

Create or reuse a `<canvas>` element in the cell output. Defaults to 400x300. Returns the canvas element, which is appended directly to the output area with a black background. On re-execution, reuses the previous canvas if dimensions match (no flicker).

```js
const c = ui.canvas(600, 400)
const ctx = c.getContext("2d")
ctx.fillStyle = "#c89b3c"
ctx.fillRect(50, 50, 200, 100)
```

### `ui.table(data, columns?)`

Render an array of objects as an HTML table. Numeric columns are right-aligned — integers display as-is, non-integer numbers are formatted to 4 decimal places. Optional `columns` array selects and orders which keys to display.

```js
const data = [
  { name: "Alice", score: 95.1234 },
  { name: "Bob", score: 87.5678 },
]
ui.table(data)

// show only specific columns:
ui.table(data, ["name"])
```

---

## Widgets

Four interactive widget functions: `ui.slider()`, `ui.dropdown()`, `ui.checkbox()`, `ui.textInput()`. Each returns the widget's current value and persists across re-executions.

```js
const n = ui.slider("count", 10, { min: 1, max: 50 })
const mode = ui.dropdown("projection", ["mercator", "equalArea", "gnomonic"])
const show = ui.checkbox("show grid", true)
const query = ui.textInput("search", "")
```

All four widget functions accept `opts.id` and `opts.class` for setting the element's `id` attribute and CSS class name.

Without callbacks, changing a widget re-runs the cell and its dependents through the DAG. With `onInput` or `onChange`, the closure runs directly — no DAG rebuild.

See [Widgets](widgets.md) for full signatures, HTML cell usage, debouncing behavior, and persistence details.

### `ui.download(label, data, filename, opts?)`

Render a styled download button in the cell output. The blob URL is automatically revoked when the cell re-runs.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `label` | string | required | Button text |
| `data` | Blob/ArrayBuffer/Uint8Array/string/object | required | File content |
| `filename` | string | required | Download filename |
| `opts.type` | string | guessed from extension | MIME type |

```js
const csv = "name,value\nAlice,42\nBob,17"
ui.download("Export CSV", csv, "data.csv")
```

### `ui.upload(label, opts?)`

File picker widget. Returns `{ name, data, size, type }` after a file is chosen, or `null` before any selection.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `label` | string | required | Display label and widget key |
| `opts.accept` | string | --- | File type filter (e.g. `".csv,.json"`) |
| `opts.as` | string | `"text"` | Read mode: `"text"`, `"arrayBuffer"`, or `"dataURL"` |
| `opts.onChange` | function | --- | Callback with result object |

```js
const file = ui.upload("data file", { accept: ".csv" })
if (file) {
  const rows = std.csv(file.data, { typed: true })
  ui.table(rows)
}
```

### `ui.drop(label, opts?)`

Drop zone with integrated file picker. Accepts drag-and-drop or click-to-browse. Same return format as `ui.upload`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `label` | string | required | Drop zone text and widget key |
| `opts.accept` | string | --- | File type filter |
| `opts.as` | string | `"text"` | Read mode: `"text"`, `"arrayBuffer"`, or `"dataURL"` |
| `opts.onChange` | function | --- | Callback with result object |

```js
const file = ui.drop("drop CSV here", { accept: ".csv", as: "text" })
if (file) ui.table(std.csv(file.data, { typed: true }))
```

---

## Module Loading

### `load(url)`

Import an ES module (cached for the session). Returns the module's exports.

```js
const d3 = await load("https://esm.sh/d3@7")
```

**Virtual modules:**

| URL | Description |
|-----|-------------|
| `@std` | Standard library (same as the `std` builtin) |
| `@python` | Python-compatible helpers (range, enumerate, len, etc.) |
| `@atra/<name>` | Atra library binary distributions |
| `@sheet` | xlsx IO library |
| `@calque` | Spreadsheet language compiler |
| `@spinifex` | Web GIS module (OpenLayers) |

### `install(url)`

Fetch a module and embed its source in the notebook HTML for offline use. For `esm.sh` URLs, automatically appends `?bundle`. Returns the module's exports.

```js
const lodash = await install("https://esm.sh/lodash-es@4")
```

### `installBinary(url, opts?)`

Fetch a binary asset, gzip-compress it, and store as base64 in the notebook. Returns a blob URL with the correct MIME type. Use `{ compress: false }` to skip compression.

```js
const fontUrl = await installBinary("https://example.com/font.woff2")
```

---

## Other Builtins

### `invalidation`

A promise that resolves just before the cell re-runs. Use it for cleanup: cancelling animations, closing connections, revoking blob URLs.

```js
const interval = setInterval(() => tick(), 100)
invalidation.then(() => clearInterval(interval))
```

### `notebook`

API for programmatic notebook control.

| Property/Method | Description |
|-----------------|-------------|
| `notebook.cells` | Array of `{ id, type, code }` for all cells |
| `notebook.scope` | Snapshot of current scope (shallow copy) |
| `notebook.addCell(type, code, afterId?)` | Insert a new cell |
| `notebook.scrollTo(id)` | Smooth-scroll to a cell |
| `notebook.focus(id)` | Scroll to and focus a cell's editor |
| `notebook.collapse(id)` | Collapse a cell |
| `notebook.expand(id)` | Expand a cell |
| `notebook.run(ids)` | Run one or more cells by id |

---

## worker(fn)

Create a Web Worker from a pure function. The worker runs in a background thread — ideal for heavy computation that would block the UI.

```js
const compute = worker(function(data) {
  // runs in a separate thread
  let sum = 0;
  for (const x of data) sum += x * x;
  return sum;
});

const result = await compute(largeArray);
```

The function must be **self-contained** — it cannot reference variables from the cell scope. Returns an async callable that serializes arguments, runs the function in a Worker, and returns the result.

TypedArrays in the return value are **transferred** (zero-copy), not cloned.

!!! tip
    Workers auto-terminate when the cell re-runs (via `invalidation`), so you don't need manual cleanup.

## workerPool(fn, n?)

Create a pool of `n` workers (defaults to `navigator.hardwareConcurrency`). Use `.map()` for parallel batch processing.

```js
const pool = workerPool(function(x) {
  return x * x;
});

const results = await pool.map([1, 2, 3, 4, 5]);
// [1, 4, 9, 16, 25]
```

The pool uses a **free-worker queue** — tasks are dispatched to the next idle worker, not round-robin. Extra arguments to `.map()` are passed to every invocation:

```js
const pool = workerPool(function(item, config) {
  return item * config.scale;
});

const results = await pool.map([1, 2, 3], { scale: 10 });
// [10, 20, 30]
```

Call `pool.terminate()` to explicitly clean up, or let `invalidation` handle it automatically.

## notebook.fs

Access the notebook's embedded filesystem. Files are stored inside the notebook HTML and persist across saves.

```js
await notebook.fs.write("data/points.csv", csvText);
const content = await notebook.fs.readText("data/points.csv");
const files = await notebook.fs.list();
```

See [Notebook Filesystem](filesystem.md) for the full API reference.
