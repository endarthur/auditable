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

**Adoption (2026-06-16).** `bootSurface` is now the universal handshake base: all
15 built-in Works surfaces (stub, settings, preview, encode, launcher, text,
inspector, hex, library, docs, terminal, patchbay, reader/book, dd60, doc) boot
through it, in addition to strata + plate. The trivial viewers/tools pass an empty
host (`makeHost: () => ({})` → default `Flush`/`CanClose`/`Relocated`); editors
(text, doc, patchbay) supply `flush`/`relocate`. `createWorksHost` (the
lifecycle+selection adapter) stays a *separate* opt-in used only by the
selection-linking surfaces (strata, plate) — most surfaces need only `bootSurface`
with a small inline host. `'surface'` is in the build's `CORE_LIBS`, so works-core
carries it (~6 KB).

## Core vs capability (what plate settled)

plate is read-mostly — it barely touches file-I/O — which answered HOST.md's open
question #1: **open/save is a *capability*, not the core.** The irreducible core is
**lifecycle (dirty/flush/title) + selection + theme**; doc-I/O (`open`/`save`),
`bus`, and `fs` are capability-shaped (feature-detected; an adapter provides only
what it backs). `createWorksHost`'s `readMostly` cap is exactly this split made
concrete: a viewer and an editor are the same adapter with one flag.

## The §5.2 Surface ABI (the lifecycle contract)

Every surface — whatever it edits or views — exposes the same small A-Bus
interface on path `/`, and the shell drives it. `bootSurface` exposes this for you
from the host's methods; this is what it speaks.

**Methods the surface implements:**

```
Surface.Flush()      → void     persist edits now. Called at save barriers
                                 (Ctrl+S, before close, before workspace export).
                                 Idempotent. Generous timeout (~5 s) — a miss
                                 warns, doesn't block the save.
Surface.CanClose()   → boolean  veto a close. Read-only surfaces return true;
                                 writable ones usually return true and block on
                                 Flush instead (better UX than a modal prompt).
Surface.Relocated(p) → void     the shell moved your project/file; future writes
                                 target the new path.
```

**Signals the surface emits:**

```
DirtyChanged(boolean)  true on first unflushed edit, false after a flush.
TitleChanged(string)   tab label changed (rename, title edit) — emit on init too.
Ready()                exactly once, LAST, when mounted and the methods will succeed.
```

**Lifecycle:** parent posts `{type:'abus:welcome', port, tab, home}` → connect
A-Bus → initialise (read the file, build UI) → **expose the contract** → emit
`TitleChanged` + `Ready` → operate → eventually `Flush` + close. The surface MUST
NOT emit `Ready` before exposing the contract — the shell calls your methods the
moment `Ready` fires. (`bootSurface` enforces the order.)

## The selection / linking contract (brushing across surfaces)

This is how a brush in one surface lights up the matching rows in another (and the
reason `@gcu/sift` exists). A selection is a small, **semantic, serializable**
description of *which rows of which dataset* a surface is highlighting, broadcast
on a shared A-Bus channel and echo-suppressed.

**The descriptor** (emitted by any participating surface; consumed by any surface
bound to the same dataset):

```
Selection = {
  dataset: string,    // identity space — the source file's VFS path (v1)
  key:     string,    // the key field naming rows (e.g. "hole_id"; "#row" = base ordinal)
  origin:  string,    // the emitter's A-Bus uniqueName — for echo suppression
  epoch:   number,    // monotonic per-origin — last-writer-wins ordering
  kind:    "rows" | "cols" | "cells" | "filter" | "none",
  rows?:   string[],      // kind:"rows"/"cells" — KEY VALUES, never positions
  cols?:   string[],      // kind:"cols"/"cells" — column names
  predicate?: Predicate,  // kind:"filter" — a @gcu/sift structured spec (no JS string)
}
```

- **Semantic, never positional** (the cardinal rule): rows are named by key
  *values*, never indices — a sort in the emitter must not scramble the receiver.
- **The dual:** *enumerated* (`rows`/`cols`/`cells`) for small/lasso selections;
  *predicate* (`filter`) for large/rule-based ones. `kind:"none"` clears.
- **The predicate is a `@gcu/sift` spec, never a JS string** — walked, never
  `eval`'d, so an untrusted surface can act on it safely. Users type
  `grade > 2`; the *emitter* parses to the spec (`@gcu/sift` `parsePredicate`);
  only the spec travels. Full-JS power stays in owner-evaluated derived columns.

**The bus channel:**

- **Transport** — a `Selection` interface broadcast signal: emit
  `bus.signal({ path:'/', interface:'Selection', member:'Changed' }, [descriptor])`
  and `bus.subscribe` to the same.
- **Opt-in + visible** — a surface reacts only when its "Linked" toggle is on;
  forced universal linking is chaos.
- **Echo suppression** — ignore any descriptor whose `origin` is your own.
- **Dataset scope** — interpret only descriptors whose `dataset` matches yours.
- **Coalesce + commit-by-default** — publish on commit (mouse-up / Enter), not
  per-drag-pixel; lean on A-Bus consumer-side coalescing.
- **Ordering** — `epoch` (monotonic per origin) gives last-writer-wins.

`createWorksHost`'s `host.selection = { publish, subscribe }` implements all of
this: the host fills `dataset`/`origin`/`epoch` and echo-suppresses + scopes; the
app supplies `kind`/`rows`/`cols`/`predicate`.

**Trusted tier (reserved seam):** `predicate.form` tags the predicate — `"spec"`
is the safe universal floor every surface evaluates; `"js"` is reserved for
privileged/trusted surfaces only (a sandboxed surface never evaluates a `form` it
doesn't trust). Designing the tag in now keeps the elevated tier a capability
check, never a contract break.

## Architecture notes

- **Zero-dep leaf.** `connect` (`@gcu/abus`) is injected, not imported — the
  surface already imports it and passes it, so @gcu/surface inlines into a surface
  without double-inlining abus (same pattern as plate's injected predicate eval).
- **Boot order is load-bearing.** `makeHost → expose §5.2 → mount → Ready (last)`.
  The shell calls a surface's methods the moment `Ready` fires, so the contract
  must already be exposed (the classic footgun bootSurface removes).
- **Selection descriptor** follows the selection/linking contract: `{ dataset,
  origin, epoch, kind, rows?/cols?/predicate? }`, echo-suppressed + dataset-scoped.

## Canonical home

This SPEC is the **committed, self-contained** home of the Works surface contract:
the §5.2 lifecycle ABI and the selection/linking contract above are graduated here
(out of internal design drafts) so a tool in *another* repo can read just this file
and `works/SURFACES.md` to build a conforming surface. `tools/strata/HOST.md`
remains the worked-example narrative (the contract's first derivation);
`@gcu/sift`'s SPEC owns the predicate grammar that rides the selection channel.
Start at **`INTEROP.md`** (repo root) for the full reading order.

## Versioning

Pre-1.0. The contract is expected to grow as the standalone + notebook hosts fold
in. New capabilities are feature-detected (an adapter provides only what it backs),
so additions don't break existing surfaces; the `predicate.form` tag keeps the
trusted tier additive too.
