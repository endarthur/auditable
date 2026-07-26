// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/widget.js

// ── ../core.js ──

// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/core.js
// @gcu/condenser — Streaming no-preprocess renderer for massive spatial elements (point clouds, block models): stream-parse → quantize → chunk → prefix-LOD → progressive accumulation → EDL. The engine under micro.

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

// ── src/core/morton.js ──

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

// ── src/core/chunks.js ──

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

// ── src/core/blocks.js ──

// @gcu/condenser — block-model chunks: IJK-exact representation (micro-spec §2.5).
//
// For a REGULAR uniform grid, a block's centroid is fully determined by its integer
// IJK: center = grid.originLocal + ijk · size, where originLocal is the CENTROID of
// block (0,0,0) — the centroid convention throughout. Chunks store raw uint16 IJK
// (not bbox-normalized lattice positions), so reconstruction is EXACT — and IJK is
// itself useful for the grid-view join. Half-dims are a chunk-level uniform (all
// blocks one size) for a REGULAR grid. SUB-BLOCKED models use the same IJK scheme
// against a FINE lattice (pitch = min dim /2) plus a per-block u8 size code into a
// shared half-dim palette (chunk.dim + chunk.dimPalette); centroids stay exact.
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
function buildBlockChunk({ x, y, z, chan, cat, recIdx, dim }, grid, frame, rnd, indices = null, dimPalette = null) {
  const n = indices ? indices.length : x.length;
  const o = frame.origin;
  const [gx, gy, gz] = grid.originLocal, [sx, sy, sz] = grid.size;
  const perm = indices ? shuffleInPlace(Uint32Array.from(indices), rnd) : shuffledIndices(n, rnd);
  const ijk = new Uint16Array(3 * n);
  const outChan = new Uint16Array(n), outCat = new Uint8Array(n), outR = new Uint32Array(n);
  const sub = !!(dim && dimPalette);                        // sub-blocked → per-block size code
  const outDim = sub ? new Uint8Array(n) : null;
  // chan range over this chunk (quantize against it — per-chunk min/max, §2.1.2)
  let cMin = Infinity, cMax = -Infinity;
  for (let k = 0; k < n; k++) { const v = chan[perm[k]]; if (Number.isFinite(v)) { if (v < cMin) cMin = v; if (v > cMax) cMax = v; } }
  if (!Number.isFinite(cMin)) { cMin = 0; cMax = 0; }
  const cScale = cMax > cMin ? 65535 / (cMax - cMin) : 0;
  let minI = 65535, minJ = 65535, minK = 65535, maxI = 0, maxJ = 0, maxK = 0;
  // sub-blocked: track actual box faces (variable half-dims) for the cull bbox
  let fx0 = Infinity, fy0 = Infinity, fz0 = Infinity, fx1 = -Infinity, fy1 = -Infinity, fz1 = -Infinity;
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
    if (sub) {
      const dc = dim[i]; outDim[k] = dc;
      const h = dimPalette[dc] || [sx / 2, sy / 2, sz / 2];
      const cx = gx + bi * sx, cy = gy + bj * sy, cz = gz + bk * sz;
      if (cx - h[0] < fx0) fx0 = cx - h[0]; if (cx + h[0] > fx1) fx1 = cx + h[0];
      if (cy - h[1] < fy0) fy0 = cy - h[1]; if (cy + h[1] > fy1) fy1 = cy + h[1];
      if (cz - h[2] < fz0) fz0 = cz - h[2]; if (cz + h[2] > fz1) fz1 = cz + h[2];
    }
  }
  // culling bbox = outer faces of the extreme blocks (variable-size when sub-blocked)
  const bboxLocal = sub
    ? Float64Array.of(fx0, fy0, fz0, fx1, fy1, fz1)
    : Float64Array.of(
        gx + minI * sx - sx / 2, gy + minJ * sy - sy / 2, gz + minK * sz - sz / 2,
        gx + maxI * sx + sx / 2, gy + maxJ * sy + sy / 2, gz + maxK * sz + sz / 2,
      );
  const chunk = { kind: 'blocks', count: n, grid, ijk, chan: outChan, chanRange: [cMin, cMax], cat: outCat, recIdx: outR, bboxLocal };
  if (sub) { chunk.dim = outDim; chunk.dimPalette = dimPalette; }
  return chunk;
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
function createBlockChunkBuilder({ frame, grid, dimPalette = null, chunkSize = 1 << 20, batchSize = 0, seed = 1, onChunk }) {
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
      dim: dimPalette && pend.every((p) => p.dim) ? concat(Uint8Array, pend.map((p) => p.dim)) : null,
      recIdx: concat(Uint32Array, pend.map((p) => p.recIdx)),
    };
    const n = pendCount;
    pend = []; pendCount = 0;
    const order = radixSortIndices(mortonKeys(cols.x, cols.y, cols.z, n), n);
    for (let start = 0; start < n; start += chunkSize) {
      const slice = order.subarray(start, Math.min(start + chunkSize, n));
      const chunk = buildBlockChunk(cols, grid, frame, rnd, slice, dimPalette);
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
        pend.push({ x: s(raw.x), y: s(raw.y), z: s(raw.z), chan: s(raw.chan), cat: s(raw.cat), dim: s(raw.dim), recIdx: recIdx.subarray(taken, taken + n) });
        pendCount += n; taken += n;
        if (pendCount >= batchN) flushBatch();
      }
    },
    flush() { flushBatch(); return doc; },
    get doc() { return doc; },
  };
}

// ── src/core/sticks.js ──

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

// ── src/core/mesh-geom.js ──

// @gcu/condenser — mesh GEOMETRY builders (core: no I/O). World-f64 vertices
// → frame-local Float32 chunks for the static indexed pipeline (gl-mesh.js),
// plus the heightfield triangulator (a regular grid IS a single-valued
// surface). The file readers (.msh/.obj/.ply) live in io/mesh-io.js.
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

// A regular grid IS a single-valued heightfield — triangulate its lattice into a
// mesh chunk with per-vertex smooth normals (grid-gradient central differences)
// and a per-vertex value (the caller maps it to a colour via its own colormap).
// Quads touching a nodata corner are dropped → clean holes. Coords are frame-
// local. Strided to a display cap by the caller (bounded triangle count).
// flatZ (a world elevation) makes a FLAT horizontal sheet at that z instead of a
// heightfield — for a 2D data grid (grade/geochem) with no DEM; `values` stays the
// grid value so the caller still colours by it, and the normal is straight up.
function buildHeightfieldMesh(grid, { stride = 1, frame = null, flatZ = null } = {}) {
  const { nx, ny, data, x0, y0, dx, dy, nodata } = grid;
  const o = (frame && frame.origin) || [0, 0, 0];
  const flat = flatZ != null, flatLocal = flat ? flatZ - o[2] : 0;
  const isBad = (v) => Number.isNaN(v) || (nodata != null && (nodata >= 1.7e38 ? v >= 1.7014e38 : v === nodata));
  const cols = Math.floor((nx - 1) / stride) + 1, rows = Math.floor((ny - 1) / stride) + 1;
  const vidx = new Int32Array(rows * cols).fill(-1);
  let nv = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!isBad(data[Math.min(ny - 1, r * stride) * nx + Math.min(nx - 1, c * stride)])) vidx[r * cols + c] = nv++;
  }
  if (!nv) return null;
  const pos = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), values = new Float32Array(nv);
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const zAt = (r, c) => { const v = data[Math.min(ny - 1, Math.max(0, r * stride)) * nx + Math.min(nx - 1, Math.max(0, c * stride))]; return isBad(v) ? NaN : v; };
  const sx = 2 * stride * dx, sy = 2 * stride * dy;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const vi = vidx[r * cols + c]; if (vi < 0) continue;
    const gr = Math.min(ny - 1, r * stride), gc = Math.min(nx - 1, c * stride), z = data[gr * nx + gc];
    const px = (x0 + gc * dx) - o[0], py = (y0 - gr * dy) - o[1], pz = flat ? flatLocal : z - o[2];
    pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz; values[vi] = z;
    if (px < bb[0]) bb[0] = px; if (py < bb[1]) bb[1] = py; if (pz < bb[2]) bb[2] = pz;
    if (px > bb[3]) bb[3] = px; if (py > bb[4]) bb[4] = py; if (pz > bb[5]) bb[5] = pz;
    if (flat) { normal[vi * 3] = 0; normal[vi * 3 + 1] = 0; normal[vi * 3 + 2] = 1; continue; }   // flat sheet → up
    // heightfield normal N = (-∂z/∂x, -∂z/∂y, 1); y decreases as row increases
    let zl = zAt(r, c - 1), zr = zAt(r, c + 1), zdn = zAt(r - 1, c), zup = zAt(r + 1, c);
    if (Number.isNaN(zl)) zl = z; if (Number.isNaN(zr)) zr = z; if (Number.isNaN(zdn)) zdn = z; if (Number.isNaN(zup)) zup = z;
    const nX = -(zr - zl) / sx, nY = -(zdn - zup) / sy, nZ = 1, nl = Math.hypot(nX, nY, nZ) || 1;
    normal[vi * 3] = nX / nl; normal[vi * 3 + 1] = nY / nl; normal[vi * 3 + 2] = nZ / nl;
  }
  const tris = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = vidx[r * cols + c], b = vidx[r * cols + c + 1], d = vidx[(r + 1) * cols + c], e = vidx[(r + 1) * cols + c + 1];
    if (a < 0 || b < 0 || d < 0 || e < 0) continue;        // drop quads touching nodata → clean holes
    tris.push(a, d, b, b, d, e);
  }
  return { kind: 'mesh', pos, idx: Uint32Array.from(tris), normal, values, count: (tris.length / 3) | 0, vertexCount: nv, bboxLocal: Float64Array.from(bb) };
}

// ── src/core/soup-geom.js ──

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

// ── src/core/gl-util.js ──

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

// ── src/core/gl-sticks.js ──

// @gcu/condenser — capsule impostors for drillhole sticks (micro-layers §6).
// gl-blocks' trick with a different intersection: one instanced quad per
// SEGMENT, billboarded to enclose the capsule's silhouette (spanned by the
// segment axis and the axis⊥view direction), fragment ray-capsule test with a
// real gl_FragDepth + surface normal (headlight shading). <2px → splat
// demotion; a cheap no-gl_FragDepth program serves fully-demoted far chunks.
// Radius is a live per-layer uniform (world metres) — the "stick thickness"
// knob. Mask / section / picked-glow / repaint identical to blocks.


