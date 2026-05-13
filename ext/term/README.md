# @gcu/term

Browser-native VT/ANSI terminal emulator with a generic byte-stream
interface. Williams-parser core, DOM renderer, no dependencies, single
file (~1100 LOC). Designed for embedded REPLs and log viewers in the
Auditable Works ecosystem.

```js
import { Terminal, DomRenderer, Input } from '@gcu/term';
import '@gcu/term/term.css';
import '@gcu/term/term-default.css';   // optional default theme

const term = new Terminal(80, 24);
const screen = document.querySelector('#screen');
const hidden = document.querySelector('#hidden-input');
const renderer = new DomRenderer(term, screen);
const input = new Input(term, screen, hidden, renderer);

// Cursor blink + render loop
let lastBlink = performance.now();
function tick(now) {
  if (now - lastBlink > 530) {
    renderer.cursorOn = !renderer.cursorOn;
    lastBlink = now;
    term.dirty = true;
  }
  if (term.dirty) {
    renderer.render();
    term.dirty = false;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Wire byte streams
term.onData(bytes => myHost.send(bytes));
function fromHost(bytes) { term.write(bytes); }

// On teardown
input.dispose();
```

See [`SPEC.md`](./SPEC.md) for the full specification — control
sequences, SGR, DEC modes, OSC commands, DOM structure, performance
characteristics, roadmap.

## What it's good for

- **Embedded REPLs**: pair with adder, soft, or any in-page interpreter.
- **Log viewers**: stream ANSI-coloured output (one-way) into a styled
  scrolling pane.
- **WebSocket bridges to PTYs**: bash / fish / etc. on the other side of
  a websocket, terminal in the browser.

## What it isn't

- A drop-in replacement for [xterm.js](https://xtermjs.org/) — that
  library is larger and more featureful, targets bigger workloads, and
  has years of polish on edge cases. `@gcu/term` is intentionally
  smaller (~6 KB gzipped) and accepts performance compromises xterm.js
  would not.
- BIDI / RTL aware. Sixel / iTerm2 / kitty graphics aware. Plugin-aware.
  See SPEC §1 non-goals.

## Install

```bash
npm install @gcu/term
```

The package ships ES modules (`src/index.js` is the source; `index.js`
is a flat single-file copy for non-bundling consumers). Both are
identical in v0.1 — there's only one source file. Run `npm run build`
to regenerate `index.js` after editing `src/`.

## License

MIT.
