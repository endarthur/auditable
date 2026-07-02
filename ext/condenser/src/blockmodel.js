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
// consumer controls pacing.
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

export async function openBlockModel(blob, { mapping = null, sample = 512 * 1024, signal, onProgress } = {}) {
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

  const header = {
    kind: 'blockmodel', count,
    bbox: { min, max },
    grid,                                                   // null → not a regular grid (points fallback)
    columns: sniff.header, mapping: { ...map, cat: categories ? catCol : null },
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
