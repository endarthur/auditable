# Save Format

Auditable notebooks are self-contained HTML files. All cell data, settings, and
installed modules are stored as JSON inside HTML comments, embedded directly in
the file before the `<script>` tag.

## Data Blocks

A saved notebook contains up to six data blocks (though CRYPTO replaces the others
when encryption is enabled):

```html
<!-- cell data: JSON array of {type, code, collapsed?} -->
<!--AUDITABLE-DATA
[{"type":"code","code":"const x = 1"},{"type":"md","code":"# Hello"}]
AUDITABLE-DATA-->

<!-- notebook settings -->
<!--AUDITABLE-SETTINGS
{"theme":"dark","width":"960px","autorun":true}
AUDITABLE-SETTINGS-->

<!-- installed modules (base64-encoded JSON) -->
<!--AUDITABLE-MODULES
eyJsb2Rhc2giOnsiY29kZSI6Ii8vIG1vZHVsZSBzb3VyY2UuLi4ifX0=
AUDITABLE-MODULES-->

<!-- embedded filesystem -->
<!--AUDITABLE-FS
{base64-encoded gzip data}
AUDITABLE-FS-->

<!-- Ed25519 signature -->
<!--AUDITABLE-SIGNATURE
{"v":1,"sig":"...","pub":"...","alg":"Ed25519"}
AUDITABLE-SIGNATURE-->
```

Each block is preceded by a descriptive HTML comment. The strip regexes use
`(?:<!-- [^\n]*-->\n)?` to optionally match these descriptions when removing
blocks during save.

### Block Details

| Block | Content | Required |
|-------|---------|----------|
| `AUDITABLE-DATA` | JSON array of cell objects (`type`, `code`, `collapsed`) | Yes |
| `AUDITABLE-SETTINGS` | JSON object with theme, width, font, autorun, etc. | Yes |
| `AUDITABLE-MODULES` | Base64-encoded JSON of installed modules | Only if modules installed |
| `AUDITABLE-FS` | Base64-encoded gzip of embedded filesystem JSON | Only if files stored |
| `AUDITABLE-SIGNATURE` | Ed25519 signature for update verification | Only for signed releases |
| `AUDITABLE-CRYPTO` | Encrypted blob replacing DATA/SETTINGS/MODULES/FS | Only if encrypted |

## Modules Encoding

The MODULES block uses base64 encoding rather than raw JSON for two reasons:

1. **HTML comment safety** — module source code can contain `--`, which is
   invalid inside HTML comments and would break the document structure.

2. **String.replace safety** — the `$'` sequence in JavaScript triggers a
   special replacement pattern in `String.replace()`, which would corrupt
   module content during save.

### Encoding

```js
// Encode: JSON → UTF-8 percent-encoding → base64, split into 76-char lines
const json = JSON.stringify(modules)
const b64 = btoa(unescape(encodeURIComponent(json)))
const lines = b64.match(/.{1,76}/g).join('\n')
```

### Decoding

```js
// Decode: strip whitespace → base64 → UTF-8 percent-decoding → JSON
const b64 = raw.replace(/\s/g, '')
const modules = JSON.parse(decodeURIComponent(escape(atob(b64))))
```

!!! note "Legacy compatibility"
    `decodeModules()` detects legacy raw JSON (content starts with `{`) and
    parses it directly, maintaining backward compatibility with older saves.

## AUDITABLE-FS

Embedded filesystem data. Stores files added via `notebook.fs` or the files panel.

```html
<!--AUDITABLE-FS
{base64-encoded gzip data}
AUDITABLE-FS-->
```

Files are stored as a JSON map of path → `{ data, type, compressed?, size, mtime }`.
The entire map is gzip-compressed and base64-encoded when beneficial.

## AUDITABLE-CRYPTO

When encryption is enabled, **all other data blocks** (DATA, SETTINGS, MODULES, FS)
are replaced by a single encrypted blob:

```html
<!--AUDITABLE-CRYPTO
{"version":1,"cipher":"AES-256-GCM","iv":"...","payload":"...","methods":[...]}
AUDITABLE-CRYPTO-->
```

The `methods` array contains independently wrapped copies of the Data Encryption Key
(DEK) — one per unlock method (passphrase, recovery key). The runtime stays cleartext;
only the data payload is encrypted.

See [Encryption](../encryption.md) for the full cryptographic design.

## Runtime Compression

Saved notebooks gzip-compress the JavaScript runtime into a
`<script type="text/plain" id="_rt">` base64 payload with a small self-extracting
loader. This reduces file size from ~1.2 MB to ~540 KB. The loader decompresses at
load time and evals the bootstrap script.

`buildNotebookHtml({ compress: false })` skips compression (used by packed saves,
which compress the entire file instead).

## Save Modes

### Normal Save

`saveNotebook()` produces a fully self-contained HTML file. It reads static DOM
elements (help overlay, settings panel, statusbar) via `outerHTML` to avoid
duplicating template markup in JavaScript.

The output structure:

```
<!DOCTYPE html>
<html>
<head>...</head>
<body>
  <!-- descriptive comment -->
  <!--AUDITABLE-DATA\n...\nAUDITABLE-DATA-->
  <!-- descriptive comment -->
  <!--AUDITABLE-SETTINGS\n...\nAUDITABLE-SETTINGS-->
  <!-- descriptive comment (if modules present) -->
  <!--AUDITABLE-MODULES\n...\nAUDITABLE-MODULES-->
  <!-- static DOM elements -->
  <style>...</style>
  <script>...</script>
</body>
</html>
```

### Packed Save

`savePackedNotebook()` compresses the entire notebook for smaller file size:

1. Serialize the full notebook HTML
2. Gzip-compress via `CompressionStream`
3. Encode as base64
4. Wrap in a minimal self-decompressing HTML loader

The packed format is detected on load via a `<meta name="auditable-packed">`
tag. The toolbar shows a "packed" badge when viewing a packed notebook.

!!! tip "When to use packed saves"
    Packed saves are useful for notebooks with large installed modules or
    binary assets. The gzip compression can reduce file size significantly.
    Normal saves are better for readability and version control diffs.

## The .txt Definition Format

Example definitions and lightweight notebook interchange use a plain-text
format with `///` comment delimiters:

```
/// auditable
/// title: My Notebook
/// settings: {"theme":"dark"}

/// code
const data = [1, 2, 3]
const total = data.reduce((a, b) => a + b, 0)

/// md
# Results
The total is ${total}.

/// code // %manual
ui.display("This cell runs manually")
```

### Structure

| Line | Purpose |
|------|---------|
| `/// auditable` | Magic first line (required) |
| `/// title: ...` | Notebook title |
| `/// settings: {...}` | JSON settings object |
| `/// module: name url` | Module to install at build time |
| `/// code` | Start of a code cell |
| `/// md` | Start of a markdown cell |
| `/// css` | Start of a CSS cell |
| `/// html` | Start of an HTML cell |

Cell content follows the type marker and continues until the next `///` marker
or end of file. Directives like `// %manual` can be appended to the type
marker line.

See `examples/defs/FORMAT.md` for the full format specification.

## Signature Verification

Signed notebooks include an `AUDITABLE-SIGNATURE` block with an Ed25519
signature. The update system uses this to verify that downloaded updates are
authentic:

```json
{
  "v": 1,
  "sig": "base64-encoded-signature",
  "pub": "base64-encoded-public-key",
  "alg": "Ed25519"
}
```

Verification extracts the deterministic signed content (style + script) and
checks the signature via the Web Crypto API. The public key is injected at
build time as `__AUDITABLE_PUBLIC_KEY__`.
