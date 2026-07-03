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
export function parsePlyHeader(text) {
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

export async function openPly(blob, { signal, onProgress } = {}) {
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
