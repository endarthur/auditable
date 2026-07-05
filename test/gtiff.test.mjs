// @gcu/gtiff — decode fixtures we ENCODE in-test (a minimal TIFF writer with
// its own LZW/PackBits encoders + node:zlib deflate), so every codec path is
// exercised round-trip: strips/tiles × none/LZW/deflate/PackBits ×
// predictors × sample types × endianness, plus geo tags and the overview
// chain.
import { test } from 'node:test';
import assert from 'node:assert';
import { deflateSync } from 'node:zlib';
import { readGTiff, gridFromGTiff, gridWindowFromGTiff, gridDecimatedFromGTiff, stepForCap, levelGeo, pickOverviewForCap, windowForWorldBbox, lzwDecode, packbitsDecode } from '../ext/gtiff/src/main.js';

// ── a tiny classic-TIFF writer ──────────────────────────────────────────
function lzwEncode(src) {
  const out = [];
  let bitBuf = 0, bitCnt = 0, width = 9;
  const push = (code) => {
    bitBuf = (bitBuf << width) | code; bitCnt += width;
    while (bitCnt >= 8) { out.push((bitBuf >>> (bitCnt - 8)) & 0xff); bitCnt -= 8; }
  };
  let dict = new Map(), next = 258;
  const reset = () => { dict = new Map(); next = 258; width = 9; };
  reset();
  push(256);                                               // Clear
  let w = '';
  for (let i = 0; i < src.length; i++) {
    const c = String.fromCharCode(src[i]);
    const wc = w + c;
    if (w.length === 0 ? true : dict.has(wc) || wc.length === 1) {
      if (wc.length === 1 || dict.has(wc)) { w = wc; continue; }
    }
    // emit code for w
    push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    dict.set(wc, next++);
    // early change, encoder side: entry 2^w-1 just defined -> next emit is w+1 bits
    if (next === (1 << width) && width < 12) width++;
    if (next === 4094) { push(256); reset(); }
    w = c;
  }
  if (w) push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  push(257);                                               // EOI
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
  return new Uint8Array(out);
}
function packbitsEncode(src) {                             // literal-only (valid, lazy)
  const out = [];
  for (let i = 0; i < src.length; i += 128) {
    const n = Math.min(128, src.length - i);
    out.push(n - 1, ...src.subarray(i, i + n));
  }
  return new Uint8Array(out);
}

// tags: [tag, type, count, values(array|Uint8Array bytes)] — writer handles inline vs offset
function writeTiff({ le = true, entries, imageData }) {
  const head = [], tail = [];                              // tail = out-of-line values + pixel data
  let tailBase = 8 + 2 + entries.length * 12 + 4;
  const enc = new TextEncoder();
  const buf = [];
  const u16 = (v) => le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff];
  const u32 = (v) => le ? [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff] : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const valBytes = (type, values) => {
    if (values instanceof Uint8Array) return values;
    if (type === 2) return new Uint8Array([...enc.encode(values), 0]);
    const o = [];
    for (const v of values) {
      if (type === 3) o.push(...u16(v));
      else if (type === 4) o.push(...u32(v));
      else if (type === 2) o.push(...enc.encode(v), 0);
      else if (type === 12) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, le); o.push(...b); }
      else o.push(v);
    }
    return new Uint8Array(o);
  };
  buf.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  buf.push(...u16(entries.length));
  for (const [tag, type, count, values] of entries) {
    const vb = valBytes(type, values);
    buf.push(...u16(tag), ...u16(type), ...u32(count));
    if (vb.length <= 4) { buf.push(...vb, ...new Array(4 - vb.length).fill(0)); }
    else { buf.push(...u32(tailBase)); tail.push(vb); tailBase += vb.length; }
  }
  buf.push(...u32(0));                                     // no next IFD
  for (const t of tail) buf.push(...t);
  for (const d of imageData) buf.push(...d);
  return new Uint8Array(buf);
}

