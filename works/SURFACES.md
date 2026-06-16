# Authoring a Works surface

Practical companion to `auditable-works-spec.md` (§§5–6, §15). The spec says
*what* a surface must do; this is *how* — patterns, gotchas, the existing
surfaces as worked examples — so a new surface kind takes a session, not a
month of rediscovery.

This doc lives in the repo so it's discoverable from the code; the formal
contract lives in the spec.

---

## 1. What a surface is

An iframe app that:

1. Receives an `abus:welcome` postMessage from its parent (the shell), with
   an A-Bus `MessagePort` and a `tab` descriptor.
2. Connects A-Bus over that port (`connect(port)` from `@gcu/abus`).
3. Exposes the §5.2 `Surface` interface (three methods + three signals).
4. Operates: renders some UI, reads/writes the workspace VFS through the
   shell's `works` service, handles user input, etc.
5. Emits `Surface.Ready` exactly once, last, when its UI is mounted and it
   is ready to accept method calls.

Surfaces come in two **hosting tiers**: the default *sandboxed* tier — an
iframe, which is what §§1–11 describe — and a *privileged* inline tier that
renders in the shell's own realm, for the few first-party surfaces that need
device APIs (camera / screen capture) or direct VFS access. See §12; until
you hit one of those needs, stay sandboxed.

The shell is the broker, owns the workspace VFS, hosts the rails layout
manager, and spawns surfaces from a built-in registry. Surfaces own no
durable state — the workspace VFS is the single source of truth.

A new surface kind is **a new HTML file** in `works/surfaces/` plus three
small wiring changes in the build + the shell. That's it.

---

## 2. The minimal surface (~30 lines)

The barest possible surface. Connects A-Bus, exposes the contract, emits
`Ready`. Doesn't read or write anything. Useful as a smoke target or as a
template to start from.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Stub</title>
<style>html,body{margin:0;height:100%;background:#14171a;color:#c8ccd0;
  font:13px/1.5 ui-sans-serif,system-ui,sans-serif}</style>
</head>
<body>
<div style="padding:16px">stub surface — connected.</div>
<script type="module">
import { connect } from '@gcu/abus';

window.addEventListener('message', async (ev) => {
  if (ev.source !== window.parent || !ev.data || ev.data.type !== 'abus:welcome') return;
  const { port, tab } = ev.data;

  let bus;
  try { bus = await connect(port, { client: 'stub' }); }
  catch (e) { console.error('A-Bus connect failed:', e); return; }

  bus.expose('/', {
    Surface: {
      methods: { Flush: () => {}, CanClose: () => true, Relocated: () => {} },
      signals: ['DirtyChanged', 'TitleChanged', 'Ready'],
    },
  });
  bus.signal({ path: '/', interface: 'Surface', member: 'TitleChanged' },
    ['Stub ' + (tab && tab.id || '?')]);
  bus.signal({ path: '/', interface: 'Surface', member: 'Ready' }, []);
});
</script>
</body>
</html>
```

`works/surfaces/stub.html` is essentially this (plus a writable probe). It
is the *only* runtime test the works-smoke uses for the file:// + spawn
plumbing — keep it tiny.

---

## 3. The surface contract (§5.2)

### 3.1 Methods you implement

```
Surface.Flush()        → void    — persist your edits now. Called at save
                                   barriers (Ctrl+S, before close, before
                                   workspace export). Idempotent.
Surface.CanClose()     → boolean — veto a close. Read-only surfaces return
                                   true. Writable surfaces typically also
                                   return true and just block on Flush
                                   (better UX than a modal "unsaved" prompt).
Surface.Relocated(p)   → void    — the shell moved your project / file.
                                   Future writes target the new path.
```

### 3.2 Signals you emit

```
DirtyChanged(boolean)  — true on first unflushed edit; false after a flush
                         completes. Drives the dot on the tab.
TitleChanged(string)   — your tab label changed (file rename, project
                         title edit, …). Emit on init too.
Ready()                — fired exactly once, last, when the surface is
                         mounted and the methods above will succeed.
```

### 3.3 Lifecycle

```
parent posts {type:'abus:welcome', port, tab, home}
  → surface connects A-Bus
  → surface initialises (reads its file, sets up UI, …)
  → surface exposes the contract
  → surface emits TitleChanged + Ready
  → operate…
  → eventually: Flush + close
