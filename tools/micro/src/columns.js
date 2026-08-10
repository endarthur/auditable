// micro columns — the derived-column STORAGE subsystem: materialized (matcol)
// accessors + the one-column-one-Parquet codec, and the budgeted PIN CACHE that
// governs both filter pins and matcol residency. No project-FS access here —
// the app injects the sidecar reader (setSidecarReader); UI reactions to a
// changed column set are injected too (setColumnsChangedHook).
import { parquetInfo, readParquetRange, writeParquet } from '../../../ext/parquet/index.js';
import { layerBlob, attrRowCountOf } from './records.js';

export const PAINT_BLANK = '#33373c';                      // unpainted recedes toward the background

export function paintRecount(col) {
  const counts = new Uint32Array(col.dict.length);
  for (let i = 0; i < col.codes.length; i++) if (col.codes[i] < counts.length) counts[col.codes[i]]++;
  col.counts = counts;
  return counts;
}

// ── materialized numeric columns ──────────────────────────────────────────────
// A materialized column is a PAINT column (kind 'ratio') carrying a full-precision
// `fvalues` Float32 backing (`mat:true`): the `codes` give the 256-level GPU colour
// (visually fine), `fvalues` give full precision for filter/GT/export, and the
// legend reads the real [min,max]. Aligned 1:1 by record index. The fvalues
// persist in a per-layer <layer>.cols/ sidecar (project dir → FSAA/OPFS), else
// IDB (loose), else memory; a manifest sourceHash guards a source reorder.
// Source-agnostic — "materialize a calc column" and other producers write here.
export function matColSourceHash(L) { const b = layerBlob(L); return `${(b && b.size) || 0}:${attrRowCountOf(L) || 0}`; }
export function matColLooseId(L) { const b = layerBlob(L); return `${L.name}:${(b && b.size) || 0}`; }
export function matColList(L) { return ((L && L.paintCols) || []).filter((c) => c.mat); }
// everything the .cols/ sidecar stores: numeric matcols + ALL dict category
// columns (op-produced AND hand-paint — dense string Parquet; the spec's call:
// paint is an ordinary dense category column). Still on project.json RLE:
// '_swath' (volatile zebra) + non-mat ratio brushes (codes ARE the value).
export const isStoredCat = (c) => !c.mat && c.kind !== 'ratio' && c.name !== '_swath';
export function storedCols(L) { return ((L && L.paintCols) || []).filter((c) => c.mat || isStoredCat(c)); }
export function matColGet(L, name) { return matColList(L).find((c) => c.name === name) || null; }
// derive 256-level display codes (1..255) from fvalues over [min,max]; NaN → 0 (blank)
export function matColCodes(fvalues, min, max) {
  const span = (max - min) || 1, codes = new Uint8Array(fvalues.length);
  for (let i = 0; i < fvalues.length; i++) { const v = fvalues[i]; codes[i] = Number.isFinite(v) ? 1 + Math.max(0, Math.min(254, Math.round(254 * (v - min) / span))) : 0; }
  return codes;
}
// golden-angle hues, same family as the category palette — the default color
// for a rule / a restored category without one
export function ruleDefaultColor(i) {
  const h = (i * 137.508) % 360, s = 0.62, v = 0.86;
  const f = (n2) => { const k = (n2 + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  const hx = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + hx(f(5)) + hx(f(3)) + hx(f(1));
}
// the app's UI reaction to a changed column set (color-by options track it)
let _onColumnsChanged = () => {};
export function setColumnsChangedHook(fn) { _onColumnsChanged = fn; }
export const columnsChanged = (L) => _onColumnsChanged(L);   // for sibling modules (element-store)
// attach (or replace) a materialized column: fvalues (truth) + derived paint codes
export function matColSet(L, name, fvalues, meta = {}) {
  let mn = Infinity, mx = -Infinity, nn = 0;
  for (let i = 0; i < fvalues.length; i++) { const v = fvalues[i]; if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; nn++; } }
  if (!nn) { mn = 0; mx = 0; }
  const col = { name, kind: 'ratio', mat: true, fvalues, codes: matColCodes(fvalues, mn, mx), dict: [''], colors: ['#000000'], blankColor: PAINT_BLANK, min: mn, max: mx, count: fvalues.length, nonnull: nn, lineage: meta.lineage || null, source: matColSourceHash(L) };
  paintRecount(col);
  pinPutMatcol(L, col);                                    // governed residency: evictable under the pin budget
  L.paintCols = (L.paintCols || []).filter((c) => c.name !== name); L.paintCols.push(col);
  L._colStats = null; L._calcFns = null;                   // schema changed → invalidate cached scans/fns
  _onColumnsChanged(L);
  return col;
}
// one column ↔ one Parquet file (manifest rule A.1): typed, null-aware (NaN ↔ null),
// SNAPPY, canonical 256K row groups with footer stats — a materialized column reads
// like any base column and gains push-down. Legacy raw .f32 still loads (PAR1 sniff).
export function matColEncode(c) {
  const data = c.mat
    ? Array.from(c.fvalues, (v) => (Number.isFinite(v) ? v : null))
    : Array.from(c.codes, (code) => (code ? (c.dict[code] ?? null) : null));   // category: dict-decoded strings
  return writeParquet({
    columnData: [{ name: c.name, data }],
    codec: 'SNAPPY', rowGroupSize: 1 << 18,
    kvMetadata: [{ key: 'micro:lineage', value: JSON.stringify(c.lineage || null) }],
  });
}
export async function matColDecodeStr(bytes) {
  const u8v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const info = parquetInfo(u8v);
  const name = info.columns[0].name || info.columns[0];
  return (await readParquetRange(u8v, [name], 0, info.rowCount, info.meta))[name];
}
export async function matColDecode(bytes) {
  const u8v = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(u8v[0] === 0x50 && u8v[1] === 0x41 && u8v[2] === 0x52 && u8v[3] === 0x31)) return new Float32Array(u8v.buffer.slice(u8v.byteOffset, u8v.byteOffset + u8v.byteLength));   // legacy raw .f32
  const info = parquetInfo(u8v);
  const name = info.columns[0].name || info.columns[0];
  const a = (await readParquetRange(u8v, [name], 0, info.rowCount, info.meta))[name];
  const out = new Float32Array(info.rowCount);
  for (let i = 0; i < info.rowCount; i++) { const v = a[i]; out[i] = v == null ? NaN : v; }
  return out;
}

