// @gcu/omf1 — Open Mining Format v1 reader/writer. Zero deps, isomorphic
// (CompressionStream is a global in Node 18+ and browsers). Implements the
// OMF-v0.9.0 wire format per spec_inbox/geology/omf-v1-js-spec.md.
//
// Wire layout (one flat binary):
//   [0..60)   header — magic 0x81828384, "OMF-v0.9.0" (NUL-pad 32), project
//             UUID (16 bytes), uint64-LE byte offset of the JSON index.
//   [60..J)   binary blob — each array/image independently zlib-deflated
//             (RFC 1950 = CompressionStream "deflate"). Numbers normalized to
//             <f8 (float64 LE) or <i8 (int64 LE); images are image/png.
//   [J..EOF)  JSON index — a UTF-8 { uid: object } registry. Objects cross-
//             reference by UUID string; array objects hold { start,length,dtype }
//             pointers into the blob.
//
// v1 = the version with real adoption (Leapfrog/Surpac/Micromine/Deswik/Vulcan).
// NOT covered: OMF v2 (ZIP+Parquet — see @gcu/omf2), sub-blocked models (v2
// only), CRS transforms, deep index validation.

const MAGIC = 0x81828384;            // bytes 84 83 82 81, read as uint32 LE
const VERSION = 'OMF-v0.9.0';

// ── zlib (RFC 1950) via the Compression Streams API ──────────────────────────
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}
async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

