# Save Format

Auditable notebooks are self-contained HTML files. Cell data, settings, installed modules, and the embedded filesystem are all stored as a single JSON dump of the notebook's VFS, embedded in an HTML comment before the runtime script.

## Data blocks

A saved notebook has either an `AUDITABLE-VFS` block (cleartext) or an `AUDITABLE-CRYPTO` block (encrypted). Both may be followed by an `AUDITABLE-SIGNATURE` block for signed releases.

```html
<!-- auditable notebook data: VFS dump (persistent mounts only) -->
<!--AUDITABLE-VFS
{"/var/notebook.txt": "...", "/home/nb/data.csv": "...", "/var/modules/...": "..."}
AUDITABLE-VFS-->

<!-- Ed25519 signature (signed releases only) -->
<!--AUDITABLE-SIGNATURE
{"v":1,"sig":"...","pub":"...","alg":"Ed25519"}
AUDITABLE-SIGNATURE-->
```

When encryption is enabled, the VFS dump is wrapped in a single encrypted blob:

```html
<!-- auditable notebook data: encrypted VFS -->
<!--AUDITABLE-CRYPTO
{"version":1,"cipher":"AES-256-GCM","iv":"...","payload":"...","methods":[...]}
AUDITABLE-CRYPTO-->
```

The block must appear before the runtime `<script>` tag so it's in the DOM when `init()` runs.

### Block reference

| Block | Content | When |
|---|---|---|
| `AUDITABLE-VFS` | JSON dump of persistent VFS mounts (`/home/nb/`, `/var/`) | Cleartext saves |
| `AUDITABLE-CRYPTO` | Encrypted blob replacing the VFS block | Encrypted saves |
| `AUDITABLE-SIGNATURE` | Ed25519 signature over the deterministic content | Signed release builds |

## VFS layout in the saved dump

The runtime's persistent VFS has two mounts that get serialized:

| Mount | Contents |
|---|---|
| `/home/nb/` | User files — the `notebook.fs` API writes here |
| `/var/` | Notebook state — `/var/notebook.txt` holds cells + settings + module declarations in `///` form; `/var/modules/<url-encoded>/{source,meta.json}` holds installed modules |

Volatile mounts (`/tmp/`, `/usr/lib/python/`) aren't serialized — they regenerate on load.

### Dump format

Each entry is keyed by absolute path. Two shapes:

```json
{
  "/var/notebook.txt": {
    "type": "file",
    "kind": "text",
    "content": "/// auditable\n/// title: My Notebook\n...",
    "size": 1234
  },
  "/home/nb/data.csv": {
    "type": "file",
    "kind": "binary",
    "content": "<base64-encoded bytes>",
    "size": 5678
  },
  "/home/nb/empty-dir/": {
    "type": "directory"
  }
}
```

The walker tries a strict UTF-8 decode at dump time — bytes that round-trip cleanly become `kind: "text"` entries (`content` is the string), others become `kind: "binary"` (`content` is base64).

Module URLs in `/var/modules/` are `encodeURIComponent`-encoded — `@gcu/adder` becomes `%40gcu%2Fadder`.

## `/var/notebook.txt` — cells + settings + modules

The notebook's cells, settings, and module declarations live in `/var/notebook.txt` using the `///` plain-text format:

```
/// auditable
/// title: My Notebook
/// settings: {"theme":"dark","width":"860px","autorun":true}
/// module: @gcu/sql ext/sql/index.js

/// code
const data = [1, 2, 3]
const total = data.reduce((a, b) => a + b, 0)

/// md
# Results
The total is ${total}.

/// code // %manual
ui.display("This cell runs manually")
```

This is the same format as `examples/defs/**/*.txt`. Human-readable, diff-friendly, no JSON escaping needed for code bodies — the format is "split on `///` lines, content between markers is verbatim."