// a 6×4 float32 DEM with a gradient + one nodata hole
const W = 6, H = 4;
const dem = new Float32Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) dem[r * W + c] = 100 + r * 10 + c;
dem[9] = -9999;
const demBytes = (le = true) => {
  const b = new Uint8Array(W * H * 4);
  const v = new DataView(b.buffer);
  for (let i = 0; i < dem.length; i++) v.setFloat32(i * 4, dem[i], le);
  return b;
};
const GEO = [
  [33550, 12, 3, [10, 10, 0]],                             // ModelPixelScale
  [33922, 12, 6, [0, 0, 0, 612000, 7765040, 0]],           // ModelTiepoint
  [34735, 3, 16, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32723]],
  [42113, 2, 6, '-9999'],
];
function demTiff({ compression = 1, data = demBytes(), le = true, extraTags = [], predictor = 1 }) {
  let img = data;
  if (compression === 5) img = lzwEncode(data);
  else if (compression === 8) img = deflateSync(data);
  else if (compression === 32773) img = packbitsEncode(data);
  const entries = [
    [256, 3, 1, [W]], [257, 3, 1, [H]], [258, 3, 1, [32]], [259, 3, 1, [compression]],
    [262, 3, 1, [1]], [277, 3, 1, [1]], [278, 3, 1, [H]], [339, 3, 1, [3]],
    ...(predictor !== 1 ? [[317, 3, 1, [predictor]]] : []),
    [279, 4, 1, [img.length]],
    ...GEO, ...extraTags,
  ].sort((a, b) => a[0] - b[0]);
  // strip offset points at the tail end — compute after layout: place data last
  const probe = writeTiff({ le, entries: [...entries, [273, 4, 1, [0]]].sort((a, b) => a[0] - b[0]), imageData: [] });
  const full = [...entries, [273, 4, 1, [probe.length]]].sort((a, b) => a[0] - b[0]);
  return writeTiff({ le, entries: full, imageData: [img] });
}

test('uncompressed float32 strip + geo tags', async () => {
  const g = await readGTiff(demTiff({}));
  assert.equal(g.images.length, 1);
  const img = g.images[0];
  assert.equal(img.width, W); assert.equal(img.height, H);
  const data = await img.read();
  assert.ok(data instanceof Float32Array);
  assert.equal(data[0], 100); assert.equal(data[W * H - 1], 100 + 3 * 10 + 5);
  assert.equal(data[9], -9999);
  assert.deepEqual(g.geo.origin, [612000, 7765040]);
  assert.deepEqual(g.geo.scale, [10, 10]);
  assert.equal(g.geo.crs, 'EPSG:32723');
  assert.equal(g.geo.nodata, -9999);
});

test('LZW round-trip (our encoder → the reader)', async () => {
  const g = await readGTiff(demTiff({ compression: 5 }));
  const data = await g.images[0].read();
  for (let i = 0; i < dem.length; i++) assert.equal(data[i], dem[i], `sample ${i}`);
});

test('LZW survives repetitive data (dictionary growth + KwKwK)', () => {
  const src = new Uint8Array(4096);
  for (let i = 0; i < src.length; i++) src[i] = (i / 7 | 0) % 5;   // long runs → KwKwK territory
  const dec = lzwDecode(lzwEncode(src), src.length);
  for (let i = 0; i < src.length; i++) assert.equal(dec[i], src[i], `byte ${i}`);
});

test('deflate round-trip (zlib-wrapped, tag 8)', async () => {
  const g = await readGTiff(demTiff({ compression: 8 }));
  const data = await g.images[0].read();
  assert.equal(data[7], dem[7]);
  assert.equal(data[9], -9999);
});

test('PackBits round-trip', async () => {
  const g = await readGTiff(demTiff({ compression: 32773 }));
  const data = await g.images[0].read();
  for (let i = 0; i < dem.length; i++) assert.equal(data[i], dem[i]);
  const rle = new Uint8Array([0xfe, 7, 2, 1, 2, 3]);       // -2 → 7×3, then literal 1,2,3
  assert.deepEqual([...packbitsDecode(rle, 6)], [7, 7, 7, 1, 2, 3]);
});

