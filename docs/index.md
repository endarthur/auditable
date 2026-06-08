# auditable

**A reactive computational notebook in a single HTML file — no server, no dependencies, no install.**

Open `auditable.html` in a browser. Write code. Press Ctrl+S. Email the file. The recipient opens it and everything runs. The HTML *is* the document, the runtime, and the lockfile.

Two flavors:

- **`auditable.html`** — a single notebook. One file, one tab, one document. Open it, work, save. The classic shape.
- **`works.html`** — [Auditable Works](works.md), a workspace shell. Hosts notebooks, a terminal (`geas`), a docs reader, file preview, A-Bus inspector, and other surfaces in a tabbed layout. Same single-file deployment story; broader scope.

## Notebook features

| Feature | Description |
|---|---|
| **Reactive DAG** | Cells track dependencies automatically. Change a value, and everything downstream updates. |
| **Four cell types** | Code, Markdown, CSS, and HTML — each with a distinct role in the notebook. |
| **Interactive widgets** | Sliders, dropdowns, checkboxes, and text inputs that drive reactive updates. |
| **Module system** | `load()` for session imports, `install()` for persistent embedding. Works offline after save. |
| **Self-contained save** | Ctrl+S produces a standalone HTML file with all code, data, and dependencies baked in. |
| **Packed export** | Gzip-compress the entire notebook into a minimal self-decompressing HTML loader. |
| **Encryption** | AES-256-GCM whole-notebook encryption with passphrase + recovery key. |
| **MCP bridge** | Connect Claude Code or other AI agents to a running notebook via WebSocket or HTTP. |
| **Notebook filesystem** | Embedded file storage (`notebook.fs`) that persists with the notebook. |
| **Plugin cell types** | Custom cell types beyond js/md/css/html via `registerExtension()`. |
| **Python cells** | [adder](adder/index.md) — a Python dialect with a pure JS interpreter, no server needed. |
| **Atra Wasm compiler** | Write Fortran/Pascal-style code that compiles to WebAssembly in the browser. |
| **AIR compiler** | Internal SSA IR backing every JS/Python/Soft cell — V8-hinted JS emission, 1.5–300× faster than naïve. |
| **Language extensions** | Tagged templates for GLSL shaders, SQL, soft, custom languages with syntax highlighting. |
| **Web Workers** | `worker()` and `workerPool()` for background computation with zero-copy transfers. |
| **Split view** | Side-by-side source and output editing mode. |
| **Headless runtime** | Run notebooks in Node.js without a browser via `createNotebook()`. |
| **GIS analysis** | [spinifex](mod-spinifex.md) module with maps, raster, DEM, and GDAL processing. |
| **Spreadsheet** | [calque](mod-calque.md) formula language + sheet widget with xlsx import/export. |
| **Presentation mode** | Hide cells, set output IDs and classes — turn a notebook into an app. |
| **Self-update** | Built-in Ed25519-verified updates — no reinstall, no package manager. |

## Works features

| Feature | Description |
|---|---|
| **Tabbed shell** | Notebook, terminal, docs reader, file preview, settings — all surfaces in a docked-tab layout ([@gcu/rails](https://github.com/gentropic/auditable/tree/main/ext/rails)). |
| **Workspace VFS** | One filesystem per workspace (IndexedDB or disk-folder via FSAA). All surfaces read/write the same tree. |
| **Disk-folder mounts** | Mount real folders at `/mnt/<name>` — direct OS read/write through the File System Access API. |
| **`geas` shell** | A real shell with `pkg` (package manager), `ed`, `readline`-edited input, plus the GCU coreutils. |
| **Docs surface** | In-tool documentation reader with Ctrl+K full-text search across the entire docs corpus + every `ext/*/SPEC.md` + every `ext/*/README.md`. |
| **A-Bus coordination** | Surfaces talk to each other and the shell via [@gcu/abus](https://github.com/gentropic/auditable/tree/main/ext/abus) — D-Bus-shaped IPC over MessagePorts. |
| **Workspace export** | Bundle the whole workspace (notebooks + files + settings) into one self-contained `.html`. |

**Learn more:** [Auditable Works](works.md) · [Encryption](encryption.md) · [MCP Bridge](mcp.md) · [Notebook Filesystem](filesystem.md) · [Plugins](plugins.md) · [adder (Python)](adder/index.md)

## Get auditable

Download `auditable.html` from the [GitHub repository](https://github.com/gentropic/auditable) — it's a single file, no install needed.

## Quick start

1. Open `auditable.html` in any modern browser (Chrome, Firefox, Edge).
2. Click the `+` button to create a code cell.
3. Type some JavaScript and press **Ctrl+Enter** to run it.
4. Press **Ctrl+S** to save — the file rewrites itself with your work embedded.

That saved file is the entire notebook. Share it, back it up, put it on a USB stick. No server required.

!!! tip "First time?"
    See the [Getting Started](getting-started.md) guide for a hands-on walkthrough.

## How it works

Every auditable notebook is a single `.html` file containing:

- **Inline CSS and JavaScript** — the full runtime, editor, and execution engine.
- **Cell data as JSON** — stored in HTML comments, parsed on load.
- **Installed modules** — base64-encoded and embedded, so imports work offline.

When you save, the file rewrites all of these blocks in place. When someone opens the file, the browser bootstraps everything from the HTML alone.

## Part of the Geoscientific Chaos Union

auditable is built by [Geoscientific Chaos Union](https://gentropic.org) (GCU). It started as a tool for computational geology and geospatial analysis, but works for any domain where you want a portable, reactive computing environment with zero infrastructure.
