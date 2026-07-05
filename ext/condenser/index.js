// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/condenser — Streaming no-preprocess renderer for massive spatial elements (point clouds, block models): stream-parse → quantize → chunk → prefix-LOD → progressive accumulation → EDL. The engine under micro.

// ── src/las.js ──

// @gcu/condenser — LAS provider (uncompressed point record formats 0–3 and 6–8).
// Header-driven: the public header block gives bbox, count, format, and scale/offset
// up front — no discovery pass. streamChunks() parses chunk-at-a-time from a
// ReadableStream, never holding raw file bytes beyond the current chunk (+ a
// partial-record carry). Positions come out as WORLD f64 (scale·raw + offset);
// frame-local quantization happens downstream in chunks.js — providers know
// formats, condenser knows rendering, nothing else crosses the seam.
//
// Provider contract (micro-spec §2.4):
//   openLas(blob) → { header, streamChunks(opts): AsyncIterable<RawChunk> }
//   RawChunk = { count, x, y, z: Float64Array, intensity: Uint16Array,
//                classification: Uint8Array, rgb: Uint8Array(3N) | null,
//                recStart: number }   — recStart = record index of element 0.

const RECLEN = { 0: 20, 1: 28, 2: 26, 3: 34, 6: 30, 7: 36, 8: 38 };
const RGB_OFF = { 2: 20, 3: 28, 7: 30, 8: 30 };

class LasFormatError extends Error {
  constructor(msg) { super(msg); this.name = 'LasFormatError'; }
}

// Parse the public header block from the file's first bytes (≥ 375 recommended).
function parseLasHeader(bytes) {
  const dv = bytes instanceof DataView ? bytes : new DataView(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength);
  if (dv.byteLength < 227) throw new LasFormatError('file too small for a LAS header');
  if (dv.getUint8(0) !== 0x4C || dv.getUint8(1) !== 0x41 || dv.getUint8(2) !== 0x53 || dv.getUint8(3) !== 0x46) {
    throw new LasFormatError('not a LAS file (no LASF signature)');
  }
  const verMajor = dv.getUint8(24), verMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const pointOffset = dv.getUint32(96, true);
  const fmtByte = dv.getUint8(104);
  if (fmtByte & 0x80) throw new LasFormatError('LAZ (compressed) — not supported; export uncompressed LAS');
  const format = fmtByte & 0x3f;
  if (!(format in RECLEN)) throw new LasFormatError(`unsupported point record format ${format} (supported: 0–3, 6–8)`);
  const recordLen = dv.getUint16(105, true);
  if (recordLen < RECLEN[format]) throw new LasFormatError(`record length ${recordLen} < format ${format} minimum ${RECLEN[format]}`);
  const legacyCount = dv.getUint32(107, true);
  let count = legacyCount;
  if (verMinor >= 4 && headerSize >= 255 && dv.byteLength >= 255) {
    const c64 = dv.getBigUint64(247, true);
    if (c64 > 0n) count = Number(c64);                    // 1.4 files may zero the legacy field
  }
  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  // bbox stored max/min interleaved per axis
  const bbox = {
    min: [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)],
    max: [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)],
  };
  return {
    kind: 'las', version: `${verMajor}.${verMinor}`, format, recordLen,
    count, pointOffset, scale, offset, bbox,
    hasRgb: format in RGB_OFF,
    attributes: ['intensity', 'classification', ...(format in RGB_OFF ? ['rgb'] : [])],
  };
}

// Decode `n` fixed-size records from dv starting at byte 0 into columnar arrays.
// RGB: LAS stores u16 per channel, but many files carry 8-bit values in the low
// byte. Decode as u16, decide once per chunk (any channel > 255 → 16-bit → >>8),
// or accept a `forceRgb16` override (sticky across chunks — see streamChunks).
function decodeLasRecords(dv, header, n, recStart, { forceRgb16 = false } = {}) {
  const { format, recordLen, scale, offset } = header;
  const clsOff = format >= 6 ? 16 : 15;
  const rgbOff = RGB_OFF[format];
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const intensity = new Uint16Array(n), classification = new Uint8Array(n);
  const rgb16 = rgbOff != null ? new Uint16Array(3 * n) : null;
  for (let i = 0; i < n; i++) {
    const o = i * recordLen;
    x[i] = dv.getInt32(o, true) * scale[0] + offset[0];
    y[i] = dv.getInt32(o + 4, true) * scale[1] + offset[1];
    z[i] = dv.getInt32(o + 8, true) * scale[2] + offset[2];
    intensity[i] = dv.getUint16(o + 12, true);
    classification[i] = dv.getUint8(o + clsOff);
    if (rgb16) {
      rgb16[i * 3] = dv.getUint16(o + rgbOff, true);
      rgb16[i * 3 + 1] = dv.getUint16(o + rgbOff + 2, true);
      rgb16[i * 3 + 2] = dv.getUint16(o + rgbOff + 4, true);
    }
  }
  let rgb = null, rgbIs16 = forceRgb16;
  if (rgb16) {
    if (!rgbIs16) { for (let k = 0; k < rgb16.length; k++) if (rgb16[k] > 255) { rgbIs16 = true; break; } }
    rgb = new Uint8Array(3 * n);
    if (rgbIs16) for (let k = 0; k < rgb16.length; k++) rgb[k] = rgb16[k] >> 8;
    else rgb.set(rgb16);                                   // values ≤255 fit as-is
  }
  return { count: n, x, y, z, intensity, classification, rgb, recStart, rgbIs16 };
}

/**
 * Open a LAS Blob/File. Reads the header up front (one small slice), then
 * streamChunks() yields RawChunks of ≤ chunkPoints records, parsing from a
 * fresh ReadableStream (a cold re-runnable recipe — call it again for a second
 * sweep). Carries partial records across stream chunk boundaries.
 */
async function openLas(blob, { headerBytes = 512 } = {}) {
  const head = new DataView(await blob.slice(0, Math.min(headerBytes, blob.size)).arrayBuffer());
  const header = parseLasHeader(head);
  const recordLen = header.recordLen;

  async function* streamChunks({ chunkPoints = 1 << 20, signal } = {}) {
    const stream = blob.slice(header.pointOffset).stream();
    const reader = stream.getReader();
    let carry = new Uint8Array(0);
    let recDone = 0;
    let rgb16 = false;                                     // sticky: once 16-bit color is seen, stay >>8
    try {
      while (recDone < header.count) {
        const { done, value } = await reader.read();
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (done) break;
        let buf = value;
        if (carry.length) {                                // stitch the partial record from last read
          const joined = new Uint8Array(carry.length + value.length);
          joined.set(carry, 0); joined.set(value, carry.length);
          buf = joined; carry = new Uint8Array(0);
        }
        let avail = Math.floor(buf.length / recordLen);
        if (avail * recordLen < buf.length) carry = buf.slice(avail * recordLen);
        avail = Math.min(avail, header.count - recDone);
        let off = 0;
        while (avail > 0) {
          const n = Math.min(avail, chunkPoints);
          const dv = new DataView(buf.buffer, buf.byteOffset + off, n * recordLen);
          const chunk = decodeLasRecords(dv, header, n, recDone, { forceRgb16: rgb16 });
          if (chunk.rgbIs16) rgb16 = true;                 // sticky: once 16-bit color is seen, stay >>8
          yield chunk;
          recDone += n; off += n * recordLen; avail -= n;
        }
      }
    } finally {
      reader.releaseLock();
      try { await stream.cancel(); } catch { /* already done */ }
    }
  }

  return { header, streamChunks };
}

// ── ../frame/src/frame.js ──

// @gcu/frame — the coordinate-frame contract for the whole GCU geometry stack.
//
// Geological work lives at projected-coordinate magnitudes (UTM easting ~5e5,
// northing ~7.7e6, RL ~1e3). Two failures follow and share one cause — doing math
// and rendering directly in those large numbers:
//   • the float32 wall — at northing 7.7e6 a 32-bit float resolves to ~1 m, so any
//     GPU/Float32Array path jitters and z-fights;
//   • catastrophic cancellation — derived quantities (lengths, cross products,
//     intersection params) lose relative precision, and a fixed ε like 1e-9 is
//     meaningless against operands of magnitude 1e6.
// The fix is to work in a small-magnitude LOCAL frame and keep the offset to WORLD
// as explicit, inspectable metadata. This module is that contract — a tiny value
// type plus pure functions, zero-dependency, that every coordinate-bearing package
// can speak.
//
// A Frame has two faculties with different reach:
//   1. numerical framing — the world↔local offset (`origin`), for the precision path
//      (dee/voxmesh/groma/regula/dxf/moncad compute in it; it gates every F32 downcast);
//   2. coordinate identity — the `crs` descriptor + `units`, universal provenance so
//      "what do these world numbers mean" is never silent.
//
// HARD BOUNDARY: frame NAMES a CRS, it never CHANGES one. Reprojection (datum shifts,
// projection changes) is a geodetic operation that lives elsewhere (spinifex/proj4
// today, a future @gcu/proj if it ever becomes a stack primitive). Crossing CRS here
// throws — see `delta`. A working offset is a translation for numerical convenience,
// not a reprojection.
//
// Points and origins are ARRAYS — [x, y] or [x, y, z] — matching the rest of the tree
// (dee.origin, grid.origin, flat Float64/Float32 vertex buffers), not the {x,y,z}
// objects the prose spec sketches. The frame is pure translation: rotation/scale are
// deliberately out of scope (a block model's own dip/rake orientation is intrinsic
// model geometry, a separate concern from the local frame — never conflated).

// A Frame value. `origin` is the WORLD coordinate of the local origin, so
// `local = world − origin`. `crs` is an optional projection descriptor (e.g. an EPSG
// code) — null means "unstated", which opts out of cross-frame CRS checking. `units`
// defaults to metres.
function makeFrame({ origin, crs = null, units = 'm' } = {}) {
  const o = origin ? Array.from(origin, Number) : [0, 0, 0];
  while (o.length < 3) o.push(0);
  return { origin: o.slice(0, 3), crs, units };
}

// The identity frame: origin at world zero. World == local. Useful as a default and
// as the "already in world coordinates" marker.
const WORLD = makeFrame({ origin: [0, 0, 0] });

// Normalise a CRS code for IDENTITY comparison: uppercase + strip a leading `EPSG:`, so
// `'EPSG:31983'`, `'epsg:31983'`, and `'31983'` all compare equal. It lives HERE, not in a
// geo/reprojection layer: frame is zero-dep and sits *under* any such layer, so importing a
// helper from geo would invert the dependency. A reprojection layer's richer code resolution
// is a superset built on this. Comparison only — the stored `crs` keeps its original spelling.
function canonCrs(code) {
  return code == null ? null : String(code).trim().toUpperCase().replace(/^EPSG:/, '');
}

// Two frames describe the same projection iff their (canonicalised) CRS agree (a null CRS on
// either side is a wildcard — you can't assert a mismatch you never declared) and their units
// match. This is the gate that keeps a frame shift from masquerading as a reprojection.
function sameProjection(a, b) {
  const ca = canonCrs(a.crs), cb = canonCrs(b.crs);
  if (ca != null && cb != null && ca !== cb) return false;
  return (a.units ?? 'm') === (b.units ?? 'm');
}

// Full structural equality: same origin, (canonicalised) CRS, and units.
function frameEq(a, b) {
  return canonCrs(a.crs) === canonCrs(b.crs) && (a.units ?? 'm') === (b.units ?? 'm') &&
    a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.origin[2] === b.origin[2];
}

// ── Point transforms (single [x,y] or [x,y,z]) ──────────────────────────────────

// World → local: subtract the origin component-wise. Round-trips losslessly with
// `toWorld` at f64 (invariant 3) — exact when the origin is chosen near the data, the
// intended use.
function toLocal(worldPt, frame) {
  const o = frame.origin, r = new Array(worldPt.length);
  for (let i = 0; i < worldPt.length; i++) r[i] = worldPt[i] - (o[i] || 0);
  return r;
}

// Local → world: add the origin back. The inverse of `toLocal`.
function toWorld(localPt, frame) {
  const o = frame.origin, r = new Array(localPt.length);
  for (let i = 0; i < localPt.length; i++) r[i] = localPt[i] + (o[i] || 0);
  return r;
}

// ── Bulk buffer transforms (flat x,y,z,x,y,z,… arrays) ──────────────────────────
// These consolidate the hand-rolled F64-recentre loops currently duplicated in the
// dee importers (lfm/msh adapters): subtract the origin at full f64 precision and hand
// the small local magnitudes to the F32/GPU downcast. The one hard rule of §5 —
// anything bound for a Float32Array passes through the local frame FIRST — is this
// call. Returns a NEW Float64Array; input is never mutated.

function toLocalCoords(coords, frame, { stride = 3 } = {}) {
  const o = frame.origin, out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += stride)
    for (let j = 0; j < stride; j++) out[i + j] = coords[i + j] - (o[j] || 0);
  return out;
}

function toWorldCoords(coords, frame, { stride = 3 } = {}) {
  const o = frame.origin, out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += stride)
    for (let j = 0; j < stride; j++) out[i + j] = coords[i + j] + (o[j] || 0);
  return out;
}

// ── Choosing an origin ──────────────────────────────────────────────────────────

// Pick a sticky origin from world-coordinate bounds. Default strategy 'centroid'
// (bbox centre); 'floor' keeps locals strictly positive (handy across tiled exports).
// The result is rounded to `round` so the anchor reads as a "nice" number in logs and
// diffs rather than an arbitrary fractional point. bounds = { min:[…], max:[…] }.
// The origin is chosen ONCE per document/session and is sticky — recomputing it
// per-operation drifts the frame and invalidates cached geometry (§4).
function originFromBounds(bounds, { round = 1, strategy = 'centroid' } = {}) {
  const { min, max } = bounds, n = Math.min(min.length, max.length), o = [];
  for (let i = 0; i < n; i++) {
    const c = strategy === 'floor' ? min[i] : (min[i] + max[i]) / 2;
    o.push(round ? Math.round(c / round) * round : c);
  }
  while (o.length < 3) o.push(0);
  return o.slice(0, 3);
}

// Convenience: a Frame straight from bounds (origin via `originFromBounds`, carrying
// the given CRS/units).
function frameFromBounds(bounds, opts = {}) {
  return makeFrame({
    origin: originFromBounds(bounds, opts),
    crs: opts.crs ?? null,
    units: opts.units ?? 'm',
  });
}

// ── Frame-relative tolerance ────────────────────────────────────────────────────

// A tolerance scaled to the working extent, so coincidence / parallel / on-curve tests
// stay meaningful at any magnitude — a fixed absolute 1e-9 is meaningless against UTM
// operands, the same failure class as the original silent-shift bug. `extent` is the
// working span (e.g. the local bbox diagonal); `rel` is the relative floor. Feeds the
// @gcu/regula tolerance model. Note exact sign/orientation tests stay EXACT (groma
// predicates) — this ε is only for constructed quantities.
function extentTolerance(frame, extent, { rel = 1e-9 } = {}) {
  const e = Math.abs(extent) || 1;
  return { eps: rel * e, rel, extent: e, units: frame.units };
}

// ── Frame ↔ frame ───────────────────────────────────────────────────────────────

// The translation to add to a point expressed local-in `from` to re-express it
// local-in `to`:  localTo = localFrom + (fromOrigin − toOrigin). Throws if the frames
// describe different projections — moving between those is a reprojection, which frame
// does not perform (the hard boundary).
function delta(from, to) {
  if (!sameProjection(from, to)) {
    throw new Error(
      `frame.delta: frames differ in CRS/units (${from.crs}/${from.units} → ${to.crs}/${to.units}); ` +
      'that is a reprojection, which @gcu/frame does not perform',
    );
  }
  return [
    from.origin[0] - to.origin[0],
    from.origin[1] - to.origin[1],
    from.origin[2] - to.origin[2],
  ];
}

// Declare an artifact's frame WITHOUT moving its coordinates (invariant 2: a coordinate
// expressed in a local frame always carries an inspectable origin). Shallow, pure —
// returns a copy with `.frame` stamped. Re-EXPRESSING coordinates into a different
// frame is `rebaseCoords`, a separate and logged transform.
function withFrame(artifact, frame) {
  return { ...artifact, frame };
}

// Re-express a flat coordinate buffer from one frame into another. Returns BOTH the new
// Float64Array and a provenance record — rebasing is an explicit, accountable transform
// (invariants 4/5), so you cannot get the moved coordinates without the record of what
// moved them (the same "numbers plus an account of what I did to them" discipline as
// the DXF contract). Throws via `delta` on a CRS/units mismatch. Pure; input untouched.
function rebaseCoords(coords, from, to, { stride = 3 } = {}) {
  const d = delta(from, to);
  const out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += stride)
    for (let j = 0; j < stride; j++) out[i + j] = coords[i + j] + (d[j] || 0);
  return { coords: out, record: rebaseRecord(from, to, d) };
}

// A provenance entry for a rebase — what the caller pushes onto its frame log.
function rebaseRecord(from, to, d) {
  return {
    op: 'rebase',
    from: { origin: [...from.origin], crs: from.crs, units: from.units },
    to: { origin: [...to.origin], crs: to.crs, units: to.units },
    delta: d,
  };
}

// ── src/morton.js ──

// @gcu/condenser — Morton (Z-order) keys + a radix sort over indices.
// Batch-wise spatial chunking (micro-spec §2.1.3): quantize each point to a
// 10-bit lattice per axis against the batch bbox, interleave to a 30-bit key,
// radix-sort an index array by key (three 10-bit passes, ping-pong — sorting
// indices, not elements, avoids the 2× transient), then slice the sorted order
// into chunks. Points that are near in space land in the same chunk → tight
// chunk AABBs → frustum culling and front-to-back order fall out.

// Spread the low 10 bits of v so there are two zero bits between each.
function part1by2(v) {
  v &= 0x3ff;
  v = (v | (v << 16)) & 0x30000ff;
  v = (v | (v << 8)) & 0x300f00f;
  v = (v | (v << 4)) & 0x30c30c3;
  v = (v | (v << 2)) & 0x9249249;
  return v;
}

// 30-bit Morton key from 10-bit lattice coordinates.
function mortonKey(ix, iy, iz) {
  return (part1by2(iz) << 2) | (part1by2(iy) << 1) | part1by2(ix);
}

// Keys for a batch: quantize x/y/z (f64, any space — only intra-batch
// consistency matters) to 10 bits against the batch extent.
function mortonKeys(x, y, z, n) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    if (z[i] < minZ) minZ = z[i]; if (z[i] > maxZ) maxZ = z[i];
  }
  const sx = maxX > minX ? 1023 / (maxX - minX) : 0;
  const sy = maxY > minY ? 1023 / (maxY - minY) : 0;
  const sz = maxZ > minZ ? 1023 / (maxZ - minZ) : 0;
  const keys = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    keys[i] = mortonKey(((x[i] - minX) * sx) | 0, ((y[i] - minY) * sy) | 0, ((z[i] - minZ) * sz) | 0);
  }
  return keys;
}

// Radix sort 0..n-1 by keys[] — three 10-bit passes, counting sort each,
// ping-pong index buffers. Stable; returns the sorted index array.
function radixSortIndices(keys, n) {
  let src = new Uint32Array(n), dst = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  const counts = new Uint32Array(1024);
  for (let pass = 0; pass < 3; pass++) {
    const shift = pass * 10;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(keys[src[i]] >>> shift) & 0x3ff]++;
    let sum = 0;
    for (let b = 0; b < 1024; b++) { const c = counts[b]; counts[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) dst[counts[(keys[src[i]] >>> shift) & 0x3ff]++] = src[i];
    const t = src; src = dst; dst = t;
  }
  return src;
}

// ── src/chunks.js ──

// @gcu/condenser — the chunk store: RawChunks (world f64, from a provider) →
// render-ready Chunks (frame-local uint16 positions + attributes + record index).
//
// Frame-local first (micro-spec Addendum A.1): one @gcu/frame per document, chosen
// from the header bbox; everything downstream (chunk bboxes, camera, clip uniforms)
// lives at small local magnitudes so the f32/GPU path never sees a 7.7e6 northing.
// The frame is pure translation with CRS identity — publish world coordinates by
// adding the origin back at the boundary.
//
// The invariant everything rests on (micro-spec §2.1.4): after building, elements
// inside a chunk are RANDOMLY PERMUTED, so any prefix of a chunk is a uniform
// random subsample of that chunk's region. Prefix-LOD, progressive accumulation,
// and budget-capped drawing all read prefixes and inherit their correctness from
// this shuffle. Seeded PRNG (mulberry32) → deterministic for tests.
//
// Chunking is BATCH-MORTON (§2.1.3): accumulate ~batchSize elements, Morton-radix-
// sort the batch, slice the sorted order into chunks → spatially tight chunk AABBs
// (frustum culling + front-to-back fall out) while peak CPU memory stays bounded
// by batchSize × constant — never proportional to the file (§3 heap bound).
//
// Chunk = {
//   count, bboxLocal: Float64Array(6) [minX,minY,minZ,maxX,maxY,maxZ],
//   pos: Uint16Array(3N)  — quantized against bboxLocal (denormalize in-shader),
//   intensity: Uint16Array, classification: Uint8Array, rgb: Uint8Array(3N)|null,
//   recIdx: Uint32Array   — row number in the source file: THE join key (§4).
// }


// mulberry32 — tiny seeded PRNG; good enough for a decorrelating shuffle.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates permutation of 0..n-1.
function shuffledIndices(n, rnd) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx;
}

// In-place Fisher–Yates over an existing index array (a gather list).
function shuffleInPlace(idx, rnd) {
  for (let i = idx.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  return idx;
}

// Pick the document frame from a provider header (bbox in world coords). CRS is
// identity metadata only — condenser never reprojects.
function documentFrame(header, { crs = null } = {}) {
  const b = header.bbox;
  if (b && Number.isFinite(b.min[0]) && Number.isFinite(b.max[0]) && (b.max[0] || b.min[0])) {
    return frameFromBounds({ min: b.min, max: b.max }, { crs, round: 1 });
  }
  return makeFrame({ origin: [0, 0, 0], crs });            // no usable bbox → identity
}

/**
 * Build one render Chunk from columnar source arrays. `indices` is an optional
 * gather list (element ids into the columns — e.g. one Morton-ordered slice of a
 * batch); omitted → all elements. The gather list is SHUFFLED (in a copy) before
 * the single gather-quantize pass — gather and shuffle cost one pass together.
 */
function buildChunk({ x, y, z, intensity, classification, rgb, recIdx }, frame, rnd, indices = null) {
  const n = indices ? indices.length : x.length;
  const o = frame.origin;
  // pass 1 — frame-local bbox (f64 subtract BEFORE any narrowing — the one hard rule)
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    const px = x[i] - o[0], py = y[i] - o[1], pz = z[i] - o[2];
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  const sx = maxX > minX ? 65535 / (maxX - minX) : 0;
  const sy = maxY > minY ? 65535 / (maxY - minY) : 0;
  const sz = maxZ > minZ ? 65535 / (maxZ - minZ) : 0;
  // pass 2 — shuffle the gather order, then gather + quantize in one sweep
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const pos = new Uint16Array(3 * n);
  const outI = new Uint16Array(n), outC = new Uint8Array(n), outR = new Uint32Array(n);
  const outRgb = rgb ? new Uint8Array(3 * n) : null;
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    pos[k * 3] = ((x[i] - o[0] - minX) * sx + 0.5) | 0;
    pos[k * 3 + 1] = ((y[i] - o[1] - minY) * sy + 0.5) | 0;
    pos[k * 3 + 2] = ((z[i] - o[2] - minZ) * sz + 0.5) | 0;
    outI[k] = intensity[i];
    outC[k] = classification[i];
    outR[k] = recIdx[i];
    if (outRgb) { outRgb[k * 3] = rgb[i * 3]; outRgb[k * 3 + 1] = rgb[i * 3 + 1]; outRgb[k * 3 + 2] = rgb[i * 3 + 2]; }
  }
  return {
    count: n,
    bboxLocal: Float64Array.of(minX, minY, minZ, maxX, maxY, maxZ),
    pos, intensity: outI, classification: outC, rgb: outRgb, recIdx: outR,
  };
}

// Denormalize one quantized element back to frame-local f64 (tests + picking).
function chunkLocalPosition(chunk, k) {
  const b = chunk.bboxLocal;
  const d = (v, mn, mx) => (mx > mn ? mn + (v / 65535) * (mx - mn) : mn);
  return [
    d(chunk.pos[k * 3], b[0], b[3]),
    d(chunk.pos[k * 3 + 1], b[1], b[4]),
    d(chunk.pos[k * 3 + 2], b[2], b[5]),
  ];
}

/**
 * ChunkBuilder — feed RawChunks as they stream in; emits finished Chunks via
 * onChunk. Batch-Morton by default: elements accumulate to ~batchSize, the batch
 * is Morton-sorted and sliced into chunkSize chunks (each internally shuffled).
 * `morton: false` slices in arrival order instead (still shuffled). flush()
 * emits the remainder and returns the document summary.
 */
function createChunkBuilder({ frame, chunkSize = 1 << 20, batchSize = 0, morton = true, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  const batchN = batchSize || chunkSize * 4;               // default: 4 chunks per spatial batch
  let pend = [];                                           // pending RawChunk column slices
  let pendCount = 0;
  const doc = { count: 0, bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity), hasRgb: false };

  const concat = (Type, parts, per) => {
    const out = new Type(pendCount * per);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const emitChunk = (chunk) => {
    doc.count += chunk.count;
    doc.hasRgb = doc.hasRgb || !!chunk.rgb;
    const b = doc.bboxLocal, cb = chunk.bboxLocal;
    for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
    onChunk(chunk);
  };
  const flushBatch = () => {
    if (!pendCount) return;
    const cols = {
      x: concat(Float64Array, pend.map((p) => p.x), 1),
      y: concat(Float64Array, pend.map((p) => p.y), 1),
      z: concat(Float64Array, pend.map((p) => p.z), 1),
      intensity: concat(Uint16Array, pend.map((p) => p.intensity), 1),
      classification: concat(Uint8Array, pend.map((p) => p.classification), 1),
      rgb: pend.every((p) => p.rgb) ? concat(Uint8Array, pend.map((p) => p.rgb), 3) : null,
      recIdx: concat(Uint32Array, pend.map((p) => p.recIdx), 1),
    };
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = morton ? radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n) : null;
    for (let start = 0; start < n; start += chunkSize) {
      const end = Math.min(start + chunkSize, n);
      const slice = order ? order.subarray(start, end)
        : Uint32Array.from({ length: end - start }, (_, i) => start + i);
      emitChunk(buildChunk(cols, frame, rnd, slice));
    }
  };

  return {
    push(raw) {
      // record indices: the provider may supply raw.recIdx directly (RAW record
      // numbers, gaps allowed — .dm skips bad rows but keeps true row numbers so
      // O(1) record fetch works); default = recStart + i (gapless providers).
      let recIdx = raw.recIdx;
      if (!recIdx) {
        recIdx = new Uint32Array(raw.count);
        for (let i = 0; i < raw.count; i++) recIdx[i] = raw.recStart + i;
      }
      let taken = 0;
      while (taken < raw.count) {
        const room = batchN - pendCount;
        const n = Math.min(room, raw.count - taken);
        const slice = (a, per = 1) => (a ? a.subarray(taken * per, (taken + n) * per) : null);
        pend.push({ x: slice(raw.x), y: slice(raw.y), z: slice(raw.z), intensity: slice(raw.intensity), classification: slice(raw.classification), rgb: slice(raw.rgb, 3), recIdx: recIdx.subarray(taken, taken + n) });
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}

// ── src/blocks.js ──

// @gcu/condenser — block-model chunks: IJK-exact representation (micro-spec §2.5).
//
// For a REGULAR uniform grid, a block's centroid is fully determined by its integer
// IJK: center = grid.originLocal + ijk · size, where originLocal is the CENTROID of
// block (0,0,0) — the centroid convention throughout. Chunks store raw uint16 IJK
// (not bbox-normalized lattice positions), so reconstruction is EXACT — and IJK is
// itself useful for the grid-view join. Half-dims are a chunk-level uniform (all
// blocks one size). Sub-blocked models don't fit this scheme; they render via the
// points pipeline until the fine-lattice (IJK + size-code) upgrade.
//
// Attributes per block: one SCALAR channel (grade — f32 in, quantized u16 against
// the chunk's min/max, range carried per chunk) + one CATEGORY channel (u8 codes
// from the provider's dictionary, ≤255 distinct) + uint32 record index (the join).
// The intra-chunk shuffle invariant (§2.1.4) applies unchanged.
//
// BlockChunk = {
//   kind: 'blocks', count,
//   grid: { originLocal: [x,y,z], size: [dx,dy,dz] },   — shared, frame-local
//   ijk: Uint16Array(3N), chan: Uint16Array(N), chanRange: [min,max],
//   cat: Uint8Array(N), recIdx: Uint32Array(N),
//   bboxLocal: Float64Array(6)                          — outer faces, for culling
// }


/**
 * Infer a regular grid from per-axis distinct centroid values (collected by a
 * provider's discovery sweep). Returns { origin (CENTROID of block 0 — i.e. the
 * first lattice value), pitch, count } per axis, or null when the axis isn't a
 * consistent lattice. `values` must be sorted ascending, deduped.
 */
function inferAxis(values, { rel = 1e-6 } = {}) {
  if (!values.length) return null;
  if (values.length === 1) return { origin: values[0], pitch: 0, count: 1 };
  let pitch = Infinity;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0 && d < pitch) pitch = d;
  }
  if (!Number.isFinite(pitch) || pitch <= 0) return null;
  const span = values[values.length - 1] - values[0];
  const count = Math.round(span / pitch) + 1;
  if (count > 65535) return null;                          // beyond u16 IJK — not this path
  const eps = Math.max(pitch * 1e-3, Math.abs(values[0]) * rel);
  for (const v of values) {
    const k = Math.round((v - values[0]) / pitch);
    if (Math.abs(values[0] + k * pitch - v) > eps) return null;   // off-lattice → not regular
  }
  return { origin: values[0], pitch, count };
}

// Grid from three axes (world coords) + a frame → the block-chunk grid descriptor.
// origin here is the centroid of block (0,0,0), frame-local.
function makeBlockGrid(axes, frame) {
  const o = frame.origin;
  return {
    originLocal: [axes[0].origin - o[0], axes[1].origin - o[1], axes[2].origin - o[2]],
    size: [axes[0].pitch || 1, axes[1].pitch || 1, axes[2].pitch || 1],
    count: [axes[0].count, axes[1].count, axes[2].count],
  };
}

/**
 * Build one BlockChunk from columnar world-space block centroids + attributes.
 * `indices` = optional gather list (a Morton slice); shuffled like point chunks.
 * IJK is computed against the grid; anything off-lattice snaps to the nearest
 * cell (the provider validated regularity during discovery).
 */
function buildBlockChunk({ x, y, z, chan, cat, recIdx }, grid, frame, rnd, indices = null) {
  const n = indices ? indices.length : x.length;
  const o = frame.origin;
  const [gx, gy, gz] = grid.originLocal, [sx, sy, sz] = grid.size;
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const ijk = new Uint16Array(3 * n);
  const outChan = new Uint16Array(n), outCat = new Uint8Array(n), outR = new Uint32Array(n);
  // chan range over this chunk (quantize against it — per-chunk min/max, §2.1.2)
  let cMin = Infinity, cMax = -Infinity;
  for (let k = 0; k < n; k++) { const v = chan[perm[k]]; if (Number.isFinite(v)) { if (v < cMin) cMin = v; if (v > cMax) cMax = v; } }
  if (!Number.isFinite(cMin)) { cMin = 0; cMax = 0; }
  const cScale = cMax > cMin ? 65535 / (cMax - cMin) : 0;
  let minI = 65535, minJ = 65535, minK = 65535, maxI = 0, maxJ = 0, maxK = 0;
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    const bi = Math.max(0, Math.round((x[i] - o[0] - gx) / sx));
    const bj = Math.max(0, Math.round((y[i] - o[1] - gy) / sy));
    const bk = Math.max(0, Math.round((z[i] - o[2] - gz) / sz));
    ijk[k * 3] = bi; ijk[k * 3 + 1] = bj; ijk[k * 3 + 2] = bk;
    if (bi < minI) minI = bi; if (bi > maxI) maxI = bi;
    if (bj < minJ) minJ = bj; if (bj > maxJ) maxJ = bj;
    if (bk < minK) minK = bk; if (bk > maxK) maxK = bk;
    const cv = chan[i];
    outChan[k] = Number.isFinite(cv) ? ((cv - cMin) * cScale + 0.5) | 0 : 0;
    outCat[k] = cat ? cat[i] : 0;
    outR[k] = recIdx[i];
  }
  // culling bbox = outer faces of the extreme blocks
  const bboxLocal = Float64Array.of(
    gx + minI * sx - sx / 2, gy + minJ * sy - sy / 2, gz + minK * sz - sz / 2,
    gx + maxI * sx + sx / 2, gy + maxJ * sy + sy / 2, gz + maxK * sz + sz / 2,
  );
  return { kind: 'blocks', count: n, grid, ijk, chan: outChan, chanRange: [cMin, cMax], cat: outCat, recIdx: outR, bboxLocal };
}

// Exact centroid of element k, frame-local (tests + picking).
function blockLocalCenter(chunk, k) {
  const g = chunk.grid;
  return [
    g.originLocal[0] + chunk.ijk[k * 3] * g.size[0],
    g.originLocal[1] + chunk.ijk[k * 3 + 1] * g.size[1],
    g.originLocal[2] + chunk.ijk[k * 3 + 2] * g.size[2],
  ];
}