```

The surface MUST NOT emit Ready before the contract is exposed. The shell
treats `Ready` as the "you can call my methods now" handshake.

The shell's `Surface.Flush()` call has a generous timeout (5 s); a surface
that misses it does not block the save — the shell proceeds and warns.
Don't depend on Flush completing instantly.

---

## 4. The three kinds of surface

How a user opens it determines what shape it takes.

### 4.1 Project surface

Bound to a `/projects/<name>/` directory whose `project.json` kind matches
the registered kind name. Opened from the tree by double-click on a
project row. The notebook is the only one today.

**When to pick this**: your document IS a directory of files (a notebook
+ data siblings; a slide deck + asset folders; a multi-file CAD project).
The project IS the unit; users want to think "open my Quad project," not
"open Quad/notebook.txt."

**Pattern**: implement a `Host` seam (`src/js/host.js` in auditable's
case). `provideVFS()` returns a VFS that mounts your own project as
`/projects/self` (Unix-style: 'my' project is always `self`, regardless
of the real workspace path). Use a **local working copy + write-back** if
you need synchronous file APIs; an A-Bus proxy if everything is async-
friendly. The notebook does local-copy because `notebook.fs` (file ops in
cells) is synchronous and predates Works.

**Marker**: `project.json` carries `{kind, id, title}`. The shell reads
`kind`, dispatches to your surface. `id` is a stable random string (your
surface mints it on first save); the tree binds tabs to `id` so rename
doesn't break references.

**Worked example**: the Auditable notebook — `auditable.html` itself,
which detects iframe vs standalone, runs `worksBoot` in the former with
`createWorksHost` from `src/js/host.js`. The standalone↔Works difference
is isolated to the Host; everything else is unchanged.

### 4.2 Loose-file surface

Bound to a single file path by extension. Opened from the tree by
double-click on a file row; the registry dispatches by extension.

**When to pick this**: your "document" is one file (a `.csv`, an image,
a markdown note). Single-file viewers and editors.

**Pattern**: read the file with `bus.call({to:'works', path:'/',
interface:'VFS', member:'Read'}, [tab.path, 'utf8'])` for text, no
encoding arg for bytes. For an editor, also write back via `'Write'` on a
debounce + on `Surface.Flush()`.

**No VFS instance needed**. `bus.call` directly is fine for one or two
operations per surface lifetime. Don't pull in `@gcu/vfs` and
`AbusBackend` for a one-shot read.

**Worked examples**:
- `text.html` — minimal editor over a textarea. Read on welcome, write
  on debounced edit + Flush.
- `preview.html` — read-only viewer that dispatches on extension to a
  CSV table / JSON tree / markdown / image / PDF renderer.

### 4.3 Tool surface

Workspace-level, spawned from the menu (or a debug action, or right-
click). May take an optional path (for "Open terminal here") but doesn't
strictly bind to one.

**When to pick this**: it's a tool / utility / monitor, not a document.
Terminal, inspector, future `top`-style process viewer, future logs
viewer.

**Multi-instance vs singleton**:
- **Multi-instance** (`terminal`): each spawn creates a new tab. Common
  case for shells, editors, scratch tools. Use this unless you have a
  reason not to.
- **Singleton** (`inspector`): only one open at a time. Reserve for
  diagnostic surfaces where multiple instances would be confusing. The
  shell doesn't enforce singleton — surfaces.js `openPath` dedups
  *by path*, but tool surfaces aren't path-bound, so a tool surface that
  wants to be singleton needs to check if one is already open in its
  spawn handler.

**Spawn entry points**: typically a menu item (Tools → Terminal), a
tree context-menu action (right-click folder → Open terminal here), or
both.

**Worked examples**:
- `inspector.html` — A-Bus broker introspection; spawned from Debug
  menu; singleton in practice (the user only opens it for debugging).
- `terminal.html` — geas shell; multi-instance from Tools → Terminal or
  tree → Open terminal here.

---

## 5. The boot template

**Use `@gcu/surface`'s `bootSurface` — don't hand-roll the handshake.** As of
2026-06-16 all 15 built-in surfaces boot through it; it encapsulates the
welcome→connect→claim→expose→Ready order (including the classic footgun: emitting
`Ready` before the contract is exposed) so you can't get it wrong:

```js
import { connect } from '@gcu/abus';
import { bootSurface } from '@gcu/surface';

