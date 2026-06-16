// @gcu/wasm4 — the host engine. Instantiates a WASM-4 cart + the atra
// rasterizer over ONE shared 64 KB memory, wires the `env` API, and runs the
// per-frame tick. Pure: no DOM, and NO atra at runtime — both the cart and the
// rasterizer are pre-compiled `.wasm` bytes (the rasterizer is fixed; carts are
// any conformant module). The browser surface adds canvas present + input on
// top of this; a Node test drives it headless.
//
//   import { createConsole } from './host.mjs';
//   const c = createConsole({ cartBytes, rasterBytes });
//   c.start();
//   c.setGamepad(0, BUTTON_RIGHT);
//   c.frame();                       // clear (unless PRESERVE) → cart.update()
//   c.getPixel(x, y);                // 0..3 framebuffer index
//
// The env is late-bound: the cart is instantiated first to obtain its exported
// memory; the rasterizer then imports that same memory, so every draw op writes
// directly into the shared framebuffer at native speed (SPEC-wasm4 §4).

// ── WASM-4 memory map ──────────────────────────────────────────────────────
export const PALETTE = 0x04;        // 4 × u32  (0x00RRGGBB)
export const DRAW_COLORS = 0x14;    // u16
export const GAMEPADS = 0x16;       // 4 × u8
export const MOUSE_X = 0x1a;        // i16
export const MOUSE_Y = 0x1c;        // i16
export const MOUSE_BUTTONS = 0x1e;  // u8
export const SYSTEM_FLAGS = 0x1f;   // u8
export const FRAMEBUFFER = 0xa0;    // 160×160 @ 2bpp, 40 bytes/row = 6400 bytes
export const FB_BYTES = 6400;
export const SCREEN = 160;

// Button bits.
export const BUTTON_1 = 0x01, BUTTON_2 = 0x02;
export const BUTTON_LEFT = 0x10, BUTTON_RIGHT = 0x20, BUTTON_UP = 0x40, BUTTON_DOWN = 0x80;
export const SYSTEM_PRESERVE_FRAMEBUFFER = 0x01;

export function createConsole({ cartBytes, rasterBytes }) {
  let raster = null;   // filled in just below; the env closures read it lazily.

  // The drawing half of `env` dispatches to the atra rasterizer. blit/blitSub/
  // text/tone are phase-2 (sprites/font/APU) — stubbed so any cart still runs.
  const env = {
    blit() {}, blitSub() {},
    line:  (x1, y1, x2, y2) => raster.line(x1, y1, x2, y2),
    hline: (x, y, len) => raster.hline(x, y, len),
    vline: (x, y, len) => raster.vline(x, y, len),
    oval:  (x, y, w, h) => raster.oval(x, y, w, h),
    rect:  (x, y, w, h) => raster.rect(x, y, w, h),
    text() {},
    tone() {},
    diskr: () => 0,
    diskw: () => 0,
    trace() {},
  };

  const cart = new WebAssembly.Instance(new WebAssembly.Module(cartBytes), { env });
  const memory = cart.exports.memory;
  if (!memory || !(memory instanceof WebAssembly.Memory)) {
    throw new Error('wasm4: cart does not export a "memory"');
  }
  // The rasterizer imports the cart's memory (compiled with __memory → env.memory).
  raster = new WebAssembly.Instance(
    new WebAssembly.Module(rasterBytes), { env: { memory } }).exports;

  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);

  function start() { if (typeof cart.exports.start === 'function') cart.exports.start(); }

  function frame() {
    // The console clears the framebuffer each frame unless the cart opted into
    // SYSTEM_PRESERVE_FRAMEBUFFER (§4).
    if (!(mem[SYSTEM_FLAGS] & SYSTEM_PRESERVE_FRAMEBUFFER)) {
      mem.fill(0, FRAMEBUFFER, FRAMEBUFFER + FB_BYTES);
    }
    if (typeof cart.exports.update === 'function') cart.exports.update();
  }

  return {
    memory,
    exports: cart.exports,
    start,
    frame,
    setGamepad(i, bits) { mem[GAMEPADS + i] = bits & 0xff; },
    setMouse(x, y, buttons) {
      dv.setInt16(MOUSE_X, x | 0, true);
      dv.setInt16(MOUSE_Y, y | 0, true);
      mem[MOUSE_BUTTONS] = buttons & 0xff;
    },
    // 2-bit framebuffer index (0..3) at pixel (x, y).
    getPixel(x, y) {
      return (mem[FRAMEBUFFER + y * 40 + (x >> 2)] >> ((x & 3) * 2)) & 3;
    },
    // Palette entry i (0..3) as 0x00RRGGBB.
    getPalette(i) { return dv.getUint32(PALETTE + i * 4, true) & 0xffffff; },
  };
}