// ── UUID (16 raw bytes ↔ 8-4-4-4-12 hex) ─────────────────────────────────────
// Round-trip consistent; the project is located in the registry by class, so
// header-UUID byte order never gates reading (real-file endianness: see README).
const _hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
function formatUUID(bytes) {
  let s = '';
  for (let i = 0; i < 16; i++) s += _hex[bytes[i]];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function parseUUID(str) {
  const h = String(str).replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── class schema — one table drives both resolve (read) and serialize (write) ─
// scalars: copied verbatim. arrays: a UUID → an { start,length,dtype } blob ref
// (→ typed array). refs: a UUID → a nested object. refLists: a [UUID] → objects.
const SCHEMA = {
  Project:            { scalars: ['name', 'description', 'origin', 'date_created', 'date_modified'], refLists: ['elements'] },
  PointSetElement:    { scalars: ['name', 'description', 'color'], refs: ['geometry'], refLists: ['data'] },
  LineSetElement:     { scalars: ['name', 'description', 'color'], refs: ['geometry'], refLists: ['data'] },
  SurfaceElement:     { scalars: ['name', 'description', 'color'], refs: ['geometry'], refLists: ['data', 'textures'] },
  VolumeElement:      { scalars: ['name', 'description', 'color'], refs: ['geometry'], refLists: ['data'] },
  PointSetGeometry:   { arrays: ['vertices'] },
  LineSetGeometry:    { arrays: ['vertices', 'segments'] },
  SurfaceGeometry:    { arrays: ['vertices', 'triangles'] },
  SurfaceGridGeometry:{ scalars: ['origin', 'axis_u', 'axis_v'], arrays: ['tensor_u', 'tensor_v', 'offset_w'] },
  VolumeGridGeometry: { scalars: ['origin', 'axis_u', 'axis_v', 'axis_w'], arrays: ['tensor_u', 'tensor_v', 'tensor_w'] },
  ScalarData:         { scalars: ['name', 'description', 'location'], arrays: ['array'], refs: ['colormap'] },
  Vector3Data:        { scalars: ['name', 'description', 'location'], arrays: ['array'] },
  Vector2Data:        { scalars: ['name', 'description', 'location'], arrays: ['array'] },
  MappedData:         { scalars: ['name', 'description', 'location'], arrays: ['indices'], refLists: ['legends'] },
  ScalarColormap:     { scalars: ['limits'], arrays: ['gradient'] },
  Legend:             { scalars: ['name'], arrays: ['values'] },
  ImageTexture:       { scalars: ['origin', 'axis_u', 'axis_v'], arrays: ['image'] },
};

// ── header ───────────────────────────────────────────────────────────────────
function readHeader(buf) {
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('omf1: not an OMF file (bad magic)');
  const version = new TextDecoder().decode(new Uint8Array(buf, 4, 32)).replace(/\0+$/, '');
  if (!version.startsWith('OMF-v0.9')) throw new Error(`omf1: unsupported version "${version}"`);
  return {
    uid: formatUUID(new Uint8Array(buf, 36, 16)),
    jsonStart: Number(view.getBigUint64(52, true)),
    version,
  };
}

// ── array (de)serialization ──────────────────────────────────────────────────
async function loadArrayFromBlob(ref, blobBytes) {
  const slice = blobBytes.subarray(ref.start, ref.start + ref.length);
  const raw = await inflate(slice);
  // Copy to a fresh, aligned buffer (subarray offsets aren't element-aligned).
  if (ref.dtype === '<f8') return new Float64Array(raw.slice().buffer);
  if (ref.dtype === '<i8') return new BigInt64Array(raw.slice().buffer);
  if (ref.dtype === 'image/png') return new Blob([raw], { type: 'image/png' });
  throw new Error(`omf1: unknown dtype "${ref.dtype}"`);
}

// Normalize a JS array/typed array/Blob → { bytes, dtype } for the blob.
async function normalizeArray(val) {
  if (val instanceof Blob) return { bytes: new Uint8Array(await val.arrayBuffer()), dtype: 'image/png' };
  if (val instanceof Float64Array) return { bytes: new Uint8Array(val.buffer, val.byteOffset, val.byteLength), dtype: '<f8' };
  if (val instanceof BigInt64Array) return { bytes: new Uint8Array(val.buffer, val.byteOffset, val.byteLength), dtype: '<i8' };
  if (val instanceof Float32Array) return { bytes: new Uint8Array(Float64Array.from(val).buffer), dtype: '<f8' };
  if (val instanceof Int32Array || val instanceof Int16Array || val instanceof Int8Array
      || val instanceof Uint32Array || val instanceof Uint16Array || val instanceof Uint8Array) {
    return { bytes: new Uint8Array(BigInt64Array.from(val, (x) => BigInt(x)).buffer), dtype: '<i8' };
  }
  if (Array.isArray(val)) {
    const allInt = val.every((x) => Number.isInteger(x));
    return allInt
      ? { bytes: new Uint8Array(BigInt64Array.from(val, (x) => BigInt(x)).buffer), dtype: '<i8' }
      : { bytes: new Uint8Array(Float64Array.from(val).buffer), dtype: '<f8' };
  }
  throw new Error('omf1: unsupported array type for serialization');
}

// ── read ─────────────────────────────────────────────────────────────────────
async function _toBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  if (source && typeof source.arrayBuffer === 'function') return new Uint8Array(await source.arrayBuffer());
  throw new Error('omf1: source must be a Blob, ArrayBuffer, or Uint8Array');
}

function _parseIndex(bytes) {
  const header = readHeader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const registry = JSON.parse(new TextDecoder().decode(bytes.subarray(header.jsonStart)));
  return { header, registry };
}

// Build the object tree (sync). Array fields become { __arrayRef, start, length,
// dtype } stubs; openOMF leaves them, readOMF replaces them with typed arrays.
function _resolve(uid, registry, cache) {
  if (cache.has(uid)) return cache.get(uid);
  const raw = registry[uid];
  if (!raw) throw new Error(`omf1: missing UID ${uid}`);
  const cls = raw.__class__ || raw.type;
  const schema = SCHEMA[cls];
  const obj = { type: cls, uid };
  cache.set(uid, obj);
  if (!schema) { Object.assign(obj, raw); delete obj.__class__; return obj; }
  for (const f of schema.scalars || []) if (raw[f] !== undefined) obj[f] = raw[f];
  for (const f of schema.arrays || []) {
    if (raw[f] == null) { obj[f] = null; continue; }
    const a = registry[raw[f]];
    obj[f] = a ? { __arrayRef: true, start: a.start, length: a.length, dtype: a.dtype } : null;
  }
  for (const f of schema.refs || []) obj[f] = raw[f] != null ? _resolve(raw[f], registry, cache) : null;
  for (const f of schema.refLists || []) obj[f] = Array.isArray(raw[f]) ? raw[f].map((u) => _resolve(u, registry, cache)) : [];
  return obj;
}

function _findProjectUid(registry) {
  for (const [uid, o] of Object.entries(registry)) if ((o.__class__ || o.type) === 'Project') return uid;
  throw new Error('omf1: no Project object in the index');
}

const isArrayRef = (v) => v && typeof v === 'object' && v.__arrayRef === true;

// Walk the tree and replace every { __arrayRef } stub with its loaded array.
async function _loadAll(node, blobBytes, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const [k, v] of Object.entries(node)) {
    if (isArrayRef(v)) node[k] = await loadArrayFromBlob(v, blobBytes);
    else if (Array.isArray(v)) for (const item of v) await _loadAll(item, blobBytes, seen);
    else if (v && typeof v === 'object') await _loadAll(v, blobBytes, seen);
  }
}

