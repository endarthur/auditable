# auditable

a reactive computational notebook that fits in a single HTML file.

no build step. no server. no dependencies. open the file, write code, save. the HTML *is* the document, the runtime, and the lockfile.

```
auditable.html    — smaller than a floppy disk
```

## what it does

- **reactive DAG** -- cells track dependencies and re-execute when upstream values change
- **four cell types** -- code, markdown, CSS, and HTML cells with live reactivity
- **interactive widgets** -- `slider()`, `dropdown()`, `checkbox()`, `textInput()` in code cells; `<audit-slider name="x">` in HTML cells defines reactive scope variables
- **markdown interpolation** -- `${expr}` in markdown and HTML cells, live-patched without destroying DOM
- **split view** -- side-by-side source + output editing (`e` in command mode)
- **autocomplete** -- fuzzy completion for JS globals, builtins, scope variables, and tagged language keywords
- **module system** -- `await load("https://esm.sh/d3")` for dynamic ESM imports; `install()` embeds the source (gzip-compressed) in the HTML so it works offline
- **binary assets** -- `installBinary()` embeds binary files (WASM, images, etc.) with gzip compression
- **atra** -- embedded language for compiling typed array kernels to WebAssembly, with split-view editor, syntax highlighting, and completions
- **language extensions** -- tagged template literals for GLSL shaders and SQL with syntax highlighting and completions
- **colormaps & color utilities** -- `std.viridis/magma/inferno/plasma/turbo`, `std.color()` with OKLAB/OKLCH, `std.colorScale()`
- **stdlib** -- `std.csv`, `std.sum`, `std.mean`, `std.linspace`, `std.bin`, `std.fmt`, and more
- **self-contained save** -- Ctrl+S produces a new HTML file with all code, state, settings, and installed modules baked in. the JS runtime is gzip-compressed for ~55% smaller files
- **packed save** -- gzip-compressed save format (compresses the entire HTML, including data blocks) with readable, self-documenting bootstrap loader
- **encryption** -- AES-256-GCM whole-notebook encryption with passphrase + recovery key. the file on disk is opaque without the passphrase. enable in settings, enter passphrase on load
- **Ed25519 signatures** -- sign notebooks for integrity verification
- **self-documenting format** -- every data block in saved HTML has a descriptive comment explaining what it is
- **find/replace** -- Ctrl+F to search across cells, with regex and case-sensitive modes
- **presentation mode** -- hide the editor, show the outputs. widgets still work. press `p`
- **copy/paste/cut cells** -- `c`/`v`/`x` in command mode
- **cell directives** -- `// %manual`, `// %hide`, `// %norun`, `// %cellName`, `// %goto`, `// %outputId`, `// %outputClass`
- **line numbers** -- toggleable in settings

## quick start

1. open `auditable.html` in a browser
2. write code in cells
3. Ctrl+S to save

that's it. email the file to someone. they open it. it runs.

**note:** Ctrl+S triggers auditable's own save (downloads a self-contained HTML file). on `file://`, some browsers intercept Ctrl+S before the page can handle it — use the **SAVE** button in the toolbar instead. when served over `http://`/`https://` (or inside Works), Ctrl+S works as expected.

## keyboard shortcuts

press **F1** inside the notebook for the full reference. highlights:

| mode | key | action |
|------|-----|--------|
| command | `j` / `k` | navigate cells |
| command | `a` / `b` | insert cell above / below |
| command | `dd` | delete cell |
| command | `z` | undo delete |
| command | `m` / `y` / `s` / `t` | convert to md / code / css / html |
| command | `h` | collapse cell |
| command | `e` | toggle split view |
| command | `c` / `v` / `x` | copy / paste / cut cell |
| command | `l` | toggle line numbers |
| command | `p` | presentation mode |
| edit | `Ctrl+Enter` | run cell |
| edit | `Shift+Enter` | run cell + advance |
| edit | `Ctrl+/` | toggle comment |
| global | `F1` | help overlay |
| global | `Ctrl+S` | save notebook |
| global | `Ctrl+F` | find / replace |

## builtins

```js
display(value)          // render text, objects, or DOM elements
canvas(w, h)            // create a canvas element in the output
table(data, columns?)   // render array of objects as a table
slider(label, default, {min, max, step, onInput, onChange})
dropdown(label, options, {onInput, onChange})
checkbox(label, default, {onInput, onChange})
textInput(label, default, {onInput, onChange})
load(url)               // dynamic ESM import (cached)
install(url)            // import + embed source in HTML on save
installBinary(url)      // embed binary asset (gzip + base64), returns blob URL
```

