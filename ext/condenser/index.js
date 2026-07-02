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


const X_RE = /^(x|xc|xcent(er|re)?|xmid|east(ing)?|xworld|centroid_?x)$/i;
const Y_RE = /^(y|yc|ycent(er|re)?|ymid|north(ing)?|yworld|centroid_?y)$/i;
const Z_RE = /^(z|zc|zcent(er|re)?|zmid|elev(ation)?|rl|level|zworld|centroid_?z)$/i;
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
  const x = find(X_RE), y = find(Y_RE), z = find(Z_RE);
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

const CAP_DISTINCT = 300000;                               // per-axis discovery cap

async function openBlockModel(blob, { mapping = null, sample = 512 * 1024, signal, onProgress } = {}) {
  const head = await blob.slice(0, Math.min(sample, blob.size)).text();
  const sniff = sniffDelimited(head);
  const map = mapping || mapColumns(sniff.header);
  if (!map) throw new Error('blockmodel: could not identify X/Y/Z centroid columns — pass a mapping');

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
  for await (const batch of lineFields(blob, sniff.delim, !!sniff.header, { signal, onProgress })) {
    for (const f of batch) {
      const xv = +f[map.x], yv = +f[map.y], zv = +f[map.z];
      if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
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
    delim: sniff.delim,                                     // for external sweeps (the filter mask)
    numericColumns,
    categories,
    attributes: [
      ...(map.chan != null && sniff.header ? [sniff.header[map.chan]] : []),
      ...(categories && sniff.header ? [sniff.header[catCol]] : []),
    ],
  };

  // ── sweep 2 (cold recipe): full RawChunks, yielded as buffers fill ──
  async function* streamChunks({ chunkPoints = 1 << 18, signal: s2, onProgress: op2 } = {}) {
    const alloc = () => ({ x: new Float64Array(chunkPoints), y: new Float64Array(chunkPoints), z: new Float64Array(chunkPoints), chan: new Float64Array(chunkPoints), cat: catCode ? new Uint8Array(chunkPoints) : null });
    let buf = alloc(), fill = 0, recStart = 0;
    for await (const batch of lineFields(blob, sniff.delim, !!sniff.header, { signal: s2, onProgress: op2 })) {
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
  }

  return { header, streamChunks };
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
uniform float uForceSplat;              // 1 = whole chunk demoted (cheap far-field path)
uniform float uFixedSplat;              // 1 = points view: fixed-px splats regardless of block size
uniform uint uPicked;                   // record index to highlight (0xFFFFFFFF = none)
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
    int rec = int(aRec);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;   // centroid-in-slab
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
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
    vColor = texture(uPalette, vec2((aCat + 0.5) / 256.0, 0.5));
  } else {
    vColor = vec4(0.62, 0.63, 0.66, 1.0);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching (still legible)
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
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
const FRAG_CHEAP = `#version 300 es
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
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), forceSplat: U('uForceSplat'), fixedSplat: U('uFixedSplat'), picked: U('uPicked'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      ortho: U('uOrtho'), fwd: U('uFwd'), orthoRay: U('uOrthoRay'), backoff: U('uBackoff'),
    } };
  };
  const full = mkProg(FRAG$gl_blocks), cheap = mkProg(FRAG_CHEAP);
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
  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, section = null }) {
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
      gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
      gl.uniform1f(uni.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uni.isolate, isolate ? 1 : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uni.mask, 4); }
    }
    active = full;
    gl.useProgram(full.prog);
  }

  return { upload, drawSlice, begin };
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
layout(location=4) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
flat out uint vRec;
flat out float vCull;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  vRec = aRec;
  vCull = (uSecCfg.x > 0.5 && abs(dot(p, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
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
layout(location=3) in uint aRec;
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform float uPerspScale, uDemotePx, uPointPx, uFixedSplat, uOrtho;
uniform sampler2D uMask;
uniform float uFilterOn, uIsolate;
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
    int rec = int(aRec);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);   // hidden (isolated or sectioned) isn't pickable
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

const NO_HIT = 0xFFFFFFFF;                                 // the clear color decodes to this

function createPickPipeline(gl) {
  const pts = makeProgram(gl, PICK_VERT_PTS, PICK_FRAG_PTS);
  const blk = makeProgram(gl, PICK_VERT_BLK, PICK_FRAG_BLK);
  const U = (p, n) => gl.getUniformLocation(p, n);
  const uPts = { viewProj: U(pts, 'uViewProj'), boxMin: U(pts, 'uBoxMin'), boxSpan: U(pts, 'uBoxSpan'), pointPx: U(pts, 'uPointPx'), secPlane: U(pts, 'uSecPlane'), secCfg: U(pts, 'uSecCfg') };
  const uBlk = {
    viewProj: U(blk, 'uViewProj'), eye: U(blk, 'uEye'), right: U(blk, 'uRight'), up: U(blk, 'uUp'),
    gridOrigin: U(blk, 'uGridOrigin'), gridSize: U(blk, 'uGridSize'),
    perspScale: U(blk, 'uPerspScale'), demotePx: U(blk, 'uDemotePx'), pointPx: U(blk, 'uPointPx'), fixedSplat: U(blk, 'uFixedSplat'),
    ortho: U(blk, 'uOrtho'), fwd: U(blk, 'uFwd'), orthoRay: U(blk, 'uOrthoRay'), backoff: U(blk, 'uBackoff'),
    mask: U(blk, 'uMask'), filterOn: U(blk, 'uFilterOn'), isolate: U(blk, 'uIsolate'),
    secPlane: U(blk, 'uSecPlane'), secCfg: U(blk, 'uSecCfg'),
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
  function pick(px, py, chunks, cam, { pointPx, blocksAsPoints = false, maskTex = null, isolate = false, section = null, viewportW, viewportH }) {
    const setSec = (u) => {
      gl.uniform4f(u.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(u.secCfg, section ? 1 : 0, section ? section.half : 0);
    };
    ensure(viewportW, viewportH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px, py, 1, 1);
    gl.clearColor(1, 1, 1, 1);                             // decodes to NO_HIT
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const s = cam.state;
    const dpp = pointPx * (window.devicePixelRatio || 1);

    const ptsChunks = chunks.filter((c) => c.kind !== 'blocks' && c.cursor > 0);
    if (ptsChunks.length) {
      gl.useProgram(pts);
      gl.uniformMatrix4fv(uPts.viewProj, false, s.viewProj);
      gl.uniform1f(uPts.pointPx, dpp);
      setSec(uPts);
      for (const c of ptsChunks) {
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
      gl.uniform1f(uBlk.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uBlk.isolate, isolate ? 1 : 0);
      setSec(uBlk);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uBlk.mask, 4); }
      for (const c of blkChunks) {
        gl.bindVertexArray(c.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.uniform3f(uBlk.gridOrigin, c.grid.originLocal[0], c.grid.originLocal[1], c.grid.originLocal[2]);
        gl.uniform3f(uBlk.gridSize, c.grid.size[0], c.grid.size[1], c.grid.size[2]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.cursor);
      }
    }

    gl.disable(gl.SCISSOR_TEST);
    const px4 = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    const rec = (px4[0] | (px4[1] << 8) | (px4[2] << 16) | (px4[3] << 24)) >>> 0;
    return rec === NO_HIT ? null : rec;
  }

  return { pick };
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
  let mode = null, lx = 0, ly = 0;
  const down = (e) => {
    mode = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
    lx = e.clientX; ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    if (!mode) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    if (mode === 'orbit') cam.orbit(-dx * 0.006, dy * 0.006);
    else cam.pan(dx, dy, canvas.clientHeight);
    if (onChange) onChange();
  };
  const up = (e) => { mode = null; try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ } };
  const wheel = (e) => { e.preventDefault(); cam.dolly(Math.pow(1.0015, e.deltaY)); if (onChange) onChange(); };
  const ctx = (e) => e.preventDefault();
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', ctx);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
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
uniform vec4 uSecPlane;                 // section plane: xyz = unit normal, w = offset (frame-local)
uniform vec2 uSecCfg;                   // x: 0 = off, 1 = slab; y: slab half-thickness
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 intensity | 2 classification | 3 rgb
uniform vec2 uZRange;                   // document local z min/span (elevation ramp)
uniform float uIntensityScale;          // 1 / (p98-ish max, normalized units)
uniform sampler2D uRamp;                // 256x1 continuous ramp
uniform sampler2D uPalette;             // 32x1 classification palette
out vec4 vColor;
flat out float vCull;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
  vCull = (uSecCfg.x > 0.5 && abs(dot(p, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y) ? 1.0 : 0.0;
  if (uColorMode == 0) {
    float t = clamp((p.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    float t = clamp(aIntensity * uIntensityScale, 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((aClass + 0.5) / 32.0, 0.5));
  } else {
    vColor = vec4(aRgb, 1.0);
  }
  if (aRec == uPicked) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
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
  return { vao, buffers, count: chunk.count, bboxLocal: chunk.bboxLocal, cursor: 0 };
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
    intensityScale: U('uIntensityScale'), ramp: U('uRamp'), palette: U('uPalette'), picked: U('uPicked'),
    secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
  };
  const ramp = lutTexture(gl, rampPixels(), 256);
  const palette = lutTexture(gl, palettePixels(), 32);   // LAS classification (points)
  let catPalette = null;                                  // category palette (blocks), lazy
  let blocksPipe = null;                                  // impostor pipeline, lazy
  let pickPipe = null;                                    // ID-buffer pick pipeline, lazy
  const chunks = [];
  let docBbox = null, intensityMax = 1;
  const docChan = [Infinity, -Infinity];                  // block grade range across chunks
  let maskTex = null, maskH = 0, isolateMode = false;     // filter bitmask (by record index)
  let pickedRec = 0xFFFFFFFF;                             // highlighted record (sentinel = none)
  // accumulation state
  const lastVP = new Float32Array(16);
  let lastKey = '', needClear = true, lastVisible = 0;

  const vpChanged = (vp) => {
    for (let i = 0; i < 16; i++) if (vp[i] !== lastVP[i]) { lastVP.set(vp); return true; }
    return false;
  };

  return {
    gl,
    get chunkCount() { return chunks.length; },
    get elementCount() { return chunks.reduce((s, c) => s + c.count, 0); },
    get accumulated() { return chunks.reduce((s, c) => s + c.cursor, 0); },   // elements in the current accumulation
    addChunk(chunk) {
      if (chunk.kind === 'blocks') {
        if (!blocksPipe) blocksPipe = createBlocksPipeline(gl);
        chunks.push(blocksPipe.upload(chunk));             // GPU owns it now
        if (chunk.chanRange[0] < docChan[0]) docChan[0] = chunk.chanRange[0];
        if (chunk.chanRange[1] > docChan[1]) docChan[1] = chunk.chanRange[1];
        return;
      }
      chunks.push(uploadChunk(gl, chunk));                 // GPU owns it now; CPU copy dies with the caller
      let m = 0; const a = chunk.intensity;
      for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
      intensityMax = Math.max(intensityMax, m);
    },
    setCategories(n) {                                     // block category palette (golden-angle hues)
      if (n > 0 && !catPalette) catPalette = lutTexture(gl, categoryPalettePixels(256), 256);
    },
    // Filter bitmask by RECORD INDEX (micro-spec section 4: arbitrary index sets → a
    // bitmask texture). mask = Uint8Array (0|1 per source row) or null to clear;
    // isolate: true discards non-matching, false dims them.
    setFilter(mask, { isolate = false } = {}) {
      isolateMode = isolate;
      if (!mask) {
        if (maskTex) { gl.deleteTexture(maskTex); maskTex = null; }
      } else {
        const W = 8192, H = Math.max(1, Math.ceil(mask.length / W));
        const padded = new Uint8Array(W * H);
        for (let i = 0; i < mask.length; i++) padded[i] = mask[i] ? 255 : 0;
        if (maskTex && H === maskH) {
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, padded);
        } else {
          if (maskTex) gl.deleteTexture(maskTex);
          maskTex = gl.createTexture(); maskH = H;
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, padded);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
      }
      needClear = true;
    },
    setDocBbox(b) { docBbox = b; },
    invalidate() { needClear = true; },
    setPicked(rec) { pickedRec = rec == null ? 0xFFFFFFFF : rec >>> 0; needClear = true; },
    // GPU pick at CSS coordinates → record index | null. Draws each chunk's
    // current accumulated prefix into a scissored offscreen target with the
    // record index as the color (gl-pick.js) — you pick exactly what you see.
    pick(cssX, cssY, cam, { pointPx = 2.5, blocksAsPoints = false, section = null } = {}) {
      if (!chunks.length) return null;
      if (!pickPipe) pickPipe = createPickPipeline(gl);
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(cssX * dpr), py = Math.round(canvas.height - cssY * dpr - 1);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
      return pickPipe.pick(px, py, chunks, cam, {
        pointPx, blocksAsPoints, maskTex, isolate: isolateMode,
        section: section && section.on ? section : null,
        viewportW: canvas.width, viewportH: canvas.height,
      });
    },
    clearChunks() {
      for (const c of chunks) { gl.deleteVertexArray(c.vao); c.buffers.forEach((b) => gl.deleteBuffer(b)); }
      chunks.length = 0; intensityMax = 1; needClear = true;
      docChan[0] = Infinity; docChan[1] = -Infinity;
    },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needClear = true; }
      return [w, h];
    },
    // Draw one frame into the CURRENT framebuffer (the EDL pass owns the target).
    // Returns { drawn, converged, visible }.
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0, blocksAsPoints = false, section = null, clip = null } = {}) {
      const vp = cam.state.viewProj;
      const sec = section && section.on ? section : null;
      const secKey = sec ? `${sec.n.join(',')}|${sec.d}|${sec.half}` : 'off';
      const clipKey = clip ? `${clip[0]}~${clip[1]}` : 'a';
      const key = `${pointPx}|${colorMode}|${blocksAsPoints ? 'P' : 'B'}|${secKey}|${clipKey}|${canvas.width}x${canvas.height}`;
      const moving = vpChanged(vp) || key !== lastKey || needClear;
      lastKey = key; needClear = false;

      // frustum-cull + front-to-back over chunk bboxes (tight, thanks to Morton)
      const planes = frustumPlanes(vp);
      const eye = cam.state.eye;
      const visible = [];
      for (const c of chunks) {
        if (!aabbInFrustum(planes, c.bboxLocal)) { if (moving) c.cursor = 0; continue; }
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
      // color-scale clip: user min/max override the auto range (null = auto side)
      const zLo = clip && clip[0] != null && colorMode === 0 ? clip[0] : db[2];
      const zHi = clip && clip[1] != null && colorMode === 0 ? clip[1] : db[5];
      const zRange = [zLo, Math.max(zHi - zLo, 1e-6)];
      // this frame's allotment per chunk: budget share by projected weight, floored
      // so distant chunks keep a sparse presence (coarse prefix always on)
      const allot = (c) => {
        const share = Math.max(Math.min(c.count, 1000), Math.floor(budget * (c._w / sumW)));
        const first = moving ? 0 : c.cursor;
        return [first, Math.min(c.count - first, share)];
      };
      let drawn = 0, converged = true;

      const pts = visible.filter((c) => c.kind !== 'blocks');
      if (pts.length) {
        gl.useProgram(prog);
        gl.uniformMatrix4fv(uni.viewProj, false, vp);
        gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
        gl.uniform1i(uni.colorMode, colorMode);
        gl.uniform2f(uni.zRange, zRange[0], zRange[1]);
        gl.uniform1f(uni.intensityScale, 65535 / (intensityMax || 1));
        gl.uniform1ui(uni.picked, pickedRec);
        gl.uniform4f(uni.secPlane, sec ? sec.n[0] : 0, sec ? sec.n[1] : 0, sec ? sec.n[2] : 1, sec ? sec.d : 0);
        gl.uniform2f(uni.secCfg, sec ? 1 : 0, sec ? sec.half : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
        for (const c of pts) {
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

      const blks = visible.filter((c) => c.kind === 'blocks');
      if (blks.length) {
        const cLo = clip && clip[0] != null && colorMode === 1 ? clip[0] : (docChan[0] === Infinity ? 0 : docChan[0]);
        const cHi = clip && clip[1] != null && colorMode === 1 ? clip[1] : docChan[1];
        const chanSpan = cHi > cLo ? cHi - cLo : 1;
        blocksPipe.begin(cam, {
          pointPx, colorMode, zRange,
          chanDoc: [cLo, chanSpan],
          ramp, palette: catPalette || palette, viewportH: canvas.height,
          maskTex, isolate: isolateMode, pointsView: blocksAsPoints, picked: pickedRec, section: sec,
        });
        const perspScale = (canvas.height / 2) / Math.tan(cam.state.fovY / 2);
        for (const c of blks) {
          const [first, k] = allot(c);
          if (k > 0) {
            // the whole chunk below the demotion threshold → the cheap program
            // (no gl_FragDepth → early-z stays on): the far-field perf lever
            const b = c.bboxLocal;
            const bboxR = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
            const rBlock = Math.hypot(c.grid.size[0], c.grid.size[1], c.grid.size[2]) / 2;
            const distNear = Math.max(cam.state.near, c._dist - bboxR);
            const cheap = blocksAsPoints || rBlock * perspScale / distNear < 2.0;
            blocksPipe.drawSlice(c, first, k, cheap);
            drawn += k; c.cursor = first + k;
          }
          if (c.cursor < c.count) converged = false;
        }
      }
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
  sniffDelimited,
  mapColumns,
  openBlockModel,
  lineFields,
  categoryPalettePixels,
  createBlocksPipeline,
  createPickPipeline,
  openDmModel,
  fetchDmRecord,
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