bootSurface({
  connect,
  client: 'my-surface-kind',
  onConnect: (bus) => installThemeSubscription(bus),   // optional, post-connect
  // Per-surface §5.2 behaviour lives here. A trivial viewer/tool passes `{}`
  // (defaults: Flush → undefined, CanClose → true, Relocated → noop). An
  // editor supplies flush + relocate. Created BEFORE mount, so closures over
  // app state set in mount are fine (the shell only calls these post-Ready).
  makeHost: (bus) => ({
    flush:    async () => { /* save now */ },
    relocate: (newPath) => { /* re-point the bound path */ },
  }),
  mount: async ({ bus, tab }) => {
    // Initialise UI, read tab.path, wire handlers, then emit TitleChanged.
    bus.signal({ path: '/', interface: 'Surface', member: 'TitleChanged' }, [title]);
  },
});
```

`bootSurface` exposes the `Surface` interface for you (from the host's
`flush`/`canClose`/`relocate`), runs `mount`, then emits `Ready` LAST. It only
exposes the `Surface` interface — a surface that needs another exposed interface
adds it inside `mount` (subscriptions and outbound calls have always lived in
`mount`/the body). One caveat: `onConnect` is **not awaited**, so anything that
must complete *before* the UI mounts (e.g. an awaited theme apply so a canvas
reads tokens on first paint, as patchbay needs) belongs at the top of `mount`,
not in `onConnect`.

Under the hood `bootSurface` is the raw handler below (for reference — you
should not write this by hand):

```js
window.addEventListener('message', async (ev) => {
  // §7.1 — adopt the welcome only from our own parent.
  if (ev.source !== window.parent) return;
  if (!ev.data || ev.data.type !== 'abus:welcome') return;
  const { port, tab, home } = ev.data;

  let bus;
  try { bus = await connect(port, { client: 'my-surface-kind' }); }
  catch (e) { showError('A-Bus connect failed: ' + e.message); return; }

  // 1. Initialise UI, read your file, etc.
  // …

  // 2. Expose the contract.
  bus.expose('/', {
    Surface: {
      methods: {
        Flush:     async () => { /* save now */ },
        CanClose:  () => true,
        Relocated: (newPath) => { /* update */ },
      },
      signals: ['DirtyChanged', 'TitleChanged', 'Ready'],
    },
  });

  // 3. Emit Title + Ready (Ready LAST).
  bus.signal({ path: '/', interface: 'Surface', member: 'TitleChanged' }, [title]);
  bus.signal({ path: '/', interface: 'Surface', member: 'Ready' }, []);
});
```

**The welcome carries three things**:
- `port` — the A-Bus `MessagePort`. Single-use; passed to `connect`.
- `tab` — `{ id, path, kind }`. `path` is the project/file path the surface
  was opened on (or `/` for path-less tools). `id` is the rails tab id.
- `home` — the workspace storage-home descriptor (`{kind:'idb',...}` or
  `{kind:'fsaa',handle}` etc.). Project surfaces use this for the Chunk
  5c delegation path; loose-file and tool surfaces typically ignore it.

**Don't expose the contract before connect resolves**. The bus is the
contract carrier; `bus.expose` before `await connect` is a programming
error.

**Don't emit Ready before the contract is exposed**. The shell will call
your methods the moment Ready fires.

---

## 6. VFS access — pick the right level

### 6.1 The simplest: `bus.call` directly

For one or two file operations, no VFS instance needed:

```js
// read
const text = await bus.call(
  { to: 'works', path: '/', interface: 'VFS', member: 'Read' },
  [path, 'utf8']);

// write
await bus.call(
  { to: 'works', path: '/', interface: 'VFS', member: 'Write' },
  [path, content]);
```

Other members: `List`, `Stat`, `MkDir`, `Exists`, `Move`, `Delete`. See
`works/js/works-service.js` for the canonical list.

`preview.html` and `text.html` both use this — one read, one write, no
ceremony. The first thing to reach for.

### 6.2 Full VFS via `AbusBackend`

For complex multi-file work — the terminal needs `ls`, `cat`, `cd`,
pipes, redirections — build a proper VFS in the surface:

```js
import { VFS, AbusBackend } from '@gcu/vfs';