// 4×4-Bayer screen-door opacity (see gl-mesh / gl-blocks): see-through without
// alpha blending — real depth writes stay correct, no back-to-front sort.
const SCREENDOOR$gl_sticks = `
uniform float uOpacity;
const float _BAYER[16] = float[16](0.0,8.0,2.0,10.0,12.0,4.0,14.0,6.0,3.0,11.0,1.0,9.0,15.0,7.0,13.0,5.0);
bool _screendoor() { if (uOpacity >= 0.999) return false; int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2); return uOpacity < (_BAYER[bi] + 0.5) / 16.0; }`;

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
uniform uint uPicked;                   // picked RECORD (0xFFFFFFFF = none)
uniform uint uPickedLayer;              // …and the layer it belongs to
uniform uint uLayer;                    // this draw's layer (per-draw, not per-element)
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
    int rec = int(aRec);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  // section cull: keep any capsule that TOUCHES the slab (segment support along
  // the normal + radius) — the fragment shader clips exactly (see gl-blocks).
  float secSupp = demoted > 0.5 ? 0.0 : (abs(dot(axis, uSecPlane.xyz)) * 0.5 + uRadius);
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y + secSupp) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
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
    int rs = int(aRec);
    if (texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);
  if (aRec == uPicked && uLayer == uPickedLayer) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);
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
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
out vec4 outColor;
${SCREENDOOR$gl_sticks}
void main() {
  if (vCull > 0.5) discard;
  if (_screendoor()) discard;           // per-layer opacity (screen-door)
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
  // TRUE SECTION on the capsule (convex, so one inside-test at the slab face is
  // exact): a hit outside the slab either becomes the flat cut CROSS-SECTION at
  // the face, or the capsule never overlaps the slab and the pixel is gone.
  float cutFace = 0.0;
  if (uSecCfg.x > 0.5) {
    float den = dot(rd, uSecPlane.xyz);
    float dc = dot(ro, uSecPlane.xyz) - uSecPlane.w;
    if (abs(dc + t * den) > uSecCfg.y) {
      if (abs(den) < 1e-9) discard;
      float sIn = min((-uSecCfg.y - dc) / den, (uSecCfg.y - dc) / den);
      if (sIn <= t) discard;                               // hit past the slab exit
      vec3 q = ro + rd * sIn;                              // at the slab face: still inside?
      vec3 qa = q - vA;
      float yq = clamp(dot(qa, ba) / baba, 0.0, 1.0);
      if (length(qa - ba * yq) > uRadius) discard;
      t = sIn;
      n = uSecPlane.xyz * -sign(den);
      cutFace = 1.0;
    }
  }
  vec3 p = ro + rd * t;
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float shade = (0.55 + 0.45 * max(dot(n, uLightDir), 0.0)) * (cutFace > 0.5 ? 0.85 : 1.0);
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
${SCREENDOOR$gl_sticks}
void main() {
  if (vCull > 0.5) discard;
  if (_screendoor()) discard;
  if (dot(vCorner, vCorner) > 1.0) discard;
  outColor = vColor;
}`;

function createSticksPipeline(gl) {
  const mkProg = (frag) => {
    const prog = makeProgram(gl, VERT$gl_sticks, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), eye: U('uEye'), radius: U('uRadius'), opacity: U('uOpacity'),
      perspScale: U('uPerspScale'), demotePx: U('uDemotePx'), pointPx: U('uPointPx'), fixedSplat: U('uFixedSplat'),
      colorMode: U('uColorMode'), zRange: U('uZRange'), chanChunk: U('uChanChunk'), chanDoc: U('uChanDoc'),
      ramp: U('uRamp'), palette: U('uPalette'), lightDir: U('uLightDir'),
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), picked: U('uPicked'), pickedLayer: U('uPickedLayer'), layer: U('uLayer'), repaint: U('uRepaint'),
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

  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, pickedLayer = 0xFFFFFFFF, layer = 0, section = null, radius = 1, catVisTex = null, selTex = null, ruleTex = null, opacity = 1 }) {
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
      gl.uniform1f(uni.opacity, Math.max(0.02, Math.min(1, opacity)));   // per-layer screen-door opacity
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
      gl.uniform1ui(uni.pickedLayer, pickedLayer >>> 0);
      gl.uniform1ui(uni.layer, layer >>> 0);              // this draw's layer — the id no longer hides in aRec
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

// ── src/core/gl-mesh.js ──

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
layout(location=1) in vec3 aColor;      // per-vertex rgb (heightfield drape); ignored when uVColor=0
layout(location=2) in vec3 aNormal;     // per-vertex normal (smooth relief); ignored when uVNormal=0
uniform mat4 uViewProj;
uniform vec4 uSecPlane;
out vec3 vWorldPos;
out vec3 vColor;
out vec3 vNormal;
out float vSecDist;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vWorldPos = aPos;
  vColor = aColor;
  vNormal = aNormal;
  vSecDist = dot(aPos, uSecPlane.xyz) - uSecPlane.w;
}`;

// Per-vertex drape (uVColor) + smooth normals (uVNormal) are OPT-IN — default 0
// keeps the flat-shaded solid-tint behaviour byte-for-byte. The heightfield
// surface sets both: vColor from a colormap, vNormal from the grid gradient, and
// the normal's z is divided by uZExag (inverse-transpose of the display z-scale)
// so lighting matches the vertically-exaggerated relief.
const SHADE_COMMON = `
uniform vec4 uTint;                     // rgb + opacity
uniform vec3 uLightDir;
uniform vec3 uEye;
uniform float uVColor;                  // 0/1 use vColor
uniform float uVNormal;                 // 0/1 use vNormal (else flat derivative)
uniform float uZExag;                   // vertical exaggeration (for the normal correction)
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
vec3 shadeSurface() {
  vec3 n = (uVNormal > 0.5)
    ? normalize(vec3(vNormal.xy, vNormal.z / max(uZExag, 1e-4)))   // exaggeration-correct
    : normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));          // flat shading
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;                                    // two-sided
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  vec3 base = (uVColor > 0.5) ? vColor : uTint.rgb;
  return base * shade;
}`;

const FRAG$gl_mesh = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vColor;
in vec3 vNormal;
in float vSecDist;
uniform vec2 uSecCfg;                   // x: on, y: half-thickness
${SHADE_COMMON}
out vec4 outColor;
void main() {
  if (uSecCfg.x > 0.5 && abs(vSecDist) > uSecCfg.y) discard;   // per-pixel plane cut
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  outColor = vec4(shadeSurface(), 1.0);
}`;

// TRACE-OVER-THE-WALL variant, used while the layer is sectioned: with blocks
// cutting TRUE at the slab plane (gl-blocks), the mesh inside the slab sits
// BEHIND the painted cut wall and would be fully occluded — and the mesh AT the
// plane is edge-on (invisible). This program pulls each in-slab fragment's DEPTH
// onto the camera-side slab face (minus an epsilon), so the whole in-slab mesh
// projects onto the section and draws over the wall — the wireframe-trace-on-a-
// section-plot look. Colour/shading unchanged; costs early-z only while sectioned.
const FRAG_OVERLAY$gl_mesh = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vColor;
in vec3 vNormal;
in float vSecDist;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform mat4 uViewProj;
uniform vec3 uFwd;
uniform float uOrtho;
${SHADE_COMMON}
out vec4 outColor;
void main() {
  if (abs(vSecDist) > uSecCfg.y) discard;
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  outColor = vec4(shadeSurface(), 1.0);
  gl_FragDepth = gl_FragCoord.z;
  float dcEye = dot(uEye, uSecPlane.xyz) - uSecPlane.w;
  if (abs(dcEye) > uSecCfg.y) {                            // eye outside the slab → a wall may occlude
    float side = sign(dcEye);
    vec3 q; bool front = false;
    if (uOrtho > 0.5) {                                    // parallel rays: march back along the view dir
      float den = dot(uFwd, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float s = (vSecDist - side * uSecCfg.y) / den;
        if (s > 0.0) { q = vWorldPos - uFwd * s; front = true; }
      }
    } else {
      vec3 rdm = vWorldPos - uEye;
      float den = dot(rdm, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float tF = (side * uSecCfg.y - dcEye) / den;       // where the eye ray crosses the near face
        if (tF > 0.0 && tF < 1.0) { q = uEye + rdm * tF; front = true; }
      }
    }
    if (front) {
      vec4 clipQ = uViewProj * vec4(q, 1.0);
      gl_FragDepth = clamp(clipQ.z / clipQ.w * 0.5 + 0.5, 0.0, 1.0) - 3e-5;
    }
  }
}`;

function createMeshPipeline(gl) {
  const mk = (frag) => {
    const prog = makeProgram(gl, VERT$gl_mesh, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      tint: U('uTint'), lightDir: U('uLightDir'), eye: U('uEye'),
      fwd: U('uFwd'), ortho: U('uOrtho'),
      vColor: U('uVColor'), vNormal: U('uVNormal'), zExag: U('uZExag'),
    } };
  };
  const base = mk(FRAG$gl_mesh), overlay = mk(FRAG_OVERLAY$gl_mesh);

  function upload(chunk) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bufs = [];
    const bPos = gl.createBuffer(); bufs.push(bPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (chunk.color) {                                     // heightfield drape: per-vertex rgb (loc 1)
      const bCol = gl.createBuffer(); bufs.push(bCol);
      gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.color, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    }
    if (chunk.normal) {                                    // smooth relief: per-vertex normal (loc 2)
      const bNrm = gl.createBuffer(); bufs.push(bNrm);
      gl.bindBuffer(gl.ARRAY_BUFFER, bNrm);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.normal, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    }
    const bIdx = gl.createBuffer(); bufs.push(bIdx);       // stays bound in the VAO
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, chunk.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {
      kind: 'mesh', vao, buffers: bufs,
      count: chunk.count, idxCount: chunk.idx.length,
      hasColor: !!chunk.color, hasNormal: !!chunk.normal,
      bboxLocal: chunk.bboxLocal, cursor: 0,
    };
  }

  // per-layer uniforms — tint [r,g,b] 0..1, opacity 0..1, section may be null.
  // Sectioned → the overlay program (depth flattened onto the slab face so the
  // trace draws over the true-cut block wall); unsectioned → the base program.
  function begin(cam, { tint = [0.62, 0.64, 0.66], opacity = 1, section = null, vcolor = false, vnormal = false }) {
    const s = cam.state;
    const { prog, uni } = section ? overlay : base;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(uni.viewProj, false, s.viewProj);
    gl.uniform1f(uni.vColor, vcolor ? 1 : 0);              // heightfield drape colours
    gl.uniform1f(uni.vNormal, vnormal ? 1 : 0);            // smooth grid normals
    gl.uniform1f(uni.zExag, s.zExag || 1);                 // normal correction under exaggeration
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
    if (uni.fwd) {
      const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
      const fl = Math.hypot(...f) || 1;
      gl.uniform3f(uni.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
      gl.uniform1f(uni.ortho, s.ortho ? 1 : 0);
    }
  }

  function draw(c) {
    gl.bindVertexArray(c.vao);
    gl.drawElements(gl.TRIANGLES, c.idxCount, gl.UNSIGNED_INT, 0);
  }

  return { upload, begin, draw };
}

// ── src/core/gl-soup.js ──

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

// sectioned variant: flatten in-slab fragment depth onto the camera-side slab
// face so the streamed-mesh trace draws over the true-cut block wall (gl-mesh's
// FRAG_OVERLAY, same math — see the rationale there)
const FRAG_OVERLAY$gl_soup = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in float vSecDist;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform vec4 uTint;
uniform vec3 uLightDir;
uniform vec3 uEye;
uniform mat4 uViewProj;
uniform vec3 uFwd;
uniform float uOrtho;
out vec4 outColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  if (abs(vSecDist) > uSecCfg.y) discard;
  if (uTint.a < 0.999) {
    int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2);
    if (uTint.a < (BAYER[bi] + 0.5) / 16.0) discard;
  }
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  vec3 vd = normalize(uEye - vWorldPos);
  if (dot(n, vd) < 0.0) n = -n;
  float shade = 0.42 + 0.58 * max(dot(n, uLightDir), 0.0);
  outColor = vec4(uTint.rgb * shade, 1.0);
  gl_FragDepth = gl_FragCoord.z;
  float dcEye = dot(uEye, uSecPlane.xyz) - uSecPlane.w;
  if (abs(dcEye) > uSecCfg.y) {
    float side = sign(dcEye);
    vec3 q; bool front = false;
    if (uOrtho > 0.5) {
      float den = dot(uFwd, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float s = (vSecDist - side * uSecCfg.y) / den;
        if (s > 0.0) { q = vWorldPos - uFwd * s; front = true; }
      }
    } else {
      vec3 rdm = vWorldPos - uEye;
      float den = dot(rdm, uSecPlane.xyz);
      if (abs(den) > 1e-9) {
        float tF = (side * uSecCfg.y - dcEye) / den;
        if (tF > 0.0 && tF < 1.0) { q = uEye + rdm * tF; front = true; }
      }
    }
    if (front) {
      vec4 clipQ = uViewProj * vec4(q, 1.0);
      gl_FragDepth = clamp(clipQ.z / clipQ.w * 0.5 + 0.5, 0.0, 1.0) - 3e-5;
    }
  }
}`;

function createSoupPipeline(gl) {
  const mk = (frag) => {
    const prog = makeProgram(gl, VERT$gl_soup, frag);
    const U = (n) => gl.getUniformLocation(prog, n);
    return { prog, uni: {
      viewProj: U('uViewProj'), boxMin: U('uBoxMin'), boxSpan: U('uBoxSpan'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'),
      tint: U('uTint'), lightDir: U('uLightDir'), eye: U('uEye'),
      fwd: U('uFwd'), ortho: U('uOrtho'),
    } };
  };
  const base = mk(FRAG$gl_soup), overlay = mk(FRAG_OVERLAY$gl_soup);
  let uni = base.uni;                                      // drawSlice uses the ACTIVE program's locations

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
    const pp = section ? overlay : base;
    uni = pp.uni;
    gl.useProgram(pp.prog);
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
    if (uni.fwd) {
      const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
      const fl = Math.hypot(...f) || 1;
      gl.uniform3f(uni.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
      gl.uniform1f(uni.ortho, s.ortho ? 1 : 0);
    }
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

// ── src/core/gl-blocks.js ──

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
// TRUE SECTIONS: the section slab clips the ray-box interval analytically in the
// fragment shader (a couple of dots + interval min/max on top of the existing
// slab test) — a block straddling the plane shows its CUT INTERIOR (flat, plane
// normal, slightly darkened) instead of vanishing or poking through. The vertex
// cull keeps anything TOUCHING the slab (box support radius along the normal);
// demoted splats keep the centroid test (sub-pixel, and a splat can't clip).
//
// Positions are IJK-exact (§2.5): center = uGridOrigin + aIjk · uGridSize, with
// uGridOrigin the frame-local centroid of block (0,0,0).


const VERT$gl_blocks = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;        // uint16 raw (integer lattice)
layout(location=1) in float aChan;      // uint16 normalized (per-chunk range)
layout(location=2) in float aCat;       // uint8 raw
layout(location=3) in uint aRec;        // uint32 record index (the join key)
layout(location=4) in uint aDim;        // uint8 size code → uDimPalette (sub-blocked)
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform sampler2D uDimPalette;          // Nx1 RGBA32F: per-code half-dims (box radius)
uniform float uSubBlock;                // 1 = variable-size boxes (read aDim → palette)
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
uniform sampler2D uChanTex;             // OPT-IN: raw f32 VALUE by record index (8192-wide rows) —
uniform float uChanTexOn;               // replaces aChan; how a never-materialized grade gets drawn
uniform float uForceSplat;              // 1 = whole chunk demoted (cheap far-field path)
uniform float uFixedSplat;              // 1 = points view: fixed-px splats regardless of block size
uniform uint uPicked;                   // picked RECORD (0xFFFFFFFF = none)
uniform uint uPickedLayer;              // …and the layer it belongs to
uniform uint uLayer;                    // this draw's layer (per-draw, not per-element)                   // record index to highlight (0xFFFFFFFF = none)
uniform uvec2 uRepaint;                 // repaint pass: draw ONLY these two records (both 0xFFFFFFFF = off)
uniform vec4 uSecPlane;                 // section plane: xyz = unit normal, w = offset (frame-local)
uniform vec2 uSecCfg;                   // x: 0 = off, 1 = slab; y: slab half-thickness
flat out vec3 vCenter;
flat out vec3 vHalf;
flat out vec4 vColor;
flat out float vMode;                   // 0 = impostor, 1 = splat
flat out float vCull;
flat out float vPxR;                    // projected radius (edge-line fade near demotion)
out vec2 vCorner;
out vec3 vWorldPos;
void main() {
  vec3 center = uGridOrigin + aIjk * uGridSize;
  vec3 half_ = uSubBlock > 0.5 ? texelFetch(uDimPalette, ivec2(int(aDim), 0), 0).rgb : uGridSize * 0.5;
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
  // section cull: keep any box that TOUCHES the slab (support radius of the box
  // along the plane normal) — the fragment shader then clips the ray interval
  // EXACTLY, so straddling blocks show their true cut instead of vanishing.
  // Demoted splats can't clip, so they keep the centroid test (sub-pixel there).
  float secSupp = demoted > 0.5 ? 0.0 : dot(half_, abs(uSecPlane.xyz));
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y + secSupp) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  float quadR = uFixedSplat > 0.5
    ? uPointPx * 0.5 * distEff / uPerspScale
    : mix(r, max(uPointPx * 0.5, pxR) * distEff / uPerspScale, demoted);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec3 wp = center + (uRight * corner.x + uUp * corner.y) * quadR;
  gl_Position = uViewProj * vec4(wp, 1.0);
  vCenter = center; vHalf = half_; vMode = demoted; vCorner = corner; vWorldPos = wp; vPxR = pxR;
  if (uColorMode == 0) {
    float t = clamp((center.z - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    int cr = int(aRec);
    float v = uChanTexOn > 0.5
      ? texelFetch(uChanTex, ivec2(cr & 8191, cr >> 13), 0).r
      : uChanChunk.x + aChan * uChanChunk.y;
    float t = clamp((v - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
    vColor = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 2) {
    vColor = texture(uPalette, vec2((cls + 0.5) / 256.0, 0.5));
  } else {
    vColor = vec4(0.62, 0.63, 0.66, 1.0);
  }
  if (uSelOn > 0.5) {
    int rs = int(aRec);
    if (texelFetch(uSel, ivec2(rs & 8191, rs >> 13), 0).r > 0.5) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.85, 0.3), 0.55), vColor.a);
  }
  if (uFilterOn > 0.5 && m < 0.5) vColor = vec4(vColor.rgb * 0.3, vColor.a);   // context mode: dim non-matching (still legible)
  if (aRec == uPicked && uLayer == uPickedLayer) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
  if ((uRepaint.x != 0xFFFFFFFFu || uRepaint.y != 0xFFFFFFFFu) && aRec != uRepaint.x && aRec != uRepaint.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // repaint pass: everything else clips out
}`;

// 4×4-Bayer screen-door opacity (same as gl-mesh): drops a fraction of pixels by a
// stable dither → "see through" the model WITHOUT alpha blending, so real depth
// writes + occlusion stay correct and no back-to-front sort is needed.
const SCREENDOOR$gl_blocks = `
uniform float uOpacity;
const float _BAYER[16] = float[16](0.0,8.0,2.0,10.0,12.0,4.0,14.0,6.0,3.0,11.0,1.0,9.0,15.0,7.0,13.0,5.0);
bool _screendoor() { if (uOpacity >= 0.999) return false; int bi = (int(gl_FragCoord.x) & 3) + ((int(gl_FragCoord.y) & 3) << 2); return uOpacity < (_BAYER[bi] + 0.5) / 16.0; }`;

