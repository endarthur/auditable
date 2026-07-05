// @gcu/gtiff — decode fixtures we ENCODE in-test (a minimal TIFF writer with
// its own LZW/PackBits encoders + node:zlib deflate), so every codec path is
// exercised round-trip: strips/tiles × none/LZW/deflate/PackBits ×
// predictors × sample types × endianness, plus geo tags and the overview
// chain.
import { test } from 'node:test';
import assert from 'node:assert';
import { deflateSync } from 'node:zlib';
import { readGTiff, gridFromGTiff, lzwDecode, packbitsDecode } from '../ext/gtiff/src/main.js';

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
