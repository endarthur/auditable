# @gcu/vfs

a virtual filesystem for the browser. zero dependencies, single file, works on `file://`.

## motivation

browser storage is fragmented: IndexedDB works everywhere but is slow and awkward, OPFS is fast but HTTPS-only, the File System Access API gives real disk access but is Chromium-only, and localStorage is too small for real data. every GCU tool that needs to store files ends up writing its own storage layer.

`@gcu/vfs` provides a single path-string API (`readFile`, `writeFile`, `readdir`, `stat`) backed by pluggable backends and a mount table that composes them into a unified directory tree. the library auto-detects what the browser supports and configures sensible defaults. it is small enough to inline in a single-file HTML application.

born from auditable's `notebook.fs` (comment-backed storage in HTML) and koma's `vfs-lite` (IndexedDB virtual filesystem). designed to work on `file://` — the constraint that eliminates OPFS-only solutions and makes IndexedDB the universal fallback.

## design principles

- **path strings, not handles.** `vfs.readFile("/data/points.csv")`, not handle chains. internally the library resolves paths to the appropriate backend.
- **pluggable backends.** each backend implements a small interface. the mount table routes paths to backends.
- **works on `file://`.** every configuration must have a fallback that works without a server. OPFS and FSAA are opt-in upgrades, not requirements.
- **zero dependencies.** the entire library is vanilla JS with no imports beyond browser APIs.
- **thread-agnostic core.** the VFS core has no DOM dependencies. it works on the main thread, in Web Workers (via `@gcu/proc`), and in Node (with shims). DOM-dependent helpers (`toURL`, `fromDrop`, `fromPicker`) live in a separate `@gcu/vfs/dom` module.
- **async-first.** all operations return promises. no synchronous API (the sync OPFS path is internal to the OPFS backend's worker, not exposed).
- **mount anything.** any object that implements the backend interface can be mounted. the built-in backends are not special — they implement the same contract as a custom backend. this is FUSE for the browser.

## API

### initialization

```js
import { VFS } from "@gcu/vfs";

// auto-detect: OPFS if secure context, else IndexedDB, memory fallback
const vfs = await VFS.create();

// explicit configuration
const vfs = await VFS.create({
  backends: {
    "/": { type: "memory" },
    "/home": { type: "idb", name: "my-app" },
    "/data": { type: "opfs" },          // silently falls back to idb if unavailable
    "/disk": { type: "fsaa", handle },   // File System Access API directory handle
  }
});

// single backend, no mount table
const vfs = await VFS.create({ type: "idb", name: "my-app" });

// mount any object that implements the backend interface (FUSE-like)
const vfs = await VFS.create({
  backends: {
    "/": { type: "memory" },
    "/api": {
      type: "custom",
      async readFile(path) { return (await fetch(`https://api.example.com${path}`)).text(); },
      async stat(path) { return { type: "file", size: 0, created: new Date(), modified: new Date() }; },
      async readdir() { return []; },
      readonly: true,
    }
  }
});
```

`VFS.create()` is async because some backends need initialization (IndexedDB open, OPFS root handle, etc.).

### filesystem operations

```js
// read/write
const text = await vfs.readFile("/data/points.csv");              // string
const bytes = await vfs.readFile("/data/model.bin", "bytes");     // Uint8Array
await vfs.writeFile("/data/points.csv", csvString);               // string
await vfs.writeFile("/data/model.bin", uint8array);               // Uint8Array

// directories
await vfs.mkdir("/data/project");
await vfs.mkdir("/data/project/drillholes", { recursive: true }); // mkdir -p
const entries = await vfs.readdir("/data");                        // ["points.csv", "project"]
const detailed = await vfs.readdir("/data", { stat: true });       // [{name, type, size, modified}]

// metadata
const info = await vfs.stat("/data/points.csv");
// { type: "file", size: 1234, created: Date, modified: Date }
const info = await vfs.stat("/data/project");
// { type: "directory", ... }

// delete
await vfs.unlink("/data/points.csv");
await vfs.rmdir("/data/project");                                  // must be empty
await vfs.rm("/data/project", { recursive: true });                // rm -rf

// rename/move
await vfs.rename("/data/old.csv", "/data/new.csv");

// existence
const exists = await vfs.exists("/data/points.csv");               // boolean

// copy
await vfs.cp("/data/points.csv", "/backup/points.csv");
await vfs.cp("/data/project", "/backup/project", { recursive: true });

// touch — create empty file or update mtime
await vfs.touch("/data/new.csv");              // creates if missing, updates mtime if exists

// symlinks
await vfs.symlink("/data/latest.csv", "/data/points.csv");  // create symlink
const target = await vfs.readlink("/data/latest.csv");       // → "/data/points.csv"
const info = await vfs.lstat("/data/latest.csv");            // stat the link itself, not the target
// { type: "symlink", target: "/data/points.csv", ... }
// vfs.stat() follows symlinks by default; vfs.lstat() does not
```

**cross-mount `rename` atomicity:** `rename` across mount boundaries is implemented as copy+delete — not atomic. if the copy succeeds but the delete fails, a duplicate exists. if the copy fails partway, the VFS attempts to clean up the partial destination. consumers should prefer `cp` + `unlink` with explicit error handling for critical cross-mount moves.

**concurrency:** the VFS uses last-write-wins semantics with no locking. concurrent `writeFile` calls to the same path are not serialized — the last one to complete determines the file's content. this is acceptable for single-threaded browser use. with `@gcu/proc` workers accessing the VFS concurrently, consumers must coordinate writes at the application level. future versions may add an optional advisory locking API.

### streaming I/O

`readFile` and `writeFile` load entire files into memory. for large files (multi-MB CSVs, binary datasets, WASM modules), streaming avoids the memory spike.

streaming is **native-only** — only backends with real streaming support (OPFS, FSAA, fetch) implement it. backends without native streaming (memory, idb, comment) don't pretend — `createReadStream` returns `null` and the VFS falls back to `readFile` at the call site. no simulated single-chunk iterables wrapping a full read.

```js
// read as an async iterable of chunks (returns null if backend doesn't support it)
const stream = vfs.createReadStream("/data/big.csv");
if (stream) {
  for await (const chunk of stream) {
    process(chunk);  // chunk: string (default) or Uint8Array (encoding: "bytes")
  }
} else {
  // fallback: non-streaming backend
  process(await vfs.readFile("/data/big.csv"));
}

// write via writer (imperative interface)
const writer = await vfs.createWriter("/data/output.csv");
writer.write("header\n");
writer.write("row1\n");
writer.write("row2\n");
await writer.close();

// convenience: write from any iterable
await vfs.writeFrom("/data/output.csv", async function* () {
  yield "x,y,z,grade\n";
  for (const row of computeRows()) {
    yield `${row.x},${row.y},${row.z},${row.grade}\n`;
  }
}());
```

**backend support for streaming:**

| backend | read stream | write stream | notes |
|---------|------------|-------------|-------|
| memory | no | no | data is in memory — use `readFile`/`writeFile` |
| idb | no | no | IndexedDB reads/writes are atomic |
| opfs | native | native | `getFile().stream()` for read; `createWritable()` for write |
| fsaa | native | native | same as OPFS |
| comment | no | no | small data, streaming is overhead |
| fetch | native | N/A (read-only) | `fetch().body` is a `ReadableStream` |
| rest | native (read) | chunked PUT (if server supports) | |
| overlay | delegates to active layer | delegates to upper | |

**chunk size:** native streaming backends use a default chunk size of 64KB, configurable via `{ chunkSize: N }` on `createReadStream`.

**integration with coreutils:**

streaming VFS reads are what make coreutils streaming pipelines efficient:

```sh
cat /data/huge.csv | head -1
```

`cat` calls `vfs.createReadStream`. if the backend supports it, chunks stream lazily — `head` takes one line and returns, the read stream is abandoned, the backend aborts the underlying read (OPFS/FSAA close the handle, fetch aborts the request). if the backend doesn't support streaming, `cat` falls back to `readFile` — still correct, just loads the whole file. coreutils `forEachLine()` handles both paths transparently.

without VFS streaming, `cat` would call `vfs.readFile` (loading the entire file into memory), then yield lines from the string. the coreutils pipe would still tear down early, but the file is already fully read. VFS streaming moves the laziness one layer deeper — into the storage itself.

### mount operations

```js
// mount at runtime
await vfs.mount("/disk", { type: "fsaa", handle: dirHandle });
vfs.unmount("/disk");

