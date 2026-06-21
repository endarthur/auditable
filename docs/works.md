# Auditable Works

**A single-file GCU desktop.** Auditable Works is a document-agnostic workspace shell — a tabbed layout host with a workspace filesystem, a coordination bus, and a set of iframe surfaces (notebook, terminal, docs reader, file preview, inspector) that compose into something between an IDE and a workstation.

```
node build.js --target=works
```

produces `works.html` — open it, get a shell. No install, no server, no dependencies.

## What Works is

Works started as "a tabbed notebook manager" (the old version is what the legacy `Works Notebook Format` was for). The current version is broader: the shell hosts **surfaces** — iframe apps that implement a small contract — and the surfaces are document-agnostic. The notebook is one surface; the terminal is another; documentation, file preview, A-Bus inspector, settings, are others. New kinds of surface (a diagram editor, a 3D viewer, a spreadsheet) are a single HTML file plus three lines of registry config.

Three commitments:

1. **The browser is the kernel; Works is the userland.** A filesystem (`@gcu/vfs`), a message bus (`@gcu/abus`), a layout manager (`@gcu/rails`), UI chrome (`@gcu/menu`, `@gcu/dialog`), a desktop shell, and apps. All running in one browser tab.
2. **The VFS is the workspace.** No separate "project files" concept beyond a directory of files marked by a `project.json`. Surfaces read and write the workspace VFS; nothing else has durable state.
3. **Single-file deployable.** Works ships as one HTML file (~2.5 MB) that runs from disk (`file://`). No build step required on the consumer side.

## Storage model