widgets accept `onInput` / `onChange` callbacks for real-time interaction without triggering DAG re-execution. ideal for animations, audio, and responsive visualizations.

## directives

```js
// %manual       — skip during reactive updates (only Ctrl+Enter or Run All)
// %hide         — hide cell in presentation mode
// %norun        — never auto-run this cell
// %cellName     — give the cell a display name
// %goto label   — jump to a named cell after execution
// %outputId id  — set an id on the cell's output div
// %outputClass  — add CSS classes to the cell's output div
```

## cell types

| cell | type | DAG role | defines | uses | key | label |
|------|------|----------|---------|------|-----|-------|
| code | code | reactive r/w | yes | yes | `y` | code |
| markdown | md | reactive read-only | no | yes | `m` | md |
| CSS | css | static side effect | no | no | `s` | css |
| HTML | html | reactive r/w | yes (widgets) | yes | `t` | html |

markdown cells support `${expr}` interpolation from upstream scope. HTML cells support the same interpolation plus `<audit-*>` widgets with `name` attributes that define reactive scope variables.

## modules

```js
// load from esm.sh -- works with any npm package
const d3 = await load("https://esm.sh/d3");
const { Stereonet } = await load("https://esm.sh/@gcu/bearing");

// install() fetches the source, gzip-compresses it, and embeds it in the HTML
// the notebook works offline after that
await install("https://esm.sh/peerjs");

// installBinary() for WASM, images, and other binary assets
// gzip-compressed by default (~60% smaller), returns a blob URL
const wasmUrl = await installBinary("https://example.com/module.wasm");
```

installed modules and binaries are managed in the settings panel -- view sizes, remove individual entries.

## language extensions

tagged template literals that register syntax highlighting and completions:

```js
// GLSL shaders -- Shadertoy-compatible with live hot-compile
await install("./ext/shader/index.js");
glsl`void mainImage(out vec4 O, in vec2 U) { O = vec4(U/iResolution.xy, 0, 1); }`

// SQL -- syntax highlighting + keyword completions (bring your own database engine)
await install("./ext/sql/index.js");
const result = sql`SELECT * FROM users WHERE age > 21`;
```

## settings

click the gear icon in the toolbar:

- **theme** -- dark (default) or light
- **editor font size** -- 10-20px
- **editor view** -- split (side-by-side source + output) or standard
- **notebook width** -- narrow / default / wide / full
- **cell header** -- auto / always / hover / compact
- **line numbers** -- on / off
- **execution mode** -- reactive (default) or manual
- **run on load** -- yes (default) or no
- **show run toggle** -- yes or no

- **encryption** -- enable AES-256-GCM encryption, change passphrase, regenerate recovery key, lock/unlock

settings travel with the file. execution mode can also be overridden globally via localStorage.

## examples