const vfs = new VFS();
vfs._mounts.set('/', new AbusBackend({ bus, service: 'works', root: '' }));
```

`/` proxies the entire workspace VFS through A-Bus — `/tmp` (volatile
scratch space, workspace-wide), `/projects`, `/home`, `/lib`, `/mnt/*`
all come through it.

**Cost**: `@gcu/vfs` is ~90 KB compressed (the works lib store has it
once; your surface's `deps` opt-in to it costing nothing extra on disk).
Worth it when you need readdir-trees, exists-checks, recursive ops.

### 6.3 `/usr/lib` builtins — `load("@gcu/<name>")`

The shell pre-installs `@gcu/abus`, `@gcu/vfs`, `@gcu/xterm`, `@gcu/geas`
into the workspace at `/usr/lib/<encodeURIComponent(url)>/` at every boot.
A surface (notebook in particular) sees them via the notebook's existing
`hydrateModulesFromVfs` (which walks `/usr/lib` *and* `/lib`, latter
shadows former).

This is the Unix-y "system-provided" location. User installs via
`install("@some/pkg")` go to `/lib`; the shell never touches `/lib`. A
user-installed module of the same URL as a builtin **shadows** the
builtin — `load("@gcu/xterm")` returns the user's version if they pinned
one.

### 6.4 The delegation-vs-proxy gotcha

The notebook surface's `/` mount is *delegated* — a direct `IDBBackend`
(or `FSAABackend`) pointing at the workspace storage home, not an A-Bus
proxy. This is the Chunk 5c speedup: large reads bypass the relay.

**Consequence**: the surface's `/` mount only sees what's on disk in the
storage home — `home/lib/mnt/projects`. It does **not** see the shell's
volatile mounts (`/tmp`, `/sys`, `/usr`). Those mounts only exist in
the shell's full VFS.

A surface that needs to read a volatile mount **must** add it as an
explicit proxy in its descriptor list:

```js
{ kind: 'proxy', mount: '/usr/lib', root: '/usr/lib' }   // always relayed
```

The notebook's host.js does this for `/usr/lib`. Other surfaces that
need `/tmp` or `/sys` would do the same (and also fall back to the
A-Bus proxy via `/` when the workspace home isn't delegated).

Loose-file and tool surfaces that go through `bus.call` directly don't
hit this — `bus.call` is the relay path, and the works service's VFS is
the shell's full VFS, mounts and all.

---

## 7. Dirty tracking and flush

If your surface is writable, follow this pattern (text.html is the
canonical example):

```js
let dirty = false;
let flushP = null;
let flushTimer = null;

function markDirty() {
  if (flushP) return;          // a flush is in flight; let it settle
  if (!dirty) {
    dirty = true;
    bus.signal({ path: '/', interface: 'Surface', member: 'DirtyChanged' }, [true]);
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 1500);
}

async function flush() {
  if (flushP) return flushP;   // dedup concurrent flushes
  clearTimeout(flushTimer); flushTimer = null;
  flushP = (async () => {
    try {
      await bus.call(
        { to: 'works', path: '/', interface: 'VFS', member: 'Write' },
        [path, getCurrentContent()]);
      if (dirty) {
        dirty = false;
        bus.signal({ path: '/', interface: 'Surface', member: 'DirtyChanged' }, [false]);
      }
    } catch (e) {
      console.error('flush failed:', e);
      // Stays dirty; user retries or close veto.
    } finally { flushP = null; }
  })();
  return flushP;
}
```

Then:

- `editor.addEventListener('input', markDirty);` — every edit nudges
  the self-flush timer.
- `Surface.Flush()` in the contract → `flush()`. The shell calls it at
  save barriers; your debounce can sleep through it.
- `Surface.CanClose()` returns true. The shell calls `Flush()` before
  close anyway.

**The 1.5 s debounce** is what the notebook and text editor both use.
Tune it to your write cost if needed — but consistency is nice.

**Read-only surfaces** (preview, inspector) implement `Flush` as a no-op
and never emit `DirtyChanged`. The flag stays false forever.

---

## 8. Worker integration (terminal-class)

When your surface needs to run heavy code without blocking the UI — geas
in the terminal, a heavy parser, a long-running search — use a Web Worker.

### 8.1 The shape

```js
// On the main thread:
function spawnWorker() {
  const src = `
    /* worker code as a string, or import from a known blob URL */
    self.onmessage = (e) => { /* ... */ };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  return new Worker(url);          // or: new Worker(url, { type: 'module' })
}
```

### 8.2 The cross-blob-origin gotcha (`file://`)