/**
 * BlockChunkBuilder — same shape as createChunkBuilder but for block RawChunks
 * ({ count, x, y, z, chan: Float32Array|Float64Array, cat: Uint8Array|null,
 * recStart }). Batch-Morton, sliced, shuffled. Tracks the document chan range
 * (for the color ramp) alongside the local bbox.
 */
function createBlockChunkBuilder({ frame, grid, chunkSize = 1 << 20, batchSize = 0, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  const batchN = batchSize || chunkSize * 4;
  let pend = [], pendCount = 0;
  const doc = {
    count: 0,
    bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity),
    chanRange: [Infinity, -Infinity],
  };
  const concat = (Type, parts, per = 1) => {
    const out = new Type(pendCount * per);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const flushBatch = () => {
    if (!pendCount) return;
    const cols = {
      x: concat(Float64Array, pend.map((p) => p.x)),
      y: concat(Float64Array, pend.map((p) => p.y)),
      z: concat(Float64Array, pend.map((p) => p.z)),
      chan: concat(Float64Array, pend.map((p) => p.chan)),
      cat: pend.every((p) => p.cat) ? concat(Uint8Array, pend.map((p) => p.cat)) : null,
      recIdx: concat(Uint32Array, pend.map((p) => p.recIdx)),
    };
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n);
    for (let start = 0; start < n; start += chunkSize) {
      const slice = order.subarray(start, Math.min(start + chunkSize, n));
      const chunk = buildBlockChunk(cols, grid, frame, rnd, slice);
      doc.count += chunk.count;
      const b = doc.bboxLocal, cb = chunk.bboxLocal;
      for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
      if (chunk.chanRange[0] < doc.chanRange[0]) doc.chanRange[0] = chunk.chanRange[0];
      if (chunk.chanRange[1] > doc.chanRange[1]) doc.chanRange[1] = chunk.chanRange[1];
      onChunk(chunk);
    }
  };
  return {
    push(raw) {
      // record indices: the provider may supply raw.recIdx directly (RAW record
      // numbers, gaps allowed — .dm skips bad rows but keeps true row numbers so
      // O(1) record fetch works); default = recStart + i (gapless providers).
      let recIdx = raw.recIdx;
      if (!recIdx) {
        recIdx = new Uint32Array(raw.count);
        for (let i = 0; i < raw.count; i++) recIdx[i] = raw.recStart + i;
      }
      let taken = 0;
      while (taken < raw.count) {
        const room = batchN - pendCount;
        const n = Math.min(room, raw.count - taken);
        const s = (a) => (a ? a.subarray(taken, taken + n) : null);
        pend.push({ x: s(raw.x), y: s(raw.y), z: s(raw.z), chan: s(raw.chan), cat: s(raw.cat), recIdx: recIdx.subarray(taken, taken + n) });
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}

// ── src/grid-join.js ──

// @gcu/condenser — grid compatibility + volume-weighted resample (micro join).
//
// A regular grid axis = { origin, pitch, count }, origin = block-0 CENTROID
// (condenser convention). Cell i spans world [origin+(i-0.5)·pitch,
// origin+(i+0.5)·pitch].
//
// Two grids are COMPATIBLE (per axis) when they share a common lattice
// g = gcd(pitchA, pitchB) (both pitches integer multiples of g) AND their
// origins are phase-aligned on g (offset an integer multiple of g). Then every
// cell decomposes exactly into g-cells and a source→target resample is EXACT
// (integer g-unit overlap weights, no float fuzz):
//   - source coarser than target → refine-replicate,
//   - source finer  → aggregate,
//   - non-nested but common-lattice (e.g. 10 & 12 on g=2) → exact mixed weights.
// Incompatible (no small common lattice, or off-phase) → refused with a reason.
//
// v1: axis-aligned grids. Rotated grids must share azimuth (not modelled here).

const REL = 1e-6;                                          // relative tolerance

// tolerant Euclidean gcd of two positive floats
function floatGcd(a, b, tol) {
  a = Math.abs(a); b = Math.abs(b);
  if (a < b) { const t = a; a = b; b = t; }
  let guard = 0;
  while (b > tol && guard++ < 1000) { const r = a % b; a = b; b = r; }
  return a;
}

// Per-axis source→target overlap map. Returns { ok, reason } or
// { ok:true, g, sp, tp, map:[[{t,w}...] per source index], nested }.
// map[si] = target cells overlapping source cell si, w = overlap in g-units.
function axisMap(src, tgt, opts = {}) {
  // degenerate (single-plane) axis: trivial pass-through
  if (src.count === 1 && tgt.count === 1) return { ok: true, g: 1, sp: 1, tp: 1, map: [[{ t: 0, w: 1 }]], nested: true };
  if (!(src.pitch > 0) || !(tgt.pitch > 0)) return { ok: false, reason: 'a single-plane axis cannot join a multi-cell axis' };
  const tol = opts.tol || REL * Math.max(src.pitch, tgt.pitch, 1);
  const g = floatGcd(src.pitch, tgt.pitch, tol);
  if (!(g > tol)) return { ok: false, reason: 'no common lattice (pitches share no usable factor)' };
  const sp = Math.round(src.pitch / g), tp = Math.round(tgt.pitch / g);
  const capped = opts.cap || 4096;
  if (sp > capped || tp > capped) return { ok: false, reason: `pitches ${src.pitch} and ${tgt.pitch} share no small common lattice (would need a ${g} unit grid)` };
  // g-units measured from the target lattice low face (cell-0 low boundary)
  const ref = tgt.origin - tgt.pitch / 2;
  const srcLow0 = src.origin - src.pitch / 2;
  const phaseF = (srcLow0 - ref) / g;
  if (Math.abs(phaseF - Math.round(phaseF)) > 1e-4) return { ok: false, reason: `origins off-phase by ${(+(phaseF - Math.round(phaseF)) * g).toFixed(4)} on the ${g} lattice` };
  const p0 = Math.round(phaseF);
  const map = new Array(src.count);
  for (let si = 0; si < src.count; si++) {
    const lo = p0 + si * sp, hi = lo + sp;
    const t0 = Math.floor(lo / tp), t1 = Math.floor((hi - 1) / tp);
    const lst = [];
    for (let ti = Math.max(0, t0); ti <= Math.min(tgt.count - 1, t1); ti++) {
      const ov = Math.min(hi, (ti + 1) * tp) - Math.max(lo, ti * tp);
      if (ov > 0) lst.push({ t: ti, w: ov });
    }
    map[si] = lst;
  }
  return { ok: true, g, sp, tp, map, nested: (sp % tp === 0 || tp % sp === 0) };
}

// Are two whole grids (each { x, y, z } of axes) compatible? → { ok, reason,
// axes:[ax,ay,az], nested }. Uses each axis as source vs the other as target
// (symmetric compatibility — direction doesn't change compatibility).
function gridsCompatible(A, B, opts = {}) {
  const axes = [];
  let nested = true;
  for (const k of ['x', 'y', 'z']) {
    const m = axisMap(A[k], B[k], opts);
    if (!m.ok) return { ok: false, reason: `${k.toUpperCase()}: ${m.reason}` };
    axes.push(m); nested = nested && m.nested;
  }
  return { ok: true, axes, nested };
}

// Build a resampler from source axes → target axes. Returns { ok, reason } or a
// resampler with dense target accumulators. Numeric ops: mean (weighted), sum,
// count, coverage. Categorical: majority (weighted vote).
function makeResampler(srcAxes, tgtAxes, opts = {}) {
  const X = axisMap(srcAxes.x, tgtAxes.x, opts);
  const Y = axisMap(srcAxes.y, tgtAxes.y, opts);
  const Z = axisMap(srcAxes.z, tgtAxes.z, opts);
  for (const [k, m] of [['X', X], ['Y', Y], ['Z', Z]]) if (!m.ok) return { ok: false, reason: `${k}: ${m.reason}` };
  const nx = tgtAxes.x.count, ny = tgtAxes.y.count, nz = tgtAxes.z.count;
  const cells = nx * ny * nz;
  const idxOf = (ti, tj, tk) => ti + nx * (tj + ny * tk);
  // full target-cell g-volume, for coverage (= tp_x·tp_y·tp_z)
  const fullW = X.tp * Y.tp * Z.tp;
  const nested = X.nested && Y.nested && Z.nested;
  return {
    ok: true, nx, ny, nz, cells, idxOf, fullW, nested, X, Y, Z,
    newAcc: () => ({ sum: new Float64Array(cells), w: new Float64Array(cells) }),
    // scatter one NUMERIC source cell (si,sj,sk index in the SOURCE lattice)
    scatter(si, sj, sk, v, wt, acc) {
      const xm = X.map[si], ym = Y.map[sj], zm = Z.map[sk];
      if (!xm || !ym || !zm) return;
      for (const { t: ti, w: wi } of xm) for (const { t: tj, w: wj } of ym) for (const { t: tk, w: wk } of zm) {
        const w = wi * wj * wk * wt; if (w <= 0) continue;
        const idx = idxOf(ti, tj, tk); acc.sum[idx] += v * w; acc.w[idx] += w;
      }
    },
    // finalize numeric → { out: Float64Array(cells), coverage: Float32Array, present: Uint8Array }
    finalize(acc, op = 'mean') {
      const out = new Float64Array(cells), coverage = new Float32Array(cells), present = new Uint8Array(cells);
      for (let i = 0; i < cells; i++) {
        const w = acc.w[i]; if (w <= 0) { out[i] = NaN; continue; }
        present[i] = 1; coverage[i] = Math.min(1, w / fullW);
        out[i] = op === 'sum' ? acc.sum[i] : op === 'count' ? acc.w[i] : op === 'coverage' ? coverage[i] : acc.sum[i] / w;   // mean default
      }
      return { out, coverage, present };
    },
    // categorical: separate vote accumulator (Map per touched cell)
    newCatAcc: () => new Map(),                             // idx → Map(code → weight)
    scatterCat(si, sj, sk, code, wt, votes) {
      const xm = X.map[si], ym = Y.map[sj], zm = Z.map[sk];
      if (!xm || !ym || !zm) return;
      for (const { t: ti, w: wi } of xm) for (const { t: tj, w: wj } of ym) for (const { t: tk, w: wk } of zm) {
        const w = wi * wj * wk * wt; if (w <= 0) continue;
        const idx = idxOf(ti, tj, tk);
        let m = votes.get(idx); if (!m) { m = new Map(); votes.set(idx, m); }
        m.set(code, (m.get(code) || 0) + w);
      }
    },
    finalizeCat(votes) {   // → { out: Int32Array(cells) of winning code (-1 empty), tie: Uint8Array }
      const out = new Int32Array(cells).fill(-1), tie = new Uint8Array(cells);
      for (const [idx, m] of votes) {
        let best = -1, bw = -1, tied = false;
        for (const [code, w] of m) { if (w > bw + 1e-9) { best = code; bw = w; tied = false; } else if (Math.abs(w - bw) <= 1e-9) tied = true; }
        out[idx] = best; tie[idx] = tied ? 1 : 0;
      }
      return { out, tie };
    },
  };
}

// A common target lattice covering the union of N grids AND compatible with all.
// grids: [{x,y,z}]. resolution: 'finest' | 'coarsest' | 'gcd' | number(pitch,
// per-axis via {x,y,z}). Returns { ok, reason } or { x, y, z } target axes.
function commonLattice(grids, opts = {}) {
  if (!grids.length) return { ok: false, reason: 'no grids' };
  const res = opts.resolution || 'finest';
  const out = {};
  for (const k of ['x', 'y', 'z']) {
    const ax = grids.map((G) => G[k]);
    const real = ax.filter((a) => a.pitch > 0);            // count-1 with a real pitch still counts
    if (!real.length) { out[k] = { origin: ax[0].origin, pitch: ax[0].pitch || 0, count: 1 }; continue; }
    const tol = REL * Math.max(...real.map((a) => a.pitch), 1);
    // common g across all real axes
    let g = real[0].pitch;
    for (const a of real) g = floatGcd(g, a.pitch, tol);
    if (!(g > tol)) return { ok: false, reason: `${k.toUpperCase()}: grids share no common lattice` };
    // all origins must share the same residue mod g (pairwise phase alignment)
    const low = (a) => a.origin - a.pitch / 2;
    const r0 = ((low(real[0]) % g) + g) % g;
    for (const a of real) {
      const r = ((low(a) % g) + g) % g;
      let d = Math.abs(r - r0); d = Math.min(d, g - d);
      if (d > 1e-4 + tol) return { ok: false, reason: `${k.toUpperCase()}: grids are off-phase (can't share a lattice)` };
    }
    // choose target pitch
    let tp;
    if (res === 'gcd') tp = g;
    else if (res === 'coarsest') tp = Math.max(...real.map((a) => a.pitch));
    else if (typeof res === 'object' && res && res[k] != null) tp = res[k];
    else if (typeof res === 'number') tp = res;
    else tp = Math.min(...real.map((a) => a.pitch));        // 'finest'
    const kk = Math.round(tp / g);
    if (Math.abs(kk * g - tp) > 1e-4 + tol || kk < 1) return { ok: false, reason: `${k.toUpperCase()}: resolution ${tp} is not a multiple of the common lattice ${g}` };
    tp = kk * g;
    // union extent (low faces / high faces)
    const uLo = Math.min(...ax.map((a) => a.origin - (a.pitch || 0) / 2));
    const uHi = Math.max(...ax.map((a) => a.origin + (a.count - 0.5) * (a.pitch || 0)));
    // anchor target low face at the shared residue near uLo
    const L = r0 + Math.floor((uLo - r0) / tp) * tp;
    const count = Math.max(1, Math.ceil((uHi - L) / tp - 1e-6));
    if (count > 65535) return { ok: false, reason: `${k.toUpperCase()}: ${count} cells at pitch ${tp} exceeds the grid limit` };
    out[k] = { origin: L + tp / 2, pitch: tp, count };
  }
  return { ok: true, ...out };
}

// ── src/blockmodel.js ──

// @gcu/condenser — delimited block-model provider (CSV/GSLIB-ish exports).
// Centroid columns (XC/YC/ZC by convention, overridable) + one scalar grade
// channel + one categorical channel. A CSV carries no header bbox, so this
// provider runs an honest TWO-SWEEP recipe (both cold-re-runnable over the
// Blob): sweep 1 (discovery) parses coordinates only → per-axis distinct
// values → regular-grid inference (§2.5); sweep 2 streams full RawChunks.
// Sub-blocked / off-lattice models fail grid inference and should be routed
// to the points pipeline by the caller (header.grid === null).
//
// openBlockModel(blob, { mapping? }) → { header, streamChunks }
//   header = { kind:'blockmodel', count, bbox, grid|null, columns, mapping,
//              categories: string[]|null (code → value, ≤255) }
//   RawChunk = { count, x, y, z: Float64Array, chan: Float64Array,
//                cat: Uint8Array|null, recStart }


const X_RE$blockmodel = /^(x|xc|xcent(er|re)?|xmid|east(ing)?|xworld|centroid_?x)$/i;
const Y_RE$blockmodel = /^(y|yc|ycent(er|re)?|ymid|north(ing)?|yworld|centroid_?y)$/i;
const Z_RE$blockmodel = /^(z|zc|zcent(er|re)?|zmid|elev(ation)?|rl|level|zworld|centroid_?z)$/i;
const DIM_RE = /^(d[xyz]|[xyz]inc|[xyz]size|[xyz]dim|dim_?[xyz])$/i;
const NONGRADE_RE = /^(ijk|id|index|row|i|j|k|dens|density|sg|topo|pct|proportion)$/i;

const WS = 'ws';                                           // whitespace-delimiter sentinel ('\s' in a string is just 's')
const splitter = (delim) => (delim === WS ? (l) => l.trim().split(/\s+/) : (l) => l.split(delim));

// Detect delimiter + header from the first text block.
function sniffDelimited(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, 24);
  if (!lines.length) throw new Error('blockmodel: no data lines');
  let best = null;
  for (const d of [',', ';', '\t', WS]) {
    const split = splitter(d);
    const counts = lines.map((l) => split(l).length);
    const n = counts[0];
    if (n < 2) continue;
    if (counts.every((c) => c === n) && (!best || n > best.n)) best = { delim: d, n };
  }
  if (!best) throw new Error('blockmodel: no consistent delimiter found');
  const first = splitter(best.delim)(lines[0]).map((s) => s.trim());
  const numericish = (s) => s !== '' && !Number.isNaN(Number(s));
  const hasHeader = first.some((s) => !numericish(s));
  return { delim: best.delim, header: hasHeader ? first : null, columns: best.n };
}

// Pick column roles from names. Returns null when centroids can't be identified.
function mapColumns(header) {
  if (!header) return null;
  const find = (re) => header.findIndex((h) => re.test(h.trim()));
  const x = find(X_RE$blockmodel), y = find(Y_RE$blockmodel), z = find(Z_RE$blockmodel);
  if (x < 0 || y < 0 || z < 0) return null;
  const taken = new Set([x, y, z]);
  header.forEach((h, i) => { if (DIM_RE.test(h.trim())) taken.add(i); });
  let chan = -1;
  for (let i = 0; i < header.length; i++) {
    if (!taken.has(i) && !NONGRADE_RE.test(header[i].trim())) { chan = i; break; }
  }
  return { x, y, z, chan: chan >= 0 ? chan : null, cat: null };
}

// Async generator over the blob's data lines (cold recipe — call again for the
// next sweep). Skips blanks + '#'; yields trimmed field arrays in batches so the
// consumer controls pacing. Exported: the filter sweep (a mask by record index)
// re-reads raw rows through the same path.
async function* lineFields(blob, delim, hasHeader, { signal, onProgress } = {}) {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  const split = splitter(delim);
  let carry = '', first = hasHeader, bytesSeen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (done) break;
      bytesSeen += value.length;
      const text = carry + value;
      const lines = text.split('\n');
      carry = lines.pop();
      const batch = [];
      for (let l of lines) {
        if (l.endsWith('\r')) l = l.slice(0, -1);
        if (!l || l[0] === '#') continue;
        if (first) { first = false; continue; }
        batch.push(split(l));
      }
      if (onProgress) onProgress(bytesSeen, blob.size);
      if (batch.length) yield batch;
    }
    if (carry && carry[0] !== '#' && carry.trim() && !first) yield [split(carry)];
  } finally { reader.releaseLock(); }
}

// Byte-tracking sibling of lineFields for the discovery sweep: yields
// { fields, at } batches where at[i] is the ABSOLUTE byte offset of that data
// line's first byte. 0x0A never occurs inside a UTF-8 multi-byte sequence, so
// byte-level line splitting is exact; text still decodes in BULK per chunk
// (per-line decode would be ~50× slower at 50M rows). These offsets feed the
// sparse record index (fetchDelimitedRecord) — the pick join on big CSVs.
async function* lineFieldsWithOffsets(blob, delim, hasHeader, { signal, onProgress } = {}) {
  const reader = blob.stream().getReader();
  const dec = new TextDecoder();
  const split = splitter(delim);
  let carryText = '', carryAt = 0, pos = 0, first = hasHeader, bytesSeen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (done) break;
      bytesSeen += value.length;
      // newline BYTE positions in this chunk (absolute)
      const nl = [];
      for (let j = 0; j < value.length; j++) if (value[j] === 10) nl.push(pos + j);
      const text = carryText + dec.decode(value, { stream: true });
      const lines = text.split('\n');
      const nextCarry = lines.pop();                       // == nl.length complete lines remain
      const fields = [], at = [];
      for (let i = 0; i < lines.length; i++) {
        const start = i === 0 ? carryAt : nl[i - 1] + 1;
        let l = lines[i];
        if (l.endsWith('\r')) l = l.slice(0, -1);
        if (!l || l[0] === '#') continue;
        if (first) { first = false; continue; }
        fields.push(split(l)); at.push(start);
      }
      carryText = nextCarry;
      carryAt = nl.length ? nl[nl.length - 1] + 1 : carryAt;
      pos += value.length;
      if (onProgress) onProgress(bytesSeen, blob.size);
      if (fields.length) yield { fields, at };
    }
    const tail = carryText + dec.decode();                 // flush any held-back multi-byte bytes
    if (tail && tail[0] !== '#' && tail.trim() && !first) yield { fields: [split(tail.endsWith('\r') ? tail.slice(0, -1) : tail)], at: [carryAt] };
  } finally { reader.releaseLock(); }
}

// O(anchors) record fetch: jump to the nearest preceding anchor, walk forward
// applying the SAME accept predicate as the sweeps (blank/# skipped in the
// reader; non-finite coords skipped here — record numbers count accepted rows
// only). Reads ~indexEvery lines instead of the whole file.
async function fetchDelimitedRecord(blob, header, rec) {
  const idx = header.index;
  if (!idx || !idx.offsets.length || rec < 0 || rec >= header.count) return null;
  const a = Math.min(Math.floor(rec / idx.k), idx.offsets.length - 1);
  let remaining = rec - a * idx.k;
  const m = header.mapping;
  const split = splitter(header.delim);
  const reader = blob.slice(idx.offsets[a]).stream().pipeThrough(new TextDecoderStream()).getReader();
  let carry = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const lines = done ? (carry ? [carry] : []) : (carry + value).split('\n');
      if (!done) carry = lines.pop();
      for (let l of lines) {
        if (l.endsWith('\r')) l = l.slice(0, -1);
        if (!l || l[0] === '#') continue;
        const f = split(l);
        const xv = +f[m.x], yv = +f[m.y], zv = +f[m.z];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
        if (remaining === 0) return f;
        remaining--;
      }
      if (done) return null;
    }
  } finally { reader.releaseLock(); }
}

const CAP_DISTINCT = 300000;                               // per-axis discovery cap

// sweep 2 as a shared factory: the same cold-recipe stream whether the header
// came from a live discovery or a cached `discovered` payload (sidecars)
function makeDelimitedStream(blob, delim, hasHeaderRow, map, catCol, catCode) {
  return async function* streamChunks({ chunkPoints = 1 << 18, signal: s2, onProgress: op2 } = {}) {
    const alloc = () => ({ x: new Float64Array(chunkPoints), y: new Float64Array(chunkPoints), z: new Float64Array(chunkPoints), chan: new Float64Array(chunkPoints), cat: catCode ? new Uint8Array(chunkPoints) : null });
    let buf = alloc(), fill = 0, recStart = 0;
    for await (const batch of lineFields(blob, delim, hasHeaderRow, { signal: s2, onProgress: op2 })) {
      for (const f of batch) {
        const xv = +f[map.x], yv = +f[map.y], zv = +f[map.z];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
        buf.x[fill] = xv; buf.y[fill] = yv; buf.z[fill] = zv;
        buf.chan[fill] = map.chan != null ? +f[map.chan] : 0;
        if (buf.cat) { const c = catCode.get((f[catCol] || '').trim()); buf.cat[fill] = c === undefined ? 0 : c; }
        fill++;
        if (fill === chunkPoints) {
          yield { count: fill, x: buf.x, y: buf.y, z: buf.z, chan: buf.chan, cat: buf.cat, recStart };
          recStart += fill; buf = alloc(); fill = 0;
        }
      }
    }
    if (fill) yield { count: fill, x: buf.x.subarray(0, fill), y: buf.y.subarray(0, fill), z: buf.z.subarray(0, fill), chan: buf.chan.subarray(0, fill), cat: buf.cat ? buf.cat.subarray(0, fill) : null, recStart };
  };
}

async function openBlockModel(blob, { mapping = null, discovered = null, sample = 512 * 1024, indexEvery = 1024, signal, onProgress } = {}) {
  // a cached discovery (project sidecars / channel re-streams): skip sweep 1
  // entirely — the header is rebuilt from the payload, sweep 2 streams as usual
  if (discovered) {
    const header = {
      ...discovered,
      bbox: { min: [...discovered.bbox.min], max: [...discovered.bbox.max] },
      index: discovered.index
        ? { k: discovered.index.k, offsets: discovered.index.offsets instanceof Float64Array ? discovered.index.offsets : Float64Array.from(discovered.index.offsets) }
        : undefined,
    };
    const map2 = header.mapping;
    const catCode2 = header.categories ? new Map(header.categories.map((v, i) => [v, i])) : null;
    return { header, streamChunks: makeDelimitedStream(blob, header.delim, header.hasHeaderRow, map2, map2.cat, catCode2) };
  }
  const head = await blob.slice(0, Math.min(sample, blob.size)).text();
  const sniff = sniffDelimited(head);
  // headerless numeric files (XYZ dumps): columns 0/1/2 = x/y/z, a 4th numeric = the
  // scalar channel; names generated so schema/filter/autocomplete still work.
  if (!sniff.header && sniff.columns >= 3) {
    sniff.header = Array.from({ length: sniff.columns }, (_, i) => (i === 0 ? 'X' : i === 1 ? 'Y' : i === 2 ? 'Z' : `V${i + 1}`));
    sniff.generated = true;
    if (!mapping) mapping = { x: 0, y: 1, z: 2, chan: sniff.columns > 3 ? 3 : null, cat: null };
  }
  const map = mapping || mapColumns(sniff.header);
  if (!map) throw new Error('blockmodel: could not identify X/Y/Z centroid columns — pass a mapping');

  // mapColumns picks the channel BY NAME (first leftover column) — a text
  // column (XC,YC,ZC,LITO) would claim it, killing both the channel and the
  // category detection below (which skips map.chan). Demote a non-numeric
  // AUTO pick; an explicit mapping stays the caller's call.
  if (!mapping && map.chan != null && sniff.header) {
    const lines0 = head.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(1, 40);
    const split0 = splitter(sniff.delim);
    const vals0 = lines0.map((l) => (split0(l)[map.chan] || '').trim()).filter(Boolean);
    if (vals0.length && vals0.every((v) => Number.isNaN(Number(v)))) map.chan = null;
  }

  // auto category: first column whose head-sample values are all non-numeric
  let catCol = map.cat;
  if (catCol == null && sniff.header) {
    const lines = head.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(1, 40);
    const split = splitter(sniff.delim);
    for (let i = 0; i < sniff.columns && catCol == null; i++) {
      if (i === map.x || i === map.y || i === map.z || i === map.chan) continue;
      const vals = lines.map((l) => (split(l)[i] || '').trim()).filter(Boolean);
      if (vals.length && vals.every((v) => Number.isNaN(Number(v)))) catCol = i;
    }
  }

  // ── sweep 1: discovery — axis distincts + extents + category dictionary ──
  const ax = [new Set(), new Set(), new Set()];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const catCounts = new Map();
  const round10 = (v) => Number(v.toPrecision(10));
  let count = 0;
  const hasHeaderRow = !!sniff.header && !sniff.generated;
  const anchors = [];                                      // sparse record index: byte offset of every indexEvery-th accepted row
  for await (const { fields, at } of lineFieldsWithOffsets(blob, sniff.delim, hasHeaderRow, { signal, onProgress })) {
    for (let fi = 0; fi < fields.length; fi++) {
      const f = fields[fi];
      const xv = +f[map.x], yv = +f[map.y], zv = +f[map.z];
      if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
      if (count % indexEvery === 0) anchors.push(at[fi]);
      count++;
      if (xv < min[0]) min[0] = xv; if (xv > max[0]) max[0] = xv;
      if (yv < min[1]) min[1] = yv; if (yv > max[1]) max[1] = yv;
      if (zv < min[2]) min[2] = zv; if (zv > max[2]) max[2] = zv;
      if (ax[0].size < CAP_DISTINCT) ax[0].add(round10(xv));
      if (ax[1].size < CAP_DISTINCT) ax[1].add(round10(yv));
      if (ax[2].size < CAP_DISTINCT) ax[2].add(round10(zv));
      if (catCol != null && catCounts.size <= 256) { const v = (f[catCol] || '').trim(); if (v) catCounts.set(v, (catCounts.get(v) || 0) + 1); }
    }
  }

  const axes = ax.map((s) => (s.size < CAP_DISTINCT ? inferAxis([...s].sort((a, b) => a - b)) : null));
  const grid = axes.every(Boolean) ? { x: axes[0], y: axes[1], z: axes[2] } : null;
  const categories = catCol != null && catCounts.size > 0 && catCounts.size <= 255
    ? [...catCounts.keys()].sort() : null;
  const catCode = categories ? new Map(categories.map((v, i) => [v, i])) : null;

  // every plausible scalar column (numeric in the head sample, not a coord/dim) —
  // the UI offers these as color channels; switching re-runs sweep 2 only.
  const numericColumns = [];
  if (sniff.header) {
    const lines2 = head.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(1, 40);
    const split2 = splitter(sniff.delim);
    for (let i = 0; i < sniff.columns; i++) {
      if (i === map.x || i === map.y || i === map.z || DIM_RE.test(sniff.header[i].trim())) continue;
      const vals = lines2.map((l) => (split2(l)[i] || '').trim()).filter(Boolean);
      if (vals.length && vals.every((v) => !Number.isNaN(Number(v)))) numericColumns.push({ i, name: sniff.header[i] });
    }
  }
  const header = {
    kind: 'blockmodel', count,
    bbox: { min, max },
    grid,                                                   // null → not a regular grid (points fallback)
    columns: sniff.header, mapping: { ...map, cat: categories ? catCol : null },
    delim: sniff.delim, hasHeaderRow,                       // for external sweeps (the filter mask)
    index: { k: indexEvery, offsets: Float64Array.from(anchors) },   // sparse line-offset index (fetchDelimitedRecord)
    numericColumns,
    categories,
    attributes: [
      ...(map.chan != null && sniff.header ? [sniff.header[map.chan]] : []),
      ...(categories && sniff.header ? [sniff.header[catCol]] : []),
    ],
  };

  // ── sweep 2 (cold recipe): the shared stream factory ──
  const streamChunks = makeDelimitedStream(blob, sniff.delim, hasHeaderRow, map, catCol, catCode);

  return { header, streamChunks };
}

// ── ../drillhole/src/desurvey.js ──

// @gcu/drillhole — desurvey: collar + survey stations → the 3D hole trace, and a
// method-consistent position at any down-hole depth.
//
// Conventions (D1): azimuth = degrees clockwise from north; dip = MINING convention,
// positive DOWN (normalizeSurveys flips neg-down files; detectDipConvention infers
// from the median); depths/lengths in any consistent unit (metres in practice).
// World frame: x = east, y = north, z = up.
//
// Reverse-vendored from BMA (A7 Phase 0, Arthur 2026-06-11) — developed there in the
// concat-source style, always intended to live here. BMA + dee re-vendor from here now.

// Unit tangent from azimuth/dip (mining pos-down): x east, y north, z up.
function dhTangent(azDeg, dipDeg) {
  let az = azDeg * Math.PI / 180, dip = dipDeg * Math.PI / 180;
  let c = Math.cos(dip);
  return [Math.sin(az) * c, Math.cos(az) * c, -Math.sin(dip)];
}

// 'pos-down' (mining: +60 = 60° below horizontal) vs 'neg-down' (signed math: -60 =
// below). Inferred from the median dip — exploration holes point down, so the sign of
// the bulk tells the convention.
function dhDetectDipConvention(surveys) {
  let dips = [];
  for (let i = 0; i < surveys.length; i++) {
    let d = surveys[i].dip;
    if (typeof d === 'number' && isFinite(d) && d !== 0) dips.push(d);
  }
  if (dips.length === 0) return 'pos-down';
  dips.sort(function(a, b) { return a - b; });
  let med = dips[Math.floor(dips.length / 2)];
  return med < 0 ? 'neg-down' : 'pos-down';
}

// Sort, dedupe (last wins), normalize dip to pos-down, synthesize a station at depth 0
// when the list starts deeper (copies the first attitude). Returns { stations:
// [{depth, az, dip}], dupCount, badCount }.
function dhNormalizeSurveys(rawSurveys, dipConvention) {
  let flip = dipConvention === 'neg-down' ? -1 : 1;
  let clean = [], badCount = 0;
  for (let i = 0; i < rawSurveys.length; i++) {
    let s = rawSurveys[i];
    let depth = s.depth, az = s.az, dip = s.dip * flip;
    if (!isFinite(depth) || depth < 0 || !isFinite(az) || !isFinite(dip) || Math.abs(dip) > 90.000001) {
      badCount++;
      continue;
    }
    clean.push({ depth: depth, az: az, dip: dip });
  }
  clean.sort(function(a, b) { return a.depth - b.depth; });
  let stations = [], dupCount = 0;
  for (let j = 0; j < clean.length; j++) {
    if (stations.length && Math.abs(stations[stations.length - 1].depth - clean[j].depth) < 1e-9) {
      stations[stations.length - 1] = clean[j]; // last wins
      dupCount++;
    } else {
      stations.push(clean[j]);
    }
  }
  if (stations.length && stations[0].depth > 1e-9) {
    stations.unshift({ depth: 0, az: stations[0].az, dip: stations[0].dip });
  }
  return { stations: stations, dupCount: dupCount, badCount: badCount };
}