// list mounts
vfs.mounts();
// [{ path: "/", type: "memory" }, { path: "/home", type: "idb" }, ...]

// resolve which backend owns a path
vfs.resolve("/home/data/file.txt");
// { backend: IDBBackend, subpath: "/data/file.txt", mount: "/home" }
```

### storage estimates

```js
const usage = await vfs.estimate("/home");
// { used: 4200000, available: 52428800, backend: "idb" }

const usage = await vfs.estimate("/");
// { used: 1340, available: Infinity, backend: "memory" }
```

delegates to the underlying backend. idb and opfs use `navigator.storage.estimate()` (shared quota — the numbers reflect the whole origin, not just this VFS). memory returns `Infinity` available. comment returns the byte length of all comment nodes for `used`, `Infinity` available (the real limit is "how big an HTML file are you willing to tolerate"). fetch returns `0` used, `Infinity` available (read-only, nothing stored). fsaa returns `used` from recursive `stat` and `available` from `navigator.storage.estimate()` (approximation — the real disk might have more or less).

useful for the "redirect large files to overflow" decision: if `estimate("/").used > threshold`, warn the user or auto-route to a different mount.

### glob / find

```js
const csvFiles = await vfs.glob("/data/**/*.csv");
// ["/data/collars.csv", "/data/assays/au.csv", "/data/survey/coords.csv"]

const allFiles = await vfs.glob("/data/**/*");
// every file under /data, recursively

const topLevel = await vfs.glob("/data/*.json");
// only JSON files directly in /data, not subdirectories
```

minimal glob implementation. supports:

- `*` — matches any characters within a single path segment (no `/`)
- `**` — matches zero or more path segments (recursive descent)
- `?` — matches a single character

no brace expansion, no character classes, no negation. this covers ~95% of real usage with ~40 lines of code. implemented as recursive `readdir` + path matching at the VFS level (not delegated to backends).

returns full absolute paths, sorted lexicographically. empty array if no matches (not an error).

### backend capabilities

```js
const caps = vfs.capabilities("/home");
// {
//   type: "idb",
//   persistent: true,      // survives page reload
//   writable: true,        // supports write operations
//   streamable: false,     // createReadStream/createWriter are native
//   estimatable: true,     // estimate() returns meaningful numbers
//   exportable: true,      // export() works
//   portable: false,       // data travels with the document (only comment backend)
//   symlinks: false,       // symlink/readlink/lstat supported
// }

const caps = vfs.capabilities("/data");
// { type: "comment", persistent: true, writable: true,
//   streamable: false, estimatable: true, exportable: true, portable: true, symlinks: false }

const caps = vfs.capabilities("/disk");
// { type: "fsaa", persistent: true, writable: true,
//   streamable: true, estimatable: true, exportable: true, portable: false, symlinks: false }

const caps = vfs.capabilities("/remote");
// { type: "fetch", persistent: false, writable: false,
//   streamable: true, estimatable: false, exportable: false, portable: false, symlinks: false }
```

returns a capabilities object for the backend that owns the given path. the VFS resolves the path to a mount point and queries the backend. backends declare their capabilities as static properties.

the `portable` flag is unique to the comment backend — it means "this data survives being saved and emailed as an HTML file." other backends are origin-bound or handle-bound. UIs can use this to show badges ("embedded", "local only", "read-only") or to warn when the user writes large data to a non-portable mount.

### events

```js
vfs.on("mount", ({ path, type }) => { /* new mount */ });
vfs.on("unmount", ({ path }) => { /* mount removed */ });
vfs.on("write", ({ path }) => { /* file written */ });
vfs.on("delete", ({ path }) => { /* file or dir deleted */ });
vfs.on("mkdir", ({ path }) => { /* directory created */ });
vfs.off("write", handler);        // remove specific listener
```

lightweight event emitter. mount/unmount events fire on `vfs.mount()` / `vfs.unmount()`. write/delete/mkdir events fire on every successful mutating operation at the VFS level (not per-backend — the VFS wrapper emits after the backend call succeeds). events fire only for operations through this VFS instance — external changes (another tab writing to the same IndexedDB, another process modifying an FSAA directory) are not detected. a future `watch()` API may add backend-level external change detection (via OPFS `FileSystemObserver` etc.) but is not in v1.

useful for file tree UIs, dirty indicators, undo systems.

### disk usage

```js
const usage = await vfs.du("/data");
// { files: 42, directories: 7, bytes: 2_340_000 }

const usage = await vfs.du("/");
// whole VFS usage across all mounts
```

recursive traversal via `readdir` + `stat`. counts files, directories, and total byte size. for backends that don't track size (memory, comment), `size` is computed from content length. for cross-mount paths, `du` aggregates across all backends under the given prefix.

useful for storage indicators in UIs, deciding when to redirect files to overflow backends, and debugging ("where did my quota go?").

### errors

all operations throw on failure. errors have a `code` property matching POSIX conventions:

| code | meaning |
|------|---------|
| `ENOENT` | path does not exist |
| `EEXIST` | path already exists (mkdir without recursive) |
| `EISDIR` | expected file, got directory |
| `ENOTDIR` | expected directory, got file (or parent is not a directory) |
| `ENOTEMPTY` | rmdir on non-empty directory |
| `ENOSPC` | storage quota exceeded |
| `EACCES` | permission denied (read-only backend, FSAA permission revoked) |
| `EXDEV` | cross-device operation (rename across mount boundaries) |
| `ENOTSUP` | operation not supported (symlinks on a backend without symlink support) |

```js
import { VFSError } from "@gcu/vfs";

try {
  await vfs.readFile("/missing");
} catch (e) {
  if (e.code === "ENOENT") { /* handle missing file */ }
}
```

### path utilities

exported standalone, usable without a VFS instance:

```js
import { path } from "@gcu/vfs";

path.join("/home", "data", "file.csv")     // "/home/data/file.csv"
path.dirname("/home/data/file.csv")         // "/home/data"
path.basename("/home/data/file.csv")        // "file.csv"
path.extname("/home/data/file.csv")         // ".csv"
path.normalize("/home/../etc/./hosts")      // "/etc/hosts"
path.resolve("/home", "../etc", "hosts")    // "/etc/hosts"
path.isAbsolute("/home")                    // true
path.relative("/home/data", "/home/other")  // "../other"
path.mime("data.csv")                       // "text/csv"
path.mime("model.wasm")                     // "application/wasm"
path.mime("unknown.xyz")                    // "application/octet-stream"
```

`path.mime` is a small lookup table (~30 common extensions: csv, json, geojson, txt, html, js, mjs, css, md, xml, svg, wasm, png, jpg, jpeg, gif, webp, tiff, tif, pdf, zip, gz, bin, geotiff, shp, dbf, prj). returns `"application/octet-stream"` for unknown extensions. useful for the comment backend (deciding text vs binary), the fetch backend (setting response types), and FSAA (MIME-based file type filtering). not exhaustive — consumers who need exotic MIME types can check the extension themselves.

## backend interface

every backend implements this contract:

```js
class Backend {
  // lifecycle
  async init()                              // called once after construction
  async destroy()                           // cleanup (close DB connections, etc.)

  // core operations
  async readFile(path, encoding)            // encoding: "utf8" (default) | "bytes"
  async writeFile(path, content)            // content: string | Uint8Array
  async unlink(path)
  async rename(oldPath, newPath)
  async stat(path)                          // returns { type, size, created, modified, mode?, owner?, group? }
  async lstat(path)                         // stat without following symlinks (default: same as stat)
  async mkdir(path)
  async readdir(path)                       // returns string[]
  async rmdir(path)
  async touch(path)                         // create empty file or update mtime

