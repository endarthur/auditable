# Export

The save tray in the toolbar (click the dropdown arrow next to the save button) offers
four export modes. Each produces a different output format suited to different workflows.

**Shortcut:** ++ctrl+s++ saves with the current mode (see [Keyboard Shortcuts](keyboard.md)).

## Save Modes

### Save — Self-Contained HTML

**Shortcut:** ++ctrl+s++

The default save mode. Produces a single `.html` file containing everything: code cells,
markdown, CSS, settings, installed modules, and the full auditable runtime. Open the file
in any browser to resume editing.

```
my_notebook.html  (~200–500 KB typical)
├── CSS styles
├── HTML template (toolbar, help, settings)
├── Cell data (JSON in HTML comment)
├── Installed modules (base64-encoded)
├── Settings (JSON in HTML comment)
└── JavaScript runtime
```

!!! info "Data format"
    Cell data, settings, modules, and the embedded filesystem are stored as
    a single JSON dump of the notebook's VFS, inside an HTML comment:
    `<!--AUDITABLE-VFS\n{...}\nAUDITABLE-VFS-->`. This keeps the data
    invisible to the browser while making the file fully self-contained.
    Older notebooks used a four-block split (DATA / SETTINGS / MODULES / FS);
    those auto-import on load and re-save in the new format. See [Save
    Format](advanced/save-format.md) for the full reference.

!!! info "Encrypted notebooks"
    When encryption is enabled, all data blocks are replaced by a single
    `AUDITABLE-CRYPTO` block. The `<title>` is masked to "Auditable — Encrypted"
    and module URLs in the settings panel are cleared. The runtime (HTML, CSS, JS)
    stays cleartext — only the data is encrypted.

---

### Save Packed — Compressed HTML

Gzip-compresses the entire notebook via `CompressionStream`, base64-encodes the result,
and wraps it in a self-decompressing HTML loader. Typically **~60% smaller** than a
normal save.

The packed file contains a minimal bootstrap script that:

1. Reads the base64 payload from a hidden `<pre>` element
2. Decodes base64 to binary
3. Decompresses via `DecompressionStream`
4. Replaces the page with the full notebook

!!! tip "When to use packed saves"
    Packed saves are ideal for sharing notebooks by email or uploading to
    file hosts where size matters. The notebook opens and behaves identically
    to a normal save — the "packed" badge in the toolbar is the only visible
    difference.

---

### Export .txt — Plain Text

Exports the notebook as a plain-text file using the `///` format (the same format used
for example definitions). This format is designed for version control and readable diffs.

```
/// auditable
/// title: My Analysis
/// settings: {"theme":"dark","fontSize":13}
/// module: ./ext/shader/index.js

/// md
# Introduction
This notebook demonstrates...

/// code
const data = [1, 2, 3, 4, 5];
const avg = std.mean(data);
ui.display(avg);

/// css
.custom { color: var(--accent); }
```

!!! note "Module references"
    The `.txt` export records module URLs but does not embed module source code.
    To recreate the notebook from a `.txt` file, the modules must be available
    at their original URLs (or pre-installed in the target environment).

---

### Export App — Standalone Web Application

Strips the editor, toolbar, settings panel, and help overlay. Emits a standalone HTML
application where:

| Cell Type | Becomes |
|---|---|
| CSS cells | `<style>` elements |
| HTML cells | Static markup with reactive bindings |
| Code cells | `<script>` blocks |
| Markdown cells | Rendered HTML content |

The export dialog lets you configure:

- **Title** — sets the `<title>` and filename
- **Include base styles** — when checked, includes auditable's full app stylesheet
  (dark theme, typography, widget styles). Uncheck for full CSS control.

#### Workflow Example

Here is a typical workflow for building and exporting a reactive web app:

**1. Create the layout (HTML cell):**
```html
<div class="app">
  <h1>Signal Generator</h1>
  <audit-slider name="freq" min="1" max="100" value="20">Frequency</audit-slider>
  <audit-slider name="amp" min="0" max="1" value="0.5" step="0.01">Amplitude</audit-slider>
  <div id="plot"></div>
</div>
```

**2. Add styling (CSS cell):**
```css
.app {
  max-width: 600px;
  margin: 0 auto;
  padding: 2rem;
}
.app h1 {
  font-family: monospace;
  color: #c89b3c;
}
```

**3. Add logic (code cell):**
```js
const canvas = ui.canvas(400, 200);
const ctx = canvas.getContext("2d");
ctx.clearRect(0, 0, 400, 200);
ctx.strokeStyle = "#c89b3c";
ctx.beginPath();
for (let x = 0; x < 400; x++) {
  const y = 100 + amp * 100 * Math.sin(x * freq * 0.01);
  x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
}
ctx.stroke();
document.getElementById("plot").replaceChildren(canvas);
```

**4. Export:** Save tray → **Export App** → configure title → download.

The result is a self-contained HTML file with reactive widgets — no auditable
editor, no toolbar, just the application.

!!! tip "The `// %bare` directive"
    Add `// %bare` to any code cell to signal that the notebook wants full control
    over styles. When present, the export dialog defaults to unchecking "include base
    styles", giving you a minimal CSS reset with only widget defaults.

---

## Ed25519 Signatures

Saved notebooks can be cryptographically signed with Ed25519 for integrity verification.

The signature is stored as an HTML comment at the end of the file:

```html
<!--AUDITABLE-SIGNATURE
{"v":1,"sig":"...","pub":"...","alg":"Ed25519"}
AUDITABLE-SIGNATURE-->
```

The signature covers the deterministic content of the notebook (style + script blocks),
so cell data and settings changes don't invalidate it — only runtime modifications do.

**Verification tools:**

- The built-in **update system** verifies signatures when downloading new versions
- The **[scan tool](https://endarthur.github.io/auditable/scan/)** is a standalone PWA
  for verifying signatures on any saved notebook

!!! info "Signing infrastructure"
    `keygen.js` generates Ed25519 keypairs, `sign.js` signs HTML files. The public
    key is injected at build time via `__AUDITABLE_PUBLIC_KEY__`.

---

## Self-Update

Auditable includes a built-in update system accessible from the toolbar overflow menu
(**...** → **update**). The update panel shows the current version, release type, and
signature status, and can:

- **Check for updates** — fetches `version.json` from the project site, downloads the
  new `auditable.html`, and verifies its Ed25519 signature before applying
- **Update from file** — paste or load a downloaded HTML file for offline updates

The update replaces the runtime (styles + script) while preserving your cell data,
settings, and installed modules.

---

## Works Workspace Integration

When a notebook runs inside an [Auditable Works workspace](works.md), saving works differently — instead of downloading a file, the notebook surface flushes via the [@gcu/abus](https://github.com/endarthur/auditable/tree/main/ext/abus) `Surface.Flush()` method, and the shell writes the result to the workspace VFS at the notebook's path. The Works shell then persists the workspace using its configured backend (IndexedDB or File System Access API).

The notebook detects the Works parent automatically — when the surface receives an `abus:welcome` from the shell, it switches save behavior to the A-Bus flush path. No user configuration needed. The legacy `works:*` postMessage bridge is retired.