// Desurvey one hole. Methods:
// - 'minimumCurvature' (default): circular-arc model, RF = (2/θ)·tan(θ/2)
// - 'balancedTangential': the same without RF — averages the two end tangents per
//   segment (matches legacy desurveys from several packages)
// - 'tangential': straight segments along the LOWER station's attitude (sparse/legacy
//   surveys; matches dee's simple-tangential seed)
// collar = [x, y, z]; stations from dhNormalizeSurveys (pos-down). Returns { method,
// depths, px, py, pz, tx, ty, tz, dogleg, dls } — tangents + method ride along so
// dhPositionAt interpolates consistently. `dogleg[k]` is the angular change (degrees)
// between stations k−1 and k; `dls[k]` is the dogleg SEVERITY in °/30 length-units (the
// metric drilling-QC convention — multiply by ⅓ for °/10 m, or recompute from `dogleg`
// for °/100 ft). Both are geometry of the survey attitudes — independent of `method` —
// so they're the same whichever desurvey you pick. dogleg[0] = dls[0] = 0.
function dhDesurveyHole(collar, stations, method) {
  method = method || 'minimumCurvature';
  let n = stations.length;
  let out = {
    method: method,
    depths: new Float64Array(n),
    px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n),
    tx: new Float64Array(n), ty: new Float64Array(n), tz: new Float64Array(n),
    dogleg: new Float64Array(n), dls: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    out.depths[i] = stations[i].depth;
    let t = dhTangent(stations[i].az, stations[i].dip);
    out.tx[i] = t[0]; out.ty[i] = t[1]; out.tz[i] = t[2];
  }
  out.px[0] = collar[0]; out.py[0] = collar[1]; out.pz[0] = collar[2];

  for (let k = 1; k < n; k++) {
    let dl = out.depths[k] - out.depths[k - 1];
    // dogleg angle between the two station tangents — drives both the min-curvature RF
    // and the QC severity, and is the same for every method (it's the survey geometry).
    let dot = out.tx[k - 1] * out.tx[k] + out.ty[k - 1] * out.ty[k] + out.tz[k - 1] * out.tz[k];
    let doglegRad = Math.acos(Math.max(-1, Math.min(1, dot)));
    out.dogleg[k] = doglegRad * 180 / Math.PI;
    out.dls[k] = dl > 1e-12 ? out.dogleg[k] / dl * 30 : 0;
    if (method === 'tangential') {
      out.px[k] = out.px[k - 1] + dl * out.tx[k];
      out.py[k] = out.py[k - 1] + dl * out.ty[k];
      out.pz[k] = out.pz[k - 1] + dl * out.tz[k];
    } else {
      let rf = 1; // balanced tangential
      // minimum curvature: RF = (2/θ)·tan(θ/2)
      if (method !== 'balancedTangential') rf = doglegRad > 1e-6 ? (2 / doglegRad) * Math.tan(doglegRad / 2) : 1;
      out.px[k] = out.px[k - 1] + 0.5 * dl * (out.tx[k - 1] + out.tx[k]) * rf;
      out.py[k] = out.py[k - 1] + 0.5 * dl * (out.ty[k - 1] + out.ty[k]) * rf;
      out.pz[k] = out.pz[k - 1] + 0.5 * dl * (out.tz[k - 1] + out.tz[k]) * rf;
    }
  }
  return out;
}

// Position at an arbitrary down-hole depth, consistent with the hole's desurvey method
// (depths between stations land on the SAME path the stations were placed on):
// - minimumCurvature: arc-correct (D2) — the closed-form integral of the slerp of the
//   end tangents: p(s) = p1 + L/(θ·sinθ)·[(cos(θ−φ) − cosθ)·d1 + (1 − cosφ)·d2],
//   φ = θ·s/L (at s = L this reduces to the RF endpoint formula; the harness pins
//   mid-segment points to an analytic circle at 1e-14)
// - tangential: straight along the lower station's attitude (how the segment was built)
// - balancedTangential: linear along the segment chord
// Beyond the last station: straight extrapolation along the last tangent (standard
// practice — intervals routinely outrun the survey).
function dhPositionAt(hole, depth) {
  let d = hole.depths, n = d.length;
  if (n === 0) return null;
  if (depth <= d[0]) {
    let s0 = depth - d[0]; // above collar station (negative) — straight
    return [hole.px[0] + s0 * hole.tx[0], hole.py[0] + s0 * hole.ty[0], hole.pz[0] + s0 * hole.tz[0]];
  }
  if (depth >= d[n - 1]) {
    let sE = depth - d[n - 1];
    return [hole.px[n - 1] + sE * hole.tx[n - 1], hole.py[n - 1] + sE * hole.ty[n - 1], hole.pz[n - 1] + sE * hole.tz[n - 1]];
  }
  // binary search: segment [lo, lo+1] with d[lo] <= depth < d[lo+1]
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    let mid = (lo + hi) >> 1;
    if (d[mid] <= depth) lo = mid; else hi = mid;
  }
  let L = d[lo + 1] - d[lo], s = depth - d[lo];
  if (L < 1e-12) return [hole.px[lo], hole.py[lo], hole.pz[lo]];

  if (hole.method === 'tangential') {
    return [
      hole.px[lo] + s * hole.tx[lo + 1],
      hole.py[lo] + s * hole.ty[lo + 1],
      hole.pz[lo] + s * hole.tz[lo + 1],
    ];
  }
  if (hole.method === 'balancedTangential') {
    let t = s / L;
    return [
      hole.px[lo] + t * (hole.px[lo + 1] - hole.px[lo]),
      hole.py[lo] + t * (hole.py[lo + 1] - hole.py[lo]),
      hole.pz[lo] + t * (hole.pz[lo + 1] - hole.pz[lo]),
    ];
  }

  let d1 = [hole.tx[lo], hole.ty[lo], hole.tz[lo]];
  let d2 = [hole.tx[lo + 1], hole.ty[lo + 1], hole.tz[lo + 1]];
  let dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
  let theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (theta < 1e-9) {
    return [hole.px[lo] + s * d1[0], hole.py[lo] + s * d1[1], hole.pz[lo] + s * d1[2]];
  }
  let phi = theta * s / L;
  let kk = L / (theta * Math.sin(theta));
  let a = (Math.cos(theta - phi) - Math.cos(theta)) * kk;
  let b = (1 - Math.cos(phi)) * kk;
  return [
    hole.px[lo] + a * d1[0] + b * d2[0],
    hole.py[lo] + a * d1[1] + b * d2[1],
    hole.pz[lo] + a * d1[2] + b * d2[2],
  ];
}

// ── ../drillhole/src/validate.js ──

// @gcu/drillhole — validate: join + check the three tables. Nothing is silently
// dropped; every exclusion lands in the report with a count and a BHID list.
//
// The collar+survey join (dhJoinHoles) and per-hole station normalization
// (dhNormalizeHoleStations) are factored out so the point-sample locator
// (dhDesurveySamples) reuses the exact same hole-building — one join, two consumers.


// Build the per-hole structure from collars + surveys (NOT normalized yet — callers
// normalize only the holes that pass their own gate, so a skipped hole doesn't accrue
// advisory counts). Returns { holes: bhid→{bhid,collar,eoh,rawSurveys}, order: [] }.
function dhJoinHoles(tables, dipConvention, hit) {
  let holes = {}, order = [];
  for (let ci = 0; ci < (tables.collars || []).length; ci++) {
    let c0 = tables.collars[ci];
    let bid = String(c0.bhid).trim();
    if (!bid) { hit('bad-collar', 'Collar rows with missing BHID or non-numeric coordinates', null); continue; }
    if (!isFinite(c0.x) || !isFinite(c0.y) || !isFinite(c0.z)) {
      hit('bad-collar', 'Collar rows with missing BHID or non-numeric coordinates', bid);
      continue;
    }
    if (holes[bid]) { hit('dup-collar', 'Duplicate collar BHIDs (first kept)', bid); continue; }
    holes[bid] = { bhid: bid, collar: [c0.x, c0.y, c0.z], eoh: isFinite(c0.eoh) ? c0.eoh : null, rawSurveys: [] };
    order.push(bid);
  }
  for (let si = 0; si < (tables.surveys || []).length; si++) {
    let s0 = tables.surveys[si];
    let sb = String(s0.bhid).trim();
    let h = holes[sb];
    if (!h) { hit('orphan-survey', 'Survey rows whose BHID has no collar (excluded)', sb); continue; }
    h.rawSurveys.push({ depth: s0.depth, az: s0.az, dip: s0.dip });
  }
  return { holes: holes, order: order };
}

// Normalize one hole's raw surveys → hole.stations (pos-down, sorted, deduped, depth-0
// synthesized), with the no-usable-survey straight-down fallback and the survey-side
// past-EOH advisory. Counts ride into `hit`. Mutates + returns the hole.
function dhNormalizeHoleStations(hole, dipConvention, hit) {
  let norm = dhNormalizeSurveys(hole.rawSurveys, dipConvention);
  if (norm.badCount) for (let bi = 0; bi < norm.badCount; bi++) hit('bad-survey', 'Survey rows with non-numeric depth/azimuth or |dip| > 90 (excluded)', hole.bhid);
  if (norm.dupCount) for (let di = 0; di < norm.dupCount; di++) hit('dup-survey-depth', 'Duplicate survey depths in a hole (last kept)', hole.bhid);
  if (norm.stations.length === 0) {
    hit('collar-no-survey', 'Holes with no usable survey (desurveyed straight down)', hole.bhid);
    norm.stations = [{ depth: 0, az: 0, dip: 90 }];
  }
  hole.stations = norm.stations;
  if (hole.eoh != null && norm.stations[norm.stations.length - 1].depth > hole.eoh + 1e-9) {
    hit('past-eoh', 'Survey or interval depths past the collar EOH (kept — EOH is advisory)', hole.bhid);
  }
  return hole;
}

// tables = {
//   collars:  [{ bhid, x, y, z, eoh }],            // eoh optional/null
//   surveys:  [{ bhid, depth, az, dip }],          // dip raw (per file)
//   intervals: { bhid: [], from: [], to: [],
//                cols: [{ name, type: 'num'|'cat', values: [] }] }
// }
// opts = { dipConvention: 'auto'|'pos-down'|'neg-down', method }
function dhValidate(tables, opts) {
  opts = opts || {};
  let checks = {};
  function hit(id, label, bhid) {
    let c = checks[id];
    if (!c) { c = checks[id] = { id: id, label: label, count: 0, bhids: [] }; }
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }

  let dipConvention = opts.dipConvention || 'auto';
  if (dipConvention === 'auto') dipConvention = dhDetectDipConvention(tables.surveys || []);

  let joined = dhJoinHoles(tables, dipConvention, hit);
  let holes = joined.holes, order = joined.order;
  for (let oi = 0; oi < order.length; oi++) holes[order[oi]].iv = [];

  // intervals
  let iv = tables.intervals || { bhid: [], from: [], to: [], cols: [] };
  let nIv = iv.bhid.length;
  for (let ii = 0; ii < nIv; ii++) {
    let ib = String(iv.bhid[ii]).trim();
    let h2 = holes[ib];
    if (!h2) { hit('orphan-interval', 'Interval rows whose BHID has no collar (excluded)', ib); continue; }
    let f = iv.from[ii], t = iv.to[ii];
    if (!isFinite(f) || !isFinite(t) || f < 0 || t <= f) {
      hit('bad-interval', 'Interval rows with FROM ≥ TO, negative or non-numeric depths (excluded)', ib);
      continue;
    }
    h2.iv.push(ii);
  }

  // per-hole structure (normalize only the holes that have intervals)
  let ready = [];
  for (let oi = 0; oi < order.length; oi++) {
    let hh = holes[order[oi]];
    if (hh.iv.length === 0) { hit('collar-no-intervals', 'Collars with no interval rows (hole skipped)', hh.bhid); continue; }

    dhNormalizeHoleStations(hh, dipConvention, hit);

    // interval-side past-EOH advisory (kept, counted)
    if (hh.eoh != null) {
      for (let ei = 0; ei < hh.iv.length; ei++) {
        if (iv.to[hh.iv[ei]] > hh.eoh + 1e-9) {
          hit('past-eoh', 'Survey or interval depths past the collar EOH (kept — EOH is advisory)', hh.bhid);
          break;
        }
      }
    }

    // overlap flag (composited as-is; SUPPORT double-counts — flagged per hole)
    let idx = hh.iv.slice().sort(function(a, b) { return iv.from[a] - iv.from[b]; });
    for (let vi = 1; vi < idx.length; vi++) {
      if (iv.from[idx[vi]] < iv.to[idx[vi - 1]] - 1e-9) {
        hit('overlap', 'Holes with overlapping intervals (composited as-is; SUPPORT double-counts)', hh.bhid);
        break;
      }
    }
    hh.iv = idx;
    ready.push(hh);
  }

  return { holes: ready, checks: checks, dipConvention: dipConvention, intervals: iv };
}

// ── ../drillhole/src/samples.js ──

// @gcu/drillhole — point-sample locator. Some data is point-support, not intervals:
// single-depth assays (handheld XRF, density readings) or already-composited samples
// re-imported. Compositing (length-weighting into windows) doesn't apply — you just
// want each sample placed in 3D on the desurveyed trace. This is that path; it reuses
// the same collar+survey join + station normalization as dhValidate.


// tables = { collars, surveys, samples: { bhid:[], depth:[], cols:[{name,type,values}] } }
// opts   = { dipConvention, method }
// Returns { header: ['BHID','X','Y','Z','DEPTH', ...cols], rows, report } — one located
// row per valid sample (sorted down-hole within each hole), with the same non-silent
// consistency report style as the interval pipeline.
function dhDesurveySamples(tables, opts) {
  opts = opts || {};
  let checks = {};
  function hit(id, label, bhid) {
    let c = checks[id];
    if (!c) { c = checks[id] = { id: id, label: label, count: 0, bhids: [] }; }
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }

  let dipConvention = opts.dipConvention || 'auto';
  if (dipConvention === 'auto') dipConvention = dhDetectDipConvention(tables.surveys || []);

  let joined = dhJoinHoles(tables, dipConvention, hit);
  let holes = joined.holes, order = joined.order;
  for (let oi = 0; oi < order.length; oi++) holes[order[oi]].smp = [];

  // samples → per-hole index lists
  let smp = tables.samples || { bhid: [], depth: [], cols: [] };
  let cols = smp.cols || [];
  let nS = smp.bhid.length;
  for (let ii = 0; ii < nS; ii++) {
    let bid = String(smp.bhid[ii]).trim();
    let h = holes[bid];
    if (!h) { hit('orphan-sample', 'Sample rows whose BHID has no collar (excluded)', bid); continue; }
    let d = smp.depth[ii];
    if (!isFinite(d) || d < 0) { hit('bad-sample', 'Sample rows with negative or non-numeric depth (excluded)', bid); continue; }
    h.smp.push(ii);
  }

  let header = ['BHID', 'X', 'Y', 'Z', 'DEPTH'];
  for (let hc = 0; hc < cols.length; hc++) header.push(cols[hc].name);
  let rows = [];
  let nHoles = 0;

  for (let oi = 0; oi < order.length; oi++) {
    let hh = holes[order[oi]];
    if (hh.smp.length === 0) { hit('collar-no-samples', 'Collars with no sample rows (hole skipped)', hh.bhid); continue; }
    dhNormalizeHoleStations(hh, dipConvention, hit);
    let path = dhDesurveyHole(hh.collar, hh.stations, opts.method);
    nHoles++;

    // EOH advisory (kept, counted)
    if (hh.eoh != null) {
      for (let ei = 0; ei < hh.smp.length; ei++) {
        if (smp.depth[hh.smp[ei]] > hh.eoh + 1e-9) {
          hit('past-eoh', 'Sample depths past the collar EOH (kept — EOH is advisory)', hh.bhid);
          break;
        }
      }
    }

    let idx = hh.smp.slice().sort(function(a, b) { return smp.depth[a] - smp.depth[b]; });
    for (let k = 0; k < idx.length; k++) {
      let ii = idx[k], d = smp.depth[ii];
      let pos = dhPositionAt(path, d);
      let row = [hh.bhid, pos[0], pos[1], pos[2], d];
      for (let c = 0; c < cols.length; c++) row.push(cols[c].values[ii]);
      rows.push(row);
    }
  }

  let checkList = [];
  for (let k in checks) checkList.push(checks[k]);
  return { header: header, rows: rows, report: { checks: checkList, nHoles: nHoles, nSamples: rows.length, dipConvention: dipConvention } };
}

// ── src/drillholes.js ──

// @gcu/condenser — drillhole provider: collar + survey + interval tables →
// desurveyed interval midpoints as an element layer (micro-layers spec §5).
// The math is @gcu/drillhole's (minimum curvature / balanced tangential /
// tangential, dip-convention detection, the non-silent consistency report);
// this module is table intake + the identity plumbing.
//
// THE IDENTITY: record N == interval-table row N. desurveySamples returns
// rows depth-sorted per hole, so a hidden __row column threads the original
// row index through — recIdx survives the sort, and pick/measure/filter all
// join back to the source assay row.
//
// Tables are read FULLY into memory (drillhole files are 10³–10⁶ rows — the
// streaming machinery is for the 10⁸ element tables), which also makes
// fetchRecord O(1) and channel switches free.


const BHID_RE = /^(bhid|holeid|hole_?id|dhid|dh_?id|hole|collar_?id|id)$/i;
const X_RE$drillholes = /^(x|xc|xcollar|east(ing)?|utm_?e)$/i;
const Y_RE$drillholes = /^(y|yc|ycollar|north(ing)?|utm_?n)$/i;
const Z_RE$drillholes = /^(z|zc|zcollar|elev(ation)?|rl)$/i;
const AT_RE = /^(at|depth|dist(ance)?|md|measured_?depth)$/i;
const AZ_RE = /^(az|azm|azim(uth)?|brg|bearing)$/i;
const DIP_RE = /^(dip|incl(ination)?|plunge)$/i;
const FROM_RE = /^(from|depfrom|depth_?from|de)$/i;
const TO_RE = /^(to|depto|depth_?to|a)$/i;
const EOH_RE = /^(eoh|depth|maxdepth|max_?depth|td|total_?depth|length)$/i;

const find = (header, re) => header.findIndex((h) => re.test(String(h).trim()));

// Classify one delimited header as collar / survey / intervals (or null).
// Survey and intervals are keyed on their unambiguous columns (AZ+DIP / FROM+TO);
// collar is BHID + coordinates. Returns { role, mapping }.
function classifyDrillholeHeader(header) {
  if (!header) return null;
  const bhid = find(header, BHID_RE);
  if (bhid < 0) return null;
  const from = find(header, FROM_RE), to = find(header, TO_RE);
  if (from >= 0 && to >= 0) return { role: 'intervals', mapping: { bhid, from, to } };
  const az = find(header, AZ_RE), dip = find(header, DIP_RE), at = find(header, AT_RE);
  if (az >= 0 && dip >= 0) return { role: 'survey', mapping: { bhid, at: at >= 0 ? at : -1, az, dip } };
  const x = find(header, X_RE$drillholes), y = find(header, Y_RE$drillholes), z = find(header, Z_RE$drillholes);
  if (x >= 0 && y >= 0 && z >= 0) {
    let eoh = -1;
    header.forEach((h, i) => { if (eoh < 0 && i !== x && i !== y && i !== z && EOH_RE.test(String(h).trim())) eoh = i; });
    return { role: 'collar', mapping: { bhid, x, y, z, eoh } };
  }
  return null;
}

// Read a delimited blob fully: { columns, rows } (field arrays, header skipped).
async function readDelimited(blob, { sample = 256 * 1024 } = {}) {
  const head = await blob.slice(0, Math.min(sample, blob.size)).text();
  const sniff = sniffDelimited(head);
  if (!sniff.header) throw new Error('drillholes: table has no header row');
  const rows = [];
  for await (const batch of lineFields(blob, sniff.delim, true)) {
    for (const f of batch) rows.push(f);
  }
  return { columns: sniff.header.map((c) => String(c).trim()), rows };
}

// Sniff a set of blobs into drillhole roles. Returns { collar, survey,
// intervals } of { blob, name, columns, mapping } when all three distinct
// roles are present, else null.
async function sniffDrillholeFiles(files) {
  const out = {};
  for (const f of files) {
    let sniff;
    try { sniff = sniffDelimited(await f.slice(0, 64 * 1024).text()); } catch { continue; }
    const cls = classifyDrillholeHeader(sniff.header);
    if (cls && !out[cls.role]) out[cls.role] = { blob: f, name: f.name || cls.role, columns: sniff.header.map((c) => String(c).trim()), mapping: cls.mapping };
  }
  return out.collar && out.survey && out.intervals ? out : null;
}

/**
 * openDrillholes({ collar, survey, intervals }, opts) — each input is a Blob.
 * opts: mappings { collar: {bhid,x,y,z,eoh}, survey: {bhid,at,az,dip},
 * intervals: {bhid,from,to} } (sniffed when omitted), method
 * ('minimumCurvature' | 'balancedTangential' | 'tangential'), dipConvention
 * ('auto' | 'pos-down' | 'neg-down'), chan (interval column index for the
 * grade channel; default = first numeric non-key column), cat (category
 * column index; default = first all-text non-key column).
 *
 * → { header, streamChunks, fetchRecord }
 *   header = { kind:'drillholes', count (ORIGINAL interval rows), bbox,
 *              columns, mapping {chan, cat}, numericColumns, categories,
 *              attributes, report, method, dipConvention, holes }
 *   RawChunk = { count, x, y, z, chan, cat, recIdx } (blockmodel shape —
 *              the page's centroids-as-points path renders it)
 *   fetchRecord(rec) → the ORIGINAL interval row (O(1), in memory)
 */
async function openDrillholes({ collar, survey, intervals }, opts = {}) {
  const tCollar = await readDelimited(collar);
  const tSurvey = await readDelimited(survey);
  const tIv = await readDelimited(intervals);
  const m = {
    collar: (opts.mappings && opts.mappings.collar) || (classifyDrillholeHeader(tCollar.columns) || {}).mapping,
    survey: (opts.mappings && opts.mappings.survey) || (classifyDrillholeHeader(tSurvey.columns) || {}).mapping,
    intervals: (opts.mappings && opts.mappings.intervals) || (classifyDrillholeHeader(tIv.columns) || {}).mapping,
  };
  if (!m.collar || m.collar.x == null) throw new Error('drillholes: collar columns not identified (need BHID + X/Y/Z)');
  if (!m.survey || m.survey.az == null) throw new Error('drillholes: survey columns not identified (need BHID + AZ + DIP)');
  if (!m.intervals || m.intervals.from == null) throw new Error('drillholes: interval columns not identified (need BHID + FROM + TO)');

  // @gcu/drillhole table shapes
  const collars = tCollar.rows.map((r) => ({
    bhid: r[m.collar.bhid], x: +r[m.collar.x], y: +r[m.collar.y], z: +r[m.collar.z],
    eoh: m.collar.eoh >= 0 ? +r[m.collar.eoh] : undefined,
  }));
  const surveys = tSurvey.rows.map((r) => ({
    bhid: r[m.survey.bhid], depth: m.survey.at >= 0 ? +r[m.survey.at] : 0, az: +r[m.survey.az], dip: +r[m.survey.dip],
  }));

  const n = tIv.rows.length;
  const keyCols = new Set([m.intervals.bhid, m.intervals.from, m.intervals.to]);
  // numeric / categorical detection over a head sample of the interval table
  const probe = tIv.rows.slice(0, 200);
  const numericCols = [], textCols = [];
  tIv.columns.forEach((name, i) => {
    if (keyCols.has(i)) return;
    const vals = probe.map((r) => (r[i] || '').trim()).filter(Boolean);
    if (!vals.length) return;
    if (vals.every((v) => !Number.isNaN(Number(v)))) numericCols.push({ i, name });
    else if (vals.every((v) => Number.isNaN(Number(v)))) textCols.push({ i, name });
  });
  const chan = opts.chan != null ? opts.chan : (numericCols[0] ? numericCols[0].i : null);
  const catCol = opts.cat != null ? opts.cat : (textCols[0] ? textCols[0].i : null);

  // samples = BOTH interval endpoints (2 per row): the desurveyed FROM and TO
  // positions are the capsule segment, arc-correct via positionAt; the render
  // midpoint derives as (A+B)/2. __row + __end thread the source row and
  // which endpoint through the per-hole depth sort (the identity).
  const bhid = new Array(2 * n), depth = new Float64Array(2 * n);
  const rowIdx = new Float64Array(2 * n), endIdx = new Float64Array(2 * n);
  const chanVals = new Float64Array(n), catVals = catCol != null ? new Array(n) : null;
  const catCounts = new Map();
  for (let i = 0; i < n; i++) {
    const r = tIv.rows[i];
    const hb = r[m.intervals.bhid];
    bhid[2 * i] = hb; bhid[2 * i + 1] = hb;
    depth[2 * i] = +r[m.intervals.from]; depth[2 * i + 1] = +r[m.intervals.to];
    rowIdx[2 * i] = i; rowIdx[2 * i + 1] = i;
    endIdx[2 * i] = 0; endIdx[2 * i + 1] = 1;
    chanVals[i] = chan != null ? +r[chan] : 0;
    if (catVals) { const v = (r[catCol] || '').trim(); catVals[i] = v; if (v && catCounts.size <= 256) catCounts.set(v, (catCounts.get(v) || 0) + 1); }
  }
  const samples = { bhid, depth, cols: [{ name: '__row', values: rowIdx }, { name: '__end', values: endIdx }] };

  const ds = dhDesurveySamples({ collars, surveys, samples }, { method: opts.method || 'minimumCurvature', dipConvention: opts.dipConvention || 'auto' });

  // the interval-shape checks (overlaps, inverted from/to…) come from validate
  const iv = {
    bhid, from: tIv.rows.map((r) => +r[m.intervals.from]), to: tIv.rows.map((r) => +r[m.intervals.to]), cols: [],
  };
  let report = ds.report;
  try {
    const v = dhValidate({ collars, surveys, intervals: iv }, { dipConvention: opts.dipConvention || 'auto' });
    const seen = new Set(report.checks.map((c) => c.id));
    const extra = Object.values(v.checks || {}).filter((c) => !seen.has(c.id));
    report = { ...report, checks: report.checks.concat(extra) };
  } catch { /* validate's report is a bonus, not a gate */ }

  const categories = catCounts.size > 0 && catCounts.size <= 255 ? [...catCounts.keys()].sort() : null;
  const catCode = categories ? new Map(categories.map((v, i) => [v, i])) : null;

  // pair the placed endpoints back into SEGMENTS keyed by source row
  const endA = new Map(), endB = new Map();               // src row → [x,y,z]
  for (let k = 0; k < ds.rows.length; k++) {
    const row = ds.rows[k];
    const src = row[5] | 0, end = row[6] | 0;             // __row, __end
    (end === 0 ? endA : endB).set(src, [row[1], row[2], row[3]]);
  }
  const placedRows = [];
  for (const [src, a] of endA) if (endB.has(src)) placedRows.push(src);
  placedRows.sort((x, y) => x - y);
  const nP = placedRows.length;
  const ax = new Float64Array(nP), ay = new Float64Array(nP), az = new Float64Array(nP);
  const bx = new Float64Array(nP), by = new Float64Array(nP), bz = new Float64Array(nP);
  const px = new Float64Array(nP), py = new Float64Array(nP), pz = new Float64Array(nP);
  const pChan = new Float64Array(nP), pCat = catCode ? new Uint8Array(nP) : null;
  const pRec = new Uint32Array(nP);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < nP; k++) {
    const src = placedRows[k];
    const A = endA.get(src), B = endB.get(src);
    ax[k] = A[0]; ay[k] = A[1]; az[k] = A[2];
    bx[k] = B[0]; by[k] = B[1]; bz[k] = B[2];
    px[k] = (A[0] + B[0]) / 2; py[k] = (A[1] + B[1]) / 2; pz[k] = (A[2] + B[2]) / 2;
    pChan[k] = Number.isFinite(chanVals[src]) ? chanVals[src] : 0;
    if (pCat) { const c = catCode.get(catVals[src]); pCat[k] = c === undefined ? 0 : c; }
    pRec[k] = src;
    for (let a2 = 0; a2 < 3; a2++) {
      if (A[a2] < min[a2]) min[a2] = A[a2]; if (A[a2] > max[a2]) max[a2] = A[a2];
      if (B[a2] < min[a2]) min[a2] = B[a2]; if (B[a2] > max[a2]) max[a2] = B[a2];
    }
  }

  let cLo = Infinity, cHi = -Infinity;
  for (let k = 0; k < nP; k++) { const v = pChan[k]; if (v < cLo) cLo = v; if (v > cHi) cHi = v; }
  const header = {
    kind: 'drillholes', count: n,
    bbox: { min, max },
    chanRange: [cLo === Infinity ? 0 : cLo, cHi === -Infinity ? 1 : cHi],
    columns: tIv.columns,
    mapping: { x: -1, y: -1, z: -1, chan, cat: categories ? catCol : null },
    intervalMapping: m.intervals,                          // resolved bhid/from/to (role badges + joins)
    numericColumns: numericCols,
    categories,
    attributes: [
      ...(chan != null ? [tIv.columns[chan]] : []),
      ...(categories ? [tIv.columns[catCol]] : []),
    ],
    report, method: opts.method || 'minimumCurvature', dipConvention: report.dipConvention,
    holes: report.nHoles, placed: nP,
  };

  async function* streamChunks({ chunkPoints = 1 << 18 } = {}) {
    for (let at = 0; at < nP; at += chunkPoints) {
      const k = Math.min(chunkPoints, nP - at);
      yield {
        count: k,
        // midpoints (points mode / section center / measure)
        x: px.subarray(at, at + k), y: py.subarray(at, at + k), z: pz.subarray(at, at + k),
        // segment endpoints (sticks mode)
        ax: ax.subarray(at, at + k), ay: ay.subarray(at, at + k), az: az.subarray(at, at + k),
        bx: bx.subarray(at, at + k), by: by.subarray(at, at + k), bz: bz.subarray(at, at + k),
        chan: pChan.subarray(at, at + k), cat: pCat ? pCat.subarray(at, at + k) : null,
        recIdx: pRec.subarray(at, at + k),
      };
    }
  }

  const fetchRecord = (rec) => (rec >= 0 && rec < n ? tIv.rows[rec] : null);
  // the placed midpoint of a source row (measure across layers) — null for
  // rows that never placed (orphans)
  const recToPlaced = new Map();
  for (let k = 0; k < nP; k++) recToPlaced.set(pRec[k], k);
  const recordPosition = (rec) => {
    const k = recToPlaced.get(rec >>> 0);
    return k === undefined ? null : [px[k], py[k], pz[k]];
  };

  return { header, streamChunks, fetchRecord, recordPosition };
}

// ── src/sticks.js ──

// @gcu/condenser — stick chunks: drillhole interval SEGMENTS (desurveyed
// endpoint pairs) as instanced capsule impostors (micro-layers spec §6).
// Same chunk discipline as blocks/points: batch-Morton on the midpoints,
// intra-chunk shuffle (any prefix = a uniform subsample), per-chunk channel
// quantization. Coordinates stay Float32 frame-local — stick counts are
// 10³–10⁶, so the uint16 squeeze isn't needed and endpoints stay exact
// to ~mm at frame-local magnitudes.


/**
 * Build one StickChunk from columnar world-space endpoints + attributes.
 * raw = { ax..az, bx..bz (endpoints), x,y,z (midpoints), chan, cat, recIdx }.
 * `indices` = optional gather list (a Morton slice); shuffled like the others.
 */
function buildStickChunk(raw, frame, rnd, indices = null) {
  const n = indices ? indices.length : raw.x.length;
  const o = frame.origin;
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const seg = new Float32Array(6 * n);                     // ax ay az bx by bz, frame-local
  const outChan = new Uint16Array(n), outCat = new Uint8Array(n), outR = new Uint32Array(n);
  let cMin = Infinity, cMax = -Infinity;
  for (let k = 0; k < n; k++) { const v = raw.chan[perm[k]]; if (Number.isFinite(v)) { if (v < cMin) cMin = v; if (v > cMax) cMax = v; } }
  if (!Number.isFinite(cMin)) { cMin = 0; cMax = 0; }
  const cScale = cMax > cMin ? 65535 / (cMax - cMin) : 0;
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    const A = [raw.ax[i] - o[0], raw.ay[i] - o[1], raw.az[i] - o[2]];
    const B = [raw.bx[i] - o[0], raw.by[i] - o[1], raw.bz[i] - o[2]];
    seg[k * 6] = A[0]; seg[k * 6 + 1] = A[1]; seg[k * 6 + 2] = A[2];
    seg[k * 6 + 3] = B[0]; seg[k * 6 + 4] = B[1]; seg[k * 6 + 5] = B[2];
    for (let a = 0; a < 3; a++) {
      if (A[a] < bb[a]) bb[a] = A[a]; if (A[a] > bb[a + 3]) bb[a + 3] = A[a];
      if (B[a] < bb[a]) bb[a] = B[a]; if (B[a] > bb[a + 3]) bb[a + 3] = B[a];
    }
    const cv = raw.chan[i];
    outChan[k] = Number.isFinite(cv) ? ((cv - cMin) * cScale + 0.5) | 0 : 0;
    outCat[k] = raw.cat ? raw.cat[i] : 0;
    outR[k] = raw.recIdx[i];
  }
  // NB: the culling bbox covers the SEGMENTS; the renderer pads it by the
  // current stick radius at cull time (the radius is a live per-layer knob).
  return { kind: 'sticks', count: n, seg, chan: outChan, chanRange: [cMin, cMax], cat: outCat, recIdx: outR, bboxLocal: Float64Array.from(bb) };
}

// Exact midpoint of element k, frame-local (tests + pick verification).
function stickLocalCenter(chunk, k) {
  const s = chunk.seg;
  return [(s[k * 6] + s[k * 6 + 3]) / 2, (s[k * 6 + 1] + s[k * 6 + 4]) / 2, (s[k * 6 + 2] + s[k * 6 + 5]) / 2];
}

/**
 * StickChunkBuilder — the blocks builder's shape over segment RawChunks
 * ({ count, ax..bz, x,y,z, chan, cat, recIdx }). Batch-Morton on midpoints,
 * sliced, shuffled.
 */