// ── the PIN CACHE (filter tier 3: prune → scan → REFINE) ──────────────────────
// After a filter scans a layer once, the columns it touched stay pinned (typed
// arrays / dict codes) inside a GLOBAL, budgeted, LRU pool — the next filter
// change evaluates over pinned columns via compileChunk with NO file read.
// Budget: localStorage 'micro.pinBudget' = 'off' | 'auto' | MB; auto scales with
// navigator.deviceMemory. Exact accounting (we own every array); eviction is
// column-granular LRU; entries carry the layer sourceHash (stale → drop).
const _pinCache = new Map(); let _pinBytes = 0, _pinTick = 0;
export function pinBudgetBytes() {
  let v = 'auto'; try { v = localStorage.getItem('micro.pinBudget') || 'auto'; } catch { /* private mode */ }
  if (v === 'off') return 0;
  if (v === 'auto') { const dm = (navigator.deviceMemory || 4); return Math.min(1024, Math.max(128, dm * 64)) * 1048576; }   // 8 GB → 512 MB
  return Math.max(0, +v || 0) * 1048576;
}
export function setPinBudget(v) { try { localStorage.setItem('micro.pinBudget', String(v)); } catch { /* ignore */ } pinTrim(); }
export function pinStats() { return { bytes: _pinBytes, budget: pinBudgetBytes(), cols: _pinCache.size }; }
export function pinTrim(extra = 0) {
  const cap = pinBudgetBytes();
  if (cap === 0) { _pinCache.clear(); _pinBytes = 0; return; }
  while (_pinBytes + extra > cap && _pinCache.size) {      // LRU: evict the least-recently-used column
    let lk = null, lt = Infinity;
    for (const [k, e] of _pinCache) if (e.t < lt) { lt = e.t; lk = k; }
    const e = _pinCache.get(lk); _pinCache.delete(lk); _pinBytes -= e.bytes;
    if (e.matcol && e.ref) e.ref.fvalues = null;           // governed residency: drop the values, keep codes (display)
  }
}
// ── GOVERNED matcol residency: fvalues register in the SAME budgeted LRU pool
// the filter pins use — resident while the budget allows (sync access intact),
// EVICTABLE under pressure, re-faulted ASYNC from the sidecar Parquet at the
// next scan that needs them (every scan head calls ensureStoredValues first).
// This is spec-step "kill resident fvalues" delivered as governance: bounded
// memory now, and the injected sidecar reader IS the read machinery true
// lazy-chunking would build on. Budget 'off' → nothing registers → always-resident.
export function pinPutMatcol(L, pc) {
  if (!pc.fvalues || pinBudgetBytes() === 0) return;
  const k = L.id + ':#mat:' + String(pc.name).toLowerCase();
  const old = _pinCache.get(k); if (old) _pinBytes -= old.bytes;
  const e = { matcol: true, ref: pc, bytes: pc.fvalues.byteLength, hash: matColSourceHash(L), t: ++_pinTick };
  pinTrim(e.bytes);
  _pinCache.set(k, e); _pinBytes += e.bytes;               // always registered (governance, not admission)
}
export function pinTouchMatcol(L, pc) { const e = _pinCache.get(L.id + ':#mat:' + String(pc.name).toLowerCase()); if (e) e.t = ++_pinTick; }
// the app injects how a stored column's bytes are read back (project sidecar /
// IDB) — this module owns residency, not the filesystem
let _readSidecarCol = async () => null;
export function setSidecarReader(fn) { _readSidecarCol = fn; }
export async function ensureStoredValues(L, needed) {      // needed: lowercased Set, or null = every matcol
  if (!L) return;
  for (const pc of matColList(L)) {
    if (needed && !needed.has(String(pc.name).toLowerCase())) continue;
    if (pc.fvalues) { pinTouchMatcol(L, pc); continue; }
    const buf = await _readSidecarCol(L, pc.name);
    if (!buf) { const el = document.querySelector('#meta'); if (el) el.textContent = `${pc.name}: values not resident and no sidecar — re-run the op`; continue; }
    pc.fvalues = await matColDecode(buf);
    pinPutMatcol(L, pc);
  }
}
export function pinPut(L, name, entry) {
  if (pinBudgetBytes() === 0) return;
  entry.bytes = (entry.data ? entry.data.byteLength : entry.codes.byteLength + entry.dict.join('').length * 2);
  entry.hash = matColSourceHash(L); entry.t = ++_pinTick;
  pinTrim(entry.bytes);
  if (entry.bytes + _pinBytes > pinBudgetBytes()) return;  // single column over budget → don't pin
  const k = L.id + ':' + String(name).toLowerCase();
  const old = _pinCache.get(k); if (old) _pinBytes -= old.bytes;
  _pinCache.set(k, entry); _pinBytes += entry.bytes;
}
export function pinGet(L, name) {
  const e = _pinCache.get(L.id + ':' + String(name).toLowerCase());
  if (!e) return null;
  if (e.hash !== matColSourceHash(L)) { pinEvictLayer(L.id); return null; }   // source changed → stale
  e.t = ++_pinTick; return e;
}
export function pinEvictLayer(id) { for (const [k, e] of [..._pinCache]) if (k.startsWith(id + ':')) { _pinCache.delete(k); _pinBytes -= e.bytes; } }
// a pinned column's values for records [start, start+n) as compileChunk input
export function pinWindow(e, start, n, scratch) {
  if (e.data) return e.data.subarray(start, start + n);    // numeric: zero-copy view
  const a = scratch && scratch.length >= n ? scratch : new Array(n);
  for (let i = 0; i < n; i++) a[i] = e.dict[e.codes[start + i]] ?? '';   // dict: decode a window
  return a;
}