  // optional
  async exists(path)                        // default: try stat, catch ENOENT
  async cp(src, dst, opts)                  // default: readFile + writeFile (backends with native copy can override)
  async symlink(target, path)               // create symlink pointing to target
  async readlink(path)                      // read symlink target
  async estimate()                          // returns { used, available }
  async chmod(path, mode)                   // store mode bits in metadata
  async chown(path, owner, group)           // store owner/group strings in metadata
  async export(path)                        // returns flat { path: content } object
  async import(path, data)                  // bulk load from flat object
  createReadStream(path, opts)              // returns AsyncIterable<string|Uint8Array>, or null
  createWriter(path)                        // returns { write(chunk), close() }, or null

  // capability flags (static or getter)
  static type = "typename"                  // e.g. "memory", "idb", "opfs", "fsaa"
  get readonly()                            // default: false
  get persistent()                          // default: false — survives page reload
  get streamable()                          // default: false — createReadStream/createWriter work natively
  get estimatable()                         // default: false — estimate() returns real numbers
  get exportable()                          // default: true — export/import work
  get portable()                            // default: false — travels with the document
  get symlinks()                            // default: false — symlink/readlink/lstat supported
}
```

`path` arguments to backend methods are always **relative to the mount point** — the mount table strips the prefix before dispatching. paths are normalized (no `.`, `..`, double slashes) and always start with `/`.

`stat` returns `{ type, size, created, modified }` where `type` is `"file"`, `"directory"`, or `"symlink"`. symlink entries include a `target` field with the link destination. `stat` follows symlinks (returns the target's metadata); `lstat` does not (returns the link's own metadata with `type: "symlink"`).

backends only need to implement the methods they support. the VFS base class provides defaults: `exists` tries `stat` and catches `ENOENT`, `cp` does `readFile` + `writeFile`, `export` does recursive `readdir` + `readFile`, `import` iterates and calls `writeFile`/`mkdir`, `touch` does `writeFile("", "")` if missing or updates metadata if exists. mutating methods on a `readonly` backend throw `EACCES` without calling the backend. backends that don't support symlinks throw `ENOTSUP` from `symlink`/`readlink`.

### custom backends (FUSE-like)

any object or class that implements the backend interface can be mounted. this is the extensibility escape hatch — mount a function, an API, a WebSocket, a joke.

```js
// mount a plain object with handler functions
await vfs.mount("/api", {
  type: "custom",
  async readFile(path) {
    const res = await fetch(`https://api.example.com${path}`);
    return await res.text();
  },
  async readdir(path) {
    const res = await fetch(`https://api.example.com${path}?list`);
    return await res.json();
  },
  async stat(path) {
    return { type: "file", size: 0, created: new Date(), modified: new Date() };
  },
  readonly: true,
  persistent: false,
});

// now this works:
const data = await vfs.readFile("/api/users/42.json");
```

```js
// mount a class instance — a Git-like content-addressable store
class CASBackend {
  static type = "cas";
  #store = new Map();