const FRAG$gl_blocks = `#version 300 es
precision highp float;
flat in vec3 vCenter;
flat in vec3 vHalf;
flat in vec4 vColor;
flat in float vMode;
flat in float vCull;
flat in float vPxR;
in vec2 vCorner;
in vec3 vWorldPos;
uniform vec3 uEye;
uniform vec3 uFwd;                      // view direction (ortho rays are parallel)
uniform float uOrthoRay;                // 1 = ortho: origin per fragment, direction = uFwd
uniform float uBackoff;                 // how far behind the quad the ortho ray starts
uniform vec3 uLightDir;
uniform mat4 uViewProj;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform float uEdges;                   // 1 = draw block edge lines (View toggle)
out vec4 outColor;
${SCREENDOOR$gl_blocks}
void main() {
  if (vCull > 0.5) discard;             // isolate mode: filtered-out block
  if (_screendoor()) discard;           // per-layer opacity (screen-door)
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
  // face normal = the slab that produced the BOX entry (chosen pre-clip)
  vec3 n = vec3(0.0);
  if (tin == tmin3.x) n = vec3(-sign(rd.x), 0.0, 0.0);
  else if (tin == tmin3.y) n = vec3(0.0, -sign(rd.y), 0.0);
  else n = vec3(0.0, 0.0, -sign(rd.z));
  // TRUE SECTION: intersect the ray-box interval with the ray-slab interval.
  // When the slab plane replaces the box entry, the visible surface is the CUT
  // INTERIOR — flat, plane normal, slightly darkened — so a thin section reads
  // as a continuous painted wall instead of a ragged centroid subset.
  float cutFace = 0.0;
  if (uSecCfg.x > 0.5) {
    float den = dot(rd, uSecPlane.xyz);
    float dc = dot(ro, uSecPlane.xyz) - uSecPlane.w;
    if (abs(den) < 1e-9) { if (abs(dc) > uSecCfg.y) discard; }
    else {
      float ta = (-uSecCfg.y - dc) / den, tb = (uSecCfg.y - dc) / den;
      float sIn = min(ta, tb), sOut = max(ta, tb);
      if (sIn > tin) { tin = sIn; cutFace = -sign(den); }
      tout = min(tout, sOut);
      if (tin > tout || tout < 0.0) discard;
    }
  }
  float t = tin > 0.0 ? tin : tout;     // inside the box → exit face
  bool onCut = cutFace != 0.0 && t == tin;
  if (onCut) n = uSecPlane.xyz * cutFace;
  vec3 p = ro + rd * t;
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  float shade = (0.55 + 0.45 * max(dot(n, uLightDir), 0.0)) * (onCut ? 0.85 : 1.0);
  // BLOCK EDGES (toggle): the hit point in box-local coords — on a face, one
  // axis sits at ±1 and the SECOND-largest → 1 marks an edge; on a cut face
  // (interior) the LARGEST → 1 outlines the cut polygon (block boundaries on
  // the section wall). fwidth gives a ~screen-constant line; fade the effect
  // out as the block shrinks toward demotion so the far field stays clean.
  if (uEdges > 0.5) {
    vec3 a2 = abs(p - vCenter) / vHalf;
    float m1 = max(a2.x, max(a2.y, a2.z));
    float m2 = max(min(a2.x, a2.y), min(max(a2.x, a2.y), a2.z));
    float e = onCut ? m1 : m2;
    float dpx = (1.0 - e) / max(fwidth(e), 1e-6);          // distance to the edge in pixels
    float edge = 1.0 - clamp(dpx * 0.7 - 0.3, 0.0, 1.0);   // ~1.5 px, soft falloff
    edge *= clamp((vPxR - 5.0) / 8.0, 0.0, 1.0);           // fade below ~13 px projected radius
    shade *= 1.0 - 0.4 * edge;
  }
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
${SCREENDOOR$gl_blocks}
void main() {
  if (vCull > 0.5) discard;
  if (_screendoor()) discard;
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
      dimPalette: U('uDimPalette'), subBlock: U('uSubBlock'), opacity: U('uOpacity'),
      perspScale: U('uPerspScale'), demotePx: U('uDemotePx'), pointPx: U('uPointPx'),
      colorMode: U('uColorMode'), zRange: U('uZRange'), chanChunk: U('uChanChunk'), chanDoc: U('uChanDoc'),
      ramp: U('uRamp'), palette: U('uPalette'), lightDir: U('uLightDir'),
      mask: U('uMask'), filterOn: U('uFilterOn'), isolate: U('uIsolate'), forceSplat: U('uForceSplat'), fixedSplat: U('uFixedSplat'), picked: U('uPicked'), pickedLayer: U('uPickedLayer'), layer: U('uLayer'), repaint: U('uRepaint'),
      catVis: U('uCatVis'), catVisOn: U('uCatVisOn'), sel: U('uSel'), selOn: U('uSelOn'),
      rule: U('uRule'), ruleOn: U('uRuleOn'),
      chanTex: U('uChanTex'), chanTexOn: U('uChanTexOn'),
      secPlane: U('uSecPlane'), secCfg: U('uSecCfg'), edges: U('uEdges'),
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
    const sub = !!(chunk.dim && chunk.dimPalette);
    const bDim = sub ? mkBuf(chunk.dim) : null;            // per-block u8 size code
    gl.bindVertexArray(null);
    // sub-blocked: a small Nx1 RGBA32F palette of half-dims (box radii). NEAREST
    // sampling of a float texture is core WebGL2 (only float RENDER needs an ext).
    let dimTex = null;
    if (sub) {
      const pal = chunk.dimPalette, data = new Float32Array(pal.length * 4);
      for (let i = 0; i < pal.length; i++) { data[i * 4] = pal[i][0]; data[i * 4 + 1] = pal[i][1]; data[i * 4 + 2] = pal[i][2]; }
      dimTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dimTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, pal.length, 1, 0, gl.RGBA, gl.FLOAT, data);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    }
    return {
      kind: 'blocks', vao, buffers: sub ? [bIjk, bChan, bCat, bRec, bDim] : [bIjk, bChan, bCat, bRec],
      bIjk, bChan, bCat, bRec, bDim, dimTex, dimPalette: sub ? chunk.dimPalette : null,
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
    if (c.dimTex) {                                         // sub-blocked: per-block size code + palette
      gl.bindBuffer(gl.ARRAY_BUFFER, c.bDim);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_BYTE, 0, first);
      gl.vertexAttribDivisor(4, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, c.dimTex);
      gl.uniform1f(uni.subBlock, 1);
    } else {
      gl.disableVertexAttribArray(4);
      // A disabled `in uint aDim` reads the generic current value, which defaults to
      // FLOAT — a type mismatch vs the uint declaration (GL_INVALID_OPERATION at draw).
      // Give it a valid uint default; aDim is unused when uSubBlock=0, so 0 is a no-op.
      gl.vertexAttribI4ui(4, 0, 0, 0, 0);
      gl.uniform1f(uni.subBlock, 0);
    }
    gl.uniform3f(uni.gridOrigin, c.grid.originLocal[0], c.grid.originLocal[1], c.grid.originLocal[2]);
    gl.uniform3f(uni.gridSize, c.grid.size[0], c.grid.size[1], c.grid.size[2]);
    const span = c.chanRange[1] - c.chanRange[0];
    gl.uniform2f(uni.chanChunk, c.chanRange[0], span > 0 ? span : 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
  }

  // Per-frame program state (called once before the chunk loop) — set on BOTH
  // programs so drawSlice can switch freely between full and cheap.
  function begin(cam, { pointPx, colorMode, zRange, chanDoc, ramp, palette, viewportH, maskTex = null, isolate = false, pointsView = false, picked = 0xFFFFFFFF, pickedLayer = 0xFFFFFFFF, layer = 0, section = null, catVisTex = null, selTex = null, ruleTex = null, chanTex = null, opacity = 1, edges = false }) {
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
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.dimPalette, 2);   // unit 2 = per-chunk sub-block half-dims; a complete default so regular draws never sample incomplete
      gl.uniform1f(uni.subBlock, 0);
      gl.uniform1f(uni.opacity, Math.max(0.02, Math.min(1, opacity)));   // per-layer screen-door opacity
      gl.uniform1f(uni.fixedSplat, pointsView ? 1 : 0);
      gl.uniform1ui(uni.picked, picked >>> 0);
      gl.uniform1ui(uni.pickedLayer, pickedLayer >>> 0);
      gl.uniform1ui(uni.layer, layer >>> 0);              // this draw's layer — the id no longer hides in aRec
      gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
      gl.uniform4f(uni.secPlane, section ? section.n[0] : 0, section ? section.n[1] : 0, section ? section.n[2] : 1, section ? section.d : 0);
      gl.uniform2f(uni.secCfg, section ? 1 : 0, section ? section.half : 0);
      gl.uniform1f(uni.edges, edges ? 1 : 0);
      gl.uniform1f(uni.filterOn, maskTex ? 1 : 0);
      gl.uniform1f(uni.isolate, isolate ? 1 : 0);
      if (maskTex) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(uni.mask, 4); }
      gl.uniform1f(uni.catVisOn, catVisTex ? 1 : 0);
      if (catVisTex) { gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, catVisTex); gl.uniform1i(uni.catVis, 5); }
      gl.uniform1f(uni.selOn, selTex ? 1 : 0);
      if (selTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, selTex); gl.uniform1i(uni.sel, 6); }
      gl.uniform1f(uni.ruleOn, ruleTex ? 1 : 0);
      if (ruleTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, ruleTex); gl.uniform1i(uni.rule, 7); }
      gl.uniform1f(uni.chanTexOn, chanTex ? 1 : 0);
      if (chanTex) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, chanTex); gl.uniform1i(uni.chanTex, 8); }
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

// ── src/core/gl-pick.js ──

// @gcu/condenser — GPU ID-buffer picking. On click, the visible chunks re-render
// once into an offscreen target with the fragment shaders outputting the RECORD
// INDEX encoded as RGBA8 instead of a color, scissored to the cursor pixel; one
// readPixels + decode gives the exact element under the cursor. The SAME analytic
// geometry that renders decides the pick — the impostor's ray-AABB test and real
// depth writes resolve which block face is hit, pixel-perfect at any zoom. No CPU
// spatial index. The record index is THE join key (micro-spec §4): a pick is a
// row number in the source file.


// no encoder: the pick target is RG32UI (R = record, G = layer + face), so the
// ids go out as integers instead of being smeared across four bytes and
// reassembled. The layer needs 6 bits and has 32, so the FACE of the hit rides
// in the spare ones — the fragment shader already solved the ray-box entry to
// write true depth, and throwing that away meant the CPU had to re-derive it
// (a second ray-AABB + sub-block dims + slab clip, drifting from what was drawn).
//
//   G = (layer & 0xFFFF) | (face << 16)
//   face: 0=−X 1=+X 2=−Y 3=+Y 4=−Z 5=+Z, 6 = the SECTION CUT wall, 7 = none
//
// Naming the face names the PLANE, so the exact hit point is ray ∩ plane — one
// line on the CPU, and it agrees with the pixel by construction.
const ENCODE = '';
const PACK = `
const uint NO_FACE = 7u;
uint packId(uint layer, uint face) { return (layer & 0xFFFFu) | (face << 16); }`;

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
    int rec = int(aRec);
    if (texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r < 0.5) vCull = 1.0;   // isolated-away isn't pickable
  }
  float cls = aClass;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
}`;
const PICK_FRAG_PTS = `#version 300 es
precision highp float;
flat in uint vRec;
flat in float vCull;
uniform uint uLayer;                    // the layer is per-DRAW, not per-element
out uvec4 outId;                        // R = record (full uint32), G = layer | face<<16
${PACK}
void main() {
  if (vCull > 0.5) discard;
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  outId = uvec4(vRec, packId(uLayer, NO_FACE), 0u, 0u);   // a splat has no face
}`;

