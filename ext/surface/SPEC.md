# @gcu/surface — SPEC

*The Auditable Works surface contract: the boot handshake + the Works host adapter.*

| | |
|---|---|
| **Package** | `@gcu/surface` |
| **Version** | 0.1.0 |
| **Build** | concat (`node ext/surface/build.js` → `index.js`) |
| **Deps** | none (`connect` injected; zero-dep leaf) |
| **Runtime** | a DOM (boot) + an A-Bus client (host) |
| **Tests** | `test/surface.test.mjs` + the strata/plate works smokes |

## Lineage

The notebook ran standalone-and-as-a-Works-surface from the start
(`src/js/host.js` + the §5.2 Surface ABI); strata generalized the *loose-file*
shape (`tools/strata/HOST.md`); plate added the *read-mostly, selection-consuming*
shape. Three examples — and the discipline (two before abstracting) said extract
only what genuinely repeats. What repeated across **strata + plate**: the boot
handshake and the Works host adapter (a byte-identical selection channel + a
near-identical lifecycle). Those are v0.1.

## What is — and isn't — in v0.1

- **In:** `bootSurface` (handshake) + `createWorksHost` (lifecycle + selection),
  the two-consumer pieces. Both proven by rewiring strata + plate onto them with
  the existing smokes green.
- **Out (deliberately):**
  - The **standalone host** (FSAA/download) — one consumer (`tools/strata`); stays
    there until a second standalone tool appears.
  - The **notebook host** (`provideVFS`/`persist`) — a different, heavier
    VFS-project shape (local-copy boot-load + write-back, IDB/FSAA delegation with
    proxy fallback, mount mirroring, settings/pkg rehydrate). It informs the
    contract; folding it in is its own careful step.
  - `theme` ownership (the `@theme-init` injection still provides
    `installThemeSubscription`, passed via `onConnect`).

## Core vs capability (what plate settled)

plate is read-mostly — it barely touches file-I/O — which answered HOST.md's open
question #1: **open/save is a *capability*, not the core.** The irreducible core is
**lifecycle (dirty/flush/title) + selection + theme**; doc-I/O (`open`/`save`),
`bus`, and `fs` are capability-shaped (feature-detected; an adapter provides only
what it backs). `createWorksHost`'s `readMostly` cap is exactly this split made
concrete: a viewer and an editor are the same adapter with one flag.

## Architecture notes

- **Zero-dep leaf.** `connect` (`@gcu/abus`) is injected, not imported — the
  surface already imports it and passes it, so @gcu/surface inlines into a surface
  without double-inlining abus (same pattern as plate's injected predicate eval).
- **Boot order is load-bearing.** `makeHost → expose §5.2 → mount → Ready (last)`.
  The shell calls a surface's methods the moment `Ready` fires, so the contract
  must already be exposed (the classic footgun bootSurface removes).
- **Selection descriptor** follows the selection/linking contract: `{ dataset,
  origin, epoch, kind, rows?/cols?/predicate? }`, echo-suppressed + dataset-scoped.

## Versioning

Pre-1.0. The contract is expected to grow as the standalone + notebook hosts fold
in (and `@gcu/sift` predicates ride the selection channel). When that lands,
`tools/strata/HOST.md`'s contract section graduates fully into this SPEC.