  async writeFile(path, content) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
    this.#store.set(hex, content);
    this.#store.set(path, hex);  // path → hash indirection
    return hex;
  }
  async readFile(path) {
    const ref = this.#store.get(path);
    if (!ref) throw VFSError("ENOENT", path);
    return this.#store.get(ref) ?? this.#store.get(path);
  }
  async stat(path) {
    if (!this.#store.has(path)) throw VFSError("ENOENT", path);
    return { type: "file", size: 0, created: new Date(), modified: new Date() };
  }
  async readdir() { return [...this.#store.keys()].filter(k => k.startsWith("/")); }
  async mkdir() {}
  async rmdir() {}
  async unlink(path) { this.#store.delete(path); }
  async rename(a, b) { this.#store.set(b, this.#store.get(a)); this.#store.delete(a); }
  get persistent() { return false; }
}

await vfs.mount("/cas", new CASBackend());
```

```js
// the absurd end: mount a WebRTC peer as a filesystem
await vfs.mount("/peer/alice", {
  type: "peer",
  async readFile(path) {
    return await mesh.request(alicePeerId, "fs:read", path);
  },
  async writeFile(path, content) {
    return await mesh.request(alicePeerId, "fs:write", path, content);
  },
  async readdir(path) {
    return await mesh.request(alicePeerId, "fs:readdir", path);
  },
  async stat(path) {
    return await mesh.request(alicePeerId, "fs:stat", path);
  },
  // ...
  readonly: false,
  persistent: true,
});

// alice's files, locally navigable:
const data = await vfs.readFile("/peer/alice/data/assays.csv");
```

**mounting rules for custom backends:**

- if the object has an `init` method, it's called after mounting (and awaited).
- if it has a `destroy` method, it's called on `unmount()`.
- missing methods are filled with defaults: unimplemented reads throw `ENOENT`, unimplemented writes throw `EACCES`.
- `type` defaults to `"custom"` if not specified.
- capability getters default to `false` / safe values if absent.
- the object is used as-is — no wrapping, no proxying, no prototype shenanigans. `this` works as expected inside methods.

this is explicitly designed for shenanigans. mount a `localStorage` wrapper in 10 lines. mount a `Map`. mount `/dev/random` as a file that returns crypto bytes. mount `/proc/battery` backed by the Battery Status API. mount a Tauri IPC bridge. mount an LLM that generates file contents on read. the interface is small enough that you can implement a useful backend on a napkin.

the built-in backends (memory, idb, opfs, fsaa, comment, fetch) are just implementations of this same interface — they aren't privileged. a custom backend mounted at `/` has the same authority as the built-in memory backend.

### backend: memory

in-memory tree. fast, ephemeral, always available. gone when the page unloads.

```js
{ type: "memory" }
```

storage model: a plain JS object tree. directories are objects, files are `{ content: string|Uint8Array, created: Date, modified: Date }`. this is the simplest backend and the universal fallback.

### backend: idb (IndexedDB)

persistent key-value store. works on `file://`. the workhorse backend.

```js
{ type: "idb", name: "my-vfs" }
// name: IndexedDB database name (default: "gcu-vfs")
```

storage model: one object store, keys are full paths (strings), values are `{ type: "file"|"directory", content?, size?, created, modified }`. directory entries are explicit records (not inferred from path prefixes) so that `readdir` and `stat` on directories work without scanning all keys.

`readdir` uses an IDB key range cursor on the path prefix. `rename` is a delete+put (IDB has no rename primitive). the database name is configurable so multiple apps on the same origin don't collide.

on `file://`, all pages share the same IndexedDB namespace in Firefox, while Chrome isolates by file path. the `name` parameter should include an app-specific prefix to avoid collisions in Firefox's shared namespace.

### backend: opfs (Origin Private File System)

fast, persistent, HTTPS-only. automatic upgrade when available.

```js
{ type: "opfs" }
// or with fallback:
{ type: "opfs", fallback: { type: "idb", name: "my-vfs" } }
```

on `init()`, the backend checks `navigator.storage?.getDirectory`. if unavailable (e.g. `file://` origin, insecure context), it transparently initializes the `fallback` backend instead. if no fallback is specified and OPFS is unavailable, `init()` throws.

storage model: native OPFS directory handles. maps directly to the API — `getDirectoryHandle`, `getFileHandle`, `getFile`, `createWritable`. no abstraction layer needed beyond path-to-handle resolution.

the sync access handle path (`createSyncAccessHandle`) is **not used** in the default implementation — it requires a Web Worker and exclusive file locking. a future extension could expose a worker-backed fast path for large binary I/O (relevant for WASM/atra workloads), but the async main-thread API is the default.

### backend: fsaa (File System Access API)

mounts a real directory from the user's disk. Chromium-only (the `showDirectoryPicker` API). read-write access to actual files.

```js
// obtain handle via picker
const handle = await window.showDirectoryPicker();
{ type: "fsaa", handle }
```

the backend stores the `FileSystemDirectoryHandle` and navigates it using `getDirectoryHandle`/`getFileHandle`. writes go to the real filesystem. the user grants permission once; the handle can be persisted in IndexedDB across sessions (handles are serializable).

`readonly` is determined by the permission state. if the user granted read-only access, `writeFile`/`mkdir`/`unlink` throw `EACCES`.

### backend: comment (HTML comment storage)

auditable-native. files live inside HTML comments in the document. they persist when the HTML file is saved (Ctrl+S). they travel with the file. they work on `file://`, offline, via email. this is the "single-file philosophy" backend.

```js
{ type: "comment", prefix: "AUDITABLE-FS" }
```

storage model: a single HTML comment node in the DOM containing a base64-encoded JSON blob that maps paths to file entries. this matches auditable's existing `AUDITABLE-FS` format:

```html
<!-- notebook filesystem: base64-encoded JSON mapping paths to {type, compressed, size, data} -->
<!--AUDITABLE-FS
eyJkYXRhL3BvaW50cy5jc3YiOnsi...
AUDITABLE-FS-->
```

the JSON structure maps paths to entries: `{ "data/points.csv": { type: "text/csv", compressed: false, size: 1234, data: "x,y,z\n..." } }`. binary files are base64-encoded in the `data` field with `compressed: true` for gzipped content. the outer base64 encoding avoids `--` sequences breaking the HTML comment (same reason auditable's MODULES block uses base64).

on `init()`, the backend finds the comment node, decodes and parses the JSON, and builds an in-memory tree (path → entry). all reads come from the in-memory tree. writes update the in-memory tree and re-encode the comment node.

**the backend does not auto-save.** writing to the comment backend modifies the live DOM comment, but the changes only persist to disk when the host application saves the HTML file (e.g. auditable's Ctrl+S / `saveNotebook()`). the host is responsible for serialization. this is by design — the VFS shouldn't trigger file downloads on every write.

directory structure is implicit: `readdir("/data")` scans the path keys for entries with the matching prefix. there are no explicit directory nodes — directories exist if any file has that prefix.

size limits: this backend is for small-to-medium data (CSV datasets, JSON configs, small binaries). multi-megabyte files will bloat the HTML. the backend does not enforce a size limit, but the host application may choose to warn or redirect large files to an overflow backend.

the `prefix` parameter allows multiple consumers to coexist in the same HTML document. auditable uses `AUDITABLE-FS`; another tool could use its own prefix.

### backend: http/fetch (read-only)

mount a URL prefix as a read-only directory. lazily fetches files on demand.

```js
{
  type: "fetch",
  base: "https://data.example.com/project/",
  index: "index.json",   // optional: file listing for readdir
  headers: {},            // optional: static object or async function (see auth section)
  credentials: "same-origin",  // optional: "include" for cookie auth
}
```

`readFile` does `fetch(base + path)`. `stat` does a `HEAD` request (or reads from the index). `readdir` requires an `index.json` at each directory level listing the entries, or returns `EACCES` if no index is configured.

all mutating operations (`writeFile`, `mkdir`, `unlink`, `rename`) throw `EACCES`. `readonly` is always `true`.

useful for lazy-loading large datasets: mount a remote data directory and read files on demand without downloading everything upfront.

### backend: rest (read-write HTTP)

mount a REST-ish HTTP server as a read-write filesystem. the obvious verb mapping:

```js
{
  type: "rest",
  base: "https://lab-server.local:8080/files",
  headers: { "Authorization": "Bearer ..." },  // static, or async function (see auth section)
  credentials: "same-origin",                   // optional: "include" for cookie auth
}
```

| VFS operation | HTTP | details |
|---|---|---|
| `readFile(path)` | `GET /path` | response body is file content |
| `writeFile(path, content)` | `PUT /path` | request body is file content |
| `stat(path)` | `HEAD /path` | size from `Content-Length`, modified from `Last-Modified`, type from trailing `/` or `Content-Type` |
| `mkdir(path)` | `PUT /path/` | trailing slash signals directory (or `MKCOL` if server supports it) |
| `unlink(path)` | `DELETE /path` | |
| `readdir(path)` | `GET /path/` | expects JSON array response: `["file.csv", "subdir/"]` |
| `rename(old, new)` | `DELETE` + `PUT` | read old, write new, delete old. not atomic. |
| `rmdir(path)` | `DELETE /path/` | |

the convention: trailing `/` means directory. `GET` on a directory returns a JSON listing. `GET` on a file returns content. this is simple enough that a server-side implementation is 20-30 lines in any framework.

the `rest` backend requires CORS on the server for anything beyond `GET`/`HEAD`/`POST`. all methods other than those three trigger a preflight `OPTIONS` request. the server must respond with appropriate `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`. this is a one-line config in most frameworks but it's worth documenting.

### backend: webdav (v2 — optional import)

full WebDAV client backend. **not in v1 core** — available as `import { WebDAVBackend } from "@gcu/vfs/webdav"`.

`fetch()` can send any HTTP method string — `MKCOL`, `MOVE`, `COPY`, `PROPFIND` all work from the browser. the only requirement is CORS headers on the server.

```js
import { WebDAVBackend } from "@gcu/vfs/webdav";

{
  type: "webdav",
  base: "https://nextcloud.example.com/remote.php/dav/files/user/",
  headers: { "Authorization": "Basic ..." },
  credentials: "same-origin",
}
```

| VFS operation | WebDAV method | details |
|---|---|---|
| `readFile(path)` | `GET` | |
| `writeFile(path, content)` | `PUT` | |
| `stat(path)` | `PROPFIND` (Depth: 0) | parse XML response for size, modified, type |
| `mkdir(path)` | `MKCOL` | |
| `unlink(path)` | `DELETE` | |
| `readdir(path)` | `PROPFIND` (Depth: 1) | parse XML multistatus response |
| `rename(old, new)` | `MOVE` | `Destination` header |
| `cp(src, dst)` | `COPY` | `Destination` header, native server-side copy |
| `rmdir(path)` | `DELETE` | |

this is the only backend where `rename` across directories is truly atomic (the server handles it) and where `cp` can be server-side (no download+reupload). `PROPFIND` responses are XML, so the backend includes a minimal XML parser for extracting `href`, `getlastmodified`, `getcontentlength`, `resourcetype` from multistatus responses.

Nextcloud, Apache, nginx (with dav module), ownCloud, Seafile, and many NAS devices speak WebDAV. it maps to the VFS interface almost 1:1, because WebDAV was literally designed to be a filesystem over HTTP. split from the core because the XML parsing adds disproportionate complexity for a backend most users won't need in v1.

**v1 HTTP backends:**

- **fetch** — read-only, GET/HEAD only, mount a CDN or static server.
- **rest** — read-write, simple verb mapping, bring your own tiny server.

### backend: overlay (composable)

read-only base with a writable layer on top. like Docker's overlayfs.

```js
{
  type: "overlay",
  lower: { type: "fetch", base: "https://templates.example.com/project/" },
  upper: { type: "idb", name: "my-edits" },
}

// or compose multiple layers:
{
  type: "overlay",
  lower: {
    type: "overlay",
    lower: { type: "fetch", base: "https://shared-data.example.com/" },
    upper: { type: "idb", name: "team-overrides" },
  },
  upper: { type: "memory" },  // session-local scratch
}
```

**read behavior:** check upper first. if the file exists in upper, return it. if not, fall through to lower. if neither has it, `ENOENT`.

**write behavior:** all writes go to upper. lower is never modified. this means you can "edit" a read-only dataset without touching the original — edits live in the writable layer.

**delete behavior:** deleting a file that exists in lower creates a **whiteout marker** in upper — a sentinel record that says "this file is deleted." subsequent reads see `ENOENT` even though the file still exists in lower. whiteouts are stored as `{ "$whiteout": true }` in upper. `readdir` filters out whiteout entries and merges listings from both layers (upper entries shadow lower entries with the same name).

**`stat` behavior:** returns metadata from upper if present (including whiteouts), otherwise from lower. the response includes `{ layer: "upper" | "lower" }` so consumers can tell whether they're seeing the original or a modified version.

**use cases:**

- fork a shared dataset without copying it. mount the original as lower, idb as upper. edits are local, originals untouched.
- auditable: embedded example data (comment backend, lower) with user modifications (idb, upper). reset to original by clearing the upper layer.
- offline-capable remote data: fetch backend as lower (cached), memory or idb as upper for local modifications. syncing upper back to the server is the consumer's problem.
- staging/preview: lower is production data, upper is proposed changes. "discard changes" = clear upper.

**`overlay.reset(path?)`** — clear the upper layer (or a subtree), restoring the lower layer's view. removes all whiteouts and upper-layer files under the given path.

the overlay backend composes with any backends, including other overlays. the lower and upper can be any backend type, including custom FUSE backends. this makes it possible to build arbitrary stacks: memory on top of idb on top of fetch — a three-tier cache with session scratch, persistent edits, and remote originals.

implementation: ~80 lines.

### backend: cache (HTTP caching layer)

transparent read cache for HTTP backends. wraps a remote backend with a local store.

```js
{
  type: "cache",
  backend: { type: "fetch", base: "https://data.example.com/" },
  store: { type: "idb", name: "fetch-cache" },   // where to cache. memory for session-only
  ttl: 3600_000,                                    // optional: cache lifetime in ms. default: Infinity
}
```

**read behavior:** check the store first. if the entry exists and hasn't expired (created + ttl > now), return it. otherwise, read from the remote backend, write to the store with a timestamp, return the result.

**write behavior:** if the remote backend is writable (rest, webdav), writes go through to the remote and update the cache. if the remote is read-only (fetch), writes go to the cache only (making it a local override — effectively the same as overlay, but with TTL semantics).

**invalidation:** `cache.invalidate(path)` removes a specific entry from the store. `cache.invalidate("*")` clears the entire cache. entries also self-invalidate when TTL expires — the next read triggers a fresh fetch.

**stat behavior:** checks cache freshness first. if cached and fresh, returns cached metadata. otherwise, fetches fresh metadata from the remote.

**`readdir` caching:** directory listings are cached separately with their own TTL. a common pattern is short TTL for listings (30s) and long TTL for file contents (1h+), since listings change more often.

```js
{
  type: "cache",
  backend: { type: "webdav", base: "https://nextcloud.example.com/dav/..." },
  store: { type: "idb", name: "dav-cache" },
  ttl: 3600_000,            // 1 hour for file contents
  listingTtl: 30_000,       // 30 seconds for directory listings
}
```

**relation to overlay:** a cache with a read-only remote and no TTL is functionally identical to an overlay. the difference is intent — overlay is about composing editable layers, cache is about performance and offline support. the cache backend adds TTL, invalidation, and automatic refresh; overlay adds whiteouts and explicit layering semantics. both are thin (~60-80 lines) and share internal machinery.

**use cases:**

- offline support: cache a WebDAV server's files in idb. the first load fetches from the network; subsequent loads work offline until TTL expires.
- reduce network traffic: cache a large dataset that rarely changes. set TTL to 24 hours. the fetch backend only hits the network once a day.
- progressive loading: mount a cached remote dataset, let the UI render from cache immediately while stale entries refresh in the background (future: `stale-while-revalidate` pattern).

### authentication for HTTP backends

the VFS does not implement authentication. it provides hooks. all three HTTP backends (fetch, rest, webdav) share the same auth configuration pattern:

**static headers** — the simplest case. API keys, pre-obtained tokens, basic auth:

```js
{
  type: "rest",
  base: "https://lab-server:8080/files",
  headers: {
    "Authorization": "Bearer eyJhbG...",
  }
}

// basic auth
{
  type: "webdav",
  base: "https://nextcloud.example.com/remote.php/dav/files/user/",
  headers: {
    "Authorization": "Basic " + btoa("user:password"),
  }
}
```

**dynamic headers (function)** — for tokens that expire. called before every request:

```js
{
  type: "rest",
  base: "https://api.example.com/files",
  headers: async () => ({
    "Authorization": "Bearer " + await getAccessToken(),
  })
}
```

when `headers` is a function, the backend calls it before each `fetch()` and merges the result into the request headers. the function can be async. this handles token refresh, rotating API keys, or any auth scheme where credentials change over time.

**cookie-based auth** — for servers that use session cookies (SSO, corporate intranets):

```js
{
  type: "rest",
  base: "https://internal.corp.com/api/files",
  credentials: "include",    // sends cookies cross-origin
}
```

maps directly to `fetch()`'s `credentials` option. `"include"` sends cookies on every request (cross-origin). `"same-origin"` (the default) sends cookies only for same-origin requests. requires the server to respond with `Access-Control-Allow-Credentials: true` and a specific `Access-Control-Allow-Origin` (not `*`).

**no auth** — for servers behind a tailnet/VPN where the network itself is the security boundary:

```js
{
  type: "rest",
  base: "http://100.64.0.3:8080/files",  // tailscale IP, no auth needed
}
```

this is the likely setup for the mesh (M1) use case. WireGuard encrypts and authenticates the transport. the VFS server is only reachable by mesh peers. no tokens, no passwords, no cookies.

**what the VFS explicitly does NOT do:**

- **OAuth flows.** acquiring tokens (redirect to auth server, handle callback, exchange code for token) is the consumer's problem. the VFS accepts the token once you have it.
- **Token storage.** where you keep the token (localStorage, memory, cookie) is the consumer's decision.
- **Login UI.** the VFS has no concept of "logged in" or "logged out." if a request returns 401, the backend throws `EACCES` and the consumer handles it.
- **Retry on 401.** tempting to auto-refresh and retry, but this belongs in the `headers` function. if `getAccessToken()` handles refresh internally, the VFS never sees a 401.
- **mTLS / client certificates.** not controllable from `fetch()`. if you need client certs, the browser handles it at the TLS level — the VFS doesn't need to know.

**error mapping for HTTP status codes:**

| HTTP status | VFS error |
|---|---|
| 401 Unauthorized | `EACCES` |
| 403 Forbidden | `EACCES` |
| 404 Not Found | `ENOENT` |
| 405 Method Not Allowed | `EACCES` |
| 409 Conflict | `EEXIST` |
| 413 Payload Too Large | `ENOSPC` |
| 507 Insufficient Storage | `ENOSPC` |
| other 4xx/5xx | generic `Error` with status code and text |

## mount table

the mount table maps path prefixes to backends. longest-prefix match wins (like a POSIX mount table).

```
/           → MemoryBackend
/home       → IDBBackend("app-home")
/data       → CommentBackend("AUDITABLE-FS")
/disk       → FSAABackend(handle)
/remote     → FetchBackend("https://cdn.example.com/data/")
/lab        → RESTBackend("https://lab-server:8080/files")
/cloud      → WebDAVBackend("https://nextcloud.example.com/dav/...")
/project    → OverlayBackend(lower: fetch, upper: idb)
/cached     → CacheBackend(backend: webdav, store: idb, ttl: 1h)
/peer/alice → custom (WebRTC mesh)
/proc       → custom (browser API shims)
```

path resolution: given `/home/project/file.csv`, the mount table finds `/home` as the longest matching prefix, strips it, and calls `IDBBackend.readFile("/project/file.csv")`.

cross-mount operations: `rename` and `cp` across mount boundaries work by reading from the source backend and writing to the destination. `rename` across mounts is a copy+delete (not atomic). same-backend `rename` delegates to the backend's native rename.

mount/unmount at runtime allows dynamic workspace composition — AF already does this with its FSAA directories and IndexedDB boxes.

## auto-configuration

`VFS.create()` with no arguments picks sensible defaults:

```
secure context (HTTPS/localhost):
  /     → opfs (persistent, fast)
  
insecure context (file://, HTTP):
  /     → idb (persistent, universal)

if IndexedDB is unavailable (rare: private browsing in older Safari):
  /     → memory (ephemeral)
```

the auto-configuration can be overridden entirely by passing a `backends` map.

## integration with auditable

auditable's `notebook.fs` is a VFS instance with the comment backend mounted at `/`, with an optional IndexedDB overflow mount:

```js
// inside auditable's init:
const fs = await VFS.create({
  backends: {
    "/": { type: "comment", prefix: "AUDITABLE-FS" },
    "/.overflow": { type: "idb", name: `auditable-${notebookId}` }
  }
});
```

cells access it as `notebook.fs.readFile(...)`, `notebook.fs.writeFile(...)`, etc. the comment backend handles small data that should travel with the notebook. large files go to `.overflow` and stay in the browser (they don't survive emailing the file, but they don't bloat it either).

the MCP bridge's `fsList`, `fsRead`, `fsWrite`, `fsDelete` tools delegate to the same VFS instance, respecting per-cell `// %mcp fs` directives for path sandboxing.

AF's workspace mounts multiple backends:

```js
const workspace = await VFS.create({
  backends: {
    "/box/default": { type: "idb", name: "af-default-box" },
    "/disk/project": { type: "fsaa", handle: projectDirHandle },
  }
});
```

the file tree UI maps 1:1 to VFS paths. creating a file in the tree calls `workspace.writeFile(...)`. opening a notebook reads it. the bridge protocol between AF shell and notebook iframes proxies filesystem operations through `postMessage`.

### mesh integration (future — M6)

the auditable mesh roadmap (M6: file mesh) describes `mesh.readFile(peerId, path)`. with custom backends, this is a mount:

```js
// when a peer connects, mount their shared filesystem
mesh.on("peer:joined", (peer) => {
  vfs.mount(`/mesh/${peer.name}`, {
    type: "mesh-peer",
    async readFile(path) { return mesh.request(peer.id, "fs:read", path); },
    async readdir(path) { return mesh.request(peer.id, "fs:readdir", path); },
    async stat(path) { return mesh.request(peer.id, "fs:stat", path); },
    readonly: true,   // or false if peer allows writes
    persistent: true,  // data persists on the remote machine
  });
});

// transparent to any code that uses the VFS:
const assays = await vfs.readFile("/mesh/alice/data/assays.csv");
```

the VFS itself doesn't know about mesh, WebRTC, or WireGuard. it just sees a backend object with the right methods. the mesh module is responsible for the networking; the VFS provides the filesystem abstraction on top.

## service worker bridge

on HTTPS origins, a service worker can serve VFS files as real URLs. this unlocks contexts where blob URLs don't work or are awkward — CSS `url()`, `<link>` tags, Web Worker imports, `<iframe src>`, `<script src>`.

```js
// register the service worker (one-time setup)
await vfs.serve({
  prefix: "/_vfs/",           // URL prefix to intercept
  scope: "/",                 // service worker scope
  worker: "/vfs-sw.js",       // service worker file (provided by @gcu/vfs)
});

// now VFS files are addressable by URL:
img.src = "/_vfs/data/photos/outcrop.jpg";

// works in CSS:
// background-image: url(/_vfs/data/textures/rock.png);

// works in HTML:
// <link rel="stylesheet" href="/_vfs/themes/dark.css">
// <script src="/_vfs/scripts/analysis.js"></script>
// <iframe src="/_vfs/notebooks/demo.html"></iframe>

// works in fetch:
const csv = await fetch("/_vfs/data/assays.csv").then(r => r.text());

// works in Web Workers:
const worker = new Worker("/_vfs/workers/compute.js");
```

**how it works:** the service worker intercepts `fetch` events for URLs matching the prefix, extracts the VFS path, reads the file from the VFS via a `MessageChannel` to the main thread, and responds with the content and correct MIME type from `path.mime()`. the main thread holds the VFS instance; the service worker is a thin proxy.

**communication:** the service worker and main thread communicate via `postMessage` on a `MessageChannel`. the service worker sends `{ type: "vfs:read", path }`, the main thread responds with `{ content, mime }` or `{ error }`. this is async but fast — no network round-trip, just inter-thread messaging.

**installation:** `vfs.serve()` registers the service worker if not already registered, waits for activation, and establishes the message channel. the service worker file (`vfs-sw.js`) is a small standalone script (~40 lines) that the consumer hosts alongside their app. it's provided by `@gcu/vfs` as a separate file — the one exception to the "single file" rule, since service workers must be served from their own URL.

**`file://` behavior:** service workers are not available on `file://`. `vfs.serve()` detects this and returns `false` without throwing. consumers should check the return value and fall back to `toURL()` from `@gcu/vfs/dom`:

```js
import { toURL } from "@gcu/vfs/dom";

const canServe = await vfs.serve({ prefix: "/_vfs/" });

function fileURL(path) {
  return canServe ? `/_vfs${path}` : toURL(vfs, path);
}

img.src = await fileURL("/data/photo.jpg");
```

**caching in the service worker:** the worker can optionally cache responses (in-memory `Map` or via the Cache API) to avoid repeated `postMessage` round-trips for the same file. cache invalidation is triggered by `vfs.on("write")` events forwarded to the worker.

**scope:** the service worker only intercepts requests matching the prefix. all other requests pass through normally. this means `vfs.serve()` doesn't interfere with the app's own service worker (if any) — use a non-overlapping prefix.

**relation to `toURL()`:** `toURL()` is the universal fallback (works everywhere, including `file://`). the service worker bridge is the upgrade path (real URLs, correct caching, works in all DOM contexts). the consumer chooses based on context or uses the helper pattern above.

## DOM helpers (`@gcu/vfs/dom`)

main-thread-only helpers that depend on DOM APIs. **not part of the core VFS module** — imported separately so the core stays thread-agnostic (works in workers, Node).

### blob URLs

```js
import { toURL, revokeURL, revokeURLs } from "@gcu/vfs/dom";

// create a blob URL for a VFS file (works on file://)
const url = await toURL(vfs, "/data/image.png");
img.src = url;

// same path returns the same cached URL
const url2 = await toURL(vfs, "/data/image.png");
url === url2  // true

// explicit revoke when done
revokeURL(url);

// or revoke all blob URLs for a subtree
revokeURLs("/data/");
```

reads the file, infers MIME type from `path.mime()`, creates a `Blob`, calls `URL.createObjectURL()`. caches the mapping (path → URL) so repeated calls don't create multiple blobs. if the file is modified via `writeFile`, the cached URL is automatically revoked via `vfs.on("write")` and the next `toURL()` creates a fresh one.

this is the `file://`-compatible way to use VFS files in DOM contexts that expect URLs — `<img src>`, `<audio src>`, `<a href>`, CSS `url()`. on HTTPS, the service worker bridge is the better option.

### desktop file import

```js
import { fromDrop, fromPicker } from "@gcu/vfs/dom";

// drag and drop: read dropped files into the VFS
dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  const imported = await fromDrop(vfs, e, "/imports/");
  // imported: ["/imports/data.csv", "/imports/photo.jpg"]
});

// file picker: open the browser's file dialog, write results to VFS
const imported = await fromPicker(vfs, "/uploads/", {
  multiple: true,
  accept: ".csv,.json,.geojson",
});
// imported: ["/uploads/collars.csv"]

// directory picker (Chromium only): import an entire directory tree
const imported = await fromPicker(vfs, "/project/", {
  directory: true,
});
// imported: ["/project/data/assays.csv", "/project/config.json", ...]
```

`fromDrop(vfs, event, destPath)` reads `event.dataTransfer.items` (or `.files` fallback), writes each file to the VFS under `destPath`, auto-detects binary vs text via `path.mime()`, creates subdirectories if the drop includes a directory tree. returns an array of written paths.

`fromPicker(vfs, destPath, options)` creates a hidden `<input type="file">`, triggers the browser's file dialog, writes selected files to the VFS. if `options.directory` is true, uses `showDirectoryPicker()` on Chromium (falls back to `<input webkitdirectory>` elsewhere). returns an array of written paths.

both methods emit `write` events for each file written. if a file already exists at the destination, it's overwritten.

## serialization / export

backends that support serialization can export their contents:

```js
// export a subtree as a flat object
const snapshot = await vfs.export("/data");
// { "points.csv": "x,y,z\n...", "model/config.json": "{...}" }

// import from a flat object
await vfs.import("/data", snapshot);
```

this is useful for:
- AF box export (serialize an IndexedDB box to JSON, embed in HTML)
- notebook portability (extract comment-backed files as a ZIP or flat bundle)
- testing (seed a memory backend from fixtures)

binary values are represented as `{ "$binary": "<base64>" }` in the export format.

## file format conventions

the VFS itself is agnostic to file contents, but some conventions are useful:

- text files are UTF-8 strings. `readFile(path)` returns a string by default.
- binary files are `Uint8Array`. use `readFile(path, "bytes")` to read as binary.
- `writeFile` accepts both strings and `Uint8Array`. the backend stores them appropriately.
- the comment backend auto-detects: if `content` is a `Uint8Array`, it base64-encodes and flags the comment with `[binary]`. on read with `"bytes"` encoding, it decodes. on read with default `"utf8"` encoding on a binary file, it throws a `TypeError`.

## permissions and access control

the VFS is not single-user. a running auditable notebook has at least two classes of principal: the **human user** (full access, the person at the keyboard) and one or more **MCP agents** (sandboxed access, governed by per-cell directives and manifests). the VFS permission model serves this multi-principal reality.

three layers, from bottom to top:

### layer 1: browser-level access (FSAA)

the File System Access API has real, browser-enforced permissions. the user grants `read` or `readwrite` access via a dialog. permissions can be revoked at any time and may not persist between sessions.

the FSAA backend exposes this through the VFS:

```js
// query current permission state for a mount
const perm = await vfs.queryPermission("/disk");
// { read: "granted", write: "granted" }
// or: { read: "granted", write: "prompt" }
// or: { read: "denied", write: "denied" }

// request elevated permission (triggers browser prompt — requires user gesture)
const result = await vfs.requestPermission("/disk", "readwrite");
// "granted" | "denied" | "prompt"
```

`queryPermission` and `requestPermission` delegate to the underlying `FileSystemHandle.queryPermission()` / `.requestPermission()`. on non-FSAA backends, `queryPermission` returns `{ read: "granted", write: "granted" }` (or `write: "denied"` for read-only backends). `requestPermission` is a no-op that returns `"granted"` (or `"denied"` for read-only).

when the FSAA backend detects that a previously-granted permission has been revoked (handle operations throw `NotAllowedError`), it throws `EACCES` and emits a `"permission"` event:

```js
vfs.on("permission", ({ path, read, write }) => {
  if (write === "denied") showWarning("Write access to " + path + " was revoked");
});
```

this is the only layer that the browser enforces. everything above is VFS-enforced.

### layer 2: file metadata (POSIX-style)

mode bits, owner, and group — stored as metadata on files. provides the POSIX vocabulary for expressing access intent.

```js
// set metadata
await vfs.chmod("/data/important.csv", 0o444);    // read-only intent
await vfs.chmod("/scripts/run.sh", 0o755);         // executable intent
await vfs.chown("/data/points.csv", "arthur");     // ownership (string, not UID)
await vfs.chgrp("/data/points.csv", "gcu");        // group (string, not GID)

// read metadata (extended stat)
const info = await vfs.stat("/data/important.csv");
// {
//   type: "file",
//   size: 1234,
//   created: Date,
//   modified: Date,
//   mode: 0o444,             // permission bits (default: 0o644 for files, 0o755 for dirs)
//   owner: "arthur",         // default: env.USER or "user"
//   group: "gcu",            // default: "staff"
// }
```

**storage:** metadata is stored alongside the file in whatever format the backend uses. idb stores it as additional fields in the record. comment backend includes it in the comment header: `<!-- [PREFIX]:path [mode:0644] [owner:arthur] -->`. memory backend stores it in the tree node. OPFS and fetch backends don't store metadata (no sideband channel) — they return defaults.

**defaults:** files get `0o644` (`rw-r--r--`), directories get `0o755` (`rwxr-xr-x`). owner defaults to `env.USER` or `"user"`. group defaults to `"staff"`.

**pax interop:** mode/owner/group are written to tar headers on export, so archives extracted on a real Unix system get meaningful permissions.

### layer 3: principals and enforcement

the VFS enforces permissions when an operation carries a **principal** — an identity with an associated policy. without a principal, operations are unrestricted (the human user at the keyboard).

```js
/**
 * @typedef {Object} Principal
 * @property {string} id             — identity: "user:arthur", "agent:claude", "agent:codex"
 * @property {string} type           — "user" | "agent"
 * @property {string[]} [prefixes]   — allowed path prefixes (from %mcp fs directives)
 * @property {string} [access]       — default access level: "rw" | "read" | "none"
 * @property {Set<string>} [readOnlyPrefixes] — prefixes with read-only access (from %mcp fs:read)
 */
```

**creating principals:**

```js
// the human user — unrestricted (no principal needed, this is the default)
await vfs.readFile("/data/secret.csv");  // works, no principal

// an MCP agent — sandboxed
const agent = {
  id: "agent:claude",
  type: "agent",
  prefixes: ["data/", "results/"],         // from // %mcp fs data/ and // %mcp fs results/
  readOnlyPrefixes: ["reference/"],         // from // %mcp fs:read reference/
  access: "rw",                             // from manifest defaults
};

await vfs.readFile("/data/points.csv", { principal: agent });     // ✓ allowed
await vfs.readFile("/secrets/keys.json", { principal: agent });   // EACCES — not in prefixes
await vfs.writeFile("/reference/std.csv", d, { principal: agent }); // EACCES — read-only prefix
await vfs.readFile("/reference/std.csv", { principal: agent });   // ✓ allowed
```

**enforcement rules** (when a principal is present):

1. **prefix check** — if the principal has `prefixes`, the path must start with at least one. if no prefix matches, `EACCES`. if `prefixes` is absent or empty, all paths are denied unless `access` is explicitly set.
2. **read-only prefix check** — if the matched prefix is in `readOnlyPrefixes`, only read operations (`readFile`, `readdir`, `stat`, `exists`, `createReadStream`, `glob`, `du`) are allowed. write operations throw `EACCES`.
3. **mode bit check** — if the file has metadata, the "other" permission bits are checked against the operation. an agent is always "other" (not the owner). `chmod 700 file` means the owner can do anything but agents can't read, write, or execute.
4. **path traversal** — `../` sequences that would escape a permitted prefix are rejected. paths are normalized before prefix matching.

**the principal flows through the stack:**

```
MCP bridge receives tool call
  → MCP adapter builds Principal from cell directives + manifest
    → adapter calls vfs.readFile(path, { principal })
      → VFS checks principal against prefixes and mode bits
        → if allowed, delegates to backend
        → if denied, throws EACCES
```

for coreutils integration, the principal is part of the context:

```js
// shell running on behalf of an agent
const shell = createShell({
  vfs,
  principal: agentPrincipal,    // all VFS operations through this shell carry the principal
  env: { USER: "agent:claude" },
});

// the agent's shell commands are sandboxed
await shell.exec('cat /data/points.csv');     // ✓ if /data/ is in prefixes
await shell.exec('cat /secrets/keys.json');   // EACCES
await shell.exec('rm /data/points.csv');      // EACCES if prefix is read-only
```

the shell passes `{ principal }` to every VFS call it makes. the utilities don't know or care about principals — they call `ctx.vfs.readFile(path)` and the VFS handles the rest. enforcement is transparent to the utility layer.

**operations without a principal are always unrestricted.** this is the fundamental security model: the human user is trusted. principals exist to constrain delegated access — AI agents, embedded iframes, shared notebooks. the VFS never blocks the person at the keyboard.

### the confirmation layer (above VFS)

the MCP adapter adds one more layer that the VFS doesn't handle: **user confirmation for mutations.** even when an agent has `rw` access and the prefix matches and mode bits allow it, `updateCellSource`, `fsWrite`, and `fsDelete` still show a confirmation dialog. the human must click "Accept" (or "Accept All" for the session).

this is intentionally outside the VFS. the VFS is a storage layer — it doesn't have a UI. the confirmation dialog is an application-level concern, implemented in auditable's MCP adapter. other consumers of `@gcu/vfs` with principals might handle confirmation differently (auto-approve in tests, require 2FA in production, etc.).

### practical examples

**methodology-only access** (the agent can't see raw data):

```js
// %mcp fs results/
// %mcp fs:read reference/
```

the agent's principal: `{ prefixes: ["results/"], readOnlyPrefixes: ["reference/"] }`. it can write results, read reference data, but `/data/` (where proprietary drill data lives) is invisible.

**full collaboration:**

```js
// %mcp manifest
({ defaults: "rw", fs: "*" })
```

the agent's principal: `{ prefixes: [""], access: "rw" }`. empty prefix matches everything. the agent can read and write any path. confirmation dialogs still apply for mutations.

**multi-agent with different trust:**

```js
// %mcp manifest
({
  defaults: "read",
  tools: {
    "analyzeData": { cell: "analysis", access: "rw" },
  },
  fs: { prefix: "data/", readOnly: true },
})
```

default agent principal: `{ prefixes: [], readOnlyPrefixes: ["data/"], access: "read" }`. the agent can read data files but can't write to the VFS or modify cells, except through the named `analyzeData` tool which has `rw` on its specific cell.

### access control lists (future)

as multi-agent workflows grow, per-principal ACLs on individual files may be needed:

```js
await vfs.setACL("/data/sensitive.csv", {
  "agent:claude": "r",
  "agent:codex": "rw",
  "user:arthur": "rwx",
  "*": "",
});
```

not in v1. the prefix-based system + mode bits cover the immediate need. file-level ACLs are the path forward when different agents need different access to the same directory.

## package structure

```
@gcu/vfs
├── index.js          — VFS class, mount table, path utils, MIME table, glob,
│                       event emitter, v1 backends (memory, idb, opfs, fsaa,
│                       comment, fetch, rest, overlay), permissions,
│                       custom backend adapter
├── dom.js            — DOM helpers: toURL, fromDrop, fromPicker (main-thread-only)
├── webdav.js         — WebDAV backend (v2, optional import)
├── vfs-sw.js         — service worker for URL serving (~40 lines)
└── (that's it)
```

`index.js` is the core — thread-agnostic, no DOM dependencies, works in workers and Node. `dom.js` provides blob URL generation, drag-drop import, and file picker helpers that require the main thread. `webdav.js` is a separate optional import for v2. `vfs-sw.js` is the service worker for `vfs.serve()` on HTTPS.

exports:

```js
import { VFS, VFSError, path } from "@gcu/vfs";

// DOM helpers (main-thread-only)
import { toURL, revokeURL, fromDrop, fromPicker } from "@gcu/vfs/dom";

// WebDAV backend (v2, optional)
import { WebDAVBackend } from "@gcu/vfs/webdav";
```

## patterns

documented patterns for advanced use cases. not built into the library — just examples of what the backend interface enables.

### transform wrapper

intercept reads and writes to transform content. not a built-in backend because it changes the return type contract (`readFile` normally returns string or Uint8Array). use when you know what you're doing.

```js
// encryption at rest
function encrypted(backend, key) {
  return {
    ...backend,
    type: "encrypted",
    async readFile(path, encoding) {
      const cipher = await backend.readFile(path, "bytes");
      const plain = await decrypt(cipher, key);
      return encoding === "bytes" ? plain : new TextDecoder().decode(plain);
    },
    async writeFile(path, content) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return backend.writeFile(path, await encrypt(bytes, key));
    },
  };
}

await vfs.mount("/secrets", encrypted(
  { type: "idb", name: "encrypted-store" },
  encryptionKey
));

// reads and writes are transparently encrypted/decrypted
await vfs.writeFile("/secrets/keys.json", JSON.stringify(keys));
const keys = JSON.parse(await vfs.readFile("/secrets/keys.json"));
// on disk (in IndexedDB): encrypted bytes. in memory: plaintext.
```

```js
// auto-parse JSON files
function jsonParsed(backend) {
  return {
    ...backend,
    type: "json-" + (backend.type || "custom"),
    async readFile(path, encoding) {
      const raw = await backend.readFile(path, encoding);
      return (encoding !== "bytes" && path.endsWith(".json")) ? JSON.parse(raw) : raw;
    },
    async writeFile(path, content) {
      const raw = (typeof content === "object" && path.endsWith(".json"))
        ? JSON.stringify(content, null, 2)
        : content;
      return backend.writeFile(path, raw);
    },
  };
}
```

```js
// logging proxy — debug any backend
function logged(backend, label = backend.type) {
  const handler = {
    get(target, prop) {
      const val = target[prop];
      if (typeof val !== "function") return val;
      return async (...args) => {
        console.log(`[${label}] ${prop}(${args.map(a => JSON.stringify(a)).join(", ")})`);
        const result = await val.apply(target, args);
        console.log(`[${label}] ${prop} →`, result);
        return result;
      };
    }
  };
  return new Proxy(backend, handler);
}

await vfs.mount("/debug", logged({ type: "memory" }));
```

the transform pattern is just function composition over the backend interface. since backends are plain objects, `{ ...backend, readFile: wrappedReadFile }` is all you need. the spread copies all methods, the override replaces the ones you want to intercept. no framework, no middleware chain, no registration API — just JS objects.

### `/proc`-style browser API mounts

mount browser APIs as virtual files. reads return live data, writes configure settings. purely for fun and discoverability.

```js
await vfs.mount("/proc", {
  type: "custom",
  async readFile(path) {
    if (path === "/battery") {
      const b = await navigator.getBattery();
      return JSON.stringify({ level: b.level, charging: b.charging, chargingTime: b.chargingTime });
    }
    if (path === "/storage") return JSON.stringify(await navigator.storage.estimate());
    if (path === "/online") return String(navigator.onLine);
    if (path === "/language") return navigator.language;
    if (path === "/memory" && performance.memory)
      return JSON.stringify(performance.memory);
    if (path === "/gpu") {
      const c = document.createElement("canvas"), g = c.getContext("webgl");
      const ext = g?.getExtension("WEBGL_debug_renderer_info");
      return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
    }
    if (path === "/clipboard") return await navigator.clipboard.readText();
    if (path === "/geolocation") {
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej));
      return JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude });
    }
    throw VFSError("ENOENT", path);
  },
  async readdir() {
    return ["battery", "storage", "online", "language", "memory", "gpu", "clipboard", "geolocation"];
  },
  async stat(path) {
    return { type: "file", size: 0, created: new Date(), modified: new Date() };
  },
  readonly: true,
  persistent: false,
});

// then:
const battery = JSON.parse(await vfs.readFile("/proc/battery"));
const gpu = await vfs.readFile("/proc/gpu");
```

useless? mostly. but it demonstrates that the FUSE interface makes *everything* in the browser addressable as a file, which is the kind of composability that leads to unexpected tools.

## testing

tests use Node's built-in test runner. a minimal IndexedDB shim (or `fake-indexeddb`) is needed for idb backend tests in Node. OPFS and FSAA backends are tested in-browser only (playwright or web-test-runner). the memory and comment backends are fully testable in Node with a DOM shim.

test matrix:

| backend | Node | Browser | `file://` |
|---------|------|---------|-----------|
| memory | ✓ | ✓ | ✓ |
| idb | ✓ (shim) | ✓ | ✓ |
| opfs | ✗ | ✓ | ✗ |
| fsaa | ✗ | ✓ (Chromium) | ✗ |
| comment | ✓ (DOM shim) | ✓ | ✓ |
| fetch | ✓ (fetch shim) | ✓ | ✓ (with server) |
| rest | ✓ (fetch shim) | ✓ | ✓ (with server) |
| overlay | ✓ | ✓ | ✓ |
| custom | ✓ | ✓ | ✓ |
| service worker | ✗ | ✓ (HTTPS) | ✗ |
| dom helpers | ✗ | ✓ | ✓ |

custom backend tests verify the mounting contract: missing methods get safe defaults, `init`/`destroy` lifecycle is honored, capability flags propagate correctly, readonly enforcement works. a mock backend with counters verifies that the VFS dispatches to the right methods with correct paths.

additional test areas:
- **symlinks:** create, readlink, stat vs lstat, ENOTSUP on backends without symlink support
- **touch:** create new file, update mtime on existing file
- **cp:** same-backend, cross-mount, recursive directory copy
- **cross-mount rename:** copy+delete behavior, cleanup on failure
- **concurrency:** concurrent writeFile to same path (last-write-wins, no corruption)
- **dom helpers:** toURL caching/revocation, fromDrop, fromPicker (browser-only)

## versioning

pre-1.0. the backend interface and API surface may change. storage formats (IndexedDB schema, comment format) will be versioned so that future changes can migrate.

## license

CC0 for the interface contract and path utilities (algorithm transcriptions — anyone should be able to implement this API).
MIT for the implementation.
