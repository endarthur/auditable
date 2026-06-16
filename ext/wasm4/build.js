// @gcu/wasm4 lib build — compiles the atra rasterizer + the demo cart to wasm
// and bundles them with the host engine into ext/wasm4/index.js (the lib the
// browser surface imports). The cart side needs no atra at runtime: both
// modules are pre-compiled here and shipped as base64.
//
//   node ext/wasm4/build.js
//
// atra is an ES module, this script is CJS → dynamic import.

const fs = require('fs');
const path = require('path');

(async () => {
  const { atra } = await import('../atra/index.js');
  const dir = __dirname;

  const rasterSrc = fs.readFileSync(path.join(dir, 'raster.atra'), 'utf8');
  const cartSrc = fs.readFileSync(path.join(dir, 'cart-demo.atra'), 'utf8');
  const host = fs.readFileSync(path.join(dir, 'host.mjs'), 'utf8');

  // The rasterizer imports the shared memory (__memory → env.memory); the cart
  // self-declares + exports its own.
  const rasterBytes = atra.compile(rasterSrc, { __memory: true });
  const demoBytes = atra.compile(cartSrc);
  const b64 = (u8) => Buffer.from(u8).toString('base64');

  const out = `// @gcu/wasm4 — BUILD OUTPUT (ext/wasm4/build.js). The host engine
// (host.mjs) + the atra rasterizer and demo cart baked as wasm. Do not edit by
// hand — run \`node ext/wasm4/build.js\` after changing raster.atra / cart-demo.atra
// / host.mjs.

${host}
// ── baked wasm modules (base64) ─────────────────────────────────────────────
export const RASTER_B64 = ${JSON.stringify(b64(rasterBytes))};
export const DEMO_CART_B64 = ${JSON.stringify(b64(demoBytes))};

export function bytesFromB64(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

export const RASTER_WASM = bytesFromB64(RASTER_B64);
export const DEMO_CART_WASM = bytesFromB64(DEMO_CART_B64);
`;

  fs.writeFileSync(path.join(dir, 'index.js'), out);
  console.log(`Built ext/wasm4/index.js — raster ${rasterBytes.length}B, demo cart ${demoBytes.length}B`);
})().catch((e) => { console.error(e); process.exit(1); });
