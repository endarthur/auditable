# auditable

**A reactive computational notebook in a single HTML file — no server, no dependencies, no install.**

Open `auditable.html` in a browser. Write code. Press Ctrl+S. Email the file. The recipient opens it and everything runs. The HTML *is* the document, the runtime, and the lockfile.

## Features

| Feature | Description |
|---------|-------------|
| **Reactive DAG** | Cells track dependencies automatically. Change a value, and everything downstream updates. |
| **Four cell types** | Code, Markdown, CSS, and HTML — each with a distinct role in the notebook. |
| **Interactive widgets** | Sliders, dropdowns, checkboxes, and text inputs that drive reactive updates. |
| **Module system** | `load()` for session imports, `install()` for persistent embedding. Works offline after save. |
| **Self-contained save** | Ctrl+S produces a standalone HTML file with all code, data, and dependencies baked in. |
| **Packed export** | Gzip-compress the entire notebook into a minimal self-decompressing HTML loader. |
| **Atra Wasm compiler** | Write Fortran/Pascal-style code that compiles to WebAssembly in the browser. |
| **Language extensions** | Tagged templates for GLSL shaders, SQL, and custom languages with syntax highlighting. |
| **Presentation mode** | Hide cells, set output IDs and classes — turn a notebook into an app. |

## Get auditable

Download `auditable.html` from the [GitHub repository](https://github.com/endarthur/auditable) — it's a single file, no install needed.

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
