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

import { inferAxis } from './blocks.js';

const X_RE = /^(x|xc|xcent(er|re)?|xmid|east(ing)?|xworld|centroid_?x)$/i;
const Y_RE = /^(y|yc|ycent(er|re)?|ymid|north(ing)?|yworld|centroid_?y)$/i;
const Z_RE = /^(z|zc|zcent(er|re)?|zmid|elev(ation)?|rl|level|zworld|centroid_?z)$/i;
const DIM_RE = /^(d[xyz]|[xyz]inc|[xyz]size|[xyz]dim|dim_?[xyz])$/i;
const DIMX_RE = /^(dx|xinc|xsize|xdim|dim_?x)$/i;
const DIMY_RE = /^(dy|yinc|ysize|ydim|dim_?y)$/i;
const DIMZ_RE = /^(dz|zinc|zsize|zdim|dim_?z)$/i;
const NONGRADE_RE = /^(ijk|id|index|row|i|j|k|dens|density|sg|topo|pct|proportion)$/i;

const WS = 'ws';                                           // whitespace-delimiter sentinel ('\s' in a string is just 's')
const splitter = (delim) => (delim === WS ? (l) => l.trim().split(/\s+/) : (l) => l.split(delim));

// Detect delimiter + header from the first text block.
export function sniffDelimited(text) {
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
export function mapColumns(header) {
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
export async function* lineFields(blob, delim, hasHeader, { signal, onProgress } = {}) {
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
export async function fetchDelimitedRecord(blob, header, rec) {
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
function makeDelimitedStream(blob, delim, hasHeaderRow, map, catCol, catCode, dimInfo = null) {
  const r10 = (v) => Number(v.toPrecision(10));
  return async function* streamChunks({ chunkPoints = 1 << 18, signal: s2, onProgress: op2 } = {}) {
    const alloc = () => ({ x: new Float64Array(chunkPoints), y: new Float64Array(chunkPoints), z: new Float64Array(chunkPoints), chan: new Float64Array(chunkPoints), cat: catCode ? new Uint8Array(chunkPoints) : null, dim: dimInfo ? new Uint8Array(chunkPoints) : null });
    let buf = alloc(), fill = 0, recStart = 0;
    for await (const batch of lineFields(blob, delim, hasHeaderRow, { signal: s2, onProgress: op2 })) {
      for (const f of batch) {
        const xv = +f[map.x], yv = +f[map.y], zv = +f[map.z];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(zv)) continue;
        buf.x[fill] = xv; buf.y[fill] = yv; buf.z[fill] = zv;
        buf.chan[fill] = map.chan != null ? +f[map.chan] : 0;
        if (buf.cat) { const c = catCode.get((f[catCol] || '').trim()); buf.cat[fill] = c === undefined ? 0 : c; }
        if (buf.dim) { const key = `${r10(+f[dimInfo.cols.x])},${r10(+f[dimInfo.cols.y])},${r10(+f[dimInfo.cols.z])}`; const c = dimInfo.code.get(key); buf.dim[fill] = c === undefined ? 0 : c; }
        fill++;
        if (fill === chunkPoints) {
          yield { count: fill, x: buf.x, y: buf.y, z: buf.z, chan: buf.chan, cat: buf.cat, dim: buf.dim, recStart };
          recStart += fill; buf = alloc(); fill = 0;
        }
      }
    }
    if (fill) yield { count: fill, x: buf.x.subarray(0, fill), y: buf.y.subarray(0, fill), z: buf.z.subarray(0, fill), chan: buf.chan.subarray(0, fill), cat: buf.cat ? buf.cat.subarray(0, fill) : null, dim: buf.dim ? buf.dim.subarray(0, fill) : null, recStart };
  };
}

export async function openBlockModel(blob, { mapping = null, discovered = null, sample = 512 * 1024, indexEvery = 1024, signal, onProgress } = {}) {
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
    // sub-blocked: rebuild the size-code map from the persisted half-dim palette (×2)
    const r10b = (v) => Number(v.toPrecision(10));
    const dimInfo2 = header.subBlocked && header.dimCols && header.dimPalette
      ? { cols: header.dimCols, code: new Map(header.dimPalette.map((hd, i) => [`${r10b(hd[0] * 2)},${r10b(hd[1] * 2)},${r10b(hd[2] * 2)}`, i])) }
      : null;
    return { header, streamChunks: makeDelimitedStream(blob, header.delim, header.hasHeaderRow, map2, map2.cat, catCode2, dimInfo2) };
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

  // per-block dimension columns (DX/DY/DZ, XINC…) → the model may be SUB-BLOCKED
  // (variable box size). Discovery tracks the fine pitch (min dim/axis) + the
  // distinct (dx,dy,dz) triples that become the size-code palette.
  const dimCols = sniff.header ? { x: sniff.header.findIndex((h) => DIMX_RE.test(h.trim())), y: sniff.header.findIndex((h) => DIMY_RE.test(h.trim())), z: sniff.header.findIndex((h) => DIMZ_RE.test(h.trim())) } : { x: -1, y: -1, z: -1 };
  const hasDims = dimCols.x >= 0 && dimCols.y >= 0 && dimCols.z >= 0;
  const minDim = [Infinity, Infinity, Infinity];
  const dimSet = new Set();

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
      if (hasDims) {
        const dx = +f[dimCols.x], dy = +f[dimCols.y], dz = +f[dimCols.z];
        if (dx > 0 && dy > 0 && dz > 0) {
          if (dx < minDim[0]) minDim[0] = dx; if (dy < minDim[1]) minDim[1] = dy; if (dz < minDim[2]) minDim[2] = dz;
          if (dimSet.size <= 300) dimSet.add(`${round10(dx)},${round10(dy)},${round10(dz)}`);
        }
      }
    }
  }

  const axes = ax.map((s) => (s.size < CAP_DISTINCT ? inferAxis([...s].sort((a, b) => a - b)) : null));
  let grid = axes.every(Boolean) ? { x: axes[0], y: axes[1], z: axes[2] } : null;

  // ── sub-blocked detection ── dims vary → fine-lattice IJK (pitch = min dim /2,
  // so every power-of-2 sub-block centroid lands on it) + a size-code palette.
  // Off the fine lattice (non-power-of-2 splits) → leave it null → points fallback.
  let subBlocked = false, dimPalette = null, dimInfo = null;
  if (hasDims && dimSet.size > 1 && Number.isFinite(minDim[0])) {
    const finePitch = [minDim[0] / 2, minDim[1] / 2, minDim[2] / 2];
    const fineAxes = [0, 1, 2].map((a) => {
      if (ax[a].size >= CAP_DISTINCT || !(finePitch[a] > 0)) return null;
      const vals = [...ax[a]].sort((u, v) => u - v);
      const origin = vals[0], pitch = finePitch[a];
      const cnt = Math.round((vals[vals.length - 1] - origin) / pitch) + 1;
      if (cnt > 65535) return null;
      const eps = Math.max(pitch * 1e-3, Math.abs(origin) * 1e-6);
      for (const v of vals) if (Math.abs(origin + Math.round((v - origin) / pitch) * pitch - v) > eps) return null;
      return { origin, pitch, count: cnt };
    });
    if (fineAxes.every(Boolean)) {
      subBlocked = true;
      const dims = [...dimSet].slice(0, 256).map((k) => k.split(',').map(Number));
      dimPalette = dims.map(([dx, dy, dz]) => [dx / 2, dy / 2, dz / 2]);       // half-dims (box radius)
      dimInfo = { cols: dimCols, code: new Map(dims.map((d, i) => [`${round10(d[0])},${round10(d[1])},${round10(d[2])}`, i])) };
      grid = { x: fineAxes[0], y: fineAxes[1], z: fineAxes[2] };                // fine lattice → IJK
    }
  }
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
    subBlocked, dimPalette, dimCols: subBlocked ? dimCols : null,   // variable-size boxes: half-dim palette + size-code per block
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
  const streamChunks = makeDelimitedStream(blob, sniff.delim, hasHeaderRow, map, catCol, catCode, dimInfo);

  return { header, streamChunks };
}
