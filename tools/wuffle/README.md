# wuffle

**A geological compass — a single-file GCU tool with two homes.**

> A wuffle throws its planes and lines straight onto a stereonet. The name puns
> on the *Wulff net*, but orientation data belongs on an **equal-area (Schmidt)**
> net — so that's the default.

wuffle is a structural-geology compass/clinometer. Two homes, one file:

- **In the field** (inside the [lead-acid](https://github.com/gentropic/lead-acid)
  Android shell): lay the phone on a plane (bedding, joint, foliation) → **dip
  direction / dip**; sight a lineation → **trend / plunge**, live off the device
  orientation. It was lead-acid's first *original* instrument — the artifact that
  exists *because* of the shell, dogfooding `keepAwake`, `fs/publish`, `share`.
- **On the desktop** (gentropic.org/wuffle, or the raw file): the same tool as a
  **stereonet + manual entry** — type `045/30` (plane) or `310→70` (line) to plot,
  read the net, download the log. No device orientation, but a real analysis surface.

Each measurement lands live on the Schmidt net and appends to a log you delete
from, clear, and publish (Downloads CSV in the shell; a file download on desktop).

## How it works

- **Orientation → geology:** `deviceorientationabsolute` feeds `@gcu/bearing`'s
  `compass.planeFromDeviceOrientation` / `lineFromDeviceOrientation`.
- **The Schmidt net is `@gcu/bearing`'s `Stereonet`** (`projection: 'equal-area'`).
- **Smoothness:** `sn.render()` re-projects the whole graticule per call — too heavy
  at 60 Hz. So the static net (graticule + measured data) redraws only on
  measure/clear, and the moving live-preview rides a separate overlay `<path>`
  updated per frame via `requestAnimationFrame` (computed with bearing's own
  projection so the ghost matches a real plot). 8 fps → 60 fps.
- **Net-centric layout:** a circle inscribed in a square leaves the corners empty,
  so the reading, caption, and measure-FAB live in the net's dead corners.
- **Shell-aware:** feature-detects the shell via `@gcu/leadacid`; `shell.present`
  false on desktop (native features simply absent), true in lead-acid.

## Build & test

```
node build.js --target=wuffle     # → wuffle.html (registry build: bearing + leadacid + app)
npm run test:wuffle               # committed smoke over the built file (boot, net, plot, entry, …)
```

`wuffle.html` is a gitignored build output. Deploy: a Pages site
(gentropic.org/wuffle) and/or copied into the lead-acid APK's assets. Dev source
imports `@gcu/bearing` + `@gcu/leadacid` via the import-map in `index.html`.

## Roadmap

- **Switchboard token migration** — the CSS is already GCU-dark; move it onto the
  `--au-*`/`--sw-*` cascade for full design-system alignment + CVD accents.
- **sensor → v2** — consume lead-acid's `sensor` port stream (raw rotation-vector +
  magnetometer calibration state) for survey-grade steadiness, and `attest`-sign
  each reading.
- **WMM declination** — position (`gnss`) → World Magnetic Model → true north.
- **Georeferencing** — stamp each measurement with `gnss` coordinates (wuffle v3);
  an outcrop photo via `camera`.
- **Fabric analysis** — bearing has density contouring + mean-vector/eigen stats +
  rose diagrams; surface them for a session.

## Credits

Geology + stereonet engine: **[@gcu/bearing](https://github.com/endarthur/bearing.js)**
(`ext/bearing`). Shell shim: `@gcu/leadacid` (`ext/leadacid`, vendored from
gentropic/lead-acid). GCU — CC0.