Module workers from blob URLs work fine in Chromium *over HTTP*. From
`file://`, blob URLs get unique opaque origins per-blob — so a module
worker created from blob URL A cannot `import` from blob URL B, even
when both were created by the same surface.

**Workaround**: classic worker with the dep source inlined into the
worker source string. The terminal does this for geas: reads the inlined
`<script type="text/plain" id="inlined-lib-geas">` (placed by the shell
at decompress time), strips the trailing `export { ... }`, appends
`setupGeasWorker(self, ...)`, spawns as a classic Worker.

The same caveat applies to module workers via blob URL trying to import
the `/usr/lib` blob URLs. They cannot. Inline-into-worker-source is the
pattern.

### 8.3 VFS in the worker

If your worker needs filesystem access, use the package's worker-RPC
helpers (geas has `setupGeasWorker` + `createGeasClient` + `serveVFS`).
Don't re-invent. The bridge runs through a `MessageChannel`: main thread
calls `serveVFS(port, mainSurfaceVFS)`, worker side reads through the
client (which internally calls back through the port).

---

## 9. Build + registry checklist

Five steps for a new surface kind, from blank file to smoke-passing:

### 9.1 Create the HTML file

```
works/surfaces/<kind>.html
```

Use the §5 template. Import shared libs via bare specifier (`@gcu/abus`
etc.) only — the build's `rewriteSurfaceToDynamic` will inline them at
decompress time. Stray imports outside the allow-list error out the
build.

### 9.2 Register in `build.js` (works target)

Add an entry to the `surfaceParts` loop's array:

```js
{ kind: 'my-kind', file: 'works/surfaces/my-kind.html', deps: ['abus', 'vfs'] },
```