function createStickChunkBuilder({ frame, chunkSize = 1 << 17, batchSize = 0, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  const batchN = batchSize || chunkSize * 4;
  let pend = [], pendCount = 0;
  const doc = {
    count: 0,
    bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity),
    chanRange: [Infinity, -Infinity],
  };
  const concat = (Type, parts) => {
    const out = new Type(parts.reduce((t, p) => t + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const flushBatch = () => {
    if (!pendCount) return;
    const cols = {
      ax: concat(Float64Array, pend.map((p) => p.ax)), ay: concat(Float64Array, pend.map((p) => p.ay)), az: concat(Float64Array, pend.map((p) => p.az)),
      bx: concat(Float64Array, pend.map((p) => p.bx)), by: concat(Float64Array, pend.map((p) => p.by)), bz: concat(Float64Array, pend.map((p) => p.bz)),
      x: concat(Float64Array, pend.map((p) => p.x)), y: concat(Float64Array, pend.map((p) => p.y)), z: concat(Float64Array, pend.map((p) => p.z)),
      chan: concat(Float64Array, pend.map((p) => p.chan)),
      cat: pend.every((p) => p.cat) ? concat(Uint8Array, pend.map((p) => p.cat)) : null,
      recIdx: concat(Uint32Array, pend.map((p) => p.recIdx)),
    };
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n);
    for (let start = 0; start < n; start += chunkSize) {
      const slice = order.subarray(start, Math.min(start + chunkSize, n));
      const chunk = buildStickChunk(cols, frame, rnd, slice);
      doc.count += chunk.count;
      const b = doc.bboxLocal, cb = chunk.bboxLocal;
      for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
      if (chunk.chanRange[0] < doc.chanRange[0]) doc.chanRange[0] = chunk.chanRange[0];
      if (chunk.chanRange[1] > doc.chanRange[1]) doc.chanRange[1] = chunk.chanRange[1];
      onChunk(chunk);
    }
  };
  return {
    push(raw) {
      let recIdx = raw.recIdx;
      if (!recIdx) {
        recIdx = new Uint32Array(raw.count);
        for (let i = 0; i < raw.count; i++) recIdx[i] = (raw.recStart || 0) + i;
      }
      let taken = 0;
      while (taken < raw.count) {
        const room = batchN - pendCount;
        const n = Math.min(room, raw.count - taken);
        const s = (a) => (a ? a.subarray(taken, taken + n) : null);
        pend.push({ ax: s(raw.ax), ay: s(raw.ay), az: s(raw.az), bx: s(raw.bx), by: s(raw.by), bz: s(raw.bz), x: s(raw.x), y: s(raw.y), z: s(raw.z), chan: s(raw.chan), cat: s(raw.cat), recIdx: recIdx.subarray(taken, taken + n) });
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}

// ── src/gl-util.js ──

// @gcu/condenser — shared GL scaffolding (used by the splat + impostor pipelines).
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('condenser shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function makeProgram(gl, vsrc, fsrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('condenser link: ' + gl.getProgramInfoLog(p));
  return p;
}

// ── src/gl-sticks.js ──

// @gcu/condenser — capsule impostors for drillhole sticks (micro-layers §6).
// gl-blocks' trick with a different intersection: one instanced quad per
// SEGMENT, billboarded to enclose the capsule's silhouette (spanned by the
// segment axis and the axis⊥view direction), fragment ray-capsule test with a
// real gl_FragDepth + surface normal (headlight shading). <2px → splat
// demotion; a cheap no-gl_FragDepth program serves fully-demoted far chunks.
// Radius is a live per-layer uniform (world metres) — the "stick thickness"
// knob. Mask / section / picked-glow / repaint identical to blocks.


const VERT$gl_sticks = `#version 300 es
precision highp float;
layout(location=0) in vec3 aA;          // segment start, frame-local
layout(location=1) in vec3 aB;          // segment end
layout(location=2) in float aChan;      // uint16 normalized (per-chunk range)
layout(location=3) in float aCat;       // uint8 raw
layout(location=4) in uint aRec;        // uint32 partitioned record id
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uRadius;                  // stick radius, world metres
uniform float uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform vec3 uFwd;
uniform int uColorMode;                 // 0 elevation | 1 channel | 2 category | 3 solid
uniform vec2 uZRange;
uniform vec2 uChanChunk;                // chunk chan min/span (dequantize)
uniform vec2 uChanDoc;                  // doc chan min/span (ramp)
uniform sampler2D uRamp;
uniform sampler2D uPalette;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uSel;
uniform float uSelOn;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform sampler2D uRule;                // rule-code byte by record index (8192-wide)
uniform float uRuleOn;                  // rule mode: the code replaces the category
uniform uint uPicked;
uniform uvec2 uRepaint;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out vec3 vA;
flat out vec3 vB;
flat out vec4 vColor;
flat out float vMode;                   // 0 = capsule, 1 = splat
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = (aA + aB) * 0.5;
  vec3 axis = aB - aA;
  float len = max(length(axis), 1e-6);
  vec3 u = axis / len;
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;
  vec3 viewDir = uOrtho > 0.5 ? uFwd : (center - uEye) / dist;
  // quad plane: the segment axis × the axis-perpendicular-to-view — encloses
  // the capsule silhouette. Axis ∥ view → any perpendicular works.
  vec3 v = cross(u, viewDir);
  float vl = length(v);
  v = vl > 1e-4 ? v / vl : normalize(abs(u.z) < 0.9 ? cross(u, vec3(0.0, 0.0, 1.0)) : cross(u, vec3(1.0, 0.0, 0.0)));
  float pxR = (len * 0.5 + uRadius) * uPerspScale / distEff;
  float demoted = max(pxR < uDemotePx ? 1.0 : 0.0, uFixedSplat);
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp;
  if (demoted > 0.5) {                                   // splat: camera-facing square at the center
    float quadR = max(uPointPx * 0.5, min(pxR, uPointPx * 2.0)) * distEff / uPerspScale;
    vec3 sv = normalize(cross(viewDir, v));
    wp = center + (v * corner.x + sv * corner.y) * quadR;
  } else {
    wp = center + u * (corner.x * (len * 0.5 + uRadius)) + v * (corner.y * uRadius);
  }
  gl_Position = uViewProj * vec4(wp, 1.0);
  vA = aA; vB = aB; vMode = demoted; vCorner = corner; vWorldPos = wp;
  if (uColorMode == 0) {
    float t = clamp((center.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float cv = uChanChunk.x + aChan * uChanChunk.y;
    float t = clamp((cv - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((cls + 0.5) / 256.0, 0.5));
  } else {
    vColor = vec4(0.62, 0.63, 0.66, 1.0);
  }
  if (uSelOn > 0.5) {
    int rs = int(aRec & 0x1FFFFFFFu);
    if (texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG$gl_sticks = `#version 300 es
precision highp float;
flat in vec3 vA;
flat in vec3 vB;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform float uOrthoRay;
uniform float uBackoff;
uniform float uRadius;
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {                    // demoted splat
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = vColor;
    return;
  }
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  // ray-capsule (body cylinder + cap spheres)
  vec3 ba = vB - vA;
  vec3 oa = ro - vA;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa);
  float rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - uRadius * uRadius * baba;
  float h = b * b - a * c;
  float t = -1.0;
  vec3 n = vec3(0.0);
  if (h >= 0.0) {
    float tb = (-b - sqrt(h)) / max(a, 1e-9);
    float y = baoa + tb * bard;
    if (y > 0.0 && y < baba && tb > 0.0) {
      t = tb;
      vec3 p = ro + rd * t;
      n = (p - vA - ba * (y / baba)) / uRadius;
    }
  }
  if (t < 0.0) {                        // the caps: try both, keep the nearest forward hit
    for (int i = 0; i < 2; i++) {
      vec3 capC = i == 0 ? vA : vB;
      vec3 o2 = ro - capC;
      float b2 = dot(rd, o2);
      float c2 = dot(o2, o2) - uRadius * uRadius;
      float h2 = b2 * b2 - c2;
      if (h2 >= 0.0) {
        float t2 = -b2 - sqrt(h2);
        if (t2 > 0.0 && (t < 0.0 || t2 < t)) {
          t = t2;
          n = (ro + rd * t2 - capC) / uRadius;
        }
      }
    }
  }
  if (t < 0.0) discard;
  vec3 p = ro + rd * t;
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float shade = 0.55 + 0.45 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(vColor.rgb * shade, vColor.a);
}`;

const FRAG_CHEAP$gl_sticks = `#version 300 es
precision highp float;
flat in vec3 vA;
flat in vec3 vB;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;
  if (dot(vCorner, vCorner) > 1.0) discard;
  outColor = vColor;
}`;

function createSticksPipeline(gl) {
  const mkProg = (frag) => {
    const prog = makeProgram(gl, VERT$gl_sticks, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), eye: U('uEye'), radius: U('uRadius'),
      perspScale: U('uPerspScale'), demotePx: U('uDemotePx'), pointPx: U('uPointPx'), fixedSplat: U('uFixedSplat'),
      colorMode: U('uColorMode'), zRange: U('uZRange'), chanChunk: U('uChanChunk'), chanDoc: U('uChanDoc'),
      ramp: U('uRamp'), palette: U('uPalette'), lightDir: U('uLightDir'),
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), picked: U('uPicked'), repaint: U('uRepaint'),
      catVis: U('uCatVis'), catVisOn: U('uCatVisOn'), sel: U('uSel'), selOn: U('uSelOn'),
      rule: U('uRule'), ruleOn: U('uRuleOn'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      ortho: U('uOrtho'), fwd: U('uFwd'), orthoRay: U('uOrthoRay'), backoff: U('uBackoff'),
    } };
  };
  const full = mkProg(FRAG$gl_sticks), cheap = mkProg(FRAG_CHEAP$gl_sticks);
  let active = full;

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const mkBuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const bSeg = mkBuf(chunk.seg), bChan = mkBuf(chunk.chan), bCat = mkBuf(chunk.cat), bRec = mkBuf(chunk.recIdx);
    gl.bindVertexArray(null);
    return {
      kind: 'sticks', vao, buffers: [bSeg, bChan, bCat, bRec],
      bSeg, bChan, bCat, bRec,
      count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0,
      chanRange: chunk.chanRange,
    };
  }

  function drawSlice(c, first, k, useCheap = false) {
    const pp = useCheap ? cheap : full;
    if (pp !== active) { gl.useProgram(pp.prog); active = pp; }
    const uni = active.uni;
    gl.uniform1f(uni.fixedSplat, useCheap ? 1 : 0);
    gl.bindVertexArray(c.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bSeg);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, first * 24);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, first * 24 + 12);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bChan);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_SHORT, true, 0, first * 2);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, first);
    gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, first * 4);
    gl.vertexAttribDivisor(4, 1);
    const span = c.chanRange[1] - c.chanRange[0];
    gl.uniform2f(uni.chanChunk, c.chanRange[0], span > 0 ? span : 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
  }

  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, section = null, radius = 1, catVisTex = null, selTex = null, ruleTex = null }) {
    const s = cam.state;
    for (const pp of [full, cheap]) {
      gl.useProgram(pp.prog);
      const uni = pp.uni;
      gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
      gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
      const v = s.view;
      let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
      const l2 = Math.hypot(lx, ly, lz) || 1;
      gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
      gl.uniform1f(uni.radius, radius);
      gl.uniform1f(uni.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uni.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uni.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uni.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uni.backoff, s.radius * 2);
      }
      gl.uniform1f(uni.demotePx, 2.0);
      gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
      gl.uniform1i(uni.colorMode, colorMode);
      gl.uniform2f(uni.zRange, zRange[0], zRange[1]);
      gl.uniform2f(uni.chanDoc, chanDoc[0], chanDoc[1]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
      gl.uniform1f(uni.fixedSplat, pointsView ? 1 : 0);
      gl.uniform1ui(uni.picked, picked >>> 0);
      gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
      gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
      gl.uniform1f(uni.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uni.isolate, isolate ? 1 : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uni.mask, 4); }
      gl.uniform1f(uni.catVisOn, catVisTex ? 1 : 0);
      if (catVisTex) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, catVisTex); gl.uniform1i(uni.catVis, 5); }
      gl.uniform1f(uni.selOn, selTex ? 1 : 0);
      if (selTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, selTex); gl.uniform1i(uni.sel, 6); }
      gl.uniform1f(uni.ruleOn, ruleTex ? 1 : 0);
      if (ruleTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, ruleTex); gl.uniform1i(uni.rule, 7); }
    }
    active = full;
    gl.useProgram(full.prog);
  }

  function setRepaint(a, b) {
    for (const pp of [full, cheap]) { gl.useProgram(pp.prog); gl.uniform2ui(pp.uni.repaint, a >>> 0, b >>> 0); }
    if (active) gl.useProgram(active.prog);
  }

  return { upload, drawSlice, begin, setRepaint };
}

// ── ../msh/msh.js ──

// @gcu/msh — ARANZ-1.0 mesh file (.msh) reader and writer.
// Single-file ESM, zero runtime deps. Works in browsers and Node 18+.
//
// Format (self-describing):
//
//   %ARANZ-1.0\n
//   \n
//   [index]\n
//   <Name> <Type> <Components> <Count>;\n
//   ...
//   \n
//   [binary]<12-byte signature><binary data in declared order, little-endian>
//
// The [index] section declares each binary array by name, element type
// (Double | Integer), components per element (e.g. 3 for 3D vertices),
// and element count. The [binary] section starts with a fixed 12-byte
// signature whose meaning is undocumented; we preserve it verbatim on
// round-trip. See the README for the bytes we've observed and our best
// guesses about their meaning (short version: probably an ARANZ-internal
// format sentinel; opaque to us).
//
// Common arrays in practice (single triangulated mesh per file):
//   Location   Double  3   N    — flat XYZ, length 3*N
//   Tri        Integer 3   M    — flat IJK indices, length 3*M
//
// Coordinates are returned unmodified — typically a UTM-like grid in
// metres. Recentring is a rendering concern, not a parsing one (WebGL
// f32 precision drops at the absolute coordinate magnitudes typical of
// UTM, so renderers should subtract a centroid before uploading).
//
// SPDX-License-Identifier: BSD-3-Clause
// Reference: vendor format, no public spec; reverse-engineered from
// MacPass HG/LG and other Leapfrog Geo / Edge exports. ARANZ Geo was
// the original developer (now Seequent / Bentley).

/** Magic line at the start of every .msh file. */
const MSH_MAGIC = '%ARANZ-1.0';

/** Section headers we recognise (case-sensitive). */
const SECTION_INDEX  = '[index]';
const SECTION_BINARY = '[binary]';

/** Length of the opaque-magic prefix that sits between '[binary]' and
 *  the first array's bytes. See README "12-byte signature" section. */
const BINARY_PREFIX_LENGTH = 12;

/** The signature observed across all files we've seen — preserved on
 *  writeback when the caller doesn't supply their own. Probably an
 *  ARANZ-internal format sentinel; we don't interpret it. */
const DEFAULT_BINARY_SIGNATURE = new Uint8Array([
  0xFF, 0x0F, 0xF0, 0x00, 0x1B, 0xDE, 0x83, 0x42,
  0xCA, 0xC0, 0xF3, 0x3F,
]);

/** Type catalog. Maps the index-declared Type name to its byte width
 *  and a constructor for the typed-array we'll hand back. Little-endian
 *  is assumed throughout; we don't write any other endianness either. */
const MSH_TYPES = {
  Double:  { bytes: 8, ctor: Float64Array, kind: 'float' },
  Float:   { bytes: 4, ctor: Float32Array, kind: 'float' },
  Integer: { bytes: 4, ctor: Int32Array,   kind: 'int'   },
  Long:    { bytes: 8, ctor: BigInt64Array, kind: 'int'  },
  Short:   { bytes: 2, ctor: Int16Array,   kind: 'int'   },
  Byte:    { bytes: 1, ctor: Uint8Array,   kind: 'int'   },
};

/** Thrown on any MSH-specific failure: bad magic, malformed index,
 *  unsupported type, declared/decoded size mismatch, out-of-range
 *  triangle indices. */
class MSHError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MSHError';
  }
}

/** @typedef {Object} MSHArray
 *  @property {string} type        e.g. "Double", "Integer"
 *  @property {number} components  values per element (3 for 3D vertex / triangle)
 *  @property {number} count       element count (vertices, triangles, ...)
 *  @property {TypedArray} data    flat values, length = components * count.
 *                                  Float64Array for Double, Int32Array for
 *                                  Integer, etc. */

/** @typedef {Object} MSHResult
 *  @property {string} version              From the magic line; '1.0' in practice.
 *  @property {Map<string,MSHArray>} arrays Declared arrays, keyed by name in
 *                                          DECLARATION ORDER (Map iteration
 *                                          preserves insertion order).
 *  @property {Uint8Array} binarySignature  The 12 bytes between '[binary]'
 *                                          and the first array. Preserved
 *                                          for byte-identical round-trip.
 *  @property {Float64Array=} vertices      Convenience: the first Double-3
 *                                          array (typically named "Location"),
 *                                          if present.
 *  @property {Int32Array=} triangles       Convenience: the first Integer-3
 *                                          array (typically "Tri"), if present. */

/** Read an .msh ArrayBuffer / Uint8Array and return a fully decoded
 *  {@link MSHResult}. Throws {@link MSHError} on any structural problem.
 *  @param {ArrayBuffer|Uint8Array} input
 *  @param {Object} [opts]
 *  @param {boolean} [opts.validateIndices=true]  Bounds-check triangle
 *      indices against vertex count. Set false to skip if you have a
 *      file with non-Location/Tri arrays whose meaning we can't infer.
 *  @returns {Promise<MSHResult>}
 */
async function readMSH(input, opts = {}) {
  const bytes = _coerceBytes(input);
  const validateIndices = opts.validateIndices !== false;

  // 1. Find the [binary] header by locating its literal bytes — the
  //    section header sits on its own line in practice, but the binary
  //    data starts IMMEDIATELY after the closing ']' (no newline).
  const binaryHeaderStart = _indexOfBytes(bytes, SECTION_BINARY);
  if (binaryHeaderStart < 0) {
    throw new MSHError('missing [binary] section header');
  }
  const binaryStart = binaryHeaderStart + SECTION_BINARY.length;

  // 2. Decode the text header (everything before [binary]) as UTF-8
  //    and parse out the magic + index declarations.
  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, binaryHeaderStart));
  const { version, declarations } = _parseTextHeader(headerText);

  // 3. Capture the 12-byte signature.
  if (binaryStart + BINARY_PREFIX_LENGTH > bytes.length) {
    throw new MSHError('binary section truncated before signature');
  }
  const binarySignature = bytes.slice(binaryStart, binaryStart + BINARY_PREFIX_LENGTH);

  // 4. Walk declarations in order, slicing the appropriate number of
  //    bytes per array. Little-endian — we copy into a fresh typed
  //    array rather than view-aliasing the source so the result is
  //    independent of the input buffer (the caller may free it).
  let cursor = binaryStart + BINARY_PREFIX_LENGTH;
  const arrays = new Map();
  for (const decl of declarations) {
    const info = MSH_TYPES[decl.type];
    if (!info) {
      throw new MSHError(`unsupported type "${decl.type}" for array "${decl.name}"`);
    }
    const totalValues = decl.components * decl.count;
    const totalBytes = totalValues * info.bytes;
    if (cursor + totalBytes > bytes.length) {
      throw new MSHError(
        `array "${decl.name}" declared ${totalBytes} bytes but file has only ${bytes.length - cursor} remaining`
      );
    }
    const data = _readTypedArray(bytes, cursor, totalValues, info);
    arrays.set(decl.name, {
      type: decl.type,
      components: decl.components,
      count: decl.count,
      data,
    });
    cursor += totalBytes;
  }
  // Trailing bytes? Real files don't have any, but tolerate up to 8
  // bytes of alignment padding (some writers append a record terminator).
  const trailing = bytes.length - cursor;
  if (trailing > 8) {
    throw new MSHError(`${trailing} unexpected bytes after the last declared array`);
  }

  const result = { version, arrays, binarySignature };

  // 5. Convenience accessors. Pick the FIRST Double-3 array as
  //    vertices and the FIRST Integer-3 array as triangles. Files with
  //    multiple Double-3 arrays (e.g. per-vertex normals) would need
  //    the caller to reach into `arrays` directly — we don't try to
  //    guess from names alone.
  let vertices, triangles;
  for (const [, arr] of arrays) {
    if (!vertices && arr.type === 'Double' && arr.components === 3) {
      vertices = arr.data;
    } else if (!triangles && arr.type === 'Integer' && arr.components === 3) {
      triangles = arr.data;
    }
  }
  if (vertices) result.vertices = vertices;
  if (triangles) result.triangles = triangles;

  // 6. Validation: every triangle index must reference a real vertex.
  //    Catches truncation / corruption that survived the size checks
  //    (e.g. a swapped array order).
  if (validateIndices && vertices && triangles) {
    const vCount = vertices.length / 3 | 0;
    for (let i = 0; i < triangles.length; i++) {
      const idx = triangles[i];
      if (idx < 0 || idx >= vCount) {
        throw new MSHError(
          `triangle index ${idx} at position ${i} is out of range (0..${vCount - 1})`
        );
      }
    }
  }

  return result;
}

/** Serialise an {@link MSHResult} (or a synthesised mesh) back to bytes.
 *  Round-trips byte-identical when given a result from readMSH that
 *  hasn't been modified.
 *  @param {Object} input
 *  @param {string} [input.version='1.0']
 *  @param {Map<string,MSHArray>|Object<string,MSHArray>} input.arrays
 *  @param {Uint8Array} [input.binarySignature]   12-byte prefix; defaults
 *      to the canonical observed signature.
 *  @returns {Promise<Uint8Array>}
 */
async function writeMSH(input) {
  const version = input.version || '1.0';
  const arrays = input.arrays instanceof Map
    ? input.arrays
    : new Map(Object.entries(input.arrays || {}));
  if (arrays.size === 0) {
    throw new MSHError('writeMSH: at least one declared array is required');
  }
  const signature = input.binarySignature || DEFAULT_BINARY_SIGNATURE;
  if (signature.length !== BINARY_PREFIX_LENGTH) {
    throw new MSHError(`binarySignature must be ${BINARY_PREFIX_LENGTH} bytes`);
  }

  // 1. Validate every array AND compute total binary length so we can
  //    allocate once. Keeps the writer single-pass and predictable.
  let binaryLen = BINARY_PREFIX_LENGTH;
  const orderedDeclarations = [];
  for (const [name, arr] of arrays) {
    const info = MSH_TYPES[arr.type];
    if (!info) {
      throw new MSHError(`writeMSH: unsupported type "${arr.type}" for array "${name}"`);
    }
    const declaredValues = arr.components * arr.count;
    if (!arr.data || arr.data.length !== declaredValues) {
      throw new MSHError(
        `writeMSH: array "${name}" declares ${declaredValues} values but data has ${arr.data?.length ?? 0}`
      );
    }
    orderedDeclarations.push({ name, ...arr, info });
    binaryLen += declaredValues * info.bytes;
  }

  // 2. Build the text header.
  const lines = [];
  lines.push(`%ARANZ-${version}`);
  lines.push('');
  lines.push(SECTION_INDEX);
  for (const decl of orderedDeclarations) {
    lines.push(`${decl.name} ${decl.type} ${decl.components} ${decl.count};`);
  }
  lines.push('');
  // The binary section header has NO trailing newline — the magic
  // signature starts immediately after the closing ']' (matching what
  // the readers in the wild expect, including the one this is based on).
  // Join with \n and append the literal '[binary]' separately so we
  // don't accidentally add one.
  const headerText = lines.join('\n') + '\n' + SECTION_BINARY;
  const headerBytes = new TextEncoder().encode(headerText);

  // 3. Allocate the final buffer and copy in:
  //    [header][signature][array 0 bytes][array 1 bytes]...
  const out = new Uint8Array(headerBytes.length + binaryLen);
  out.set(headerBytes, 0);
  let cursor = headerBytes.length;
  out.set(signature, cursor);
  cursor += BINARY_PREFIX_LENGTH;
  for (const decl of orderedDeclarations) {
    _writeTypedArray(out, cursor, decl.data, decl.info);
    cursor += decl.data.length * decl.info.bytes;
  }
  return out;
}

// ── internals ──

function _coerceBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && input.buffer instanceof ArrayBuffer) {
    // Other typed-array view: use its underlying buffer slice.
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new MSHError('readMSH: input must be ArrayBuffer or Uint8Array');
}

function _indexOfBytes(haystack, needleString) {
  // Search for an ASCII substring in a Uint8Array. Used to find the
  // [binary] header; we don't decode the whole file as UTF-8 because
  // the binary section will contain arbitrary bytes that may form
  // partial-UTF-8 sequences and corrupt the decoder.
  const needle = new TextEncoder().encode(needleString);
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function _parseTextHeader(text) {
  // Magic must be the first non-empty content line.
  const lines = text.split('\n');
  if (lines.length === 0 || !lines[0].startsWith('%ARANZ-')) {
    throw new MSHError('missing %ARANZ-N magic line');
  }
  const version = lines[0].slice('%ARANZ-'.length).trim();
  // Walk lines looking for [index]. Everything between [index] and the
  // next bracketed-section header (we expect [binary]) is declarations.
  let inIndex = false;
  const declarations = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      if (line === SECTION_INDEX) { inIndex = true; continue; }
      // Any other bracketed section ends the index. (We only know
      // about [binary] here, but other vendors might extend later.)
      inIndex = false;
      continue;
    }
    if (!inIndex) continue;
    declarations.push(_parseDeclaration(line));
  }
  if (declarations.length === 0) {
    throw new MSHError('[index] section is missing or empty');
  }
  return { version, declarations };
}

function _parseDeclaration(line) {
  // Shape: "<Name> <Type> <Components> <Count>;"
  // Name can contain spaces in theory (vendor-defined); we treat the
  // trailing ';' as the terminator and walk backwards through the
  // 3 numeric / type tokens. Anything before them is the name.
  const stripped = line.endsWith(';') ? line.slice(0, -1).trim() : line.trim();
  const tokens = stripped.split(/\s+/);
  if (tokens.length < 4) {
    throw new MSHError(`malformed index declaration: "${line}"`);
  }
  const count      = parseInt(tokens[tokens.length - 1], 10);
  const components = parseInt(tokens[tokens.length - 2], 10);
  const type       = tokens[tokens.length - 3];
  const name       = tokens.slice(0, tokens.length - 3).join(' ');
  if (!Number.isFinite(count) || count < 0
      || !Number.isFinite(components) || components < 1
      || !name) {
    throw new MSHError(`malformed index declaration: "${line}"`);
  }
  return { name, type, components, count };
}

function _readTypedArray(bytes, offset, length, info) {
  // The src bytes may not be aligned to the typed-array's stride, and
  // even when aligned, slicing into a fresh buffer guarantees the
  // returned array is independent of the input (we make NO promises
  // about the lifetime of the input ArrayBuffer). Copy bytes then
  // build the typed view on the copy.
  const totalBytes = length * info.bytes;
  const buf = new ArrayBuffer(totalBytes);
  new Uint8Array(buf).set(bytes.subarray(offset, offset + totalBytes));
  // BigInt64Array constructor takes (buffer, byteOffset, length).
  // All others same shape.
  return new info.ctor(buf, 0, length);
}

function _writeTypedArray(dst, offset, src, info) {
  // src is already a typed array (Float64Array etc.). We need its raw
  // bytes copied into dst at the given byte offset. The simplest path
  // is to view the SAME bytes via Uint8Array and let .set() handle
  // the copy.
  const view = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  // Sanity check: declared values × stride MUST match.
  if (view.byteLength !== src.length * info.bytes) {
    throw new MSHError(
      `writeMSH: typed-array stride mismatch (got ${view.byteLength}, expected ${src.length * info.bytes})`
    );
  }
  dst.set(view, offset);
}

// ── src/ply.js ──

// @gcu/condenser — PLY point-cloud provider (ascii + binary_little_endian).
// Reads the vertex element only (meshes: faces are ignored — micro shows the
// vertices). PLY carries no header bbox, so this provider runs a discovery
// sweep (bbox + intensity range) before streaming — both cold recipes over
// the Blob, same shape as the delimited provider. RawChunks match the LAS
// shape so the points pipeline + chunk builder are reused verbatim:
//   { count, x, y, z: Float64Array, intensity: Uint16Array,
//     classification: Uint8Array, rgb: Uint8Array(3n)|null, recStart }
//
// openPly(blob) → { header, streamChunks, fetchRecord }
//   header = { kind:'ply', format, count, bbox, columns, attributes, ply:{…} }
//   fetchRecord(rec) → [values in property order] (O(1) binary, sweep ascii)
//
// Honest limits: binary_big_endian and list-typed VERTEX properties throw;
// the vertex element must come first (a variable-size element before it
// would make the binary offset unknowable).

const TYPES = {
  char: [1, 'getInt8'], int8: [1, 'getInt8'],
  uchar: [1, 'getUint8'], uint8: [1, 'getUint8'],
  short: [2, 'getInt16'], int16: [2, 'getInt16'],
  ushort: [2, 'getUint16'], uint16: [2, 'getUint16'],
  int: [4, 'getInt32'], int32: [4, 'getInt32'],
  uint: [4, 'getUint32'], uint32: [4, 'getUint32'],
  float: [4, 'getFloat32'], float32: [4, 'getFloat32'],
  double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
};

// Parse the ASCII header block. Returns null when 'end_header' isn't in the
// sample (caller retries with a bigger slice).
function parsePlyHeader(text) {
  const endAt = text.indexOf('end_header');
  if (endAt < 0) return null;
  const nl = text.indexOf('\n', endAt);
  if (nl < 0) return null;
  const lines = text.slice(0, endAt).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('ply: missing magic');
  let format = null;
  const elements = [];
  for (const l of lines.slice(1)) {
    const f = l.split(/\s+/);
    if (f[0] === 'format') {
      if (f[1] === 'ascii') format = 'ascii';
      else if (f[1] === 'binary_little_endian') format = 'binary_le';
      else throw new Error(`ply: unsupported format ${f[1]}`);
    } else if (f[0] === 'element') {
      elements.push({ name: f[1], count: +f[2], props: [] });
    } else if (f[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new Error('ply: property before element');
      if (f[1] === 'list') el.props.push({ name: f[4], list: true, countType: f[2], idxType: f[3] });
      else el.props.push({ name: f[2], type: f[1] });
    }
    // 'comment' / 'obj_info' — skipped
  }
  if (!format) throw new Error('ply: no format line');
  const vertex = elements[0];
  if (!vertex || vertex.name !== 'vertex') throw new Error('ply: vertex must be the first element');
  let stride = 0;
  for (const p of vertex.props) {
    if (p.list) throw new Error('ply: list-typed vertex property unsupported');
    const t = TYPES[p.type];
    if (!t) throw new Error(`ply: unknown type ${p.type}`);
    p.size = t[0]; p.getter = t[1]; p.offset = stride;
    stride += t[0];
  }
  return { format, count: vertex.count, props: vertex.props, stride, dataOffset: nl + 1, elements };
}

const findProp = (props, ...names) => {
  for (const n of names) { const p = props.find((q) => q.name.toLowerCase() === n); if (p) return p; }
  return null;
};

async function openPly(blob, { signal, onProgress } = {}) {
  // header is ASCII even for binary files — sample up front, grow if needed
  let sampleLen = 64 * 1024, ply = null;
  for (;;) {
    const text = new TextDecoder('latin1').decode(await blob.slice(0, Math.min(sampleLen, blob.size)).arrayBuffer());
    ply = parsePlyHeader(text);
    if (ply) break;
    if (sampleLen >= blob.size) throw new Error('ply: no end_header');
    sampleLen *= 4;
  }
  const { props, stride, count } = ply;
  const px = findProp(props, 'x'), py = findProp(props, 'y'), pz = findProp(props, 'z');
  if (!px || !py || !pz) throw new Error('ply: vertex needs x/y/z properties');
  const pr = findProp(props, 'red', 'r', 'diffuse_red'), pg = findProp(props, 'green', 'g', 'diffuse_green'), pb = findProp(props, 'blue', 'b', 'diffuse_blue');
  const hasRgb = !!(pr && pg && pb);
  const pi = findProp(props, 'intensity', 'scalar_intensity', 'quality', 'confidence');
  const idx = { x: props.indexOf(px), y: props.indexOf(py), z: props.indexOf(pz), i: pi ? props.indexOf(pi) : -1, r: pr ? props.indexOf(pr) : -1, g: pg ? props.indexOf(pg) : -1, b: pb ? props.indexOf(pb) : -1 };
  const ascii = ply.format === 'ascii';

  // ── record iteration (cold recipe): yields batches of decoded raw fields ──
  // binary: DataView slabs; ascii: line stream. Both yield {fields, recStart}
  // where fields[k] is a Float64Array per needed property.
  const NEED = [...new Set([idx.x, idx.y, idx.z, idx.i, idx.r, idx.g, idx.b].filter((v) => v >= 0))];
  async function* recordBatches(batchRecords, s2, op2) {
    const alloc = () => { const o = {}; for (const k of NEED) o[k] = new Float64Array(batchRecords); return o; };
    if (!ascii) {
      let rec = 0;
      while (rec < count) {
        if (s2 && s2.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const n = Math.min(batchRecords, count - rec);
        const off = ply.dataOffset + rec * stride;
        const dv = new DataView(await blob.slice(off, off + n * stride).arrayBuffer());
        const fields = alloc();
        for (const k of NEED) {
          const p = props[k], g = p.getter, po = p.offset, col = fields[k];
          for (let i = 0; i < n; i++) col[i] = dv[g](i * stride + po, true);
        }
        if (op2) op2(off + n * stride, blob.size);
        yield { fields, n, recStart: rec };
        rec += n;
      }
    } else {
      const reader = blob.slice(ply.dataOffset).stream().pipeThrough(new TextDecoderStream()).getReader();
      let carry = '', rec = 0, fields = alloc(), n = 0, seen = ply.dataOffset;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (s2 && s2.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const lines = done ? (carry ? [carry] : []) : (carry + value).split('\n');
          if (!done) { carry = lines.pop(); seen += value.length; }
          for (const l of lines) {
            if (rec + n >= count) break;                    // face lines follow — stop at the vertex count
            const t = l.trim();
            if (!t) continue;
            const f = t.split(/\s+/);
            for (const k of NEED) fields[k][n] = +f[k];
            n++;
            if (n === batchRecords) { yield { fields, n, recStart: rec }; rec += n; fields = alloc(); n = 0; }
          }
          if (op2) op2(Math.min(seen, blob.size), blob.size);
          if (done || rec + n >= count) break;
        }
        if (n) yield { fields, n, recStart: rec };
      } finally { reader.releaseLock(); }
    }
  }

  // ── discovery sweep: bbox + intensity range ──
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let iMin = Infinity, iMax = -Infinity;
  for await (const { fields, n } of recordBatches(1 << 16, signal, onProgress)) {
    const xs = fields[idx.x], ys = fields[idx.y], zs = fields[idx.z], is = idx.i >= 0 ? fields[idx.i] : null;
    for (let i = 0; i < n; i++) {
      const xv = xs[i], yv = ys[i], zv = zs[i];
      if (xv < min[0]) min[0] = xv; if (xv > max[0]) max[0] = xv;
      if (yv < min[1]) min[1] = yv; if (yv > max[1]) max[1] = yv;
      if (zv < min[2]) min[2] = zv; if (zv > max[2]) max[2] = zv;
      if (is) { const v = is[i]; if (v < iMin) iMin = v; if (v > iMax) iMax = v; }
    }
  }
  const iScale = idx.i >= 0 && iMax > iMin ? 65535 / (iMax - iMin) : 0;

  const header = {
    kind: 'ply', format: ply.format, count,
    bbox: { min, max },
    columns: props.map((p) => p.name),
    attributes: [...(pi ? [pi.name] : []), ...(hasRgb ? ['rgb'] : [])],
    hasRgb,
    ply: { props, stride, dataOffset: ply.dataOffset, ascii },
  };

  // ── streaming sweep (cold recipe): LAS-shaped RawChunks ──
  async function* streamChunks({ chunkPoints = 1 << 18, signal: s2, onProgress: op2 } = {}) {
    for await (const { fields, n, recStart } of recordBatches(chunkPoints, s2, op2)) {
      const intensity = new Uint16Array(n);
      if (idx.i >= 0) { const is = fields[idx.i]; for (let i = 0; i < n; i++) intensity[i] = ((is[i] - iMin) * iScale) | 0; }
      let rgb = null;
      if (hasRgb) {
        rgb = new Uint8Array(3 * n);
        const rs = fields[idx.r], gs = fields[idx.g], bs = fields[idx.b];
        for (let i = 0; i < n; i++) { rgb[3 * i] = rs[i]; rgb[3 * i + 1] = gs[i]; rgb[3 * i + 2] = bs[i]; }
      }
      yield {
        count: n,
        x: fields[idx.x].subarray(0, n), y: fields[idx.y].subarray(0, n), z: fields[idx.z].subarray(0, n),
        intensity, classification: new Uint8Array(n), rgb, recStart,
      };
    }
  }

  // ── record fetch (the pick join): O(1) binary, early-exit sweep ascii ──
  async function fetchRecord(rec) {
    if (rec < 0 || rec >= count) return null;
    if (!ascii) {
      const off = ply.dataOffset + rec * stride;
      const dv = new DataView(await blob.slice(off, off + stride).arrayBuffer());
      return props.map((p) => dv[p.getter](p.offset, true));
    }
    const reader = blob.slice(ply.dataOffset).stream().pipeThrough(new TextDecoderStream()).getReader();
    let carry = '', at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const lines = done ? (carry ? [carry] : []) : (carry + value).split('\n');
        if (!done) carry = lines.pop();
        for (const l of lines) {
          const t = l.trim();
          if (!t) continue;
          if (at === rec) return t.split(/\s+/).map(Number);
          at++;
        }
        if (done) return null;
      }
    } finally { reader.releaseLock(); }
  }

  return { header, streamChunks, fetchRecord };
}

// ── src/mesh.js ──

// @gcu/condenser — context-tier mesh providers (micro-layers §7, tier 1).
// Wireframes, solids, TINs: whole-file reads into { vertices, triangles },
// then buildMeshChunk rebases to frame-local Float32 for the static indexed
// pipeline (gl-mesh.js). The tier is bounded by design — huge triangle-soup
// scans (photogrammetry) belong to the roadmapped streaming tier, which gets
// the full Morton/prefix treatment. Context meshes carry no records: scenery.
//
// Providers (each → { header, vertices: Float64Array(3n), triangles: Uint32Array(3m) }):
//   openMsh(blob)      — Leapfrog ARANZ-1.0 .msh via @gcu/msh
//   openObj(blob)      — Wavefront OBJ (v/f; fans n-gons; negative indices)
//   openPlyMesh(blob)  — PLY with a face element (ascii + binary_little_endian)
// header = { kind:'mesh', format, vertexCount, triCount, bbox:{min,max} }


function meshBbox(vertices) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function meshHeader(format, vertices, triangles) {
  return {
    kind: 'mesh', format,
    vertexCount: (vertices.length / 3) | 0,
    triCount: (triangles.length / 3) | 0,
    bbox: meshBbox(vertices),
  };
}

// ── Leapfrog .msh ──
async function openMsh(blob) {
  const msh = await readMSH(new Uint8Array(await blob.arrayBuffer()));
  if (!msh.vertices || !msh.triangles) throw new Error('msh: no vertex/triangle arrays found');
  const vertices = Float64Array.from(msh.vertices);
  const triangles = Uint32Array.from(msh.triangles);
  return { header: meshHeader('msh', vertices, triangles), vertices, triangles };
}

// ── Wavefront OBJ — v + f only (groups/materials are the records roadmap) ──
async function openObj(blob) {
  const text = await blob.text();
  const vx = [], tris = [];
  let nv = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line[0] === '#') continue;
    if (line.startsWith('v ')) {
      const f = line.split(/\s+/);
      vx.push(+f[1], +f[2], +f[3]);
      nv++;
    } else if (line.startsWith('f ')) {
      const f = line.split(/\s+/);
      const ix = [];
      for (let k = 1; k < f.length; k++) {
        // "v", "v/vt", "v//vn", "v/vt/vn" — the vertex index leads; negatives
        // count back from the vertices seen so far (OBJ spec)
        let v = parseInt(f[k], 10);
        if (!Number.isFinite(v) || v === 0) continue;
        if (v < 0) v = nv + v; else v = v - 1;
        ix.push(v);
      }
      for (let k = 2; k < ix.length; k++) tris.push(ix[0], ix[k - 1], ix[k]);   // fan
    }
  }
  if (!nv || !tris.length) throw new Error('obj: no v/f geometry found');
  const vertices = Float64Array.from(vx);
  const triangles = Uint32Array.from(tris);
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= nv) throw new Error(`obj: face index ${triangles[i]} out of range (${nv} vertices)`);
  return { header: meshHeader('obj', vertices, triangles), vertices, triangles };
}

// ── PLY with faces — reuses ply.js's header parse (vertex first, face after) ──
async function openPlyMesh(blob) {
  let sampleLen = 64 * 1024, ply = null;
  for (;;) {
    const text = new TextDecoder('latin1').decode(await blob.slice(0, Math.min(sampleLen, blob.size)).arrayBuffer());
    ply = parsePlyHeader(text);
    if (ply) break;
    if (sampleLen >= blob.size) throw new Error('ply: no end_header');
    sampleLen *= 4;
  }
  const face = ply.elements.find((e) => e.name === 'face');
  if (!face || !face.count) throw new Error('ply: no face element (points file — use openPly)');
  const px = ply.props.findIndex((p) => p.name.toLowerCase() === 'x');
  const py = ply.props.findIndex((p) => p.name.toLowerCase() === 'y');
  const pz = ply.props.findIndex((p) => p.name.toLowerCase() === 'z');
  if (px < 0 || py < 0 || pz < 0) throw new Error('ply: vertex needs x/y/z');
  const nv = ply.count;
  const vertices = new Float64Array(3 * nv);
  const tris = [];
  const SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const GETTERS = { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' };

  if (ply.format === 'ascii') {
    const text = await blob.text();
    const lines = text.slice(ply.dataOffset).split('\n');
    let at = 0, rec = 0;
    while (rec < nv && at < lines.length) {
      const t = lines[at++].trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      vertices[3 * rec] = +f[px]; vertices[3 * rec + 1] = +f[py]; vertices[3 * rec + 2] = +f[pz];
      rec++;
    }
    let fc = 0;
    while (fc < face.count && at < lines.length) {
      const t = lines[at++].trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      const k = +f[0];
      for (let j = 2; j < k; j++) tris.push(+f[1], +f[j], +f[j + 1]);   // fan
      fc++;
    }
  } else {
    const bytes = await blob.arrayBuffer();
    const dv = new DataView(bytes);
    for (let i = 0; i < nv; i++) {
      const base = ply.dataOffset + i * ply.stride;
      vertices[3 * i] = dv[ply.props[px].getter](base + ply.props[px].offset, true);
      vertices[3 * i + 1] = dv[ply.props[py].getter](base + ply.props[py].offset, true);
      vertices[3 * i + 2] = dv[ply.props[pz].getter](base + ply.props[pz].offset, true);
    }
    // faces: sequential walk (variable-size records). Only the vertex-index
    // list is kept; other per-face properties are stepped over.
    let off = ply.dataOffset + nv * ply.stride;
    // counts + indices are unsigned in practice (int32 indices are non-negative)
    const rd = (size) => { const v = dv[GETTERS[size]](off, true); off += size; return v; };
    for (let i = 0; i < face.count; i++) {
      for (const p of face.props) {
        if (p.list) {
          const cs = SIZES[p.countType] || 1, is = SIZES[p.idxType] || 4;
          const k = rd(cs);
          if (/vertex_ind/i.test(p.name) || face.props.length === 1) {
            const ix = new Array(k);
            for (let j = 0; j < k; j++) ix[j] = rd(is);
            for (let j = 2; j < k; j++) tris.push(ix[0], ix[j - 1], ix[j]);
          } else off += k * is;
        } else {
          const sz = SIZES[p.type] || 4;
          off += sz;
        }
      }
    }
  }
  if (!tris.length) throw new Error('ply: face element yielded no triangles');
  const triangles = Uint32Array.from(tris);
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= nv) throw new Error(`ply: face index ${triangles[i]} out of range (${nv} vertices)`);
  return { header: meshHeader(ply.format === 'ascii' ? 'ply-ascii' : 'ply-binary', vertices, triangles), vertices, triangles };
}

// ── world f64 → one frame-local GPU-ready chunk ──
// Float32 positions are safe at frame-local magnitudes (the whole point of
// @gcu/frame); indices stay u32. Context meshes are ONE chunk — they draw
// whole on clear frames, no prefix, no budget.
function buildMeshChunk({ vertices, triangles, frame }) {
  const o = frame ? frame.origin : [0, 0, 0];
  const n = (vertices.length / 3) | 0;
  const pos = new Float32Array(3 * n);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[3 * i + k] - o[k];
      pos[3 * i + k] = v;
      if (v < bb[k]) bb[k] = v;
      if (v > bb[k + 3]) bb[k + 3] = v;
    }
  }
  return {
    kind: 'mesh',
    pos,
    idx: triangles instanceof Uint32Array ? triangles : Uint32Array.from(triangles),
    count: (triangles.length / 3) | 0,                     // elements = triangles
    vertexCount: n,
    bboxLocal: Float64Array.from(bb),
  };
}

// ── src/gl-mesh.js ──

// @gcu/condenser — the context-mesh pipeline (micro-layers §7, tier 1).
// Static indexed triangles: one VAO + element buffer per mesh, drawn whole on
// clear frames (no prefix, no budget — the tier is bounded at open). Flat
// shading comes from screen-space derivatives (no normals buffer), two-sided
// (geological wireframes are rarely consistently wound). The section cut is
// PER-PIXEL — a triangle crossing the plane is clipped at it, not dropped —
// which is exactly the sectioned-solid view. Opacity is 4×4-Bayer screen-door:
// depth-correct, blend-free, safe under progressive accumulation and EDL.


const VERT$gl_mesh = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // frame-local vertex
uniform mat4 uViewProj;
uniform vec4 uSecPlane;
out vec3 vWorldPos;
out float vSecDist;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vWorldPos = aPos;
  vSecDist = dot(aPos, uSecPlane.xyz) - uSecPlane.w;
}`;

const FRAG$gl_mesh = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in float vSecDist;
uniform vec2 uSecCfg;                   // x: on, y: half-thickness
uniform vec4 uTint;                     // rgb + opacity
uniform vec3 uLightDir;
uniform vec3 uEye;
out vec4 outColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  if (uSecCfg.x > 0.5 && abs(vSecDist) > uSecCfg.y) discard;   // per-pixel plane cut
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));  // flat shading
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;                                 // two-sided
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(uTint.rgb * shade, 1.0);
}`;

function createMeshPipeline(gl) {
  const prog = makeProgram(gl, VERT$gl_mesh, FRAG$gl_mesh);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = {
    viewProj: U('uViewProj'), secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
    tint: U('uTint'), lightDir: U('uLightDir'), eye: U('uEye'),
  };

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const bIdx = gl.createBuffer();                        // stays bound in the VAO
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, chunk.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      kind: 'mesh', vao, buffers: [bPos, bIdx],
      count: chunk.count, idxCount: chunk.idx.length,
      bboxLocal: chunk.bboxLocal, cursor: 0,
    };
  }

  // per-layer uniforms — tint [r,g,b] 0..1, opacity 0..1, section may be null
  function begin(cam, { tint = [0.62, 0.64, 0.66], opacity = 1, section = null }) {
    const s = cam.state;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
    gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
    // the headlight of blocks/sticks: eye direction + a little up
    const v = s.view;
    let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
    const l2 = Math.hypot(lx, ly, lz) || 1;
    gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
    gl.uniform4f(uni.tint, tint[0], tint[1], tint[2], Math.max(0.02, Math.min(1, opacity)));
    gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
    gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
  }

  function draw(c) {
    gl.bindVertexArray(c.vao);
    gl.drawElements(gl.TRIANGLES, c.idxCount, gl.UNSIGNED_INT, 0);
  }

  return { upload, begin, draw };
}

// ── src/soup.js ──

// @gcu/condenser — streaming-tier meshes (micro-layers §7, tier 2): TRIANGLE
// SOUP under the full chunk discipline. Photogrammetry-scale meshes (10⁷–10⁸
// tris) get what points get: batch-Morton on centroids, intra-chunk shuffle
// (any prefix = a uniform subsample — valid because triangle size
// anti-correlates with mesh size: a mesh is huge BECAUSE its triangles are
// pixel-scale, and pixel-scale triangles subsample like points), per-chunk u16
// quantization (~18 B/tri resident), budgeted progressive accumulation.
// Flat shading needs no stored normals (screen-space derivatives in-shader).
// Soup carries no records in v1 — context semantics at scale.
//
// Precision: streamed vertices are kept Float32 LOCAL to a provisional origin
// (the first vertex) — world-f32 at UTM magnitudes loses ~1 m, local-f32 keeps
// mm — and re-widened to world f64 on emit for the frame-local rebase.


/**
 * Build one SoupChunk from columnar world-space corners + centroids.
 * raw = { ax..az, bx..bz, cx..cz (corners), x,y,z (centroids) }.
 * Corners are u16-quantized against the chunk bbox (the points trick ×3).
 */
function buildSoupChunk(raw, frame, rnd, indices = null) {
  const n = indices ? indices.length : raw.x.length;
  const o = frame.origin;
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const C = [raw.ax, raw.ay, raw.az, raw.bx, raw.by, raw.bz, raw.cx, raw.cy, raw.cz];
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    for (let c = 0; c < 9; c++) {
      const a = c % 3, v = C[c][i] - o[a];
      if (v < bb[a]) bb[a] = v;
      if (v > bb[a + 3]) bb[a + 3] = v;
    }
  }
  const sx = bb[3] > bb[0] ? 65535 / (bb[3] - bb[0]) : 0;
  const sy = bb[4] > bb[1] ? 65535 / (bb[4] - bb[1]) : 0;
  const sz = bb[5] > bb[2] ? 65535 / (bb[5] - bb[2]) : 0;
  const S = [sx, sy, sz];
  const tri = new Uint16Array(9 * n);
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    for (let c = 0; c < 9; c++) {
      const a = c % 3;
      tri[k * 9 + c] = ((C[c][i] - o[a] - bb[a]) * S[a] + 0.5) | 0;
    }
  }
  return { kind: 'soup', count: n, tri, bboxLocal: Float64Array.from(bb) };
}

// Exact centroid of element k, frame-local (tests).
function soupLocalCentroid(chunk, k) {
  const b = chunk.bboxLocal, t = chunk.tri;
  const d = (v, a) => (b[a + 3] > b[a] ? b[a] + (v / 65535) * (b[a + 3] - b[a]) : b[a]);
  const out = [0, 0, 0];
  for (let c = 0; c < 9; c++) out[c % 3] += d(t[k * 9 + c], c % 3) / 3;
  return out;
}

/**
 * SoupChunkBuilder — the sticks builder's shape over triangle RawChunks
 * ({ count, ax..cz, x,y,z }). Batch-Morton on centroids, sliced, shuffled.
 */
function createSoupChunkBuilder({ frame, chunkSize = 1 << 17, batchSize = 0, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  const batchN = batchSize || chunkSize * 4;
  let pend = [], pendCount = 0;
  const doc = {
    count: 0,
    bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity),
  };
  const concat = (Type, parts) => {
    const out = new Type(parts.reduce((t, p) => t + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const COLS = ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'cx', 'cy', 'cz', 'x', 'y', 'z'];
  const flushBatch = () => {
    if (!pendCount) return;
    const cols = {};
    for (const c of COLS) cols[c] = concat(Float64Array, pend.map((p) => p[c]));
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n);
    for (let start = 0; start < n; start += chunkSize) {
      const slice = order.subarray(start, Math.min(start + chunkSize, n));
      const chunk = buildSoupChunk(cols, frame, rnd, slice);
      doc.count += chunk.count;
      const b = doc.bboxLocal, cb = chunk.bboxLocal;
      for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
      onChunk(chunk);
    }
  };
  return {
    push(raw) {
      let taken = 0;
      while (taken < raw.count) {
        const room = batchN - pendCount;
        const n = Math.min(room, raw.count - taken);
        const part = {};
        for (const c of COLS) part[c] = raw[c].subarray(taken, taken + n);
        pend.push(part);
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}

// world f64 corner columns from a resolved index triple against local-f32
// vertices + their origin (the precision dance in the header comment)
function emitBatch(verts, vo, ia, ib, ic, n) {
  const out = { count: n };
  for (const c of ['ax', 'ay', 'az', 'bx', 'by', 'bz', 'cx', 'cy', 'cz', 'x', 'y', 'z']) out[c] = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = ia[i] * 3, b = ib[i] * 3, c = ic[i] * 3;
    const AX = vo[0] + verts[a], AY = vo[1] + verts[a + 1], AZ = vo[2] + verts[a + 2];
    const BX = vo[0] + verts[b], BY = vo[1] + verts[b + 1], BZ = vo[2] + verts[b + 2];
    const CX = vo[0] + verts[c], CY = vo[1] + verts[c + 1], CZ = vo[2] + verts[c + 2];
    out.ax[i] = AX; out.ay[i] = AY; out.az[i] = AZ;
    out.bx[i] = BX; out.by[i] = BY; out.bz[i] = BZ;
    out.cx[i] = CX; out.cy[i] = CY; out.cz[i] = CZ;
    out.x[i] = (AX + BX + CX) / 3; out.y[i] = (AY + BY + CY) / 3; out.z[i] = (AZ + BZ + CZ) / 3;
  }
  return out;
}

/**
 * Soup-stream an ALREADY-PARSED mesh (oversized .msh/.obj — their formats are
 * whole-file reads anyway; the vertices are transient, the soup is resident).
 * Yields RawChunks for createSoupChunkBuilder.
 */
async function* soupFromMesh({ vertices, triangles }, { batchTris = 1 << 16 } = {}) {
  const nv = (vertices.length / 3) | 0;
  const vo = nv ? [vertices[0], vertices[1], vertices[2]] : [0, 0, 0];
  const verts = new Float32Array(3 * nv);
  for (let i = 0; i < nv; i++) {
    verts[3 * i] = vertices[3 * i] - vo[0];
    verts[3 * i + 1] = vertices[3 * i + 1] - vo[1];
    verts[3 * i + 2] = vertices[3 * i + 2] - vo[2];
  }
  const nt = (triangles.length / 3) | 0;
  const ia = new Uint32Array(batchTris), ib = new Uint32Array(batchTris), ic = new Uint32Array(batchTris);
  let n = 0;
  for (let t = 0; t < nt; t++) {
    ia[n] = triangles[3 * t]; ib[n] = triangles[3 * t + 1]; ic[n] = triangles[3 * t + 2];
    n++;
    if (n === batchTris) { yield emitBatch(verts, vo, ia, ib, ic, n); n = 0; }
  }
  if (n) yield emitBatch(verts, vo, ia, ib, ic, n);
}

/**
 * openPlySoup(blob) — the TRUE streaming provider (binary_le + ascii PLY, the
 * formats photogrammetry exports). Two passes over the blob, neither holding
 * the file: (1) the vertex block → local-f32 xyz (12 B/vertex transient RAM —
 * the honest open-time cost; freed when streaming ends), (2) the face block
 * walked in slabs, fanned, emitted as RawChunk batches.
 * → { header, streamChunks } — header = { kind:'mesh', soup:true, format,
 *    vertexCount, triCount(≈ faces, exact after stream), bbox }
 */
async function openPlySoup(blob, { onProgress } = {}) {
  let sampleLen = 64 * 1024, ply = null;
  for (;;) {
    const text = new TextDecoder('latin1').decode(await blob.slice(0, Math.min(sampleLen, blob.size)).arrayBuffer());
    ply = parsePlyHeader(text);
    if (ply) break;
    if (sampleLen >= blob.size) throw new Error('ply: no end_header');
    sampleLen *= 4;
  }
  const face = ply.elements.find((e) => e.name === 'face');
  if (!face || !face.count) throw new Error('ply: no face element');
  const px = ply.props.find((p) => p.name.toLowerCase() === 'x');
  const py = ply.props.find((p) => p.name.toLowerCase() === 'y');
  const pz = ply.props.find((p) => p.name.toLowerCase() === 'z');
  if (!px || !py || !pz) throw new Error('ply: vertex needs x/y/z');
  const nv = ply.count, ascii = ply.format === 'ascii';
  const SIZES = { char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const GETTERS = { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' };

  // ── pass 1: vertices → local f32 (+ bbox in world f64) ──
  const verts = new Float32Array(3 * nv);
  const vo = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let faceStart;                                            // byte offset where faces begin (binary) / line index (ascii)
  let asciiLines = null;
  if (!ascii) {
    const SLAB = 1 << 23;                                   // 8 MB windows
    let seen = 0;
    while (seen < nv) {
      const n = Math.min(Math.floor(SLAB / ply.stride) || 1, nv - seen);
      const off = ply.dataOffset + seen * ply.stride;
      const dv = new DataView(await blob.slice(off, off + n * ply.stride).arrayBuffer());
      for (let i = 0; i < n; i++) {
        const X = dv[px.getter](i * ply.stride + px.offset, true);
        const Y = dv[py.getter](i * ply.stride + py.offset, true);
        const Z = dv[pz.getter](i * ply.stride + pz.offset, true);
        if (seen === 0 && i === 0) { vo[0] = X; vo[1] = Y; vo[2] = Z; }
        const k = (seen + i) * 3;
        verts[k] = X - vo[0]; verts[k + 1] = Y - vo[1]; verts[k + 2] = Z - vo[2];
        if (X < min[0]) min[0] = X; if (X > max[0]) max[0] = X;
        if (Y < min[1]) min[1] = Y; if (Y > max[1]) max[1] = Y;
        if (Z < min[2]) min[2] = Z; if (Z > max[2]) max[2] = Z;
      }
      seen += n;
      if (onProgress) onProgress(off + n * ply.stride, blob.size);
    }
    faceStart = ply.dataOffset + nv * ply.stride;
  } else {
    // ascii: one decode, line-split (ascii photogrammetry at soup scale is
    // rare; the binary path is the load-bearing one)
    const text = await blob.text();
    asciiLines = text.slice(ply.dataOffset).split('\n');
    const xi = ply.props.indexOf(px), yi = ply.props.indexOf(py), zi = ply.props.indexOf(pz);
    let rec = 0, at = 0;
    while (rec < nv && at < asciiLines.length) {
      const t = asciiLines[at++].trim();
      if (!t) continue;
      const f = t.split(/\s+/);
      const X = +f[xi], Y = +f[yi], Z = +f[zi];
      if (rec === 0) { vo[0] = X; vo[1] = Y; vo[2] = Z; }
      verts[rec * 3] = X - vo[0]; verts[rec * 3 + 1] = Y - vo[1]; verts[rec * 3 + 2] = Z - vo[2];
      if (X < min[0]) min[0] = X; if (X > max[0]) max[0] = X;
      if (Y < min[1]) min[1] = Y; if (Y > max[1]) max[1] = Y;
      if (Z < min[2]) min[2] = Z; if (Z > max[2]) max[2] = Z;
      rec++;
    }
    faceStart = at;
  }

  const header = {
    kind: 'mesh', soup: true, format: ascii ? 'ply-ascii' : 'ply-binary',
    vertexCount: nv, triCount: face.count, faces: face.count,
    bbox: { min, max },
  };

  // ── pass 2: the face walk → RawChunk batches ──
  async function* streamChunks({ batchTris = 1 << 16, signal, onProgress: op2 } = {}) {
    const ia = new Uint32Array(batchTris), ib = new Uint32Array(batchTris), ic = new Uint32Array(batchTris);
    let n = 0, tris = 0;
    const flushTo = function* (force) {
      if (n && (force || n === batchTris)) { const b = emitBatch(verts, vo, ia, ib, ic, n); tris += n; n = 0; yield b; }
    };
    const pushFan = function* (ix, k) {
      for (let j = 2; j < k; j++) {
        ia[n] = ix[0]; ib[n] = ix[j - 1]; ic[n] = ix[j];
        n++;
        if (n === batchTris) yield* flushTo(true);
      }
    };
    if (!ascii) {
      const MAXREC = 4 + 255 * 8;                           // count + a generous n-gon
      const SLAB = 1 << 23;
      let base = faceStart, carry = new Uint8Array(0), done = 0;
      const ix = new Uint32Array(256);
      while (done < face.count && base < blob.size) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const take = Math.min(SLAB, blob.size - base);
        const slab = new Uint8Array(carry.length + take);
        slab.set(carry, 0);
        slab.set(new Uint8Array(await blob.slice(base, base + take).arrayBuffer()), carry.length);
        base += take;
        const dv = new DataView(slab.buffer);
        let off = 0;
        const last = base >= blob.size;
        while (done < face.count && (last ? off < slab.length : off + MAXREC <= slab.length)) {
          let rOff = off, bad = false;
          for (const pr of face.props) {
            if (pr.list) {
              const cs = SIZES[pr.countType] || 1, is = SIZES[pr.idxType] || 4;
              if (rOff + cs > slab.length) { bad = true; break; }
              const k = dv[GETTERS[cs]](rOff, true); rOff += cs;
              if (rOff + k * is > slab.length) { bad = true; break; }
              if (/vertex_ind/i.test(pr.name) || face.props.length === 1) {
                for (let j = 0; j < k; j++) ix[j] = dv[GETTERS[is]](rOff + j * is, true);
                rOff += k * is;
                yield* pushFan(ix, k);
              } else rOff += k * is;
            } else {
              rOff += SIZES[pr.type] || 4;
              if (rOff > slab.length) { bad = true; break; }
            }
          }
          if (bad) break;
          off = rOff;
          done++;
        }
        carry = slab.subarray(off);
        if (op2) op2(base, blob.size);
      }
    } else {
      let at = faceStart, fc = 0;
      while (fc < face.count && at < asciiLines.length) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const t = asciiLines[at++].trim();
        if (!t) continue;
        const f = t.split(/\s+/);
        const k = +f[0];
        const ix = new Uint32Array(k);
        for (let j = 0; j < k; j++) ix[j] = +f[1 + j];
        yield* pushFan(ix, k);
        fc++;
      }
    }
    yield* flushTo(true);
    header.triCount = tris + n;                             // exact after the stream (fans expand quads)
  }

  return { header, streamChunks };
}

// ── src/gl-soup.js ──

// @gcu/condenser — the streaming-mesh (triangle soup) pipeline (micro-layers
// §7 tier 2). The points pipeline's shape over TRIANGLES: u16 positions
// dequantized against the chunk bbox, prefix slices (first/k in TRIANGLE
// units), budgeted accumulation. The fragment shader is gl-mesh's: derivative
// flat shading, two-sided, Bayer screen-door opacity, per-pixel section cut.


const VERT$gl_soup = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // u16 normalized against the chunk bbox
uniform mat4 uViewProj;
uniform vec3 uBoxMin;
uniform vec3 uBoxSpan;
uniform vec4 uSecPlane;
out vec3 vWorldPos;
out float vSecDist;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  vWorldPos = p;
  vSecDist = dot(p, uSecPlane.xyz) - uSecPlane.w;
}`;

