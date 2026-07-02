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
// M1 chunking is SEQUENTIAL (arrival order — flight lines are spatially coherent
// enough for per-chunk bboxes to be useful); Morton-order spatial chunking is M2
// and replaces only the bucketing, not this contract.
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
 * Build one render Chunk from a set of RawChunk slices (already concatenated by
 * the caller — see ChunkBuilder). All arrays are same-length columnar views.
 */
function buildChunk({ x, y, z, intensity, classification, rgb, recIdx }, frame, rnd) {
  const n = x.length;
  // frame-local bbox (f64 subtract BEFORE any narrowing — the one hard rule)
  const o = frame.origin;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const lx = new Float64Array(n), ly = new Float64Array(n), lz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const px = x[i] - o[0], py = y[i] - o[1], pz = z[i] - o[2];
    lx[i] = px; ly[i] = py; lz[i] = pz;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  const sx = maxX > minX ? 65535 / (maxX - minX) : 0;
  const sy = maxY > minY ? 65535 / (maxY - minY) : 0;
  const sz = maxZ > minZ ? 65535 / (maxZ - minZ) : 0;
  const perm = shuffledIndices(n, rnd);
  const pos = new Uint16Array(3 * n);
  const outI = new Uint16Array(n), outC = new Uint8Array(n), outR = new Uint32Array(n);
  const outRgb = rgb ? new Uint8Array(3 * n) : null;
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    pos[k * 3] = ((lx[i] - minX) * sx + 0.5) | 0;
    pos[k * 3 + 1] = ((ly[i] - minY) * sy + 0.5) | 0;
    pos[k * 3 + 2] = ((lz[i] - minZ) * sz + 0.5) | 0;
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
 * ChunkBuilder — feed RawChunks as they stream in; emits finished Chunks of
 * ~chunkSize elements via onChunk. flush() emits the remainder. Also tracks the
 * document-wide local bbox + counts for camera fitting.
 */
function createChunkBuilder({ frame, chunkSize = 1 << 20, seed = 1, onChunk }) {
  const rnd = mulberry32(seed);
  let pend = [];                                           // pending RawChunk slices
  let pendCount = 0;
  const doc = { count: 0, bboxLocal: Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity), hasRgb: false };

  const concat = (Type, parts, per) => {
    const out = new Type(pendCount * per);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  const emit = () => {
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
    pend = []; pendCount = 0;
    const chunk = buildChunk(cols, frame, rnd);
    doc.count += chunk.count;
    doc.hasRgb = doc.hasRgb || !!chunk.rgb;
    const b = doc.bboxLocal, cb = chunk.bboxLocal;
    for (let i = 0; i < 3; i++) { if (cb[i] < b[i]) b[i] = cb[i]; if (cb[i + 3] > b[i + 3]) b[i + 3] = cb[i + 3]; }
    onChunk(chunk);
  };

  return {
    push(raw) {
      // attach record indices (provider gives recStart; elements are file-ordered)
      const recIdx = new Uint32Array(raw.count);
      for (let i = 0; i < raw.count; i++) recIdx[i] = raw.recStart + i;
      let taken = 0;
      while (taken < raw.count) {
        const room = chunkSize - pendCount;
        const n = Math.min(room, raw.count - taken);
        const slice = (a, per = 1) => (a ? a.subarray(taken * per, (taken + n) * per) : null);
        pend.push({ x: slice(raw.x), y: slice(raw.y), z: slice(raw.z), intensity: slice(raw.intensity), classification: slice(raw.classification), rgb: slice(raw.rgb, 3), recIdx: recIdx.subarray(taken, taken + n) });
        pendCount += n; taken += n;
        if (pendCount >= chunkSize) emit();
      }
    },
    flush() { emit(); return doc; },
    get doc() { return doc; },
  };
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
    c.proj = mat4Perspective(c.fovY, c.aspect, c.near, c.far);
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

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;        // uint16 normalized -> 0..1
layout(location=1) in float aIntensity; // uint16 normalized
layout(location=2) in float aClass;     // uint8, raw (0..255)
layout(location=3) in vec3 aRgb;        // uint8 normalized
uniform mat4 uViewProj;
uniform vec3 uBoxMin, uBoxSpan;
uniform float uPointPx;
uniform int uColorMode;                 // 0 elevation | 1 intensity | 2 classification | 3 rgb
uniform vec2 uZRange;                   // document local z min/span (elevation ramp)
uniform float uIntensityScale;          // 1 / (p98-ish max, normalized units)
uniform sampler2D uRamp;                // 256x1 continuous ramp
uniform sampler2D uPalette;             // 32x1 classification palette
out vec4 vColor;
void main() {
  vec3 p = uBoxMin + aPos * uBoxSpan;
  gl_Position = uViewProj * vec4(p, 1.0);
  gl_PointSize = uPointPx;
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
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;        // circular splat
  outColor = vColor;
}`;

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

// Upload one chunk's buffers → a VAO. CPU copies are the caller's to release.
function uploadChunk(gl, chunk) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = (data, loc, size, type, normalized, isInt = false) => {
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
  gl.bindVertexArray(null);
  return { vao, buffers, count: chunk.count, bboxLocal: chunk.bboxLocal };
}

/**
 * createRenderer(canvas) — owns the GL context, program, LUTs, and the chunk
 * list; draw(cam, opts) renders one frame (into the current framebuffer — the
 * EDL pass wraps it). Chunks arrive via addChunk() as the stream lands.
 */
function createRenderer(canvas, { background = [0.07, 0.07, 0.07, 1] } = {}) {
  // preserveDrawingBuffer: the viewport is also the screenshot-export surface
  // (micro-spec §6) and readPixels-after-frame is how the smoke verifies renders;
  // the cost is one buffer copy per composite — negligible next to the splat pass.
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('condenser: WebGL2 unavailable');
  const prog = makeProgram(gl, VERT, FRAG);
  const U = (n) => gl.getUniformLocation(prog, n);
  const uni = {
    viewProj: U('uViewProj'), boxMin: U('uBoxMin'), boxSpan: U('uBoxSpan'),
    pointPx: U('uPointPx'), colorMode: U('uColorMode'), zRange: U('uZRange'),
    intensityScale: U('uIntensityScale'), ramp: U('uRamp'), palette: U('uPalette'),
  };
  const ramp = lutTexture(gl, rampPixels(), 256);
  const palette = lutTexture(gl, palettePixels(), 32);
  const chunks = [];
  let docBbox = null, intensityMax = 1;

  return {
    gl,
    get chunkCount() { return chunks.length; },
    get elementCount() { return chunks.reduce((s, c) => s + c.count, 0); },
    addChunk(chunk) {
      chunks.push(uploadChunk(gl, chunk));
      let m = 0; const a = chunk.intensity;
      for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
      intensityMax = Math.max(intensityMax, m);
    },
    setDocBbox(b) { docBbox = b; },
    clearChunks() { for (const c of chunks) { gl.deleteVertexArray(c.vao); c.buffers.forEach((b) => gl.deleteBuffer(b)); } chunks.length = 0; intensityMax = 1; },
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      return [w, h];
    },
    // Draw one frame into the CURRENT framebuffer (caller sets viewport target).
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0 } = {}) {
      const total = chunks.reduce((s, c) => s + c.count, 0) || 1;
      const frac = Math.min(1, budget / total);            // M1 prefix-LOD: uniform fraction per chunk
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(background[0], background[1], background[2], background[3]);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uni.viewProj, false, cam.state.viewProj);
      gl.uniform1f(uni.pointPx, pointPx * (window.devicePixelRatio || 1));
      gl.uniform1i(uni.colorMode, colorMode);
      const b = docBbox || Float64Array.of(0, 0, 0, 1, 1, 1);
      gl.uniform2f(uni.zRange, b[2], Math.max(b[5] - b[2], 1e-6));
      gl.uniform1f(uni.intensityScale, 65535 / (intensityMax || 1));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
      let drawn = 0;
      for (const c of chunks) {
        const k = Math.max(1, Math.floor(c.count * frac));
        gl.uniform3f(uni.boxMin, c.bboxLocal[0], c.bboxLocal[1], c.bboxLocal[2]);
        gl.uniform3f(uni.boxSpan, c.bboxLocal[3] - c.bboxLocal[0], c.bboxLocal[4] - c.bboxLocal[1], c.bboxLocal[5] - c.bboxLocal[2]);
        gl.bindVertexArray(c.vao);
        gl.drawArrays(gl.POINTS, 0, k);
        drawn += k;
      }
      gl.bindVertexArray(null);
      return drawn;
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
uniform float uStrength;               // 0 = off-look, ~1 default
uniform float uRadius;                 // sample radius in pixels
out vec4 outColor;

float linDepth(float d) {              // depth buffer -> linear eye-space z
  float n = uNearFar.x, f = uNearFar.y;
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
  const uni = { color: U('uColor'), depth: U('uDepth'), texel: U('uTexel'), nearFar: U('uNearFar'), strength: U('uStrength'), radius: U('uRadius') };
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
    render(width, height, cam, sceneDraw, { enabled = true, strength = 1.0, radius = 1.4 } = {}) {
      if (!enabled) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height); return sceneDraw(); }
      ensure(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      const drawn = sceneDraw();                           // the splat pass, into the FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, colorTex); gl.uniform1i(uni.color, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, depthTex); gl.uniform1i(uni.depth, 3);
      gl.uniform2f(uni.texel, 1 / w, 1 / h);
      gl.uniform2f(uni.nearFar, cam.state.near, cam.state.far);
      gl.uniform1f(uni.strength, strength);
      gl.uniform1f(uni.radius, radius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      return drawn;
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
  documentFrame,
  buildChunk,
  chunkLocalPosition,
  createChunkBuilder,
  mat4Perspective,
  mat4LookAt,
  mat4Multiply,
  transformPoint,
  createOrbitCamera,
  attachOrbitInput,
  makeProgram,
  rampPixels,
  palettePixels,
  uploadChunk,
  createRenderer,
  createEdl,
};
