# Interoperating with Auditable Works

*You have a GCU tool (in this repo or another — osjs, ep, koma, a new one) and you
want it to **play nice with Auditable Works**: embed as a surface, read/write the
workspace, and brush/link with other surfaces like strata. This is the front door.
Everything it points at is committed and self-contained — you don't need the rest
of the app.*

---

## The one-paragraph model

The browser is the kernel; **Works** is the userland. A **surface** is an iframe
app that is an A-Bus peer implementing a small lifecycle contract. The shell hands
each surface a message-bus port and a filesystem; the surface reads its bound file,
builds its UI, and announces itself. That's it — there's no Works SDK to learn
beyond a bus, a filesystem, and a five-method contract.

## Reading order (canonical, committed)

1. **`ext/surface/SPEC.md`** — **the contract.** The §5.2 Surface lifecycle ABI
   (`Flush`/`CanClose`/`Relocated` + `DirtyChanged`/`TitleChanged`/`Ready`) and the
   selection/linking contract (the brushing descriptor + the bus rules). Self-contained.
2. **`works/SURFACES.md`** — **the authoring guide.** 12 sections: the boot
   template, the three surface kinds (static / app-core / notebook), VFS access
   patterns, dirty+flush wiring, the build/registry checklist, anti-patterns, and
   reference surfaces in reading order. Start with `works/surfaces/stub.html` (the
   minimal working surface) and `works/surfaces/text.html` (a real loose-file one).
3. **`@gcu/surface`** (`ext/surface`) — **the contract as code.** `bootSurface`
   (the handshake, done right) + `createWorksHost` (the host adapter: lifecycle +
   selection). Zero-dep, host-agnostic. Import it; don't reinvent the handshake.
4. **`@gcu/abus`** (`ext/abus`) — the D-Bus-shaped message bus surfaces coordinate
   over. **`@gcu/vfs`** (`ext/vfs`) — the workspace filesystem. These are the
   "play nice in general" layer: even a tool that isn't a full surface can speak
   A-Bus to coordinate, and read/write the workspace via the `works` VFS service.
5. **`@gcu/sift`** (`ext/sift`) — the safe structured predicate a `kind:"filter"`
   selection carries (only if you brush by rule, not just enumerated rows).
6. **`ext/EXTENSION_SPEC.md`** — packaging a standalone surface as an installable
   `.gcupkg` (manifest, capabilities, two-entry-point split, distribution).

## Look & feel — the Switchboard UI toolkit

Behaving like a surface is half of it; *looking* like GCU is the other half. That's
**Switchboard** (`ext/switchboard/`), the GCU UI toolkit — two tiers:

- **The language** (`ext/switchboard/SPEC.md`): tokens, the six-accent semantic
  mapping (action=orange, info=teal, go=green, caution=amber, fault=red,
  selected=indigo), typography, component patterns, theming, a11y. Runtime-free.
- **The components**: `@gcu/menu` (menus), `@gcu/dialog` (modals), `@gcu/rails`
  (docking layout), `@gcu/loom` (grid), `@gcu/term` (terminal) — drop-in DOM
  widgets that obey the toolkit's authoring contract (SPEC §6.0).

As a Works surface you inherit the workspace theme for free (the `@theme-tokens` /
`@theme-init` injection supplies `--au-*`); read **only `--au-*`** in your CSS,
never `--sw-*` or hard-coded colors, and you re-skin + light/dark for free. Start
at `ext/switchboard/README.md`.

## The minimal recipe

A surface is an HTML file that, on load, does this — and `bootSurface` does it for
you (the order is load-bearing: expose the contract **before** emitting `Ready`):

```js
import { connect } from '@gcu/abus';
import { bootSurface, createWorksHost } from '@gcu/surface';

bootSurface({
  connect,
  client: 'my-tool',
  makeHost: (bus, tab) => createWorksHost(bus, tab, { readMostly: false }),
  mount: async ({ bus, tab, host }) => {
    // read your bound file from the workspace VFS (bytes, so zips survive):
    const bytes = await bus.call(
      { to: 'works', path: '/', interface: 'VFS', member: 'Read' }, [tab.path, 'bytes']);
    // …build your UI, wire host.onFlush(saveHandler), host.setDirty(true) on edit…
  },
});
```

The `abus:welcome` message the shell posts carries three things: **`port`** (your
A-Bus channel), **`tab`** (`{ id, path, … }` — your bound file), and **`home`**
(the workspace storage descriptor). Read your file via the `works` VFS service;
write back on `Flush`.

## Two principles that save you a rewrite

- **Never branch on environment.** Write your tool's core against a small host
  interface (file-I/O + title + dirty + flush; `bus`/`fs`/`theme`/`selection`
  capability-optional) and hand it a *host adapter*. `createWorksHost` is the Works
  adapter; a standalone page supplies its own (FSAA/download). Same core, both
  homes. `tools/strata/HOST.md` is the worked example of this discipline.
- **Selections are semantic, predicates are safe.** Brush by **key values**, not
  row indices (a sort elsewhere must not scramble you). A rule-based selection
  travels as a `@gcu/sift` spec (walked, never `eval`'d) so even an untrusted
  surface can act on it. See `ext/surface/SPEC.md` § "The selection / linking
  contract".

## Worked examples to copy

- `works/surfaces/stub.html` — the smallest conforming surface (boot + contract + Ready).
- `works/surfaces/text.html` — a loose-file editor (read on welcome, debounced flush).
- `works/surfaces/strata.html` + `tools/strata/` — a document-editing surface with
  **standalone↔Works parity** (the same `createStrataApp(host)` core in both).
- `works/surfaces/plate.html` — a read-mostly, **selection-consuming** surface
  (brushes ↔ strata on the same file).
- `ext/example-quip/` — a standalone extension packaged as a `.gcupkg`.

---

*Questions this doc can't answer are usually in `works/SURFACES.md` (authoring) or
`ext/surface/SPEC.md` (contract). Those two plus `@gcu/abus`/`@gcu/vfs` are
everything a conforming surface needs.*
