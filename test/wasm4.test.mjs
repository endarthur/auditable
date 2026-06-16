// @gcu/wasm4 headless engine test. Compiles the atra rasterizer + a demo cart,
// runs them through the host engine over a shared 64 KB memory, and asserts the
// framebuffer — input → motion → draw → clear-each-frame, all without a DOM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { atra } from '../ext/atra/index.js';
import { createConsole, BUTTON_RIGHT, BUTTON_DOWN } from '../ext/wasm4/host.mjs';
import font from '../ext/wasm4/font.js';

const dir = dirname(fileURLToPath(import.meta.url));
const rasterSrc = readFileSync(join(dir, '../ext/wasm4/raster.atra'), 'utf8');
const cartSrc = readFileSync(join(dir, '../ext/wasm4/cart-demo.atra'), 'utf8');

// The rasterizer imports the (shared) memory: compile with __memory set so it
// emits `import env.memory` rather than self-declaring one.
const rasterBytes = atra.compile(rasterSrc, { __memory: true });
const cartBytes = atra.compile(cartSrc);

describe('wasm4 cart shape', () => {
  it('cart exports start/update/memory and imports env.rect only', () => {
    const mod = new WebAssembly.Module(cartBytes);
    const ex = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
    const im = WebAssembly.Module.imports(mod);
    assert.ok(ex.has('start') && ex.has('update') && ex.has('memory'));
    assert.ok(im.some((i) => i.module === 'env' && i.name === 'rect'));
    assert.ok(!im.some((i) => i.module === 'math'), 'cart must be freestanding (no math import)');
  });

  it('rasterizer imports the shared memory from env', () => {
    const im = WebAssembly.Module.imports(new WebAssembly.Module(rasterBytes));
    assert.ok(im.some((i) => i.module === 'env' && i.name === 'memory' && i.kind === 'memory'));
  });
});

describe('wasm4 headless engine', () => {
  it('start() sets the palette and the cart runs over shared memory', () => {
    const c = createConsole({ cartBytes, rasterBytes });
    c.start();
    assert.strictEqual(c.getPalette(0), 0x1a1c2c);
    assert.strictEqual(c.getPalette(3), 0xef7d57);
  });

  it('one frame draws the block at the start position (76,76)', () => {
    const c = createConsole({ cartBytes, rasterBytes });
    c.start();
    c.frame();
    // rect(76,76,8,8): fill nibble 2 → idx 1 interior; outline nibble 4 → idx 3.
    assert.strictEqual(c.getPixel(79, 79), 1, 'interior fill');
    assert.strictEqual(c.getPixel(76, 76), 3, 'outline corner');
    assert.strictEqual(c.getPixel(70, 70), 0, 'outside untouched');
  });

  it('holding RIGHT moves the block and the old cell is cleared each frame', () => {
    const c = createConsole({ cartBytes, rasterBytes });
    c.start();
    for (let i = 0; i < 5; i++) { c.setGamepad(0, BUTTON_RIGHT); c.frame(); }
    // px: 76 → 81 after 5 frames. New block [81,89): interior idx 1, corner idx 3.
    assert.strictEqual(c.getPixel(84, 79), 1, 'block moved right (new interior)');
    assert.strictEqual(c.getPixel(81, 76), 3, 'new outline corner');
    // The original far-left column is now empty — proves clear-each-frame.
    assert.strictEqual(c.getPixel(76, 79), 0, 'old position cleared');
  });

  it('diagonal: RIGHT+DOWN moves the block down-right', () => {
    const c = createConsole({ cartBytes, rasterBytes });
    c.start();
    for (let i = 0; i < 3; i++) { c.setGamepad(0, BUTTON_RIGHT | BUTTON_DOWN); c.frame(); }
    // px,py: 76 → 79. Block [79,87)×[79,87).
    assert.strictEqual(c.getPixel(82, 82), 1, 'interior at moved position');
    assert.strictEqual(c.getPixel(76, 76), 0, 'start cell cleared');
  });

  it('PRESERVE flag keeps the framebuffer between frames', () => {
    const c = createConsole({ cartBytes, rasterBytes });
    c.start();
    c.frame();                                   // draw at 76,76
    new Uint8Array(c.memory.buffer)[0x1f] = 0x01; // SYSTEM_PRESERVE_FRAMEBUFFER
    for (let i = 0; i < 5; i++) { c.setGamepad(0, BUTTON_RIGHT); c.frame(); }
    // With preserve on, the original block's left edge (x=76, untouched by any
    // later rect) is NOT cleared — it stays drawn. (Without preserve the same
    // cell reads 0, as the "old position cleared" test asserts.)
    assert.notStrictEqual(c.getPixel(76, 79), 0, 'old trail preserved');
  });
});

