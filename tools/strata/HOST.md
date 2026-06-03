# The strata host interface — the seed of `@gcu/surface`

strata's app core (`js/app.js`, `createStrataApp(host)`) is **host-agnostic**: it
renders the toolbar + grid and routes *all* environment-specific work — file I/O,
title, dirty state, save-now — through a small `host` object. The **same core**
runs standalone (a page) and as a Works surface (an A-Bus iframe); only the host
adapter differs.

This interface is deliberately kept **strata-local** and **unnamed**. It is the
*first* of the two real examples (strata + a chart surface) from which
`@gcu/surface` will later be extracted — *two examples before the abstraction*.
This doc is the artifact that should be open on the table at extraction time: the
contract, the rationale, and the open questions the chart must answer.

> Status: design-in-progress (2026-06-02). Promotes to `ext/surface/SPEC.md` when
> `@gcu/surface` is extracted. Supporting breadcrumbs: the `project_strata_design`
> memory, the `strata:` commit messages, `works/SURFACES.md` (§4.2 loose-file, §9
> build), and `spec_inbox/strata-spec.md` §7 (the surface forcing-function design).

---

## The contract

The core calls only these. An adapter implements them per environment.

```
host.open()              → Promise<{ name, bytes } | null>
    Let the user pick a source file (FSAA picker / <input> standalone; or, in
    Works, read the bound tab.path). null = cancelled.

host.save(name, bytes)   → Promise<msg | null>
    Persist to the CURRENT file (the FSAA handle / the bound Works path). Falls
    back to saveAs when there's no current file. Returns a status string, or null
    if the user cancelled a fallback dialog.

host.saveAs(name, bytes) → Promise<msg | null>
    Choose a destination and persist (FSAA save picker / download standalone;
    a path prompt in Works). name is a suggested filename.

host.setDirty(bool)      → void          host.dirty → bool
    Set / read the unsaved-edits flag. Standalone arms beforeunload; Works emits
    Surface.DirtyChanged.

host.setTitle(name)      → void
    The environment title — document.title standalone; Surface.TitleChanged in
    Works. (The app updates its own in-toolbar filename display separately.)

host.onFlush(cb)         → void
    Register the app's "save now" handler. Works wires it to Surface.Flush (the
    shell's save barrier); standalone leaves it for beforeunload / future use.
```

**Capability flags / optional surfaces (feature-detected; an adapter provides
only what it backs):**

```
host.canOpenFiles  — may the user open arbitrary files from inside the app?
                     true standalone (picker + drag-drop); false in the Works
                     loose-file surface (files open via the tree). Default true;
                     when false the core hides Open + drag-drop.
host.bus    — A-Bus client. Filled by the Works adapter; powers cross-surface
              selection/linking (strata-spec §7.1). Absent standalone.
host.fs     — a VFS-shaped {read,write,list,…}. Filled by a future PROJECT
              adapter (a /projects/<x>/ strata workspace, project.json kind:strata)
              so strata can hold many tables/views, not just one file.
host.theme  — { current, onChange }. Workspace theme in Works; own CSS standalone.
```

The core must treat `bus`/`fs`/`theme` as *optional* (feature-detect, never
assume). That single rule is what lets the same core span loose-file, project,
and tool-spawn modes without branching on environment.

---

## The adapters

| adapter | where | open / save | dirty / flush |
|---|---|---|---|
| **standalone** | `js/host.js` `createStandaloneHost()` | File System Access API (save-in-place) → `<input>`/download fallback | `beforeunload` warns on `dirty` |
| **Works** | inline in `works/surfaces/strata.html` `createWorksHost()` | `bus.call({to:'works', VFS Read/Write})` on `tab.path` (read as `'bytes'`) | `DirtyChanged` signal + §7 1.5 s self-flush; `Surface.Flush → onFlush` |

Both are live and verified: `test/strata-app-smoke.mjs` (standalone) and
`test/strata-works-smoke.mjs` (the Works surface — open a `.strata` by extension,
mount, edit, render). The Works surface is a loose-file surface (`SURFACES.md`
§4.2); registered `registerKind('strata', { extensions: ['.strata'] })`, with the
app core shared as the `strata-app` build lib.

The core (`js/app.js`) is shared verbatim. Standalone resolves its bare `@gcu/*`
imports via the `<import map>` in `index.html`; the works build inlines the core
as the `strata-app` lib payload (its transitive `@gcu/loom`/`strata`/`recon`/
`archive` inline after it).

---

## Why these decisions (so the extraction doesn't relitigate)

- **Strata-local, not `@gcu/surface` yet.** One example can't shape a general
  contract honestly — you'd guess and pay for it. Hold until the chart (example
  #2) is built against this same shape; *then* extract. (Crib `src/js/host.js`'s
  pattern, let it reveal the generalization, then extract — per the dock reframe.)
- **Small + capability-shaped.** The required surface is just file-I/O + title +
  dirty + flush — the irreducible "a tool that edits a document" need. Everything
  richer (bus, fs, theme) is optional so adapters add only what they back. Keeps
  the contract from leaking Works internals.
- **Loose-file first.** A `.strata` is already a self-contained zip document, so
  the single-file surface is the smallest honest slice. `fs` (project mode) and
  `bus` (selection) are additive — no rewrite.
- **The §5.2 Surface ABI stays hidden from the core.** Flush/CanClose/Relocated +
  DirtyChanged/TitleChanged/Ready are the Works *adapter's* job; the core never
  sees them. That boundary is what keeps the core portable.

---

## What the chart (example #2) must confirm before we extract `@gcu/surface`

Open questions only a second, *different-shaped* surface can answer:

1. **Is `open`/`save` even core?** A chart may be read-mostly — it *consumes* a
   selection and renders, owning no file of its own. If so, file-I/O is a
   *capability* (`host.doc?`), not the core, and the true core is smaller
   (lifecycle + bus + theme). Watch for this; it's the most likely reshape.
2. **The selection/linking contract (§7.1).** The chart is what forces it into
   existence: one descriptor (`dataset + key + predicate`) emitted/consumed over
   `host.bus`, echo-suppressed, opt-in. Design it *with* the chart, not before.
3. **Does `fs` (project mode) belong in the contract or stay a capability?**
   Resolve once a real multi-table strata project exists.
4. **Extract the boot helper.** The `welcome → connect → expose → Ready` handshake
   (a known footgun) is ~30 identical lines per surface — the clearest extraction
   once two surfaces share it.

When 1–4 are answered, this file's **contract** section graduates to
`ext/surface/SPEC.md`, the adapters become `@gcu/surface`'s standalone + Works
backings, and the selection descriptor lands as its linking primitive.
