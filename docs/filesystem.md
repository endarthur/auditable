# Notebook Filesystem

Every notebook has an embedded filesystem accessible via `notebook.fs`. Files are stored inside the notebook HTML and persist across saves — no server, no external storage.

---

## Writing and reading files

```js
// write a text file
await notebook.fs.write("data/points.csv", "x,y\n1,2\n3,4");

// read it back as text
const csv = await notebook.fs.read("data/points.csv");

// write binary data
const response = await fetch("image.png");
const buffer = await response.arrayBuffer();
await notebook.fs.write("assets/image.png", buffer);

// read as binary
const bytes = await notebook.fs.read("assets/image.png", "binary");
```

`write()` accepts strings, ArrayBuffers, TypedArrays, Blobs, canvas elements, ImageData, and plain objects (serialized as JSON).

---

## API reference

| Method | Returns | Description |
|--------|---------|-------------|
| `write(path, content, opts?)` | `{ path, size, compressedSize }` | Write a file |
| `read(path, format?)` | `*` | Read a file — format auto-detected from MIME type |
| `list(pattern?)` | `object[]` | List files, optionally filtered by prefix or glob |
| `glob(pattern)` | `string[]` | List file paths matching a glob pattern |
| `delete(path, opts?)` | `boolean` | Delete a file or folder |
| `rename(oldPath, newPath)` | `boolean` | Rename or move a file or folder |
| `copy(src, dest)` | `{ path, size }` | Copy a file or folder |
| `stat(path)` | `object \| null` | File metadata: `{ path, type, size, compressedSize }` |
| `exists(path)` | `boolean` | Check whether a file exists |
| `clear()` | `number` | Delete all files, returns count removed |
| `size` | `number` | Total bytes used (getter, not a function) |
| `import(opts?)` | `string \| string[]` | Open a file picker and import files |
| `export(path)` | `void` | Download a file, folder (as zip), or glob match |

### Read formats

The second argument to `read()` selects the return type. When omitted, text
types (csv, json, txt, js, html, etc.) return a string; binary types return a
`Uint8Array`.

| Format | Returns | Description |
|--------|---------|-------------|
| `"text"` | `string` | UTF-8 decoded string |
| `"binary"` | `Uint8Array` | Raw bytes |
| `"json"` | `object` | Parsed JSON |
| `"blob"` | `Blob` | Blob with correct MIME type |
| `"url"` | `string` | Object URL (revoke when done) |

```js
const data = await notebook.fs.read("config.json", "json");
const url = await notebook.fs.read("photo.jpg", "url");
```

---

## Glob patterns

`glob()` supports `*` (any characters within a directory), `**` (any depth), and `?` (single character):

```js
const csvFiles = await notebook.fs.glob("data/*.csv");
const allImages = await notebook.fs.glob("**/*.png");
```

`list()` also accepts glob patterns — it returns objects with `{ path, type, size }` instead of bare path strings.

---

## Path rules

Paths are always relative — no leading `/`, no `..` segments, no empty path components.

```js
// valid
await notebook.fs.write("data/file.csv", content);
await notebook.fs.write("readme.txt", content);

// invalid — will throw
await notebook.fs.write("/data/file.csv", content);   // leading /
await notebook.fs.write("../file.csv", content);       // .. traversal
```

!!! warning
    Paths must not start with `/` or contain `..` segments. These restrictions
    prevent directory traversal and keep the filesystem sandboxed within the
    notebook.

---

## Compression

Files are automatically gzip-compressed when it reduces size. Already-compressed formats (PNG, JPEG, WebP, GIF, ZIP, gzip, WASM) are stored as-is. MIME types are auto-detected from the file extension.

!!! info "Storage overhead"
    Files are base64-encoded in the HTML, which adds ~33% overhead. Gzip
    compression typically more than offsets this for text-based formats, but
    binary files that are already compressed will be slightly larger than their
    original size.

---

## Import and export

`import()` opens a native file picker and writes the selected files directly into the filesystem:

```js
// import a single file
const path = await notebook.fs.import();

// import multiple files into a folder
const paths = await notebook.fs.import({ multiple: true, prefix: "data/" });

// import and unzip
const paths = await notebook.fs.import({ unzip: true, prefix: "assets/" });
```

`export()` downloads a file, or zips and downloads a folder or glob match:

```js
// download a single file
await notebook.fs.export("data/results.csv");

// download a folder as a zip
await notebook.fs.export("data/");

// download matching files as a zip
await notebook.fs.export("**/*.csv");
```

---

## Files panel

The files panel (accessible from the toolbar) provides a visual file manager:

- **Browse** the directory tree with breadcrumb navigation
- **Expand/collapse** folders inline
- **Right-click** files for context actions: copy read command, copy path, rename, download, delete
- **Right-click** folders to import files, download as zip, rename, or delete
- **Import** button at the top to add files via file picker

!!! tip
    Use `notebook.fs` to bundle datasets, images, or configuration files
    directly inside your notebook — no external dependencies needed.

---

## Persistence

Files are stored in an `AUDITABLE-VFS` comment block inside the notebook HTML (the unified-VFS save format introduced in 2026). They save with the notebook and survive copy/paste, email, or any other way you move the HTML file. When encryption is enabled, the filesystem is included in the encrypted payload — no cleartext `AUDITABLE-VFS` block is written.

Legacy notebooks (the older 4-block `AUDITABLE-FS` + `AUDITABLE-DATA` + `AUDITABLE-SETTINGS` + `AUDITABLE-MODULES` format) auto-import on load — the runtime detects the legacy blocks, rehydrates the VFS, and writes the new single-block format on the next save. The migration is transparent.

---

## VFS layout

`notebook.fs` is the user-facing API; behind it sits a [@gcu/vfs](https://github.com/endarthur/auditable/tree/main/ext/vfs) instance with several mounts:

| Mount | Persistent? | Contents |
|---|---|---|
| `/home/nb/` | yes | User files — what `notebook.fs.write(path, data)` writes to |
| `/var/` | yes | Notebook state — cells, settings, installed modules. Internal. |
| `/tmp/` | no | Volatile scratch — cleared on reload |
| `/usr/lib/python/` | no | Python stdlib (adder repopulates on load) |

The `notebook.fs.write('foo.txt', ...)` call writes to `/home/nb/foo.txt`. Paths without a leading slash are relative to `/home/nb/`; absolute paths address the unified VFS directly.

In [Auditable Works](works.md), the workspace VFS has a different layout (`/home`, `/mnt/<name>`, `/tmp`, `/usr/lib`) — Works surfaces talk to the *workspace* VFS over A-Bus, not the per-notebook `notebook.fs`. Inside a Works-hosted notebook, `notebook.fs` still works (it operates on the notebook's own `/home/nb/`), but the broader workspace is also reachable via the workspace VFS API.

---

---

## MCP integration

MCP agents can access the filesystem via `fsList`, `fsRead`, `fsWrite`, and `fsDelete` tools. Access requires `// %mcp fs` directives:

```js
// %mcp fs data/
// Agent can read/write files under data/

// %mcp fs:read config/
// Agent can read (but not write) files under config/

// %mcp fs *
// Agent has full filesystem access
```

See [MCP Bridge](mcp.md) for details on agent filesystem access.