test('big-endian file on a little-endian platform', async () => {
  const g = await readGTiff(demTiff({ le: false, data: demBytes(false) }));
  assert.equal(g.littleEndian, false);
  const data = await g.images[0].read();
  assert.equal(data[0], 100);
  assert.equal(data[W + 1], 111);
});

test('a segment decoded twice is stable (no in-place source mutation)', async () => {
  // big-endian + windowed: the swap/predictor must not corrupt the file bytes
  const g = await readGTiff(demTiff({ le: false, data: demBytes(false) }));
  const a = await g.images[0].readWindow({ x: 1, y: 1, width: 3, height: 2 });
  const b = await g.images[0].readWindow({ x: 1, y: 1, width: 3, height: 2 });
  for (let i = 0; i < a.data.length; i++) assert.equal(a.data[i], b.data[i], `reread ${i}`);
  assert.equal(a.data[0], dem[1 * W + 1]);                 // and still correct
});

test('predictor 2 (horizontal differencing, int16)', async () => {
  const vals = Int16Array.from({ length: W * H }, (_, i) => 500 + (i % W) * 3 + (i / W | 0));
  const diff = Int16Array.from(vals);
  for (let r = 0; r < H; r++) for (let c = W - 1; c > 0; c--) diff[r * W + c] -= diff[r * W + c - 1];
  const raw = new Uint8Array(diff.buffer.slice(0));
  const entries = [
    [256, 3, 1, [W]], [257, 3, 1, [H]], [258, 3, 1, [16]], [259, 3, 1, [1]],
    [262, 3, 1, [1]], [277, 3, 1, [1]], [278, 3, 1, [H]], [339, 3, 1, [2]], [317, 3, 1, [2]],
    [279, 4, 1, [raw.length]],
  ];
  const probe = writeTiff({ le: true, entries: [...entries, [273, 4, 1, [0]]].sort((a, b) => a[0] - b[0]), imageData: [] });
  const tif = writeTiff({ le: true, entries: [...entries, [273, 4, 1, [probe.length]]].sort((a, b) => a[0] - b[0]), imageData: [raw] });
  const g = await readGTiff(tif);
  const data = await g.images[0].read();
  assert.ok(data instanceof Int16Array);
  for (let i = 0; i < vals.length; i++) assert.equal(data[i], vals[i], `sample ${i}`);
});

test('tiled layout with edge clipping', async () => {
  // 6×4 image in 4×4 tiles → 2 across, right tile clipped to 2 columns
  const tile = (x0) => {
    const b = new Uint8Array(4 * 4 * 4);
    const v = new DataView(b.buffer);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const gc = x0 + c;
      v.setFloat32((r * 4 + c) * 4, gc < W && r < H ? dem[r * W + gc] : -1, true);
    }
    return b;
  };
  const t0 = tile(0), t1 = tile(4);
  const entries = [
    [256, 3, 1, [W]], [257, 3, 1, [H]], [258, 3, 1, [32]], [259, 3, 1, [1]],
    [262, 3, 1, [1]], [277, 3, 1, [1]], [339, 3, 1, [3]],
    [322, 3, 1, [4]], [323, 3, 1, [4]],
    [325, 4, 2, [t0.length, t1.length]],
  ];
  const probe = writeTiff({ le: true, entries: [...entries, [324, 4, 2, [0, 0]]].sort((a, b) => a[0] - b[0]), imageData: [] });
  const tif = writeTiff({ le: true, entries: [...entries, [324, 4, 2, [probe.length, probe.length + t0.length]]].sort((a, b) => a[0] - b[0]), imageData: [t0, t1] });
  const g = await readGTiff(tif);
  const data = await g.images[0].read();
  for (let i = 0; i < dem.length; i++) assert.equal(data[i], dem[i], `sample ${i}`);
});