describe('wasm4 rasterizer — blit / blitSub', () => {
  // Instantiate the rasterizer directly over a private memory to unit-test the
  // sprite path (the engine wires env.blit → these).
  const memory = new WebAssembly.Memory({ initial: 1 });
  const r = atra({ memory })`${rasterSrc}`;
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const px = (x, y) => (mem[0xa0 + y * 40 + (x >> 2)] >> ((x & 3) * 2)) & 3;
  const clear = () => mem.fill(0, 0xa0, 0xa0 + 6400);
  const SP = 0xc000;
  // 4×4 2bpp sprite, row 0 values [1,2,3,0] (MSB-first = 0x6C), rows 1-3 zero.
  mem[SP] = 0x6c;
  dv.setUint16(0x14, 0x4320, true);   // v0 transparent, v1→idx1, v2→idx2, v3→idx3

  it('blit maps 2bpp values through DRAW_COLORS nibbles', () => {
    clear();
    r.blit(SP, 10, 10, 4, 4, 1);
    assert.strictEqual(px(10, 10), 1);
    assert.strictEqual(px(11, 10), 2);
    assert.strictEqual(px(12, 10), 3);
    assert.strictEqual(px(13, 10), 0, 'value 0 = transparent');
    assert.strictEqual(px(10, 11), 0, 'empty sprite row');
  });

  it('FLIP_X mirrors across the sprite width', () => {
    clear();
    r.blit(SP, 10, 10, 4, 4, 1 | 2);
    assert.strictEqual(px(13, 10), 1, 'leftmost value now at right edge');
    assert.strictEqual(px(11, 10), 3);
  });

  it('blitSub draws a sub-region by srcX/stride', () => {
    clear();
    r.blitSub(SP, 20, 20, 2, 1, 1, 0, 4, 1);
    assert.strictEqual(px(20, 20), 2);
    assert.strictEqual(px(21, 20), 3);
  });
});

describe('wasm4 text', () => {
  it('the demo renders its MOVE label when a font is provided', () => {
    const c = createConsole({ cartBytes, rasterBytes, fontBytes: font.packFont() });
    c.start();
    c.frame();
    // "MOVE" at (4,4) with DRAW_COLORS 0x04 → idx 3. The rect is at center
    // (76,76), so any idx-3 pixel in the top-left label region is text.
    let found = false;
    for (let y = 4; y < 12 && !found; y++)
      for (let x = 4; x < 40 && !found; x++)
        if (c.getPixel(x, y) === 3) found = true;
    assert.ok(found, 'MOVE text drew idx-3 pixels');
  });

  it('no font → text() draws nothing but does not crash; rect still draws', () => {
    const c = createConsole({ cartBytes, rasterBytes });   // no fontBytes
    c.start();
    c.frame();
    assert.strictEqual(c.getPixel(79, 79), 1, 'rect unaffected by blank font');
    // Label region empty (font is zeros at 0xDC00).
    let any = false;
    for (let y = 4; y < 12; y++) for (let x = 4; x < 40; x++) if (c.getPixel(x, y) !== 0) any = true;
    assert.ok(!any, 'no text pixels without a font');
  });

  it('packFont produces 64 glyphs × 8 bytes', () => {
    assert.strictEqual(font.packFont().length, (0x5f - 0x20 + 1) * 8);
  });
});