const FRAG$gl_soup = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in float vSecDist;
uniform vec2 uSecCfg;
uniform vec4 uTint;
uniform vec3 uLightDir;
uniform vec3 uEye;
out vec4 outColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  if (uSecCfg.x > 0.5 && abs(vSecDist) > uSecCfg.y) discard;
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(uTint.rgb * shade, 1.0);
}`;

function createSoupPipeline(gl) {
  const prog = makeProgram(gl, VERT$gl_soup, FRAG$gl_soup);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = {
    viewProj: U('uViewProj'), boxMin: U('uBoxMin'), boxSpan: U('uBoxSpan'),
    secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
    tint: U('uTint'), lightDir: U('uLightDir'), eye: U('uEye'),
  };

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.tri, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindVertexArray(null);
    return {
      kind: 'soup', vao, buffers: [b],
      count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0,
    };
  }

  function begin(cam, { tint = [0.62, 0.64, 0.66], opacity = 1, section = null }) {
    const s = cam.state;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
    gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
    const v = s.view;
    let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
    const l2 = Math.hypot(lx, ly, lz) || 1;
    gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
    gl.uniform4f(uni.tint, tint[0], tint[1], tint[2], Math.max(0.02, Math.min(1, opacity)));
    gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
    gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
  }

  // first/k in TRIANGLES — the prefix invariant rides the shuffled build order
  function drawSlice(c, first, k) {
    gl.bindVertexArray(c.vao);
    gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
    gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
    gl.drawArrays(gl.TRIANGLES, first * 3, k * 3);
  }

  return { upload, begin, drawSlice };
}

// ── src/gl-blocks.js ──

// @gcu/condenser — box impostors for block models (micro-spec §2.3).
// One screen-aligned quad per block (instanced TRIANGLE_STRIP — no point-sprite
// size cap): the vertex shader expands a camera-basis billboard sized to the
// block's bounding sphere; the fragment shader ray-intersects the block's ACTUAL
// AABB analytically (slab test), discards on miss, writes correct gl_FragDepth
// and the face normal on hit → pixel-perfect cube silhouettes and correct
// inter-block occlusion at one quad per block. Face-normal flat shading; EDL
// does the rest on top.
//
// LOD demotion: a block whose projected radius falls below ~2 px renders as a
// plain circular splat (no ray test) — near field looks like blocks, far field
// looks like the dense cloud it visually is (§2.3).
//
// WebGL2 has no baseInstance, so accumulation slices [first, first+k) work by
// re-pointing the instance attributes at byte offsets before each draw — the
// chunk's VAO records the new pointers (cheap: 3 pointer calls per chunk-draw).
//
// Positions are IJK-exact (§2.5): center = uGridOrigin + aIjk · uGridSize, with
// uGridOrigin the frame-local centroid of block (0,0,0).


const VERT$gl_blocks = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;        // uint16 raw (integer lattice)
layout(location=1) in float aChan;      // uint16 normalized (per-chunk range)
layout(location=2) in float aCat;       // uint8 raw
layout(location=3) in uint aRec;        // uint32 record index (the join key)
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform float uPerspScale;              // persp: px/world at distance 1; ortho: px/world flat
uniform float uOrtho;                   // 1 = orthographic (skip the /dist)
uniform float uDemotePx, uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 grade | 2 category | 3 solid
uniform vec2 uZRange;
uniform vec2 uChanChunk;                // this chunk's [min, span] (dequantize aChan)
uniform vec2 uChanDoc;                  // document [min, span] (ramp normalization)
uniform sampler2D uRamp;
uniform sampler2D uPalette;
uniform sampler2D uMask;                // filter bitmask by record index (8192-wide)
uniform float uFilterOn, uIsolate;
uniform sampler2D uSel;
uniform float uSelOn;
uniform sampler2D uCatVis;              // 256x1 per-class visibility
uniform float uCatVisOn;
uniform sampler2D uRule;                // rule-code byte by record index (8192-wide)
uniform float uRuleOn;                  // rule mode: the code replaces the category
uniform float uForceSplat;              // 1 = whole chunk demoted (cheap far-field path)
uniform float uFixedSplat;              // 1 = points view: fixed-px splats regardless of block size
uniform uint uPicked;                   // record index to highlight (0xFFFFFFFF = none)
uniform uvec2 uRepaint;                 // repaint pass: draw ONLY these two records (both 0xFFFFFFFF = off)
uniform vec4 uSecPlane;                 // section plane: xyz = unit normal, w = offset (frame-local)
uniform vec2 uSecCfg;                   // x: 0 = off, 1 = slab; y: slab half-thickness
flat out vec3 vCenter;
flat out vec3 vHalf;
flat out vec4 vColor;
flat out float vMode;                   // 0 = impostor, 1 = splat
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = uGridOrigin + aIjk * uGridSize;
  vec3 half_ = uGridSize * 0.5;
  float r = length(half_);
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;              // ortho: size is distance-free
  float pxR = r * uPerspScale / distEff;
  float demoted = max(max(pxR < uDemotePx ? 1.0 : 0.0, uForceSplat), uFixedSplat);
  // filter mask: dim (default) or cull (isolate)
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;   // centroid-in-slab
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  float quadR = uFixedSplat > 0.5
    ? uPointPx * 0.5 * distEff / uPerspScale
    : mix(r, max(uPointPx * 0.5, pxR) * distEff / uPerspScale, demoted);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp = center + (uRight * corner.x + uUp * corner.y) * quadR;
  gl_Position = uViewProj * vec4(wp, 1.0);
  vCenter = center; vHalf = half_; vMode = demoted; vCorner = corner; vWorldPos = wp;
  if (uColorMode == 0) {
    float t = clamp((center.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float v = uChanChunk.x + aChan * uChanChunk.y;
    float t = clamp((v - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((cls + 0.5) / 256.0, 0.5));
  } else {
    vColor = vec4(0.62, 0.63, 0.66, 1.0);
  }
  if (uSelOn > 0.5) {
    int rs = int(aRec & 0x1FFFFFFFu);
    if (texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching (still legible)
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // repaint pass: everything else clips out
}`;

