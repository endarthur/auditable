# @gcu/xterm

**Vendored xterm.js + fit + WebGL addons, bundled as one ESM module.**

A rollup bundle that re-exports the bits of [xterm.js](https://xtermjs.org) used by Auditable's terminal surfaces (and any other GCU code that needs a real terminal emulator in the browser). Built once, committed, loaded by the shell — no upstream fetch at runtime, no extra build dependency on downstream consumers.

Bundled exports:

```js
import { Terminal, FitAddon, WebglAddon } from '@gcu/xterm';
```

- `Terminal` — the core emulator class (from `@xterm/xterm`).
- `FitAddon` — resize-to-container helper (from `@xterm/addon-fit`).
- `WebglAddon` — WebGL renderer (from `@xterm/addon-webgl`).

## Files

```
ext/xterm/
  entry.mjs    — rollup entry, listing the re-exports
  index.js     — BUILD OUTPUT, the ESM bundle
  xterm.css    — the upstream stylesheet, copied verbatim
  build.js     — rollup invocation
```

## Building

```sh
node ext/xterm/build.js
```

Re-bundles after a `package.json` upstream version bump in this folder. The `index.js` output is committed so consumers don't need npm.

## Status

Vendored — tracks `@xterm/xterm` 5.x. Not published as `@gcu/xterm` on npm; consumed inline by the works.html shell.

## License

xterm.js is MIT (Copyright © 2017 The xterm.js authors); this bundle is also MIT.