// ── blocks (geometry identical to gl-blocks; color replaced by the encoded id) ──
const PICK_VERT_BLK = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;
layout(location=2) in float aCat;
layout(location=3) in uint aRec;
layout(location=4) in uint aDim;
uniform mat4 uViewProj;
uniform vec3 uEye, uRight, uUp;
uniform vec3 uGridOrigin, uGridSize;
uniform sampler2D uDimPalette;
uniform float uSubBlock;
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
  vec3 half_ = uSubBlock > 0.5 ? texelFetch(uDimPalette, ivec2(int(aDim), 0), 0).rgb : uGridSize * 0.5;
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
  // touch-the-slab cull (support radius) — the fragment clips exactly, matching
  // the visual true-section cut so the cut wall is pickable
  float secSupp = demoted > 0.5 ? 0.0 : dot(half_, abs(uSecPlane.xyz));
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y + secSupp) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);   // hidden (isolated or sectioned) isn't pickable
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
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
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform uint uLayer;
out uvec4 outId;
${PACK}
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outId = uvec4(vRec, packId(uLayer, NO_FACE), 0u, 0u);  // demoted to a splat: no box, no face
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
  float tinBox = tin;                                    // the box entry, before any slab clip
  // clip by the section slab — the visible CUT surface is what picks (gl-blocks)
  if (uSecCfg.x > 0.5) {
    float den = dot(rd, uSecPlane.xyz);
    float dc = dot(ro, uSecPlane.xyz) - uSecPlane.w;
    if (abs(den) < 1e-9) { if (abs(dc) > uSecCfg.y) discard; }
    else {
      float ta = (-uSecCfg.y - dc) / den, tb = (uSecCfg.y - dc) / den;
      tin = max(tin, min(ta, tb));
      tout = min(tout, max(ta, tb));
      if (tin > tout || tout < 0.0) discard;
    }
  }
  float t = tin > 0.0 ? tin : tout;
  vec4 clip = uViewProj * vec4(ro + rd * t, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  // WHICH FACE the eye ray entered through: the axis that WON the box entry,
  // signed by the ray's direction along it (travelling +x → you hit the −X face).
  // If the slab clip pushed the entry past the box's own, you are looking at the
  // CUT, not a face. tin ≤ 0 means the eye is inside the block — no face.
  uint face = NO_FACE;
  if (tin > 0.0) {
    if (tin > tinBox + 1e-5) face = 6u;                  // the section cut wall
    else {
      uint ax = (tmin3.x >= tmin3.y && tmin3.x >= tmin3.z) ? 0u : ((tmin3.y >= tmin3.z) ? 1u : 2u);
      float rda = ax == 0u ? rd.x : (ax == 1u ? rd.y : rd.z);
      face = ax * 2u + (rda > 0.0 ? 0u : 1u);
    }
  }
  outId = uvec4(vRec, packId(uLayer, face), 0u, 0u);
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
    int rec = int(aRec);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
  }
  float secSupp = demoted > 0.5 ? 0.0 : (abs(dot(axis, uSecPlane.xyz)) * 0.5 + uRadius);
  float secCull = (uSecCfg.x > 0.5 && abs(dot(center, uSecPlane.xyz) - uSecPlane.w) > uSecCfg.y + secSupp) ? 1.0 : 0.0;
  vCull = max((uIsolate > 0.5 && m < 0.5) ? 1.0 : 0.0, secCull);
  float cls = aCat;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
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
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform uint uLayer;
out uvec4 outId;
${PACK}
void main() {
  if (vCull > 0.5) discard;
  if (vMode > 0.5) {
    if (dot(vCorner, vCorner) > 1.0) discard;
    gl_FragDepth = gl_FragCoord.z;
    outId = uvec4(vRec, packId(uLayer, NO_FACE), 0u, 0u);
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
  // section clip (convexity trick, matches gl-sticks): a hit outside the slab is
  // either the cut cross-section at the face or not pickable at all
  if (uSecCfg.x > 0.5) {
    float den = dot(rd, uSecPlane.xyz);
    float dc = dot(ro, uSecPlane.xyz) - uSecPlane.w;
    if (abs(dc + t * den) > uSecCfg.y) {
      if (abs(den) < 1e-9) discard;
      float sIn = min((-uSecCfg.y - dc) / den, (uSecCfg.y - dc) / den);
      if (sIn <= t) discard;
      vec3 q = ro + rd * sIn;
      vec3 qa = q - vA;
      float yq = clamp(dot(qa, ba) / baba, 0.0, 1.0);
      if (length(qa - ba * yq) > uRadius) discard;
      t = sIn;
    }
  }
  vec4 clip = uViewProj * vec4(ro + rd * t, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outId = uvec4(vRec, packId(uLayer, NO_FACE), 0u, 0u);   // a capsule has no axis-aligned face
}`;

const NO_LAYER = 0xFFFFFFFF;                                // the layer channel's miss sentinel

// The G channel's contract, in ONE place. Anything that reads the pick buffer —
// pick(), pickRegion()'s callers, a rubber-band sweep — unpacks through these.
const layerOfId = (g) => (g >>> 0) & 0xFFFF;
const faceOfId = (g) => ((g >>> 16) & 7);
const isMiss = (g) => (g >>> 0) === NO_LAYER;
const NO_FACE = 7;
const FACE_CUT = 6;
// unit normals per face code, and the human name. index 6/7 have no normal.
const FACE_NORMALS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], null, null];
const FACE_NAMES = ['−X (west)', '+X (east)', '−Y (south)', '+Y (north)', '−Z (bottom)', '+Z (top)', 'section cut', '—'];
const MISS_CLEAR = new Uint32Array([0xFFFFFFFF, 0xFFFFFFFF, 0, 0]);

// ── meshes ──
// A mesh has NO per-row records: it is a bag of triangles, not rows of a table.
// So the ID buffer answers only WHICH mesh (record = 0), and the CPU raycasts
// that mesh's BVH for the triangle + the exact point (winding's raycastBVH).
// WebGL2 has no gl_PrimitiveID, and un-indexing a mesh purely to carry a
// per-vertex triangle id would triple its vertex memory — for a click.
//
// The geometry and the SECTION behaviour mirror gl-mesh exactly (including the
// trace-over-the-wall depth flatten): you must pick what you see, or the ID
// buffer is lying.
const PICK_VERT_MSH = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec4 uSecPlane;
out vec3 vWorldPos;
out float vSecDist;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vWorldPos = aPos;
  vSecDist = dot(aPos, uSecPlane.xyz) - uSecPlane.w;
}`;
const PICK_FRAG_MSH = `#version 300 es
precision highp float;
in vec3 vWorldPos;
in float vSecDist;
uniform vec4 uSecPlane;
uniform vec2 uSecCfg;
uniform mat4 uViewProj;
uniform vec3 uEye, uFwd;
uniform float uOrtho;
uniform uint uLayer;
out uvec4 outId;
${PACK}
void main() {
  if (uSecCfg.x > 0.5 && abs(vSecDist) > uSecCfg.y) discard;
  gl_FragDepth = gl_FragCoord.z;
  if (uSecCfg.x > 0.5) {                                   // the visual flattens the in-slab trace onto the
    float dcEye = dot(uEye, uSecPlane.xyz) - uSecPlane.w;  // camera-side wall; the pick must agree or you
    if (abs(dcEye) > uSecCfg.y) {                          // would see a trace you cannot click
      float side = sign(dcEye);
      vec3 q; bool front = false;
      if (uOrtho > 0.5) {
        float den = dot(uFwd, uSecPlane.xyz);
        if (abs(den) > 1e-9) {
          float t = (vSecDist - side * uSecCfg.y) / den;
          if (t > 0.0) { q = vWorldPos - uFwd * t; front = true; }
        }
      } else {
        vec3 rdm = vWorldPos - uEye;
        float den = dot(rdm, uSecPlane.xyz);
        if (abs(den) > 1e-9) {
          float tF = (side * uSecCfg.y - dcEye) / den;
          if (tF > 0.0 && tF < 1.0) { q = uEye + rdm * tF; front = true; }
        }
      }
      if (front) {
        vec4 clipQ = uViewProj * vec4(q, 1.0);
        gl_FragDepth = clamp(clipQ.z / clipQ.w * 0.5 + 0.5, 0.0, 1.0) - 3e-5;
      }
    }
  }
  outId = uvec4(0u, packId(uLayer, NO_FACE), 0u, 0u);      // record 0: the CPU resolves the triangle
}`;

function createPickPipeline(gl) {
  const msh = makeProgram(gl, PICK_VERT_MSH, PICK_FRAG_MSH);
  const uMsh = {
    viewProj: gl.getUniformLocation(msh, 'uViewProj'), secPlane: gl.getUniformLocation(msh, 'uSecPlane'),
    secCfg: gl.getUniformLocation(msh, 'uSecCfg'), eye: gl.getUniformLocation(msh, 'uEye'),
    fwd: gl.getUniformLocation(msh, 'uFwd'), ortho: gl.getUniformLocation(msh, 'uOrtho'),
    layer: gl.getUniformLocation(msh, 'uLayer'),
  };
  const pts = makeProgram(gl, PICK_VERT_PTS, PICK_FRAG_PTS);
  const blk = makeProgram(gl, PICK_VERT_BLK, PICK_FRAG_BLK);
  const stk = makeProgram(gl, PICK_VERT_STK, PICK_FRAG_STK);
  const U = (p, n) => gl.getUniformLocation(p, n);
  const uPts = { layer: U(pts, 'uLayer'), viewProj: U(pts, 'uViewProj'), boxMin: U(pts, 'uBoxMin'), boxSpan: U(pts, 'uBoxSpan'), pointPx: U(pts, 'uPointPx'), secPlane: U(pts, 'uSecPlane'), secCfg: U(pts, 'uSecCfg'), mask: U(pts, 'uMask'), filterOn: U(pts, 'uFilterOn'), isolate: U(pts, 'uIsolate'), catVis: U(pts, 'uCatVis'), catVisOn: U(pts, 'uCatVisOn'), rule: U(pts, 'uRule'), ruleOn: U(pts, 'uRuleOn') };
  const uBlk = {
    layer: U(blk, 'uLayer'),
    viewProj: U(blk, 'uViewProj'), eye: U(blk, 'uEye'), right: U(blk, 'uRight'), up: U(blk, 'uUp'),
    gridOrigin: U(blk, 'uGridOrigin'), gridSize: U(blk, 'uGridSize'),
    dimPalette: U(blk, 'uDimPalette'), subBlock: U(blk, 'uSubBlock'),
    perspScale: U(blk, 'uPerspScale'), demotePx: U(blk, 'uDemotePx'), pointPx: U(blk, 'uPointPx'), fixedSplat: U(blk, 'uFixedSplat'),
    ortho: U(blk, 'uOrtho'), fwd: U(blk, 'uFwd'), orthoRay: U(blk, 'uOrthoRay'), backoff: U(blk, 'uBackoff'),
    mask: U(blk, 'uMask'), filterOn: U(blk, 'uFilterOn'), isolate: U(blk, 'uIsolate'),
    catVis: U(blk, 'uCatVis'), catVisOn: U(blk, 'uCatVisOn'), rule: U(blk, 'uRule'), ruleOn: U(blk, 'uRuleOn'),
    secPlane: U(blk, 'uSecPlane'), secCfg: U(blk, 'uSecCfg'),
  };
  const uStk = {
    layer: U(stk, 'uLayer'),
    viewProj: U(stk, 'uViewProj'), eye: U(stk, 'uEye'), radius: U(stk, 'uRadius'),
    perspScale: U(stk, 'uPerspScale'), demotePx: U(stk, 'uDemotePx'), pointPx: U(stk, 'uPointPx'), fixedSplat: U(stk, 'uFixedSplat'),
    ortho: U(stk, 'uOrtho'), fwd: U(stk, 'uFwd'), orthoRay: U(stk, 'uOrthoRay'), backoff: U(stk, 'uBackoff'),
    mask: U(stk, 'uMask'), filterOn: U(stk, 'uFilterOn'), isolate: U(stk, 'uIsolate'),
    catVis: U(stk, 'uCatVis'), catVisOn: U(stk, 'uCatVisOn'), rule: U(stk, 'uRule'), ruleOn: U(stk, 'uRuleOn'),
    secPlane: U(stk, 'uSecPlane'), secCfg: U(stk, 'uSecCfg'),
  };
  let fbo = null, colorTex = null, depthTex = null, w = 0, h = 0;

  function ensure(width, height) {
    if (fbo && width === w && height === h) return;
    w = width; h = height;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(colorTex); gl.deleteTexture(depthTex); }
    colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    // RG32UI: R = record (a full uint32), G = layer. Integer target → the ids are
    // read back as integers, with no byte packing anywhere.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32UI, w, h, 0, gl.RG_INTEGER, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // depth is a TEXTURE (not a renderbuffer): the deferred re-shade resolve
    // samples it to unproject each pixel's exact hit point (block edge lines)
    depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
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
      let s = st && st.sectioned === false ? null : section;
      const pm = st ? st.sectioned : true;
      if (s && (pm === 'front' || pm === 'behind') && s.d0 !== undefined) { const H = Math.max(1e5, 8 * (s.half || 1)); s = { ...s, d: pm === 'front' ? s.d0 + H : s.d0 - H, half: H }; }
      gl.uniform4f(u.secPlane, s ? s.n[0] : 0, s ? s.n[1] : 0, s ? s.n[2] : 1, s ? s.d : 0);
      gl.uniform2f(u.secCfg, s ? 1 : 0, s ? s.half : 0);
    };
    // a mesh's section is a TRACE band at the true plane, not the fat half-space
    // slab the blocks use (gl.js meshSecOf) — mirror it or the pick disagrees
    // with the picture on exactly the views geologists spend their day in.
    const setSecMesh = (u, st) => {
      let s2 = st && st.sectioned === false ? null : section;
      const pm = st ? st.sectioned : true;
      const clip = s2 && (pm === 'front' || pm === 'behind' ? pm : s2.clip);
      if (s2 && (clip === 'front' || clip === 'behind') && s2.d0 !== undefined) {
        s2 = { ...s2, d: s2.d0, half: Math.max(0.01, s2.traceHalf || 1) };
      }
      gl.uniform4f(u.secPlane, s2 ? s2.n[0] : 0, s2 ? s2.n[1] : 0, s2 ? s2.n[2] : 1, s2 ? s2.d : 0);
      gl.uniform2f(u.secCfg, s2 ? 1 : 0, s2 ? s2.half : 0);
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
    gl.clearBufferuiv(gl.COLOR, 0, MISS_CLEAR);            // layer = NO_LAYER → "nothing here"
    gl.clear(gl.DEPTH_BUFFER_BIT);
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
      gl.uniform1ui(uPts.layer, id >>> 0);
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
      gl.uniform1i(uBlk.dimPalette, 2);                     // unit 2 = sub-block half-dims (per-chunk below)
      for (const [id, group] of byLayer(blkChunks)) {
        gl.uniform1ui(uBlk.layer, id >>> 0);
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
        if (c.dimTex) {
          gl.bindBuffer(gl.ARRAY_BUFFER, c.bDim);
          gl.enableVertexAttribArray(4);
          gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_BYTE, 0, 0);
          gl.vertexAttribDivisor(4, 1);
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, c.dimTex);
          gl.uniform1f(uBlk.subBlock, 1);
        } else {
          gl.disableVertexAttribArray(4);
          gl.vertexAttribI4ui(4, 0, 0, 0, 0);   // uint default for the disabled `in uint aDim` (see gl-blocks.js)
          gl.uniform1f(uBlk.subBlock, 0);
        }
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
        gl.uniform1ui(uStk.layer, id >>> 0);
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

    // ── meshes: WHICH mesh, not which triangle (the CPU's job) ──
    // Policy lives with the app: a layer may declare itself pickable. The default
    // is OPAQUE-ONLY, and that is deliberate — you make a context surface
    // see-through precisely so you can work on what is behind it, so a 50%
    // topography must not steal the click meant for the block under it.
    const mshChunks = chunks.filter((c) => c.kind === 'mesh' && c.idxCount > 0);
    if (mshChunks.length) {
      gl.useProgram(msh);
      gl.uniformMatrix4fv(uMsh.viewProj, false, s.viewProj);
      gl.uniform3f(uMsh.eye, s.eye[0], s.eye[1], s.eye[2]);
      const f = [s.target[0] - s.eye[0], s.target[1] - s.eye[1], s.target[2] - s.eye[2]];
      const fl = Math.hypot(...f) || 1;
      gl.uniform3f(uMsh.fwd, f[0] / fl, f[1] / fl, f[2] / fl);
      gl.uniform1f(uMsh.ortho, s.ortho ? 1 : 0);
      for (const [id, group] of byLayer(mshChunks)) {
        const st = stateOf(id);
        const pickable = st.meshPickable != null ? st.meshPickable : (st.meshOpacity == null || st.meshOpacity >= 0.95);
        if (!pickable) continue;
        gl.uniform1ui(uMsh.layer, id >>> 0);
        setSecMesh(uMsh, st);                              // the TRACE band, exactly as gl.js's meshSecOf draws it
        for (const c of group) {
          gl.bindVertexArray(c.vao);
          gl.drawElements(gl.TRIANGLES, c.idxCount, gl.UNSIGNED_INT, 0);
        }
      }
    }

    gl.disable(gl.SCISSOR_TEST);
  }

  // → { layer, rec } or null. Both come straight out of the integer target: no
  // byte reassembly, and the RECORD may use the full 32-bit range because the
  // miss sentinel now lives in the LAYER channel.
  function pick(px, py, chunks, cam, opts) {
    renderInto(px, py, 1, 1, chunks, cam, opts);
    const out = new Uint32Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    if (out[1] === NO_LAYER) return null;
    const g = out[1] >>> 0;
    return { layer: g & 0xFFFF, rec: out[0] >>> 0, face: (g >>> 16) & 7 };
  }

  // one ID-buffer pass over a RECT (device px, GL bottom-left origin) — the
  // marquee/lasso read. Same programs, same per-layer gates; returns the raw
  // RGBA block (rows bottom-up); the caller masks by polygon and decodes.
  // the marquee/lasso read: a Uint32Array of 4 components per pixel (rows
  // bottom-up) — [0] = record, [1] = layer | face<<16 (NO_LAYER = nothing there;
  // unpack with layerOfId/faceOfId, never by reading [1] raw)
  function pickRegion(px, py, w2, h2, chunks, cam, opts) {
    renderInto(px, py, w2, h2, chunks, cam, opts);
    const out = new Uint32Array(w2 * h2 * 4);
    gl.readPixels(px, py, w2, h2, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return out;
  }

  // deferred re-shade (gl-resolve.js): render the FULL-VIEWPORT id buffer and
  // hand back the target texture itself — NO readPixels; the resolve pass
  // samples it on the GPU. The texture stays owned by this pipeline; later
  // pick()/pickRegion() calls repaint scissored regions of it with the same
  // camera + geometry, so within one capture generation (camera and structure
  // frozen — the caller invalidates on any moving frame) the content stays
  // consistent. Leaves FBO at null; the caller restores its own target.
  function captureViewport(chunks, cam, opts) {
    renderInto(0, 0, opts.viewportW, opts.viewportH, chunks, cam, opts);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return { tex: colorTex, depth: depthTex, w, h };
  }

  return { pick, pickRegion, captureViewport, NO_LAYER };
}

// ── src/core/camera.js ──

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

// General 4×4 inverse (cofactor expansion, column-major). Used to unproject
// (pixel, depth) → world in the deferred re-shade resolve; the viewProj is
// always invertible for a real camera. Returns null on a singular matrix.
function mat4Inverse(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) return null;
  const d = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= d;
  return inv;
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
    zExag: 1,                                              // vertical exaggeration: a GLOBAL scene z-scale folded into viewProj (all layers stay registered; queries stay in real coords — see update())
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
    // near at radius/4000: on a km-scale fitted model the old /1000 put the
    // clip plane METRES in front of the camera — visible slicing when panning
    // close past geometry. /4000 keeps depth precision under a block size at
    // the far end of a 24-bit buffer (error ~ z²/(near·2²⁴): ~3 m at z=10 km
    // with near 2.5 m) while clipping 4× closer.
    c.near = Math.max(c.radius / 4000, 0.01);
    c.far = c.radius * 100;
    c.view = mat4LookAt(c.eye, c.target, [0, 0, 1]);
    c.halfH = c.radius * Math.tan(c.fovY / 2);
    c.proj = c.ortho ? mat4Ortho(c.halfH, c.aspect, c.near, c.far) : mat4Perspective(c.fovY, c.aspect, c.near, c.far);
    c.viewProj = mat4Multiply(c.proj, c.view);
    // Vertical exaggeration: fold a world-space z-scale into viewProj, pivoted at
    // the target's z (so the look-at point stays fixed). viewProj·M means every
    // vertex is z-scaled AT DRAW ONLY — shaders still test real z for section
    // culling (before viewProj), pick is the ID-buffer (real recIdx), measure
    // reads source records, and unproject uses inverse(viewProj) which yields real
    // coords. One matrix, all layers registered, every query honest.
    if (c.zExag && c.zExag !== 1) {
      const S = c.zExag, tz = c.target[2];                 // z' = tz + (z-tz)·S  ⇒  column-major z-scale about tz
      c.viewProj = mat4Multiply(c.viewProj, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, S, 0, 0, 0, tz * (1 - S), 1]);
    }
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
      // vertical exaggeration stretches displayed z by zExag, so a real-z move
      // shows amplified — divide the up-vector's z contribution by zExag so the
      // grabbed point tracks the cursor 1:1 (M⁻¹ of the up-move; x/y are unscaled).
      // In plan view cp=0 → no change, as it should be.
      c.target[2] += cp * (dyPx * s) / (c.zExag || 1);
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
      if (!cam.state.orbitLock) cam.orbit(-dA, 0);         // twist: grab-the-world (locked views don't twist)
      pinch = now;
      if (onChange) onChange();
      return;
    }
    if (!mode || mode === 'pinch') return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    // orbitLock (state flag): 2D/section-locked views — drags PAN instead of
    // orbiting, so a locked plan/section can't be knocked off-plane by a drag
    if (mode === 'orbit') { if (cam.state.orbitLock) cam.pan(dx, dy, canvas.clientHeight); else cam.orbit(-dx * 0.006, dy * 0.006); }
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

// ── src/core/gl-resolve.js ──

// @gcu/condenser — DEFERRED RE-SHADE (render-paths spec §2). Once the scene
// has converged, the pick pipeline's full-viewport (record, layer|face) id
// buffer is kept as a texture, and COSMETIC changes — ramp, clip, colour
// mode, filter (dim), selection, chanTex values — run ONE fullscreen resolve
// pass per element layer instead of re-rasterizing the geometry. O(pixels)
// at any model size: a ramp drag over a 50M-block model recolours at refresh
// rate instead of restarting the accumulation.
//
// Two GPU pieces, no CPU data needed:
//   bake    — per layer, scatter each element's (z, value, category, rgb) to
//             its RECORD's texel in an 8192-wide RGBA32F attribute texture
//             (one point-draw over the layer's chunks; works for streamed
//             models whose columns were never CPU-resident).
//   resolve — fullscreen triangle per layer: id → attr texel → the SAME
//             colour math the raster shaders use (parity by construction,
//             including the raster shaders' per-kind wash order), written
//             into the EDL colour buffer; `discard` leaves background /
//             mesh / other-layer pixels untouched, and the untouched EDL
//             depth still shades the presented frame.
//
// Blocks' per-face impostor lighting reconstructs from the id buffer's FACE
// code (gl-pick names the plane the eye ray entered): shade = (0.55 +
// 0.45·max(n·L,0)) · (cut ? 0.85 : 1) — the exact gl-blocks formula. Splat-
// demoted pixels (NO_FACE) stay unlit, exactly as rasterized. Out of scope
// (the caller falls back to re-raster): block EDGE lines (need the intra-face
// hit position), opacity < 1 (screen-door), catVis / isolate (they CULL
// geometry, so the id buffer itself goes stale), sticks / soup layers.