const FRAG$gl_blocks = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;                      // view direction (ortho rays are parallel)
uniform float uOrthoRay;                // 1 = ortho: origin per fragment, direction = uFwd
uniform float uBackoff;                 // how far behind the quad the ortho ray starts
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;             // isolate mode: filtered-out block
  if (vMode > 0.5) {                    // demoted splat: circular mask, rasterizer depth
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = vColor;
    return;
  }
  // ray-AABB slab test in frame-local space (perspective: from the eye;
  // orthographic: parallel rays -- origin backed off along the view direction)
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  vec3 inv = 1.0 / rd;                  // IEEE inf on axis-parallel rays is fine here
  vec3 t0 = (vCenter - vHalf - ro) * inv;
  vec3 t1 = (vCenter + vHalf - ro) * inv;
  vec3 tmin3 = min(t0, t1), tmax3 = max(t0, t1);
  float tin = max(max(tmin3.x, tmin3.y), tmin3.z);
  float tout = min(min(tmax3.x, tmax3.y), tmax3.z);
  if (tin > tout || tout < 0.0) discard;
  float t = tin > 0.0 ? tin : tout;     // inside the box → exit face
  vec3 p = ro + rd * t;
  // face normal = the slab that produced tin
  vec3 n = vec3(0.0);
  if (tin == tmin3.x) n = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tin == tmin3.y) n = vec3(0.0, -sign(rd.y), 0.0);
  else n = vec3(0.0, 0.0, -sign(rd.z));
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float shade = 0.55 + 0.45 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(vColor.rgb * shade, vColor.a);
}`;

// Far-field fragment: splat only, NO gl_FragDepth anywhere → early-z stays
// enabled for these draws — the perf lever for distant chunks (§2.3 mitigation).
const FRAG_CHEAP$gl_blocks = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform mat4 uViewProj;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;
  if (dot(vCorner, vCorner) > 1.0) discard;
  outColor = vColor;
}`;

// Golden-angle hue walk → visually distinct category colors (code → color).
function categoryPalettePixels(n = 256) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const h = (i * 137.508) % 360, s = 0.55, l = 0.58;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    out[i * 4] = Math.round((r + m) * 255); out[i * 4 + 1] = Math.round((g + m) * 255); out[i * 4 + 2] = Math.round((b + m) * 255); out[i * 4 + 3] = 255;
  }
  return out;
}

function createBlocksPipeline(gl) {
  const mkProg = (frag) => {
    const prog = makeProgram(gl, VERT$gl_blocks, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), eye: U('uEye'), right: U('uRight'), up: U('uUp'),
      gridOrigin: U('uGridOrigin'), gridSize: U('uGridSize'),
      perspScale: U('uPerspScale'), demotePx: U('uDemotePx'), pointPx: U('uPointPx'),
      colorMode: U('uColorMode'), zRange: U('uZRange'), chanChunk: U('uChanChunk'), chanDoc: U('uChanDoc'),
      ramp: U('uRamp'), palette: U('uPalette'), lightDir: U('uLightDir'),
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), forceSplat: U('uForceSplat'), fixedSplat: U('uFixedSplat'), picked: U('uPicked'), repaint: U('uRepaint'),
      catVis: U('uCatVis'), catVisOn: U('uCatVisOn'), sel: U('uSel'), selOn: U('uSelOn'),
      rule: U('uRule'), ruleOn: U('uRuleOn'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      ortho: U('uOrtho'), fwd: U('uFwd'), orthoRay: U('uOrthoRay'), backoff: U('uBackoff'),
    } };
  };
  const full = mkProg(FRAG$gl_blocks), cheap = mkProg(FRAG_CHEAP$gl_blocks);
  let active = full;

  // Upload one BlockChunk → buffers + a VAO whose instance pointers get re-aimed
  // per slice. CPU arrays are free to die after this returns.
  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const mkBuf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const bIjk = mkBuf(chunk.ijk), bChan = mkBuf(chunk.chan), bCat = mkBuf(chunk.cat);
    const bRec = mkBuf(chunk.recIdx);                      // filter-mask lookup + pick pass
    gl.bindVertexArray(null);
    return {
      kind: 'blocks', vao, buffers: [bIjk, bChan, bCat, bRec],
      bIjk, bChan, bCat, bRec,
      count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0,
      grid: chunk.grid, chanRange: chunk.chanRange,
    };
  }

  // Aim the instance attributes at element `first` and draw k instances.
  // useCheap: the whole chunk projects below the demotion threshold, so the
  // no-gl_FragDepth program (early-z enabled) draws it as forced splats.
  function drawSlice(c, first, k, useCheap = false) {
    const pp = useCheap ? cheap : full;
    if (pp !== active) { gl.useProgram(pp.prog); active = pp; }
    const uni = active.uni;
    gl.uniform1f(uni.forceSplat, useCheap ? 1 : 0);
    gl.bindVertexArray(c.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, first * 6);
    gl.vertexAttribDivisor(0, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bChan);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, true, 0, first * 2);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, first);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, first * 4);
    gl.vertexAttribDivisor(3, 1);
    gl.uniform3f(uni.gridOrigin, c.grid.originLocal[0], c.grid.originLocal[1], c.grid.originLocal[2]);
    gl.uniform3f(uni.gridSize, c.grid.size[0], c.grid.size[1], c.grid.size[2]);
    const span = c.chanRange[1] - c.chanRange[0];
    gl.uniform2f(uni.chanChunk, c.chanRange[0], span > 0 ? span : 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
  }

  // Per-frame program state (called once before the chunk loop) — set on BOTH
  // programs so drawSlice can switch freely between full and cheap.
  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, section = null, catVisTex = null, selTex = null, ruleTex = null }) {
    const s = cam.state;
    for (const pp of [full, cheap]) {
      gl.useProgram(pp.prog);
      const uni = pp.uni;
      gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
      gl.uniform3f(uni.eye, s.eye[0], s.eye[1], s.eye[2]);
      const v = s.view;                                    // camera basis = view-matrix rotation rows
      gl.uniform3f(uni.right, v[0], v[4], v[8]);
      gl.uniform3f(uni.up, v[1], v[5], v[9]);
      // headlight, slightly above the view direction
      let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
      const ll = Math.hypot(lx, ly, lz) || 1;
      lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
      const l2 = Math.hypot(lx, ly, lz) || 1;
      gl.uniform3f(uni.lightDir, lx / l2, ly / l2, lz / l2);
      gl.uniform1f(uni.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uni.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uni.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uni.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uni.backoff, s.radius * 2);
      }
      gl.uniform1f(uni.demotePx, 2.0);
      gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
      gl.uniform1i(uni.colorMode, colorMode);
      gl.uniform2f(uni.zRange, zRange[0], zRange[1]);
      gl.uniform2f(uni.chanDoc, chanDoc[0], chanDoc[1]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
      gl.uniform1f(uni.fixedSplat, pointsView ? 1 : 0);
      gl.uniform1ui(uni.picked, picked >>> 0);
      gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
      gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
      gl.uniform1f(uni.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uni.isolate, isolate ? 1 : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uni.mask, 4); }
      gl.uniform1f(uni.catVisOn, catVisTex ? 1 : 0);
      if (catVisTex) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, catVisTex); gl.uniform1i(uni.catVis, 5); }
      gl.uniform1f(uni.selOn, selTex ? 1 : 0);
      if (selTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, selTex); gl.uniform1i(uni.sel, 6); }
      gl.uniform1f(uni.ruleOn, ruleTex ? 1 : 0);
      if (ruleTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, ruleTex); gl.uniform1i(uni.rule, 7); }
    }
    active = full;
    gl.useProgram(full.prog);
  }

  // The pick-repaint pass (gl.js): both programs get the target pair, then the
  // lazily-tracked active program is restored so drawSlice's cache stays honest.
  function setRepaint(a, b) {
    for (const pp of [full, cheap]) { gl.useProgram(pp.prog); gl.uniform2ui(pp.uni.repaint, a >>> 0, b >>> 0); }
    if (active) gl.useProgram(active.prog);
  }

  return { upload, drawSlice, begin, setRepaint };
}

// ── src/gl-pick.js ──

// @gcu/condenser — GPU ID-buffer picking. On click, the visible chunks re-render
// once into an offscreen target with the fragment shaders outputting the RECORD
// INDEX encoded as RGBA8 instead of a color, scissored to the cursor pixel; one
// readPixels + decode gives the exact element under the cursor. The SAME analytic
// geometry that renders decides the pick — the impostor's ray-AABB test and real
// depth writes resolve which block face is hit, pixel-perfect at any zoom. No CPU
// spatial index. The record index is THE join key (micro-spec §4): a pick is a
// row number in the source file.


const ENCODE = `
vec4 encodeRec(uint r) {
  return vec4(float(r & 255u), float((r >> 8) & 255u), float((r >> 16) & 255u), float((r >> 24) & 255u)) / 255.0;
}`;