`deps` lists every `@gcu/<name>` your surface imports. Forgetting one
errors at decompress (the build's stray-import check catches it).

If your surface needs special build extras (xterm CSS inlined, a worker
payload generated), follow the terminal pattern: `extras: 'my-kind'` and
a `buildMySurfaceExtras` function. Keep this minimal — most surfaces
don't need it.

### 9.3 Register the kind in `works/js/surface-registry.js`

```js
registerKind('my-kind', {
  label:      'My Surface',
  icon:       '◆',
  extensions: ['.foo', '.bar'],   // for loose-file surfaces; [] otherwise
});
```

For project surfaces, leave `extensions: []` — the tree dispatches by
`project.json` `kind`, not extension.

Registration order matters for extension dispatch: `kindForExtension`
returns the first match. Register richer renderers BEFORE generic ones
(preview is registered before text so .csv opens in preview, not text).

### 9.4 Wire up the spawn entry point

Depending on your surface kind:

- **Project surface**: nothing — the tree's double-click handler
  dispatches automatically via `project.json` kind.
- **Loose-file surface**: nothing — same, via extension.
- **Tool surface**: add a menu item in `works/js/menubar.js`:
  ```js
  { label: 'My Tool', action: 'tools:my-kind' },
  ```
  and the handler:
  ```js
  if (action === 'tools:my-kind') { spawnSurface('my-kind'); return; }
  ```
  Optionally add a tree context action (`works/js/tree.js` showMenu) for
  "Open here" patterns.

### 9.5 Smoke test

Add a check to `test/works-smoke.mjs`:

```js
const myOpen = await page.evaluate(async () => {
  const W = window.WKS;
  const tabId = W.spawnSurface('my-kind', { /* opts */ });
  const rec = W.surfaces.get(tabId);
  const deadline = Date.now() + 20000;
  while (rec && !rec.ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { tabId, ready: !!(rec && rec.ready) };
});
```

```js
'my-kind: surface boots': myOpen.ready === true,
```

If your surface exposes a behaviour (renders a table, runs a command,
…), add a check that exercises it via `surfaceFrame(tabId)` and a
`frame.evaluate(...)`. The preview tests are the model — reach into the
frame's DOM and assert a specific node exists.

---

## 10. Anti-patterns

Things that look reasonable but bite you later.

- **Owning durable state outside the workspace VFS.** Your iframe gets
  thrown away on close / reload. The workspace IS the persistence.
  IndexedDB inside the surface is a smell — if you reach for it, ask
  whether the data should be in the workspace.
- **Top-level imports of non-allow-listed deps.** The build will reject
  them, but the error is at build time, not at code-review time. Plan
  your deps with the kind registration; don't bolt on imports later.
- **Cross-blob ESM imports from `file://`.** Won't work. Worker code
  that imports `@gcu/<x>` from a blob URL will fail. Inline at the
  source-string level for workers.
- **`String.prototype.replace(re, stringContainingDollar)`** — `$&`,
  `$'`, `` $` `` are special tokens in string replacements. The vfs and
  geas bundles both contain literal `$'`. Use a *function* replacement
  (`replace(re, () => str)`) when injecting bundle source.
- **Emitting `Ready` before the contract is exposed.** The shell starts
  calling your methods on Ready. Methods that aren't exposed yet =
  "no such interface" errors.
- **Forgetting to handle the welcome's `ev.source` check.** `if
  (ev.source !== window.parent) return` — surfaces are iframes; only
  the shell may welcome them. Skipping this is a security smell (spec
  §7.1).
- **Blocking the UI thread for >100 ms.** Use a worker. The notebook's
  cell execution and the terminal's geas both run in workers; copy the
  pattern.
- **Synchronous `notebook.fs`-style file APIs without a local copy.**
  The workspace VFS is async-only over A-Bus. If your surface has a
  legacy synchronous API (the notebook had this), use the Host pattern
  (local-copy with boot-load + flush-back).

---

## 11. Reference implementations

Each existing surface teaches something specific. Read in this order if
you're new:

1. **`works/surfaces/stub.html`** (50 lines) — the absolute minimum.
   A-Bus welcome, contract, Ready. Nothing else. Read this first.
2. **`works/surfaces/inspector.html`** (200 lines) — read-only tool
   surface, spawned from a menu, singleton in practice. Calls another
   service's introspection (`works.Inspect.Snapshot`), refreshes
   periodically. *No file I/O, no dirty tracking.*
3. **`works/surfaces/text.html`** (~150 lines) — minimal editable
   loose-file surface. Read on welcome, debounced flush, Flush method.
   *The canonical writable-surface pattern.*
4. **`works/surfaces/preview.html`** (~280 lines) — read-only file
   viewer with internal type dispatch (CSV / JSON / MD / image / PDF).
   *Shows how one surface can host multiple renderers.*
5. **`works/surfaces/terminal.html`** (~150 lines) — full tool surface
   with a Web Worker (geas), an in-surface VFS with AbusBackend +
   MemoryBackend, xterm.js + WebGL renderer, a REPL. *The most
   complex surface; touches every pattern in this doc.*
6. **`auditable.html` + `src/js/host.js`** — the notebook surface. The
   only project surface today, and the only one that uses the Host
   seam + local-copy + flush-back. Read after you've digested the
   smaller ones; this is its own scale of work.

---

## 12. Hosting tiers: sandboxed vs privileged surfaces

> **Status: design — not yet implemented.** Atalaia (`ext/atalaia`) is the
> first planned consumer; this section is the contract it builds against.
> Everything in §§1–11 describes the *sandboxed* tier, which is the only one
> shipping today.

A surface's *host* — iframe or not — is orthogonal to its *kind* (§4, which is
about how a user *opens* it). The iframe is an isolation choice, not a rails
requirement, and two facts already in the code make a second tier nearly free:

- **Rails hosts an element, not an iframe.** `renderPanel` returns whatever
  element it likes; rails positions it and never reparents it (`layout.js:29`
  returns `rec.iframe` today — a `<div>` works identically).
- **A-Bus is realm-agnostic.** The shell's own `works` service is already an
  in-realm peer: a `MessageChannel` whose `port2` the shell `connect()`s
  itself, no iframe and no `postMessage` welcome (`works-service.js:48-50`).

Combine them and you get **privileged surfaces** — dom0 to the sandboxed
tier's domU, ring-0 to its ring-3:

| | Sandboxed (default) | Privileged (inline) |
|---|---|---|
| Host element | `<iframe>` (blob URL) | shell-owned `<div>` + shadow root |
| A-Bus | `postMessage` welcome → `connect(port)` | in-realm `MessageChannel`; shell `connect`s for it |
| Realm / origin | own document, own origin (opaque on `file://`) | the shell's realm + origin |
| VFS / broker | RPC via `bus.call({to:'works',…})` | direct `WKS.vfs` / `WKS.broker` |
| Runtime payload | embedded gzip blob per surface | none — it's shell code |
| Trust | any surface, incl. third-party `.gcupkg` | **first-party / trusted code only** |
| Fault blast radius | contained — the iframe dies alone | shared — a crash can take the shell |

### 12.1 When to reach for privileged

Only when the sandbox is actively in your way. Concretely:

- **Capture / device APIs.** `getUserMedia` / `getDisplayMedia` are gated both
  by the iframe's Permissions-Policy (`allow="camera; display-capture"`, which
  the shell does **not** set on surface iframes) and by the `blob:file://`
  opaque origin a sandboxed surface runs under. A privileged surface runs in
  the shell's **top-level** realm — on a `file://`-opened `works.html` that's a
  real, non-opaque `file://` origin (a secure context), so capture works with
  no permission-policy plumbing and no `localhost` workaround. **This is why
  Atalaia is the first consumer.**