See [`examples/defs/FORMAT.md`](https://github.com/endarthur/auditable/blob/main/examples/defs/FORMAT.md) for the full grammar.

### Why not raw JSON?

The earlier four-block format (`AUDITABLE-DATA` + `AUDITABLE-SETTINGS` + `AUDITABLE-MODULES` + `AUDITABLE-FS`) used JSON. The unified-VFS save format moved cells to the `///` plain-text form because:

1. **Diffs read.** Two cell-source changes produce a diff that highlights the changed lines, not a re-encoded JSON string.
2. **No double escape.** A JS template literal in a code cell doesn't need JSON-escaping of its `${` and `}` and backticks. The format is just bytes.
3. **One source of truth.** The example notebooks and saved notebooks share the same format — same parser, same writer.

## Legacy four-block format

Older notebooks (pre-2026) used a four-block split: `AUDITABLE-DATA` + `AUDITABLE-SETTINGS` + `AUDITABLE-MODULES` + `AUDITABLE-FS`. The runtime detects this on load via `importLegacyFormat()`, rehydrates into the VFS, and writes the new single-block format on next save. Migration is one-time and transparent — open an old notebook, save it, you have a current notebook.

The legacy format is documented in git history but no new notebooks should be produced in that shape.

## `AUDITABLE-CRYPTO`

When encryption is enabled, **the entire VFS dump** (cells, settings, modules, filesystem) is encrypted as one AES-256-GCM blob:

```json
{
  "version": 1,
  "cipher": "AES-256-GCM",
  "iv": "<base64>",
  "payload": "<base64-encoded ciphertext>",
  "methods": [
    {"type": "pbkdf2", "salt": "...", "iterations": 600000, "wrapped": "..."},
    {"type": "recovery", "salt": "...", "wrapped": "..."}
  ]
}
```

The `methods` array contains independently wrapped copies of the Data Encryption Key (DEK) — one per unlock method (passphrase, recovery key). Unlocking with any method recovers the same DEK and decrypts the payload.

The runtime stays cleartext. Only the data payload is encrypted. See [Encryption](../encryption.md) for the full cryptographic design.

## Runtime compression

Saved notebooks gzip-compress the JavaScript runtime into a `<script type="text/plain" id="_rt">` base64 payload with a small self-extracting loader. This reduces file size from ~1.2 MB to ~540 KB. The loader decompresses at load time and evals the bootstrap.

```js
buildNotebookHtml({ compress: false })   // skip runtime compression
```

is used by packed saves (which compress the entire file separately) and by the `--no-compress` build flag for development.

## Save modes

### Normal save

`saveNotebook()` produces a fully self-contained HTML file. Reads static DOM elements (help overlay, settings panel, statusbar) via `outerHTML` to avoid duplicating template markup in JavaScript. The runtime is gzip-compressed (~540 KB total file size); data blocks, title, and HTML structure remain cleartext.

```
<!DOCTYPE html>
<html>
<head>...</head>
<body>
  <!-- auditable notebook data: VFS dump -->
  <!--AUDITABLE-VFS\n...\nAUDITABLE-VFS-->
  <!-- static DOM elements -->
  <style>...</style>
  <script type="text/plain" id="_rt">...base64 runtime...</script>
  <script>...self-extracting loader...</script>
</body>
</html>
```

### Packed save

`savePackedNotebook()` compresses the *entire* notebook:

1. Serialize the full notebook HTML (no runtime compression — we'll do whole-file compression instead).
2. Gzip-compress via `CompressionStream`.
3. Encode as base64.
4. Wrap in a minimal self-decompressing HTML loader.

Packed format is detected on load via a `<meta name="auditable-packed">` tag. The toolbar shows a "packed" badge when viewing a packed notebook.

!!! tip "When to use packed saves"
    Packed saves are useful for notebooks with large installed modules or binary assets. The whole-file gzip compresses better than the per-block compression normal saves use. Normal saves are better for readability and version control diffs.

### Export .txt

`exportAsTxt()` exports the notebook as a plain-text `///` format file — the same shape as `/var/notebook.txt` in the saved HTML. Useful for diffing, scripting, or shipping notebooks alongside source code.

### Export app

`doExportApp()` strips the editor, toolbar, settings, help overlay, insert bars, DAG engine, and save system. CSS cells become `<style>` blocks; evaluated HTML cells become static markup; code cells become `<script>`. The output is a real app, not a notebook — no `Ctrl+S` to re-save, no DAG, just the rendered output.

`// %bare` on a cell opts that cell out of base styles in the exported app.

## Persistence model — write on save only

Persistence is **write-on-save-only**. No DOM mutation between user-initiated saves. Settings, edits, and module installs all stay in memory until the user clicks Save (or `Ctrl+S`).

The earlier "live sync to DOM comment nodes for native Ctrl+S" pattern is retired (browsers save the page as MHTML or stale-DOM, and never produced a working file in practice on `file://` URLs).

## Signature verification

Signed notebooks include an `AUDITABLE-SIGNATURE` block with an Ed25519 signature:

```json
{
  "v": 1,
  "sig": "<base64-encoded signature>",
  "pub": "<base64-encoded public key>",
  "alg": "Ed25519"
}
```

The update system uses this to verify downloaded updates are authentic. Verification extracts the deterministic signed content (style + script) and checks the signature via the Web Crypto API. The public key is injected at build time as `__AUDITABLE_PUBLIC_KEY__`.

See `keygen.js` (generates the signing keypair) and `sign.js` (signs a built `auditable.html`) for the signing toolchain.

## See also

- [`examples/defs/FORMAT.md`](https://github.com/endarthur/auditable/blob/main/examples/defs/FORMAT.md) — the `///` plain-text format spec.
- [Encryption](../encryption.md) — what the `AUDITABLE-CRYPTO` block contains.
- [Notebook Filesystem](../filesystem.md) — what gets serialized into the `/home/nb/` portion of the VFS dump.
- [Export](../export.md) — save modes, packed export, app export, signatures.