// ── points ──
const PICK_VERT_PTS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=2) in float aClass;
layout(location=4) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform sampler2D uRule;
uniform float uRuleOn;
flat out uint vRec;
flat out float vCull;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  vRec = aRec;
  vCull = (uSecCfg.x > 0.5 && abs(dot(p, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  if (uFilterOn > 0.5 && uIsolate > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    if (texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r < 0.5) vCull = 1.0;   // isolated-away isn't pickable
  }
  float cls = aClass;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
}`;
const PICK_FRAG_PTS = `#version 300 es
precision highp float;
flat in uint vRec;
flat in float vCull;
out vec4 outColor;
${ENCODE}
void main() {
  if (vCull > 0.5) discard;
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  outColor = encodeRec(vRec);
}`;

// ── blocks (geometry identical to gl-blocks; color replaced by the encoded id) ──
const PICK_VERT_BLK = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;
layout(location=2) in float aCat;
layout(location=3) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform float uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform sampler2D uRule;
uniform float uRuleOn;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out vec3 vCenter;
flat out vec3 vHalf;
flat out uint vRec;
flat out float vMode;
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = uGridOrigin + aIjk * uGridSize;
  vec3 half_ = uGridSize * 0.5;
  float r = length(half_);
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;
  float pxR = r * uPerspScale / distEff;
  float demoted = max(pxR < uDemotePx ? 1.0 : 0.0, uFixedSplat);
  float quadR = uFixedSplat > 0.5
    ? uPointPx * 0.5 * distEff / uPerspScale
    : mix(r, max(uPointPx * 0.5, pxR) * distEff / uPerspScale, demoted);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp = center + (uRight * corner.x + uUp * corner.y) * quadR;
  gl_Position = uViewProj * vec4(wp, 1.0);
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);   // hidden (isolated or sectioned) isn't pickable
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  vCenter = center; vHalf = half_; vRec = aRec; vMode = demoted; vCorner = corner; vWorldPos = wp;
}`;
const PICK_FRAG_BLK = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in uint vRec;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform float uOrthoRay;
uniform float uBackoff;
uniform mat4 uViewProj;
out vec4 outColor;
${ENCODE}
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = encodeRec(vRec);
    return;
  }
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (vCenter - vHalf - ro) * inv;
  vec3 t1 = (vCenter + vHalf - ro) * inv;
  vec3 tmin3 = min(t0, t1), tmax3 = max(t0, t1);
  float tin = max(max(tmin3.x, tmin3.y), tmin3.z);
  float tout = min(min(tmax3.x, tmax3.y), tmax3.z);
  if (tin > tout || tout < 0.0) discard;
  float t = tin > 0.0 ? tin : tout;
  vec4 clip = uViewProj * vec4(ro + rd * t, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = encodeRec(vRec);
}`;

// ── sticks (capsule geometry identical to gl-sticks; color = the encoded id) ──
const PICK_VERT_STK = `#version 300 es
precision highp float;
layout(location=0) in vec3 aA;
layout(location=1) in vec3 aB;
layout(location=3) in float aCat;
layout(location=4) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uRadius, uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform vec3 uFwd;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;
uniform float uCatVisOn;
uniform sampler2D uRule;
uniform float uRuleOn;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out vec3 vA;
flat out vec3 vB;
flat out uint vRec;
flat out float vMode;
flat out float vCull;
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = (aA + aB) * 0.5;
  vec3 axis = aB - aA;
  float len = max(length(axis), 1e-6);
  vec3 u = axis / len;
  float dist = max(distance(uEye, center), 1e-3);
  float distEff = uOrtho > 0.5 ? 1.0 : dist;
  vec3 viewDir = uOrtho > 0.5 ? uFwd : (center - uEye) / dist;
  vec3 v = cross(u, viewDir);
  float vl = length(v);
  v = vl > 1e-4 ? v / vl : normalize(abs(u.z) < 0.9 ? cross(u, vec3(0.0, 0.0, 1.0)) : cross(u, vec3(1.0, 0.0, 0.0)));
  float pxR = (len * 0.5 + uRadius) * uPerspScale / distEff;
  float demoted = max(pxR < uDemotePx ? 1.0 : 0.0, uFixedSplat);
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp;
  if (demoted > 0.5) {
    float quadR = max(uPointPx * 0.5, min(pxR, uPointPx * 2.0)) * distEff / uPerspScale;
    vec3 sv = normalize(cross(viewDir, v));
    wp = center + (v * corner.x + sv * corner.y) * quadR;
  } else {
    wp = center + u * (corner.x * (len * 0.5 + uRadius)) + v * (corner.y * uRadius);
  }
  gl_Position = uViewProj * vec4(wp, 1.0);
  vA = aA; vB = aB; vRec = aRec; vMode = demoted; vCorner = corner; vWorldPos = wp;
}`;
const PICK_FRAG_STK = `#version 300 es
precision highp float;
flat in vec3 vA;
flat in vec3 vB;
flat in uint vRec;
flat in float vMode;
flat in float vCull;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform float uOrthoRay;
uniform float uBackoff;
uniform float uRadius;
uniform mat4 uViewProj;
out vec4 outColor;
${ENCODE}
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outColor = encodeRec(vRec);
    return;
  }
  vec3 ro = uOrthoRay > 0.5 ? vWorldPos - uFwd * uBackoff : uEye;
  vec3 rd = uOrthoRay > 0.5 ? uFwd : normalize(vWorldPos - uEye);
  vec3 ba = vB - vA;
  vec3 oa = ro - vA;
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa);
  float rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - uRadius * uRadius * baba;
  float h = b * b - a * c;
  float t = -1.0;
  if (h >= 0.0) {
    float tb = (-b - sqrt(h)) / max(a, 1e-9);
    float y = baoa + tb * bard;
    if (y > 0.0 && y < baba && tb > 0.0) t = tb;
  }
  if (t < 0.0) {
    for (int i = 0; i < 2; i++) {
      vec3 capC = i == 0 ? vA : vB;
      vec3 o2 = ro - capC;
      float b2 = dot(rd, o2);
      float c2 = dot(o2, o2) - uRadius * uRadius;
      float h2 = b2 * b2 - c2;
      if (h2 >= 0.0) {
        float t2 = -b2 - sqrt(h2);
        if (t2 > 0.0 && (t < 0.0 || t2 < t)) t = t2;
      }
    }
  }
  if (t < 0.0) discard;
  vec4 clip = uViewProj * vec4(ro + rd * t, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = encodeRec(vRec);
}`;

const NO_HIT = 0xFFFFFFFF;                                 // the clear color decodes to this

function createPickPipeline(gl) {
  const pts = makeProgram(gl, PICK_VERT_PTS, PICK_FRAG_PTS);
  const blk = makeProgram(gl, PICK_VERT_BLK, PICK_FRAG_BLK);
  const stk = makeProgram(gl, PICK_VERT_STK, PICK_FRAG_STK);
  const U = (p, n) => gl.getUniformLocation(p, n);
  const uPts = { viewProj: U(pts, 'uViewProj'), boxMin: U(pts, 'uBoxMin'), boxSpan: U(pts, 'uBoxSpan'), pointPx: U(pts, 'uPointPx'), secPlane: U(pts, 'uSecPlane'), secCfg: U(pts, 'uSecCfg'), mask: U(pts, 'uMask'), filterOn: U(pts, 'uFilterOn'), isolate: U(pts, 'uIsolate'), catVis: U(pts, 'uCatVis'), catVisOn: U(pts, 'uCatVisOn'), rule: U(pts, 'uRule'), ruleOn: U(pts, 'uRuleOn') };
  const uBlk = {
    viewProj: U(blk, 'uViewProj'), eye: U(blk, 'uEye'), right: U(blk, 'uRight'), up: U(blk, 'uUp'),
    gridOrigin: U(blk, 'uGridOrigin'), gridSize: U(blk, 'uGridSize'),
    perspScale: U(blk, 'uPerspScale'), demotePx: U(blk, 'uDemotePx'), pointPx: U(blk, 'uPointPx'), fixedSplat: U(blk, 'uFixedSplat'),
    ortho: U(blk, 'uOrtho'), fwd: U(blk, 'uFwd'), orthoRay: U(blk, 'uOrthoRay'), backoff: U(blk, 'uBackoff'),
    mask: U(blk, 'uMask'), filterOn: U(blk, 'uFilterOn'), isolate: U(blk, 'uIsolate'),
    catVis: U(blk, 'uCatVis'), catVisOn: U(blk, 'uCatVisOn'), rule: U(blk, 'uRule'), ruleOn: U(blk, 'uRuleOn'),
    secPlane: U(blk, 'uSecPlane'), secCfg: U(blk, 'uSecCfg'),
  };
  const uStk = {
    viewProj: U(stk, 'uViewProj'), eye: U(stk, 'uEye'), radius: U(stk, 'uRadius'),
    perspScale: U(stk, 'uPerspScale'), demotePx: U(stk, 'uDemotePx'), pointPx: U(stk, 'uPointPx'), fixedSplat: U(stk, 'uFixedSplat'),
    ortho: U(stk, 'uOrtho'), fwd: U(stk, 'uFwd'), orthoRay: U(stk, 'uOrthoRay'), backoff: U(stk, 'uBackoff'),
    mask: U(stk, 'uMask'), filterOn: U(stk, 'uFilterOn'), isolate: U(stk, 'uIsolate'),
    catVis: U(stk, 'uCatVis'), catVisOn: U(stk, 'uCatVisOn'), rule: U(stk, 'uRule'), ruleOn: U(stk, 'uRuleOn'),
    secPlane: U(stk, 'uSecPlane'), secCfg: U(stk, 'uSecCfg'),
  };
  let fbo = null, colorTex = null, depthRb = null, w = 0, h = 0;

  function ensure(width, height) {
    if (fbo && width === w && height === h) return;
    w = width; h = height;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(colorTex); gl.deleteRenderbuffer(depthRb); }
    colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Pick at device pixel (px, py) (GL origin, bottom-left). Draws each chunk's
   * CURRENT accumulated prefix (you pick what you can see), scissored to the
   * pixel. Returns the record index, or null.
   */
  // the shared ID-buffer pass: scissored to (px,py,w,h), leaves the FBO bound
  // for the caller's readPixels. pick() reads 1px; pickRegion() reads the block.
  function renderInto(px, py, w2, h2, chunks, cam, { pointPx, blocksAsPoints = false, layerStates = null, section = null, viewportW, viewportH }) {
    const stateOf = (id) => (layerStates && layerStates.get(id)) || { maskTex: null, isolate: false };
    const byLayer = (arr) => {
      const m = new Map();
      for (const c of arr) { const id = c._layer || 0; let g = m.get(id); if (!g) m.set(id, g = []); g.push(c); }
      return m;
    };
    // per layer: an exempt layer (st.sectioned === false) picks whole
    const setSec = (u, st) => {
      const s = st && st.sectioned === false ? null : section;
      gl.uniform4f(u.secPlane, s ? s.n[0] : 0, s ? s.n[1] : 0, s ? s.n[2] : 1, s ? s.d : 0);
      gl.uniform2f(u.secCfg, s ? 1 : 0, s ? s.half : 0);
    };
    // hidden classes aren't pickable (same texture the visual pass culls by)
    const setCatVis = (u, st) => {
      const t = st && st.catVisTex;
      gl.uniform1f(u.catVisOn, t ? 1 : 0);
      if (t) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u.catVis, 5); }
    };
    // rule mode: the code substitutes for the class, so hidden RULES cull too
    const setRule = (u, st) => {
      const t = st && st.ruleOn && st.ruleTex;
      gl.uniform1f(u.ruleOn, t ? 1 : 0);
      if (t) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u.rule, 7); }
    };
    ensure(viewportW, viewportH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px, py, w2, h2);
    gl.clearColor(1, 1, 1, 1);                             // decodes to NO_HIT
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const s = cam.state;
    const dpp = pointPx * (window.devicePixelRatio || 1);

    const ptsChunks = chunks.filter((c) => c.kind === 'points' && c.cursor > 0);
    if (ptsChunks.length) {
      gl.useProgram(pts);
      gl.uniformMatrix4fv(uPts.viewProj, false, s.viewProj);
      gl.uniform1f(uPts.pointPx, dpp);
      for (const [id, group] of byLayer(ptsChunks)) {
      const st = stateOf(id);
      setSec(uPts, st);
      setCatVis(uPts, st);
      setRule(uPts, st);
      gl.uniform1f(uPts.filterOn, st.maskTex ? 1 : 0);
      gl.uniform1f(uPts.isolate, st.isolate ? 1 : 0);
      if (st.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, st.maskTex); gl.uniform1i(uPts.mask, 4); }
      for (const c of group) {
        gl.bindVertexArray(c.vao);
        // wire the recIdx buffer as attr 4 (idempotent; the visual program ignores it)
        gl.bindBuffer(gl.ARRAY_BUFFER, c.buffers[c.buffers.length - 1]);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
        gl.uniform3f(uPts.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
        gl.uniform3f(uPts.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
        gl.drawArrays(gl.POINTS, 0, c.cursor);
      }
      }
    }

    const blkChunks = chunks.filter((c) => c.kind === 'blocks' && c.cursor > 0);
    if (blkChunks.length) {
      gl.useProgram(blk);
      gl.uniformMatrix4fv(uBlk.viewProj, false, s.viewProj);
      gl.uniform3f(uBlk.eye, s.eye[0], s.eye[1], s.eye[2]);
      const v = s.view;
      gl.uniform3f(uBlk.right, v[0], v[4], v[8]);
      gl.uniform3f(uBlk.up, v[1], v[5], v[9]);
      gl.uniform1f(uBlk.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uBlk.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uBlk.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uBlk.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uBlk.backoff, s.radius * 2);
      }
      gl.uniform1f(uBlk.demotePx, 2.0);
      gl.uniform1f(uBlk.pointPx, dpp);
      gl.uniform1f(uBlk.fixedSplat, blocksAsPoints ? 1 : 0);
      for (const [id, group] of byLayer(blkChunks)) {
      const st = stateOf(id);
      setSec(uBlk, st);
      setCatVis(uBlk, st);
      setRule(uBlk, st);
      gl.uniform1f(uBlk.filterOn, st.maskTex ? 1 : 0);
      gl.uniform1f(uBlk.isolate, st.isolate ? 1 : 0);
      if (st.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, st.maskTex); gl.uniform1i(uBlk.mask, 4); }
      for (const c of group) {
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
        gl.vertexAttribDivisor(2, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.uniform3f(uBlk.gridOrigin, c.grid.originLocal[0], c.grid.originLocal[1], c.grid.originLocal[2]);
        gl.uniform3f(uBlk.gridSize, c.grid.size[0], c.grid.size[1], c.grid.size[2]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.cursor);
      }
      }
    }

    const stkChunks = chunks.filter((c) => c.kind === 'sticks' && c.cursor > 0);
    if (stkChunks.length) {
      gl.useProgram(stk);
      gl.uniformMatrix4fv(uStk.viewProj, false, s.viewProj);
      gl.uniform3f(uStk.eye, s.eye[0], s.eye[1], s.eye[2]);
      gl.uniform1f(uStk.perspScale, s.ortho ? (viewportH / 2) / s.halfH : (viewportH / 2) / Math.tan(s.fovY / 2));
      gl.uniform1f(uStk.ortho, s.ortho ? 1 : 0);
      gl.uniform1f(uStk.orthoRay, s.ortho ? 1 : 0);
      {
        const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
        const fl = Math.hypot(...f) || 1;
        gl.uniform3f(uStk.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
        gl.uniform1f(uStk.backoff, s.radius * 2);
      }
      gl.uniform1f(uStk.demotePx, 2.0);
      gl.uniform1f(uStk.pointPx, dpp);
      gl.uniform1f(uStk.fixedSplat, blocksAsPoints ? 1 : 0);
      for (const [id, group] of byLayer(stkChunks)) {
      const st2 = stateOf(id);
      setSec(uStk, st2);
      setCatVis(uStk, st2);
      setRule(uStk, st2);
      gl.uniform1f(uStk.radius, (st2 && st2.stickRadius) || 1);
      gl.uniform1f(uStk.filterOn, st2.maskTex ? 1 : 0);
      gl.uniform1f(uStk.isolate, st2.isolate ? 1 : 0);
      if (st2.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, st2.maskTex); gl.uniform1i(uStk.mask, 4); }
      for (const c of group) {
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bSeg);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.vertexAttribDivisor(1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
        gl.vertexAttribDivisor(4, 1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.cursor);
      }
      }
    }

    gl.disable(gl.SCISSOR_TEST);
  }

  function pick(px, py, chunks, cam, opts) {
    renderInto(px, py, 1, 1, chunks, cam, opts);
    const px4 = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    const rec = (px4[0] | (px4[1] << 8) | (px4[2] << 16) | (px4[3] << 24)) >>> 0;
    return rec === NO_HIT ? null : rec;
  }

  // one ID-buffer pass over a RECT (device px, GL bottom-left origin) — the
  // marquee/lasso read. Same programs, same per-layer gates; returns the raw
  // RGBA block (rows bottom-up); the caller masks by polygon and decodes.
  function pickRegion(px, py, w2, h2, chunks, cam, opts) {
    renderInto(px, py, w2, h2, chunks, cam, opts);
    const out = new Uint8Array(w2 * h2 * 4);
    gl.readPixels(px, py, w2, h2, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return out;
  }

  return { pick, pickRegion };
}

// ── ../dm/src/dm.js ──

// @gcu/dm — Datamine .DM file reader (READ-ONLY). Zero-dependency, browser-native.
//
// Provenance / legal: the format is reverse-engineered from two public,
// independent sources — VMine.com's format description (explicitly NOT from
// Constellation/Datamine copyright material) and Jeremy Maccelari's BSD-licensed
// ParaViewGeo `dmfile.h` (1999). The .DM file format is excluded from copyright
// under the EU Software Directive. Full spec + references: SPEC.md. MIT.
//
// Two sub-formats share the .dm extension: Single Precision (SP, 2048-byte pages,
// Float32, 4-byte words) and Extended Precision (EP, 4096-byte pages, Float64,
// 8-byte words). Page 1 = Data Definition (fields); pages 2+ = packed records.
// The last 16 bytes of every page are a legacy security block (skipped). Both
// variants leave 508 usable words per page.

class DMFormatError extends Error {
  constructor(msg) { super(msg); this.name = 'DMFormatError'; }
}

const USABLE_WORDS = 508;      // per page, both SP and EP (16-byte security tail)
const SENTINEL = 0.9e30;       // |value| above this = a Datamine special (missing/inf/trace)

const toDV = (b) => (b instanceof DataView ? b : new DataView(b.buffer ? b.buffer : b, b.byteOffset || 0, b.byteLength));

// Read N words as text: 4 ASCII chars per word (in EP, the first 4 bytes of each
// 8-byte word; the rest is padding). Non-printable bytes dropped; result trimmed.
function readText(dv, off, nWords, ws) {
  let s = '';
  for (let w = 0; w < nWords; w++) {
    const base = off + w * ws;
    for (let b = 0; b < 4; b++) {
      if (base + b >= dv.byteLength) break;
      const ch = dv.getUint8(base + b);
      if (ch >= 32 && ch < 127) s += String.fromCharCode(ch);
    }
  }
  return s.trim();
}

// Recover an EP extended field name (>8, up to 24 chars), or null if the entry
// isn't flagged long. EP-only: SP's 4-byte words have no high half. Leapfrog and
// other modern exporters hide chars 9–24 in bytes a legacy 8-char reader skips,
// flagged by ASCII "LONG" in the high half of the type word — so old readers
// still see a valid 8-char name (the encoding is purely additive). Chars 1–8 =
// low halves of words 0–1; 9–16 = their high halves; 17–24 = word 5 (low then
// high). Internal spaces kept; trailing pad stripped. Reverse-engineered from
// real Leapfrog EP exports (independent byte observation), not from Datamine
// copyright material. See SPEC §3.2.1.
function readLongName(dv, o, ws) {
  if (ws !== 8) return null;                              // EP-only mechanism
  if (o + ws * 5 + 8 > dv.byteLength) return null;        // truncated buffer → legacy path
  const flag = o + ws * 2 + 4;                            // high half of the type word
  const LONG = [0x4C, 0x4F, 0x4E, 0x47];                  // "LONG"
  for (let b = 0; b < 4; b++) if (dv.getUint8(flag + b) !== LONG[b]) return null;
  const segs = [o, o + ws, o + 4, o + ws + 4, o + ws * 5, o + ws * 5 + 4];
  //           low(w0) low(w1) high(w0) high(w1) low(w5)   high(w5)
  let s = '';
  for (const base of segs)
    for (let b = 0; b < 4; b++) {
      const c = dv.getUint8(base + b);
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ' ';
    }
  return s.replace(/\s+$/, '') || null;                   // strip trailing pad, keep internal spaces
}

const FMTS = [['sp', 'le'], ['sp', 'be'], ['ep', 'le'], ['ep', 'be']];
const wordSize = (p) => (p === 'ep' ? 8 : 4);
const pageSize = (p) => (p === 'ep' ? 4096 : 2048);
const dateOffOf = (p) => (p === 'ep' ? 192 : 96);

/**
 * Detect { precision: 'sp'|'ep', byteOrder: 'le'|'be' } from the file head
 * (≥ one page recommended), or null if it isn't a recognizable .dm. There's no
 * magic number: validate NVAR (1–500, integral) + a printable first field name.
 */
function detectDM(bytes) {
  const dv = toDV(bytes);
  for (const [precision, byteOrder] of FMTS) {
    const ws = wordSize(precision), isLE = byteOrder === 'le';
    const fcOff = dateOffOf(precision) + ws;                         // NVAR position
    if (fcOff + ws > dv.byteLength) continue;
    const fc = precision === 'ep' ? dv.getFloat64(fcOff, isLE) : dv.getFloat32(fcOff, isLE);
    const n = Math.round(fc);
    if (n < 1 || n > 500 || Math.abs(fc - n) > 0.01) continue;
    const fieldStart = dateOffOf(precision) + ws * 4;
    let printable = fieldStart + 4 <= dv.byteLength;
    for (let b = 0; printable && b < 4; b++) { const c = dv.getUint8(fieldStart + b); if (c < 32 || c >= 127) printable = false; }
    if (printable) return { precision, byteOrder };
  }
  return null;
}

/**
 * Parse the Data Definition (page 1) into a header: field schema, record layout,
 * and counts. `fmt` (from detectDM) is optional — detected if omitted. `bytes`
 * need only cover the first page.
 */
function parseHeader(bytes, fmt) {
  const dv = toDV(bytes);
  const f = fmt || detectDM(bytes);
  if (!f) throw new DMFormatError('not a recognizable .dm file (no SP/EP + endianness matched)');
  const { precision, byteOrder } = f;
  const ws = wordSize(precision), ps = pageSize(precision), isLE = byteOrder === 'le';
  const readNum = precision === 'ep' ? (o) => dv.getFloat64(o, isLE) : (o) => dv.getFloat32(o, isLE);

  const dateOff = dateOffOf(precision);
  const filename = readText(dv, 0, 2, ws);
  const description = readText(dv, precision === 'ep' ? 32 : 16, 20, ws);
  const dateNum = Math.round(readNum(dateOff));
  const nvar = Math.round(readNum(dateOff + ws));
  const lastPage = Math.round(readNum(dateOff + ws * 2));
  const lastRec = Math.round(readNum(dateOff + ws * 3));
  if (nvar < 1 || nvar > 256) throw new DMFormatError(`NVAR out of range: ${nvar}`);

  // Field-definition entries (28 bytes SP / 56 EP each; alpha >4 chars span
  // multiple entries sharing a name with incrementing WORDNO).
  const fieldStart = dateOff + ws * 4, fieldSize = ws * 7;
  const raw = [];
  for (let i = 0; i < nvar; i++) {
    const o = fieldStart + i * fieldSize;
    if (o + fieldSize > ps) break;                                   // single-page DD (spec §3.2)
    raw.push({
      name: readLongName(dv, o, ws) ?? readText(dv, o, 2, ws),   // §3.2.1 EP long names, else legacy 8-char
      type: (readText(dv, o + ws * 2, 1, ws).charAt(0) || 'N').toUpperCase(),
      sw: Math.round(readNum(o + ws * 3)),
      wordno: Math.round(readNum(o + ws * 4)),
      def: readNum(o + ws * 6),
    });
  }

  // Reconstruct logical columns (group entries by name).
  const map = new Map();
  for (const e of raw) {
    if (!map.has(e.name)) map.set(e.name, { name: e.name, type: e.type, entries: [] });
    map.get(e.name).entries.push(e);
  }
  let maxLen = 0;
  const columns = [];
  for (const c of map.values()) {
    const sorted = c.entries.slice().sort((a, b) => a.wordno - b.wordno);
    const sw = sorted.map((e) => e.sw);
    for (const p of sw) if (p > maxLen) maxLen = p;
    const isConstant = sorted[0].sw === 0;
    let constantValue = null;
    if (isConstant) {
      if (c.type === 'A') constantValue = decodeAlphaDefault(sorted, precision, isLE);
      else { const v = sorted[0].def; constantValue = Math.abs(v) > SENTINEL ? null : v; }
    }
    columns.push({ name: c.name, type: c.type, sw, width: c.type === 'A' ? sw.length * 4 : undefined, isConstant, constantValue });
  }

  const recordsPerPage = maxLen > 0 ? Math.floor(USABLE_WORDS / maxLen) : 0;
  const recordCount = lastPage > 1 ? (lastPage - 2) * recordsPerPage + lastRec : lastRec;

  return {
    precision, byteOrder, wordSize: ws, pageSize: ps,
    filename, description, date: dmDate(dateNum),
    nvar, lastPage, lastRec, maxLen, recordsPerPage, recordCount,
    columns,
    schema: columns.map((c) => ({ name: c.name, type: c.type === 'A' ? 'string' : 'number' })),
  };
}

function decodeAlphaDefault(entries, precision, isLE) {
  let s = '';
  const buf = new ArrayBuffer(precision === 'ep' ? 8 : 4);
  const dv = new DataView(buf);
  for (const e of entries) {
    if (precision === 'ep') dv.setFloat64(0, e.def, isLE); else dv.setFloat32(0, e.def, isLE);
    for (let b = 0; b < 4; b++) { const c = dv.getUint8(b); if (c >= 32 && c < 127) s += String.fromCharCode(c); }
  }
  return s.trim();
}

function dmDate(n) {
  if (!n || n < 10000) return null;                                 // 10000×year + 100×month + day
  const year = Math.floor(n / 10000), month = Math.floor((n % 10000) / 100), day = n % 100;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/** Byte range of record `i` (0-based) in the file — a contiguous slice (records
 *  never span a page). Read it and pass to decodeRecord. */
function recordRange(h, i) {
  const dataPage = Math.floor(i / h.recordsPerPage) + 2;            // 1-based; page 1 = DD
  const recInPage = i % h.recordsPerPage;
  return { offset: (dataPage - 1) * h.pageSize + recInPage * h.maxLen * h.wordSize, length: h.maxLen * h.wordSize };
}

/** Decode one record's word slice (from recordRange) into positional values:
 *  number | null (missing/sentinel) for numeric columns, string for alpha. */
function decodeRecord(bytes, h) {
  const dv = toDV(bytes);
  const ws = h.wordSize, isLE = h.byteOrder === 'le';
  const readNum = h.precision === 'ep' ? (o) => dv.getFloat64(o, isLE) : (o) => dv.getFloat32(o, isLE);
  return h.columns.map((col) => {
    if (col.isConstant) return col.constantValue;
    if (col.type === 'A') {
      let s = '';
      for (const sw of col.sw) { const base = (sw - 1) * ws; for (let b = 0; b < 4; b++) { if (base + b >= dv.byteLength) break; const c = dv.getUint8(base + b); if (c >= 32 && c < 127) s += String.fromCharCode(c); } }
      return s.trim();
    }
    const off = (col.sw[0] - 1) * ws;
    if (off + ws > dv.byteLength) return null;
    const v = readNum(off);
    return Math.abs(v) > SENTINEL ? null : v;
  });
}

/**
 * Whole-file convenience: detect + parse + record access over an ArrayBuffer /
 * Uint8Array. For huge files prefer the windowed path (detectDM → parseHeader →
 * recordRange → decodeRecord over a File you slice).
 */
function readDM(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.byteLength < 2048) throw new DMFormatError('file too small for a .dm page');
  const fmt = detectDM(u8.subarray(0, Math.min(4096, u8.byteLength)));
  if (!fmt) throw new DMFormatError('not a recognizable .dm file');
  const h = parseHeader(u8, fmt);
  const sliceRec = (i) => { const { offset, length } = recordRange(h, i); return u8.subarray(offset, offset + length); };
  return {
    filename: h.filename, description: h.description, date: h.date,
    precision: h.precision, byteOrder: h.byteOrder, fields: h.schema, recordCount: h.recordCount, header: h,
    getRecord(i) {
      if (i < 0 || i >= h.recordCount) return null;
      const vals = decodeRecord(sliceRec(i), h);
      const obj = {};
      h.columns.forEach((c, k) => { obj[c.name] = vals[k]; });
      return obj;
    },
    getColumns() {
      const n = h.recordCount;
      const out = {};
      const numArr = h.precision === 'ep' ? Float64Array : Float32Array;
      h.columns.forEach((c, k) => {
        if (c.isConstant) { out[c.name] = c.constantValue; return; }
        out[c.name] = c.type === 'A' ? new Array(n) : new numArr(n);
      });
      for (let i = 0; i < n; i++) {
        const vals = decodeRecord(sliceRec(i), h);
        h.columns.forEach((c, k) => {
          if (c.isConstant) return;
          if (c.type === 'A') out[c.name][i] = vals[k];
          else out[c.name][i] = vals[k] == null ? NaN : vals[k];     // missing → NaN in typed arrays
        });
      }
      return out;
    },
    * [Symbol.iterator]() { for (let i = 0; i < h.recordCount; i++) yield this.getRecord(i); },
  };
}

// ── src/dm-provider.js ──

// @gcu/condenser — Datamine .dm block-model provider, over @gcu/dm's windowed
// reader (micro-spec Addendum A.2). The DD page carries the grid definition as
// implicit constants (XMORIG/YMORIG/ZMORIG corner origin, XINC/YINC/ZINC block
// dims, NX/NY/NZ counts), so — unlike CSV — there is NO discovery sweep: grid,
// bbox, and schema are known from the first page. Centroids come from XC/YC/ZC
// per-record fields; the centroid of block (0,0,0) is MORIG + INC/2.
//
// Record indices are RAW record numbers (rows with missing coordinates are
// skipped but their numbers are not reused), so recordRange gives O(1) fetch of
// any picked record. Categories (first alpha column) build their dictionary
// incrementally during the single streaming sweep (≤255 distinct).
//
// v1 scope: regular uniform grids (INC as DD constants). Sub-blocked models
// (per-record INC) and non-model .dm files are a later milestone.


const DEF_NAMES = new Set(['IJK', 'XC', 'YC', 'ZC', 'XINC', 'YINC', 'ZINC', 'XMORIG', 'YMORIG', 'ZMORIG', 'NX', 'NY', 'NZ']);

async function openDmModel(blob, { mapping = null } = {}) {
  const head = new Uint8Array(await blob.slice(0, Math.min(8192, blob.size)).arrayBuffer());
  const fmt = detectDM(head);
  if (!fmt) throw new Error('dm: not a recognizable .dm file');
  const h = parseHeader(head, fmt);
  const names = h.columns.map((c) => c.name);
  const idx = (n) => names.indexOf(n);
  const constVal = (n) => { const c = h.columns[idx(n)]; return c && c.isConstant ? c.constantValue : null; };

  const xc = idx('XC') >= 0 ? idx('XC') : idx('X');
  const yc = idx('YC') >= 0 ? idx('YC') : idx('Y');
  const zc = idx('ZC') >= 0 ? idx('ZC') : idx('Z');
  if (xc < 0 || yc < 0 || zc < 0) throw new Error('dm: no XC/YC/ZC centroid fields — not a block model export');

  // the grid, straight from the DD (corner origin → centroid convention)
  const mor = [constVal('XMORIG'), constVal('YMORIG'), constVal('ZMORIG')];
  const inc = [constVal('XINC'), constVal('YINC'), constVal('ZINC')];
  const cnt = [constVal('NX'), constVal('NY'), constVal('NZ')];
  const regular = mor.every(Number.isFinite) && inc.every((v) => Number.isFinite(v) && v > 0) && cnt.every((v) => Number.isFinite(v) && v >= 1);
  if (!regular) throw new Error('dm: no regular grid definition (XMORIG/XINC/NX as constants) — sub-blocked / non-model files land in a later milestone');
  const grid = {
    x: { origin: mor[0] + inc[0] / 2, pitch: inc[0], count: Math.round(cnt[0]) },
    y: { origin: mor[1] + inc[1] / 2, pitch: inc[1], count: Math.round(cnt[1]) },
    z: { origin: mor[2] + inc[2] / 2, pitch: inc[2], count: Math.round(cnt[2]) },
  };
  const bbox = {
    min: [mor[0], mor[1], mor[2]],
    max: [mor[0] + inc[0] * cnt[0], mor[1] + inc[1] * cnt[1], mor[2] + inc[2] * cnt[2]],
  };

  // channels: every per-record numeric non-definition column; first alpha = category
  const numericColumns = h.columns
    .map((c, i) => ({ c, i }))
    .filter((o) => o.c.type === 'N' && !o.c.isConstant && !DEF_NAMES.has(o.c.name))
    .map((o) => ({ i: o.i, name: o.c.name }));
  const chan = mapping && mapping.chan != null ? mapping.chan : (numericColumns[0] ? numericColumns[0].i : null);
  const catIdx = h.columns.findIndex((c) => c.type === 'A' && !c.isConstant);
  const categories = catIdx >= 0 ? [] : null;              // fills incrementally during the sweep
  const catCode = catIdx >= 0 ? new Map() : null;

  const header = {
    kind: 'blockmodel', count: h.recordCount,
    bbox, grid,
    columns: names,
    mapping: { x: xc, y: yc, z: zc, chan, cat: catIdx >= 0 ? catIdx : null },
    numericColumns, categories,
    attributes: [...(chan != null ? [names[chan]] : []), ...(catIdx >= 0 ? [names[catIdx]] : [])],
    dm: h,                                                  // the @gcu/dm header: O(1) record fetch + the filter sweep
  };

  // Decoded-record batches (a cold recipe — call again for the filter sweep).
  // Reads ~4 MB page runs sequentially; yields { recStart, rows } with RAW
  // record numbering (recStart + k, no skips at this layer).
  async function* recordBatches({ signal } = {}) {
    const pagesPer = Math.max(1, Math.floor((4 << 20) / h.pageSize));
    for (let page = 2; page <= h.lastPage; page += pagesPer) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const pEnd = Math.min(page + pagesPer - 1, h.lastPage);
      const bytes = new Uint8Array(await blob.slice((page - 1) * h.pageSize, pEnd * h.pageSize).arrayBuffer());
      const rows = [];
      for (let pg = page; pg <= pEnd; pg++) {
        const nRec = pg === h.lastPage ? h.lastRec : h.recordsPerPage;
        const base = (pg - page) * h.pageSize;
        for (let r = 0; r < nRec; r++) {
          rows.push(decodeRecord(bytes.subarray(base + r * h.maxLen * h.wordSize, base + (r + 1) * h.maxLen * h.wordSize), h));
        }
      }
      yield { recStart: (page - 2) * h.recordsPerPage, rows };
    }
  }

  async function* streamChunks({ chunkPoints = 1 << 18, signal, onProgress } = {}) {
    const alloc = () => ({
      x: new Float64Array(chunkPoints), y: new Float64Array(chunkPoints), z: new Float64Array(chunkPoints),
      chan: new Float64Array(chunkPoints), cat: catCode ? new Uint8Array(chunkPoints) : null,
      recIdx: new Uint32Array(chunkPoints),
    });
    let buf = alloc(), fill = 0, done = 0;
    for await (const { recStart, rows } of recordBatches({ signal })) {
      for (let k = 0; k < rows.length; k++) {
        const vals = rows[k];
        const xv = vals[xc], yv = vals[yc], zv = vals[zc];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;   // skipped, raw number NOT reused
        buf.x[fill] = xv; buf.y[fill] = yv; buf.z[fill] = zv;
        const cv = chan != null ? vals[chan] : 0;
        buf.chan[fill] = cv == null ? NaN : cv;
        if (buf.cat) {
          const v = String(vals[catIdx] == null ? '' : vals[catIdx]);
          let code = catCode.get(v);
          if (code === undefined) {
            if (catCode.size < 255) { code = catCode.size; catCode.set(v, code); categories.push(v); }
            else code = 0;
          }
          buf.cat[fill] = code;
        }
        buf.recIdx[fill] = recStart + k;                   // RAW record number — the join key
        fill++;
        if (fill === chunkPoints) {
          yield { count: fill, x: buf.x, y: buf.y, z: buf.z, chan: buf.chan, cat: buf.cat, recIdx: buf.recIdx, recStart: 0 };
          buf = alloc(); fill = 0;
        }
      }
      done += rows.length;
      if (onProgress) onProgress(done, h.recordCount);
    }
    if (fill) {
      yield {
        count: fill, x: buf.x.subarray(0, fill), y: buf.y.subarray(0, fill), z: buf.z.subarray(0, fill),
        chan: buf.chan.subarray(0, fill), cat: buf.cat ? buf.cat.subarray(0, fill) : null,
        recIdx: buf.recIdx.subarray(0, fill), recStart: 0,
      };
    }
  }

  return { header, streamChunks, recordBatches };
}

// O(1) fetch of one record by RAW record number (the pick → inspector path).
async function fetchDmRecord(blob, h, rec) {
  const { offset, length } = recordRange(h, rec);
  const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  return decodeRecord(bytes, h);                           // positional values, h.columns order
}

// ── src/camera.js ──

// @gcu/condenser — minimal mat4 math + an orbit camera. Raw WebGL2 needs ~four
// matrix ops, not a scene graph (dee's camera is Three-coupled — micro-spec §5
// says borrow the *math*, and the math is textbook, so it lives here).
// Column-major Float32Array(16), GL convention. All coordinates FRAME-LOCAL —
// the document frame keeps magnitudes small enough for f32 uniforms.

function mat4Perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) * nf; m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4Ortho(halfH, aspect, near, far) {
  const halfW = halfH * aspect, m = new Float32Array(16);
  m[0] = 1 / halfW; m[5] = 1 / halfH;
  m[10] = -2 / (far - near); m[14] = -(far + near) / (far - near);
  m[15] = 1;
  return m;
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[4] = xy; m[8] = xz; m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[1] = yx; m[5] = yy; m[9] = yz; m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[2] = zx; m[6] = zy; m[10] = zz; m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

function mat4Multiply(a, b) {                       // a·b (both column-major)
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return m;
}

// Frustum planes from a viewProj matrix (Gribb–Hartmann, column-major): six
// [a,b,c,d] rows — a point is inside when a·x+b·y+c·z+d ≥ 0 for all six.
function frustumPlanes(m) {
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  return [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), add(r3, r2), sub(r3, r2)];
}

// Conservative AABB-vs-frustum: positive-vertex test — the box is out only when
// its most-positive corner for some plane is still behind that plane.
function aabbInFrustum(planes, b) {                 // b = [minX,minY,minZ,maxX,maxY,maxZ]
  for (const [a, bb, c, d] of planes) {
    const px = a > 0 ? b[3] : b[0], py = bb > 0 ? b[4] : b[1], pz = c > 0 ? b[5] : b[2];
    if (a * px + bb * py + c * pz + d < 0) return false;
  }
  return true;
}

function transformPoint(m, p) {                     // m · [p,1] → perspective divide
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/**
 * Orbit camera: target + spherical (radius, theta around Z, phi from the XY
 * plane). Z-up (geology convention). Produces eye/view/proj; near/far adapt to
 * the orbit radius each update (dee's depth-precision trick).
 */
function createOrbitCamera({ fovY = 45 * Math.PI / 180 } = {}) {
  const c = {
    target: [0, 0, 0], radius: 100, theta: Math.PI / 4, phi: Math.PI / 5, fovY,
    aspect: 1, near: 0.1, far: 1e6,
    ortho: false, halfH: 0,                                // ortho: half-height = radius·tan(fovY/2) — toggling keeps apparent size at the target
    eye: [0, 0, 0], view: null, proj: null, viewProj: null,
  };
  const EPS = 0.01;
  function update() {
    c.phi = Math.max(-Math.PI / 2 + EPS, Math.min(Math.PI / 2 - EPS, c.phi));
    c.radius = Math.max(0.05, c.radius);
    const cp = Math.cos(c.phi);
    c.eye = [
      c.target[0] + c.radius * cp * Math.cos(c.theta),
      c.target[1] + c.radius * cp * Math.sin(c.theta),
      c.target[2] + c.radius * Math.sin(c.phi),
    ];
    c.near = Math.max(c.radius / 1000, 0.01);
    c.far = c.radius * 100;
    c.view = mat4LookAt(c.eye, c.target, [0, 0, 1]);
    c.halfH = c.radius * Math.tan(c.fovY / 2);
    c.proj = c.ortho ? mat4Ortho(c.halfH, c.aspect, c.near, c.far) : mat4Perspective(c.fovY, c.aspect, c.near, c.far);
    c.viewProj = mat4Multiply(c.proj, c.view);
    return c;
  }
  return {
    get state() { return c; },
    update,
    setAspect(a) { c.aspect = a || 1; return update(); },
    orbit(dTheta, dPhi) { c.theta += dTheta; c.phi += dPhi; return update(); },
    dolly(f) { c.radius *= f; return update(); },
    pan(dxPx, dyPx, viewportH) {                           // screen px → world at target depth
      const s = 2 * c.radius * Math.tan(c.fovY / 2) / (viewportH || 1);
      const ct = Math.cos(c.theta), st = Math.sin(c.theta), sp = Math.sin(c.phi), cp = Math.cos(c.phi);
      // camera right = (-st, ct, 0); camera up ≈ (-ct·sp, -st·sp, cp)
      c.target[0] += (-st) * (-dxPx * s) + (-ct * sp) * (dyPx * s);
      c.target[1] += (ct) * (-dxPx * s) + (-st * sp) * (dyPx * s);
      c.target[2] += cp * (dyPx * s);
      return update();
    },
    setOrtho(on) { c.ortho = !!on; return update(); },
    fit(bbox) {                                            // frame a local-space bbox
      c.target = [(bbox[0] + bbox[3]) / 2, (bbox[1] + bbox[4]) / 2, (bbox[2] + bbox[5]) / 2];
      const dx = bbox[3] - bbox[0], dy = bbox[4] - bbox[1], dz = bbox[5] - bbox[2];
      const d = Math.hypot(dx, dy, dz) || 1;
      c.radius = (d / 2) / Math.tan(c.fovY / 2) * 1.2;
      return update();
    },
  };
}

// Wire standard mouse/touch input onto an orbit camera. Returns a detach fn.
// left-drag orbit · right-drag / shift-drag pan · wheel dolly.
function attachOrbitInput(canvas, cam, { onChange } = {}) {
  // pointers tracked by id: one = orbit (or pan with right-button/shift),
  // two = the touch grammar — pinch dollies, the centroid pans, twist orbits
  // theta. touch-action:none or the browser eats the gestures first.
  canvas.style.touchAction = 'none';
  const pts = new Map();
  let mode = null, lx = 0, ly = 0;
  let pinch = null;                                        // { span, cx, cy, angle }
  const pinchState = () => {
    const [a, b] = [...pts.values()];
    return {
      span: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  };
  const down = (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    if (pts.size === 2) { pinch = pinchState(); mode = 'pinch'; return; }
    if (pts.size > 2) return;                              // third finger: ignore
    mode = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
    lx = e.clientX; ly = e.clientY;
  };
  const move = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch' && pts.size >= 2) {
      const now = pinchState();
      cam.dolly(pinch.span / now.span > 0 ? pinch.span / now.span : 1);
      cam.pan(now.cx - pinch.cx, now.cy - pinch.cy, canvas.clientHeight);
      let dA = now.angle - pinch.angle;
      if (dA > Math.PI) dA -= 2 * Math.PI;
      if (dA < -Math.PI) dA += 2 * Math.PI;
      cam.orbit(-dA, 0);                                   // twist: grab-the-world
      pinch = now;
      if (onChange) onChange();
      return;
    }
    if (!mode || mode === 'pinch') return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    if (mode === 'orbit') cam.orbit(-dx * 0.006, dy * 0.006);
    else cam.pan(dx, dy, canvas.clientHeight);
    if (onChange) onChange();
  };
  const up = (e) => {
    pts.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    if (pts.size >= 2) { pinch = pinchState(); return; }   // still pinching with others
    if (pts.size === 1) {                                  // pinch → single: re-anchor, no jump
      const rest = [...pts.values()][0];
      mode = 'orbit'; lx = rest.x; ly = rest.y; pinch = null;
      return;
    }
    mode = null; pinch = null;
  };
  const wheel = (e) => { e.preventDefault(); cam.dolly(Math.pow(1.0015, e.deltaY)); if (onChange) onChange(); };
  const ctx = (e) => e.preventDefault();
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', ctx);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('contextmenu', ctx);
  };
}

// ── src/gl.js ──

// @gcu/condenser — the WebGL2 splat renderer. Raw GL, no scene graph: per-chunk
// VAOs over the quantized buffers (positions stay uint16 on the GPU — denormalized
// in the vertex shader against per-chunk bbox uniforms), circular point splats,
// color-by as a mode uniform + LUT texture (switching color source is a uniform/
// texture swap, never a buffer re-upload — micro-spec §2.2).
//
// Prefix-LOD (M1 form): a global per-frame element budget split across visible
// chunks proportionally; each chunk draws its FIRST k elements — correct as a
// uniform subsample because chunks.js shuffled them (the §2.1.4 invariant).


const VERT$gl = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // uint16 normalized -> 0..1
layout(location=1) in float aIntensity; // uint16 normalized
layout(location=2) in float aClass;     // uint8, raw (0..255)
layout(location=3) in vec3 aRgb;        // uint8 normalized
layout(location=4) in uint aRec;        // uint32 record index (highlight + mask lookups)
uniform uint uPicked;                   // record index to highlight (0xFFFFFFFF = none)
uniform uvec2 uRepaint;                 // repaint pass: draw ONLY these two records (both 0xFFFFFFFF = off)
uniform vec4 uSecPlane;                 // section plane: xyz = unit normal, w = offset (frame-local)
uniform vec2 uSecCfg;                   // x: 0 = off, 1 = slab; y: slab half-thickness
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 intensity | 2 classification | 3 rgb
uniform vec2 uZRange;                   // document local z min/span (elevation ramp)
uniform float uIntensityScale;          // 1 / (p98-ish max, normalized units)
uniform sampler2D uRamp;                // 256x1 continuous ramp
uniform sampler2D uPalette;             // classification / category palette
uniform float uPaletteN;                // its width (32 = LAS classes, 256 = category dict)
uniform sampler2D uMask;                // filter bitmask by record index (8192-wide)
uniform float uFilterOn, uIsolate;
uniform sampler2D uCatVis;              // 256x1 per-class visibility (layer properties)
uniform float uCatVisOn;
uniform sampler2D uSel;                 // selection bitmask by record index (8192-wide)
uniform float uSelOn;
uniform sampler2D uRule;                // rule-code byte by record index (8192-wide)
uniform float uRuleOn;                  // rule mode: the code REPLACES the class for palette + eyes
out vec4 vColor;
flat out float vCull;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  vCull = (uSecCfg.x > 0.5 && abs(dot(p, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  float m = 1.0;
  if (uFilterOn > 0.5) {
    int rec = int(aRec & 0x1FFFFFFFu);  // low 29 bits = the record (top 3 = layer)
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
    if (uIsolate > 0.5 && m < 0.5) vCull = 1.0;
  }
  float cls = aClass;
  if (uRuleOn > 0.5) {
    int rr = int(aRec & 0x1FFFFFFFu);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  float selHit = 0.0;
  if (uSelOn > 0.5) {
    int rs = int(aRec & 0x1FFFFFFFu);
    selHit = texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r;
  }
  if (uColorMode == 0) {
    float t = clamp((p.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float t = clamp(aIntensity * uIntensityScale, 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((cls + 0.5) / uPaletteN, 0.5));
  } else {
    vColor = vec4(aRgb, 1.0);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching
  if (selHit > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);   // selected: warm gold wash
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // repaint pass: everything else clips out
}`;

const FRAG$gl = `#version 300 es
precision highp float;
in vec4 vColor;
flat in float vCull;
out vec4 outColor;
void main() {
  if (vCull > 0.5) discard;             // outside the section slab
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;        // circular splat
  outColor = vColor;
}`;


// ── LUTs ──
// A small viridis-ish ramp (Switchboard-friendly; perceptual enough for v0.1).
const RAMP_STOPS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
function rampPixels(n = 256, stops = RAMP_STOPS) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) * (stops.length - 1), k = Math.min(stops.length - 2, t | 0), f = t - k;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(stops[k][c] * (1 - f) + stops[k + 1][c] * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}
// Standard LAS classification palette (0..18+; index = class code).
const CLASS_COLORS = {
  0: [140, 144, 153], 1: [170, 170, 170], 2: [161, 124, 82], 3: [122, 168, 100],
  4: [90, 150, 70], 5: [60, 130, 60], 6: [200, 105, 84], 7: [220, 80, 80],
  8: [180, 180, 90], 9: [74, 120, 176], 10: [200, 160, 60], 11: [110, 110, 120],
  12: [235, 100, 60], 13: [180, 140, 200], 14: [140, 120, 220], 15: [120, 200, 200],
  16: [200, 200, 120], 17: [160, 90, 160], 18: [230, 150, 150],
};
function palettePixels(n = 32) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = CLASS_COLORS[i] || [200, 60, 200];           // unknown classes scream magenta, quietly
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
  }
  return out;
}

function lutTexture(gl, pixels, n) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  return t;
}

// Upload one chunk's buffers → a VAO. CPU copies are the caller's to release —
// after this returns, the GPU owns the data (§2.1.5 CPU-release). recIdx goes up
// too (an unattached buffer, wired by the M5 pick pass) so nothing per-element
// has to stay resident in JS.
function uploadChunk(gl, chunk) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = (data, loc, size, type, normalized) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
    return b;
  };
  const buffers = [
    buf(chunk.pos, 0, 3, gl.UNSIGNED_SHORT, true),
    buf(chunk.intensity, 1, 1, gl.UNSIGNED_SHORT, true),
    buf(chunk.classification, 2, 1, gl.UNSIGNED_BYTE, false),
  ];
  if (chunk.rgb) buffers.push(buf(chunk.rgb, 3, 3, gl.UNSIGNED_BYTE, true));
  else { gl.disableVertexAttribArray(3); gl.vertexAttrib3f(3, 0.7, 0.7, 0.7); }
  const recBuf = gl.createBuffer();                        // highlight + pick lookups, GPU-resident
  gl.bindBuffer(gl.ARRAY_BUFFER, recBuf);
  gl.bufferData(gl.ARRAY_BUFFER, chunk.recIdx, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
  buffers.push(recBuf);
  gl.bindVertexArray(null);
  return { kind: 'points', vao, buffers, count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0 };
}

/**
 * createRenderer(canvas) — owns the GL context, program, LUTs, and the chunk
 * list; draw(cam, opts) renders one frame (into the current framebuffer — the
 * EDL pass wraps it). Chunks arrive via addChunk() as the stream lands.
 *
 * M2 state machine (§2.2): each frame classifies as MOVING (camera/viewport/
 * uniform changed since last frame) or STILL.
 *   moving → clear + draw a per-chunk PREFIX: k_i = budget · w_i/Σw where w_i is
 *   the chunk's projected screen weight ((radius/dist)², floored so the coarse
 *   global prefix never disappears), front-to-back over the frustum-culled set.
 *   still  → no clear; draw the NEXT SLICE of each unfinished visible chunk
 *   (progressive accumulation into the persistent FBO) until converged.
 * New chunks stream INTO the accumulation (no clear — they just draw behind).
 * All of it is correct because chunk prefixes are uniform subsamples (§2.1.4).
 */