- **IndexedDB / WebGL / WebGPU**, for the same opaque-origin reason (`file://`
  blocks IDB in `blob:` iframes — see §8.2 and §10). Cartobrush's hillshade GL
  contexts and the dee 3-D panel want this.
- **Large shared buffers.** Read a 64 MB scalar layer straight off `WKS.vfs`
  instead of serializing it across an A-Bus port.
- **Boot weight.** No per-surface embedded runtime blob; it shares the shell's
  already-loaded module instances.

If none of those bite, **stay sandboxed.** The isolation is worth more than the
convenience.

### 12.2 What you give up — and the mitigations

- **Fault isolation.** Ring-0: an unhandled throw or leak runs in the shell's
  realm. Wrap the mount in try/catch and fail to a visible error state inside
  your root, never let it throw past the mount.
- **CSS / global collisions.** You share the shell's document. **Mitigation:
  render into a shadow root** (the mount hands you one) — it restores CSS
  isolation while keeping JS-realm privilege. Switchboard's `--sw-*` / `--au-*`
  tokens are CSS custom properties, which pierce shadow boundaries, so theming
  still cascades in unchanged.
- **Trust.** The sandbox *is* the security boundary for untrusted code, so
  privileged is **first-party only** — the registry refuses to host an
  extension-registered (`.gcupkg`) surface inline; third-party surfaces are
  always iframes. (Enforced in `registerKind`: an `isExtension` kind asking for
  `host:'inline'` is downgraded to `'iframe'` with a console warning.)
- **No standalone story for free.** A privileged surface is shell code, not a
  standalone HTML file. The `@gcu/dock` roadmap item (environment-adaptive
  host) is the path to one codebase running both standalone and inline; until
  then, an inline surface is Works-only.

### 12.3 The contract is identical

A privileged surface implements the **same §5.2 `Surface` contract** — the same
`Flush` / `CanClose` / `Relocated` methods and `DirtyChanged` / `TitleChanged` /
`Ready` signals, on the same A-Bus. Dirty-tracking (§7), VFS access (§6), and
worker integration (§8) are all unchanged. Only two things differ: the
**transport** (you're handed a live `bus`, not a `postMessage` welcome) and the
**host** (you render into a shadow root, not a fresh document). The symmetry is
deliberate — it's what lets a single surface target either tier (the dock
angle).

### 12.4 The mechanism

Four small changes turn the single-tier spawner into a two-tier one.

**Registry — a `host` flag + a `mount` function.** Inline surfaces have no
embedded HTML payload; they register a mount entry point instead:

```js
registerKind('atalaia', {
  label: 'Atalaia', icon: '◎', host: 'inline',
  mount: mountAtalaia,            // (ctx) => disposeFn | Promise<disposeFn>
  extensions: ['.atalaia'],       // or [] for a tool surface
});
```

`host` defaults to `'iframe'`, so everything today is unaffected.

**Spawn branch — `createSurface` forks on `host`:**