the `examples/` directory contains 81 self-contained notebooks organized by category. browse them live at [gentropic.org/auditable/examples](https://gentropic.org/auditable/examples/), or open any `.html` file directly -- no server required.

**basics/** -- core auditable features

| file | what it shows |
|------|---------------|
| `example_workshop` | workshop template for guided tutorials |
| `example_life` | conway's game of life -- imperative callbacks in a `// %manual` cell |
| `example_lorenz` | lorenz attractor with adjustable parameters and 3D rotation |
| `example_mandelbrot` | mandelbrot set explorer with zoom, pan, and color shift |
| `example_particles` | particle system with gravity and collision |
| `example_idw` | inverse distance weighting interpolation with viridis colormap |
| `example_dashboard` | multi-panel dashboard layout with CSS cells |
| `example_modules` | `install()` and `load()` with esm.sh modules |
| `example_python` | Python builtins (`range`, `enumerate`, `sorted`, etc.) in JS |
| `example_widgets` | `<audit-*>` widget components in HTML cells |
| `example_app_export` | export notebooks as standalone reactive apps |
| `example_md_interpolation` | `${expr}` interpolation in markdown cells |
| `example_encrypted_*` | pre-encrypted notebook (passphrase in filename, recovery key sidecar) |

**atra/** -- Wasm compiler

| file | what it shows |
|------|---------------|
| `example_atra` | variogram models with `call_indirect` function pointers |
| `example_atra_tour` | atra language tour -- syntax and features |
| `example_atra_v_julia` | animated Julia set fractal rendered in Wasm |
| `example_atra_layouts` | N-body gravity simulation with memory layouts |
| `example_atra_multi_memory` | columnar block model with separate memory banks |
| `example_atra_strings` | data segments, character literals, and string operations |
| `example_natra` | natra -- ndarray for the browser with Wasm kernels |

**calque/** -- spreadsheet language

| file | what it shows |
|------|---------------|
| `example_calque` | calque basics -- columns, formulas, xlsx export |
| `example_calque_advanced` | lookup, templates, reductions, layouts |
| `example_sheet` | interactive sheet widget |

**gslib/** -- geostatistics

| file | what it shows |
|------|---------------|
| `example_alpack` | ALPACK -- dense linear algebra + ordinary kriging |
| `example_alpack_atra` | atra + ALPACK -- all-Wasm RBF interpolation pipeline |
| `example_gslib_kb2d` | KB2D -- 2D kriging from GSLIB |
| `example_gslib_sgsim` | SGSIM -- sequential Gaussian simulation from GSLIB |

**gis/** -- spatial analysis

| file | what it shows |
|------|---------------|
| `example_spinifex` | web GIS with SRTM elevation, drawing, profiles |
| `example_raster` | terrain analysis -- slope, aspect, hillshade, curvature, contours |
| `example_hydrology` | drainage analysis -- fill sinks, flow direction, accumulation, watersheds |

**geology/** -- structural geology

| file | what it shows |
|------|---------------|
| `example_stereonet` | equal-area stereonet using `@gcu/bearing` |

**extensions/** -- language tags and browser APIs

| file | what it shows |
|------|---------------|
| `example_sql` | SQL queries with sql.js -- `installBinary()` for WASM, `@auditable/sql` for syntax |
| `example_shader` | GLSL fragment shaders with Shadertoy-compatible uniforms |

**etc/** -- standalone demos

| file | what it shows |
|------|---------------|
| `example_line` | `@gcu/line` -- pure-JS linear algebra (ndarray, broadcasting, SVD, QR, solve, eigSym) |
| `example_synth` | web audio synthesizer with keyboard UI |

## saved file format

saved notebooks carry a single VFS-dump comment block. cleartext:

```html
<!-- auditable notebook data: VFS dump (persistent mounts only) -->
<!--AUDITABLE-VFS
{ "/var/notebook.txt": { "type":"file","kind":"text","content":"/// auditable\n/// title: ..." },
  "/home/nb/data.csv": { ... },
  "/var/modules/lodash/source": { ... } }
AUDITABLE-VFS-->

<!-- Ed25519 signature: verify style+script content against pub key -->
<!--AUDITABLE-SIGNATURE
{"v":1,"sig":"...","pub":"...","alg":"Ed25519"}
AUDITABLE-SIGNATURE-->
```

modules are base64-encoded to avoid HTML comment parsing issues. JS modules are gzip-compressed before encoding (~74% savings). old notebooks with raw JSON or uncompressed modules still load (backward compatible).

the JS runtime is gzip-compressed in saved notebooks and examples. a small self-extracting loader decompresses and evals the runtime on load — data blocks, title, and HTML structure remain cleartext and human-readable. packed saves gzip the entire HTML (including data blocks) with a readable bootstrap loader.

the VFS dump covers the persistent mounts: `/home/nb/` (user files), `/var/notebook.txt` (cells + settings + module declarations in `///` form), `/var/modules/<url-encoded>/` (installed module bodies). volatile mounts (`/tmp/`, `/usr/lib/python/`) aren't serialized.

cells are persisted in the `///` text format documented at `examples/defs/FORMAT.md` — same format as the example definitions. legacy notebooks with the older 4-block format (`AUDITABLE-DATA` + `AUDITABLE-SETTINGS` + `AUDITABLE-MODULES` + `AUDITABLE-FS`) auto-import on load and self-upgrade to the new format on next save.

encrypted notebooks wrap the same VFS dump in a single AES-GCM blob:

```html
<!-- encrypted notebook data: passphrase required to access cells, settings, modules, files -->
<!--AUDITABLE-CRYPTO
{"version":1,"cipher":"AES-256-GCM","iv":"...","payload":"...","methods":[...]}
AUDITABLE-CRYPTO-->
```

the runtime stays cleartext (it's the application). the data is opaque without the passphrase. a recovery key (random 256-bit, grouped hex) is generated as backup. see `ext/crypto/SPEC.md` for the full cryptographic design.

## auditable works -- experimental

`works.html` is a workspace shell for managing multiple notebooks, similar to JupyterLab. open it in a browser to get a file tree, tab bar, and iframe-based notebook editing.

**features:**
- **multi-root workspace** -- open real directories (File System Access API, Chromium only) and virtual "boxes" (IndexedDB, all browsers) side by side
- **tab management** -- preview tabs (single-click), permanent tabs (double-click or edit), drag to reorder
- **postMessage bridge** -- Ctrl+S in a notebook saves back to the workspace (disk or box)
- **box export/import** -- export a box as a self-contained `works.html` file, import it elsewhere
- **localStorage shim** -- blob URL iframes get per-file storage backed by IndexedDB, so any single-file HTML app works
- **persistence** -- workspace roots, open tabs, sidebar width, and active tab restore on reload

**build:**
```
node build.js                    # builds auditable.html
node build.js --target=works     # builds works.html (requires auditable.html)
npm run build:works              # both
```

Works embeds the full auditable runtime, so new notebooks created inside Works are fully self-contained -- save one out and it works standalone.

**building a surface / interoperating:** to make a tool (in this repo or another GCU project) embed as a Works surface and brush/link with others, start at [`INTEROP.md`](INTEROP.md) -- the committed front door to the surface contract (`ext/surface/SPEC.md`), the authoring guide (`works/SURFACES.md`), and the A-Bus/VFS libs.

## calque -- spreadsheet language editor

`tools/calque/index.html` is a standalone editor for the calque spreadsheet language. write calque source, see a live spreadsheet grid, export to xlsx.

**features:**
- **canvas grid** -- interactive spreadsheet with cell selection, inline editing, copy/paste
- **live evaluation** -- 300ms debounced eval, results update in the grid as you type
- **project management** -- localStorage-backed projects with splash screen on launch
- **recent projects** -- splash screen shows recent projects with timestamps, File menu has recent section
- **built-in examples** -- Sales Report, Budget, Math, Strings
- **xlsx import/export** -- drag-drop .xlsx files onto the grid, export via File menu
- **floating editor** -- draggable, resizable CM6 editor window with calque syntax highlighting
- **template string highlighting** -- stateful stream tokenizer handles multi-line backtick strings
- **PWA** -- installable, works offline via service worker

**build:**
```
node build.js --target=calque    # builds tools/calque/index.html
```

**storage keys:** `cq-projects` (project index), `cq-project:<id>` (source text), `cq-active` (current project ID).

see `ext/calque/SPEC.md` for the calque language specification.

## how it works

cells declare variables with `const`, `let`, or `function`. the parser (`parseNames`) extracts top-level definitions -- including destructuring and comma-separated declarations -- and builds a dependency graph. when a cell changes, all downstream cells re-execute in topological order.

HTML cells define scope variables via `<audit-*>` widgets with `name` attributes. markdown and HTML cells support `${expr}` interpolation -- bound expressions are live-patched without destroying the DOM, so widgets and interactive elements survive upstream changes.

the scope is passed by value between cells via `AsyncFunction` constructors. mutable state that needs to survive across callbacks belongs in `// %manual` cells.

widgets are keyed by label. when a slider's value changes, the cell that created it re-executes, which triggers its dependents. the DAG handles the rest.

save serializes the persistent VFS mounts (cells, settings, installed modules, user files) as a single JSON dump in an HTML comment (`<!--AUDITABLE-VFS ... -->`). cells live in the `///` text format inside `/var/notebook.txt`. the JS runtime is gzip-compressed with a self-extracting loader. data stays cleartext for auditability. the browser is the runtime. the HTML is the lockfile.

## building

```
npm install                        # (nothing to install -- zero dependencies)
node build.js                      # concatenates src/ modules into auditable.html
node build.js --target=works       # builds works.html
node build.js --target=calque      # builds tools/calque/index.html
npm test                           # runs tests with node --test
```

to regenerate examples after changes:
```
node gen_examples.js
```

## philosophy

- the browser has everything: canvas, WebGL, WebGPU, WebAudio, WebRTC, Web Serial, IndexedDB
- a single file is the most portable artifact humans have invented since paper
- zero dependencies means zero supply chain risk
- if you can't email it, it's too complicated
- MIT license, software delivered as is

## roadmap

see `ROADMAP.md` for planned features and Works development.

## license

MIT

---

part of the [geoscientific chaos union](https://gentropic.org) -- by [endarthur](https://endarthur.github.io)
