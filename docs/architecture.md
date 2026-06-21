# Architecture — the stack at a glance

Orientation for understanding (or driving) Auditable: what the pieces are and how
they layer. If you're an agent connected over MCP, start here, then
`worksSearchDocs` for specifics. If you're a new contributor, this is the map
before the territory.

## The frame

**The browser is the kernel; everything else is userland.** Auditable ships as a
single self-contained HTML file — the file *is* the document, the runtime, and the
lockfile. No server, no install, no build step to run it.

Two artifacts, same deployment story:

- **`auditable.html`** — one reactive notebook. See [auditable](index.md).
- **`works.html`** — [Auditable Works](works.md), a desktop *shell* that hosts
  notebooks and other apps ("surfaces") in a tabbed workspace.

**A north-star invariant: network is an opt-in edge.** The app stays fully
functional under CSP `connect-src 'none'`, losing only explicitly network-named
features (`install`, map tiles, the registry). Nothing touches the network on
load; all egress is a user-invoked action. Coordination is local (A-Bus +
postMessage), persistence is local (a virtual filesystem). WebGPU and WebAssembly
are local too — the browser hosts them, no network.

## The layers

```
 ┌─ apps ───────────────────────────────────────────────┐
 │  notebook surface · terminal · docs · strata · …      │   Works surfaces
 ├─ shell ──────────────────────────────────────────────┤
 │  desktop: layout · file tree · the `works` service    │   works/js
 ├─ the notebook ───────────────────────────────────────┤
 │  cells · reactive DAG · AIR compiler · builtins       │   src/js
 ├─ foundation libs (@gcu/*) ───────────────────────────┤
 │  vfs · abus · rails · surface · menu · dialog · sift  │   ext/*
 ├─ runtime + build ────────────────────────────────────┤
 │  ES modules via blob URLs + an import map; one file   │   build.js
 └──────────────────────────────────────────────────────┘
```

Each layer talks to the one below through a narrow contract — surfaces never reach
into the shell's internals; they speak A-Bus.

## The reactive core (the notebook)

- **Cells + the DAG.** A notebook is cells (code / markdown / css / html). Cell
  dependencies are tracked automatically into a directed acyclic graph; change a
  value and everything downstream re-runs. See [Cells & Reactivity](cells.md).
- **Scope by value.** Each cell runs in its own function; upstream variables
  arrive as parameters. Cross-cell mutable state uses `// %manual` cells +
  callbacks. See [the scope model](advanced/scope-model.md).
- **AIR — the compiler.** Every JS / Python / Soft cell lowers to a shared SSA
  intermediate representation, runs optimization passes (type propagation,
  specialization), and emits V8-hinted JavaScript — 1.5–300× faster than naïve.
  Any failure silently falls back, so cells always run.
- **Languages.** [adder](adder/index.md) (a Python dialect, pure JS), soft
  (English-keyword), and atra (a Fortran/Pascal-style language compiling to
  WebAssembly *in the browser*) all run through AIR.

## Works — the desktop

- **Surfaces** are iframe apps and A-Bus peers implementing a `Surface` contract.
  The notebook is one surface; so are the terminal, docs reader, file preview,
  inspector, strata table, and more.
- **A-Bus** (`@gcu/abus`) is the coordination layer — a D-Bus-shaped message bus.
  The shell hosts the broker; it's also the **capability boundary** (gated,
  consented, audited access — see [Agent Access](works-agent.md)).
- **The VFS is the workspace.** A virtual filesystem (`@gcu/vfs`) is the single
  persistence interface (IndexedDB / disk-folder / memory backends). A project is
  a VFS directory marked by `project.json`.
- **Surfaces are sandboxed** (opaque-origin iframes) so they can't reach the
  shell realm except over A-Bus — the basis of the capability-security model.

## The `@gcu/*` module map

Curated, not exhaustive — `worksSearchDocs` or each package's `SPEC.md`/`README.md`
has the detail.

| Group | Packages | Role |
|---|---|---|
| **Foundation** | `vfs` · `abus` · `rails` · `surface` · `menu` · `dialog` · `sift` | filesystem, bus, layout, surface contract, UI chrome, safe predicates |
| **Compiler / languages** | `air` · adder · soft · atra | the SSA compiler + the languages that lower to it |
| **Numerics / compute** | `line` · `scitra` · `learn` · `natra` · `proc` | BLAS, scipy-shaped, sklearn-shaped, ndarrays, Web-Worker processes |
| **Streaming / large data** | `sluice` · `recon` · `flowsheet` | online stats, data sniffing, lazy lineage pipelines |
| **Geoscience** | `gslib` · `gsjs` · spinifex · `grid`/`voxmesh` · `stereonet`/`bearing` · `msh`/`omf1` | faithful GSLIB (frozen oracle) + the modern geostats library, GIS, block models, structural geology, mesh/vendor I/O |
| **Tabular** | `strata` · `over` · `dimensions` · `sheet` · calque | reactive table, row-transform DSL, dimensional algebra, spreadsheets |
| **Docs / content** | `markdown` · `librarian` · `docview` · `reader-core` · `epub` · `template` | rendering, full-text search, doc viewing, books, templating |
| **Plumbing** | `capsule` · `archive` · `numen` · `geas` · `coreutils` | share-links, ZIP/zstd, the MCP bridge, the shell, CLI tools |

A recurring GCU pattern: a **faithful reference** stays frozen as the oracle while
a **modern sibling** evolves and is differential-tested against it (e.g. `gslib`
the GSLIB transcription vs `gsjs` the modern geostats library).

## Build + runtime

`node build.js` bundles the ES modules under `src/` (and `works/js/`) into one
HTML file: each module's source is JSON-stringified into a registry, a bootstrap
creates a blob URL per module and an import map (`#name` → blob URL), then imports
them — so every module keeps its own scope, no global collisions. Vendored deps
(CodeMirror, acorn) load as classic scripts first. The pure computational core
(DAG, engine, serialization, stdlib) has zero DOM dependencies and also runs
headless in Node via `createNotebook()`.

## Where to go next

- [Auditable Works](works.md) · [Agent Access (numen)](works-agent.md) ·
  [MCP Bridge](mcp.md)
- [Cells & Reactivity](cells.md) · [Scope model](advanced/scope-model.md) ·
  [Save format](advanced/save-format.md)
- [adder (Python)](adder/index.md) · [Modules](modules.md) ·
  [Notebook filesystem](filesystem.md)