export async function openOMF(source) {
  const bytes = await _toBytes(source);
  const { header, registry } = _parseIndex(bytes);
  const project = _resolve(_findProjectUid(registry), registry, new Map());
  project.uid = project.uid || header.uid;
  return {
    project,
    loadArray: (ref) => loadArrayFromBlob(ref, bytes),
    loadImage: (ref) => loadArrayFromBlob(ref, bytes),
    close() { /* nothing to release — bytes are GC'd with the reader */ },
  };
}

export async function readOMF(source) {
  const bytes = await _toBytes(source);
  const { header, registry } = _parseIndex(bytes);
  const project = _resolve(_findProjectUid(registry), registry, new Map());
  project.uid = project.uid || header.uid;
  await _loadAll(project, bytes);
  return project;
}

// ── write ──────────────────────────────────────────────────────────────────
export async function writeOMF(project) {
  const registry = {};
  const pending = [];   // { uid, val } array fields, deflated in a second pass

  const newUid = () => (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : formatUUID(Uint8Array.from({ length: 16 }, (_, i) => (i * 73 + pending.length * 17) & 255)));

  function serArray(val) {
    const uid = newUid();
    pending.push({ uid, val });
    return uid;
  }
  function ser(obj) {
    const cls = obj.type || obj.__class__;
    const schema = SCHEMA[cls];
    if (!schema) throw new Error(`omf1: cannot serialize unknown class "${cls}"`);
    const uid = obj.uid || newUid();
    const out = { __class__: cls, uid };
    for (const f of schema.scalars || []) if (obj[f] !== undefined) out[f] = obj[f];
    for (const f of schema.arrays || []) out[f] = obj[f] != null ? serArray(obj[f]) : null;
    for (const f of schema.refs || []) out[f] = obj[f] != null ? ser(obj[f]) : null;
    for (const f of schema.refLists || []) out[f] = Array.isArray(obj[f]) ? obj[f].map(ser) : [];
    registry[uid] = out;
    return uid;
  }

  const projUid = ser({ ...project, type: 'Project' });

  // Deflate every array, lay them end-to-end in the blob (starts at byte 60),
  // and fill in each array object's { start,length,dtype }.
  const chunks = [];
  let offset = 60;
  for (const { uid, val } of pending) {
    const { bytes, dtype } = await normalizeArray(val);
    const comp = await deflate(bytes);
    registry[uid] = { __class__: dtype === 'image/png' ? 'PngImage' : 'ScalarArray', start: offset, length: comp.length, dtype };
    chunks.push(comp);
    offset += comp.length;
  }
  const blobLen = offset - 60;

  const json = new TextEncoder().encode(JSON.stringify(registry));
  const total = 60 + blobLen + json.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  out.set(new TextEncoder().encode(VERSION), 4);                 // NUL-padded by zero-init
  out.set(parseUUID(registry[projUid].uid), 36);
  view.setBigUint64(52, BigInt(60 + blobLen), true);
  let p = 60;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  out.set(json, 60 + blobLen);
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const _len = (t) => (t == null ? 0 : (t.length || 0));

// Grid block counts [nu, nv, nw] from a VolumeGridGeometry (cell count per axis
// = number of tensor widths).
export function blockModelGrid(geometry) {
  return [_len(geometry.tensor_u), _len(geometry.tensor_v), _len(geometry.tensor_w)];
}

// Explicit block centroids (N×3 flat Float64Array), W-fastest then V then U —
// matching OMF cell order. Axes scaled by cumulative tensor widths from origin.
export function blockModelCentroids(geometry) {
  const tu = geometry.tensor_u, tv = geometry.tensor_v, tw = geometry.tensor_w;
  const [o, au, av, aw] = [geometry.origin, geometry.axis_u, geometry.axis_v, geometry.axis_w];
  const nu = _len(tu), nv = _len(tv), nw = _len(tw);
  const mid = (t) => { const m = new Float64Array(t.length); let acc = 0; for (let i = 0; i < t.length; i++) { m[i] = acc + Number(t[i]) / 2; acc += Number(t[i]); } return m; };
  const cu = mid(tu), cv = mid(tv), cw = mid(tw);
  const out = new Float64Array(nu * nv * nw * 3);
  let k = 0;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) for (let l = 0; l < nw; l++) {
    out[k++] = o[0] + au[0] * cu[i] + av[0] * cv[j] + aw[0] * cw[l];
    out[k++] = o[1] + au[1] * cu[i] + av[1] * cv[j] + aw[1] * cw[l];
    out[k++] = o[2] + au[2] * cu[i] + av[2] * cv[j] + aw[2] * cw[l];
  }
  return out;
}

export { formatUUID, parseUUID, readHeader, blockModelGrid as omfGrid };
