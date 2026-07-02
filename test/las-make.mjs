// Test-only synthetic LAS writer — builds valid uncompressed LAS 1.2/1.4 buffers so
// @gcu/condenser's reader can be validated without shipping a writer or real data.
// Shared by test/condenser.test.mjs and the micro render smoke.
//
// points: array of { x, y, z, intensity?, classification?, r?, g?, b? } in WORLD
// coordinates; scale/offset are applied in reverse to produce the stored int32s.
export function makeLas(points, {
  format = 0,                       // 0..3, 6..8 (what the reader supports)
  scale = [0.001, 0.001, 0.001],
  offset = [0, 0, 0],
  version = [1, 2],                 // [major, minor]; 1.4 → 375-byte header + u64 count
} = {}) {
  const RECLEN = { 0: 20, 1: 28, 2: 26, 3: 34, 6: 30, 7: 36, 8: 38 }[format];
  if (!RECLEN) throw new Error(`las-make: unsupported format ${format}`);
  const is14 = version[1] >= 4;
  const headerSize = is14 ? 375 : 227;
  const n = points.length;
  const buf = new ArrayBuffer(headerSize + n * RECLEN);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // ── public header block ──
  u8.set([0x4C, 0x41, 0x53, 0x46], 0);                    // "LASF"
  dv.setUint8(24, version[0]); dv.setUint8(25, version[1]);
  dv.setUint16(94, headerSize, true);
  dv.setUint32(96, headerSize, true);                     // offset to point data (no VLRs)
  dv.setUint32(100, 0, true);                             // VLR count
  dv.setUint8(104, format);
  dv.setUint16(105, RECLEN, true);
  dv.setUint32(107, is14 ? 0 : n, true);                  // legacy count (0 in 1.4 convention)
  for (let i = 0; i < 3; i++) {
    dv.setFloat64(131 + i * 8, scale[i], true);
    dv.setFloat64(155 + i * 8, offset[i], true);
  }
  // bbox: max/min interleaved per axis (maxX, minX, maxY, minY, maxZ, minZ)
  // (loop, not Math.max(...spread) — a spread of millions of points blows the call stack)
  const ext = (k) => {
    if (!points.length) return [0, 0];
    let mx = -Infinity, mn = Infinity;
    for (const p of points) { const v = p[k]; if (v > mx) mx = v; if (v < mn) mn = v; }
    return [mx, mn];
  };
  const [maxX, minX] = ext('x'), [maxY, minY] = ext('y'), [maxZ, minZ] = ext('z');
  [[maxX, minX], [maxY, minY], [maxZ, minZ]].forEach(([mx, mn], i) => {
    dv.setFloat64(179 + i * 16, mx, true);
    dv.setFloat64(187 + i * 16, mn, true);
  });
  if (is14) dv.setBigUint64(247, BigInt(n), true);        // 1.4 u64 point count

  // ── point records ──
  const rgbOff = { 2: 20, 3: 28, 7: 30, 8: 30 }[format];
  const clsOff = format >= 6 ? 16 : 15;
  points.forEach((p, i) => {
    const o = headerSize + i * RECLEN;
    dv.setInt32(o, Math.round((p.x - offset[0]) / scale[0]), true);
    dv.setInt32(o + 4, Math.round((p.y - offset[1]) / scale[1]), true);
    dv.setInt32(o + 8, Math.round((p.z - offset[2]) / scale[2]), true);
    dv.setUint16(o + 12, p.intensity || 0, true);
    dv.setUint8(clsOff + o, p.classification || 0);
    if (rgbOff != null) {
      dv.setUint16(o + rgbOff, p.r || 0, true);
      dv.setUint16(o + rgbOff + 2, p.g || 0, true);
      dv.setUint16(o + rgbOff + 4, p.b || 0, true);
    }
  });
  return buf;
}

// A deterministic synthetic terrain patch (QF-ish bench + a pit wall) for bigger tests:
// n points over [x0,x0+w]×[y0,y0+h] with a sloped/stepped z and lognormal-ish intensity.
// PRNG is mulberry32 — NOT the naive LCG `s*1103515245 & 0x7fffffff`, whose f64
// multiply exceeds 2^53 and degenerates to a ~16k-value cycle (2M "random" points
// collapse onto 16k positions; found the hard way via a sparse render).
export function makeTerrainPoints(n, { x0 = 610000, y0 = 7760000, z0 = 900, w = 400, h = 400 } = {}) {
  let a = 42 >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = x0 + rnd() * w, y = y0 + rnd() * h;
    const bench = Math.floor(((x - x0) / w) * 5) * 10;          // 5 benches, 10 m steps
    const z = z0 - bench + Math.sin((y - y0) / 40) * 1.5 + rnd() * 0.3;
    pts[i] = { x, y, z, intensity: Math.floor(1000 + rnd() * rnd() * 50000), classification: 2 + (i % 3), r: Math.floor(rnd() * 65535), g: Math.floor(rnd() * 65535), b: Math.floor(rnd() * 65535) };
  }
  return pts;
}
