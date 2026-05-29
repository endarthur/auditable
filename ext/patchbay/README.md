# @gcu/patchbay

A Eurorack-style **reactive dataflow rack** for Auditable Works — modules with
knobs, jacks, and patch cables, recast as industrial process-control gear
("punk SCADA"). A cable is a real dependency in patchbay's own reactive graph;
the rack talks to the rest of the workspace through I/O modules at its edges.

Built to `index.js` (`node ext/patchbay/build.js`); registered as the shared
lib `@gcu/patchbay` and the `patchbay` Works surface (`.patchbay` files; Tools
→ New rack). The surface shell is `works/surfaces/patchbay.html`.

## Architecture

- **Engine** (`src/engine.js`) — `createEngine(sr, ctx)`. Each module
  instance's input ports, knobs, and controls are sideact signals; a cable
  `A.out → B.in` is a rebindable `computed`, so sideact's auto-tracking *is*
  the graph (no manual topo-sort). Cycle-guarded; one cable per input.
  sideact is **injected** (`sr = {signal, computed, effect, batch}`), not
  imported, so the engine is Node-testable and bundle-safe.
- **SDK** (`src/sdk.js`) — `defineModule({ type, ports, knobs, controls,
  process, setup, display, … })`. `process(inp, k, state)` is a pure reactive
  value compute; `setup(ctx, inst) → teardown` is the clocked / I/O seam.
- **Render / interact** (`src/render.js`, `src/interact.js`) — canvas rack:
  rails the panels bolt to, verlet cables, HP-grid snap, pinch/zoom, knob &
  control drag, wire draw, flow animation.
- **Store** (`src/store.js`) — a rack is one `.patchbay` JSON doc (modules +
  cables + per-instance knobs/controls/params/appearance + cable colours).
- **pb** (`src/pb.js`) — module-sized displays: led, bargraph, scope (multi-pen
  trend), lcd, numeric (7-seg), dot, spectrum, indicator, gauge (needle), text.

## Module kit (groups)

Sources · Math · Logic · Process · Control · Panel · Display · I/O. Notable:
gauges, alarms (Schmitt threshold), PID, timers (TON/TOF), sample-&-hold,
counter, slew, the panel controls (trigger / toggle / switch-router / fader),
and NOTE label panels. Add via the **Add** menu, **Ctrl+K** search, or
right-click the rack.

## Talking to a notebook (the I/O boundary)

Patchbay reaches the workspace through the shell's `works` VFS service, so its
file I/O lands on the **shared workspace VFS** — including the volatile
`/tmp`, which a notebook surface also sees. That's the bridge:

- **LOG** (`io.vfs-write`) writes its input to a path, e.g. `/tmp/pb-level.txt`.
- **FILE** (`io.vfs-read`) reads a path and re-reads on change.
- **TAG IN / TAG OUT** (`io.abus-*`) subscribe / publish A-Bus topics.

A notebook cell reads the LOG'd value straight off the workspace `/tmp`
(verified with both IDB and memory storage homes):

```js
// in a notebook cell, alongside an open patchbay rack whose LOG writes there
const level = parseFloat(await notebook.fs.read('/tmp/pb-level.txt'));
display('rack level: ' + level);
// re-run to pull the latest; or poll on a timer / ui.slider for live readout
```

Tools → **New rack** ships this wired up: a SETPOINT → LOG → `/tmp/pb-level.txt`,
with a note panel pointing at it.

> Reverse direction (notebook → rack) works the same way: a notebook cell
> `notebook.fs.write('/tmp/pb-in.txt', …)` and a FILE module reading that path.
> Live A-Bus subscription *from cell code* isn't exposed yet (cells have VFS,
> not the bus) — the workspace `/tmp` file is the paved channel today.

## Testing

- `node --test test/patchbay.test.mjs test/patchbay-render.test.mjs test/patchbay-stdlib.test.mjs`
  — engine, render geometry, stdlib (no DOM).
- `node test/patchbay-smoke.mjs` — Playwright: boots in Works (HTTP + file://),
  mounts, flushes, and verifies the LOG → workspace `/tmp` bridge.
