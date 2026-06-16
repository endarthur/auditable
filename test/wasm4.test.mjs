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
