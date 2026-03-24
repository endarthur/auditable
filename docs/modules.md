# Modules

Auditable provides three functions for importing external code and assets into
notebooks: `load()`, `install()`, and `installBinary()`. All three are
available as cell builtins — injected automatically into every code cell.

---

## `load(url)`

Dynamically imports an ES module and returns its exports. Results are cached
in `window._importCache` for the duration of the browser session.

```js
const d3 = await load("https://esm.sh/d3");
const { scaleLinear } = await load("https://esm.sh/d3-scale");
```

!!! info "Session-only"
    Modules loaded with `load()` are fetched on every page load. They are
    **not** persisted in the HTML file. Use `install()` if you need offline
    access after saving.

If the URL points to an already-installed module (via `install()` or
`/// module:` directive), `load()` uses the stored source instead of fetching.

---

## `install(url)`

Like `load()`, but **persists the module source** inside the HTML file's
`AUDITABLE-MODULES` data block. After installing, the module works offline in
saved notebooks.

```js
await install("https://esm.sh/peerjs");
```

Returns the module's exports (same as `load()`). Also prints the installed
size to the cell output.

!!! tip "esm.sh bundling"
    For URLs containing `esm.sh`, `install()` automatically appends `?bundle`
    (if not already present) to ensure all dependencies are included in a
    single fetch. This avoids broken imports in offline mode.

**How it works internally:**

1. Fetches the source text from the URL
2. Resolves root-relative import paths to absolute URLs (so blob URLs work)
3. Stores the source in `window._installedModules` keyed by the original URL
4. Serializes to the `AUDITABLE-MODULES` block via `syncModules()`
5. Creates a blob URL and imports it into the session cache

---

## `installBinary(url, opts?)`

Fetches a binary asset (WASM, images, fonts, data files), stores it as base64
in the notebook, and returns a **blob URL** with the correct MIME type.

```js
const wasmUrl = await installBinary("https://example.com/module.wasm");
const imageUrl = await installBinary("https://example.com/photo.jpg");
```

| Option     | Type    | Default | Description                          |
|------------|---------|---------|--------------------------------------|
| `compress` | boolean | `true`  | Gzip-compress before storing         |

By default, binary data is gzip-compressed before base64 encoding to reduce
file size. Disable compression for already-compressed formats:

```js
// already compressed — skip gzip
const zipUrl = await installBinary("https://example.com/data.zip", { compress: false });
```

!!! warning "File size"
    Binary assets are embedded directly in the HTML. Large binaries will
    significantly increase notebook file size. Compression helps, but consider
    whether the asset truly needs to be embedded.

**Storage format:** each binary entry in `_installedModules` has:

| Field        | Description                                    |
|--------------|------------------------------------------------|
| `source`     | Base64-encoded data (compressed or raw)        |
| `binary`     | `true` — marks this as a binary entry         |
| `compressed` | Whether gzip compression was applied           |
| `type`       | MIME type (detected from response headers)     |

On load, `decodeBinary()` reverses the process: base64-decode, decompress if
needed, create a blob URL with the stored MIME type.

---

## Virtual modules

Several special URLs resolve to built-in or bundled modules without any
network request:

### `@std`

The standard library. Already available as the `std` parameter in every cell,
but importable for consistency:

```js
const { sum, mean, linspace } = await load("@std");
```

### `@python` / `@python/this`

Python compatibility layer providing familiar builtins for users transitioning from Python. Each function has a `.help` property showing the idiomatic JS equivalent.

```js
const { range, enumerate, len, sorted, reversed, isinstance, type } = await load("@python");
```

| Function | Description | JS equivalent |
|----------|-------------|---------------|
| `range(stop)` / `range(start, stop, step)` | Generate an array of integers | `Array.from({length: n}, (_, i) => start + i * step)` |
| `enumerate(arr)` | Array of `[index, value]` pairs | `arr.map((v, i) => [i, v])` |
| `len(x)` | Length of an array, string, or `.size` of a Map/Set | `x.length` or `x.size` |
| `sorted(arr, key?, reverse?)` | Return a sorted copy | `arr.toSorted((a, b) => ...)` |
| `reversed(arr)` | Return a reversed copy | `arr.toReversed()` |
| `isinstance(obj, cls)` | Type check | `obj instanceof cls` |
| `type(x)` | Return type string (`'null'`, `'array'`, or `typeof`) | `typeof x` |