function createRenderer(canvas, { background = [0.07, 0.07, 0.07, 1] } = {}) {
  // preserveDrawingBuffer: the viewport is also the screenshot-export surface
  // (micro-spec §6) and readPixels-after-frame is how the smoke verifies renders;
  // the cost is one buffer copy per composite — negligible next to the splat pass.
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('condenser: WebGL2 unavailable');
  const prog = makeProgram(gl, VERT$gl, FRAG$gl);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = {
    viewProj: U('uViewProj'), boxMin: U('uBoxMin'), boxSpan: U('uBoxSpan'),
    pointPx: U('uPointPx'), colorMode: U('uColorMode'), zRange: U('uZRange'),
    intensityScale: U('uIntensityScale'), ramp: U('uRamp'), palette: U('uPalette'), picked: U('uPicked'), repaint: U('uRepaint'),
    secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
    mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), paletteN: U('uPaletteN'),
    catVis: U('uCatVis'), catVisOn: U('uCatVisOn'),
    sel: U('uSel'), selOn: U('uSelOn'),
    rule: U('uRule'), ruleOn: U('uRuleOn'),
  };
  const ramp = lutTexture(gl, rampPixels(), 256);
  const palette = lutTexture(gl, palettePixels(), 32);   // LAS classification (points)
  let catPalette = null;                                  // category palette (blocks), lazy
  let blocksPipe = null;                                  // impostor pipeline, lazy
  let sticksPipe = null;                                  // capsule pipeline, lazy
  let meshPipe = null;                                    // context-mesh pipeline, lazy
  let soupPipe = null;                                    // streaming-mesh (soup) pipeline, lazy
  let pickPipe = null;                                    // ID-buffer pick pipeline, lazy
  const chunks = [];
  let docBbox = null;                                     // scene bbox (fit + the shared elevation ramp)
  let pickedRec = 0xFFFFFFFF;                             // highlighted record (sentinel = none; FULL partitioned id)
  const repaintSet = new Set();                           // records to repaint over a converged frame
  let lastConverged = false;
  // ── layers (micro-layers spec §1): each opened dataset is a layer with its own
  // visibility, filter mask, compaction set, and color ranges. recIdx is
  // PARTITIONED — (layerId << 29) | record — so one ID buffer serves all layers
  // (§3). Single-layer callers never notice: layer 0 shifts by zero and every
  // API defaults to it. ──
  const layers = new Map();                               // id → per-layer state
  function layerOf(id) {
    let l = layers.get(id);
    if (!l) {
      l = { visible: true, set: 'base', maskTex: null, maskH: 0, isolate: false,
            intensityMax: 1, docChan: [Infinity, -Infinity], catN: 0, stickRadius: 1, sectioned: true,
            meshTint: [0.62, 0.64, 0.66], meshOpacity: 1, catVisTex: null, rampTex: null, paletteTex: null, paletteW: 0, selTex: null, selH: 0,
            ruleTex: null, ruleH: 0, ruleOn: false };
      layers.set(id, l);
    }
    return l;
  }
  const activeChunk = (c) => { const l = layers.get(c._layer); return !!l && l.visible && c._set === l.set; };
  const freeChunk = (c) => { gl.deleteVertexArray(c.vao); c.buffers.forEach((b) => gl.deleteBuffer(b)); };
  const byLayer = (arr) => {
    const m = new Map();
    for (const c of arr) { let g = m.get(c._layer); if (!g) m.set(c._layer, g = []); g.push(c); }
    return m;
  };
  // accumulation state
  const lastVP = new Float32Array(16);
  let lastKey = '', needClear = true, lastVisible = 0;

  const vpChanged = (vp) => {
    for (let i = 0; i < 16; i++) if (vp[i] !== lastVP[i]) { lastVP.set(vp); return true; }
    return false;
  };

  return {
    gl,
    // background clear colour (also the figure/screenshot backdrop, since EDL
    // passes through background pixels untouched). rgba 0-1; a moving frame
    // re-clears so it takes effect next redraw.
    setBackground(rgba) { if (rgba && rgba.length >= 3) { background[0] = rgba[0]; background[1] = rgba[1]; background[2] = rgba[2]; background[3] = rgba[3] != null ? rgba[3] : 1; needClear = true; } },
    get background() { return [background[0], background[1], background[2], background[3]]; },
    get chunkCount() { return chunks.reduce((s, c) => s + (activeChunk(c) ? 1 : 0), 0); },
    get elementCount() { return chunks.reduce((s, c) => s + (activeChunk(c) ? c.count : 0), 0); },
    // ALL resident chunks (hidden layers + inactive sets included — they hold
    // their buffers), so the number is what the GPU is actually carrying
    get vramBytes() { return chunks.reduce((s, c) => s + (c.bytes || 0), 0); },
    layerVramBytes(layer) { return chunks.reduce((s, c) => s + (c._layer === layer ? (c.bytes || 0) : 0), 0); },
    get accumulated() { return chunks.reduce((s, c) => s + (activeChunk(c) ? c.cursor : 0), 0); },   // elements in the current accumulation
    addChunk(chunk, set = 'base', layer = 0) {
      const ls = layerOf(layer);
      if (layer && chunk.recIdx) {                        // partition the record ids (layer 0 shifts by zero)
        const base = (layer << 29) >>> 0, r = chunk.recIdx;
        for (let i = 0; i < r.length; i++) r[i] = (r[i] | base) >>> 0;
      }
      // honest VRAM accounting: every typed array in the CPU chunk becomes a
      // GPU buffer (bboxLocal's 48 B is noise) — summed here, read as vramBytes
      let cb = 0;
      for (const k in chunk) { const v = chunk[k]; if (v && v.buffer && v.byteLength) cb += v.byteLength; }
      if (chunk.kind === 'mesh') {                        // context tier: static, recordless, whole-draw
        if (!meshPipe) meshPipe = createMeshPipeline(gl);
        const up = meshPipe.upload(chunk); up._set = set; up._layer = layer; up.bytes = cb;
        chunks.push(up);
        needClear = true;                                 // draw it into a fresh accumulation
        return;
      }
      if (chunk.kind === 'soup') {                        // streaming tier: budgeted like points
        if (!soupPipe) soupPipe = createSoupPipeline(gl);
        const up = soupPipe.upload(chunk); up._set = set; up._layer = layer; up.bytes = cb;
        chunks.push(up);                                  // streams INTO the accumulation, no clear
        return;
      }
      if (chunk.kind === 'blocks' || chunk.kind === 'sticks') {
        if (chunk.kind === 'blocks' && !blocksPipe) blocksPipe = createBlocksPipeline(gl);
        if (chunk.kind === 'sticks' && !sticksPipe) sticksPipe = createSticksPipeline(gl);
        const up = (chunk.kind === 'blocks' ? blocksPipe : sticksPipe).upload(chunk);
        up._set = set; up._layer = layer; up.bytes = cb;
        chunks.push(up);                                   // GPU owns it now
        if (set === 'base') {                              // compact chunks never tighten the ramp
          if (chunk.chanRange[0] < ls.docChan[0]) ls.docChan[0] = chunk.chanRange[0];
          if (chunk.chanRange[1] > ls.docChan[1]) ls.docChan[1] = chunk.chanRange[1];
        }
        return;
      }
      const up = uploadChunk(gl, chunk); up._set = set; up._layer = layer; up.bytes = cb;
      chunks.push(up);                                     // GPU owns it now; CPU copy dies with the caller
      if (set === 'base') {
        let m = 0; const a = chunk.intensity;
        for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
        ls.intensityMax = Math.max(ls.intensityMax, m);
      }
    },
    setCategories(n) {                                     // block category palette (golden-angle hues)
      if (n > 0 && !catPalette) catPalette = lutTexture(gl, categoryPalettePixels(256), 256);
    },
    // Filter bitmask by RECORD INDEX within the layer (micro-spec section 4).
    // mask = Uint8Array (0|1 per source row) or null to clear; isolate: true
    // discards non-matching, false dims them.
    setFilter(mask, { isolate = false } = {}, layer = 0) {
      const ls = layerOf(layer);
      ls.isolate = isolate;
      if (!mask) {
        if (ls.maskTex) { gl.deleteTexture(ls.maskTex); ls.maskTex = null; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(mask.length / W));
        const padded = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) padded[i] = mask[i] ? 255 : 0;
        if (ls.maskTex && H === ls.maskH) {
          gl.bindTexture(gl.TEXTURE_2D, ls.maskTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (ls.maskTex) gl.deleteTexture(ls.maskTex);
          ls.maskTex = gl.createTexture(); ls.maskH = H;
          gl.bindTexture(gl.TEXTURE_2D, ls.maskTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    setDocBbox(b) { docBbox = b; },
    // Filter compaction (per layer): 'compact' chunks hold ONLY matching elements
    // (record ids preserved), so the render budget runs over the matches instead
    // of shader-discarding the rest. Base chunks stay resident — clearing is instant.
    setActiveSet(set, layer = 0) { const ls = layerOf(layer); if (set !== ls.set) { ls.set = set; needClear = true; } },
    get activeSet() { return layerOf(0).set; },            // legacy single-layer read
    clearCompact(layer = 0) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c._layer !== layer || c._set !== 'compact') continue;
        freeChunk(c);
        chunks.splice(i, 1);
      }
      const ls = layerOf(layer);
      if (ls.set === 'compact') { ls.set = 'base'; needClear = true; }
    },
    // points layers with a CATEGORY dict color class codes through the 256-wide
    // golden-angle palette instead of the 32-entry LAS classification table
    setLayerCats(layer, n) { const ls = layerOf(layer); if (ls.catN !== (n || 0)) { ls.catN = n || 0; needClear = true; } },
    // stick thickness (world metres) — a live per-layer knob
    setLayerStickRadius(layer, r) { const ls = layerOf(layer); const v = Math.max(0.05, +r || 1); if (ls.stickRadius !== v) { ls.stickRadius = v; needClear = true; } },
    layerStickRadius(layer) { return layerOf(layer).stickRadius; },
    layerChanRange(layer) { const ls = layers.get(layer); return ls && ls.docChan[0] !== Infinity ? [ls.docChan[0], ls.docChan[1]] : null; },
    // per-layer section participation: an exempt layer draws (and picks) whole
    // while the others are slabbed — e.g. topo kept for context during sectioning
    setLayerSectioned(layer, on) { const ls = layerOf(layer); const v = on !== false; if (ls.sectioned !== v) { ls.sectioned = v; needClear = true; } },
    layerSectioned(layer) { return layerOf(layer).sectioned !== false; },
    // context-mesh style: tint [r,g,b] 0..1 + opacity 0..1 (Bayer screen-door)
    setLayerMeshStyle(layer, { tint, opacity } = {}) {
      const ls = layerOf(layer);
      if (tint) ls.meshTint = tint;
      if (opacity != null) ls.meshOpacity = Math.max(0.02, Math.min(1, +opacity));
      needClear = true;
    },
    layerMeshStyle(layer) { const ls = layerOf(layer); return { tint: ls.meshTint, opacity: ls.meshOpacity }; },
    // per-layer SELECTION bitmask (spec §15): same texture shape as the filter
    // mask; selected elements get a warm tint in every element program
    setLayerSelection(layer, mask) {
      const ls = layerOf(layer);
      if (!mask) {
        if (ls.selTex) { gl.deleteTexture(ls.selTex); ls.selTex = null; ls.selH = 0; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(mask.length / W));
        const padded = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) padded[i] = mask[i] ? 255 : 0;
        if (ls.selTex && H === ls.selH) {
          gl.bindTexture(gl.TEXTURE_2D, ls.selTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (ls.selTex) gl.deleteTexture(ls.selTex);
          ls.selTex = gl.createTexture(); ls.selH = H;
          gl.bindTexture(gl.TEXTURE_2D, ls.selTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    // per-layer RULE CODES (spec §10.4): one byte per record — which styling
    // rule claimed it (0 = none/else, 1..255 = rule order). Same texture shape
    // as the filter mask, but the byte is a VALUE, not a bit: in rule mode it
    // substitutes for the class code, so the palette, the per-class eyes, and
    // pick culling all compose without new machinery.
    setLayerRuleCodes(layer, codes) {
      const ls = layerOf(layer);
      if (!codes) {
        if (ls.ruleTex) { gl.deleteTexture(ls.ruleTex); ls.ruleTex = null; ls.ruleH = 0; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(codes.length / W));
        const padded = new Uint8Array(W * H);
        padded.set(codes);
        if (ls.ruleTex && H === ls.ruleH) {
          gl.bindTexture(gl.TEXTURE_2D, ls.ruleTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (ls.ruleTex) gl.deleteTexture(ls.ruleTex);
          ls.ruleTex = gl.createTexture(); ls.ruleH = H;
          gl.bindTexture(gl.TEXTURE_2D, ls.ruleTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    // rule mode on/off per layer — kept separate from the codes so switching
    // categorized ⇄ rule-based is a flag flip, no re-upload
    setLayerRuleMode(layer, on) {
      const ls = layerOf(layer);
      if (ls.ruleOn !== !!on) { ls.ruleOn = !!on; needClear = true; }
    },
    // per-layer CATEGORY palette (legend colors/groups baked app-side).
    // pixels = Uint8Array(width*4) RGBA (width 256 for dict layers, 32 for LAS
    // classification — it must match what uPaletteN samples), null = built-ins.
    setLayerPalette(layer, pixels, width = 256) {
      const ls = layerOf(layer);
      if (!pixels) {
        if (ls.paletteTex) { gl.deleteTexture(ls.paletteTex); ls.paletteTex = null; ls.paletteW = 0; }
      } else if (!ls.paletteTex || ls.paletteW !== width) {
        if (ls.paletteTex) gl.deleteTexture(ls.paletteTex);
        ls.paletteTex = lutTexture(gl, pixels, width);
        ls.paletteW = width;
      } else {
        gl.bindTexture(gl.TEXTURE_2D, ls.paletteTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
      needClear = true;
    },
    // per-layer color ramp LUT (layer properties: presets + baked breakpoints).
    // pixels = Uint8Array(256*4) RGBA, or null to fall back to the built-in ramp.
    setLayerRamp(layer, pixels) {
      const ls = layerOf(layer);
      if (!pixels) {
        if (ls.rampTex) { gl.deleteTexture(ls.rampTex); ls.rampTex = null; }
      } else if (!ls.rampTex) {
        ls.rampTex = lutTexture(gl, pixels, 256);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, ls.rampTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
      needClear = true;
    },
    // per-CLASS visibility (layer properties): vis = Uint8Array(256) of 0|1, or
    // null to clear. GPU-side — the class code already rides every element as
    // an attribute, so eyes are a texture update: no sweeps, any element count.
    // Composes with the filter mask (both are cull paths); hidden classes
    // don't pick either (gl-pick reads the same texture).
    setLayerCatVisibility(layer, vis) {
      const ls = layerOf(layer);
      if (!vis) {
        if (ls.catVisTex) { gl.deleteTexture(ls.catVisTex); ls.catVisTex = null; }
      } else {
        const px = new Uint8Array(256);
        for (let i = 0; i < 256; i++) px[i] = vis[i] ? 255 : 0;
        if (!ls.catVisTex) {
          ls.catVisTex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, ls.catVisTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, px);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        } else {
          gl.bindTexture(gl.TEXTURE_2D, ls.catVisTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, px);
        }
      }
      needClear = true;
    },
    setLayerVisible(layer, on) {
      const ls = layerOf(layer);
      if (ls.visible !== !!on) { ls.visible = !!on; needClear = true; }
    },
    removeLayer(layer) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (chunks[i]._layer !== layer) continue;
        freeChunk(chunks[i]);
        chunks.splice(i, 1);
      }
      const ls = layers.get(layer);
      if (ls && ls.maskTex) gl.deleteTexture(ls.maskTex);
      if (ls && ls.catVisTex) gl.deleteTexture(ls.catVisTex);
      if (ls && ls.rampTex) gl.deleteTexture(ls.rampTex);
      if (ls && ls.paletteTex) gl.deleteTexture(ls.paletteTex);
      if (ls && ls.selTex) gl.deleteTexture(ls.selTex);
      if (ls && ls.ruleTex) gl.deleteTexture(ls.ruleTex);
      layers.delete(layer);
      needClear = true;
    },
    layerElementCount(layer) {
      const ls = layers.get(layer);
      if (!ls) return 0;
      return chunks.reduce((s, c) => s + (c._layer === layer && c._set === ls.set ? c.count : 0), 0);
    },
    invalidate() { needClear = true; },
    // Pick/unpick over a CONVERGED frame repaints just the affected elements
    // (a depth-LEQUAL pass where everything else clips out) instead of
    // restarting the accumulation — same total vertex work, none of the
    // de-densify blink. Mid-accumulation falls back to the clear.
    setPicked(rec) {
      const next = rec == null ? 0xFFFFFFFF : rec >>> 0;
      if (next === pickedRec) return;
      const prev = pickedRec;
      pickedRec = next;
      if (lastConverged && !needClear) {
        if (prev !== 0xFFFFFFFF) repaintSet.add(prev);
        if (next !== 0xFFFFFFFF) repaintSet.add(next);
        if (repaintSet.size > 2) { repaintSet.clear(); needClear = true; }   // rapid multi-pick: one redraw is cheaper
      } else needClear = true;
    },
    // GPU pick at CSS coordinates → PARTITIONED record id | null. Draws each
    // visible layer's accumulated prefix into a scissored offscreen target with
    // the record id as the color (gl-pick.js) — you pick exactly what you see.
    // marquee/lasso support (spec §15): render the ID buffer once over a CSS
    // rect and hand back the raw pixels — the app polygon-masks and decodes.
    pickRegion(cssRect, cam, { pointPx = 2.5, blocksAsPoints = false, section = null } = {}) {
      if (!chunks.length) return null;
      if (!pickPipe) pickPipe = createPickPipeline(gl);
      const dpr = window.devicePixelRatio || 1;
      const x = Math.max(0, Math.round(cssRect.x * dpr));
      const yTop = Math.round(cssRect.y * dpr);
      const w = Math.min(canvas.width - x, Math.round(cssRect.w * dpr));
      const h = Math.min(canvas.height, Math.round(cssRect.h * dpr));
      const y = Math.max(0, canvas.height - yTop - h);
      if (w <= 0 || h <= 0) return null;
      const data = pickPipe.pickRegion(x, y, w, h, chunks.filter(activeChunk), cam, {
        pointPx, blocksAsPoints, layerStates: layers,
        section: section && section.on ? section : null,
        viewportW: canvas.width, viewportH: canvas.height,
      });
      return { data, w, h, dpr };                          // rows bottom-up (GL), NO_HIT = 0xFFFFFFFF
    },
    pick(cssX, cssY, cam, { pointPx = 2.5, blocksAsPoints = false, section = null } = {}) {
      if (!chunks.length) return null;
      if (!pickPipe) pickPipe = createPickPipeline(gl);
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(cssX * dpr), py = Math.round(canvas.height - cssY * dpr - 1);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
      return pickPipe.pick(px, py, chunks.filter(activeChunk), cam, {
        pointPx, blocksAsPoints, layerStates: layers,
        section: section && section.on ? section : null,
        viewportW: canvas.width, viewportH: canvas.height,
      });
    },
    clearChunks() {
      for (const c of chunks) freeChunk(c);
      chunks.length = 0; needClear = true;
      for (const ls of layers.values()) { if (ls.maskTex) gl.deleteTexture(ls.maskTex); if (ls.catVisTex) gl.deleteTexture(ls.catVisTex); if (ls.rampTex) gl.deleteTexture(ls.rampTex); if (ls.paletteTex) gl.deleteTexture(ls.paletteTex); if (ls.selTex) gl.deleteTexture(ls.selTex); if (ls.ruleTex) gl.deleteTexture(ls.ruleTex); }
      layers.clear();
    },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needClear = true; }
      return [w, h];
    },
    // Draw one frame into the CURRENT framebuffer (the EDL pass owns the target).
    // opts.layerOpts = { [id]: { colorMode, clip } } overrides the global color
    // opts per layer (absent → the globals, so single-layer callers are unchanged).
    // Returns { drawn, converged, visible }.
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0, blocksAsPoints = false, section = null, clip = null, layerOpts = null } = {}) {
      const vp = cam.state.viewProj;
      const sec = section && section.on ? section : null;
      const secKey = sec ? `${sec.n.join(',')}|${sec.d}|${sec.half}` : 'off';
      const clipKey = clip ? `${clip[0]}~${clip[1]}` : 'a';
      const loKey = layerOpts ? JSON.stringify(layerOpts) : '';
      const key = `${pointPx}|${colorMode}|${blocksAsPoints ? 'P' : 'B'}|${secKey}|${clipKey}|${loKey}|${canvas.width}x${canvas.height}`;
      const moving = vpChanged(vp) || key !== lastKey || needClear;
      lastKey = key; needClear = false;
      if (moving) repaintSet.clear();                      // the full redraw covers any pending repaint

      // frustum-cull + front-to-back over chunk bboxes (tight, thanks to Morton)
      const planes = frustumPlanes(vp);
      const eye = cam.state.eye;
      const visible = [];
      const padBox = new Float64Array(6);
      for (const c of chunks) {
        if (!activeChunk(c)) continue;
        let cullBox = c.bboxLocal;
        if (c.kind === 'sticks') {
          const r = layerOf(c._layer).stickRadius;
          for (let i = 0; i < 3; i++) { padBox[i] = c.bboxLocal[i] - r; padBox[i + 3] = c.bboxLocal[i + 3] + r; }
          cullBox = padBox;
        }
        if (!aabbInFrustum(planes, cullBox)) { if (moving) c.cursor = 0; continue; }
        const b = c.bboxLocal;
        const cx = (b[0] + b[3]) / 2 - eye[0], cy = (b[1] + b[4]) / 2 - eye[1], cz = (b[2] + b[5]) / 2 - eye[2];
        const dist = Math.max(Math.hypot(cx, cy, cz), cam.state.near);
        const r = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 || 1;
        c._dist = dist;
        c._w = Math.min(1, (r / dist) * (r / dist));       // projected-area weight
        visible.push(c);
      }
      visible.sort((a, b) => a._dist - b._dist);           // front-to-back
      lastVisible = visible.length;
      const sumW = visible.reduce((s, c) => s + c._w, 0) || 1;

      gl.enable(gl.DEPTH_TEST);
      if (moving) {
        gl.clearColor(background[0], background[1], background[2], background[3]);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        for (const c of visible) c.cursor = 0;
      }

      const db = docBbox || Float64Array.of(0, 0, 0, 1, 1, 1);
      // per-layer view opts (color mode + clip); the globals when not overridden
      const lopt = (id) => (layerOpts && layerOpts[id]) || { colorMode, clip };
      // elevation ramp = the SCENE z range (layers share vertical space) + clip
      const zRangeOf = (o) => {
        const zLo = o.clip && o.clip[0] != null && o.colorMode === 0 ? o.clip[0] : db[2];
        const zHi = o.clip && o.clip[1] != null && o.colorMode === 0 ? o.clip[1] : db[5];
        return [zLo, Math.max(zHi - zLo, 1e-6)];
      };
      // this frame's allotment per chunk: budget share by projected weight, floored
      // so distant chunks keep a sparse presence (coarse prefix always on)
      const allot = (c) => {
        const share = Math.max(Math.min(c.count, 1000), Math.floor(budget * (c._w / sumW)));
        const first = moving ? 0 : c.cursor;
        return [first, Math.min(c.count - first, share)];
      };
      let drawn = 0, converged = true;
      // pending pick repaint: one extra full-geometry pass at depth LEQUAL —
      // lands exactly on the element's already-accumulated pixels
      const rp = !moving && repaintSet.size
        ? [...repaintSet, 0xFFFFFFFF, 0xFFFFFFFF].slice(0, 2).map((v) => v >>> 0) : null;

      // context meshes first: static occluders drawn WHOLE on clear frames (or
      // when freshly streamed in) — early-z then rejects points behind them.
      // On still frames their cursor == count, so accumulation skips them.
      const msh = visible.filter((c) => c.kind === 'mesh');
      if (msh.length) {
        for (const [id, group] of byLayer(msh)) {
          if (!group.some((c) => moving || c.cursor === 0)) continue;
          const ls = layerOf(id);
          meshPipe.begin(cam, { tint: ls.meshTint, opacity: ls.meshOpacity, section: ls.sectioned === false ? null : sec });
          for (const c of group) {
            if (!(moving || c.cursor === 0)) continue;
            meshPipe.draw(c);
            c.cursor = c.count;
            drawn += c.count;
          }
        }
        gl.bindVertexArray(null);
      }

      // streaming-tier meshes: budgeted prefixes like points (the shuffle makes
      // any prefix a uniform subsample of the soup), drawn before points so the
      // surface occludes early
      const soup = visible.filter((c) => c.kind === 'soup');
      if (soup.length) {
        for (const [id, group] of byLayer(soup)) {
          const ls = layerOf(id);
          soupPipe.begin(cam, { tint: ls.meshTint, opacity: ls.meshOpacity, section: ls.sectioned === false ? null : sec });
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              soupPipe.drawSlice(c, first, k);
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        gl.bindVertexArray(null);
      }

      const pts = visible.filter((c) => c.kind === 'points');
      if (pts.length) {
        const ptsGroups = byLayer(pts);
        gl.useProgram(prog);
        gl.uniformMatrix4fv(uni.viewProj, false, vp);
        gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
        gl.uniform1ui(uni.picked, pickedRec);
        gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
        // per-layer uniforms + slices (front-to-back preserved within each group)
        const setupPtsLayer = (id) => {
          const ls = layerOf(id), o = lopt(id), zr = zRangeOf(o);
          const lsec = ls.sectioned === false ? null : sec;
          gl.uniform4f(uni.secPlane, lsec ? lsec.n[0] : 0, lsec ? lsec.n[1] : 0, lsec ? lsec.n[2] : 1, lsec ? lsec.d : 0);
          gl.uniform2f(uni.secCfg, lsec ? 1 : 0, lsec ? lsec.half : 0);
          gl.uniform1i(uni.colorMode, o.colorMode);
          gl.uniform2f(uni.zRange, zr[0], zr[1]);
          gl.uniform1f(uni.intensityScale, 65535 / (ls.intensityMax || 1));
          gl.uniform1f(uni.paletteN, ls.paletteTex ? ls.paletteW : (ls.catN || 32));
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ls.paletteTex || (ls.catN && catPalette ? catPalette : palette));
          gl.uniform1i(uni.palette, 1);
          gl.uniform1f(uni.filterOn, ls.maskTex ? 1 : 0);
          gl.uniform1f(uni.isolate, ls.isolate ? 1 : 0);
          if (ls.maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, ls.maskTex); gl.uniform1i(uni.mask, 4); }
          gl.uniform1f(uni.catVisOn, ls.catVisTex ? 1 : 0);
          if (ls.catVisTex) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, ls.catVisTex); gl.uniform1i(uni.catVis, 5); }
          gl.uniform1f(uni.selOn, ls.selTex ? 1 : 0);
          if (ls.selTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, ls.selTex); gl.uniform1i(uni.sel, 6); }
          gl.uniform1f(uni.ruleOn, ls.ruleOn && ls.ruleTex ? 1 : 0);
          if (ls.ruleOn && ls.ruleTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, ls.ruleTex); gl.uniform1i(uni.rule, 7); }
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ls.rampTex || ramp); gl.uniform1i(uni.ramp, 0);
        };
        for (const [id, group] of ptsGroups) {
          setupPtsLayer(id);
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
              gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
              gl.bindVertexArray(c.vao);
              gl.drawArrays(gl.POINTS, first, k);
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        if (rp) {
          gl.depthFunc(gl.LEQUAL);
          gl.uniform2ui(uni.repaint, rp[0], rp[1]);
          for (const [id, group] of ptsGroups) {
            setupPtsLayer(id);
            for (const c of group) {
              gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
              gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
              gl.bindVertexArray(c.vao);
              gl.drawArrays(gl.POINTS, 0, c.count);
            }
          }
          gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
          gl.depthFunc(gl.LESS);
        }
      }

      const blks = visible.filter((c) => c.kind === 'blocks');
      if (blks.length) {
        const blkGroups = byLayer(blks);
        const perspScale = (canvas.height / 2) / Math.tan(cam.state.fovY / 2);
        const cheapOf = (c) => {
          // the whole chunk below the demotion threshold → the cheap program
          // (no gl_FragDepth → early-z stays on): the far-field perf lever
          const b = c.bboxLocal;
          const bboxR = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
          const rBlock = Math.hypot(c.grid.size[0], c.grid.size[1], c.grid.size[2]) / 2;
          const distNear = Math.max(cam.state.near, c._dist - bboxR);
          return blocksAsPoints || rBlock * perspScale / distNear < 2.0;
        };
        const beginLayer = (id) => {
          const ls = layerOf(id), o = lopt(id);
          const cLo = o.clip && o.clip[0] != null && o.colorMode === 1 ? o.clip[0] : (ls.docChan[0] === Infinity ? 0 : ls.docChan[0]);
          const cHi = o.clip && o.clip[1] != null && o.colorMode === 1 ? o.clip[1] : ls.docChan[1];
          blocksPipe.begin(cam, {
            pointPx, colorMode: o.colorMode, zRange: zRangeOf(o),
            chanDoc: [cLo, cHi > cLo ? cHi - cLo : 1],
            ramp: ls.rampTex || ramp, palette: ls.paletteTex || catPalette || palette, viewportH: canvas.height,
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec,
            section: ls.sectioned === false ? null : sec,
            catVisTex: ls.catVisTex, selTex: ls.selTex, ruleTex: ls.ruleOn ? ls.ruleTex : null,
          });
        };
        for (const [id, group] of blkGroups) {
          beginLayer(id);
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              blocksPipe.drawSlice(c, first, k, cheapOf(c));
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        if (rp) {
          gl.depthFunc(gl.LEQUAL);
          for (const [id, group] of blkGroups) {
            beginLayer(id);                                // begin resets uRepaint — set it after, per layer
            blocksPipe.setRepaint(rp[0], rp[1]);
            for (const c of group) blocksPipe.drawSlice(c, 0, c.count, cheapOf(c));
          }
          blocksPipe.setRepaint(0xFFFFFFFF, 0xFFFFFFFF);
          gl.depthFunc(gl.LESS);
        }
      }
      const stks = visible.filter((c) => c.kind === 'sticks');
      if (stks.length) {
        const stkGroups = byLayer(stks);
        const perspScale2 = cam.state.ortho ? (canvas.height / 2) / cam.state.halfH : (canvas.height / 2) / Math.tan(cam.state.fovY / 2);
        const cheapOf2 = (c) => {
          // whole chunk under the demotion threshold → the no-fragdepth program
          const ls = layerOf(c._layer);
          const b = c.bboxLocal;
          const bboxR = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
          const distNear = Math.max(cam.state.near, c._dist - bboxR);
          // a generous per-chunk proxy: the layer radius at the chunk's nearest point
          return blocksAsPoints || (ls.stickRadius * 4) * perspScale2 / (cam.state.ortho ? 1 : distNear) < 2.0;
        };
        const beginStkLayer = (id) => {
          const ls = layerOf(id), o = lopt(id);
          const cLo = o.clip && o.clip[0] != null && o.colorMode === 1 ? o.clip[0] : (ls.docChan[0] === Infinity ? 0 : ls.docChan[0]);
          const cHi = o.clip && o.clip[1] != null && o.colorMode === 1 ? o.clip[1] : ls.docChan[1];
          sticksPipe.begin(cam, {
            pointPx, colorMode: o.colorMode, zRange: zRangeOf(o),
            chanDoc: [cLo, cHi > cLo ? cHi - cLo : 1],
            ramp: ls.rampTex || ramp, palette: ls.paletteTex || catPalette || palette, viewportH: canvas.height,
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec,
            section: ls.sectioned === false ? null : sec,
            radius: ls.stickRadius, catVisTex: ls.catVisTex, selTex: ls.selTex, ruleTex: ls.ruleOn ? ls.ruleTex : null,
          });
        };
        for (const [id, group] of stkGroups) {
          beginStkLayer(id);
          for (const c of group) {
            const [first, k] = allot(c);
            if (k > 0) {
              sticksPipe.drawSlice(c, first, k, cheapOf2(c));
              drawn += k; c.cursor = first + k;
            }
            if (c.cursor < c.count) converged = false;
          }
        }
        if (rp) {
          gl.depthFunc(gl.LEQUAL);
          for (const [id, group] of stkGroups) {
            beginStkLayer(id);
            sticksPipe.setRepaint(rp[0], rp[1]);
            for (const c of group) sticksPipe.drawSlice(c, 0, c.count, cheapOf2(c));
          }
          sticksPipe.setRepaint(0xFFFFFFFF, 0xFFFFFFFF);
          gl.depthFunc(gl.LESS);
        }
      }
      if (rp) repaintSet.clear();
      lastConverged = converged;
      gl.bindVertexArray(null);
      return { drawn, converged, visible: lastVisible };
    },
  };
}

// ── src/edl.js ──

// @gcu/condenser — Eye-Dome Lighting post-pass (Boucheny 2009 / Ribes & Boucheny).
// The scene renders into an offscreen framebuffer (color + depth texture); a
// fullscreen pass compares each pixel's log-linear depth against its neighbors
// and darkens where neighbors are closer — unlit points read as a surface.
// Mandatory in M1 (micro-spec §2.2): without it a point cloud reads as noise.


const QUAD_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {                          // fullscreen triangle, no buffers
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const EDL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uTexel;                   // 1/size
uniform vec2 uNearFar;
uniform float uOrtho;                  // 1 = orthographic (depth is already linear)
uniform float uStrength;               // 0 = off-look, ~1 default
uniform float uRadius;                 // sample radius in pixels
out vec4 outColor;

float linDepth(float d) {              // depth buffer -> linear eye-space z
  float n = uNearFar.x, f = uNearFar.y;
  if (uOrtho > 0.5) return n + d * (f - n);
  return (2.0 * n * f) / (f + n - (d * 2.0 - 1.0) * (f - n));
}
void main() {
  vec4 col = texture(uColor, vUv);
  float d = texture(uDepth, vUv).r;
  if (d >= 1.0) { outColor = col; return; }              // background: untouched
  float zc = log2(max(linDepth(d), 1e-6));
  float ob = 0.0;
  const vec2 DIRS[8] = vec2[8](vec2(1.,0.), vec2(-1.,0.), vec2(0.,1.), vec2(0.,-1.),
                               vec2(.7,.7), vec2(-.7,.7), vec2(.7,-.7), vec2(-.7,-.7));
  for (int i = 0; i < 8; i++) {
    float dn = texture(uDepth, vUv + DIRS[i] * uTexel * uRadius).r;
    float zn = dn >= 1.0 ? zc + 4.0 : log2(max(linDepth(dn), 1e-6));   // background neighbor = far
    ob += max(0.0, zc - zn);
  }
  float shade = exp(-uStrength * 60.0 * ob / 8.0);
  outColor = vec4(col.rgb * shade, col.a);
}`;

function createEdl(gl) {
  const prog = makeProgram(gl, QUAD_VERT, EDL_FRAG);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = { color: U('uColor'), depth: U('uDepth'), texel: U('uTexel'), nearFar: U('uNearFar'), ortho: U('uOrtho'), strength: U('uStrength'), radius: U('uRadius') };
  let fbo = null, colorTex = null, depthTex = null, w = 0, h = 0;

  function ensure(width, height) {
    if (width === w && height === h && fbo) return;
    w = width; h = height;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(colorTex); gl.deleteTexture(depthTex); }
    const tex = (ifmt, fmt, type) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    colorTex = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    depthTex = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  return {
    // Render `sceneDraw()` through the EDL pipeline onto the default framebuffer.
    // ALWAYS goes via the FBO — progressive accumulation (§2.2) needs a persistent
    // depth buffer, which the default framebuffer doesn't guarantee; EDL-disabled
    // is strength 0 (exp(0) ≡ passthrough), so there's exactly one path.
    render(width, height, cam, sceneDraw, { enabled = true, strength = 1.0, radius = 1.4 } = {}) {
      ensure(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      const result = sceneDraw();                          // the splat pass, into the FBO (may draw 0 when converged)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, colorTex); gl.uniform1i(uni.color, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, depthTex); gl.uniform1i(uni.depth, 3);
      gl.uniform2f(uni.texel, 1 / w, 1 / h);
      gl.uniform2f(uni.nearFar, cam.state.near, cam.state.far);
      gl.uniform1f(uni.ortho, cam.state.ortho ? 1 : 0);
      gl.uniform1f(uni.strength, enabled ? strength : 0);
      gl.uniform1f(uni.radius, radius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      return result;
    },
  };
}

// ── src/main.js ──

// @gcu/condenser — streaming no-preprocess renderer for massive spatial elements.
// The engine under micro (the scope over lamina's slide). Curated public surface.

export {
  LasFormatError,
  parseLasHeader,
  decodeLasRecords,
  openLas,
  mulberry32,
  shuffledIndices,
  shuffleInPlace,
  documentFrame,
  buildChunk,
  chunkLocalPosition,
  createChunkBuilder,
  part1by2,
  mortonKey,
  mortonKeys,
  radixSortIndices,
  inferAxis,
  makeBlockGrid,
  buildBlockChunk,
  blockLocalCenter,
  createBlockChunkBuilder,
  floatGcd,
  axisMap,
  gridsCompatible,
  makeResampler,
  commonLattice,
  sniffDelimited,
  mapColumns,
  openBlockModel,
  lineFields,
  fetchDelimitedRecord,
  classifyDrillholeHeader,
  sniffDrillholeFiles,
  readDelimited,
  openDrillholes,
  buildStickChunk,
  stickLocalCenter,
  createStickChunkBuilder,
  createSticksPipeline,
  openMsh,
  openObj,
  openPlyMesh,
  buildMeshChunk,
  createMeshPipeline,
  buildSoupChunk,
  soupLocalCentroid,
  createSoupChunkBuilder,
  soupFromMesh,
  openPlySoup,
  createSoupPipeline,
  categoryPalettePixels,
  createBlocksPipeline,
  createPickPipeline,
  openDmModel,
  fetchDmRecord,
  parsePlyHeader,
  openPly,
  mat4Perspective,
  mat4Ortho,
  mat4LookAt,
  mat4Multiply,
  transformPoint,
  frustumPlanes,
  aabbInFrustum,
  createOrbitCamera,
  attachOrbitInput,
  makeProgram,
  rampPixels,
  palettePixels,
  uploadChunk,
  createRenderer,
  createEdl,
};