```js
import { connect } from '#abus';   // add to surfaces.js imports

export function createSurface(tabId, kind, opts = {}) {
  const def = kindDef(kind);
  if (!def) throw new Error('unknown surface kind: ' + kind);
  if (def.host === 'inline') return createInlineSurface(tabId, kind, def, opts);
  /* …existing iframe path… */
}

function createInlineSurface(tabId, kind, def, opts) {
  const host = document.createElement('div');
  host.className = 'works-surface-inline';
  const root = host.attachShadow({ mode: 'open' });    // CSS isolation

  // In-realm A-Bus peer — the works-service.js:48-50 pattern.
  const ch = new MessageChannel();
  const uniqueName = WKS.broker.connect(ch.port1);
  _byUnique.set(uniqueName, tabId);

  const rec = { tabId, kind, uniqueName, element: host,
                path: opts.path || '/', title: opts.title || def.label,
                ready: false, dirty: false, dispose: null };
  WKS.surfaces.set(tabId, rec);

  (async () => {
    const bus = await connect(ch.port2, { client: kind });
    // The surface exposes the §5.2 contract + emits Ready itself, exactly
    // like the iframe boot template — it just receives the bus directly.
    rec.dispose = await def.mount({
      root, bus,
      tab: { id: tabId, path: rec.path, kind },
      vfs: WKS.vfs, home: WKS.home,
    });
  })().catch((e) => { /* render the error into `root`; never throw past here */ });

  return rec;
}
```

**Panel handoff — `renderPanel` returns whichever element exists:**

```js
if (rec) return rec.iframe || rec.element;
```

**Teardown — `tab:close` disposes the mount** (alongside the existing
uniqueName / record cleanup in `setupSurfaces`):

```js
if (typeof rec.dispose === 'function') { try { rec.dispose(); } catch {} }
```

`decompressSurfaces` skips `host:'inline'` kinds (there's no embedded payload),
and the surface module is imported from the works module manifest
(`works/js/main.js`) so it lands in the build — there's no
`works/surfaces/<kind>.html`, no `surface-<kind>` script tag, no blob.

### 12.5 The inline mount contract

```
mount(ctx) → disposeFn | Promise<disposeFn>

ctx = {
  root,   // an open ShadowRoot — render all UI here (CSS-isolated)
  bus,    // live A-Bus peer — expose the §5.2 Surface contract on it
  tab,    // { id, path, kind }
  vfs,    // WKS.vfs — the shell's full VFS, direct (every mount, /tmp & /sys too)
  home,   // storage-home descriptor
}
```

The mount does what the iframe boot template (§5) does — initialise UI into
`root`, `bus.expose('/', { Surface: {…} })`, then emit `TitleChanged` + `Ready`
last — minus the welcome listener. It returns a `dispose` that tears down
timers, capture streams, workers, and observers. **Releasing a live camera /
display `MediaStream` in `dispose` is mandatory** — a privileged surface that
leaks a stream leaks it into the shell's own realm.

### 12.6 Atalaia as the worked example

Atalaia registers `host:'inline'` because its whole reason for being — reading
a `getDisplayMedia` / `getUserMedia` frame source — is exactly what the sandbox
blocks. Its mount:

1. Renders the live-frame canvas + ROI overlays + trace panel into `root`.
2. Acquires the source via `navigator.mediaDevices.getDisplayMedia(…)` — which
   works because it's in the shell's top-level (non-opaque) origin.
3. Reads/writes the `watch.atalaia/` directory directly through `ctx.vfs`
   (frame crops, `log.ndjson`) — no port-serialization of image data.
4. On a fired trigger, emits an A-Bus event (`bus.signal` / `bus.call`) that
   notebook cells and other surfaces subscribe to — Atalaia as a reactive
   source, exactly as its spec intends.
5. `dispose` stops every track on the active `MediaStream` and clears the
   sample-tick timer.

The smoke test (§9.5) for an inline surface skips the `surfaceFrame` step
(there is no frame) and reaches into `rec.element.shadowRoot` instead to assert
its UI mounted.

---

## 13. Related reading

- `auditable-works-spec.md` §§5–6, §15 — the formal contract,
  registry, and packaging. This doc references its section numbers.
- `works/js/works-service.js` — the canonical VFS interface a surface
  consumes (`Read` / `Write` / `List` / `Stat` / `MkDir` / `Exists` /
  `Move` / `Delete`) plus the `Shell` interface (`OpenPath`).
- `works/js/surface-registry.js` — `registerKind`, `kindDef`,
  `kindForExtension`, `decompressLibs`, `decompressSurfaces`,
  `installSharedLibsToVfs`. Read when you wonder how a kind gets
  dispatched or how `/usr/lib` gets populated.
- `works/js/surfaces.js` — `createSurface` / `spawnSurface` /
  `openPath`. The shell-side spawn machinery; read when your surface
  needs unusual spawn options.
- `build.js` (works target) — the `surfaceParts` loop, the
  `rewriteSurfaceToDynamic` inliner, the import-map placeholder
  scheme. Read when your surface's deps need a new lib in the store.
