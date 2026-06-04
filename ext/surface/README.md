# @gcu/surface

The **Auditable Works surface contract** — the small, capability-shaped seam that
lets the same tool run standalone and as a Works surface without branching on its
environment. v0.1 ships the two genuinely-shared pieces, extracted from the two
real consumers (strata + plate):

- **`bootSurface(opts)`** — the `welcome → connect → claim → expose-§5.2 → mount →
  Ready` handshake every surface performs. ~30 near-identical lines and a known
  footgun (emit `Ready` before exposing the contract → the shell calls methods
  that don't exist yet); this gets the order right once.
- **`createWorksHost(bus, tab, caps)`** — the Works host adapter backing the §5.2
  Surface lifecycle (dirty / flush / title) and the cross-surface
  **selection/linking** channel.

> The standalone host (FSAA/download) stays in `tools/strata` until a second
> standalone tool needs it (one consumer ≠ an abstraction). The notebook's
> VFS-project host (`src/js/host.js`, `provideVFS`/`persist`) is a different,
> heavier shape folded in later. Contract + rationale: `tools/strata/HOST.md`.

## Quickstart

```js
import { connect } from '@gcu/abus';
import { bootSurface, createWorksHost } from '@gcu/surface';

bootSurface({
  connect,                                  // injected (keeps @gcu/surface zero-dep)
  client: 'plate',
  onConnect: (bus) => installThemeSubscription(bus),
  makeHost: (bus, tab) => createWorksHost(bus, tab, { readMostly: true }),
  mount: async ({ bus, tab, host }) => {
    // read tab.path, build the UI, wire host.onFlush — the contract is already
    // exposed; Ready fires automatically after this resolves.
  },
});
```

## API

**`bootSurface({ connect, client, makeHost, mount, onConnect? })`** — runs the
handshake. `connect` is injected (`@gcu/abus`'s) so this package imports nothing.
Order is load-bearing: `makeHost → expose contract → mount → Ready (last)`.

**`createWorksHost(bus, tab, caps?) → host`**
- `caps.readMostly` — `true`: save is inert, `setDirty` is a no-op, no self-flush
  (a viewer like plate). `false` (default): save writes `tab.path` via the works
  VFS, `setDirty` arms a self-flush (an editor like strata).
- `caps.selfFlushMs` — edit→flush debounce (default 1500).
- The host: `open` · `save(name,bytes)` · `saveAs` · `setDirty`/`.dirty` ·
  `setTitle` · `onFlush`/`flush` · `canClose` · `canOpenFiles` · `selection`.
- `host.selection` = `{ publish(payload), subscribe(cb)→unsub }` — the host fills
  the descriptor's `dataset` (= `tab.path`), `origin` (the A-Bus name), and a
  monotonic `epoch`; subscribers echo-suppress (own origin) and dataset-scope.

## The host contract (the irreducible seam)

A surface's core calls only: file-I/O (`open`/`save`/`saveAs`) + `setDirty` +
`setTitle` + `onFlush`. `bus` / `fs` / `theme` / `selection` are
capability-optional — an adapter provides only what it backs. That single rule is
what lets one core span standalone, loose-file, and project modes.

## Build & test

`node ext/surface/build.js` → `ext/surface/index.js`. Pure tests:
`test/surface.test.mjs` (createWorksHost over a fake bus). `bootSurface` is
covered by `test/strata-link-smoke.mjs` + `test/plate-strata-link-smoke.mjs`.

## License

MIT © Arthur Endlein Correia — Geoscientific Chaos Union (gentropic.org)