test('gridFromGTiff: PixelIsArea centers + nodata + crs', async () => {
  const g = await readGTiff(demTiff({}));
  const grid = await gridFromGTiff(g);
  assert.equal(grid.nx, W); assert.equal(grid.ny, H);
  assert.equal(grid.x0, 612005);                           // corner + half a 10 m cell
  assert.equal(grid.y0, 7765035);
  assert.equal(grid.dx, 10); assert.equal(grid.dy, 10);
  assert.equal(grid.nodata, -9999);
  assert.equal(grid.crs, 'EPSG:32723');
  assert.equal(grid.data[1 * W + 2], 112);
});

test('structural failures throw plainly', async () => {
  await assert.rejects(() => readGTiff(new Uint8Array([1, 2, 3])), /not a TIFF/);
  const bad = demTiff({});
  bad[2] = 43; bad[3] = 0;                                 // fake BigTIFF magic
  await assert.rejects(() => readGTiff(bad), /BigTIFF/);
});

// ── windowed reads ──────────────────────────────────────────────────────
// an 8×8 float32 DEM in 4×4 tiles (4 tiles), value = 100 + 10·r + c, with geo
function tiledDem() {
  const W2 = 8, H2 = 8, T = 4;
  const val = (r, c) => 100 + 10 * r + c;
  const across = W2 / T;
  const tiles = [];
  for (let ty = 0; ty < H2 / T; ty++) for (let tx = 0; tx < across; tx++) {
    const b = new Uint8Array(T * T * 4), v = new DataView(b.buffer);
    for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) v.setFloat32((r * T + c) * 4, val(ty * T + r, tx * T + c), true);
    tiles.push(b);
  }
  const entries = [
    [256, 3, 1, [W2]], [257, 3, 1, [H2]], [258, 3, 1, [32]], [259, 3, 1, [1]], [262, 3, 1, [1]],
    [277, 3, 1, [1]], [339, 3, 1, [3]], [322, 3, 1, [T]], [323, 3, 1, [T]],
    [325, 4, tiles.length, tiles.map((t) => t.length)],
    [33550, 12, 3, [10, 10, 0]], [33922, 12, 6, [0, 0, 0, 612000, 7765080, 0]],
  ];
  const probe = writeTiff({ le: true, entries: [...entries, [324, 4, tiles.length, tiles.map(() => 0)]].sort((a, b) => a[0] - b[0]), imageData: [] });
  let off = probe.length; const offs = tiles.map((t) => { const o = off; off += t.length; return o; });
  return { tif: writeTiff({ le: true, entries: [...entries, [324, 4, tiles.length, offs]].sort((a, b) => a[0] - b[0]), imageData: tiles }), val, W2, H2 };
}

test('readWindow decodes a sub-region across tiles', async () => {
  const { tif, val } = tiledDem();
  const g = await readGTiff(tif);
  // window straddling all four tiles: cols 2..5, rows 3..5
  const r = await g.images[0].readWindow({ x: 2, y: 3, width: 4, height: 3 });
  assert.equal(r.width, 4); assert.equal(r.height, 3); assert.equal(r.x, 2); assert.equal(r.y, 3);
  for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 4; cc++) assert.equal(r.data[rr * 4 + cc], val(3 + rr, 2 + cc), `win ${rr},${cc}`);
});

test('readWindow clamps to the image + full read matches', async () => {
  const { tif, val, W2, H2 } = tiledDem();
  const g = await readGTiff(tif);
  const clamped = await g.images[0].readWindow({ x: 6, y: 6, width: 10, height: 10 });   // runs off the edge
  assert.equal(clamped.width, 2); assert.equal(clamped.height, 2);
  assert.equal(clamped.data[0], val(6, 6));
  const full = await g.images[0].read();                   // read() === readWindow(null)
  for (let i = 0; i < W2 * H2; i++) assert.equal(full[i], val((i / W2) | 0, i % W2));
});