The workspace is a tree of files and directories — the **workspace VFS**, a [@gcu/vfs](https://www.npmjs.com/package/@gcu/vfs) instance the shell owns. Four mounts:

| Mount | Persistent? | Backend | Contents |
|---|---|---|---|
| `/home` | yes | IDB (default) or FSAA disk folder | User files — projects, notebooks, scratch work |
| `/mnt/<name>` | yes (handles in shell meta IDB) | FSAA disk-folder mounts | Disk folders mounted explicitly via *File → Mount folder…* |
| `/tmp` | no | Memory | Volatile scratch space (shared across surfaces) |
| `/usr/lib` | no | Memory | Shell-bundled libraries (`@gcu/{abus,vfs,xterm,geas}`) — `load()`-able from notebooks |

Storage homes are chosen at workspace creation: **IndexedDB** (the default — works everywhere) or **File System Access API** (Chromium-only; mounts a disk folder as `/home`).

### Mount delegation

When the storage home is an FSAA folder, file reads inside a notebook surface go *directly* to the OS via the mount-delegation protocol — the shell doesn't proxy individual reads through A-Bus. For IDB-backed homes (and cross-realm mount targets), reads fall back to the A-Bus proxy path. Either way, the API is the same from the surface's perspective.

### `project.json` and the project boundary

A directory containing a `project.json` is a *project*. Project-level operations (export to a standalone .html, set defaults, attach metadata) anchor on it. Without `project.json`, the directory is just a directory. Most workspaces start with a single project at `/home/<name>/`.

## Surfaces

A **surface** is an iframe app that implements the §5.2 *Surface* contract (three methods + three signals) over A-Bus. The shell hosts surfaces in tabs; surfaces own no durable state — the workspace VFS is the single source of truth.

Built-in surface kinds (Works 0.1):

| Kind | File | Purpose |
|---|---|---|
| `notebook` | `auditable.html` embedded whole | Runs an auditable notebook. The primary surface for code/data work. |
| `terminal` | `surfaces/terminal.html` | The `geas` shell — pkg, ed, readline, plus everything geas ships. |
| `docs` | `surfaces/docs.html` | In-tool documentation reader; Ctrl+K full-text search via [@gcu/librarian](https://www.npmjs.com/package/@gcu/librarian). |
| `text` | `surfaces/text.html` | Plain-text editor for `.txt`, `.md`, `.json`, etc. |
| `preview` | `surfaces/preview.html` | Read-only render for CSV, JSON, Markdown, images, PDF. |
| `inspector` | `surfaces/inspector.html` | A-Bus inspector — every message on the bus, live. Debug tool. |
| `settings` | `surfaces/settings.html` | Workspace settings (theme, fonts, mount management). |
| `stub` | `surfaces/stub.html` | Smoke target — minimal "I connected" surface. |

A new surface kind is a single HTML file in `works/surfaces/` plus three lines in `works/js/surface-registry.js`. The contract is documented in [works/SURFACES.md](https://github.com/gentropic/auditable/blob/main/works/SURFACES.md) — practical authoring guide with patterns, gotchas, and reference implementations.

## Layout

[@gcu/rails](https://github.com/gentropic/auditable/tree/main/ext/rails) is the docked-tab layout engine. Three primitives:

- **Tab** — a hosted surface.
- **Stack** — a group of tabs, with a tab bar; one tab visible at a time.
- **Float / Dock** — multiple stacks arranged horizontally or vertically, with draggable splitters.

Tabs are draggable between stacks. Stacks are draggable into new dock positions. The layout persists in shell-meta IDB (a separate key-value store from the workspace VFS) so it survives reloads.

## Menus and operations

Top menu bar (the `@gcu/menu` MenuBar). Items:

### File

| Item | Effect |
|---|---|
| New notebook… | Creates a new `.html` notebook under the current project, opens it in a notebook surface. |
| Import notebook… | Imports a `.html` / `.txt` notebook into the workspace (paste path, drop file, or pick). |
| New workspace… | Creates a fresh workspace (with IDB home; FSAA optional). Replaces the current one. |
| Open folder… | Opens a disk folder as the workspace's `/home` (FSAA; Chromium-only). |
| Mount folder… | Mounts a disk folder at `/mnt/<name>` (FSAA; persists the handle). |
| Open workspace file… | Imports a `.html` workspace export. |
| Save | Persists the current workspace + all open surfaces (Ctrl+S). |
| Export workspace… | Bundles the workspace into a single self-contained `.html`. |

### View

| Item | Effect |
|---|---|
| Toggle sidebar | Show/hide the file tree. |

### Tools

| Item | Effect |
|---|---|
| Terminal | Spawn a `geas` terminal surface. |
| Connect agent folder… | Connect an AI agent over a shared folder. See [Agent Access](works-agent.md). (Shown only when the numen shim + folder picker are available.) |
| Settings… | Open the workspace settings surface — incl. **Agent access** (connect a bridge, manage grants, view the audit log). |

### Debug

| Item | Effect |
|---|---|
| New stub surface | Smoke-test the surface plumbing. |
| A-Bus inspector | Live monitor of every message on the bus. |

### Help

| Item | Effect |
|---|---|
| Documentation (F1) | Open the docs surface — full Ctrl+K search across this site + every `ext/*/SPEC.md` + every `ext/*/README.md`. |
| About Auditable Works | Version, build date, Ed25519 key, links. |

## Saving and exporting

**Save** (Ctrl+S) persists the workspace VFS in place — IDB writes for the default backend, disk writes for FSAA-backed homes. Surfaces with pending edits flush via `Surface.Flush()` before the persist; surfaces with `Surface.CanClose() === false` block close until they're ready.

**Export workspace** (File → Export workspace…) produces a single self-contained `.html` — a complete copy of the workspace VFS embedded in a loader that, when opened, rehydrates into an IDB-backed workspace. The output is `file://`-openable, single-file, includes every notebook + every mounted file + every shell setting. Use case: "send this whole project to a colleague," "archive a finished workspace," "back up to a USB stick."

## A-Bus — the coordination layer

The shell hosts the A-Bus broker; every surface is a peer. Surfaces address each other (and the shell) over A-Bus method calls and signals — see [@gcu/abus/SPEC.md](https://github.com/gentropic/auditable/blob/main/ext/abus/SPEC.md). The shell exposes a `works` service at `/` with three interfaces:

- `VFS` — `Read`, `Write`, `MkDir`, `Stat`, `List`, `Move`, `Delete`. Surfaces use this to read/write workspace files.
- `Shell` — `OpenPath`, `SpawnSurface`, `ListSurfaces`, `RunNotebook`, mounts, registry/profiles, layout management.
- `Notebook` — drive a notebook by path: `ListCells`, `GetSource`, `GetOutput`, `RunCell`, `SetCell`, `AddCell`, `DeleteCell`.
- `Inspect` — the broker topology (gated; granted to the inspector surface at spawn).
- `Mcp` — agent connection + per-agent grants + the audit log (drives the Settings panel).

The broker is also the **capability boundary**: most calls pass freely, but gated members are default-deny until a matching grant is issued. Today VFS *writes* and Notebook *edits* are gated for **agent** principals — see [Agent Access](works-agent.md). The A-Bus inspector surface (Debug → A-Bus inspector) shows every call, return, signal, and subscription on the bus in real time.

## Settings

The settings surface (Tools → Settings…) edits `/etc/works.json` — the workspace's persistent configuration:

```json
{
  "theme": "dark",
  "font": {
    "monospace": "ui-monospace, Space Mono, monospace",
    "sans": "ui-sans-serif, Barlow, system-ui, sans-serif"
  },
  "fonts": "bundled",   // or "system"
  "mounts": [ ... ]      // persistent /mnt/* mount handles
}
```

Settings propagate via A-Bus signals to all open surfaces — theme changes apply live without reload.

## Bundled libraries — `/usr/lib`

The shell bundles four `@gcu/*` libraries and exposes them via the `/usr/lib/` mount:

```js
const { connect } = await load('@gcu/abus');        // resolves to /usr/lib/@gcu/abus/index.js
const { VFS }     = await load('@gcu/vfs');
const { Terminal} = await load('@gcu/xterm');
const { geas }    = await load('@gcu/geas');
```

Notebook surfaces can `load()` these as if they were any other module. The shell bundles the source once and inlines it into each surface's HTML at decompress time (file:// blob URLs get unique opaque origins, so each iframe needs its own copy — but the on-disk storage is deduplicated).

## Building Works

```bash
node build.js                  # build auditable.html (required first — Works embeds it)
node build.js --target=works   # build works.html
```

The Works build embeds:

- The full `auditable.html` runtime (as the notebook surface).
- The shell modules (`works/js/*`).
- Five static surfaces (`stub`, `text`, `preview`, `inspector`, `terminal`, `docs`, `settings`).
- Four `@gcu/*` bundled libs (`abus`, `vfs`, `xterm`, `geas`) — gzipped, base64-inlined.
- The full docs corpus (gzipped, base64-inlined; ~600 KB).

Total: ~2.5 MB.

## Testing

`test/works-smoke.mjs` — a Playwright headless test that:

1. Boots Works in Chromium.
2. Spawns a stub surface.
3. Verifies A-Bus connect + Surface contract.
4. Repeats from `file://` (separate from the HTTP loopback path).

Not part of `npm test` (Playwright dependency); run with `node test/works-smoke.mjs`.

## Status

Phase 1 (shell + notebook surface + workspace persistence + mount delegation) and Phase 2 (geas terminal surface) shipped. Phase 3+ (more surfaces, surface-to-surface protocols, customization) ongoing.

The legacy `works:*` postMessage bridge and the lightweight-JSON notebook format are **retired** — replaced by A-Bus and the VFS-is-the-workspace model. Old workspaces / notebooks that use the legacy formats won't open in current Works without conversion.

## What Works is NOT

- **A web app.** No server. The whole thing is one HTML file that opens from disk.
- **A package manager.** That's `pkg`, which lives in geas. Works hosts a geas terminal surface; pkg is invoked from there.
- **A notebook.** The *notebook surface* is an Auditable notebook. Works is the shell around it (plus everything else).
- **A general-purpose IDE.** Works hosts surfaces; an IDE-grade editor surface (code intelligence, multi-cursor, LSP) is plausible but doesn't exist today.

## See also

- [Agent Access (numen)](works-agent.md) — connect an AI agent to the desktop, gated + consented + audited.
- [SURFACES.md](https://github.com/gentropic/auditable/blob/main/works/SURFACES.md) — how to author a new surface kind.
- [@gcu/abus SPEC](https://github.com/gentropic/auditable/blob/main/ext/abus/SPEC.md) — the IPC backbone.
- [@gcu/vfs](https://github.com/gentropic/auditable/tree/main/ext/vfs) — the workspace filesystem.
- [@gcu/rails](https://github.com/gentropic/auditable/tree/main/ext/rails) — the layout engine.