const TEXW = 8192;

// ── bake shaders: element → its record's texel ──────────────────────────────
const BAKE_VERT_BLOCKS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aIjk;
layout(location=1) in float aChan;
layout(location=2) in float aCat;
layout(location=3) in uint aRec;
uniform vec3 uGridOrigin, uGridSize;
uniform vec2 uChanChunk;                 // this chunk's [min, span] (dequantize aChan)
uniform vec2 uTexSize;
flat out vec4 vAttr;
void main() {
  int rec = int(aRec);
  vec2 px = vec2(float(rec & 8191) + 0.5, float(rec >> 13) + 0.5);
  gl_Position = vec4(px / uTexSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  float z = uGridOrigin.z + aIjk.z * uGridSize.z;
  vAttr = vec4(z, uChanChunk.x + aChan * uChanChunk.y, aCat, 0.0);
}`;

const BAKE_VERT_POINTS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aIntensity;
layout(location=2) in float aClass;
layout(location=3) in vec3 aRgb;
layout(location=4) in uint aRec;
uniform vec3 uBoxMin, uBoxSpan;
uniform vec2 uTexSize;
flat out vec4 vAttr;
void main() {
  int rec = int(aRec);
  vec2 px = vec2(float(rec & 8191) + 0.5, float(rec >> 13) + 0.5);
  gl_Position = vec4(px / uTexSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  float z = uBoxMin.z + aPos.z * uBoxSpan.z;
  // rgb packs into one float exactly (24 bits fit f32's 24-bit mantissa)
  float rgb = floor(aRgb.r * 255.0 + 0.5) + floor(aRgb.g * 255.0 + 0.5) * 256.0 + floor(aRgb.b * 255.0 + 0.5) * 65536.0;
  vAttr = vec4(z, aIntensity, aClass, rgb);
}`;

const BAKE_FRAG = `#version 300 es
precision highp float;
flat in vec4 vAttr;
out vec4 outAttr;
void main() { outAttr = vAttr; }`;

// ── the resolve pass: id → attrs → the raster shaders' colour math ──────────
const RESOLVE_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const RESOLVE_FRAG = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D uId;                  // RG32UI: R = record, G = layer | face<<16 (NO_LAYER = miss)
uniform sampler2D uAttr;                 // baked (z, value, cat, rgbPacked) by record
uniform sampler2D uRamp, uPalette, uMask, uSel, uRule, uChanTex;
uniform sampler2D uDepth;                // the capture's hit depths (edge-line unproject)
uniform uint uLayerId, uPicked, uPickedLayer;
uniform int uKind;                       // 0 = points, 1 = blocks
uniform int uColorMode;
uniform vec2 uZRange, uChanDoc;
uniform float uPaletteN, uIntensityScale;
uniform float uFilterOn, uSelOn, uRuleOn, uChanTexOn;
uniform vec3 uLightDir, uCutNormal;
uniform vec3 uFaceN[6];                  // gl-pick's FACE_NORMALS
uniform float uEdgesOn, uOrtho, uPerspScale;
uniform mat4 uInvVP;                     // inverse viewProj: (pixel, depth) → world hit point
uniform vec2 uViewport;
uniform vec3 uEyePos, uGridOrigin, uGridSize;   // the blocks layer's lattice (regular grids only)
out vec4 outColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  uvec2 id = texelFetch(uId, px, 0).rg;
  if (id.g == 0xFFFFFFFFu) discard;                        // background: untouched
  uint layer = id.g & 0xFFFFu;
  if (layer != uLayerId) discard;                          // mesh / other layers: untouched
  int rec = int(id.r);
  ivec2 at = ivec2(rec & 8191, rec >> 13);
  vec4 attr = texelFetch(uAttr, at, 0);
  float cls = attr.z;
  if (uRuleOn > 0.5) cls = floor(texelFetch(uRule, at, 0).r * 255.0 + 0.5);
  vec4 col;
  if (uColorMode == 0) {                                   // elevation (both kinds)
    float t = clamp((attr.x - uZRange.x) / max(uZRange.y, 1e-6), 0.0, 1.0);
    col = texture(uRamp, vec2(t, 0.5));
  } else if (uColorMode == 1) {
    if (uKind == 1) {                                      // blocks: grade (doc-normalized)
      float v = uChanTexOn > 0.5 ? texelFetch(uChanTex, at, 0).r : attr.y;
      float t = clamp((v - uChanDoc.x) / max(uChanDoc.y, 1e-6), 0.0, 1.0);
      col = texture(uRamp, vec2(t, 0.5));
    } else {                                               // points: intensity
      float t = clamp(attr.y * uIntensityScale, 0.0, 1.0);
      col = texture(uRamp, vec2(t, 0.5));
    }
  } else if (uColorMode == 2) {                            // category / classification
    col = texture(uPalette, vec2((cls + 0.5) / uPaletteN, 0.5));
  } else {
    if (uKind == 1) col = vec4(0.62, 0.63, 0.66, 1.0);     // blocks: solid
    else {                                                 // points: rgb (unpack)
      float p3 = attr.w;
      float b = floor(p3 / 65536.0); p3 -= b * 65536.0;
      float g = floor(p3 / 256.0); p3 -= g * 256.0;
      col = vec4(p3 / 255.0, g / 255.0, b / 255.0, 1.0);
    }
  }
  float m = 1.0;
  if (uFilterOn > 0.5) m = texelFetch(uMask, at, 0).r > 0.5 ? 1.0 : 0.0;
  float selHit = uSelOn > 0.5 ? texelFetch(uSel, at, 0).r : 0.0;
  // wash order matches each kind's raster shader EXACTLY: gl.js points dim
  // THEN sel-wash; gl-blocks sel-washes THEN dims. Only both-at-once pixels
  // differ between the orders, but parity is the contract here.
  if (uKind == 1) {
    if (selHit > 0.5) col = vec4(mix(col.rgb, vec3(1.0, 0.85, 0.3), 0.55), col.a);
    if (uFilterOn > 0.5 && m < 0.5) col = vec4(col.rgb * 0.3, col.a);
  } else {
    if (uFilterOn > 0.5 && m < 0.5) col = vec4(col.rgb * 0.3, col.a);
    if (selHit > 0.5) col = vec4(mix(col.rgb, vec3(1.0, 0.85, 0.3), 0.55), col.a);
  }
  if (id.r == uPicked && layer == uPickedLayer) col = vec4(mix(col.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, col.a);
  float shade = 1.0;
  if (uKind == 1) {                                        // blocks: per-face impostor lighting
    uint face = (id.g >> 16) & 7u;
    if (face < 6u) shade = 0.55 + 0.45 * max(dot(uFaceN[face], uLightDir), 0.0);
    else if (face == 6u) shade = (0.55 + 0.45 * max(dot(uCutNormal, uLightDir), 0.0)) * 0.85;   // the section cut wall
    // face 7 (NO_FACE): a demoted splat — unlit, as rasterized (and no edges)
    // BLOCK EDGE LINES (gl-blocks' exact math): the capture depth gives back
    // the hit point — unproject it, snap the block centre from the face plane
    // + the regular lattice, and the box-local coords fall out. Sub-blocked
    // models (per-block half-dims) can't reconstruct the centre this way and
    // fall back to the re-raster before we get here.
    if (uEdgesOn > 0.5 && face < 7u) {
      float dz = texelFetch(uDepth, px, 0).r;
      vec2 xy = (gl_FragCoord.xy / uViewport) * 2.0 - 1.0;
      vec4 hp = uInvVP * vec4(xy, dz * 2.0 - 1.0, 1.0);
      vec3 p = hp.xyz / hp.w;
      vec3 half_ = uGridSize * 0.5;
      // the pixel ray (also perturbed rays below, for the analytic derivative)
      vec4 rA = uInvVP * vec4(xy, -1.0, 1.0);
      vec4 rB = uInvVP * vec4(xy, 1.0, 1.0);
      vec3 ro = rA.xyz / rA.w, rd = rB.xyz / rB.w - ro;
      float pv = 0.0; int ax = 0;
      if (face < 6u) {
        // depth only PICKS the lattice face plane; the position comes from
        // re-intersecting the ray with that exact plane (no 24-bit jitter)
        ax = int(face >> 1);
        float o0 = uGridOrigin[ax] - half_[ax];
        pv = o0 + round((p[ax] - o0) / uGridSize[ax]) * uGridSize[ax];
        if (abs(rd[ax]) > 1e-12) p = ro + rd * ((pv - ro[ax]) / rd[ax]);
        p[ax] = pv;
      }
      vec3 base = face < 6u ? p - uFaceN[face] * half_ : p;   // face pixel: step inward; cut pixel: already interior
      vec3 center = uGridOrigin + vec3(round((base.x - uGridOrigin.x) / uGridSize.x), round((base.y - uGridOrigin.y) / uGridSize.y), round((base.z - uGridOrigin.z) / uGridSize.z)) * uGridSize;
      vec3 a2 = abs(p - center) / half_;
      float m1 = max(a2.x, max(a2.y, a2.z));
      float m2 = max(min(a2.x, a2.y), min(max(a2.x, a2.y), a2.z));
      float e = face == 6u ? m1 : m2;
      // ANALYTIC screen derivative of e: fwidth() cancels at block seams (e is
      // symmetric across them — …0.8, 1.0 │ 1.0, 0.8…), erasing the lines
      // exactly where they live; the raster never sees that because each
      // impostor is its own primitive with helper-invocation derivatives. So
      // evaluate e at the hardware's own 2×2 QUAD positions — rays through the
      // quad-aligned pixels, intersected with THIS pixel's plane — and
      // difference them ourselves. Quad alignment matters: it reproduces the
      // raster's per-quad-shared derivative, phase and all.
      float cutD = dot(p, uCutNormal);
      vec2 qb = floor(gl_FragCoord.xy * 0.5) * 2.0 + 0.5;
      float eq[3];
      for (int k = 0; k < 3; k++) {
        vec2 fxy = k == 0 ? qb : (k == 1 ? qb + vec2(1.0, 0.0) : qb + vec2(0.0, 1.0));
        vec2 nxy = (fxy / uViewport) * 2.0 - 1.0;
        vec4 qA = uInvVP * vec4(nxy, -1.0, 1.0);
        vec4 qB = uInvVP * vec4(nxy, 1.0, 1.0);
        vec3 qo = qA.xyz / qA.w, qd = qB.xyz / qB.w - qo;
        vec3 q;
        if (face < 6u) { float den = qd[ax]; q = abs(den) > 1e-12 ? qo + qd * ((pv - qo[ax]) / den) : p; }
        else { float den = dot(qd, uCutNormal); q = abs(den) > 1e-9 ? qo + qd * ((cutD - dot(qo, uCutNormal)) / den) : p; }
        vec3 aq = abs(q - center) / half_;
        float q1 = max(aq.x, max(aq.y, aq.z));
        float q2 = max(min(aq.x, aq.y), min(max(aq.x, aq.y), aq.z));
        eq[k] = face == 6u ? q1 : q2;
      }
      float fw = abs(eq[1] - eq[0]) + abs(eq[2] - eq[0]);
      float dpx = (1.0 - e) / max(fw, 1e-6);
      float edge = 1.0 - clamp(dpx * 0.7 - 0.3, 0.0, 1.0);
      float distE = uOrtho > 0.5 ? 1.0 : max(distance(uEyePos, center), 1e-3);
      float pxR = length(half_) * uPerspScale / distE;
      edge *= clamp((pxR - 5.0) / 8.0, 0.0, 1.0);          // fade toward demotion, as rasterized
      shade *= 1.0 - 0.4 * edge;
    }
  }
  outColor = vec4(col.rgb * shade, col.a);
}`;

function createResolvePipeline(gl) {
  // the bake target is RGBA32F — colour-renderable only with this extension;
  // absent (rare on WebGL2-era GPUs) the whole feature quietly disables and
  // every cosmetic change re-rasters, exactly as before.
  const floatOk = !!gl.getExtension('EXT_color_buffer_float');
  const bakeBlocks = makeProgram(gl, BAKE_VERT_BLOCKS, BAKE_FRAG);
  const bakePoints = makeProgram(gl, BAKE_VERT_POINTS, BAKE_FRAG);
  const resolveProg = makeProgram(gl, RESOLVE_VERT, RESOLVE_FRAG);
  const U = (p, n) => gl.getUniformLocation(p, n);
  const uB = { gridOrigin: U(bakeBlocks, 'uGridOrigin'), gridSize: U(bakeBlocks, 'uGridSize'), chanChunk: U(bakeBlocks, 'uChanChunk'), texSize: U(bakeBlocks, 'uTexSize') };
  const uP = { boxMin: U(bakePoints, 'uBoxMin'), boxSpan: U(bakePoints, 'uBoxSpan'), texSize: U(bakePoints, 'uTexSize') };
  const uR = {
    id: U(resolveProg, 'uId'), attr: U(resolveProg, 'uAttr'), ramp: U(resolveProg, 'uRamp'), palette: U(resolveProg, 'uPalette'),
    mask: U(resolveProg, 'uMask'), sel: U(resolveProg, 'uSel'), rule: U(resolveProg, 'uRule'), chanTex: U(resolveProg, 'uChanTex'),
    layerId: U(resolveProg, 'uLayerId'), picked: U(resolveProg, 'uPicked'), pickedLayer: U(resolveProg, 'uPickedLayer'),
    kind: U(resolveProg, 'uKind'), colorMode: U(resolveProg, 'uColorMode'), zRange: U(resolveProg, 'uZRange'), chanDoc: U(resolveProg, 'uChanDoc'),
    paletteN: U(resolveProg, 'uPaletteN'), intensityScale: U(resolveProg, 'uIntensityScale'),
    filterOn: U(resolveProg, 'uFilterOn'), selOn: U(resolveProg, 'uSelOn'), ruleOn: U(resolveProg, 'uRuleOn'), chanTexOn: U(resolveProg, 'uChanTexOn'),
    lightDir: U(resolveProg, 'uLightDir'), cutNormal: U(resolveProg, 'uCutNormal'), faceN: U(resolveProg, 'uFaceN'),
    depth: U(resolveProg, 'uDepth'), edgesOn: U(resolveProg, 'uEdgesOn'), ortho: U(resolveProg, 'uOrtho'), perspScale: U(resolveProg, 'uPerspScale'),
    invVP: U(resolveProg, 'uInvVP'), viewport: U(resolveProg, 'uViewport'), eyePos: U(resolveProg, 'uEyePos'),
    gridOrigin: U(resolveProg, 'uGridOrigin'), gridSize: U(resolveProg, 'uGridSize'),
  };
  const IDENT4 = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const bakeFbo = gl.createFramebuffer();
  const bakes = new Map();                                 // layerId → { tex, h }
  const faceFlat = new Float32Array(18);
  for (let i = 0; i < 6; i++) { const n = FACE_NORMALS[i]; faceFlat[i * 3] = n[0]; faceFlat[i * 3 + 1] = n[1]; faceFlat[i * 3 + 2] = n[2]; }

  // one bake VAO per blocks chunk: the same buffers the instanced VAO uses, but
  // re-pointed per-VERTEX (divisor 0) so one gl.POINTS draw scatters every block
  function blocksBakeVao(c) {
    if (c._bakeVao) return c._bakeVao;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bIjk); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bChan); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bCat); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.bRec); gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
    gl.bindVertexArray(null);
    c._bakeVao = vao;
    return vao;
  }

  return {
    ok: floatOk,
    // (re)bake one layer's attribute texture from its resident chunks.
    // maxRec = 1 + the highest record index the caller has seen for the layer.
    // Leaves the FBO at null and the viewport at the bake size — the caller
    // (inside the EDL sceneDraw) restores its own binding + viewport after.
    bakeLayer(layerId, chunksOfLayer, maxRec) {
      if (!floatOk || !chunksOfLayer.length || !maxRec) return null;
      const h = Math.max(1, Math.ceil(maxRec / TEXW));
      let b = bakes.get(layerId);
      if (!b || b.h < h) {
        if (b) gl.deleteTexture(b.tex);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXW, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        b = { tex, h };
        bakes.set(layerId, b);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.tex, 0);
      gl.viewport(0, 0, TEXW, b.h);
      gl.disable(gl.DEPTH_TEST);
      const kind = chunksOfLayer[0].kind;
      if (kind === 'blocks') {
        gl.useProgram(bakeBlocks);
        gl.uniform2f(uB.texSize, TEXW, b.h);
        for (const c of chunksOfLayer) {
          const g = c.grid;
          gl.uniform3f(uB.gridOrigin, g.originLocal[0], g.originLocal[1], g.originLocal[2]);
          gl.uniform3f(uB.gridSize, g.size[0], g.size[1], g.size[2]);
          const span = c.chanRange[1] - c.chanRange[0];
          gl.uniform2f(uB.chanChunk, c.chanRange[0], span > 0 ? span : 0);
          gl.bindVertexArray(blocksBakeVao(c));
          gl.drawArrays(gl.POINTS, 0, c.count);
        }
      } else {
        gl.useProgram(bakePoints);
        gl.uniform2f(uP.texSize, TEXW, b.h);
        for (const c of chunksOfLayer) {
          const bb = c.bboxLocal;
          gl.uniform3f(uP.boxMin, bb[0], bb[1], bb[2]);
          gl.uniform3f(uP.boxSpan, bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]);
          gl.bindVertexArray(c.vao);                       // per-vertex layout already, locations match
          gl.drawArrays(gl.POINTS, 0, c.count);
        }
      }
      gl.bindVertexArray(null);
      gl.enable(gl.DEPTH_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return b;
    },
    hasBake(layerId) { return bakes.has(layerId); },
    dropBake(layerId) { const b = bakes.get(layerId); if (b) { gl.deleteTexture(b.tex); bakes.delete(layerId); } },
    // one fullscreen pass for one layer, into the CURRENTLY BOUND framebuffer
    // (the EDL colour buffer). `u` carries the same per-layer values the raster
    // path's begin/setup functions computed. Depth stays untouched.
    resolveLayer(idTex, layerId, u) {
      const b = bakes.get(layerId);
      if (!b) return false;
      gl.useProgram(resolveProg);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      const bind = (unit, loc, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); };
      bind(0, uR.id, idTex);
      bind(1, uR.attr, b.tex);
      bind(2, uR.ramp, u.ramp);
      bind(3, uR.palette, u.palette);
      // every float sampler MUST land on a float texture: an unset sampler
      // uniform defaults to unit 0 — the INTEGER id texture — and that type
      // mismatch silently kills the whole draw (GL_INVALID_OPERATION). The
      // ramp parks the unused ones; their On-flags gate actual sampling.
      bind(4, uR.mask, u.mask || u.ramp);
      bind(5, uR.sel, u.sel || u.ramp);
      bind(6, uR.rule, u.rule || u.ramp);
      bind(7, uR.chanTex, u.chanTex || u.ramp);
      bind(8, uR.depth, (u.edges && u.depth) || u.ramp);   // depth-as-sampler2D: .r is the depth (compare mode NONE)
      gl.uniform1f(uR.edgesOn, u.edges && u.depth ? 1 : 0);
      gl.uniform1f(uR.ortho, u.ortho ? 1 : 0);
      gl.uniform1f(uR.perspScale, u.perspScale || 1);
      gl.uniformMatrix4fv(uR.invVP, false, u.invVP || IDENT4);
      gl.uniform2f(uR.viewport, u.viewportW || 1, u.viewportH || 1);
      gl.uniform3f(uR.eyePos, u.eye ? u.eye[0] : 0, u.eye ? u.eye[1] : 0, u.eye ? u.eye[2] : 0);
      gl.uniform3f(uR.gridOrigin, u.grid ? u.grid.originLocal[0] : 0, u.grid ? u.grid.originLocal[1] : 0, u.grid ? u.grid.originLocal[2] : 0);
      gl.uniform3f(uR.gridSize, u.grid ? u.grid.size[0] : 1, u.grid ? u.grid.size[1] : 1, u.grid ? u.grid.size[2] : 1);
      gl.uniform1ui(uR.layerId, layerId >>> 0);
      gl.uniform1ui(uR.picked, u.picked >>> 0);
      gl.uniform1ui(uR.pickedLayer, u.pickedLayer >>> 0);
      gl.uniform1i(uR.kind, u.kind === 'blocks' ? 1 : 0);
      gl.uniform1i(uR.colorMode, u.colorMode | 0);
      gl.uniform2f(uR.zRange, u.zRange[0], u.zRange[1]);
      gl.uniform2f(uR.chanDoc, u.chanDoc[0], u.chanDoc[1]);
      gl.uniform1f(uR.paletteN, u.paletteN);
      gl.uniform1f(uR.intensityScale, u.intensityScale);
      gl.uniform1f(uR.filterOn, u.mask ? 1 : 0);
      gl.uniform1f(uR.selOn, u.sel ? 1 : 0);
      gl.uniform1f(uR.ruleOn, u.rule ? 1 : 0);
      gl.uniform1f(uR.chanTexOn, u.chanTex ? 1 : 0);
      gl.uniform3f(uR.lightDir, u.lightDir[0], u.lightDir[1], u.lightDir[2]);
      gl.uniform3f(uR.cutNormal, u.cutNormal[0], u.cutNormal[1], u.cutNormal[2]);
      gl.uniform3fv(uR.faceN, faceFlat);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      return true;
    },
    clear() { for (const b of bakes.values()) gl.deleteTexture(b.tex); bakes.clear(); },
  };
}

// ── src/core/gl.js ──

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
uniform uint uPicked;                   // picked RECORD (0xFFFFFFFF = none)
uniform uint uPickedLayer;              // …and the layer it belongs to
uniform uint uLayer;                    // this draw's layer (per-draw, not per-element)                   // record index to highlight (0xFFFFFFFF = none)
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
    int rec = int(aRec);
    m = texelFetch(uMask, ivec2(rec & 8191, rec >> 13), 0).r > 0.5 ? 1.0 : 0.0;
    if (uIsolate > 0.5 && m < 0.5) vCull = 1.0;
  }
  float cls = aClass;
  if (uRuleOn > 0.5) {
    int rr = int(aRec);
    cls = floor(texelFetch(uRule, ivec2(rr & 8191, rr >> 13), 0).r * 255.0 + 0.5);
  }
  if (uCatVisOn > 0.5 && texelFetch(uCatVis, ivec2(int(cls) & 255, 0), 0).r < 0.5) vCull = 1.0;
  float selHit = 0.0;
  if (uSelOn > 0.5) {
    int rs = int(aRec);
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
  if (aRec == uPicked && uLayer == uPickedLayer) vColor = vec4(mix(vColor.rgb, vec3(1.0, 0.15, 0.7), 0.85) + 0.1, vColor.a);   // picked: hot magenta — the hue viridis doesn't have
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
    intensityScale: U('uIntensityScale'), ramp: U('uRamp'), palette: U('uPalette'), picked: U('uPicked'), pickedLayer: U('uPickedLayer'), layer: U('uLayer'), repaint: U('uRepaint'),
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
  let resolvePipe = null;                                 // deferred re-shade pipeline, lazy (gl-resolve.js)
  const chunks = [];
  let docBbox = null;                                     // scene bbox (fit + the shared elevation ramp)
  let pickedRec = 0xFFFFFFFF;                             // highlighted RECORD (sentinel = none)
  let pickedLayer = 0xFFFFFFFF;                           // …and its layer (the pair IS the identity now)
  const repaintSet = new Set();                           // records to repaint over a converged frame
  let lastConverged = false;
  // ── layers (micro-layers spec §1): each opened dataset is a layer with its own
  // visibility, filter mask, compaction set, and color ranges. recIdx is
  // PARTITIONED — (layerId << 29) | record — so one ID buffer serves all layers
  // (§3). Single-layer callers never notice: layer 0 shifts by zero and every
  // API defaults to it. ──
  const layers = new Map();                               // id → per-layer state
  // a layer's view of the section: false = exempt, 'front'/'behind' = keep that
  // side only (a half-space is a slab with the far face pushed past the data —
  // same trick the global clip uses, but per layer, derived from sec.d0)
  const layerSecOf = (ls, sec) => {
    const m = ls.sectioned;
    if (!sec || m === false) return m === false ? null : sec;
    if ((m === 'front' || m === 'behind') && sec.d0 !== undefined) {
      const H = Math.max(1e5, 8 * (sec.half || 1));
      return { ...sec, d: m === 'front' ? sec.d0 + H : sec.d0 - H, half: H, clip: m, traceHalf: sec.traceHalf || (sec.half < 9e4 ? sec.half : 1) };
    }
    return sec;
  };
  // meshes render their section as a TRACE flattened onto the wall — for a
  // half-space clip the slab half is ~1e5 (it swallows the scene), so the
  // trace band narrows to the TRUE plane ± traceHalf; slab sections already
  // carry the right width
  const meshSecOf = (ls, sec) => {
    const s2 = layerSecOf(ls, sec);
    if (!s2 || !(s2.clip === 'front' || s2.clip === 'behind') || s2.d0 === undefined) return s2;
    return { ...s2, d: s2.d0, half: Math.max(0.01, s2.traceHalf || 1) };
  };
  function layerOf(id) {
    let l = layers.get(id);
    if (!l) {
      l = { visible: true, set: 'base', maskTex: null, maskH: 0, isolate: false,
            intensityMax: 1, docChan: [Infinity, -Infinity], catN: 0, stickRadius: 1, sectioned: true,
            meshTint: [0.62, 0.64, 0.66], meshOpacity: 1, opacity: 1, catVisTex: null, rampTex: null, paletteTex: null, paletteW: 0, selTex: null, selH: 0,
            ruleTex: null, ruleH: 0, ruleOn: false,
            chanTex: null, chanTexRange: null };
      layers.set(id, l);
    }
    return l;
  }
  const activeChunk = (c) => { const l = layers.get(c._layer); return !!l && l.visible && c._set === l.set; };
  const freeChunk = (c) => { gl.deleteVertexArray(c.vao); if (c._bakeVao) gl.deleteVertexArray(c._bakeVao); c.buffers.forEach((b) => gl.deleteBuffer(b)); };
  const byLayer = (arr) => {
    const m = new Map();
    for (const c of arr) { let g = m.get(c._layer); if (!g) m.set(c._layer, g = []); g.push(c); }
    return m;
  };
  // accumulation state
  const lastVP = new Float32Array(16);
  let lastKey = '', needClear = true, lastVisible = 0;
  // deferred re-shade state (gl-resolve.js): a COSMETIC change (ramp, clip,
  // colour mode, dim-filter, selection, chanTex values) over a converged frame
  // resolves per-pixel from the captured id buffer instead of re-rastering.
  // Dirt is tracked PER LAYER: a ramp drag on the block model must not care
  // that a drillhole (sticks) layer shares the scene — untouched layers keep
  // their accumulated pixels, and only a change to an UNRESOLVABLE layer
  // falls back to the re-raster.
  const cosmeticDirtyLayers = new Set();                  // layers a cosmetic setter touched
  const lastCosSig = new Map();                           // layer → view-opts signature last rastered/resolved
  let idCapture = null;                                   // { tex, w, h } from pickPipe.captureViewport
  const layerMaxRec = new Map();                          // layer → 1 + highest record index seen
  const bakeDirty = new Set();                            // layers whose attr bake is stale
  let resolves = 0;                                       // resolve passes run (harness observability)
  const trackRec = (layer, recIdx) => {
    let m = layerMaxRec.get(layer) || 0;
    for (let i = 0; i < recIdx.length; i++) if (recIdx[i] >= m) m = recIdx[i] + 1;
    layerMaxRec.set(layer, m);
    bakeDirty.add(layer);
  };

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
    get resolveCount() { return resolves; },               // deferred re-shade passes run (harness observability)
    addChunk(chunk, set = 'base', layer = 0) {
      const ls = layerOf(layer);
      idCapture = null;                                   // new geometry: the captured id buffer is stale
      // recIdx stays RAW — the layer rides a per-draw uniform, so there is no
      // per-element rewrite here any more (and no 3-bit ceiling on layers)
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
        if (chunk.kind === 'blocks' && chunk.recIdx) trackRec(layer, chunk.recIdx);   // re-shade bake bookkeeping
        if (set === 'base') {                              // compact chunks never tighten the ramp
          if (chunk.chanRange[0] < ls.docChan[0]) ls.docChan[0] = chunk.chanRange[0];
          if (chunk.chanRange[1] > ls.docChan[1]) ls.docChan[1] = chunk.chanRange[1];
        }
        return;
      }
      const up = uploadChunk(gl, chunk); up._set = set; up._layer = layer; up.bytes = cb;
      chunks.push(up);                                     // GPU owns it now; CPU copy dies with the caller
      if (chunk.recIdx) trackRec(layer, chunk.recIdx);     // re-shade bake bookkeeping (points)
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
      const culled = isolate || (ls.isolate && !!ls.maskTex);   // isolate CULLS (now or before) → geometry changes
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
      if (culled) needClear = true; else cosmeticDirtyLayers.add(layer);   // dim-mode filter is a re-shade, not a re-raster
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
    setLayerCats(layer, n) { const ls = layerOf(layer); if (ls.catN !== (n || 0)) { ls.catN = n || 0; cosmeticDirtyLayers.add(layer); } },
    // stick thickness (world metres) — a live per-layer knob
    setLayerStickRadius(layer, r) { const ls = layerOf(layer); const v = Math.max(0.05, +r || 1); if (ls.stickRadius !== v) { ls.stickRadius = v; needClear = true; } },
    layerStickRadius(layer) { return layerOf(layer).stickRadius; },
    layerChanRange(layer) { const ls = layers.get(layer); return ls && ls.docChan[0] !== Infinity ? [ls.docChan[0], ls.docChan[1]] : null; },
    // per-layer section participation: an exempt layer draws (and picks) whole
    // while the others are slabbed — e.g. topo kept for context during sectioning
    setLayerSectioned(layer, mode) { const ls = layerOf(layer); const v = mode === undefined ? true : mode; if (ls.sectioned !== v) { ls.sectioned = v; needClear = true; } },
    layerSectioned(layer) { const m = layerOf(layer).sectioned; return m === undefined ? true : m; },
    
    // context-mesh style: tint [r,g,b] 0..1 + opacity 0..1 (Bayer screen-door)
    setLayerMeshStyle(layer, { tint, opacity } = {}) {
      const ls = layerOf(layer);
      if (tint) ls.meshTint = tint;
      if (opacity != null) ls.meshOpacity = Math.max(0.02, Math.min(1, +opacity));
      needClear = true;
    },
    layerMeshStyle(layer) { const ls = layerOf(layer); return { tint: ls.meshTint, opacity: ls.meshOpacity }; },
    // per-layer opacity for blocks (box impostors) + sticks (drillholes) — applied
    // as a screen-door dither in their shaders (see-through, no alpha-blend ordering).
    // Is this mesh layer PICKABLE? null = the default (opaque meshes pick, see-through
    // ones don't — you made it see-through to work on what is behind it). The app
    // overrides per layer: micro turns the ACTIVE mesh on, so selecting a surface in
    // the tree is what makes it clickable.
    setLayerPickable(layer, v) { layerOf(layer).meshPickable = v == null ? null : !!v; },
    layerPickable(layer) { const v = layerOf(layer).meshPickable; return v === undefined ? null : v; },
    setLayerOpacity(layer, opacity) { const ls = layerOf(layer); const v = Math.max(0.02, Math.min(1, +opacity)); ls.opacity = v; ls.meshOpacity = v; needClear = true; },   // ONE knob: mesh-family layers read meshOpacity
    // block-edge override: null = follow the draw-level blockEdges flag, true/false = force
    setLayerEdges(layer, v) { const ls = layerOf(layer); const nv = v == null ? null : !!v; if (ls.edges !== nv) { ls.edges = nv; needClear = true; } },
    layerEdges(layer) { const v = layerOf(layer).edges; return v === undefined ? null : v; },
    layerOpacity(layer) { return layerOf(layer).opacity; },
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
      cosmeticDirtyLayers.add(layer);                                // a wash, not a cull — re-shade path
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
      // rule codes recolour (cosmetic) — but when class EYES are active they
      // also re-CULL through catVis, which the captured id buffer can't follow
      if (ls.ruleOn && ls.catVisTex) needClear = true; else cosmeticDirtyLayers.add(layer);
    },
    // rule mode on/off per layer — kept separate from the codes so switching
    // categorized ⇄ rule-based is a flag flip, no re-upload
    setLayerRuleMode(layer, on) {
      const ls = layerOf(layer);
      if (ls.ruleOn !== !!on) {
        ls.ruleOn = !!on;
        if (ls.catVisTex) needClear = true; else cosmeticDirtyLayers.add(layer);   // eyes re-index on the flip
      }
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
      cosmeticDirtyLayers.add(layer);
    },
    // per-layer color ramp LUT (layer properties: presets + baked breakpoints).
    // pixels = Uint8Array(256*4) RGBA, or null to fall back to the built-in ramp.
    // OPT-IN: drive block colour from an R32F VALUE texture (one texel per record,
    // 8192-wide rows) instead of the baked aChan buffer. `range` = [lo, hi] for the
    // ramp normalization — a computed texture has no docChan of its own. Pass a
    // null texture to fall back to aChan. The caller OWNS the texture (create,
    // render into, delete); the renderer only samples it.
    setLayerChanTex(layer, tex, range = null) {
      const ls = layerOf(layer);
      ls.chanTex = tex || null;
      ls.chanTexRange = (tex && range) ? [range[0], Math.max(1e-9, range[1] - range[0])] : null;
      cosmeticDirtyLayers.add(layer);
    },
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
      cosmeticDirtyLayers.add(layer);
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
      if (resolvePipe) resolvePipe.dropBake(layer);
      layerMaxRec.delete(layer); bakeDirty.delete(layer);
      lastCosSig.delete(layer); cosmeticDirtyLayers.delete(layer);
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
    // { layer, rec } — or null for "nothing picked". The pair IS the identity:
    // record 5 of layer 2 and record 5 of layer 3 are different elements.
    setPicked(pick) {
      const next = pick == null ? 0xFFFFFFFF : (pick.rec >>> 0);
      const nextL = pick == null ? 0xFFFFFFFF : (pick.layer >>> 0);
      if (next === pickedRec && nextL === pickedLayer) return;
      const prev = pickedRec;
      pickedRec = next; pickedLayer = nextL;
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
      if (resolvePipe) resolvePipe.clear();
      layerMaxRec.clear(); bakeDirty.clear(); idCapture = null;
      lastCosSig.clear(); cosmeticDirtyLayers.clear();
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
    draw(cam, { budget = 3_000_000, pointPx = 2.5, colorMode = 0, blocksAsPoints = false, blockEdges = false, section = null, clip = null, layerOpts = null } = {}) {
      const vp = cam.state.viewProj;
      const sec = section && section.on ? section : null;
      const secKey = sec ? `${sec.n.join(',')}|${sec.d}|${sec.half}` : 'off';
      // the old single draw key, SPLIT: structural changes re-raster; cosmetic
      // ones (colour mode, clip, per-layer view opts — plus whatever the
      // cosmetic setters touched) can deferred-re-shade over the converged frame
      const structKey = `${pointPx}|${blocksAsPoints ? 'P' : 'B'}${blockEdges ? 'E' : ''}|${secKey}|${canvas.width}x${canvas.height}`;
      let moving = vpChanged(vp) || structKey !== lastKey || needClear;

      const db = docBbox || Float64Array.of(0, 0, 0, 1, 1, 1);
      // per-layer view opts (color mode + clip); the globals when not overridden
      const lopt = (id) => (layerOpts && layerOpts[id]) || { colorMode, clip };
      // elevation ramp = the SCENE z range (layers share vertical space) + clip
      const zRangeOf = (o) => {
        const zLo = o.clip && o.clip[0] != null && o.colorMode === 0 ? o.clip[0] : db[2];
        const zHi = o.clip && o.clip[1] != null && o.colorMode === 0 ? o.clip[1] : db[5];
        return [zLo, Math.max(zHi - zLo, 1e-6)];
      };

      // per-layer cosmetic DIRT: explicit setter dirt + drift in the view opts
      // this layer's raster consumed (colour mode + clip, global or per-layer).
      // Hidden layers can't change pixels; meshes ignore colour opts entirely
      // (their cosmetics go through setLayerMeshStyle → needClear).
      const sigOf = (id) => { const o = lopt(id); return `${o.colorMode}|${o.clip ? `${o.clip[0]}~${o.clip[1]}` : 'a'}`; };
      const kindBy = new Map(), subBy = new Set();
      for (const c of chunks) if (activeChunk(c)) {
        if (!kindBy.has(c._layer)) kindBy.set(c._layer, c.kind);
        if (c.dimPalette) subBy.add(c._layer);             // sub-blocked: variable half-dims
      }
      const dirty = new Set(cosmeticDirtyLayers);
      for (const id of kindBy.keys()) if (lastCosSig.get(id) !== sigOf(id)) dirty.add(id);
      for (const id of [...dirty]) { const k = kindBy.get(id); if (!k || k === 'mesh') dirty.delete(id); }

      // ── DEFERRED RE-SHADE (gl-resolve.js): cosmetic changes over a CONVERGED
      // frame become one fullscreen resolve pass per DIRTY layer — O(pixels) at
      // any model size. Untouched layers (a drillhole sticks layer while the
      // block ramp drags) keep their accumulated pixels; only a change to a
      // layer the id buffer can't express (sticks/soup recolour, culling,
      // opacity, edges) falls through to the re-raster. ──
      if (!moving && dirty.size && lastConverged) {
        if (!resolvePipe) resolvePipe = createResolvePipeline(gl);
        resolveOk: if (resolvePipe.ok) {
          let bail = false;
          const groups = new Map();
          for (const id of dirty) {
            const ls = layerOf(id), k = kindBy.get(id);
            if (k !== 'points' && k !== 'blocks') { bail = true; break; }   // a sticks/soup recolour must re-raster
            if (ls.opacity < 0.999) { bail = true; break; }   // screen-door holes aren't in the id buffer
            // edge lines RESOLVE for regular grids (the capture depth unprojects
            // the hit point, the lattice snaps the centre); sub-blocked models
            // have per-block half-dims the depth alone can't recover
            if (k === 'blocks' && (ls.edges != null ? ls.edges : blockEdges) && subBy.has(id)) { bail = true; break; }
            groups.set(id, []);
            // NOTE: isolate filters and class eyes (catVis) are FINE here even
            // though they cull — changing them goes through needClear, so at
            // this point they are unchanged since the capture and the id
            // buffer already reflects the culled geometry.
          }
          if (bail || !groups.size) break resolveOk;
          const act = chunks.filter(activeChunk);
          for (const c of act) { const g = groups.get(c._layer); if (g) g.push(c); }
          // capture the id buffer LAZILY — ids don't depend on cosmetics, so the
          // pre-change converged geometry still yields the correct capture; a
          // still scene that never gets a cosmetic poke never pays for one
          if (!pickPipe) pickPipe = createPickPipeline(gl);
          const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          if (!idCapture || idCapture.w !== canvas.width || idCapture.h !== canvas.height) {
            idCapture = pickPipe.captureViewport(act, cam, {
              pointPx, blocksAsPoints, layerStates: layers,
              section: sec, viewportW: canvas.width, viewportH: canvas.height,
            });
          }
          for (const [id, group] of groups) {              // (re)bake stale attr textures
            if (!resolvePipe.hasBake(id) || bakeDirty.has(id)) {
              resolvePipe.bakeLayer(id, group, layerMaxRec.get(id) || 0);
              bakeDirty.delete(id);
            }
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);     // back to the EDL target
          gl.viewport(0, 0, canvas.width, canvas.height);
          // headlight — the exact formula blocksPipe.begin computes
          const s = cam.state, v = s.view;
          let lx = s.eye[0] - s.target[0], ly = s.eye[1] - s.target[1], lz = s.eye[2] - s.target[2];
          const ll = Math.hypot(lx, ly, lz) || 1;
          lx = lx / ll + v[1] * 0.4; ly = ly / ll + v[5] * 0.4; lz = lz / ll + v[9] * 0.4;
          const l2 = Math.hypot(lx, ly, lz) || 1;
          const lightDir = [lx / l2, ly / l2, lz / l2];
          const invVP = mat4Inverse(vp);                   // edge-line unproject
          const perspScale = s.ortho ? (canvas.height / 2) / s.halfH : (canvas.height / 2) / Math.tan(s.fovY / 2);
          for (const [id, group] of groups) {
            const ls = layerOf(id), o = lopt(id), zr = zRangeOf(o);
            let u;
            if (group[0].kind === 'blocks') {
              const cLo = o.clip && o.clip[0] != null && o.colorMode === 1 ? o.clip[0] : (ls.docChan[0] === Infinity ? 0 : ls.docChan[0]);
              const cHi = o.clip && o.clip[1] != null && o.colorMode === 1 ? o.clip[1] : ls.docChan[1];
              // the cut wall faces the viewer: the section normal signed toward the eye
              const lsec = layerSecOf(ls, sec);
              let cutN = [0, 0, 1];
              if (lsec) {
                const sgn = Math.sign(s.eye[0] * lsec.n[0] + s.eye[1] * lsec.n[1] + s.eye[2] * lsec.n[2] - lsec.d) || 1;
                cutN = [lsec.n[0] * sgn, lsec.n[1] * sgn, lsec.n[2] * sgn];
              }
              u = {
                kind: 'blocks', colorMode: o.colorMode, zRange: zr,
                chanDoc: ls.chanTex && ls.chanTexRange ? ls.chanTexRange : [cLo, cHi > cLo ? cHi - cLo : 1],
                paletteN: 256, intensityScale: 1,
                ramp: ls.rampTex || ramp, palette: ls.paletteTex || catPalette || palette,
                mask: ls.maskTex, sel: ls.selTex, rule: ls.ruleOn ? ls.ruleTex : null, chanTex: ls.chanTex,
                picked: pickedRec, pickedLayer, lightDir, cutNormal: cutN,
                edges: ls.edges != null ? ls.edges : blockEdges, depth: idCapture.depth,
                invVP, viewportW: canvas.width, viewportH: canvas.height,
                eye: [s.eye[0], s.eye[1], s.eye[2]], ortho: s.ortho, perspScale,
                grid: group[0].grid,
              };
            } else {
              u = {
                kind: 'points', colorMode: o.colorMode, zRange: zr, chanDoc: [0, 1],
                paletteN: ls.paletteTex ? ls.paletteW : (ls.catN || 32),
                intensityScale: 65535 / (ls.intensityMax || 1),
                ramp: ls.rampTex || ramp, palette: ls.paletteTex || (ls.catN && catPalette ? catPalette : palette),
                mask: ls.maskTex, sel: ls.selTex, rule: ls.ruleOn ? ls.ruleTex : null, chanTex: null,
                picked: pickedRec, pickedLayer, lightDir: [0, 0, 1], cutNormal: [0, 0, 1],
              };
            }
            resolvePipe.resolveLayer(idCapture.tex, id, u);
          }
          resolves++;
          for (const id of kindBy.keys()) lastCosSig.set(id, sigOf(id));
          cosmeticDirtyLayers.clear();
          // repaintSet stays: a pending pick highlight on a NON-resolved layer
          // is repainted by the next still frame's repaint pass
          return { drawn: 0, converged: true, visible: lastVisible, resolved: true };
        }
      }
      if (dirty.size) moving = true;                       // no resolve → a cosmetic change re-rasters
      lastKey = structKey; needClear = false;
      for (const id of kindBy.keys()) lastCosSig.set(id, sigOf(id));
      cosmeticDirtyLayers.clear();
      if (moving) { repaintSet.clear(); idCapture = null; }   // full redraw covers pending repaint; the capture is stale

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
          meshPipe.begin(cam, { tint: ls.meshTint, opacity: ls.meshOpacity, section: meshSecOf(ls, sec),
            vcolor: group.some((c) => c.hasColor), vnormal: group.some((c) => c.hasNormal) });   // heightfield drape + smooth normals
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
          soupPipe.begin(cam, { tint: ls.meshTint, opacity: ls.meshOpacity, section: meshSecOf(ls, sec) });
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
        gl.uniform1ui(uni.pickedLayer, pickedLayer);
        gl.uniform2ui(uni.repaint, 0xFFFFFFFF, 0xFFFFFFFF);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ramp); gl.uniform1i(uni.ramp, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, palette); gl.uniform1i(uni.palette, 1);
        // per-layer uniforms + slices (front-to-back preserved within each group)
        const setupPtsLayer = (id) => {
          const ls = layerOf(id), o = lopt(id), zr = zRangeOf(o);
          gl.uniform1ui(uni.layer, id >>> 0);
          const lsec = layerSecOf(ls, sec);
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
          // sub-blocked: fine grid.size is the min pitch — use the largest box radius
          const rBlock = c.dimPalette
            ? Math.max(...c.dimPalette.map((h) => Math.hypot(h[0], h[1], h[2])))
            : Math.hypot(c.grid.size[0], c.grid.size[1], c.grid.size[2]) / 2;
          const distNear = Math.max(cam.state.near, c._dist - bboxR);
          return blocksAsPoints || rBlock * perspScale / distNear < 2.0;
        };
        const beginLayer = (id) => {
          const ls = layerOf(id), o = lopt(id);
          const cLo = o.clip && o.clip[0] != null && o.colorMode === 1 ? o.clip[0] : (ls.docChan[0] === Infinity ? 0 : ls.docChan[0]);
          const cHi = o.clip && o.clip[1] != null && o.colorMode === 1 ? o.clip[1] : ls.docChan[1];
          blocksPipe.begin(cam, {
            pointPx, colorMode: o.colorMode, zRange: zRangeOf(o),
            chanDoc: ls.chanTex && ls.chanTexRange ? ls.chanTexRange : [cLo, cHi > cLo ? cHi - cLo : 1],
            ramp: ls.rampTex || ramp, palette: ls.paletteTex || catPalette || palette, viewportH: canvas.height,
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec, pickedLayer, layer: id,
            section: layerSecOf(ls, sec),
            catVisTex: ls.catVisTex, selTex: ls.selTex, ruleTex: ls.ruleOn ? ls.ruleTex : null,
            chanTex: ls.chanTex,
            opacity: ls.opacity, edges: ls.edges != null ? ls.edges : blockEdges,   // per-layer override, else the View toggle
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
            maskTex: ls.maskTex, isolate: ls.isolate, pointsView: blocksAsPoints, picked: pickedRec, pickedLayer, layer: id,
            section: layerSecOf(ls, sec),
            radius: ls.stickRadius, catVisTex: ls.catVisTex, selTex: ls.selTex, ruleTex: ls.ruleOn ? ls.ruleTex : null,
            opacity: ls.opacity,
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

// ── src/core/edl.js ──

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

// ── src/core.js ──

// @gcu/condenser/core — the render engine alone: chunk builders + GL pipelines
// + camera + EDL + Morton. Zero I/O, zero providers; @gcu/frame is the one
// inlined leaf (every chunk is frame-relative). The full package (main.js)
// re-exports this same surface plus io/ + grid/.

// ── ../../drillhole/src/desurvey.js ──

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

// ── ../../drillhole/src/validate.js ──

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

// ── ../../drillhole/src/samples.js ──

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

// ── src/widget.js ──

// @gcu/condenser — the anywidget (Jupyter) front half. Glue only: it decodes
// the packed columnar payload, feeds each layer through the engine's chunk
// builders, and drives one progressive render loop per widget instance. All
// the rendering intelligence (Morton order, prefix LOD, box impostors, capsule
// impostors, EDL, true sections, the ID-buffer pick) is @gcu/condenser/core,
// unchanged — the SAME engine micro ships, so a notebook and the desktop tool
// agree by construction. Drillholes desurvey through @gcu/drillhole, also the
// same code, so a hole lands in the same place in both.
//
// anywidget contract: default-export an object with render({model, el}),
// returning a cleanup function. `_payload` is one atomic Bytes blob holding
// EVERY layer against ONE shared frame; `_styles` is a per-layer style dict.


// ── ramp presets. rampPixels' default is the viridis-ish walk; these are the
// few a geologist reaches for. Kept here (not in the engine) because they are
// a PRESENTATION choice — micro has its own richer set in its own UI. ──
const RAMPS = {
  viridis: null,                                           // the engine default
  magma: [[0, 0, 4], [80, 18, 123], [182, 54, 121], [252, 137, 97], [252, 253, 191]],
  turbo: [[48, 18, 59], [28, 156, 220], [96, 252, 100], [249, 190, 60], [122, 4, 3]],
  greys: [[20, 20, 20], [90, 90, 90], [150, 150, 150], [205, 205, 205], [250, 250, 250]],
  spectral: [[94, 79, 162], [102, 194, 165], [255, 255, 191], [253, 174, 97], [158, 1, 66]],
  fire: [[10, 5, 40], [120, 20, 90], [220, 80, 40], [250, 180, 50], [255, 250, 200]],
};

const TYPES = { f64: Float64Array, f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array };

// ── the wire format (mirrors gcu_condenser/__init__.py's _pack) ──
//   'CDNS' | u32 version | u32 headerLen | header JSON (utf-8) | pad | body
// Column offsets are RELATIVE TO THE BODY START, which both sides derive as
// (12 + headerLen) rounded up to 8 — self-describing without the offsets
// depending on the header's own length. ONE blob keeps a data change ATOMIC.
function decodePayload(raw) {
  if (!raw) return null;
  const buf = raw instanceof ArrayBuffer ? raw : (raw.buffer || raw);
  const base = raw.byteOffset || 0;
  const len = raw.byteLength != null ? raw.byteLength : (buf ? buf.byteLength : 0);
  if (!buf || len < 12) return null;
  const dv = new DataView(buf, base, len);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'CDNS') return null;
  const headerLen = dv.getUint32(8, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, base + 12, headerLen)));
  const bodyStart = (12 + headerLen + 7) & ~7;
  const all = {};
  for (const [name, c] of Object.entries(head.cols || {})) {
    const T = TYPES[c.type];
    if (T) all[name] = new T(buf, base + bodyStart + c.off, c.len);
  }
  // each layer's header maps its own column names onto the flat body
  const layers = (head.layers || []).map((L) => {
    const cols = {};
    for (const [name, key] of Object.entries(L.cols || {})) if (all[key]) cols[name] = all[key];
    return { ...L, cols };
  });
  return { frame: head.frame, layers };
}

// which engine colour mode a `color` choice means, per element kind. The engine
// numbers differ by pipeline (points: 1 = intensity, blocks/sticks: 1 = grade),
// so the widget speaks names and translates here.
function modeOf(color, kind, cols) {
  if (color === 'value' && (cols.value || cols.value_u16)) return 1;
  if (color === 'category' && cols.cat) return 2;
  if (color === 'rgb' && cols.rgb && kind === 'points') return 3;
  if (color === 'flat') return kind === 'points' ? 0 : 3;  // blocks/sticks: 3 = solid
  return 0;                                                // 'z' (elevation)
}

// the section trait → the engine's frame-local plane. `position` is a WORLD
// coordinate along the normal (that is what a geologist types), so the frame
// origin comes off it here.
function sectionOf(sec, origin) {
  if (!sec) return null;
  let n = sec.normal;
  if (!n) {
    const ax = sec.axis;
    if (!ax) return null;
    n = ax === 'x' ? [1, 0, 0] : ax === 'y' ? [0, 1, 0] : [0, 0, 1];
  }
  const L = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / L, n[1] / L, n[2] / L];
  const d = (+sec.position || 0) - (n[0] * origin[0] + n[1] * origin[1] + n[2] * origin[2]);
  const half = Math.max(0.01, (+sec.thickness || 10) / 2);
  return { on: true, n, d, half, d0: d, clip: 'slab', traceHalf: half };
}

// ── drillholes: three tables → desurveyed capsule segments ──
// The interval FROM and TO depths are located as two point-samples on the
// desurveyed trace (arc-correct via positionAt), then paired back into a
// segment keyed by source row — the same construction condenser's own file
// provider uses, so notebook and micro place a hole identically.
function drillholeSegments(head, cols) {
  const nC = cols.c_bhid.length, nS = cols.s_bhid.length, n = cols.i_bhid.length;
  const collars = new Array(nC);
  for (let i = 0; i < nC; i++) {
    collars[i] = { bhid: String(cols.c_bhid[i]), x: cols.c_x[i], y: cols.c_y[i], z: cols.c_z[i] };
    if (cols.c_eoh) collars[i].eoh = cols.c_eoh[i];
  }
  const surveys = new Array(nS);
  for (let i = 0; i < nS; i++) surveys[i] = { bhid: String(cols.s_bhid[i]), depth: cols.s_depth[i], az: cols.s_az[i], dip: cols.s_dip[i] };

  const bhid = new Array(2 * n), depth = new Float64Array(2 * n);
  const rowIdx = new Float64Array(2 * n), endIdx = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const hb = String(cols.i_bhid[i]);
    bhid[2 * i] = hb; bhid[2 * i + 1] = hb;
    depth[2 * i] = cols.i_from[i]; depth[2 * i + 1] = cols.i_to[i];
    rowIdx[2 * i] = i; rowIdx[2 * i + 1] = i;
    endIdx[2 * i] = 0; endIdx[2 * i + 1] = 1;
  }
  const ds = dhDesurveySamples(
    { collars, surveys, samples: { bhid, depth, cols: [{ name: '__row', values: rowIdx }, { name: '__end', values: endIdx }] } },
    { method: head.method || 'minimumCurvature', dipConvention: head.dip_convention || 'auto' },
  );

  const endA = new Map(), endB = new Map();                // src row → [x,y,z]
  for (const row of ds.rows) (row[6] | 0) === 0 ? endA.set(row[5] | 0, [row[1], row[2], row[3]]) : endB.set(row[5] | 0, [row[1], row[2], row[3]]);
  const placed = [];
  for (const src of endA.keys()) if (endB.has(src)) placed.push(src);
  placed.sort((a, b) => a - b);
  const k = placed.length;
  const out = {
    count: k,
    ax: new Float64Array(k), ay: new Float64Array(k), az: new Float64Array(k),
    bx: new Float64Array(k), by: new Float64Array(k), bz: new Float64Array(k),
    x: new Float64Array(k), y: new Float64Array(k), z: new Float64Array(k),
    chan: new Float64Array(k), cat: cols.cat ? new Uint8Array(k) : null,
    recIdx: new Uint32Array(k),
  };
  for (let i = 0; i < k; i++) {
    const s = placed[i], A = endA.get(s), B = endB.get(s);
    out.ax[i] = A[0]; out.ay[i] = A[1]; out.az[i] = A[2];
    out.bx[i] = B[0]; out.by[i] = B[1]; out.bz[i] = B[2];
    out.x[i] = (A[0] + B[0]) / 2; out.y[i] = (A[1] + B[1]) / 2; out.z[i] = (A[2] + B[2]) / 2;
    out.chan[i] = cols.value && Number.isFinite(cols.value[s]) ? cols.value[s] : 0;
    if (out.cat) out.cat[i] = cols.cat[s];
    out.recIdx[i] = s;                                     // the INTERVAL row — the pick's join key
  }
  return out;
}

// anywidget wants a DEFAULT export; @gcu/build emits named exports only (its
// rename-on-collision pass needs names). So this is named, and build.js appends
// the one-line `export default { render }` footer to the bundle.
function render({ model, el }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;width:100%;background:#121212;border-radius:3px;overflow:hidden;';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  host.appendChild(canvas);
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:6px;bottom:5px;font:11px ui-monospace,Menlo,Consolas,monospace;color:#8b8b8b;pointer-events:none;text-shadow:0 1px 2px #000;';
  host.appendChild(hud);
  el.appendChild(host);

  let renderer = null, edl = null, cam = null, detach = null, raf = 0, ro = null;
  let payload = null, disposed = false, needFit = false, converged = false;
  let docBbox = null;
  const kinds = [];                                        // layer index → element kind

  try {
    renderer = createRenderer(canvas, { background: [0.07, 0.07, 0.07, 1] });
    edl = createEdl(renderer.gl);
    cam = createOrbitCamera();
  } catch (e) {                                            // no WebGL2 (headless CI, locked-down VM)
    host.style.height = '80px';
    hud.style.cssText += 'position:static;padding:10px;color:#d07a5c;';
    hud.textContent = `condenser: ${e.message}`;
    return () => { el.innerHTML = ''; };
  }

  const styles = () => model.get('_styles') || [];
  const styleAt = (i) => styles()[i] || {};

  const draw = () => {
    raf = 0;
    if (disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; renderer.invalidate(); }
    cam.setAspect(w / h);
    if (needFit && docBbox) { cam.fit(docBbox); needFit = false; }

    const st = styles();
    // per-layer colour mode + clip; the engine takes point size / points-view
    // as VIEW-wide, so those fold across the visible layers
    const layerOpts = {};
    let pointPx = 2.5, asPoints = false;
    st.forEach((s, i) => {
      const cols = payload && payload.layers[i] ? payload.layers[i].cols : {};
      layerOpts[i] = {
        colorMode: modeOf(s.color, kinds[i], cols),
        clip: s.clip && s.clip.length === 2 ? s.clip : null,
      };
      if (s.visible !== false) {
        pointPx = Math.max(pointPx, s.point_size || 0);
        asPoints = asPoints || !!s.as_points;
      }
    });
    const opts = {
      budget: model.get('budget') || 3_000_000,
      pointPx, blocksAsPoints: asPoints, blockEdges: false,   // edges are a per-layer override
      section: sectionOf(model.get('section'), (payload && payload.frame) || [0, 0, 0]),
      clip: null, layerOpts,
    };
    const r = edl.render(w, h, cam, () => renderer.draw(cam, opts),
      { enabled: model.get('edl') !== false, strength: model.get('edl_strength') != null ? model.get('edl_strength') : 1.0 });
    converged = r.converged;
    if (payload) {
      const tot = renderer.elementCount, acc = renderer.accumulated;
      const n = payload.layers.length;
      const what = n === 1 ? (kinds[0] === 'blocks' ? 'blocks' : kinds[0] === 'drillholes' ? 'intervals' : 'points')
        : `elements · ${n} layers`;
      hud.textContent = converged ? `${tot.toLocaleString()} ${what}` : `${tot.toLocaleString()} · ${Math.round((100 * acc) / (tot || 1))}%`;
    }
    if (!converged) schedule();
  };
  const schedule = () => { if (!raf && !disposed) raf = requestAnimationFrame(draw); };
  const invalidate = () => { renderer.invalidate(); schedule(); };

  // ── load: payload → chunk builders → GPU, one engine layer per data layer ──
  const load = () => {
    renderer.clearChunks();
    payload = null; docBbox = null; kinds.length = 0;
    const p = decodePayload(model.get('_payload'));
    if (!p || !p.layers.length) { hud.textContent = 'no data'; schedule(); return; }
    payload = p;
    const frame = { origin: p.frame, crs: null, units: 'm' };
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

    p.layers.forEach((L, i) => {
      const cols = L.cols;
      kinds[i] = L.kind;
      let doc = null;
      if (L.kind === 'blocks') {
        const grid = makeBlockGrid(L.axes.map(([origin, pitch, count]) => ({ origin, pitch, count })), frame);
        const b = createBlockChunkBuilder({
          frame, grid, chunkSize: 1 << 18, seed: 1,
          dimPalette: L.dim_palette || null,               // sub-blocked: per-code half-dims
          onChunk: (c) => renderer.addChunk(c, 'base', i),
        });
        b.push({ count: L.count, x: cols.x, y: cols.y, z: cols.z, chan: cols.value || null, cat: cols.cat || null, dim: cols.dim || null, recStart: 0 });
        doc = b.flush();
        if (L.cat_n) renderer.setCategories(L.cat_n);
      } else if (L.kind === 'drillholes') {
        const seg = drillholeSegments(L, cols);
        const b = createStickChunkBuilder({ frame, chunkSize: 1 << 16, seed: 1, onChunk: (c) => renderer.addChunk(c, 'base', i) });
        b.push({ count: seg.count, ax: seg.ax, ay: seg.ay, az: seg.az, bx: seg.bx, by: seg.by, bz: seg.bz,
          x: seg.x, y: seg.y, z: seg.z, chan: seg.chan, cat: seg.cat, recIdx: seg.recIdx });
        doc = b.flush();
        if (L.cat_n) renderer.setCategories(L.cat_n);
      } else {
        const b = createChunkBuilder({ frame, chunkSize: 1 << 19, seed: 1, onChunk: (c) => renderer.addChunk(c, 'base', i) });
        b.push({
          count: L.count, x: cols.x, y: cols.y, z: cols.z,
          intensity: cols.value_u16 || new Uint16Array(L.count),
          classification: cols.cat || new Uint8Array(L.count),
          rgb: cols.rgb || null, recStart: 0,
        });
        doc = b.flush();
        if (L.cat_n) renderer.setLayerCats(i, L.cat_n);
      }
      if (doc && doc.bboxLocal) {
        for (let a = 0; a < 3; a++) {
          if (doc.bboxLocal[a] < bb[a]) bb[a] = doc.bboxLocal[a];
          if (doc.bboxLocal[a + 3] > bb[a + 3]) bb[a + 3] = doc.bboxLocal[a + 3];
        }
      }
    });

    docBbox = Float64Array.from(bb);
    renderer.setDocBbox(docBbox);
    applyStyles();
    needFit = true;
    invalidate();
  };

  // ── styles: everything the engine keeps per LAYER ──
  const applyStyles = () => {
    if (!payload) return;
    styles().forEach((s, i) => {
      const L = payload.layers[i];
      if (!L) return;
      renderer.setLayerVisible(i, s.visible !== false);
      renderer.setLayerOpacity(i, s.opacity == null ? 1 : s.opacity);
      renderer.setLayerSectioned(i, s.sectioned === undefined ? true : s.sectioned);
      const stops = RAMPS[s.ramp || 'viridis'];
      renderer.setLayerRamp(i, stops ? rampPixels(256, stops) : null);
      if (L.kind === 'blocks') renderer.setLayerEdges(i, !!s.block_edges);
      if (L.kind === 'drillholes') renderer.setLayerStickRadius(i, s.radius || 1.5);
      // threshold → the isolate/dim mask, built here from the value column that
      // is already resident, so dragging a cutoff never re-sends data
      const v = L.cols.value;
      const t = s.threshold;
      if (v && t && t.length === 2) {
        const mask = new Uint8Array(v.length);
        for (let q = 0; q < v.length; q++) mask[q] = (v[q] >= t[0] && v[q] <= t[1]) ? 1 : 0;
        renderer.setFilter(mask, { isolate: s.filter_mode !== 'dim' }, i);
      } else {
        renderer.setFilter(null, {}, i);
      }
    });
    schedule();
  };

  const applyBackground = () => {
    const hex = String(model.get('background') || '#121212').replace('#', '');
    if (hex.length !== 6) return;
    const v = parseInt(hex, 16);
    renderer.setBackground([((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1]);
    schedule();
  };
  const applyHeight = () => { host.style.height = `${model.get('height') || 460}px`; invalidate(); };

  // ── the click → `selection` round trip: the ID buffer names the LAYER and the
  // RECORD, and a record IS the source row, so Python gets back a table index. ──
  let downAt = null;
  const onDown = (e) => { downAt = [e.clientX, e.clientY]; };
  const onUp = (e) => {
    if (!downAt || !payload) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 4) return;                                 // a drag is navigation, not a pick
    const r = canvas.getBoundingClientRect();
    const st = styles();
    let pointPx = 2.5, asPoints = false;
    st.forEach((s) => { if (s.visible !== false) { pointPx = Math.max(pointPx, s.point_size || 0); asPoints = asPoints || !!s.as_points; } });
    const hit = renderer.pick(e.clientX - r.left, e.clientY - r.top, cam, {
      pointPx, blocksAsPoints: asPoints,
      section: sectionOf(model.get('section'), payload.frame),
    });
    renderer.setPicked(hit || null);
    model.set('selection', hit ? { layer: hit.layer, name: (styleAt(hit.layer).name || ''), row: hit.rec } : {});
    model.save_changes();
    schedule();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  detach = attachOrbitInput(canvas, cam, { onChange: schedule });

  const subs = [
    ['change:_payload', load],
    ['change:_styles', () => { applyStyles(); invalidate(); }],
    ['change:section', invalidate],
    ['change:background', applyBackground],
    ['change:height', applyHeight],
    ['change:edl', invalidate], ['change:edl_strength', invalidate], ['change:budget', invalidate],
    ['change:_fit', () => { needFit = true; invalidate(); }],
  ];
  for (const [ev, fn] of subs) model.on(ev, fn);

  ro = new ResizeObserver(() => invalidate());
  ro.observe(host);
  applyHeight();
  applyBackground();
  load();

  return () => {                                           // anywidget teardown
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (detach) detach();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    for (const [ev, fn] of subs) model.off(ev, fn);
    try { renderer.clearChunks(); } catch { /* context already gone */ }
    const lose = renderer.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();                          // a notebook can build dozens of these
    el.innerHTML = '';
  };
}

export {
  render,
};

export default { render };