test('gridWindowFromGTiff shifts the origin to the window', async () => {
  const { tif, val } = tiledDem();
  const g = await readGTiff(tif);
  const win = { x: 3, y: 2, width: 3, height: 3 };
  const gw = await gridWindowFromGTiff(g, 0, win);
  const full = await gridFromGTiff(g);
  assert.equal(gw.nx, 3); assert.equal(gw.ny, 3);
  // window origin = full origin shifted by the pixel offset
  assert.equal(gw.x0, full.x0 + 3 * full.dx);
  assert.equal(gw.y0, full.y0 - 2 * full.dy);
  assert.equal(gw.dx, full.dx);
  assert.equal(gw.data[0], val(2, 3));                     // top-left of the window
});

test('windowForWorldBbox maps a world bbox to a padded pixel window', () => {
  const g = { images: [{ width: 8, height: 8 }], geo: { origin: [612000, 7765080], scale: [10, 10], pixelIsPoint: false, nodata: -9999, crs: null } };
  // sample (0,0) centre is at (612005, 7765075); a bbox around cols 2-4, rows 1-3
  const bb = [612025, 7765045, 612045, 7765065];
  const win = windowForWorldBbox(g, 0, bb, 1);
  assert.ok(win.x <= 2 && win.x + win.width >= 5, `x window ${JSON.stringify(win)}`);
  assert.ok(win.y <= 1 && win.y + win.height >= 4, `y window ${JSON.stringify(win)}`);
});

test('readDecimated subsamples the whole image (bounded memory)', async () => {
  const { tif, val, W2 } = tiledDem();                     // 8×8 in 4×4 tiles
  const g = await readGTiff(tif);
  const r = await g.images[0].readDecimated(2);            // → 4×4 on the even lattice
  assert.equal(r.dnx, 4); assert.equal(r.dny, 4); assert.equal(r.step, 2);
  for (let dr = 0; dr < 4; dr++) for (let dc = 0; dc < 4; dc++) assert.equal(r.data[dr * 4 + dc], val(dr * 2, dc * 2), `dec ${dr},${dc}`);
  const one = await g.images[0].readDecimated(1);          // step 1 == full read
  assert.equal(one.dnx, W2);
  assert.equal(one.data[W2 + 1], val(1, 1));
});

test('gridDecimatedFromGTiff: cell size scales, origin holds', async () => {
  const { tif } = tiledDem();
  const g = await readGTiff(tif);
  const full = await gridFromGTiff(g);
  const dec = await gridDecimatedFromGTiff(g, 0, 2);
  assert.equal(dec.nx, 4); assert.equal(dec.ny, 4);
  assert.equal(dec.dx, full.dx * 2);                       // coarser cells
  assert.equal(dec.x0, full.x0);                           // sample (0,0) unchanged
  assert.equal(dec.y0, full.y0);
  assert.equal(dec.data[0], full.data[0]);
});

test('stepForCap picks a bounded decimation', () => {
  const g = { images: [{ width: 4000, height: 4000 }], geo: {} };   // 16M px
  assert.equal(stepForCap(g, 0, 16_000_000), 1);           // already fits
  assert.equal(stepForCap(g, 0, 4_000_000), 2);            // /2 → 4M
  assert.equal(stepForCap(g, 0, 1_000_000), 4);            // /4 → 1M
});

test('levelGeo + pickOverviewForCap over a fake pyramid', () => {
  // full 800×800, overviews 400×400, 200×200, 100×100
  const g = { images: [{ width: 800, height: 800 }, { width: 400, height: 400 }, { width: 200, height: 200 }, { width: 100, height: 100 }], geo: { origin: [1000, 5000], scale: [1, 1], pixelIsPoint: false } };
  const l2 = levelGeo(g, 2);
  assert.equal(l2.nx, 200); assert.equal(l2.dx, 4);        // 800/200 = 4× coarser
  assert.equal(l2.x0, 1000 + 2);                           // half a 4 m cell in
  // cap 50k px → finest level ≤ 50k is 200×200 (40k); 400×400 = 160k > cap
  assert.equal(pickOverviewForCap(g, 50000), 2);
  assert.equal(pickOverviewForCap(g, 200000), 1);          // 400×400 fits
  assert.equal(pickOverviewForCap(g, 5000), 3);            // only the coarsest 100×100 (10k)... falls back
});