`@python/this` imports the same functions and also displays the Zen of Python.

### `@atra/<name>`

Pre-compiled atra library binary distributions (standalone JS with embedded
Wasm). Three resolution paths, tried in order:

1. **Pre-installed** — if the module was previously installed via `install()`
   or a `/// module:` directive, uses the stored source from
   `_installedModules`. Works offline.
2. **Dev-mode fallback** — in development (serving from the repo), falls back
   to a relative import from `./ext/atra/lib/<name>.js`.
3. **CDN install** — `install("@atra/alpack")` fetches from the auditable
   GitHub Pages CDN and persists for offline use.

```js
const alpack = await load("@atra/alpack");
```

### `@sheet`

XLSX I/O library for reading and writing spreadsheet files. See [Sheet module](mod-sheet.md) for API details.

### `@calque`

Spreadsheet language compiler (Calque). See [Calque module](mod-calque.md) for API details.

### `@spinifex`

Web GIS module wrapping OpenLayers 10. See [Spinifex module](mod-spinifex.md) for API details.

!!! note
    `@sheet`, `@calque`, and `@spinifex` follow the same three-path resolution
    as `@atra` — installed source first, then dev-mode relative import, then
    CDN install.

### @gcu/ namespace

Extensions under the `@gcu/` prefix are first-party auditable modules:

| Module | Description |
|--------|-------------|
| `@gcu/adder` | Python dialect interpreter — enables `adder` cell type |
| `@gcu/plot` | Charting library (line, bar, scatter, histogram, heatmap) |
| `@gcu/sadpan` | Stereographic analysis and projection |
| `@gcu/natra` | N-dimensional array operations |
| `@gcu/units` | Unit conversion, sieve mesh, drill core calculations |
| `@gcu/vfs` | Virtual filesystem with multiple backends |

Other named modules:

| Module | Description |
|--------|-------------|
| `@plan` | Project scheduling (CPM, PERT, Monte Carlo, EVM) |
| `@sheet` | Spreadsheet widget with xlsx I/O |
| `@calque` | Spreadsheet formula language |

```js
// load a first-party module
const plot = await load("@gcu/plot");

// load and register the Python cell type
await load("@gcu/adder");
```

!!! info
    `@gcu/` modules are bundled into saved notebooks via `install()`, so they work offline after the first load.

---

## Managing installed modules

The **settings panel** (gear icon in the toolbar) displays all installed
modules and binaries with their sizes. You can remove individual entries to
reduce file size.

Installed modules are encoded in the `AUDITABLE-MODULES` HTML comment block
using base64 (not raw JSON), because module source code can contain `--`
(which breaks HTML comments) and `$'` (which triggers `String.replace()`
special patterns).

---

## The `/// module:` directive

In example definition files (`examples/defs/**/*.txt`), the `/// module:`
directive embeds modules at **build time** rather than runtime:

```
/// module: @atra/alpack ext/atra/lib/alpack.src.js
```

This tells `gen_examples.js` to read the file at the given path and store its
contents in `_installedModules` under the specified key. The resulting example
HTML works offline without any network requests.

!!! info "Build-time only"
    The `/// module:` directive is processed by the example generator
    (`gen_examples.js` / `make_example.js`). It has no effect at runtime in
    the notebook itself.

---

## Examples

```js
// load a charting library (session-only)
const Plot = await load("https://esm.sh/@observablehq/plot");

// install for offline use
const { default: Papa } = await install("https://esm.sh/papaparse?bundle");

// install a WASM binary
const sqliteUrl = await installBinary(
  "https://example.com/sql-wasm.wasm"
);

// atra library (pre-installed or dev fallback)
const alpack = await load("@atra/alpack");

// python compat
const { range, zip, enumerate } = await load("@python");
```
