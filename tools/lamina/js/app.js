// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, buildFileSource, buildStreamSource, buildSourceFromIndex, indexOf, fileKey, createRecordViewSource, scanFilter, createResultView, scanSortKeys, scanColumnStats, scanAllColumnStats, scanGroupBy, scanGradeTonnage, scanDataQuality, parseNum, createLaminaProvider, LOADING, withCalcCursor, withCalcView } from '@gcu/lamina';
import { compile, compileBool, validate, deps, complete, tokenize } from '@gcu/expr';   // SQL-WHERE-flavored filter + calc language; complete() drives autocomplete, tokenize() the highlight overlay
import { gradeTonnage } from '@gcu/sluice';   // streaming accumulators — the grade-tonnage cutoff curve (one accumulator per grade field, driven from lamina's record cursor)
import { convert as unitConvert } from '@gcu/units';   // grade/density unit declarations — the block-model report
import { geometryAccumulator, inferGeometry } from '@gcu/recon';   // grid-geometry inference (harvested from BMA) — the grid summary
import { ProcessManager } from '@gcu/proc';
import { detectFormat, listZip, readZip, gunzipBytes, listTar, readTar, unzstdBytes, unbz2Bytes } from '@gcu/archive';
import { detectDM, parseHeader, recordRange, decodeRecord, readField } from '@gcu/dm';
import { Unzip, UnzipInflate } from 'fflate';
import { idbCache } from './idb-cache.js';

// Below this COMPRESSED size we decompress the archive whole (resident — best UX:
// true random access + cacheable index). Above it we WINDOW the entry through the
// rewindable tape (buildStreamSource): no RAM/disk blowup, forward-cheap, far-seek
// rewinds. (spec §7a — the third backing between resident and materialized-OPFS.)
const RESIDENT_LIMIT = 32 * 1024 * 1024;
// Bumped whenever detection logic changes — a stale cached `detect` (e.g. from
// before comment-preamble skipping) must NOT be reused. idbCache entries carry
// this; a mismatch is treated as a miss (re-detect + re-scan).
const CACHE_VERSION = 2;
const cacheFresh = (c) => c && c.v === CACHE_VERSION;
const residentLimit = () => (typeof window.__LAMINA_RESIDENT_LIMIT__ === 'number' ? window.__LAMINA_RESIDENT_LIMIT__ : RESIDENT_LIMIT);

// Build stamp — replaced at build time (build.js lamina target) with
// "<version> · <content-hash> · <date>"; stays 'dev' in the unbuilt harness. The
// hash is a content hash of the bundle (a git SHA can't go here — a commit can't
// contain its own hash), so it changes exactly when the code does. Shown in the
// footer (far right) + the About panel so we know which lamina is loaded without
// bumping the version every time.
const __LAMINA_BUILD__ = 'dev';

const $ = (s) => document.querySelector(s);
let grid = null;

// ── theme (light / dark / auto) — no settings dialog; a View menu toggle. The
// chrome reads CSS vars (--bg etc., flipped by :root[data-theme]); the grid uses
// loom's own light/dark palette (createGrid theme). Persisted in localStorage. ──
let theme = (() => { try { return localStorage.getItem('lamina.theme') || 'auto'; } catch { return 'auto'; } })();
const effectiveTheme = () => (theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme);
function applyTheme() {
  const eff = effectiveTheme();
  document.documentElement.dataset.theme = eff;
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.content = (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || (eff === 'light' ? '#f4f4f3' : '#121212'));
  rerender();                                          // re-create the grid with loom's matching palette
}
function setTheme(t) { theme = t; try { localStorage.setItem('lamina.theme', t); } catch { /* ignore */ } applyTheme(); }
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (theme === 'auto') applyTheme(); });
let lastScan = null;            // 'worker'|'inline'|'cache'|'resident'|'stream' — last index-scan path (automation hook)
let current = null;             // { source, d, dataStart, baseVs, label, totalBytes } — the open file (for filtering)

// ── off-thread index scan (a @gcu/proc module-call imports the lamina bundle and
// runs scanFileToIndex over File.stream(); the File crosses by reference, the
// ~1 MB index comes back). Keeps the tab responsive on tens-of-GB. On file://
// cross-blob workers are blocked, so we skip it; any worker failure falls back to
// the inline scan in openFile. ──
// Worker module URL for the off-thread scan. In the single-file build the boot
// sets __LAMINA_BUNDLE_URL__ to the inlined @gcu/lamina blob URL (importable from
// the worker, same-origin); in the dev harness it resolves the served bundle
// against the document (the import map's anchor — app.js is one dir deeper).
const LAMINA_URL = (typeof window.__LAMINA_BUNDLE_URL__ === 'string')
  ? window.__LAMINA_BUNDLE_URL__
  : new URL('../../ext/lamina/index.js', document.baseURI).href;
const canWorker = location.protocol !== 'file:' && typeof Worker !== 'undefined';
let _pm = null;
const pm = () => (_pm ||= new ProcessManager());

async function workerScan(file, scanOpts) {
  const proc = await pm().spawn({ module: LAMINA_URL, fn: 'scanFileToIndex', args: [file, scanOpts] });
  const code = await proc.wait();
  if (code !== 0) { if (proc.error) throw proc.error; throw new Error('scan worker exit ' + code); }
  return proc.result;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// The non-grid panel: binary handoff, archive guards, empty-archive notes.
function showNote(name, badge, title, msg, meta) {
  if (grid) { grid.destroy(); grid = null; }
  current = null; $('#filter').value = ''; syncFilterClear();   // nothing filterable on a note panel
  $('#fileName').textContent = name;
  $('#empty').style.display = 'none';
  $('#grid').innerHTML = '';
  $('#binary').style.display = 'flex';
  $('#binary').querySelector('b').textContent = title;
  $('#binaryMsg').textContent = msg;
  const b = $('#kindBadge'); b.style.display = ''; b.textContent = badge;
  $('#meta').textContent = meta;
}
function showBinary(name, totalBytes) {
  showNote(name, 'binary', 'binary file', 'use the hex viewer for this one', `${fmtBytes(totalBytes)} · binary`);
}

// Mount a built source (memory / streaming / tape) read-only. Builds the base
// view, stores `current` (the open file — filter + sort act on it), then renders.
function mount(name, d, src, totalBytes) {
  const kind = d.kind;                                  // 'delimited' | 'text'
  const schema = kind === 'delimited' ? d.schema : [{ name: 'line', type: 'string' }];
  const dataStart = d.dataStart != null ? d.dataStart : (kind === 'delimited' && d.hasHeader ? 1 : 0);
  const baseVs = createRecordViewSource(src, { schema, dataStart });
  current = { source: src, d, schema, dataStart, baseVs, label: name, totalBytes, filterResult: null, sort: null, hidden: new Set(), colWidths: {}, colFormats: {}, _vis: null, file: null, bytes: null, force: {} };
  _recPinned = null; _recRow = 0;                        // fresh file → drop any pinned compare record
  $('#filter').value = ''; $('#filter').classList.remove('err'); syncFilterClear();   // fresh file → clear filter + sort
  initCalcState();
  recompute();
  refreshGutter();
  if (_pendingLens || _pendingLensView) Promise.resolve().then(applyPendingLens);   // after openFile sets current.file
}

// Derive the active view from base + filter + sort and render it. Filter and sort
// compose: sort runs over the current filter's matches (so "filter then sort" is
// the path for files too big to sort whole).
async function recompute() {
  const c = current;
  if (!c) return;
  let view = c.baseVs;
  let info = {};
  const fr = c.filterResult;                            // { offsets, lengths, nums } or null
  if (c.sort && c.sort.length) {                         // c.sort is an array of { col, dir } keys (multi-column)
    const ac = newFooterScan();
    $('#meta').textContent = 'sorting…';
    try {
      const keys = c.sort.map((s) => ({ col: s.col, dir: s.dir, numeric: (c.schema[s.col] && c.schema[s.col].type) === 'number' }));
      const order = await scanSortKeys(c.source, {
        keys, dataStart: c.dataStart, decimal: c.d.decimal, rows: fr ? fr.nums : null, signal: ac.signal,
        onProgress: (b, n) => { $('#meta').textContent = `sorting… ${n ? Math.round((100 * b) / n) : 0}% · Esc to cancel`; },
      });
      view = createResultView(c.source, order, c.schema);
      info = { filtered: !!fr, sorted: true };
    } catch (e) {
      c.sort = null; view = fr ? createResultView(c.source, fr, c.schema) : c.baseVs; info = { filtered: !!fr };
      if (!(e && e.name === 'AbortError')) $('#meta').textContent = `sort: ${e.message}`;   // abort → fall back to unsorted silently
    } finally { if (_footerScanAbort === ac) _footerScanAbort = null; }
  } else if (fr) {
    view = createResultView(c.source, fr, c.schema);
    info = { filtered: true };
  }
  mountView(view, info);
}

// Estimate resident memory for the never-resident headline: the coarse block index
// (the structure that scales with the file) + a bound on the cached windows (the LRU).
// null when the whole file is in RAM (memory source) or the backing has no block index
// (.dm) — i.e. only the genuinely-windowed case, where resident << file, gets the badge.
function residentEstimate(c) {
  const s = c && c.source;
  if (!s || c.bytes) return null;                        // memory source = whole file resident; no magic to show
  const blocks = s.blockOffsets && s.blockOffsets.length;
  if (!blocks) return null;                              // .dm / unknown backing
  const idx = blocks * 8;                                // Float64 byte-offset per block
  const avgRow = c.totalBytes / Math.max(1, s.rowCount || 1);
  const windows = Math.min(16, blocks) * (s.blockSize || 4096) * avgRow;   // LRU cap × block records × avg row bytes
  return idx + windows;
}

// (Re)create the grid for a view + wire header sort/context + column hide/show +
// update the footer. The provider is wrapped to (a) remap display columns past
// hidden ones and (b) stamp the sort arrow onto the active column.
function mountView(vs, info = {}, keepVScroll = false) {
  captureWidths();                                       // persist the outgoing grid's column widths
  const prevScroll = grid ? grid.getScroll() : null;     // keep horizontal scroll across the rebuild (filter/sort/hide)
  if (grid) { grid.destroy(); grid = null; }
  const c = current;
  c.view = vs; c.info = info;                           // remember for a cheap re-render (hide/show)
  $('#fileName').textContent = c.label;
  $('#binary').style.display = 'none';
  $('#empty').style.display = 'none';
  const badge = $('#kindBadge'); badge.style.display = '';
  badge.textContent = c.d.dm ? 'dm' : c.d.kind === 'delimited' ? `CSV · ${c.d.delimiter === '\t' ? 'TSV' : 'delimited'}` : c.d.kind;
  badge.title = detectedFacts(c.d).map(([k, v]) => `${k}: ${v}`).join(' · ') + ' — click to change how the file is read';

  const base = createLaminaProvider(vs, { PENDING });
  const total = c.baseVs.cols;
  const vis = [];                                        // display col → underlying col (pinned-first, reordered, skipping hidden)
  let pinnedVis = 0;
  for (const uc of pinnedFirstOrder(c)) { if (c.hidden.has(uc)) continue; vis.push(uc); if (c.pinned && c.pinned.has(uc)) pinnedVis++; }
  c._vis = vis; c._pinnedCount = pinnedVis;
  const provider = {
    dims() { return { rows: vs.rowCount(), cols: vis.length }; },
    cellAt(r, dc) {
      const uc = vis[dc];
      const cell = base.cellAt(r, uc);
      if (!cell || typeof cell !== 'object') return cell;     // PENDING / null / blank
      let style = cell.style;
      const fmt = c.colFormats[uc];
      if (fmt && cell.type === 'number') { const num = parseNum(cell.value, c.d.decimal); if (!Number.isNaN(num)) { const t = fmtNumber(num, fmt); if (t != null) style = { ...style, text: t }; } }
      const cs = c.colScale && c.colScale.get(uc);
      if (cs && cell.type === 'number' && cs.hi > cs.lo) {
        const num = parseNum(cell.value, c.d.decimal);
        if (!Number.isNaN(num)) { const sc = scaleColor(scaleT(num, cs), cs.palette); style = { ...style, bg: sc.bg, fg: sc.fg }; }
      }
      if (_findActive && (_findScopeCol == null || _findScopeCol === uc) && cell.value != null && cell.value !== '' && _findMatch(String(cell.value))) style = { ...style, highlight: true };   // tint visible find matches (free — viewport only)
      return style === cell.style ? cell : { ...cell, style };
    },
    header(dc) { const uc = vis[dc]; const h = base.header(uc); const sk = c.sort && c.sort.find((s) => s.col === uc); if (sk) h.sort = sk.dir; return h; },
    headerGutter(dc) {
      const uc = vis[dc]; if (!(showGutter && c.gutter)) return null;
      const g = c.gutter[uc]; if (!g) return null;
      const f = c.gutterFiltered && c.gutterFiltered[uc];
      return f ? { ...g, filtered: f } : g;             // filter-reactive: the filtered overlay rides on the global spec
    },
    rowHeader(r) { return base.rowHeader(r); },
    onReady(cb) { return base.onReady(cb); },
  };

  grid = createGrid($('#grid'), provider, { readOnly: true, theme: effectiveTheme(), defaultColW: c.d.kind === 'text' ? 900 : 130, headerGutterH: (showGutter && c.d.kind === 'delimited') ? GUTTER_H : 0, pinnedCols: c._pinnedCount || 0, axisLock: scrollLock });
  // reapply persisted column widths (stored by UNDERLYING col → display indices)
  const dw = {};
  for (let dc = 0; dc < vis.length; dc++) { const w = c.colWidths[vis[dc]]; if (w != null) dw[dc] = w; }
  if (Object.keys(dw).length) grid.setColWidths(dw);
  // Restore scroll: horizontal always (same columns), vertical only on a pure
  // re-render (hide/show/pin/format) — a filter/sort changes the row set, so it
  // starts at the top. The browser clamps if the new extent is smaller.
  if (prevScroll) grid.setScroll({ left: prevScroll.left, top: keepVScroll ? prevScroll.top : 0 });
  if (c.d.kind === 'delimited') {
    // No sort-on-label-click — confusing for a viewer; sort lives in the header
    // right-click menu (Sort ↑/↓). The label click is inert; the gutter click → stats.
    grid.onHeaderContextMenu(({ col, clientX, clientY }) => showColumnMenu(vis[col], clientX, clientY));
  }
  grid.onContextMenu(({ row, col, sel, clientX, clientY }) => showCellMenu(row, col, sel, clientX, clientY));
  if (c.d.kind === 'delimited') {
    grid.onGutterClick((dc, frac) => gutterClick(vis[dc], frac));       // tap → filter (hist: the bin · cat: the category) — debounced for dbl-click
    grid.onGutterDblClick((dc) => gutterDblClick(vis[dc]));             // double-click → Statistics popup
    grid.onGutterBrush((dc, lo, hi) => gutterBrush(vis[dc], lo, hi));   // hist drag → `between` · cat drag → `in (…)`
    grid.onGutterBrushMove((dc, lo, hi, x, y) => showBrushTip(vis[dc], lo, hi, x, y));   // live readout while dragging
    grid.onGutterHover((dc, frac, x, y) => showGutterTip(dc == null ? null : vis[dc], frac, x, y));   // hover → value / category tooltip
  }

  const shownRows = vs.rowCount();
  const baseRows = c.baseVs.rowCount();
  let rows = info.filtered ? `${shownRows.toLocaleString()} of ${baseRows.toLocaleString()} rows (filtered)` : `${shownRows.toLocaleString()} rows`;
  if (info.sorted && c.sort) rows += ` · sorted by ${c.sort.map((s) => c.schema[s.col].name + (s.dir === 'desc' ? ' ↓' : ' ↑')).join(', ')}`;
  const cols = c.hidden.size ? `${vis.length} of ${total} cols` : `${vis.length} cols`;
  const skipped = c.d.skip ? ` · ${c.d.skip} ${c.d.comment ? c.d.comment + '-' : ''}comment lines skipped` : '';
  const kindLabel = c.d.dm ? 'dm' : c.d.kind;
  const resident = residentEstimate(c);                  // the never-resident superpower, made visible
  const resTerm = (resident != null && resident < c.totalBytes * 0.6) ? ` · ~${fmtBytes(resident)} resident` : '';
  c._meta = `${rows} × ${cols} · ${fmtBytes(c.totalBytes)}${resTerm} · ${kindLabel}${skipped}`;   // remembered so a copy-flash can restore it
  $('#meta').textContent = c._meta;
  grid.onSelect(onSelectionChanged);                    // drives the record card + footer selection stats
  $('#selStats').textContent = '';                      // fresh grid → no selection yet
  window._laminaVS = vs;                                // automation hook
  if (_colPanelOpen) renderColPanel();                  // keep the columns panel in sync (gutter-ready, menu-hide, new file)
  if (_recPanelOpen) renderRecordCard(_recRow);         // re-resolve the record after a sort/filter/new file
  updateEncHint();
}

// Cheap re-render of the current view (after a column hide/show — the data view
// is unchanged, only which columns show).
function rerender() { if (current && current.view) mountView(current.view, current.info, true); }   // row set unchanged → keep both scroll axes
// Override a column's detected type (number ↔ text). The schema array is shared
// live with the views, so this changes alignment + how stats/sort treat it;
// recompute re-applies a sort on that column under the new type.
function setColType(uc, type) {
  if (!current || !current.schema[uc]) return;
  current.schema[uc].type = type;
  current.typeOverrides = current.typeOverrides || {};
  current.typeOverrides[current.schema[uc].name] = type;   // by name → round-trips in the lens
  if (current._statsCache) current._statsCache.clear();    // type change → stats meaning changed
  recompute();
}

// Cell color-scale (heatmap). Perceptual, colour-blind-safe ramps (switchboard CVD
// lineage): sequential viridis/magma + a diverging blue–red (for cutoff-relative).
// t∈[0,1] → a cell bg + a luminance-picked readable text colour; fully-filled cells
// are theme-independent.
const PALETTES = {
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  magma: [[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]],
  inferno: [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]],
  plasma: [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 149, 64], [240, 249, 33]],
  turbo: [[48, 18, 59], [33, 144, 237], [60, 230, 113], [223, 220, 48], [209, 47, 11]],
  cividis: [[0, 32, 76], [42, 72, 114], [110, 112, 115], [176, 166, 114], [255, 233, 69]],
  grayscale: [[24, 24, 24], [128, 128, 128], [240, 240, 240]],
  bluered: [[33, 102, 172], [146, 197, 222], [247, 247, 247], [244, 165, 130], [178, 24, 43]],   // diverging
};
// Distinct categorical hues for the cat gutter glyph's stacked segments — mid-tone,
// readable on both the light and dark field background (Tableau-10 ordering).
const CAT_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#ff9da7', '#bab0ac'];
function scaleColor(t, palette) {
  const P = PALETTES[palette] || PALETTES.viridis;
  t = Math.max(0, Math.min(1, t));
  const n = P.length - 1, i = Math.min(n - 1, Math.floor(t * n)), f = t * n - i, a = P[i], b = P[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f), g = Math.round(a[1] + (b[1] - a[1]) * f), bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return { bg: `rgb(${r},${g},${bl})`, fg: (0.299 * r + 0.587 * g + 0.114 * bl) / 255 > 0.6 ? '#111' : '#f5f5f5' };
}
// Map a value → t∈[0,1] under a color-scale config { scale, lo, hi, reverse }.
function scaleT(num, cs) {
  let t;
  if (cs.scale === 'log') { const lo = Math.max(cs.lo, 1e-12), hi = Math.max(cs.hi, lo * 1.0000001), v = Math.max(num, lo); t = (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)); }
  else t = (num - cs.lo) / ((cs.hi - cs.lo) || 1);
  t = Math.max(0, Math.min(1, t));
  return cs.reverse ? 1 - t : t;
}

// colScale is a Map<col → { scale, clip, palette, reverse, lo, hi }>.
function colScaleDefault(uc) {
  const c = current, g = c.gutter && c.gutter[uc];
  return { scale: 'linear', clip: false, palette: 'viridis', reverse: false, lo: g && g.min != null ? g.min : 0, hi: g && g.max != null ? g.max : 1 };
}
function toggleColorScale(uc) {
  const c = current; if (!c) return;
  c.colScale = c.colScale || new Map();
  if (c.colScale.has(uc)) c.colScale.delete(uc); else c.colScale.set(uc, colScaleDefault(uc));
  rerender();
}
async function setColScaleOpt(uc, patch) {
  const c = current; if (!c) return;
  c.colScale = c.colScale || new Map();
  if (!c.colScale.has(uc)) c.colScale.set(uc, colScaleDefault(uc));   // picking a palette/scale/clip turns it on with that option
  const cs = { ...c.colScale.get(uc), ...patch };
  if ('clip' in patch) {                                 // recompute bounds: robust p5–p95 (sampled) vs the full min/max
    if (patch.clip) { const b = await computeClipBounds(uc); if (b) { cs.lo = b.lo; cs.hi = b.hi; } }
    else { const g = c.gutter && c.gutter[uc]; if (g) { cs.lo = g.min; cs.hi = g.max; } }
    if (current !== c) return;
  }
  if (cs.scale === 'log' && cs.lo <= 0) cs.lo = cs.hi > 0 ? cs.hi / 1000 : 1e-6;   // log needs a positive floor
  c.colScale.set(uc, cs); rerender();
}
// Robust scale bounds from the gutter sample: p5 / p95 (tames outliers / log-normal tails).
async function computeClipBounds(uc) {
  const c = current; const vals = [];
  await c.source.eachRecord({ dataStart: c.dataStart, limit: GUTTER_SAMPLE }, (disp, fields) => {
    const x = parseNum(fields[uc], c.d.decimal); if (!Number.isNaN(x)) vals.push(x);
  });
  if (vals.length < 2) return null;
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return { lo: q(0.05), hi: q(0.95) };
}

// Per-column number display format (null = auto/raw). Applied in the cellAt wrap.
function fmtNumber(num, fmt) {
  if (!fmt) return null;
  if (fmt.mode === 'fixed') return num.toFixed(fmt.digits);
  if (fmt.mode === 'sci') return num.toExponential(fmt.digits);
  if (fmt.mode === 'group') return num.toLocaleString();
  return null;
}
function setColFormat(uc, fmt) { if (current) { current.colFormats[uc] = fmt; rerender(); } }
function hideColumn(uc) { if (current) { current.hidden.add(uc); rerender(); } }
function showColumn(uc) { if (current) { current.hidden.delete(uc); rerender(); } }
function showAllColumns() { if (current) { current.hidden.clear(); rerender(); } }

// Display order of UNDERLYING column indices, reconciled with the current schema:
// honor c.colOrder where valid, then append any unlisted indices (a new calc column,
// or a lens that didn't name them) in natural order. null/absent → natural order.
function effectiveOrder(c) {
  const n = c.schema.length;
  if (!c.colOrder || !c.colOrder.length) return Array.from({ length: n }, (_, i) => i);
  const seen = new Set(), out = [];
  for (const uc of c.colOrder) if (uc >= 0 && uc < n && !seen.has(uc)) { out.push(uc); seen.add(uc); }
  for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
  return out;
}
// Move column `fromUc` to just before `toUc` in the display order (panel drag).
function reorderCol(fromUc, toUc) {
  const c = current; if (!c || fromUc === toUc) return;
  const order = effectiveOrder(c);
  order.splice(order.indexOf(fromUc), 1);
  order.splice(order.indexOf(toUc), 0, fromUc);
  c.colOrder = order;
  rerender();                                            // rebuilds _vis (+ renderColPanel via the mountView hook)
}
// Display order with pinned columns hoisted to the front (each group keeps colOrder).
// loom freezes the first N display columns, so pinned-first + a count = pin/freeze.
function pinnedFirstOrder(c) {
  const order = effectiveOrder(c), pin = c.pinned;
  if (!pin || !pin.size) return order;
  const a = [], b = [];
  for (const uc of order) (pin.has(uc) ? a : b).push(uc);
  return a.concat(b);
}
// Go-to-column: scroll the grid so column `uc` is visible (+ select it at the current
// row). loom scrolls a selection into view, so this is the jump. Hidden → no-op.
function scrollToColumn(uc) {
  const c = current; if (!c || !grid) return;
  const dc = (c._vis || []).indexOf(uc);
  if (dc < 0) return;                                    // hidden — not in the grid
  const sel = grid.getSelection(); const r = sel ? sel.r0 : 0;
  grid.setSelection({ r0: r, c0: dc, r1: r, c1: dc });
  if (grid.revealCell) grid.revealCell(r, dc);           // selection alone doesn't scroll — bring it into view
  grid.focus();
}
// Pin/unpin a column (freeze it on the left). Pinned columns render leftmost + frozen.
function togglePin(uc) {
  const c = current; if (!c) return;
  c.pinned = c.pinned || new Set();
  if (c.pinned.has(uc)) c.pinned.delete(uc); else c.pinned.add(uc);
  rerender();
}

// ── columns panel (right-docked slide-out) ─────────────────────────────────────
// A searchable list of every column with a visibility checkbox + type + null-rate +
// a ⋯ menu (the existing per-column actions). Pure consolidation of existing state
// (c.hidden / colFormats / colScale / gutter + showColumnMenu); reorder + pin = v2.
// ── dock panel resizing (drag the left edge; width persisted) ───────────────────
const loadPanelW = (k, d) => { try { const v = parseInt(localStorage.getItem(k), 10); return Number.isFinite(v) ? v : d; } catch { return d; } };
let colPanelW = loadPanelW('lamina.colPanelW', 266), recPanelW = loadPanelW('lamina.recPanelW', 300);
function clampPanelW(w) { return Math.max(200, Math.min(w | 0, Math.round(window.innerWidth * 0.6))); }
function makePanelResizable(panelId, gripId, set) {
  const grip = $('#' + gripId), panel = $('#' + panelId); if (!grip || !panel) return;
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault(); grip.classList.add('dragging');
    const onMove = (ev) => { const w = clampPanelW(window.innerWidth - ev.clientX); set(w); panel.style.width = w + 'px'; document.documentElement.style.setProperty('--cp', w + 'px'); };
    const onUp = () => { grip.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  });
}
makePanelResizable('colPanel', 'cpGrip', (w) => { colPanelW = w; try { localStorage.setItem('lamina.colPanelW', w); } catch { /* ignore */ } });
makePanelResizable('recordPanel', 'rpGrip', (w) => { recPanelW = w; try { localStorage.setItem('lamina.recPanelW', w); } catch { /* ignore */ } });

// ── record card (row inspector) ─────────────────────────────────────────────────
// A right-dock panel showing the selected row's fields as name:value — read one
// record without scrolling 50 columns horizontally. Follows the selection. Shares the
// right-dock slot with the columns panel (mutually exclusive). Click a field → filter
// by that value (inspect → narrow). Pure inspection; read-only.
let _recPanelOpen = false, _recRow = 0, _recPinned = null;   // _recPinned = { row, fields } snapshot for side-by-side compare
function toggleRecordPanel(force) {
  _recPanelOpen = force != null ? force : !_recPanelOpen;
  if (_recPanelOpen && !current) { _recPanelOpen = false; return; }
  closeMenu();
  if (_recPanelOpen && _colPanelOpen) toggleColPanel(false);   // one right-dock panel at a time
  const p = $('#recordPanel');
  if (_recPanelOpen) p.style.width = clampPanelW(recPanelW) + 'px';
  p.classList.toggle('show', _recPanelOpen);
  document.documentElement.style.setProperty('--cp', _recPanelOpen ? p.offsetWidth + 'px' : '0px');
  if (_recPanelOpen) { const s = grid && grid.getSelection(); renderRecordCard(s ? s.r0 : _recRow); }
}
function fmtRecVal(c, uc, raw) {              // a record field → display string (honours the column's number format)
  let disp = (raw == null || raw === '') ? '' : String(raw);
  const s = c.schema[uc];
  if (s.type === 'number' && c.colFormats[uc] && disp !== '') { const num = parseNum(raw, c.d.decimal); if (!Number.isNaN(num)) { const t = fmtNumber(num, c.colFormats[uc]); if (t != null) disp = t; } }
  return disp;
}
async function renderRecordCard(row) {
  const c = current; if (!c || !_recPanelOpen) return;
  const vs = c.view || window._laminaVS; if (!vs) return;
  row = Math.max(0, Math.min(vs.rowCount() - 1, row | 0));
  _recRow = row;
  const pin = _recPinned;
  $('#rpRow').textContent = pin ? `row ${(pin.row + 1).toLocaleString()} ⇄ ${(row + 1).toLocaleString()}` : `row ${(row + 1).toLocaleString()} of ${vs.rowCount().toLocaleString()}`;
  const pinBtn = $('#rpPin'); if (pinBtn) pinBtn.classList.toggle('on', !!pin);
  const fields = await vs.ensureRow(row);
  if (current !== c || !_recPanelOpen || _recRow !== row) return;   // selection moved / file changed mid-load
  const list = $('#rpList'); list.textContent = '';
  if (!fields) { const e = document.createElement('div'); e.className = 'rp-field'; e.textContent = '(no data)'; list.appendChild(e); return; }
  for (const uc of pinnedFirstOrder(c)) {
    const s = c.schema[uc], raw = fields[uc], numCls = s.type === 'number' ? ' num' : '';
    const f = document.createElement('div'); f.className = 'rp-field' + (c.hidden.has(uc) ? ' off' : '');
    const k = document.createElement('span'); k.className = 'rp-k'; k.textContent = s.name; k.title = s.name;
    if (s.calc) { const cf = document.createElement('span'); cf.className = 'rp-calc'; cf.textContent = 'ƒ '; k.prepend(cf); }
    const disp = fmtRecVal(c, uc, raw);
    if (pin) {                                // compare: pinned value | current value, diff highlighted
      f.classList.add('cmp');
      const praw = pin.fields ? pin.fields[uc] : undefined, pdisp = fmtRecVal(c, uc, praw);
      if (String(praw == null ? '' : praw) !== String(raw == null ? '' : raw)) f.classList.add('diff');
      const vp = document.createElement('span'); vp.className = 'rp-vp' + numCls; vp.textContent = pdisp === '' ? '∅' : pdisp;
      const v = document.createElement('span'); v.className = 'rp-v' + numCls; v.textContent = disp === '' ? '∅' : disp;
      f.append(k, vp, v);
    } else {
      const v = document.createElement('span'); v.className = 'rp-v' + numCls;
      if (disp === '') { v.textContent = '∅'; v.classList.add('rp-null'); } else v.textContent = disp;
      f.append(k, v);
      if (raw != null && raw !== '') { f.title = 'filter by this value'; f.onclick = () => filterByValue(uc, String(raw)); }
    }
    list.appendChild(f);
  }
}
$('#rpClose').onclick = () => toggleRecordPanel(false);
$('#rpPrev').onclick = () => renderRecordCard(_recRow - 1);
$('#rpNext').onclick = () => renderRecordCard(_recRow + 1);
$('#rpPin').onclick = async () => {           // pin the current record as a reference, or unpin
  if (_recPinned) { _recPinned = null; return renderRecordCard(_recRow); }
  const c = current, vs = c && (c.view || window._laminaVS); if (!vs) return;
  const fields = await vs.ensureRow(_recRow);
  _recPinned = { row: _recRow, fields: fields ? fields.slice() : [] };
  renderRecordCard(_recRow);
};
$('#rpCopy').onclick = async () => {          // copy the record (TSV) — both columns when pinned
  const c = current, vs = c && (c.view || window._laminaVS); if (!vs) return;
  const fields = await vs.ensureRow(_recRow); if (!fields) return;
  const pin = _recPinned, L = [];
  if (pin) L.push(`field\trow ${pin.row + 1}\trow ${_recRow + 1}`);
  for (const uc of pinnedFirstOrder(c)) {
    const nm = c.schema[uc].name;
    L.push(pin ? `${nm}\t${fmtRecVal(c, uc, pin.fields[uc])}\t${fmtRecVal(c, uc, fields[uc])}` : `${nm}\t${fmtRecVal(c, uc, fields[uc])}`);
  }
  copyText(L.join('\n'));
  const b = $('#rpCopy'); b.textContent = '✓'; setTimeout(() => { b.textContent = '⧉'; }, 1000);
};

// ── selection stats (footer) ────────────────────────────────────────────────────
// Select a range → count · sum · mean · min · max (numeric) in the footer, like a
// spreadsheet's status bar. Debounced (a drag fires onSelect a lot); bounded by a cell
// cap (a whole-column select stays cheap, marked + when capped). Reads cached/loaded
// rows via the active view. One handler drives both this and the record card.
let _selTimer = null;
const SEL_STATS_CAP = 50000;
function onSelectionChanged(sel) {
  if (_recPanelOpen && sel) renderRecordCard(sel.r0);
  clearTimeout(_selTimer);
  _selTimer = setTimeout(() => updateSelStats(sel), 90);
}
async function updateSelStats(sel) {
  const el = $('#selStats'), c = current;
  if (!el) return;
  if (!c || !sel) { el.textContent = ''; return; }
  const r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
  const c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
  const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
  if (cells <= 1) { el.textContent = ''; return; }
  const perRow = c1 - c0 + 1, rEnd = Math.min(r1, r0 + Math.floor(SEL_STATS_CAP / perRow));
  const capped = rEnd < r1;
  const vs = c.view || window._laminaVS;
  let count = 0, n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (let r = r0; r <= rEnd; r++) {
    const fields = await vs.ensureRow(r);
    if (current !== c) return;                          // file changed mid-scan
    if (!fields) continue;
    for (let dc = c0; dc <= c1; dc++) {
      const uc = c._vis ? c._vis[dc] : dc; if (uc == null) continue;
      const raw = fields[uc];
      if (raw == null || raw === '') continue;
      count++;
      if (c.schema[uc] && c.schema[uc].type === 'number') { const x = parseNum(raw, c.d.decimal); if (!Number.isNaN(x)) { n++; sum += x; if (x < min) min = x; if (x > max) max = x; } }
    }
  }
  if (current !== c) return;
  let s = `sel ${count.toLocaleString()}${capped ? '+' : ''}`;
  if (n > 0) s += ` · Σ ${fmtN(sum)} · x̄ ${fmtN(sum / n)} · min ${fmtN(min)} · max ${fmtN(max)}`;
  el.textContent = s;
}

let _colPanelOpen = false;
function toggleColPanel(force) {
  _colPanelOpen = force != null ? force : !_colPanelOpen;
  if (_colPanelOpen && !current) { _colPanelOpen = false; return; }
  closeMenu();
  if (_colPanelOpen && _recPanelOpen) toggleRecordPanel(false);   // one right-dock panel at a time
  const p = $('#colPanel');
  if (_colPanelOpen) p.style.width = clampPanelW(colPanelW) + 'px';
  p.classList.toggle('show', _colPanelOpen);
  // loom's own ResizeObserver repaints the grid when #grid's right inset changes.
  document.documentElement.style.setProperty('--cp', _colPanelOpen ? p.offsetWidth + 'px' : '0px');
  if (_colPanelOpen) { renderColPanel(); $('#cpSearch').focus(); }
}
function updateCpCount() {
  const c = current; if (!c) return;
  $('#cpCount').textContent = `${c.schema.length - c.hidden.size} of ${c.schema.length} shown`;
}
let _cpDragUc = null;
function renderColPanel() {
  const c = current; if (!c || !_colPanelOpen) return;
  const list = $('#cpList'); const q = $('#cpSearch').value.trim().toLowerCase();
  list.textContent = '';
  for (const uc of pinnedFirstOrder(c)) {                // list in DISPLAY order (pinned-first) so it matches the grid
    const s = c.schema[uc]; if (q && !s.name.toLowerCase().includes(q)) continue;
    const visible = !c.hidden.has(uc);
    const isPinned = !!(c.pinned && c.pinned.has(uc));
    const row = document.createElement('div'); row.className = 'cp-row' + (visible ? '' : ' off') + (isPinned ? ' pinned' : '');
    const grip = document.createElement('span'); grip.className = 'cp-grip'; grip.textContent = '⠿'; grip.title = 'drag to reorder'; grip.draggable = true;
    grip.addEventListener('dragstart', (e) => { _cpDragUc = uc; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', s.name); } catch { /* ignore */ } row.classList.add('cp-dragging'); });
    grip.addEventListener('dragend', () => { row.classList.remove('cp-dragging'); list.querySelectorAll('.cp-over').forEach((x) => x.classList.remove('cp-over')); _cpDragUc = null; });
    row.addEventListener('dragover', (e) => { if (_cpDragUc == null) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('cp-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('cp-over'));
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('cp-over'); if (_cpDragUc != null && _cpDragUc !== uc) reorderCol(_cpDragUc, uc); });
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = visible;
    cb.onchange = () => { if (cb.checked) c.hidden.delete(uc); else c.hidden.add(uc); row.classList.toggle('off', !cb.checked); updateCpCount(); rerender(); };
    const ty = document.createElement('span'); ty.className = 'cp-type' + (s.type === 'number' ? ' num' : ''); ty.textContent = s.type === 'number' ? '#' : 'abc';
    const nm = document.createElement('span'); nm.className = 'cp-name'; nm.textContent = s.name; nm.title = visible ? 'scroll to column' : s.name;
    if (visible) nm.onclick = () => scrollToColumn(uc);
    if (s.calc) { const f = document.createElement('span'); f.className = 'cp-calc'; f.textContent = 'ƒ '; nm.prepend(f); }
    const g = c.gutter && c.gutter[uc]; const pct = g && g.nullRate != null ? Math.round(g.nullRate * 100) : null;
    const nu = document.createElement('span'); nu.className = 'cp-null';
    if (pct != null && pct > 0) { nu.textContent = pct + '%∅'; nu.title = pct + '% blank (sampled)'; }
    const pin = document.createElement('button'); pin.className = 'cp-pin' + (isPinned ? ' on' : ''); pin.textContent = '📌'; pin.title = isPinned ? 'unfreeze column' : 'freeze column (keep visible while scrolling)';
    pin.onclick = () => togglePin(uc);
    const more = document.createElement('button'); more.className = 'cp-more'; more.textContent = '⋯'; more.title = 'column actions';
    more.onclick = () => { const r = more.getBoundingClientRect(); showColumnMenu(uc, r.left - 150, r.bottom + 2); };
    row.append(grip, cb, ty, nm, nu, pin, more); list.appendChild(row);
  }
  updateCpCount();
}
$('#cpClose').onclick = () => toggleColPanel(false);
$('#cpSearch').oninput = renderColPanel;
$('#colPanel').querySelectorAll('.cp-bulk button').forEach((b) => {
  b.onclick = () => {
    const c = current; if (!c) return;
    const act = b.dataset.cp;
    if (act === 'all') c.hidden.clear();
    else if (act === 'none') { for (let i = 0; i < c.schema.length; i++) c.hidden.add(i); }
    else for (let i = 0; i < c.schema.length; i++) { if (c.hidden.has(i)) c.hidden.delete(i); else c.hidden.add(i); }
    renderColPanel(); rerender();
  };
});

// ── cell context menu: copy variants + filter-by-value + column stats ──
function showCellMenu(row, col, sel, x, y) {
  const c = current; if (!c || !grid) return;
  const uc = (c._vis ? c._vis[col] : col);
  const name = c.baseVs.header(uc).label;
  const cell = grid.provider.cellAt(row, col);
  const val = (cell && typeof cell === 'object') ? (cell.value ?? '') : '';
  const nR = sel.r1 - sel.r0 + 1, nC = sel.c1 - sel.c0 + 1;
  const shownVal = val.length > 24 ? val.slice(0, 24) + '…' : val;
  const items = [
    { label: nR * nC > 1 ? `Copy ${nR}×${nC}` : 'Copy', action: () => copySelection(sel, {}) },
    { label: 'Copy with header', action: () => copySelection(sel, { header: true }) },
    { label: 'Copy with row #', action: () => copySelection(sel, { rowNum: true }) },
    { label: 'Copy with header + row #', action: () => copySelection(sel, { header: true, rowNum: true }) },
    { sep: true },
    { label: `Filter ${name} = ${shownVal || '(empty)'}`, action: () => filterByValue(uc, val) },
    { label: `Statistics — ${name}…`, action: () => showColumnStats(uc) },
    { sep: true },
    { label: 'Inspect this row…', action: () => { toggleRecordPanel(true); renderRecordCard(row); } },
  ];
  showMenu(x, y, items);
}

// Build a TSV from a display selection (raw values for data fidelity) → clipboard.
async function copySelection(sel, { header, rowNum } = {}) {
  if (!grid) return;
  const { r0, c0, r1, c1 } = sel;
  for (let r = r0; r <= r1; r++) await window._laminaVS.ensureRow(r);     // load any off-screen rows in range
  const lines = [];
  if (header) {
    const h = rowNum ? ['row'] : [];
    for (let dc = c0; dc <= c1; dc++) h.push(grid.provider.header(dc).label);
    lines.push(h.join('\t'));
  }
  for (let r = r0; r <= r1; r++) {
    const out = rowNum ? [grid.provider.rowHeader(r)] : [];
    for (let dc = c0; dc <= c1; dc++) { const cell = grid.provider.cellAt(r, dc); out.push(cell && typeof cell === 'object' ? (cell.value ?? '') : ''); }
    lines.push(out.join('\t'));
  }
  copySuppressFlash = true;
  copyText(lines.join('\n'));
  copySuppressFlash = false;
  flashCopied(`copied ${r1 - r0 + 1}×${c1 - c0 + 1}${header ? ' +header' : ''}${rowNum ? ' +row#' : ''}`);
}

// Clipboard write via a temp textarea + execCommand — works under file:// too
// (navigator.clipboard is blocked there), matching loom's own copy path.
function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  if (grid) grid.focus();
}

// A column reference for the filter grammar: a bare ident if safe, else the
// ["…"] bracket escape (geo columns are "Cu (ppm)", "a Domains", …).
function colRef(name) { return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : `[${JSON.stringify(name)}]`; }

// Filter to the right-clicked cell's value (numeric → bare number, else quoted).
function filterByValue(uc, val) {
  const name = current.baseVs.header(uc).label;
  const numeric = current.schema[uc] && current.schema[uc].type === 'number';
  const expr = (numeric && val !== '' && !Number.isNaN(Number(val)))
    ? `${colRef(name)} == ${val}`
    : `${colRef(name)} == "${String(val).replace(/"/g, '')}"`;
  $('#filter').value = expr; syncFilterClear(); applyFilter(expr);
}

// ── copy feedback in the footer (menu copies + Ctrl+C) ──
let copySuppressFlash = false;
let _metaTimer = null;
function flashCopied(msg) {
  clearTimeout(_metaTimer);
  $('#meta').textContent = '✓ ' + msg;
  _metaTimer = setTimeout(() => { if (current && current._meta) $('#meta').textContent = current._meta; }, 1800);
}
document.addEventListener('copy', () => {                 // loom's Ctrl+C (menu copies suppress this)
  if (copySuppressFlash || !grid) return;
  const s = grid.getSelection(); if (!s) return;
  flashCopied(`copied ${s.r1 - s.r0 + 1}×${s.c1 - s.c0 + 1}`);
});
// Persist the live grid's column widths into `current.colWidths` (keyed by
// UNDERLYING col, so they survive hide/show + sort/filter re-renders).
function captureWidths() {
  if (!grid || !current || !current._vis) return;
  const w = grid.getColWidths();                         // display-keyed
  for (const k in w) { const uc = current._vis[k]; if (uc != null) current.colWidths[uc] = w[k]; }
}
// Size every visible column to its content (header + visible cells — cheap, loom
// samples only what's on screen). Reset returns them to the default width.
function autofitAll() { if (!grid) return; const n = grid.provider.dims().cols; for (let c = 0; c < n; c++) grid.autofitColumn(c); captureWidths(); }
function resetColWidths() { if (current) current.colWidths = {}; if (grid) grid.setColWidths({}); }

// Right-click a column header → sort / filter-by / hide / show.
function showColumnMenu(uc, x, y) {
  const c = current; if (!c) return;
  const name = c.baseVs.header(uc).label;
  const sorted = c.sort || [];
  const items = [
    { label: `Sort ${name} ↑`, action: () => { c.sort = [{ col: uc, dir: 'asc' }]; recompute(); } },
    { label: `Sort ${name} ↓`, action: () => { c.sort = [{ col: uc, dir: 'desc' }]; recompute(); } },
  ];
  if (sorted.length && !sorted.some((s) => s.col === uc)) {           // add as a tiebreaker after the current keys
    items.push(
      { label: `Then by ${name} ↑`, action: () => { c.sort = [...sorted, { col: uc, dir: 'asc' }]; recompute(); } },
      { label: `Then by ${name} ↓`, action: () => { c.sort = [...sorted, { col: uc, dir: 'desc' }]; recompute(); } });
  }
  if (sorted.length) items.push({ label: 'Clear sort', action: () => { c.sort = null; recompute(); } });
  items.push({ sep: true }, { label: `Statistics — ${name}…`, action: () => showColumnStats(uc) });
  items.push({ label: `Filter by ${name}…`, action: () => setFilterText(`${colRef(name)} `) });
  const isNum = c.schema[uc] && c.schema[uc].type === 'number';       // force-type override (fixes a mis-detected column)
  items.push(isNum ? { label: 'Treat as text', action: () => setColType(uc, 'string') }
                   : { label: 'Treat as number', action: () => setColType(uc, 'number') });
  if (isNum) items.push({ label: 'Number format', submenu: [
    { label: 'Auto', action: () => setColFormat(uc, null) },
    { label: '0 decimals', action: () => setColFormat(uc, { mode: 'fixed', digits: 0 }) },
    { label: '2 decimals', action: () => setColFormat(uc, { mode: 'fixed', digits: 2 }) },
    { label: '3 decimals', action: () => setColFormat(uc, { mode: 'fixed', digits: 3 }) },
    { label: '4 decimals', action: () => setColFormat(uc, { mode: 'fixed', digits: 4 }) },
    { label: 'Scientific', action: () => setColFormat(uc, { mode: 'sci', digits: 3 }) },
    { label: 'Thousands (1,234)', action: () => setColFormat(uc, { mode: 'group' }) },
  ] });
  if (isNum) {                                                        // heatmap the cells by value
    const cs = c.colScale && c.colScale.get(uc);
    const eff = cs || colScaleDefault(uc);                            // checkmarks reflect what WOULD apply; picking any option enables it
    const pal = (id, lbl) => ({ label: (eff.palette === id ? '✓ ' : '') + lbl, action: () => setColScaleOpt(uc, { palette: id }) });
    const sub = [
      { label: (cs ? '✓ ' : '') + 'On', action: () => toggleColorScale(uc) },
      { sep: true },
      { label: 'Palette', submenu: [
        pal('viridis', 'Viridis'), pal('magma', 'Magma'), pal('inferno', 'Inferno'),
        pal('plasma', 'Plasma'), pal('turbo', 'Turbo'), pal('cividis', 'Cividis'),
        pal('grayscale', 'Grayscale'), pal('bluered', 'Blue–red (diverging)'),
      ] },
      { label: 'Scale', submenu: [
        { label: (eff.scale === 'linear' ? '✓ ' : '') + 'Linear', action: () => setColScaleOpt(uc, { scale: 'linear' }) },
        { label: (eff.scale === 'log' ? '✓ ' : '') + 'Log', action: () => setColScaleOpt(uc, { scale: 'log' }) },
      ] },
      { label: (eff.clip ? '✓ ' : '') + 'Clip outliers (p5–p95)', action: () => setColScaleOpt(uc, { clip: !eff.clip }) },
      { label: (eff.reverse ? '✓ ' : '') + 'Reverse', action: () => setColScaleOpt(uc, { reverse: !eff.reverse }) },
    ];
    items.push({ label: 'Color scale', submenu: sub });
    const gg = c.gutter && c.gutter[uc];                              // log-distribution gutter toggle (only when a positive log glyph exists)
    if (gg && gg.kind === 'hist' && gg.logBins) {
      const lbl = (gg.log ? '✓ ' : '') + 'Log distribution' + (gg.logSuggested && gg.log ? ' (auto)' : '');
      items.push({ label: lbl, action: () => setGutterLog(uc, !gg.log) });
    }
  }
  items.push({ sep: true }, { label: `Hide ${name}`, action: () => hideColumn(uc) });
  for (let i = 0; i < c.baseVs.cols; i++) {
    if (c.hidden.has(i)) items.push({ label: `Show ${c.baseVs.header(i).label}`, action: () => showColumn(i) });
  }
  if (c.hidden.size) items.push({ label: 'Show all columns', action: () => showAllColumns() });
  items.push({ sep: true }, { label: 'Add calculated column…', action: () => openCalcEditor(null) });
  if (c._schema0 && uc >= c._schema0.length) {                       // this IS a calc column → edit / remove
    const ci = uc - c._schema0.length;
    items.push({ label: `Edit ${name}…`, action: () => openCalcEditor(ci) }, { label: `Remove ${name}`, action: () => removeCalc(ci) });
  }
  items.push({ label: 'Autofit all columns', action: () => autofitAll() });
  showMenu(x, y, items);
}

// A lightweight context menu with hover submenus. Items: {label, action(rect)} |
// {label, submenu:[items]} | {sep:true}. Hovering a submenu item opens its child
// to the right (parent stays); hovering a leaf closes any open child.
let _menus = [];   // open menu divs, parent → child chain
// x,y = preferred top-left (root menu, at the cursor). anchor = the parent item's
// rect for a submenu — opened to its right, FLIPPED to the parent menu's left edge
// when it would overflow (recursively safe: each level flips off its own anchor).
function openLevel(items, x, y, level, anchor) {
  closeFrom(level);
  const m = document.createElement('div'); m.className = 'ctxmenu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const el = document.createElement('div'); el.className = 'item';
    const lab = document.createElement('span'); lab.textContent = it.label; el.appendChild(lab);
    if (it.submenu) {
      const arr = document.createElement('span'); arr.className = 'arr'; arr.textContent = '▸'; el.appendChild(arr);
      const open = () => openLevel(it.submenu, 0, 0, level + 1, el.getBoundingClientRect());
      el.onmouseenter = open;
      el.onclick = (e) => { e.stopPropagation(); open(); };
    } else {
      el.onmouseenter = () => closeFrom(level + 1);      // leaving the submenu-opener row closes the child
      el.onclick = () => { const r = el.getBoundingClientRect(); closeMenu(); it.action && it.action(r); };
    }
    m.appendChild(el);
  }
  document.body.appendChild(m);
  const mw = m.offsetWidth, mh = m.offsetHeight, pad = 4;
  let left, top;
  if (anchor) {                                          // submenu: right of the item, flip to the parent's left on overflow
    left = anchor.right - 2;
    if (left + mw > innerWidth - pad) left = anchor.left - mw + 2;
    if (left < pad) left = Math.max(pad, innerWidth - mw - pad);
    top = anchor.top - 5;
  } else {                                               // root: at the cursor, nudge left if it overflows
    left = x; top = y;
    if (left + mw > innerWidth - pad) left = Math.max(pad, x - mw);
  }
  if (top + mh > innerHeight - pad) top = Math.max(pad, innerHeight - mh - pad);   // clamp vertically (both menus)
  if (top < pad) top = pad;
  m.style.left = left + 'px'; m.style.top = top + 'px';
  _menus[level] = m;
}
function closeFrom(level) { for (let i = _menus.length - 1; i >= level; i--) if (_menus[i]) _menus[i].remove(); _menus.length = Math.min(_menus.length, level); }
function closeMenu() { closeFrom(0); document.removeEventListener('mousedown', onDocDown); }
function onDocDown(e) { if (!_menus.some((m) => m && m.contains(e.target))) closeMenu(); }
function showMenu(x, y, items) { closeMenu(); openLevel(items, x, y, 0); setTimeout(() => document.addEventListener('mousedown', onDocDown), 0); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// Cycle a column's sort: none → asc → desc → none. Switching columns starts asc.
// Cycle the PRIMARY sort on a column: none → asc → desc → none (replaces any
// multi-key sort). Secondary keys are added via the header menu's "Then by".
function toggleSort(col) {
  const c = current; if (!c) return;
  const cur = c.sort && c.sort.length === 1 && c.sort[0].col === col ? c.sort[0] : null;
  if (!cur) c.sort = [{ col, dir: 'asc' }];
  else if (cur.dir === 'asc') c.sort = [{ col, dir: 'desc' }];
  else c.sort = null;
  return recompute();
}

// Apply a filter expression (forward scan → matching rows), then recompute (sort
// re-applies over the new matches). Empty clears. Bad column/expr marks red.
async function applyFilter(str) {
  const c = current;
  if (!c) return;
  if (c._statsCache) c._statsCache.clear();              // filter changes the matched set → cached stats are stale
  if (!str.trim()) { $('#filter').classList.remove('err'); c.filterResult = null; const r = recompute(); refreshGutterFiltered(); return r; }
  const cols = c.d.kind === 'delimited' ? c.d.schema : [{ name: 'line' }];
  const v = validate(str, cols);                          // parse + unknown-column → red box, friendly message
  if (!v.ok) return filterErr(new Error(friendlyError(v.errors, cols)));
  let predicate;
  try { predicate = compileBool(str, cols, { decimal: c.d.decimal }); } catch (e) { return filterErr(e); }
  $('#filter').classList.remove('err');
  $('#meta').textContent = 'filtering…';
  // on a .dm, PROJECT the scan to the predicate's referenced columns (strided
  // decode — read only those fields per record, not all N). Skip when calc columns
  // are in play (their formulas may reach any column → full decode is required).
  let projCols = null;
  if (c.dm && (!c.calcs || !c.calcs.length)) {
    try {
      const idxOf = new Map(c.d.schema.map((s, i) => [String(s.name).toLowerCase(), i]));
      const need = new Set();
      for (const d of deps(str)) { const i = idxOf.get(String(d).toLowerCase()); if (i != null) need.add(i); }
      projCols = need.size ? [...need] : null;
    } catch { projCols = null; }
  }
  const ac = newFooterScan();
  try {
    c.filterResult = await scanFilter(c.source, {
      predicate, dataStart: c.dataStart, signal: ac.signal, cols: projCols,
      onProgress: (b, n) => { $('#meta').textContent = `filtering… ${n ? Math.round((100 * b) / n) : 0}% · Esc to cancel`; },
    });
    const r = recompute(); refreshGutterFiltered(); return r;   // overlay the matched-rows distribution on the gutters
  } catch (e) {
    if (e && e.name === 'AbortError') { $('#meta').textContent = c._meta || 'filter cancelled'; return; }   // keep the prior view
    filterErr(e);
  } finally { if (_footerScanAbort === ac) _footerScanAbort = null; }
}
function filterErr(e) { $('#filter').classList.add('err'); $('#meta').textContent = `filter: ${e.message}`; }

// Open raw bytes — memory source (the test hook + small files). `force` overrides
// auto-detection (the interpretation popover re-opens with it).
function open(name, bytes, force) {
  if (!force) {
    const lens = sniffLens(bytes); if (lens) return applyLens(lens);   // a .lamina lens, not data
    const dmFmt = detectDM(bytes.subarray(0, Math.min(4096, bytes.length)));   // Datamine .dm?
    if (dmFmt) {
      try {
        const h = parseHeader(bytes, dmFmt);
        const reader = (off, len) => Promise.resolve(bytes.subarray(off, off + len));   // already resident
        return mountDm(name, reader, h, bytes.length);
      } catch { /* fall through */ }
    }
  }
  const enc = force && force.encoding;
  const sample = bytes.subarray(0, 65536);
  const d = detectKind(sample, { force, name });
  if (d.kind === 'binary') return showBinary(name, bytes.length);
  d.encoding = enc;
  mount(name, d, buildMemorySource(bytes, { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"', encoding: enc }), bytes.length);
  current.bytes = bytes; current.force = force || {};                 // remember for re-open with new force
  current.encSuspect = encodingSuspect(sample, enc); updateEncHint();
}

// Render in-memory bytes (a small file, or a decompressed archive entry) through
// the RESIDENT memory source — no streaming, no index cache.
function openInner(label, bytes) {
  const d = detectKind(bytes.subarray(0, 65536), { name: label });
  if (d.kind === 'binary') return showBinary(label, bytes.length);
  lastScan = 'resident';
  mount(label, d, buildMemorySource(bytes, { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"' }), bytes.length);
}

// ── Datamine .dm (binary table) → a DIRECT record path: no decode-to-text, ever.
// One backing for every size — the .dm IS a record source (a record cursor +
// a windowed browse view), so filter / sort / stats / format work the same as CSV.
// `reader(off,len) → Promise<Uint8Array>` abstracts the bytes (File.slice for a
// picked file, a subarray for already-resident bytes). ──

// A windowed .dm browse ViewSource: a block is K contiguous records, read on
// demand via `reader` + decodeRecord, held in a small LRU — only a few screenfuls
// resident, never the file. Same shape as createRecordViewSource (rowAt sync →
// fields | LOADING | null) so the loom provider + grid windowing work unchanged.
// Decoded values are stringified to match the CSV path (the provider writes
// row[c] into the cell text).
function createDmViewSource(reader, h, { cacheBlocks = 16, blockSize = 256 } = {}) {
  const K = blockSize;
  const n = h.recordCount;
  const cols = h.schema.length;
  const cache = new Map();          // block → fields[][]  (insertion-order LRU)
  const inflight = new Map();
  const readyCbs = [];
  const notify = () => { for (const cb of readyCbs) { try { cb(); } catch (e) { console.error('[lamina] onReady threw', e); } } };

  function loadBlock(b) {
    if (cache.has(b)) return Promise.resolve();
    if (inflight.has(b)) return inflight.get(b);
    const i0 = b * K, i1 = Math.min(n, i0 + K);
    const start = recordRange(h, i0).offset;
    const last = recordRange(h, i1 - 1);
    const end = last.offset + last.length;                  // span may cross pages — per-record offsets index in
    const p = Promise.resolve(reader(start, end - start)).then((bytes) => {
      const rows = [];
      for (let i = i0; i < i1; i++) {
        const r = recordRange(h, i);
        const vals = decodeRecord(bytes.subarray(r.offset - start, r.offset - start + r.length), h);
        rows.push(vals.map((v) => (v == null ? '' : String(v))));
      }
      cache.set(b, rows);
      while (cache.size > cacheBlocks) cache.delete(cache.keys().next().value);   // evict oldest
      inflight.delete(b); notify();
    }, (err) => { inflight.delete(b); console.error('[lamina] dm loadBlock failed', err); });
    inflight.set(b, p);
    return p;
  }

  return {
    kind: 'delimited', cols, schema: h.schema,
    rowCount() { return n; },
    rowAt(r) {
      if (r < 0 || r >= n) return null;
      const b = Math.floor(r / K);
      if (cache.has(b)) { const rows = cache.get(b); cache.delete(b); cache.set(b, rows); return rows[r - b * K] || null; }   // LRU touch
      loadBlock(b);
      return LOADING;
    },
    async ensureRow(r) { if (r >= 0 && r < n) await loadBlock(Math.floor(r / K)); return this.rowAt(r); },
    header(c) { return { label: h.schema[c] ? h.schema[c].name : `col ${c + 1}`, type: this.colType(c) }; },
    colType(c) { return (h.schema[c] && h.schema[c].type) || 'string'; },
    onReady(cb) { readyCbs.push(cb); return () => { const i = readyCbs.indexOf(cb); if (i >= 0) readyCbs.splice(i, 1); }; },
  };
}

// A .dm record cursor — the @gcu/lamina cursor contract (eachRecord + readByLoc)
// over @gcu/dm's O(1) record access. This is what powers filter / sort / stats on
// a .dm with NO text round-trip: eachRecord yields the RAW decoded values (numbers
// stay numbers — exact, no parse-back); the locator is just the record index;
// readByLoc re-reads one record for a scattered result view. Reads in record
// chunks (one page-span per read); a `rows` subset stops early.
// project ONE record: decode only the requested column indices by striding each
// field's fixed word-offset (readField), instead of the whole record. Missing/
// unreferenced columns stay undefined — the predicate only reads its own columns.
function projectDmRecord(bytes, h, cols) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(h.columns.length);
  for (const ci of cols) out[ci] = readField(dv, h, h.columns[ci], 0);
  return out;
}
function createDmCursor(reader, h, { chunk = 4096 } = {}) {
  const n = h.recordCount;
  return {
    kind: 'dm', rowCount: n, schema: h.schema, delimiter: '\t', quote: '"',
    async eachRecord({ dataStart = 0, rows = null, onProgress, limit = Infinity, cols = null } = {}, visit) {
      let sp = 0, seen = 0;
      for (let i0 = 0; i0 < n; i0 += chunk) {
        const i1 = Math.min(n, i0 + chunk);
        const start = recordRange(h, i0).offset;
        const last = recordRange(h, i1 - 1);
        const bytes = await reader(start, last.offset + last.length - start);
        for (let i = i0; i < i1; i++) {
          const disp = i - dataStart;
          if (disp < 0) continue;
          if (rows) {                                       // restrict to the subset (ascending)
            while (sp < rows.length && rows[sp] < disp) sp++;
            if (sp >= rows.length || rows[sp] !== disp) continue;
            sp++;
          }
          const r = recordRange(h, i);
          const sub = bytes.subarray(r.offset - start, r.offset - start + r.length);
          visit(disp, cols ? projectDmRecord(sub, h, cols) : decodeRecord(sub, h), i, 0);   // loc0 = record index; cols = strided projection

          if (++seen >= limit) return;                      // sample cap (gutter stats)
        }
        if (onProgress) onProgress(i1, n);
        if (rows && sp >= rows.length) break;
      }
    },
    async readByLoc(i) {
      const r = recordRange(h, i);
      const bytes = await reader(r.offset, r.length);
      return decodeRecord(bytes, h).map((v) => (v == null ? '' : String(v)));   // display strings (matches CSV)
    },
  };
}

// Mount a .dm: the windowed browse view + the record cursor (filter/sort/stats).
// Any size — no resident decode, no TSV, no cap.
function mountDm(name, reader, h, totalBytes) {
  if (grid) { grid.destroy(); grid = null; }
  const baseVs = createDmViewSource(reader, h);
  const source = createDmCursor(reader, h);
  const d = { kind: 'delimited', delimiter: '\t', quote: '"', hasHeader: true, schema: h.schema, dataStart: 0, decimal: '.', dm: true };
  current = { source, d, schema: h.schema, dataStart: 0, baseVs, label: name, totalBytes, filterResult: null, sort: null, hidden: new Set(), colWidths: {}, colFormats: {}, _vis: null, file: null, bytes: null, force: {}, dm: true };
  _recPinned = null; _recRow = 0;                        // fresh file → drop any pinned compare record
  $('#filter').value = ''; $('#filter').classList.remove('err'); syncFilterClear();
  lastScan = 'dm';
  initCalcState();
  recompute();
  refreshGutter();
  if (_pendingLens || _pendingLensView) Promise.resolve().then(applyPendingLens);
}

// ── calculated columns (read-time derived columns; @gcu/expr) ──────────────────
// Each is { name, expr, type }. They're NEVER materialized — applyCalcs rebuilds
// the cursor + browse view as calc-decorated wrappers over the pristine originals
// (kept as _src0 / _vs0 / _schema0), so filter / sort / stats / browse all see the
// derived columns. Session-only (lost on reload) — but a "lens" (Data → Save lens…)
// captures them along with the filter / sort / formats to re-apply later.

// Capture the pristine (undecorated) source/view/schema + an empty calc list. Called
// right after a file mounts (mount / mountDm), before any calc is added.
function initCalcState() {
  const c = current;
  c.calcs = [];
  c._src0 = c.source; c._vs0 = c.baseVs; c._schema0 = c.schema;
}

// Rebuild source/baseVs/schema from the originals + the current calc list, then
// re-run the active filter against the new schema (which re-renders). Compiling all
// calcs against the FULL extended schema (base + every calc) keeps indices correct
// under add/edit/remove and lets a calc reference an earlier calc.
function applyCalcs() {
  const c = current; if (!c) return;
  if (c._statsCache) c._statsCache.clear();             // calc columns changed → cached stats / column indices stale
  const calcs = c.calcs;
  if (!calcs.length) {
    c.source = c._src0; c.baseVs = c._vs0; c.schema = c._schema0; c.d.schema = c._schema0;
  } else {
    const ext = [...c._schema0, ...calcs.map((x) => ({ name: x.name, type: x.type, calc: true }))];
    const compiled = calcs.map((x) => ({ name: x.name, type: x.type, fn: compile(x.expr, ext, { decimal: c.d.decimal }) }));
    const baseCount = c._schema0.length;
    c.schema = ext; c.d.schema = ext;
    c.source = withCalcCursor(c._src0, baseCount, compiled);
    c.baseVs = withCalcView(c._vs0, baseCount, compiled);
  }
  if (c.sort) { c.sort = c.sort.filter((s) => s.col < c.schema.length); if (!c.sort.length) c.sort = null; }   // a removed calc → drop dangling sort keys
  const box = $('#filter').value;                                 // a filter that referenced a removed calc → clear it (don't strand a red box)
  if (box.trim() && !validate(box, c.schema).ok) { $('#filter').value = ''; $('#filter').classList.remove('err'); syncFilterClear(); }
  const r = applyFilter($('#filter').value);                      // re-validate + re-run the filter, then recompute (sort)
  refreshGutter();                                                // recompute the gutter so calc columns get a glyph too
  return r;
}

// Programmatic add (the automation hook + the editor's commit share applyCalcs).
async function addCalc(name, expr) {
  const c = current; if (!c) return;
  c.calcs.push({ name, expr, type: await inferCalcType(expr, c.schema) });
  return applyCalcs();
}
function removeCalc(idx) { const c = current; if (!c) return; c.calcs.splice(idx, 1); return applyCalcs(); }

// ── lens: save / apply a VIEW (filter · sort · calc columns · per-column number
// format / color-scale / hidden / width) as a small .lamina JSON. The data stays
// put — a lens is config that REapplies to the current (or a similar) file. Columns
// are referenced BY NAME (case-insensitive, like the filter language), so a lens
// made on one export applies to the next: names that resolve are applied, names that
// don't are skipped + reported. No data, no theme (theme is a global pref).
const LENS_VERSION = 1;
let _pendingLens = null;        // a lens opened with no file yet → apply when one mounts
let _pendingLensView = null;    // a lens mid-apply across an interpretation re-read

function buildLens() {
  const c = current; if (!c) return null;
  const nameOf = (uc) => (c.schema[uc] && c.schema[uc].name);
  const lens = { kind: 'lamina-lens', version: LENS_VERSION, source: c.label || null };
  const f = c.force || {};                                  // interpretation — only the bits the user forced (auto handles the rest)
  const interp = {};
  for (const k of ['kind', 'delimiter', 'hasHeader', 'decimal', 'skip', 'comment', 'quote']) if (f[k] != null && f[k] !== '') interp[k] = f[k];
  if (Object.keys(interp).length) lens.interpretation = interp;
  const box = $('#filter').value.trim(); if (box) lens.filter = box;
  if (c.sort && c.sort.length) lens.sort = c.sort.map((s) => ({ col: nameOf(s.col), dir: s.dir })).filter((s) => s.col);
  if (c.calcs && c.calcs.length) lens.calcs = c.calcs.map((x) => ({ name: x.name, expr: x.expr, type: x.type }));
  const cols = {};
  for (let uc = 0; uc < c.schema.length; uc++) {
    const nm = nameOf(uc); if (!nm) continue;
    const o = {};
    if (c.colFormats[uc]) o.format = c.colFormats[uc];
    const cs = c.colScale && c.colScale.get(uc);
    if (cs) o.colorScale = { scale: cs.scale, palette: cs.palette, reverse: cs.reverse, clip: cs.clip };   // lo/hi are data-specific → recomputed on apply
    if (c.hidden.has(uc)) o.hidden = true;
    if (c.colWidths[uc] != null) o.width = c.colWidths[uc];
    if (c.typeOverrides && c.typeOverrides[nm]) o.type = c.typeOverrides[nm];   // treat-as override
    if (Object.keys(o).length) cols[nm] = o;
  }
  if (Object.keys(cols).length) lens.columns = cols;
  const order = effectiveOrder(c);                          // column display order (names), only if reordered from natural
  if (!order.every((uc, i) => uc === i)) lens.order = order.map(nameOf).filter(Boolean);
  if (c.pinned && c.pinned.size) lens.pinned = order.filter((uc) => c.pinned.has(uc)).map(nameOf).filter(Boolean);
  // grade–tonnage setup (only if the user configured GT this session) — by NAME
  // so it re-applies to any file with a matching schema, like everything else
  if (_gtConfig && Array.isArray(_gtConfig.grades) && _gtConfig.grades.length) {
    const grades = _gtConfig.grades
      .map((uc, i) => ({ col: nameOf(uc), unit: _gtConfig.gradeUnits[i] || '', cutoffs: _gtConfig.cutoffs[i] || '', ranges: _gtConfig.ranges[i] || '' }))
      .filter((g) => g.col);
    if (grades.length) lens.gt = { group: _gtConfig.group != null ? nameOf(_gtConfig.group) : null,
      volume: _gtConfig.volume, density: _gtConfig.density, densityUnit: _gtConfig.densityUnit, proportion: _gtConfig.proportion, grades };
  }
  return lens;
}

async function saveLens() {
  const lens = buildLens(); if (!lens) return;
  closeMenu();
  const text = JSON.stringify(lens, null, 2);
  const fname = ((current.label || 'view').replace(/\.[^.]*$/, '')) + '.lamina';
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'lamina lens', accept: { 'application/json': ['.lamina', '.lam'] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close();
      $('#meta').textContent = `✓ lens saved → ${h.name || fname}`;
    } catch { /* cancelled */ }
  } else { downloadText(text, fname); $('#meta').textContent = `✓ lens → ${fname}`; }
}

// Sniff bytes → a lens object if it carries the marker, else null. Cheap head check
// before the full parse; must run BEFORE CSV/dm detection so a .lamina isn't read as
// data. (downloadText uses text/csv; a lens download fallback gets the right ext.)
function sniffLens(bytes) {
  let head; try { head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256)); } catch { return null; }
  if (!/^\s*\{/.test(head) || !head.includes('lamina-lens')) return null;
  try { const o = JSON.parse(new TextDecoder().decode(bytes)); return (o && o.kind === 'lamina-lens') ? o : null; } catch { return null; }
}

// Apply a lens to the current file (or hold it if none open yet). Re-reads first
// when the lens's interpretation differs, then applies the view by name.
function applyLens(lens) {
  if (!current) { _pendingLens = lens; $('#empty').style.display = ''; $('#meta').textContent = 'lens loaded — open a data file to apply it to'; return; }
  const c = current, want = lens.interpretation, cur = c.force || {};
  const differs = want && ['kind', 'delimiter', 'hasHeader', 'decimal', 'skip', 'comment'].some((k) => want[k] != null && want[k] !== '' && want[k] !== cur[k]);
  if (differs && (c.file || c.bytes)) { _pendingLensView = lens; reopen(want); }   // mount() applies the view after the re-read
  else return applyLensView(lens);
}

async function applyLensView(lens) {
  const c = current; if (!c) return;
  const skip = [];
  const hasBase = (name) => c._schema0.some((s) => s.name.toLowerCase() === String(name).toLowerCase());
  if (Array.isArray(lens.calcs)) for (const cc of lens.calcs) {           // 1) calc columns (whose name is free)
    if (!cc.name || !cc.expr) continue;
    if (hasBase(cc.name) || c.calcs.some((x) => x.name.toLowerCase() === cc.name.toLowerCase())) { skip.push(`calc "${cc.name}" (name taken)`); continue; }
    c.calcs.push({ name: cc.name, expr: cc.expr, type: cc.type || 'number' });
  }
  if (lens.filter) { $('#filter').value = lens.filter; } else { $('#filter').value = ''; }   // 2) filter — applyCalcs runs it vs the rebuilt schema
  syncFilterClear();
  await applyCalcs();                                                     // rebuilds c.schema (base+calcs) + runs the filter
  if (current !== c) return;
  if (lens.filter && !validate(lens.filter, c.schema).ok) skip.push('filter (a referenced column is missing)');
  const idx = (name) => c.schema.findIndex((s) => s.name.toLowerCase() === String(name).toLowerCase());   // 3) names → indices (extended schema)
  if (Array.isArray(lens.sort)) {
    const keys = [];
    for (const s of lens.sort) { const i = idx(s.col); if (i >= 0) keys.push({ col: i, dir: s.dir === 'desc' ? 'desc' : 'asc' }); else skip.push(`sort "${s.col}" (missing)`); }
    c.sort = keys.length ? keys : null;
  }
  if (lens.columns) for (const [name, cfg] of Object.entries(lens.columns)) {
    const i = idx(name); if (i < 0) { skip.push(`column "${name}" (missing)`); continue; }
    if (cfg.format) c.colFormats[i] = cfg.format;
    if (cfg.hidden) c.hidden.add(i);
    if (cfg.width != null) c.colWidths[i] = cfg.width;
    if (cfg.type && c.schema[i]) { c.schema[i].type = cfg.type; c.typeOverrides = c.typeOverrides || {}; c.typeOverrides[name] = cfg.type; }   // treat-as override
  }
  if (Array.isArray(lens.order)) {                                        // column display order (by name; unlisted appended by effectiveOrder)
    const ord = [];
    for (const nm of lens.order) { const i = idx(nm); if (i >= 0 && !ord.includes(i)) ord.push(i); }
    c.colOrder = ord.length ? ord : null;
  }
  if (Array.isArray(lens.pinned)) {                                       // frozen columns (by name)
    c.pinned = new Set();
    for (const nm of lens.pinned) { const i = idx(nm); if (i >= 0) c.pinned.add(i); }
  }
  await recompute();                                                      // sort + render with formats/hidden + order
  if (current !== c) return;
  if (lens.columns && Object.values(lens.columns).some((cfg) => cfg.colorScale)) {   // color-scale needs the gutter (min/max)
    await refreshGutter();
    if (current !== c) return;
    c.colScale = c.colScale || new Map();
    for (const [name, cfg] of Object.entries(lens.columns)) {
      if (!cfg.colorScale) continue;
      const i = idx(name); if (i < 0) continue;
      c.colScale.set(i, { ...colScaleDefault(i), scale: cfg.colorScale.scale || 'linear', palette: cfg.colorScale.palette || 'viridis', reverse: !!cfg.colorScale.reverse });
      if (cfg.colorScale.clip) await setColScaleOpt(i, { clip: true });   // recomputes robust bounds for THIS file
    }
    rerender();
  }
  // grade–tonnage setup: stash it for openGradeTonnage to seed from (a grade
  // whose column is missing just falls back to auto there — noted here)
  if (lens.gt && Array.isArray(lens.gt.grades)) {
    c._lensGt = lens.gt;
    const missing = lens.gt.grades.filter((g) => idx(g.col) < 0).map((g) => g.col);
    if (missing.length) skip.push(`grade–tonnage grade(s) ${missing.join(', ')} (missing)`);
  }
  const where = lens.source && lens.source !== c.label ? ` (from ${lens.source})` : '';
  $('#meta').textContent = skip.length ? `lens applied${where} — skipped: ${skip.join('; ')}` : `lens applied${where}`;
  if (!skip.length) setTimeout(() => { if (current === c && c._meta) $('#meta').textContent = c._meta; }, 3500);
}

// Mount-time hook: a lens waiting for data, or one mid-apply across a re-read.
function applyPendingLens() {
  if (_pendingLensView) { const v = _pendingLensView; _pendingLensView = null; applyLensView(v); }
  else if (_pendingLens) { const v = _pendingLens; _pendingLens = null; applyLens(v); }
}

// Pick a .lamina file and apply it to the current view.
async function applyLensFromFile() {
  closeMenu();
  let bytes = null;
  if (window.showOpenFilePicker) {
    try { const [h] = await window.showOpenFilePicker({ types: [{ description: 'lamina lens', accept: { 'application/json': ['.lamina', '.lam'] } }] }); const f = await h.getFile(); bytes = new Uint8Array(await f.arrayBuffer()); } catch { return; }
  } else {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.lamina,.lam,application/json';
    bytes = await new Promise((res) => { inp.onchange = async () => res(inp.files[0] ? new Uint8Array(await inp.files[0].arrayBuffer()) : null); inp.click(); });
    if (!bytes) return;
  }
  const lens = sniffLens(bytes);
  if (!lens) { $('#meta').textContent = 'not a lamina lens file'; return; }
  applyLens(lens);
}

// Sample the first visible rows to guess number-vs-text (display alignment + numeric
// sort/stats); the column menu's "treat as text/number" stays the manual override.
async function inferCalcType(expr, cols) {
  const c = current;
  let fn; try { fn = compile(expr, cols, { decimal: c.d.decimal }); } catch { return 'string'; }
  const n = Math.min(6, c.baseVs.rowCount()); const out = [];
  for (let r = 0; r < n; r++) { const row = await c.baseVs.ensureRow(r); if (row) out.push(fn(row)); }
  const nn = out.filter((x) => x != null);
  return nn.length && nn.every((x) => typeof x === 'number') ? 'number' : 'string';
}

// ── streaming export (the "extract" leg) ───────────────────────────────────────
// Write the CURRENT view (filtered + sorted + calc + chosen columns) to CSV/TSV —
// never-resident via the File System Access API (a buffered <a download> fallback
// where FSAA is absent). Get the 50k rows that matter out of the 500M.
function csvField(v, delim, q) {
  const s = v == null ? '' : String(v);
  return (s.includes(delim) || s.includes(q) || s.includes('\n') || s.includes('\r')) ? q + s.split(q).join(q + q) + q : s;
}
// Iterate the chosen view row-by-row (sequential → the block LRU keeps it cheap),
// serialize, and push batches to a sink ({ write, close }). Cancellable via signal.
async function runExport({ delimiter = ',', header = true, allRows = false, colIdx, sink, onProgress, signal }) {
  const c = current; if (!c) return 0;
  const q = '"';
  const idx = colIdx && colIdx.length ? colIdx : c.schema.map((_, i) => i);
  let buf = header ? idx.map((i) => csvField(c.schema[i].name, delimiter, q)).join(delimiter) + '\n' : '';
  let written = 0;
  const emit = (row) => { buf += (row ? idx.map((i) => csvField(row[i], delimiter, q)).join(delimiter) : '') + '\n'; written++; };

  const filtered = !allRows && c.filterResult;
  const sorted = !allRows && c.sort && c.sort.length;
  if (filtered && !sorted) {
    // Block-ordered scan over the matched rows: sequential reads, skipping
    // match-free blocks (eachRecord), vastly faster than the result view's scattered
    // per-row File.slice reads. Same source order as the unsorted filtered view.
    const rows = c.filterResult.nums, total = rows.length, CANCEL = {};
    try {
      await c.source.eachRecord({ dataStart: c.dataStart, rows }, (disp, fields) => {
        if (signal && signal.cancelled) throw CANCEL;
        emit(fields);
        if (onProgress && (written & 4095) === 0) onProgress(written, total);
        if (buf.length > 65536) { const w = sink.write(buf); buf = ''; return w; }   // async visit → eachRecord awaits the stream-flush
      });
    } catch (e) { if (e !== CANCEL) throw e; }
  } else {
    const view = allRows ? c.baseVs : (c.view || c.baseVs);   // whole table, or a SORTED result view (order ≠ disk, so per-row)
    const n = view.rowCount();
    for (let r = 0; r < n; r++) {
      if (signal && signal.cancelled) break;
      emit(await view.ensureRow(r));
      if (buf.length > 65536) { await sink.write(buf); buf = ''; }
      if (onProgress && (r & 2047) === 0) onProgress(r, n);
    }
  }
  await sink.write(buf);
  await sink.close();
  return written;
}
// Automation hook + the small-file path: serialize the whole export to a string.
async function exportToString(opts = {}) {
  const parts = [];
  await runExport({ ...opts, sink: { write: (t) => parts.push(t), close: () => {} } });
  return parts.join('');
}
function downloadText(text, name) {                            // fallback when FSAA is absent (Firefox/Safari)
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let _exSignal = null;
function openExportDialog() {
  const c = current; if (!c) return;
  closeMenu();
  const list = $('#exCols'); list.innerHTML = '';
  c.schema.forEach((s, i) => {
    const lab = document.createElement('label'); lab.className = 'ex-col';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !c.hidden.has(i); cb.dataset.i = String(i);
    const nm = document.createElement('span'); nm.textContent = s.name; if (s.calc) nm.style.color = '#d8c08a';
    lab.appendChild(cb); lab.appendChild(nm); list.appendChild(lab);
  });
  $('#exProgress').textContent = '';
  $('#exDelim').value = c.d.delimiter === '\t' ? 'tab' : 'comma';
  const scoped = !!(c.filterResult || (c.sort && c.sort.length));     // a scope choice only matters when a filter/sort is active
  $('#exScopeRow').style.display = scoped ? '' : 'none';
  $('#exScope').value = scoped ? 'view' : 'all';
  $('#exColSearch').value = ''; filterExCols(); updateExColCount();
  $('#exportDialog').classList.add('show');
}
function closeExportDialog() { if (_exSignal) _exSignal.cancelled = true; $('#exportDialog').classList.remove('show'); }

// ── export column picker: search-filter + all/none/invert + live count ──
const exColRows = () => [...$('#exCols').querySelectorAll('.ex-col')];
const exColShown = () => exColRows().filter((r) => !r.classList.contains('hide'));   // not hidden by the search
function updateExColCount() {
  const rows = exColRows(), n = rows.filter((r) => r.querySelector('input').checked).length;
  $('#exColCount').textContent = `${n} / ${rows.length}`;
}
function filterExCols() {
  const inp = $('#exColSearch');
  const q = inp.value.trim().toLowerCase();
  inp.closest('.ex-search-wrap').classList.toggle('has-text', inp.value !== '');   // show the clear × only when typed
  for (const r of exColRows()) r.classList.toggle('hide', !!q && !r.querySelector('span').textContent.toLowerCase().includes(q));
}
// All/None/Invert act on the SHOWN rows, so a search narrows their scope
// (filter "au" → all → checks just the assay columns). Checked state persists
// across filtering; export reads every checked box regardless of the filter.
const _exSetShown = (val) => { exColShown().forEach((r) => { const cb = r.querySelector('input'); cb.checked = val == null ? !cb.checked : val; }); updateExColCount(); };
$('#exColSearch').oninput = filterExCols;
$('#exColSearchClear').onclick = () => { const i = $('#exColSearch'); i.value = ''; filterExCols(); i.focus(); };
$('#exColAll').onclick = () => _exSetShown(true);
$('#exColNone').onclick = () => _exSetShown(false);
$('#exColInvert').onclick = () => _exSetShown(null);
$('#exCols').onchange = updateExColCount;
function gatherExportOpts() {
  const d = $('#exDelim').value;
  return {
    delimiter: d === 'tab' ? '\t' : d === 'semi' ? ';' : d === 'pipe' ? '|' : ',',
    header: $('#exHeader').checked,
    allRows: $('#exScope').value === 'all',
    colIdx: [...$('#exCols').querySelectorAll('input:checked')].map((cb) => Number(cb.dataset.i)),
  };
}
async function doExport() {
  const c = current; if (!c) return;
  const opts = gatherExportOpts();
  if (!opts.colIdx.length) { $('#exProgress').textContent = 'pick at least one column'; return; }
  const ext = opts.delimiter === '\t' ? '.tsv' : '.csv';
  const fname = (c.label || 'export').replace(/\.[^.]*$/, '') + ext;
  const signal = { cancelled: false }; _exSignal = signal;
  let sink;
  if (window.showSaveFilePicker) {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'Delimited text', accept: { 'text/csv': [ext] } }] }); }
    catch { _exSignal = null; return; }                       // user cancelled the picker
    const w = await handle.createWritable();
    sink = { write: (t) => w.write(t), close: () => w.close() };
  } else {                                                     // buffered download (size-capped)
    const parts = []; let total = 0;
    sink = { write: (t) => { total += t.length; if (total > 256 * 1024 * 1024) throw new Error('too large for the download fallback — use a Chromium browser for streaming export'); parts.push(t); }, close: () => downloadText(parts.join(''), fname) };
  }
  try {
    const n = await runExport({ ...opts, sink, signal, onProgress: (r, tot) => { $('#exProgress').textContent = `exporting… ${tot ? Math.round(100 * r / tot) : 0}%  (${r.toLocaleString()} rows)`; } });
    $('#exProgress').textContent = signal.cancelled ? 'cancelled' : `✓ ${n.toLocaleString()} rows → ${fname}`;
    if (!signal.cancelled) setTimeout(() => { if (_exSignal === signal) $('#exportDialog').classList.remove('show'); }, 1100);
  } catch (e) { $('#exProgress').textContent = 'export failed: ' + e.message; }
  finally { _exSignal = null; }
}

// ── the calc-column manager (the list) ──
function openCalcManager() {
  const c = current; if (!c) return;
  closeOpts(); closeMenu();
  renderCalcManager();
  $('#calcManager').classList.add('show');
}
function closeCalcManager() { $('#calcManager').classList.remove('show'); }
function renderCalcManager() {
  const c = current; if (!c) return;
  const list = $('#cmList'); list.innerHTML = '';
  if (!c.calcs.length) {
    const e = document.createElement('div'); e.className = 'cm-empty';
    e.textContent = 'No calculated columns yet. Add one to derive a column from a formula — e.g. grade * density.';
    list.appendChild(e); return;
  }
  c.calcs.forEach((cc, i) => {
    const row = document.createElement('div'); row.className = 'cm-row';
    const meta = document.createElement('div'); meta.className = 'cm-meta';
    const nm = document.createElement('span'); nm.className = 'cm-name'; nm.textContent = cc.name;
    const ex = document.createElement('code'); ex.className = 'cm-expr'; ex.textContent = cc.expr;
    meta.appendChild(nm); meta.appendChild(ex);
    const acts = document.createElement('div'); acts.className = 'cm-acts';
    const ed = document.createElement('button'); ed.textContent = 'Edit'; ed.onclick = () => { closeCalcManager(); _mgrReturn = true; openCalcEditor(i); };
    const rm = document.createElement('button'); rm.textContent = 'Remove'; rm.onclick = () => { removeCalc(i); renderCalcManager(); };
    acts.appendChild(ed); acts.appendChild(rm);
    row.appendChild(meta); row.appendChild(acts);
    list.appendChild(row);
  });
}
$('#cmClose').onclick = closeCalcManager;
$('#cmAdd').onclick = () => { closeCalcManager(); _mgrReturn = true; openCalcEditor(null); };
$('#calcManager').onclick = (e) => { if (e.target.id === 'calcManager') closeCalcManager(); };   // backdrop dismiss

// ── the calc-column editor popover ──
let _calcEdit = null;                       // index being edited, or null (add mode)
let _calcDraft = { ok: false };             // { ok, name, expr, type } from the live preview
let _mgrReturn = false;                     // reopen the manager after the editor closes (came from it)

function openCalcEditor(idx) {
  const c = current; if (!c) return;
  closeOpts(); closeMenu();
  _calcEdit = (idx == null ? null : idx);
  const cur = idx == null ? null : c.calcs[idx];
  $('#ceTitle').textContent = idx == null ? 'Add calculated column' : 'Edit calculated column';
  $('#ceCommit').textContent = idx == null ? 'Add' : 'Save';
  $('#ceName').value = cur ? cur.name : '';
  $('#ceExpr').value = cur ? cur.expr : '';
  $('#calcEditor').classList.add('show');
  previewCalc();
  $('#ceName').focus();
  setTimeout(() => document.addEventListener('mousedown', onCalcDown), 0);
}
function closeCalcEditor() {
  $('#calcEditor').classList.remove('show'); document.removeEventListener('mousedown', onCalcDown);
  if (_mgrReturn) { _mgrReturn = false; openCalcManager(); }   // came from the manager → return to it
}
function onCalcDown(e) { if (!$('#calcEditor').contains(e.target)) closeCalcEditor(); }

// Live: validate name + expression, show deps, preview over the first visible rows.
async function previewCalc() {
  const c = current; if (!c) return;
  _calcDraft = { ok: false };
  const name = $('#ceName').value.trim();
  const expr = $('#ceExpr').value;
  syncHL($('#ceExpr'), $('#ceExprHL'));                 // keep the highlight layer in step
  const status = $('#ceStatus'), prev = $('#cePreview');
  $('#ceName').classList.remove('err'); $('#ceExpr').classList.remove('err');

  // name: valid ident, not colliding with a base column or another calc
  let nameErr = '';
  if (name) {
    const taken = new Set([...c._schema0.map((x) => x.name.toLowerCase()), ...c.calcs.filter((_, i) => i !== _calcEdit).map((x) => x.name.toLowerCase())]);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) nameErr = 'name: a letter then letters / digits / _ / -';
    else if (taken.has(name.toLowerCase())) nameErr = `a column named "${name}" already exists`;
    if (nameErr) $('#ceName').classList.add('err');
  }

  if (!expr.trim()) { status.className = 'ce-status'; status.textContent = nameErr || 'enter an expression'; prev.textContent = ''; $('#ceCommit').disabled = true; return; }
  const v = validate(expr, c.schema);
  if (!v.ok) { $('#ceExpr').classList.add('err'); status.className = 'ce-status err'; status.textContent = friendlyError(v.errors, c.schema); prev.textContent = ''; $('#ceCommit').disabled = true; return; }

  let fn; try { fn = compile(expr, c.schema, { decimal: c.d.decimal }); } catch (e) { status.className = 'ce-status err'; status.textContent = e.message; prev.textContent = ''; $('#ceCommit').disabled = true; return; }
  const used = deps(expr);
  status.className = nameErr ? 'ce-status err' : 'ce-status';
  status.textContent = nameErr || `✓ uses: ${used.join(', ') || '(constants)'}`;

  // preview over the first visible rows (the values the user can eyeball-check)
  const n = Math.min(6, c.baseVs.rowCount()), out = [];
  for (let r = 0; r < n; r++) { const row = await c.baseVs.ensureRow(r); out.push(row ? fn(row) : null); }
  prev.textContent = out.length ? out.map((x, r) => `${String(r + 1).padStart(2)}  ${x == null ? '·' : x}`).join('\n') : '(no rows)';
  const nn = out.filter((x) => x != null);
  const type = nn.length && nn.every((x) => typeof x === 'number') ? 'number' : 'string';

  const ok = !!name && !nameErr;
  $('#ceCommit').disabled = !ok;
  _calcDraft = { ok, name, expr, type };
}
function commitCalc() {
  const c = current; if (!c || !_calcDraft.ok) return;
  const entry = { name: _calcDraft.name, expr: _calcDraft.expr, type: _calcDraft.type };
  if (_calcEdit == null) c.calcs.push(entry); else c.calcs[_calcEdit] = entry;
  closeCalcEditor();
  applyCalcs();
}
$('#ceName').addEventListener('input', previewCalc);
$('#ceExpr').addEventListener('input', previewCalc);
$('#ceExpr').addEventListener('keydown', (e) => { if (e.key === 'Enter') commitCalc(); else if (e.key === 'Escape') closeCalcEditor(); });
$('#ceCommit').onclick = commitCalc;
$('#ceCancel').onclick = closeCalcEditor;
$('#addCalc').onclick = () => openCalcEditor(null);   // toolbar entry (header right-click is the contextual one)
$('#precomputeBtn').onclick = () => precomputeStats({ show: true });
$('#precomputeCaret').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, [
  { label: 'Precompute & show summary', action: () => precomputeStats({ show: true }) },
  { label: 'Precompute only (warm cache)', action: () => precomputeStats({ show: false }) },
]); };

// ── autocomplete (expr.complete) on the filter + calc-expr inputs ───────────────
// The value suggestions come from the gutter sample (a column's top categories),
// so picking "OXIDE" from a list is how you avoid the bare-word-vs-quoted footgun.
function columnValues(name) {
  const c = current; if (!c || !c.gutter || !c.schema) return [];
  const lc = String(name).toLowerCase();
  const i = c.schema.findIndex((s) => s.name.toLowerCase() === lc);
  return (i >= 0 && c.gutter[i] && c.gutter[i].values) || [];
}
const filterCtx = () => (current ? { columns: current.d.schema, values: columnValues } : null);
const calcCtx = () => (current ? { columns: current.schema, values: columnValues } : null);

const _ac = { input: null, res: null, sel: 0 };
function attachAutocomplete(input, getCtx) {
  input.addEventListener('input', () => acRefresh(input, getCtx));
  input.addEventListener('keydown', (e) => acKeydown(e, input), true);   // capture: beat apply-on-Enter / commit-on-Enter
  input.addEventListener('click', () => acRefresh(input, getCtx));
  input.addEventListener('blur', () => setTimeout(acClose, 120));         // delay so a popup click lands first
}
function acRefresh(input, getCtx) {
  if (_ac.suppress) return;                               // mid-accept: don't reopen (so Enter can then apply/commit)
  const ctx = getCtx(); if (!ctx) return acClose();
  const res = complete(input.value, input.selectionStart, ctx);
  if (!res.options.length) return acClose();
  _ac.input = input; _ac.res = res; _ac.sel = 0; acRender(input);
}
function acRender(input) {
  const pop = $('#acPopup'); pop.innerHTML = '';
  _ac.res.options.forEach((o, i) => {
    const row = document.createElement('div'); row.className = 'ac-item' + (i === _ac.sel ? ' sel' : '');
    const v = document.createElement('span'); v.className = 'ac-val ' + ('ac-' + o.kind); v.textContent = o.value;
    const k = document.createElement('span'); k.className = 'ac-kind'; k.textContent = o.detail || o.kind;
    row.appendChild(v); row.appendChild(k);
    row.onmousedown = (e) => { e.preventDefault(); acAccept(i); };
    pop.appendChild(row);
  });
  const r = input.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 300) + 'px';
  pop.style.top = (r.bottom + 2) + 'px';
  pop.style.minWidth = Math.min(Math.max(r.width, 180), 320) + 'px';
  pop.classList.add('show');
}
function acClose() { const p = $('#acPopup'); if (p) p.classList.remove('show'); _ac.res = null; }
function acKeydown(e, input) {
  if (!_ac.res || !$('#acPopup').classList.contains('show')) return;     // closed → let the key through (Enter applies/commits)
  const n = _ac.res.options.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); _ac.sel = (_ac.sel + 1) % n; acRender(input); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); _ac.sel = (_ac.sel - 1 + n) % n; acRender(input); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); acAccept(_ac.sel); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); acClose(); }
}
function acAccept(i) {
  const input = _ac.input, res = _ac.res; if (!res) return;
  const o = res.options[i]; if (!o) return;
  const spaceAfter = (o.kind === 'operator' || o.kind === 'keyword') && !o.value.endsWith('(');
  const ins = o.value + (spaceAfter ? ' ' : '');
  input.value = input.value.slice(0, res.from) + ins + input.value.slice(res.to);
  const caret = res.from + ins.length;
  input.focus(); input.setSelectionRange(caret, caret);
  _ac.suppress = true; input.dispatchEvent(new Event('input')); _ac.suppress = false;   // sync syncFilterClear/previewCalc, but don't reopen
  acClose();                                  // accepted → close; type a char to get the next suggestions
}
attachAutocomplete($('#filter'), filterCtx);
attachAutocomplete($('#ceExpr'), calcCtx);

$('#exRun').onclick = doExport;
$('#exCancel').onclick = closeExportDialog;
$('#exportDialog').onclick = (e) => { if (e.target.id === 'exportDialog') closeExportDialog(); };

// ── syntax highlighting: a colored layer (driven by expr.tokenize) behind the
// transparent-text input. No CM6 — monospace + single-line makes the overlay align
// by construction; we just keep it scroll-synced. ──
function renderExprHL(hl, src) {
  if (!hl) return;
  const toks = tokenize(src);
  let html = '', pos = 0;
  for (const t of toks) {
    if (t.start > pos) html += esc(src.slice(pos, t.start));   // whitespace / gaps
    html += `<span class="hl-${t.kind}">${esc(t.value)}</span>`;
    pos = t.end;
  }
  if (pos < src.length) html += esc(src.slice(pos));
  hl.innerHTML = html;
}
function syncHL(input, hl) { renderExprHL(hl, input.value); hl.scrollLeft = input.scrollLeft; }
// caret moves / horizontal scroll without a value change → keep the layer aligned
for (const [inId, hlId] of [['filter', 'filterHL'], ['ceExpr', 'ceExprHL']]) {
  const inp = $('#' + inId), hl = $('#' + hlId);
  const s = () => { hl.scrollLeft = inp.scrollLeft; };
  inp.addEventListener('scroll', s); inp.addEventListener('keyup', s); inp.addEventListener('click', s);
}

// ── smart-validate: turn a bare error into a helpful one (closest column, or
//    "quote it as text" — the footgun hint). ──
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function friendlyError(errors, cols) {
  const e = errors[0];
  if (e.kind !== 'column') return e.message;
  const names = cols.map((c) => (typeof c === 'string' ? c : c.name));
  const lb = e.name.toLowerCase();
  let near = names.find((n) => n.toLowerCase().startsWith(lb)) || names.find((n) => n.toLowerCase().includes(lb));
  if (!near) { let bd = 1e9; for (const n of names) { const d = lev(n.toLowerCase(), lb); if (d < bd) { bd = d; near = n; } } if (bd > Math.max(2, Math.ceil(lb.length / 2))) near = null; }
  return e.message + (near ? ` — did you mean ${near}?` : ` — quote it as "${e.name}" if you meant text`);
}

// Single-stream decoders that have NO browser streaming primitive (only gzip/
// deflate do via DecompressionStream) → resident-only, size-guarded.
const SINGLE_STREAM = { zst: unzstdBytes, bz2: unbz2Bytes };   // xz handled separately (WASM, not in this build)

// ── archives (spec §7a): peek inside zip / tar / gz / zst / bz2. Small
// archives decompress whole (RESIDENT — best UX). A huge zip/gz WINDOWS the entry
// through the rewindable tape (no RAM/disk); zst/bz2 have no browser streaming
// decoder so they stay resident (size-guarded). xz is WASM-only → not in this
// build (wasm-free for the strict CSP); openArchive shows a clear note. ──
async function openArchive(file, fmt) {
  $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
  if (fmt === 'xz' || fmt === 'tar.xz') {                     // WASM decoder; lamina ships wasm-free for its strict offline CSP
    return showNote(file.name, 'xz', 'xz isn’t supported in this build',
      'lamina ships WASM-free for its strict offline CSP (no \'wasm-unsafe-eval\'); xz needs a WASM decoder. Re-compress as .gz, .zst, or .zip.', `${fmtBytes(file.size)} · xz`);
  }
  const tooLarge = () => showNote(file.name, fmt, 'archive too large',
    `${fmtBytes(file.size)} — ${fmt} has no streaming decoder; resident decode is memory-bound`, `${fmtBytes(file.size)} · ${fmt}`);

  if (fmt === 'gz') {
    const innerLabel = `${file.name} › ${file.name.replace(/\.gz$/i, '')}`;
    if (file.size <= residentLimit()) {
      $('#meta').textContent = 'decompressing…';
      const inner = await gunzipBytes(new Uint8Array(await file.arrayBuffer()));
      return openDecompressed(innerLabel, inner instanceof Uint8Array ? inner : new Uint8Array(inner));
    }
    return openStreamSource(file, innerLabel, () => file.stream().pipeThrough(new DecompressionStream('gzip')), 'gz');
  }

  if (SINGLE_STREAM[fmt]) {                                   // zst / bz2 — resident only
    if (file.size > residentLimit()) return tooLarge();
    $('#meta').textContent = 'decompressing…';
    const inner = await SINGLE_STREAM[fmt](new Uint8Array(await file.arrayBuffer()));
    return openDecompressed(`${file.name} › ${file.name.replace(new RegExp('\\.' + fmt + '$', 'i'), '')}`, inner instanceof Uint8Array ? inner : new Uint8Array(inner));
  }

  if (fmt === 'tar') {                                        // resident multi-entry
    if (file.size > residentLimit()) return tooLarge();
    $('#meta').textContent = 'reading archive…';
    const bytes = new Uint8Array(await file.arrayBuffer());
    return openTar(file.name, bytes);
  }

  // zip
  if (file.size <= residentLimit()) {
    $('#meta').textContent = 'decompressing…';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = listZip(bytes).filter((e) => e.type === 'file' && !e.path.endsWith('/'));
    if (!entries.length) return showNote(file.name, 'zip', 'empty archive', 'no files inside', `${fmtBytes(file.size)} · zip`);
    const openOne = (path) => { const inner = readZip(bytes, path); inner ? openDecompressed(`${file.name} › ${path}`, inner) : showNote(file.name, 'zip', 'entry not found', path, '—'); };
    return entries.length === 1 ? openOne(entries[0].path) : showPicker(entries, openOne);
  }

  // huge zip → stream-enumerate (no full load), then window the chosen entry via the tape
  $('#meta').textContent = 'reading archive…';
  const entries = (await listZipStreaming(file)).filter((e) => !e.path.endsWith('/'));
  if (!entries.length) return showNote(file.name, 'zip', 'empty archive', 'no files inside', `${fmtBytes(file.size)} · zip`);
  const openOne = (path) => openStreamSource(file, `${file.name} › ${path}`, zipEntryStream(file, path), 'zip', path);
  return entries.length === 1 ? openOne(entries[0].path) : showPicker(entries, openOne);
}

// Resident bytes from a decompress: if they're a tar (the .tar.gz / .tar.zst
// case), list its entries; otherwise view them directly.
function openDecompressed(label, bytes) {
  if (detectFormat(bytes) === 'tar') return openTar(label, bytes);
  openInner(label, bytes);
}

function openTar(label, bytes) {
  const entries = listTar(bytes).filter((e) => e.type === 'file' && !e.path.endsWith('/'));
  if (!entries.length) return showNote(label, 'tar', 'empty archive', 'no files inside', '—');
  const openOne = (path) => { const inner = readTar(bytes, path); inner ? openInner(`${label} › ${path}`, inner) : showNote(label, 'tar', 'entry not found', path, '—'); };
  return entries.length === 1 ? openOne(entries[0].path) : showPicker(entries, openOne);
}

// Build a windowed source over a re-openable decompressed stream (the tape). Peek
// the decompressed head to detect kind, reuse a cached index when present.
async function openStreamSource(file, label, openStream, badge, entryPath) {
  $('#fileName').textContent = label; $('#empty').style.display = 'none';
  const head = await readHead(openStream, 65536);
  const d = detectKind(head, { name: label });
  if (d.kind === 'binary') return showBinary(label, head.length);        // size unknown until scanned
  const key = `${fileKey(file)}::${entryPath || badge}`;
  const cached = await idbCache.get(key);
  const opts = { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"' };
  let src;
  if (cacheFresh(cached) && cached.index) {
    lastScan = 'cache';
    src = await buildStreamSource({ openStream, index: cached.index, ...opts });
  } else {
    lastScan = 'stream';
    $('#meta').textContent = 'indexing…';
    src = await buildStreamSource({ openStream, ...opts });
    idbCache.set(key, { v: CACHE_VERSION, detect: d, index: indexOf(src) });   // best-effort sidecar
  }
  mount(label, d, src, src.totalBytes);
}

// Pull the first n bytes of a stream (for detection), then cancel.
async function readHead(openStream, n) {
  const reader = openStream().getReader();
  const parts = []; let got = 0;
  while (got < n) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
  try { reader.cancel(); } catch { /* ignore */ }
  const out = new Uint8Array(Math.min(got, n)); let w = 0;
  for (const p of parts) { const take = Math.min(p.length, n - w); out.set(p.subarray(0, take), w); w += take; if (w >= n) break; }
  return out;
}

// ── streaming zip (fflate Unzip, no full load) — enumerate + per-entry stream ──

// List entries by streaming the zip's local headers (no decompression, low memory).
function listZipStreaming(file) {
  return new Promise((resolve, reject) => {
    const uz = new Unzip(); uz.register(UnzipInflate);
    const entries = [];
    uz.onfile = (f) => { entries.push({ path: f.name, size: f.originalSize || 0 }); };  // don't start() → skip data
    (async () => {
      const reader = file.stream().getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) { uz.push(new Uint8Array(0), true); break; } uz.push(value, false); }
        resolve(entries);
      } catch (e) { reject(e); }
    })();
  });
}

// A re-openable decompressed ReadableStream for ONE zip entry (re-runs the unzip
// from the start each call = rewindable; backpressured — one chunk per pull).
function zipEntryStream(file, path) {
  return () => {
    let uz, srcReader, started = false, finished = false;
    const pending = [];
    const setup = () => {
      uz = new Unzip(); uz.register(UnzipInflate);
      uz.onfile = (f) => {
        if (f.name !== path) return;                                     // others: don't start → fflate skips their data
        f.ondata = (err, chunk, final) => { if (err) throw err; if (chunk && chunk.length) pending.push(chunk); if (final) finished = true; };
        f.start();
      };
      srcReader = file.stream().getReader();
    };
    return new ReadableStream({
      async pull(controller) {
        if (!started) { setup(); started = true; }
        while (pending.length === 0 && !finished) {
          const { done, value } = await srcReader.read();
          if (done) { uz.push(new Uint8Array(0), true); break; }
          uz.push(value, false);
        }
        if (pending.length) controller.enqueue(pending.shift());
        else controller.close();
      },
      cancel() { try { srcReader && srcReader.cancel(); } catch { /* ignore */ } },
    });
  };
}

function showPicker(entries, onPick) {
  const list = $('#pickerList');
  list.innerHTML = '';
  for (const e of entries) {
    const item = document.createElement('div');
    item.className = 'pk-item';
    item.innerHTML = `<span class="pk-name"></span><span class="pk-size">${fmtBytes(e.size || 0)}</span>`;
    item.querySelector('.pk-name').textContent = e.path;          // textContent — no markup injection
    item.onclick = () => { $('#picker').classList.remove('show'); onPick(e.path); };
    list.appendChild(item);
  }
  $('#picker').classList.add('show');
}
$('#picker').onclick = (e) => { if (e.target.id === 'picker') $('#picker').classList.remove('show'); };  // click backdrop to dismiss

// Open a File — STREAMING source (never resident; the huge-file path). Detect off
// the head slice, then stream the whole to build the block index.
async function openFile(file, force) {
  const forced = force && Object.keys(force).length > 0;              // user overrode detection → fresh, no cache

  // 0. Archive? Peek inside. Sniff the head's magic bytes (≥263 for tar's ustar
  // magic at offset 257). Forcing kind/delimiter skips the archive route.
  if (!forced) {
    const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    // A .lamina lens (small JSON with the marker)? Apply it, don't read it as data.
    if (file.size < (1 << 20)) { const t = new TextDecoder('utf-8', { fatal: false }).decode(head); if (/^\s*\{/.test(t) && t.includes('lamina-lens')) { const lens = sniffLens(new Uint8Array(await file.arrayBuffer())); if (lens) return applyLens(lens); } }
    const fmt = detectFormat(head);
    if (fmt === 'zip' || fmt === 'gz' || fmt === 'tar' || fmt === 'zst' || fmt === 'xz' || fmt === 'bz2') return openArchive(file, fmt);

    // Datamine .dm (binary table) — sniff the DD page, then window it: a record
    // cursor + browse view read only the records they touch via File.slice. No
    // resident decode at any size; filter/sort/stats run the same as CSV.
    const dmHead = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const dmFmt = detectDM(dmHead);
    if (dmFmt) {
      try {
        const h = parseHeader(dmHead, dmFmt);
        const reader = (off, len) => file.slice(off, off + len).arrayBuffer().then((b) => new Uint8Array(b));
        return mountDm(file.name, reader, h, file.size);
      } catch (e) { console.warn('[lamina] .dm parse failed, falling back', e); }
    }
  }

  // 1. Cache hit → rebuild the source from the stored index, no scan (instant).
  const key = fileKey(file);
  const cached = forced ? null : await idbCache.get(key);
  if (cacheFresh(cached)) {
    lastScan = 'cache';
    if (cached.detect.kind === 'binary') return showBinary(file.name, file.size);
    $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
    mount(file.name, cached.detect, buildSourceFromIndex(file, cached.index), file.size);
    current.file = file; current.force = {};
    return;
  }

  // 2. Miss (or forced) → detect off the head, scan (off-thread when we can), then cache.
  const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const enc = force && force.encoding;
  const d = detectKind(sample, { force, name: file.name });
  if (d.kind === 'binary') { if (!forced) idbCache.set(key, { v: CACHE_VERSION, detect: d, index: null }); return showBinary(file.name, file.size); }
  d.encoding = enc;
  $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
  const opts = { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"', encoding: enc };
  const onProgress = (r, t) => { $('#meta').textContent = `indexing… ${t ? Math.round((100 * r) / t) : 0}%`; };
  let src;
  if (canWorker) {
    $('#meta').textContent = 'indexing…';                          // worker scan has no progress callback
    try { src = await buildFileSource(file, { ...opts, scan: workerScan }); lastScan = 'worker'; }
    catch { src = await buildFileSource(file, { ...opts, onProgress }); lastScan = 'inline'; }  // worker blocked/failed → inline
  } else {
    src = await buildFileSource(file, { ...opts, onProgress }); lastScan = 'inline';            // file:// — inline only
  }
  if (!forced) idbCache.set(key, { v: CACHE_VERSION, detect: d, index: indexOf(src) });   // cache only the auto interpretation
  mount(file.name, d, src, file.size);
  current.file = file; current.force = force || {};                 // remember for re-open with new force
  current.encSuspect = encodingSuspect(sample, enc); updateEncHint();
}

// ── encoding: mojibake hint ──────────────────────────────────────────────────────
// Not auto-detection — guidance. Decoding Latin-1/Windows-1252 bytes as UTF-8 yields
// U+FFFD (�); their presence in the sample is a strong "wrong encoding" signal. Only
// flagged while on the default UTF-8 (once the user picks an encoding, no nag); clears
// naturally when the right one is chosen (Latin-1 decodes every byte).
function encodingSuspect(sampleBytes, enc) {
  if (enc && enc !== 'utf-8') return false;
  try { return /�/.test(new TextDecoder('utf-8', { fatal: false }).decode(sampleBytes.subarray(0, 65536))); } catch { return false; }
}
function updateEncHint() {
  const el = $('#encHint'); if (!el) return;
  const show = !!(current && current.encSuspect);
  el.style.display = show ? '' : 'none';
  if (show) { el.textContent = '⚠ encoding?'; el.title = "some bytes didn't decode as UTF-8 — try Western / Latin-1 (click, or Data → Interpretation)"; }
}

// ── interpretation override (delimiter / header / kind) + go-to-row ──

// Re-open the current file applying a force patch (the popover changed something).
function reopen(patch) {
  const c = current; if (!c) return;
  const force = { ...(c.force || {}), ...patch };
  Object.keys(force).forEach((k) => { if (force[k] === '' || force[k] == null) delete force[k]; });   // '' = auto
  if (c.file) openFile(c.file, force);
  else if (c.bytes) open(c.label, c.bytes, force);
}

// Human name + the literal glyph for a delimiter byte (tab/whitespace get a
// visible symbol since the real char is invisible). Matches the popover options.
function delimName(ch) {
  return ch === '\t' ? 'tab (⇥)' : ch === ' ' ? 'whitespace (␣)' : ch === ',' ? 'comma (,)'
    : ch === ';' ? 'semicolon (;)' : ch === '|' ? 'pipe (|)' : ch ? `"${ch}"` : '?';
}

// What auto-detect FOUND, as [label, value] pairs (so "auto" isn't a black box).
// Forced bits are reflected too — d carries the effective interpretation. Rendered
// as a label/value grid in the popover; joined into a one-line badge tooltip.
function detectedFacts(d) {
  if (!d) return [];
  if (d.dm) return [['format', 'Datamine .dm'], ['columns', String((d.schema || []).length)]];
  if (d.kind === 'binary') return [['format', 'binary']];
  if (d.kind === 'text') { const f = [['format', 'plain text']]; if (d.skip) f.push(['preamble', `${d.skip} line${d.skip > 1 ? 's' : ''}`]); return f; }
  const f = [];
  if (d.geoeas) f.push(['format', 'GeoEAS/GSLIB']);
  f.push(['delimiter', delimName(d.delimiter)]);
  f.push(['columns', String((d.schema || []).length)]);
  f.push(['header', d.hasHeader ? 'yes' : 'no']);
  if (d.decimal === ',') f.push(['decimal', 'comma']);
  if (d.comment) f.push(['comment', d.comment]);
  f.push(['encoding', d.encoding || 'utf-8']);
  if (d.skip) f.push(['preamble', `${d.skip} line${d.skip > 1 ? 's' : ''}`]);
  return f;
}
const _escHtml = (s) => String(s).replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]));

// Open the interpretation popover (delimiter / header / kind / skip / comment).
// Dismiss-on-outside is attached AFTER this click (setTimeout 0) so the very
// click that opens it — from the kind badge OR View → Interpretation — doesn't
// immediately close it.
function openOpts() {
  if (!current) return;
  const opts = $('#opts');
  if (opts.classList.contains('show')) return closeOpts();
  const facts = detectedFacts(current.d);
  $('#optDetected').innerHTML = facts.length
    ? '<div class="od-cap">Detected</div>' + facts.map(([k, v]) => `<div class="od-k">${k}</div><div class="od-v">${_escHtml(v)}</div>`).join('')
    : '';
  const f = current.force || {};
  $('#optKind').value = f.kind || '';
  $('#optDelim').value = f.delimiter || '';
  $('#optHeader').value = f.hasHeader === true ? 'yes' : f.hasHeader === false ? 'no' : '';
  $('#optSkip').value = f.skip != null ? f.skip : '';
  $('#optComment').value = f.comment != null ? f.comment : '';
  $('#optDecimal').value = f.decimal === ',' ? ',' : '';
  $('#optEncoding').value = f.encoding || '';
  opts.classList.add('show');
  setTimeout(() => document.addEventListener('mousedown', onOptsDown), 0);
}
function closeOpts() { $('#opts').classList.remove('show'); document.removeEventListener('mousedown', onOptsDown); }
function onOptsDown(e) { if (!$('#opts').contains(e.target) && e.target.id !== 'kindBadge') closeOpts(); }
$('#kindBadge').onclick = () => openOpts();
{ const es = $('#emptySample'); if (es) es.onclick = (e) => { e.preventDefault(); openSampleData(); }; }
$('#optKind').onchange = (e) => reopen({ kind: e.target.value });
$('#optDelim').onchange = (e) => reopen({ delimiter: e.target.value });
$('#optHeader').onchange = (e) => reopen({ hasHeader: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : '' });
$('#optSkip').onchange = (e) => reopen({ skip: e.target.value === '' ? '' : Math.max(0, e.target.value | 0) });   // '' = auto
$('#optComment').onchange = (e) => reopen({ comment: e.target.value });                                           // '' = none/auto
$('#optDecimal').onchange = (e) => reopen({ decimal: e.target.value });                                           // '' = point, ',' = comma
$('#optEncoding').onchange = (e) => reopen({ encoding: e.target.value });                                         // '' = utf-8 (auto)
$('#encHint').onclick = () => openOpts();                                                                          // footer mojibake hint → interpretation popover

// Go to a 1-based row: select it (loom scrolls the selection into view).
function gotoRow(n) {
  if (!grid || !window._laminaVS) return;
  const row = Math.max(0, Math.min(window._laminaVS.rowCount() - 1, (n | 0) - 1));
  grid.setSelection({ r0: row, c0: 0, r1: row, c1: 0 });
  grid.revealCell(row, 0);                                  // selection alone doesn't scroll — bring it into view
  grid.focus();
}
$('#goto').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value) { gotoRow(Number(e.target.value)); } });

// ── file pick ──
// Type hints for the OS dialog (lamina still opens anything — All Files stays).
const PICK_TYPES = [
  { description: 'Tables', accept: { 'text/csv': ['.csv', '.tsv', '.tab', '.txt'], 'application/octet-stream': ['.dm', '.lam', '.lamina'] } },
  { description: 'Archives', accept: { 'application/octet-stream': ['.zip', '.tar', '.gz', '.zst', '.bz2'] } },
];
// ── in-grid find (Ctrl+F) ───────────────────────────────────────────────────────
// Locate-and-jump, distinct from the filter (which subsets). Free-text substring by
// default; optional case / whole-cell / regex toggles + a selected-column scope.
// Find-next scans the active view forward/back from the selection to the next matching
// cell, jumps + highlights it (loom selection), wraps with an honest note, cancelable.
// Visible matches tint live (cellAt → style.highlight). Count-all is opt-in (a scan).
let _findOpen = false, _findActive = false, _findScopeCol = null, _findSignal = null;
let _findMatch = () => false;

function buildFindMatch() {
  const q = $('#findInput').value;
  const cs = $('#findCase').classList.contains('on'), whole = $('#findWhole').classList.contains('on'), re = $('#findRe').classList.contains('on');
  const sel = grid && grid.getSelection();
  _findScopeCol = ($('#findScope').classList.contains('on') && current && current._vis && sel) ? current._vis[sel.c0] : null;
  _findActive = _findOpen && !!q;
  $('#findInput').classList.remove('err');
  if (!q) { _findMatch = () => false; return; }
  if (re) {
    try { const r = new RegExp(q, cs ? '' : 'i'); _findMatch = (v) => r.test(v); }
    catch { _findMatch = () => false; _findActive = false; $('#findInput').classList.add('err'); }
    return;
  }
  const needle = cs ? q : q.toLowerCase();
  _findMatch = whole ? (v) => (cs ? v : v.toLowerCase()) === needle : (v) => (cs ? v : v.toLowerCase()).includes(needle);
}
function syncFind() { buildFindMatch(); if (grid) grid.refresh(); }   // re-tint visible matches (cheap repaint, keeps scroll/selection)
function openFind() { if (!current) return; _findOpen = true; $('#findBar').classList.add('show'); const i = $('#findInput'); i.focus(); i.select(); syncFind(); }
function closeFind() { _findOpen = false; _findActive = false; $('#findBar').classList.remove('show'); if (_findSignal) _findSignal.cancel = true; if (grid) { grid.refresh(); grid.focus(); } }

async function findScan(dir, countOnly) {
  const c = current; if (!c || !_findActive) return;
  const vs = c.view || window._laminaVS; const total = vs.rowCount(); if (!total) return;
  const cols = _findScopeCol != null ? [_findScopeCol] : (c._vis || []).slice();
  const status = $('#findStatus');
  if (_findSignal) _findSignal.cancel = true;
  const signal = { cancel: false }; _findSignal = signal;
  const sel = grid && grid.getSelection();
  const start = sel ? sel.r0 : (dir > 0 ? -1 : 0);
  let n = 0;
  const upto = countOnly ? total : total;
  for (let i = countOnly ? 0 : 1; countOnly ? i < total : i <= total; i++) {
    if (signal.cancel) return;
    let r = countOnly ? i : (start + dir * i) % total; if (r < 0) r += total;
    let fields = vs.rowAt(r);
    if (fields === LOADING) fields = await vs.ensureRow(r);
    if (current !== c || signal.cancel) return;
    if (!fields || fields === LOADING) continue;
    let hit = false;
    for (const uc of cols) { const raw = fields[uc]; if (raw != null && raw !== '' && _findMatch(String(raw))) { hit = true; if (!countOnly) { const dc = (c._vis || []).indexOf(uc); grid.setSelection({ r0: r, c0: dc >= 0 ? dc : 0, r1: r, c1: dc >= 0 ? dc : 0 }); grid.focus(); const wrapped = dir > 0 ? r <= start : (start >= 0 && r >= start); status.textContent = `row ${(r + 1).toLocaleString()}${wrapped ? ' · wrapped' : ''}`; return; } break; } }
    if (hit) n++;
    if (i % 8192 === 0) { status.textContent = `${countOnly ? 'counting' : 'searching'}… ${Math.round(100 * i / upto)}%`; await new Promise((res) => setTimeout(res)); }
  }
  if (signal.cancel) return;
  status.textContent = countOnly ? `${n.toLocaleString()} row${n === 1 ? '' : 's'} match` : 'no match';
}
const findNext = (dir) => findScan(dir, false);
const findCountAll = () => findScan(1, true);

$('#findInput').addEventListener('input', syncFind);
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
for (const id of ['findCase', 'findWhole', 'findRe', 'findScope']) $('#' + id).onclick = () => { $('#' + id).classList.toggle('on'); syncFind(); $('#findInput').focus(); };
$('#findNext').onclick = () => findNext(1);
$('#findPrev').onclick = () => findNext(-1);
$('#findCount').onclick = findCountAll;
$('#findClose').onclick = closeFind;

// ── recents (local · opt-in · clearable) ────────────────────────────────────────
// Remember opened files so they reopen fast. LOCAL only — stored in IndexedDB (under a
// reserved key in the index cache), never transmitted; doesn't touch the
// connect-src 'none' guarantee. An FSAA handle persists (reopening re-grants
// permission via the browser — no silent re-read); without one (drag / <input> /
// file://) we keep the name and re-pick. Transparent (shown), clearable (Clear), and
// disableable (File → Remember recent files). Declared in SECURITY.md + capability.json.
const RECENTS_KEY = '__recents__', RECENTS_MAX = 12;
let _recents = [];
let _remember = (() => { try { return localStorage.getItem('lamina.recents') !== 'off'; } catch { return true; } })();

async function refreshRecents() { try { _recents = (_remember && (await idbCache.get(RECENTS_KEY))) || []; } catch { _recents = []; } renderEmptyRecents(); }
async function addRecent(file, handle) {
  if (!_remember || !file) return;
  try {
    const key = file.name + ':' + file.size;
    const list = (await idbCache.get(RECENTS_KEY)) || [];
    _recents = [{ name: file.name, size: file.size, mtime: file.lastModified || 0, handle: handle || null }]
      .concat(list.filter((e) => e.name + ':' + e.size !== key)).slice(0, RECENTS_MAX);
    await idbCache.set(RECENTS_KEY, _recents);
    renderEmptyRecents();
  } catch { /* best-effort */ }
}
async function clearRecents() { try { await idbCache.set(RECENTS_KEY, []); } catch { /* ignore */ } _recents = []; renderEmptyRecents(); }
function setRemember(on) { _remember = on; try { localStorage.setItem('lamina.recents', on ? 'on' : 'off'); } catch { /* ignore */ } if (on) refreshRecents(); else clearRecents(); }

// Reopen a recent: with a handle → re-grant permission + getFile (instant via the
// index cache); without → re-pick (we can't, and won't, silently re-read).
async function openRecent(entry) {
  closeMenu();
  if (entry && entry.handle && entry.handle.getFile) {
    try {
      const h = entry.handle;
      if (h.queryPermission) {
        let p = await h.queryPermission({ mode: 'read' });
        if (p !== 'granted' && h.requestPermission) p = await h.requestPermission({ mode: 'read' });
        if (p !== 'granted') { $('#meta').textContent = 'permission denied — open it again'; return; }
      }
      const f = await h.getFile();
      addRecent(f, h);
      return openFile(f);
    } catch { $('#meta').textContent = `couldn't reopen “${entry.name}” — pick it again`; return pickFile(); }
  }
  $('#meta').textContent = `“${entry.name}” has no saved handle — pick it again`;
  return pickFile();
}

// Recents shown on the empty state (the prime reopen moment). Chips need
// pointer-events (the banner is otherwise click-through for drops).
function renderEmptyRecents() {
  const el = $('#emptyRecents'); if (!el) return;
  el.textContent = '';
  if (!_remember || !_recents.length) return;
  const lab = document.createElement('span'); lab.className = 'er-label'; lab.textContent = 'recent:';
  el.appendChild(lab);
  for (const e of _recents.slice(0, 8)) {
    const chip = document.createElement('a'); chip.className = 'er-chip' + (e.handle ? '' : ' nohandle');
    chip.textContent = e.name; chip.title = e.handle ? 'reopen' : 'no saved handle — re-pick';
    chip.onclick = () => openRecent(e);
    el.appendChild(chip);
  }
}

async function pickFile() {
  if (window.showOpenFilePicker) {
    try { const [h] = await window.showOpenFilePicker({ types: PICK_TYPES }); if (h) { const f = await h.getFile(); addRecent(f, h); openFile(f); } } catch { /* cancelled */ }
  } else {
    // The <input> fallback (Firefox + ALL mobile, where showOpenFilePicker doesn't
    // exist). NO `accept` filter: lamina opens anything, and on Android the OS
    // picker hides files whose extension has no registered MIME — which is exactly
    // what greys out a .dm. Showing everything is both on-brand and the .dm fix.
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = () => { if (inp.files[0]) { addRecent(inp.files[0], null); openFile(inp.files[0]); } };
    inp.click();
  }
}

// ── menubar (File / View / Help) — reuses the showMenu helper, dark-themed ──
function menuAt(btn, items) { const r = btn.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, items); }
const hasFile = () => !!current;
$('#mFile').onclick = () => {
  const items = [
    { label: 'Open…    Ctrl+O', action: pickFile },
    { label: 'New window', action: () => window.open(location.href, '_blank') },
  ];
  if (_remember && _recents.length) {
    items.push({ sep: true });
    for (const e of _recents.slice(0, 10)) items.push({ label: (e.handle ? '' : '↻ ') + e.name, action: () => openRecent(e) });
    items.push({ label: 'Clear recents', action: clearRecents });
  }
  items.push({ sep: true }, { label: (_remember ? '✓ ' : '') + 'Remember recent files', action: () => setRemember(!_remember) });
  menuAt($('#mFile'), items);
};
// Data = the file & its view; Tools = the instruments (analyses over it). Split so
// Tools can grow (compare-with, CDF, report export…) without burying the file ops.
$('#mData').onclick = () => menuAt($('#mData'), [
  { label: 'Interpretation (delimiter / header / skip)…', action: () => { if (hasFile()) openOpts(); } },
  { label: 'Export…', action: () => { if (hasFile()) openExportDialog(); } },
  { sep: true },
  { label: 'Save lens…', action: () => { if (hasFile()) saveLens(); } },
  { label: 'Apply lens…', action: applyLensFromFile },
  { sep: true },
  { label: 'Calculated columns…', action: () => { if (hasFile()) openCalcManager(); } },
  { sep: true },
  { label: 'Clear filter', action: () => { $('#filter').value = ''; syncFilterClear(); applyFilter(''); } },
  { label: 'Clear sort', action: () => { if (current) { current.sort = null; recompute(); } } },
  { sep: true },
  { label: 'Gutter brush', submenu: [
    { label: (brushMode === 'auto' ? '✓ ' : '') + 'Auto (apply if small, stage if huge)', action: () => setBrushMode('auto') },
    { label: (brushMode === 'apply' ? '✓ ' : '') + 'Apply on release', action: () => setBrushMode('apply') },
    { label: (brushMode === 'stage' ? '✓ ' : '') + 'Stage (press Enter to run)', action: () => setBrushMode('stage') },
  ] },
]);
$('#mTools').onclick = () => menuAt($('#mTools'), [
  { label: 'Column summary (Σ stats)…', action: () => { if (hasFile()) precomputeStats({ show: true }); } },
  { label: 'Group by…', action: () => { if (hasFile()) openGroupBy(); } },
  { label: 'Grade–tonnage…', action: () => { if (hasFile()) openGradeTonnage(); } },
  { label: 'Grid summary…', action: () => { if (hasFile()) openGridSummary(); } },
  { label: 'Data quality…', action: () => { if (hasFile()) showDataQuality(); } },
]);
$('#mView').onclick = () => menuAt($('#mView'), [
  { label: (showGutter ? '✓ ' : '') + 'Column distributions', action: () => { showGutter = !showGutter; refreshGutter(); } },
  { label: (autoLog ? '✓ ' : '') + 'Auto log-scale skewed columns', action: () => { autoLog = !autoLog; try { localStorage.setItem('lamina.autoLog', autoLog ? 'on' : 'off'); } catch { /* ignore */ } if (current) { current.gutterLog = null; refreshGutter(); } } },
  { label: (scrollLock ? '✓ ' : '') + 'Lock scroll to one axis', action: () => { scrollLock = !scrollLock; try { localStorage.setItem('lamina.scrollLock', scrollLock ? 'on' : 'off'); } catch { /* ignore */ } if (grid) grid.setAxisLock(scrollLock); } },
  { label: 'Theme', submenu: [
    { label: (theme === 'auto' ? '✓ ' : '') + 'Auto (system)', action: () => setTheme('auto') },
    { label: (theme === 'dark' ? '✓ ' : '') + 'Dark', action: () => setTheme('dark') },
    { label: (theme === 'light' ? '✓ ' : '') + 'Light', action: () => setTheme('light') },
  ] },
  { label: 'Columns…', action: () => toggleColPanel() },
  { label: 'Record inspector…', action: () => toggleRecordPanel() },
  { label: 'Go to row…', action: () => $('#goto').focus() },
  { sep: true },
  { label: 'Autofit all columns', action: () => autofitAll() },
  { label: 'Reset column widths', action: () => resetColWidths() },
  { label: 'Show all columns', action: () => showAllColumns() },
]);
$('#mHelp').onclick = () => menuAt($('#mHelp'), [
  { label: 'Getting started…', action: () => showHelp('start') },
  { label: 'Filter syntax…', action: () => showHelp('filter') },
  { label: 'Analysis & quality…', action: () => showHelp('analysis') },
  { label: 'Keyboard & mouse…', action: () => showHelp('keys') },
    { label: 'Manual — the full documentation ↗', action: () => window.open('https://gentropic.org/lamina/docs/', '_blank', 'noopener') },
  { sep: true },
  { label: 'About lamina', action: () => showHelp('about') },
]);

// ── help overlay ──
const HELP = {
  start: ['Getting started',
    `<b>lamina</b> opens any file — even a multi-gigabyte one — and lets you scroll, filter, and sort it. It never loads the whole file, so size isn't the problem.<br><br>`
    + `<b>Open</b> — File → Open (<code>Ctrl+O</code>) or drag a file in. CSV/TSV → table · Datamine <code>.dm</code> → table · text → lines · binary → hex · <code>.zip</code>/<code>.tar</code>/<code>.gz</code>/<code>.zst</code>/<code>.bz2</code> → peek inside. <b>No file handy?</b> — the empty screen offers <i>▸ open a sample block model</i> (120,000 rows, generated locally — nothing is downloaded).<br><br>`
    + `<b>If a file reads wrong</b> — click the <b>kind badge</b> (top-right) or <b>Data → Interpretation</b> to force the delimiter, header on/off, skip comment lines, switch the decimal point/comma, or pick the <b>character encoding</b> (UTF-8 · Windows-1252 · Latin-1 · UTF-16). A <code>⚠ encoding?</code> hint appears in the footer if bytes don't decode as UTF-8.<br><br>`
    + `<b>Column distributions</b> — each header shows a mini distribution + null-rate bar (histogram for numbers, colored top-values bar for categories; <code>≈</code> = sampled, <code>log</code> = auto log-scaled). It's interactive: <b>hover</b> for the value/category, <b>tap</b> to filter, <b>double-click</b> for full Statistics, <b>drag</b> a range to filter. Toggle under <b>View → Column distributions</b>.<br><br>`
    + `<b>Understand & check the data</b> — <b>Σ stats</b> (toolbar) summarizes every column at once; <b>Tools → Group by…</b> aggregates by domain (with weighting); <b>Tools → Grade–tonnage…</b> reports tonnes · grade · metal by domain <i>and</i> the cutoff curves; <b>Tools → Data quality…</b> flags silent problems (leading-zero codes, missing-value sentinels, junk in numeric columns). See <i>Analysis &amp; quality</i>.<br><br>`
    + `<b>Most actions live in right-click menus:</b><br>`
    + `• <b>Right-click a column header</b> — Statistics · sort · filter by · number format · treat as text/number · hide/show · autofit · <b>add a calculated column</b>.<br>`
    + `• <b>Right-click a cell or selection</b> — copy (with header / row #) · filter by this value · column statistics.<br><br>`
    + `<b>Filter</b> in the box (Enter) — e.g. <code>grade > 1 && lito == "OXIDE"</code> (see Filter syntax). <b>Sort</b> by clicking a header. <b>Jump</b> with the row # box. In a column's Statistics, click values to build a set filter.<br><br>`
    + `<b>Export</b> — <b>Data → Export…</b> writes the current view (filtered · sorted · calc columns · chosen columns) to CSV/TSV, streamed straight to a file you pick — never uploaded, never fully held in memory.<br><br>`
    + `<b>Lenses</b> — <b>Data → Save lens…</b> saves your <i>view</i> (filter · sort · calc columns · number formats · color scales · hidden columns) as a small <code>.lamina</code> file — not the data. <b>Apply lens…</b> (or open a <code>.lamina</code>) re-applies it to the current file, matching columns <b>by name</b>; anything that doesn't match is skipped and noted. Reuse one setup across every export with the same schema.<br><br>`
    + `<b>Calculated columns</b> (marked <code>ƒ</code> in the header) — add with the <b>ƒ+ col</b> button (next to the filter) or a header's right-click; see and manage them all under <b>Data → Calculated columns…</b>. A derived column from a formula in the same language as the filter (<code>grade * density</code>, <code>if(au > 1, "ore", "waste")</code>); it's computed on the fly (never written), and you can filter, sort, and stat it like any column.`],
  filter: ['Filter syntax',
    `The filter is a <b>SQL <code>WHERE</code></b>-style expression — <b>Enter</b> applies, <b>Esc</b> clears. A condition is <code>column OP value</code>, e.g. <code>grade > 1</code>.<br><br>`
    + `<b>Compare</b> <code>=</code> <code>!=</code> <code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code> · <b>combine</b> <code>and</code> <code>or</code> <code>not</code>, group with parentheses: <code>(grade >= 1 or cu > 0.3) and lito = "OXIDE"</code>.<br>`
    + `<b>Range</b> <code>grade between 1 and 5</code> · <b>set</b> <code>lito in ("OXIDE", "SULF")</code> (or click values in a column's Statistics) · <b>text</b> <code>code contains "DDH"</code>, <code>code like "DDH%"</code>, <code>code matches "^DDH"</code> · <b>blanks</b> <code>au is blank</code> / <code>au is filled</code> (and <code>is not blank</code>).<br>`
    + `<b>Functions</b> <code>round int abs sqrt log exp pow min max clamp bin if(c, a, b)</code> · casts <code>coalesce ifnum</code> · tests <code>isnum isnan</code> — e.g. <code>sqrt(au) > 0.5</code>. As a calculated column, <code>bin(grade, 0.5)</code> buckets a number to its bin's lower edge — group by it for elevation bands and the like. (For grade–tonnage there's a dedicated <b>Tools → Grade–tonnage…</b>.)<br><br>`
    + `<b>Quote text values</b> (like SQL) — a bare word is a <i>column</i> (so <code>fe &gt; cu</code> compares two columns), a quoted word is text: <code>lito = "OXIDE"</code>. Columns are case-insensitive; bracket awkward names: <code>["Cu (ppm)"] &gt; 30</code>. Blanks behave sanely — <code>blank = blank</code> is true, no SQL <code>NULL</code> trap.<br>`
    + `<span style="color:#666">(C-style <code>==</code> <code>&amp;&amp;</code> <code>~</code> also work, if that's your habit.)</span> Right-click a column header for <b>Filter by &lt;col&gt;…</b>.`],
  analysis: ['Analysis & quality',
    `<b>Column statistics</b> — click a header's glyph (double-click), or right-click → Statistics. A histogram (log-x toggle) + quantiles, count / nulls / non-numeric (with examples), min / max / mean / std / <b>CV</b> / <b>skew</b> / <b>zeros</b>. Tick <b>exclude zeros</b> / <b>exclude negatives</b> and <b>apply</b> to re-stat grade-only. Copy as TSV. Big columns scan with a cancel (or <code>Esc</code>).<br><br>`
    + `<b>Σ stats</b> (toolbar) — precomputes stats for <i>every</i> column in one pass, then opens the <b>Column summary</b>: a sortable table (a row per column × n · null% · non-num · min · max · mean · std · CV · skew · zero% · p50). Sort by <b>null%</b> / <b>CV</b> / <b>non-num</b> to triage the file; click a row for that column's detail, or its <b>name</b> to jump to it in the grid; copy as TSV. The caret (▾) offers precompute-only — warm the cache so every Statistics opens instantly.<br><br>`
    + `<b>Group by</b> (Tools → Group by…) — per-group aggregates over one or more value columns, with an optional <b>weight</b> column → a weighted mean shown next to the plain mean (so an unweighted vs length/volume-weighted grade difference is visible). Sort any column; click a group → filter the grid to it; copy as TSV. <b>Numeric bins:</b> add a calculated column <code>bin(rl, 10)</code>, then group by it — elevation bands, bench slices, etc.<br><br>`
    + `<b>Grade–tonnage</b> (Tools → Grade–tonnage…) — the resource view. <b>Volume · density · ore proportion</b> are expressions (a column, a constant, or e.g. <code>dx * dy * dz</code> — auto-detected where the columns are obvious; <b>blank = 1</b>); tonnes = Σ(volume × density × proportion). The report gives <b>tonnes · tonnage-weighted grade · contained metal per domain</b> (+ Σ total), and each grade field gets its <b>cutoff curve</b> — tonnes ≥ cutoff falling, mean grade rising — with a cutoff table at automatic round cutoffs, <b>or type your own per grade</b> (<code>0.5, 1, 2</code> — computed exactly, not snapped to bins). Respects the current filter; add more grade fields with <b>+ add grade</b>; every table copies as TSV. All computed windowed — a multi-GB model reports without loading.<br><br>`
    + `<b>Grid summary</b> (Tools → Grid summary…) — for a block model: infers the <b>grid</b> from the centroid columns (auto-detected; dx/dy/dz optional, they override spacing inference) — origin · block size · count per axis, coordinate <b>ordering</b> (fastest/slowest), <b>sub-block detection</b>, parent-cell count and <b>fill %</b>. "No regular grid" is itself an answer (scattered data, or a broken export). Copy as TSV.<br><br>`
    + `<b>Data quality</b> (Tools → Data quality…) — scans a sample and flags the quiet bugs that bite an estimate: <b>leading zeros lost</b> (a code like <code>007</code> read as a number), <b>non-numeric values</b> in a numeric column, <b>missing-value sentinels</b> (<code>-999</code>…), thousands separators, whitespace padding, all-blank, constant, dates-as-text. Click a flag → that column's Statistics, or its <b>name</b> → jump to it in the grid; a leading-zeros flag offers a one-click <b>fix: treat as text</b>. <code>✓</code> when clean.<br><br>`
    + `<b>Color scale</b> — right-click a numeric header → Color scale: heatmap the cells (8 palettes · linear/log · clip outliers · reverse). <b>Record inspector</b> (View) — a row's fields as a list, follows the selection; <code>↑</code>/<code>↓</code> step, <b>pin</b> to compare two rows. <b>Columns</b> panel (View) — search · show/hide · reorder · pin-freeze.`],
  keys: ['Keyboard & mouse',
    `<b>Ctrl+O</b> — open a file<br><b>Ctrl+F</b> — find in the table (locate & jump; <code>Aa</code> case · <code>⊏⊐</code> whole-cell · <code>.*</code> regex · <code>col</code> scope · <code>#</code> count) — <b>Enter</b>/<b>Shift+Enter</b> next/prev, <b>Esc</b> closes<br><b>Enter</b> / <b>Esc</b> in the filter box — apply / clear<br>`
    + `<b>Click a column header</b> — sort (cycles ascending → descending → off)<br>`
    + `<b>Right-click a column header</b> — statistics · sort · filter by · number format · treat as text/number · hide / show<br>`
    + `<b>Click the kind badge</b> (top right) — change how the file is read (delimiter, header, skip rows, comment)<br>`
    + `<b>Drag a column border</b> — resize · <b>double-click a border</b> — autofit that column · <b>View → Autofit all columns</b><br>`
    + `<b>Distribution glyph</b> — hover = value/category · click = filter · double-click = Statistics · drag = filter a range<br>`
    + `<b>Dock panels</b> (View → Columns / Record inspector) — drag the left edge to resize; in the record inspector <code>↑</code>/<code>↓</code> step rows and <code>⊙</code> pins one to compare side by side<br>`
    + `<b>Scroll</b> locks to one axis per gesture (helps 2D trackballs); turn off via View → Lock scroll to one axis<br>`
    + `<b>row # box</b> — jump to a row<br>Selected cells <b>copy</b> as TSV (Ctrl+C).`],
  about: ['About lamina',
    `<b>lamina</b> — open any file, however large, and scroll, filter, sort, derive, summarize, and quality-check it. Windowed, read-only, offline.<br><br>`
    + `Delimited → grid, text → lines, binary → hex. Opens <b>Datamine .dm</b> tables directly — at any size, decoded on the fly (no conversion), with the same filter / sort / stats as CSV. Reads inside zip / tar / gz / zst / bz2, and windows huge compressed entries without unpacking. Detects GSLIB / Geo-EAS + whitespace dumps and skips <code>#</code> comment preambles. <b>Grade–tonnage</b> (by domain + cutoff curves) runs windowed on any size.<br><br>`
    + `Part of the Geoscientific Chaos Union — <code>gentropic.org</code>.<br><br>`
    + `<span style="color:var(--dim)">MIT. Bundles <code>fflate · fzstd · seek-bzip</code> (all MIT) for reading archives — full notices in this file's source.</span><br>`
    + `<span style="color:var(--dim)">build <code>${__LAMINA_BUILD__}</code></span>`],
};
function showOverlay(title, html) {
  $('#helpTitle').textContent = title;
  $('#helpBody').innerHTML = html;
  $('.help-box').classList.remove('wide');               // only the column summary is wide
  $('#help').classList.add('show');
}
function showHelp(topic) { const [title, body] = HELP[topic] || HELP.about; showOverlay(title, body); }
$('#helpClose').onclick = () => $('#help').classList.remove('show');
$('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').classList.remove('show'); };
// Click categorical top-values in the stats panel to build a set filter — toggles
// each value (panel stays open), applying `col in a, b, …` live. Close to see the
// grid. (A single value is just `col in v`; deselect all clears the filter.)
$('#helpBody').addEventListener('click', (e) => {
  const sf = e.target.closest('.sfilter');
  if (!sf || _statsCol == null) return;
  const v = sf.dataset.v;
  if (_statsSelected.has(v)) { _statsSelected.delete(v); sf.classList.remove('sel'); }
  else { _statsSelected.add(v); sf.classList.add('sel'); }
  applyStatFilter();
});
function applyStatFilter() {
  if (!current || _statsCol == null) return;
  const name = current.baseVs.header(_statsCol).label;
  if (_statsSelected.size === 0) { $('#filter').value = ''; syncFilterClear(); return applyFilter(''); }
  const expr = `${colRef(name)} in ${[...(_statsSelected)].map((v) => JSON.stringify(v)).join(', ')}`;
  $('#filter').value = expr; syncFilterClear(); applyFilter(expr);
}

// ── column distribution gutter (the header glyphs) ──────────────────────────
// A per-column distribution mark drawn in loom's header gutter: a mini-histogram
// (numeric) or a top-N segmented bar (categorical) + a null-rate bar. v1 is an
// APPROXIMATE glyph from the first GUTTER_SAMPLE records (one quick scan, all
// columns, marked ≈); click a gutter → the full exact stats popover.
const GUTTER_H = 26, GUTTER_SAMPLE = 8192, GUTTER_BINS = 22;
let showGutter = true;
let autoLog = (() => { try { return localStorage.getItem('lamina.autoLog') !== 'off'; } catch { return true; } })();   // auto-swap skewed positive columns to a log gutter
let scrollLock = (() => { try { return localStorage.getItem('lamina.scrollLock') !== 'off'; } catch { return true; } })();   // lock wheel scroll to one axis (helps 2D trackball drag-scroll)

// ── gutter brush → filter ──────────────────────────────────────────────────────
// Drag a range on a numeric column's histogram → a `col between A and B` filter.
// Conservative by design: nothing filters during the drag (loom shows a preview
// band, emits once on release); a tap (< threshold) opens stats instead; Esc
// cancels. On release we either apply or STAGE (fill the box, press Enter) — auto
// by row count, since a filter on a huge file is a full scan.
const BRUSH_AUTO_ROWS = 2_000_000;
let brushMode = (() => { try { return localStorage.getItem('lamina.brushMode') || 'auto'; } catch { return 'auto'; } })();   // 'auto' | 'apply' | 'stage'
function setBrushMode(m) { brushMode = m; try { localStorage.setItem('lamina.brushMode', m); } catch { /* ignore */ } }
const roundSig = (x) => (x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(4)));

function brushFilter(uc, lo, hi) {
  const c = current; if (!c) return;
  const g = c.gutter && c.gutter[uc];
  if (!g || g.kind !== 'hist' || g.min == null || g.max == null || !(g.max > g.min)) return showColumnStats(uc);   // categorical / flat → stats, not a range
  let a, b;
  if (g.log && g.logMin != null) {                    // log gutter → map the drag fraction through log space so the range matches the glyph
    const l0 = Math.log(g.logMin), ls = (Math.log(g.max) - l0) || 1;
    a = roundSig(Math.exp(l0 + lo * ls)); b = roundSig(Math.exp(l0 + hi * ls));
  } else {
    const span = g.max - g.min;
    a = roundSig(g.min + lo * span); b = roundSig(g.min + hi * span);
  }
  const name = c.baseVs.header(uc).label;
  const expr = `${colRef(name)} between ${a} and ${b}`;
  $('#filter').value = expr; syncFilterClear();
  const apply = brushMode === 'apply' || (brushMode === 'auto' && c.baseVs.rowCount() < BRUSH_AUTO_ROWS);
  if (apply) return applyFilter(expr);
  $('#filter').focus(); $('#meta').textContent = 'filter staged — press Enter to apply';   // big file → don't auto-scan
}

// A small floating tooltip near the cursor (shared by the brush-drag range readout
// and the gutter hover value/category readout).
let _tipEl = null;
function tipAt(text, x, y) {
  if (!_tipEl) { _tipEl = document.createElement('div'); _tipEl.className = 'brush-tip'; document.body.appendChild(_tipEl); }
  _tipEl.textContent = text;
  _tipEl.style.display = 'block';
  const w = _tipEl.offsetWidth || 90;
  let lx = x + 12; if (lx + w > window.innerWidth - 4) lx = x - w - 12;   // flip left near the right edge
  _tipEl.style.left = lx + 'px';
  _tipEl.style.top = (y + 14) + 'px';
}
function hideTip() { if (_tipEl) _tipEl.style.display = 'none'; }

function brushRange(g, lo, hi) {   // a fraction range → a value range (log-aware)
  if (g.log && g.logMin != null) { const l0 = Math.log(g.logMin), ls = (Math.log(g.max) - l0) || 1; return [Math.exp(l0 + lo * ls), Math.exp(l0 + hi * ls)]; }
  const span = g.max - g.min; return [g.min + lo * span, g.min + hi * span];
}
// Categorical glyph: segments are drawn proportional to sum(segments) (fills the
// width). Map a click/range fraction back to segment index/indices the same way.
function catSegAt(g, frac) {
  const total = g.segments.reduce((s, v) => s + v, 0) || 1;
  let cum = 0;
  for (let i = 0; i < g.segments.length; i++) { cum += g.segments[i] / total; if (frac <= cum) return i; }
  return g.segments.length - 1;
}
function catSegsInRange(g, lo, hi) {
  const total = g.segments.reduce((s, v) => s + v, 0) || 1;
  const out = []; let cum = 0;
  for (let i = 0; i < g.segments.length; i++) { const a = cum, b = cum + g.segments[i] / total; cum = b; if (b > lo && a < hi) out.push(i); }
  return out;
}

// Live range readout while DRAGGING a gutter brush. lo == null → hide.
function showBrushTip(uc, lo, hi, x, y) {
  if (lo == null) { hideTip(); return; }
  const c = current; if (!c) return;
  const g = c.gutter && c.gutter[uc]; if (!g) return;
  if (g.kind === 'cat') { const vals = catSegsInRange(g, lo, hi).map((i) => g.values[i]).filter((v) => v != null); if (vals.length) tipAt(vals.join(', '), x, y); return; }
  if (g.kind !== 'hist' || g.min == null || !(g.max > g.min)) return;
  const [a, b] = brushRange(g, lo, hi);
  tipAt(`${roundSig(a)} – ${roundSig(b)}`, x, y);
}

// Hover readout (no drag): the value (hist) or category · share (cat) under the cursor.
function showGutterTip(uc, frac, x, y) {
  if (uc == null) { hideTip(); return; }
  const c = current; if (!c) { hideTip(); return; }
  const g = c.gutter && c.gutter[uc]; if (!g) { hideTip(); return; }
  if (g.kind === 'cat') {
    const i = catSegAt(g, frac); if (i < 0 || g.values[i] == null) { hideTip(); return; }
    const pct = g.segments[i] * 100;                    // segments are already share-of-sample fractions
    tipAt(`${g.values[i]} · ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`, x, y);
  } else if (g.kind === 'hist' && g.min != null && g.max > g.min) {
    tipAt(`≈ ${roundSig(brushRange(g, frac, frac)[0])}`, x, y);
  } else hideTip();
}

// Gutter tap → FILTER (hist: the bin under the cursor as a narrow `between`; cat:
// the category). Debounced ~220ms so a DOUBLE-click (→ Statistics) can cancel it —
// the browser fires a click before every dblclick.
let _gutterTapTimer = null;
function gutterClick(uc, frac) {
  clearTimeout(_gutterTapTimer);
  _gutterTapTimer = setTimeout(() => { _gutterTapTimer = null; gutterTapFilter(uc, frac); }, 220);
}
function gutterDblClick(uc) {
  clearTimeout(_gutterTapTimer); _gutterTapTimer = null;   // cancel the pending tap-filter
  hideTip(); showColumnStats(uc);
}
function gutterTapFilter(uc, frac) {
  const c = current; if (!c) return;
  const g = c.gutter && c.gutter[uc];
  if (!g) return showColumnStats(uc);
  hideTip();
  if (g.kind === 'cat') { const i = catSegAt(g, frac); if (i >= 0 && g.values[i] != null) return filterByValue(uc, String(g.values[i])); return; }
  if (g.kind === 'hist' && g.min != null && g.max > g.min) {   // filter to the hovered bin's value range
    const nb = (g.bins && g.bins.length) || 1, k = Math.min(nb - 1, Math.max(0, Math.floor(frac * nb)));
    return brushFilter(uc, k / nb, (k + 1) / nb);
  }
  showColumnStats(uc);
}
// Gutter drag: hist → `between`; cat → `in (…)` over the covered segments.
function gutterBrush(uc, lo, hi) {
  const c = current; if (!c) return;
  const g = c.gutter && c.gutter[uc];
  if (g && g.kind === 'cat') {
    hideTip();
    const vals = catSegsInRange(g, lo, hi).map((i) => g.values[i]).filter((v) => v != null);
    if (!vals.length) return showColumnStats(uc);
    if (vals.length === 1) return filterByValue(uc, String(vals[0]));
    const name = c.baseVs.header(uc).label;
    const expr = `${colRef(name)} in (${vals.map((v) => JSON.stringify(String(v))).join(', ')})`;
    $('#filter').value = expr; syncFilterClear(); return applyFilter(expr);
  }
  return brushFilter(uc, lo, hi);
}

// Filter-reactive overlay: the distribution of the current filter's matches,
// binned on the GLOBAL min/max so it aligns, drawn solid over the faint global.
// Numeric (hist) only; stride-sampled across the matches so it stays cheap.
async function refreshGutterFiltered() {
  const c = current; if (!c) return;
  if (!showGutter || c.d.kind !== 'delimited' || !c.gutter || !c.filterResult || !c.filterResult.nums.length) {
    if (c.gutterFiltered) { c.gutterFiltered = null; rerender(); }
    return;
  }
  try {
    const g = await computeGutterFiltered(c.source, c.schema, c.dataStart, c.d.decimal, c.gutter, c.filterResult.nums);
    if (current !== c) return;
    c.gutterFiltered = g; rerender();
  } catch (e) { console.warn('[lamina] filtered gutter failed', e); }
}
async function computeGutterFiltered(source, schema, dataStart, decimal, global, matchRows) {
  const stride = Math.max(1, Math.ceil(matchRows.length / GUTTER_SAMPLE));   // even sample across the matches
  const sub = []; for (let i = 0; i < matchRows.length; i += stride) sub.push(matchRows[i]);
  const cols = schema.length;
  const acc = schema.map((s, i) => {
    const gi = global[i];
    if (!(s.type === 'number' && gi && gi.kind === 'hist' && gi.min != null && gi.max > gi.min)) return null;
    if (gi.log && gi.logMin != null) { const l0 = Math.log(gi.logMin); return { log: true, l0, ls: (Math.log(gi.max) - l0) || 1, bins: new Array(GUTTER_BINS).fill(0), any: false }; }
    return { lo: gi.min, span: gi.max - gi.min, bins: new Array(GUTTER_BINS).fill(0), any: false };
  });
  await source.eachRecord({ dataStart, rows: sub }, (disp, fields) => {
    for (let i = 0; i < cols; i++) {
      const a = acc[i]; if (!a) continue;
      const raw = fields[i]; if (raw == null || raw === '') continue;
      const x = parseNum(raw, decimal); if (Number.isNaN(x)) continue;
      let k;
      if (a.log) { if (x <= 0) continue; k = Math.floor((Math.log(x) - a.l0) / a.ls * GUTTER_BINS); }   // align with the log-binned global glyph
      else k = Math.floor((x - a.lo) / a.span * GUTTER_BINS);
      if (k >= GUTTER_BINS) k = GUTTER_BINS - 1; if (k < 0) k = 0;
      a.bins[k]++; a.any = true;
    }
  });
  return acc.map((a) => (a && a.any ? { kind: 'hist', bins: (() => { const mx = Math.max(...a.bins) || 1; return a.bins.map((x) => x / mx); })() } : null));
}

async function refreshGutter() {
  const c = current; if (!c) return;
  c.gutterFiltered = null;                              // global changed → drop any stale filtered overlay
  if (!showGutter || c.d.kind !== 'delimited') { c.gutter = null; return rerender(); }
  // Footer feedback only if the sample scan actually drags (huge file) — a 150ms
  // debounce, so a small file never flashes the message (and footer-reading tests stay clean).
  const slow = setTimeout(() => { if (current === c) $('#meta').textContent = 'profiling columns…'; }, 150);
  try {
    const g = await computeGutterStats(c.source, c.schema, c.dataStart, c.d.decimal);
    if (current !== c) return;                       // a newer file opened mid-scan
    applyGutterLogPrefs(c, g);
    c.gutter = g;
  } catch (e) { console.warn('[lamina] gutter stats failed', e); c.gutter = null; }
  finally { clearTimeout(slow); }
  rerender();                                        // repaints with the bars + restores the footer meta (c._meta)
}

// Resolve each hist column's active log state: a per-column override (c.gutterLog)
// wins; else the global autoLog gate × the detector's vote. Sets g.bins/g.log.
function applyGutterLogPrefs(c, g) {
  for (let uc = 0; uc < g.length; uc++) {
    const col = g[uc]; if (!col || col.kind !== 'hist' || !col.logBins) continue;
    const ov = c.gutterLog && c.gutterLog[uc];
    const on = ov === undefined ? (autoLog && col.logSuggested) : ov;
    col.log = on; col.bins = on ? col.logBins : col.linBins;
  }
}
// Toggle log binning on one column's gutter glyph (context-menu action). Persists
// as a per-column override so a gutter refresh keeps the choice.
function setGutterLog(uc, on) {
  const c = current; if (!c || !c.gutter) return;
  const col = c.gutter[uc]; if (!col || col.kind !== 'hist' || !col.logBins) return;
  (c.gutterLog || (c.gutterLog = {}))[uc] = on;
  col.log = on; col.bins = on ? col.logBins : col.linBins;
  rerender();
  if (c.filterResult) refreshGutterFiltered();        // re-bin the filtered overlay in the new space
}

// One bounded scan → per-column { kind:'hist', bins:[0..1], nullRate, approx } |
// { kind:'cat', segments:[fractions], nullRate, approx } | null.
// Spread the gutter sweep across the WHOLE file (a few clustered runs from blocks
// evenly spaced through it), not the first N rows — otherwise a spatially-ordered
// model (block models, drillholes) makes the sweep land in one flat corner (all-zero
// grades, near-constant coords) and every glyph reads empty. The block-skip in
// eachRecord means this still reads only ~GUTTER_SPREAD blocks (cheap, never-resident).
const GUTTER_SPREAD = 48;
function gutterSampleRows(source, dataStart) {
  const N = Math.max(0, (source.rowCount || 0) - dataStart);
  if (N <= GUTTER_SAMPLE) return null;                   // small file → just sample all (limit)
  const per = Math.ceil(GUTTER_SAMPLE / GUTTER_SPREAD), rows = [];
  for (let i = 0; i < GUTTER_SPREAD; i++) {
    const start = Math.floor((i * N) / GUTTER_SPREAD);
    for (let j = 0; j < per && start + j < N; j++) rows.push(start + j);   // a short contiguous run per spread point (1-2 blocks each)
  }
  return rows;                                            // ascending
}
// Bin a value array into GUTTER_BINS normalized [0..1] heights — linear over
// [lo, lo+span], or log over [lo(>0), lo+span] when `log` (skips v≤0).
function binVals(vals, lo, span, log) {
  const bins = new Array(GUTTER_BINS).fill(0);
  const l0 = log ? Math.log(lo) : lo, s = (log ? Math.log(lo + span) : lo + span) - l0 || 1;
  for (const v of vals) {
    if (log && v <= 0) continue;
    let k = Math.floor(((log ? Math.log(v) : v) - l0) / s * GUTTER_BINS);
    if (k >= GUTTER_BINS) k = GUTTER_BINS - 1; if (k < 0) k = 0; bins[k]++;
  }
  const mx = Math.max(...bins) || 1;
  return bins.map((x) => x / mx);
}
// Fisher–Pearson sample skewness — the log-normal detector's signal.
function skewness(vals) {
  const n = vals.length; if (n < 3) return 0;
  let m = 0; for (const v of vals) m += v; m /= n;
  let s2 = 0, s3 = 0; for (const v of vals) { const d = v - m; s2 += d * d; s3 += d * d * d; }
  const sd = Math.sqrt(s2 / n); if (sd === 0) return 0;
  return (s3 / n) / (sd * sd * sd);
}
async function computeGutterStats(source, schema, dataStart, decimal) {
  const cols = schema.length;
  const acc = schema.map((s) => (s.type === 'number'
    ? { num: true, vals: [], n: 0, nulls: 0, min: Infinity, max: -Infinity }
    : { num: false, n: 0, nulls: 0, freq: new Map() }));
  const rows = gutterSampleRows(source, dataStart);
  await source.eachRecord(rows ? { dataStart, rows } : { dataStart, limit: GUTTER_SAMPLE }, (disp, fields) => {
    for (let i = 0; i < cols; i++) {
      const a = acc[i]; if (!a) continue; a.n++;
      const raw = fields[i];
      if (a.num) {
        if (raw == null || raw === '') { a.nulls++; continue; }
        const x = parseNum(raw, decimal);
        if (Number.isNaN(x)) { a.nulls++; continue; }
        a.vals.push(x); if (x < a.min) a.min = x; if (x > a.max) a.max = x;
      } else {
        if (raw == null || raw === '') { a.nulls++; continue; }
        if (a.freq.has(raw)) a.freq.set(raw, a.freq.get(raw) + 1);
        else if (a.freq.size < 200) a.freq.set(raw, 1);                 // cap distinct (bounded memory)
      }
    }
  });
  return acc.map((a) => {
    if (!a || !a.n) return null;
    const nullRate = a.nulls / a.n;
    if (a.num) {
      if (!a.vals.length || !(a.max > a.min)) return { kind: 'hist', bins: [], nullRate, approx: true, min: a.vals.length ? a.min : null, max: a.vals.length ? a.max : null };
      const linBins = binVals(a.vals, a.min, a.max - a.min, false);
      // Detect an obvious log-normal column (skewed, mostly-positive — grades,
      // assays) and pre-render the glyph in log space. logSuggested drives the
      // auto-swap; logBins/logMin carry the alt rendering + the brush mapping. A
      // per-column override (c.gutterLog) can force it on/off in refreshGutter.
      const pos = a.vals.filter((v) => v > 0), neg = a.vals.filter((v) => v < 0).length;
      let logSuggested = false, logMin = null, logBins = null;
      // Magnitude data (grades/assays): ZEROS are fine (waste/unestimated blocks — a
      // grade column is mostly zero), only real NEGATIVES disqualify log. Skewness is
      // measured on the positive subset (the actual grade tail), zeros set aside.
      if (pos.length >= 12 && neg <= a.vals.length * 0.02) {
        const pmin = Math.min(...pos);
        if (a.max > pmin) {
          const rawSkew = skewness(pos), logSkew = skewness(pos.map(Math.log));
          if (rawSkew > 1.5 && Math.abs(logSkew) < Math.abs(rawSkew) - 0.5) {   // log transform is much more symmetric → it's log-ish
            logSuggested = true; logMin = pmin; logBins = binVals(a.vals, pmin, a.max, true);
          }
        }
      }
      return { kind: 'hist', bins: logSuggested ? logBins : linBins, linBins, logBins, log: logSuggested, logSuggested, logMin, nullRate, approx: true, min: a.min, max: a.max };   // min/max(/logMin) → the brush maps a drag fraction to a value range
    }
    const tot = [...a.freq.values()].reduce((s, v) => s + v, 0) || 1;
    const top = [...a.freq.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8);
    return { kind: 'cat', segments: top.map(([, nn]) => nn / tot), values: top.map(([v]) => v), colors: top.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]), nullRate, approx: true };
  });
}

// ── column statistics (respects the current filter) ──
const fmtN = (x) => x == null ? '—' : (Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-4) ? x.toExponential(4) : (Number.isInteger(x) ? x.toLocaleString() : x.toPrecision(6).replace(/\.?0+$/, '')));
const fmtInt = (x) => x == null ? '—' : Math.round(x).toLocaleString();   // big totals (tonnes / metal / counts) — whole, thousands-separated
const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

// Draw the column-profile histogram onto a canvas: bars + a quantile overlay
// (p25–p75 band, median line, p5/p95 ticks). Theme-aware (reads CSS vars).
function drawProfileHist(canvas, hist, q) {
  const W = canvas.clientWidth || 380, H = canvas.clientHeight || 120, dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const cv = getComputedStyle(document.documentElement);
  const bar = cv.getPropertyValue('--ok').trim() || '#8cb878', acc = cv.getPropertyValue('--accent').trim() || '#c89b3c', band = cv.getPropertyValue('--accent-soft').trim() || 'rgba(200,155,60,0.18)';
  const bins = hist.bins, n = bins.length, mx = Math.max(...bins) || 1, bw = W / n, mt = 3, plotH = H - mt - 1;
  const lo = hist.log ? Math.log(hist.min) : hist.min, span = ((hist.log ? Math.log(hist.max) : hist.max) - lo) || 1;
  const xOf = (v) => { if (hist.log && v <= 0) return 0; return Math.max(0, Math.min(1, ((hist.log ? Math.log(v) : v) - lo) / span)) * W; };
  if (q) { ctx.fillStyle = band; ctx.fillRect(xOf(q.p25), 0, Math.max(xOf(q.p75) - xOf(q.p25), 1), H); }   // IQR band
  ctx.fillStyle = bar;
  for (let i = 0; i < n; i++) { const bh = (bins[i] / mx) * plotH; if (bh > 0) ctx.fillRect(i * bw, mt + (plotH - bh), Math.max(bw - 1, 0.5), bh); }
  if (q) {
    ctx.strokeStyle = acc; ctx.lineWidth = 1;
    const line = (x) => { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke(); };
    line(xOf(q.p50));                                            // median
    ctx.globalAlpha = 0.4; line(xOf(q.p5)); line(xOf(q.p95)); ctx.globalAlpha = 1;   // whiskers
  }
}

// Clean TSV of a column summary → clipboard (paste into a report). Raw values (full
// precision) so Excel reads them as numbers, not the display-formatted strings.
function statsToTSV(st, name) {
  const L = [], r = (k, v) => L.push(k + '\t' + v);
  r('column', name);
  if (st.kind === 'number') {
    r('count', st.count); r('non-null', st.n); r('nulls', st.nulls);
    if (st.excluded) r('excluded', st.excluded + (st.excludeZero && st.excludeNeg ? ' (≤0)' : st.excludeZero ? ' (zeros)' : ' (negatives)'));
    if (st.bad) r('non-numeric', st.bad);
    r('min', st.min); r('max', st.max); r('mean', st.mean); r('std', st.std); r('sum', st.sum);
    if (st.cv != null) r('CV', st.cv);
    if (st.skew != null) r('skew', st.skew);
    if (st.zeros) r('zeros', `${st.zeros} (${(100 * st.zeros / st.n).toFixed(1)}%)`);
    if (st.quantiles) { const q = st.quantiles; r('p5', q.p5); r('p25', q.p25); r('median', q.p50); r('p75', q.p75); r('p95', q.p95); }
  } else {
    r('count', st.count); r('nulls', st.nulls); r('distinct', st.distinct + (st.cappedDistinct ? '+' : ''));
    L.push(''); L.push('value\tcount\tpct');
    for (const t of st.top) L.push(`${t.value}\t${t.n}\t${st.count ? (100 * t.n / st.count).toFixed(1) : '0'}`);
  }
  return L.join('\n');
}

function renderStats(st, ex = {}) {
  const row = (k, v) => `<tr><td style="color:var(--muted);padding-right:18px">${k}</td><td style="text-align:right">${v}</td></tr>`;
  const btnStyle = 'float:right;font:inherit;font-size:11px;color:var(--muted);background:var(--bg-field);border:1px solid var(--bd2);border-radius:4px;padding:2px 8px;cursor:pointer';
  const copyBtn = `<button id="statsCopy" title="copy this summary (TSV)" style="${btnStyle}">copy</button>`
    + (st.kind === 'number' && st.histogram ? `<button id="statsPng" title="save the histogram as PNG" style="${btnStyle};margin-right:6px">png</button>` : '');
  if (st.kind === 'number') {
    let h = `<div class="stats-opts"><label><input type="checkbox" id="optNoZero"${ex.excludeZero ? ' checked' : ''}> exclude zeros</label><label><input type="checkbox" id="optNoNeg"${ex.excludeNeg ? ' checked' : ''}> exclude negatives</label><button id="optApply" class="stats-apply" disabled>apply</button></div>`;
    if (st.histogram) {                                         // the column-profile chart
      h += `<div class="prof-wrap"><canvas id="profHist" class="prof-hist"></canvas>`;
      if (st.logHistogram) h += `<button id="profLog" class="prof-log" title="log scale (for skewed / log-normal data)">log x</button>`;
      h += `</div>`;
      if (st.quantilesCapped) h += `<div style="color:var(--dim);font-size:11px;margin:-6px 0 8px">≈ from a sample (too many values for exact)</div>`;
    }
    h += '<table style="border-collapse:collapse">';
    h += row('count', st.count.toLocaleString()) + row('non-null', st.n.toLocaleString()) + row('nulls', st.nulls.toLocaleString());
    if (st.excluded) {
      const lbl = st.excludeZero && st.excludeNeg ? '≤ 0' : st.excludeZero ? 'zeros' : 'negatives';
      h += row('<span style="color:var(--dim)">excluded</span>', `<span style="color:var(--dim)">${st.excluded.toLocaleString()} <span style="font-size:10px">(${lbl})</span></span>`);
    }
    if (st.bad) {
      h += row('<span style="color:var(--accent)">non-numeric</span>', `<span style="color:var(--accent)">${st.bad.toLocaleString()}</span>`);
      if (st.badSamples && st.badSamples.length) {        // show what's actually not-a-number (the diagnostic)
        const ex = st.badSamples.map((v) => `<code style="color:var(--accent)">${esc(v === '' ? '∅' : v)}</code>`).join(' ');
        h += `<tr><td colspan="2" style="color:var(--dim);padding:2px 0 6px;font-size:11px">e.g. ${ex}</td></tr>`;
      }
    }
    h += row('min', fmtN(st.min)) + row('max', fmtN(st.max)) + row('mean', fmtN(st.mean)) + row('std', fmtN(st.std)) + row('sum', fmtN(st.sum));
    if (st.cv != null) h += row('CV', fmtN(st.cv));
    if (st.skew != null) h += row('skew', fmtN(st.skew));
    if (st.zeros) h += row('zeros', `${st.zeros.toLocaleString()} <span style="color:var(--dim);font-size:10px">(${(100 * st.zeros / st.n).toFixed(st.zeros * 100 / st.n < 1 ? 1 : 0)}%)</span>`);
    if (st.quantiles) {
      const lab = (k) => st.quantilesApprox ? `${k} <span style="color:var(--dim)">≈</span>` : k;
      const q = st.quantiles;
      h += row(lab('p5'), fmtN(q.p5)) + row(lab('p25'), fmtN(q.p25)) + row(st.quantilesApprox ? '<b>median ≈</b>' : '<b>median</b>', `<b>${fmtN(q.p50)}</b>`) + row(lab('p75'), fmtN(q.p75)) + row(lab('p95'), fmtN(q.p95));
    } else if (st.quantilesCapped) h += row('quantiles', '<span style="color:var(--dim)">too many values</span>');
    if (st.precomputed) h += `<tr><td colspan="2" style="color:var(--dim);font-size:11px;padding-top:6px">≈ quantiles from precompute · <button id="statsExact" style="font:inherit;font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">compute exact</button></td></tr>`;
    return copyBtn + h + "</table>";
  }
  let h = '<table style="border-collapse:collapse">';
  h += row('count', st.count.toLocaleString()) + row('nulls', st.nulls.toLocaleString()) + row('distinct', st.distinct.toLocaleString() + (st.cappedDistinct ? '+' : ''));
  h += '</table><div style="margin-top:12px;color:var(--muted)">top values <span style="color:var(--dim)">(click to toggle a filter set)</span></div><table style="border-collapse:collapse;margin-top:4px;width:100%">';
  for (const t of st.top) {
    const pct = st.count ? (100 * t.n / st.count).toFixed(1) : '0';
    const v = esc(t.value).replace(/"/g, '&quot;');
    h += `<tr><td style="padding:1px 18px 1px 0;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:linear-gradient(90deg, var(--accent-soft) ${pct}%, transparent ${pct}%)"><span class="sfilter" data-v="${v}">${esc(t.value)}</span></td><td style="text-align:right;color:var(--text)">${t.n.toLocaleString()} <span style="color:var(--dim)">(${pct}%)</span></td></tr>`;
  }
  return copyBtn + h + "</table>";
}

let _statsCol = null;          // the column the open stats panel describes (for click-to-filter)
const _statsSelected = new Set();   // categorical values toggled in the panel → an `in` filter
let _statsAbort = null;        // AbortController for the in-progress stats scan (popup cancel)
let _footerScanAbort = null;   // AbortController for the in-progress sort/filter scan (Esc cancel)
function newFooterScan() { if (_footerScanAbort) _footerScanAbort.abort(); _footerScanAbort = new AbortController(); return _footerScanAbort; }
// Esc aborts whatever heavy scan is running (stats popup / sort / filter).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (_statsAbort) _statsAbort.abort();
  if (_footerScanAbort) _footerScanAbort.abort();
}, true);
async function showColumnStats(uc) {
  const c = current; if (!c) return;
  _statsCol = uc; _statsSelected.clear();
  const name = c.baseVs.header(uc).label;
  const numeric = (c.schema[uc] && c.schema[uc].type) === 'number';
  const suffix = c.filterResult ? ' (filtered)' : '';
  const ex = { excludeZero: false, excludeNeg: false };       // re-scan filters; toggled via the in-popup chips
  // Wire the popup's live bits (chart, log toggle, exclude chips, copy, exact). Used
  // by both the fresh-scan path and the cache-hit path.
  const wireStats = (st) => {
    const canvas = $('#profHist');
    if (canvas && st.histogram) {
      let logOn = false;
      const draw = () => drawProfileHist(canvas, logOn && st.logHistogram ? st.logHistogram : st.histogram, st.quantiles);
      requestAnimationFrame(draw);
      const lg = $('#profLog');
      if (lg) lg.onclick = () => { logOn = !logOn; lg.classList.toggle('on', logOn); draw(); };
    }
    const oz = $('#optNoZero'), on = $('#optNoNeg'), ap = $('#optApply');
    if (oz && on && ap) {
      const sync = () => { const dirty = oz.checked !== ex.excludeZero || on.checked !== ex.excludeNeg; ap.disabled = !dirty; ap.classList.toggle('dirty', dirty); };
      oz.onchange = sync; on.onchange = sync;
      ap.onclick = () => { if (ap.disabled) return; ex.excludeZero = oz.checked; ex.excludeNeg = on.checked; run(); };
    }
    const cb = $('#statsCopy');
    if (cb) cb.onclick = () => { copyText(statsToTSV(st, name)); cb.textContent = 'copied ✓'; setTimeout(() => { cb.textContent = 'copy'; }, 1200); };
    const pb = $('#statsPng');
    if (pb) pb.onclick = () => { const cv = $('#profHist'); if (cv) saveCanvasPng(cv, `${String(name).replace(/[^\w.-]+/g, '_')}_hist.png`); };
    const xe = $('#statsExact');   // precomputed (≈) → recompute this one column exactly
    if (xe) xe.onclick = () => run({ force: true });
  };
  const cacheKey = () => `${uc}|${ex.excludeZero ? 1 : 0}|${ex.excludeNeg ? 1 : 0}`;
  const run = async (opts = {}) => {
    if (!opts.force && c._statsCache) {                        // cache hit → instant, no scan
      const hit = c._statsCache.get(cacheKey());
      if (hit) { showOverlay(`Statistics — ${name}${suffix}`, renderStats(hit, ex)); wireStats(hit); return; }
    }
    if (_statsAbort) _statsAbort.abort();                      // a re-run (apply chips / exact) supersedes the prior scan
    const ac = new AbortController(); _statsAbort = ac;
    showOverlay(`Statistics — ${name}${suffix}`, '<div style="color:#777">computing… <span id="scanPct">0%</span> <button id="scanCancel" style="font:inherit;font-size:11px;color:var(--muted);background:var(--bg-field);border:1px solid var(--bd2);border-radius:4px;padding:1px 8px;cursor:pointer;margin-left:6px">cancel</button></div>');
    const xb = $('#scanCancel'); if (xb) xb.onclick = () => ac.abort();
    try {
      const st = await scanColumnStats(c.source, {
        col: uc, dataStart: c.dataStart, numeric, decimal: c.d.decimal, rows: c.filterResult ? c.filterResult.nums : null,
        excludeZero: ex.excludeZero, excludeNeg: ex.excludeNeg, signal: ac.signal,
        onProgress: (b, n) => { const el = $('#scanPct'); if (el) el.textContent = `${n ? Math.round((100 * b) / n) : 0}%`; },
      });
      if (ac.signal.aborted) return;
      (c._statsCache || (c._statsCache = new Map())).set(cacheKey(), st);   // exact result → cache (overwrites a precomputed ≈ entry)
      showOverlay(`Statistics — ${name}${suffix}`, renderStats(st, ex));
      wireStats(st);
    } catch (e) {
      if (e && e.name === 'AbortError') { showOverlay(`Statistics — ${name}`, '<div style="color:var(--dim)">scan cancelled — reopen to retry</div>'); return; }
      showOverlay(`Statistics — ${name}`, `<div style="color:var(--fault)">${e.message}</div>`);
    } finally { if (_statsAbort === ac) _statsAbort = null; }
  };
  await run();
}

// ── column summary table (all columns × metrics) ────────────────────────────────
// Reads the precompute cache; one HTML table, click-to-sort, row → column detail.
const SUM_COLS = [
  { k: 'name', label: 'column', txt: true }, { k: 'type', label: 'type', txt: true },
  { k: 'n', label: 'n' }, { k: 'nullPct', label: 'null%', pct: true }, { k: 'nonnum', label: 'non-num' },
  { k: 'min', label: 'min' }, { k: 'max', label: 'max' }, { k: 'mean', label: 'mean' }, { k: 'std', label: 'std' },
  { k: 'cv', label: 'CV' }, { k: 'skew', label: 'skew' }, { k: 'zeroPct', label: 'zero%', pct: true },
  { k: 'p50', label: 'p50' }, { k: 'distinct', label: 'distinct' },
];
let _summarySort = { col: null, dir: 1 };
function buildSummaryRows(c) {
  const rows = [];
  for (let uc = 0; uc < c.schema.length; uc++) {
    const st = c._statsCache && c._statsCache.get(`${uc}|0|0`); if (!st) continue;
    const s = c.schema[uc];
    if (st.kind === 'number') rows.push({ uc, name: s.name, calc: !!s.calc, type: 'num', n: st.n, nullPct: st.count ? 100 * st.nulls / st.count : 0, nonnum: st.bad || 0, min: st.min, max: st.max, mean: st.mean, std: st.std, cv: st.cv, skew: st.skew, zeroPct: st.n ? 100 * st.zeros / st.n : 0, p50: st.quantiles ? st.quantiles.p50 : null, distinct: null, approx: !!st.quantilesApprox });
    else rows.push({ uc, name: s.name, calc: !!s.calc, type: 'txt', n: st.count - st.nulls, nullPct: st.count ? 100 * st.nulls / st.count : 0, nonnum: null, min: null, max: null, mean: null, std: null, cv: null, skew: null, zeroPct: null, p50: null, distinct: st.distinct, approx: false });
  }
  return rows;
}
function renderSummary(c) {
  let rows = buildSummaryRows(c);
  if (!rows.length) return '<div style="color:var(--dim)">no precomputed columns</div>';
  const srt = _summarySort;
  if (srt.col) rows = rows.slice().sort((a, b) => { const x = a[srt.col], y = b[srt.col]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return typeof x === 'string' ? srt.dir * x.localeCompare(y) : srt.dir * (x - y); });
  const fmtCell = (v, col) => v == null ? '' : col.pct ? (v > 0 && v < 1 ? v.toFixed(1) : Math.round(v)) + '%' : col.txt ? esc(String(v)) : fmtN(v);
  let h = '<button id="sumCopy" class="sum-copy">copy all</button><div style="overflow:auto;max-height:62vh;margin-top:4px;width:fit-content;max-width:100%"><table class="sum-tbl"><thead><tr>';
  for (const col of SUM_COLS) h += `<th data-k="${col.k}" class="${col.txt ? '' : 'num'}${srt.col === col.k ? ' sorted' : ''}">${col.label}${srt.col === col.k ? (srt.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  h += '</tr></thead><tbody>';
  for (const r of rows) {
    h += `<tr data-uc="${r.uc}">`;
    for (const col of SUM_COLS) {
      if (col.k === 'name') { h += `<td>${r.calc ? '<span style="color:var(--accent)">ƒ </span>' : ''}<span class="col-jump" title="go to this column in the grid">${esc(String(r.name))}</span></td>`; continue; }
      if (col.k === 'p50' && r.approx && r.p50 != null) { h += `<td class="num">${fmtN(r.p50)} <span style="color:var(--dim)">≈</span></td>`; continue; }
      const v = r[col.k];
      let sty = '';   // visual triage: null%/zero% as data-bars, junk-in-numeric flagged amber
      if (col.k === 'nullPct' && v > 0) sty = `background:linear-gradient(to right,rgba(206,74,74,.17) ${Math.min(100, v)}%,transparent 0)`;
      else if (col.k === 'zeroPct' && v > 0) sty = `background:linear-gradient(to right,rgba(140,144,153,.15) ${Math.min(100, v)}%,transparent 0)`;
      else if (col.k === 'nonnum' && v > 0) sty = 'background:rgba(214,150,54,.18);color:var(--text-hi)';
      h += `<td class="${col.txt ? '' : 'num'}"${sty ? ` style="${sty}"` : ''}>${fmtCell(v, col)}</td>`;
    }
    h += '</tr>';
  }
  return h + '</tbody></table></div>';
}
function summaryTSV(c) {
  const rows = buildSummaryRows(c), L = [SUM_COLS.map((col) => col.label).join('\t')];
  for (const r of rows) L.push(SUM_COLS.map((col) => { const v = r[col.k]; return v == null ? '' : col.pct ? v.toFixed(1) : v; }).join('\t'));
  return L.join('\n');
}
function paintSummary(c) {
  $('#helpBody').innerHTML = renderSummary(c);
  $('#helpBody').querySelectorAll('.sum-tbl th[data-k]').forEach((th) => th.onclick = () => {
    const k = th.getAttribute('data-k');
    if (_summarySort.col === k) _summarySort.dir *= -1; else _summarySort = { col: k, dir: (k === 'name' || k === 'type') ? 1 : -1 };   // numbers default desc (surface the big ones)
    paintSummary(c);
  });
  $('#helpBody').querySelectorAll('.sum-tbl tbody tr').forEach((tr) => tr.onclick = () => { showColumnStats(+tr.getAttribute('data-uc')); });   // row → that column's detail (showOverlay drops .wide)
  wireColJump();   // the name → jump to the column in the grid
  const cp = $('#sumCopy'); if (cp) cp.onclick = () => { copyText(summaryTSV(c)); cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy all'; }, 1200); };
}
// Wire the column-name "jump" links in the summary / data-quality tables: close the
// overlay and scroll the grid to that column (stops the row's own click = Statistics).
function wireColJump() {
  $('#helpBody').querySelectorAll('.col-jump').forEach((el) => el.onclick = (e) => {
    e.stopPropagation();
    const tr = el.closest('tr'); if (!tr) return;
    $('#help').classList.remove('show'); $('.help-box').classList.remove('wide');
    scrollToColumn(+tr.getAttribute('data-uc'));
  });
}
function showSummary() {
  const c = current; if (!c) return;
  $('#helpTitle').textContent = `Column summary — ${c.label}${c.filterResult ? ' (filtered)' : ''}`;
  $('.help-box').classList.add('wide');
  $('#help').classList.add('show');
  paintSummary(c);
}

// ── data quality (per-column quiet-bug flags over a sample) ─────────────────────
let _dqFindings = null;
async function showDataQuality() {
  const c = current; if (!c || c.d.kind !== 'delimited') return;
  $('#helpTitle').textContent = `Data quality — ${c.label}${c.filterResult ? ' (filtered)' : ''}`;
  $('.help-box').classList.add('wide');
  $('#help').classList.add('show');
  $('#helpBody').innerHTML = '<div style="color:#777">scanning… <span id="scanPct">0%</span></div>';
  const ac = newFooterScan();
  let rows, limit;
  if (c.filterResult) { rows = c.filterResult.nums; limit = Infinity; }   // the filtered subset
  else { rows = gutterSampleRows(c.source, c.dataStart); limit = GUTTER_SAMPLE; }   // spread sample (or all if small)
  try {
    const findings = await scanDataQuality(c.source, {
      schema: c.schema, dataStart: c.dataStart, decimal: c.d.decimal, rows: rows || null, limit, signal: ac.signal,
      onProgress: (b, n) => { const e = $('#scanPct'); if (e) e.textContent = `${n ? Math.round(100 * b / n) : 0}%`; },
    });
    if (ac.signal.aborted) return;
    _dqFindings = findings;
    paintDataQuality(c);
  } catch (e) {
    if (e && e.name === 'AbortError') $('#helpBody').innerHTML = '<div style="color:var(--dim)">cancelled</div>';
    else $('#helpBody').innerHTML = `<div style="color:var(--fault)">${esc(e.message)}</div>`;
  } finally { if (_footerScanAbort === ac) _footerScanAbort = null; }
}
function paintDataQuality(c) {
  const f = _dqFindings || [];
  if (!f.length) { $('#helpBody').innerHTML = '<div style="color:var(--ok);padding:8px 2px">✓ no data-quality flags in the sample</div>'; return; }
  const dot = { high: 'var(--fault)', warn: 'var(--accent)', info: 'var(--muted)' };
  let h = '<button id="dqCopy" class="sum-copy">copy all</button>';
  h += `<div style="color:var(--dim);font-size:11px;margin:2px 0 6px">${f.length} flag(s) — from a sample · click a row to inspect the column</div>`;
  h += '<div style="overflow:auto;max-height:60vh"><table class="sum-tbl"><thead><tr><th></th><th>column</th><th>flag</th><th>detail</th></tr></thead><tbody>';
  for (const x of f) {
    const fix = x.issue === 'leading zeros lost' ? ` <button class="dq-fix" data-uc="${x.col}" title="store this column as text so the leading zeros survive">fix: treat as text</button>` : '';
    h += `<tr data-uc="${x.col}"><td style="color:${dot[x.severity]};text-align:center">●</td><td><span class="col-jump" title="go to this column in the grid">${esc(x.name)}</span></td><td>${esc(x.issue)}</td><td style="color:var(--muted);white-space:normal">${esc(x.detail)}${fix}</td></tr>`;
  }
  h += '</tbody></table></div>';
  $('#helpBody').innerHTML = h;
  $('#helpBody').querySelectorAll('.sum-tbl tbody tr').forEach((tr) => tr.onclick = () => showColumnStats(+tr.getAttribute('data-uc')));
  $('#helpBody').querySelectorAll('.dq-fix').forEach((b) => b.onclick = (e) => { e.stopPropagation(); setColType(+b.getAttribute('data-uc'), 'string'); showDataQuality(); });   // text column → leading zeros preserved → re-scan clears the flag
  wireColJump();   // the name → jump to the column in the grid
  const cp = $('#dqCopy'); if (cp) cp.onclick = () => { copyText(['severity\tcolumn\tflag\tdetail', ...f.map((x) => `${x.severity}\t${x.name}\t${x.issue}\t${x.detail}`)].join('\n')); cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy all'; }, 1200); };
}

// ── group by (one group column × value column(s), optional weight) ───────────────
let _gbConfig = null, _gbResult = null, _gbSort = { col: 'n', dir: -1 };
function openGroupBy() {
  const c = current; if (!c || c.d.kind !== 'delimited') return;
  const firstCat = c.schema.findIndex((s) => s.type !== 'number'), firstNum = c.schema.findIndex((s) => s.type === 'number');
  _gbConfig = { group: firstCat >= 0 ? firstCat : 0, values: [firstNum >= 0 ? firstNum : 0], weight: null };
  _gbResult = null;
  $('#helpTitle').textContent = `Group by — ${c.label}${c.filterResult ? ' (filtered)' : ''}`;
  $('.help-box').classList.add('wide');
  $('#help').classList.add('show');
  paintGroupBy();
}
function paintGroupBy() {
  const c = current; if (!c) return;
  const cols = c.schema, numFilter = (s) => s.type === 'number';
  const optsFor = (sel, filter) => cols.map((s, i) => (filter && !filter(s)) ? '' : `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  let h = '<div class="gb-form">';
  h += `<label>Group by <select id="gbGroup">${optsFor(_gbConfig.group, null)}</select></label>`;
  h += '<span class="gb-vals">';
  _gbConfig.values.forEach((uc, vi) => { h += `<label class="gb-val">Value <select class="gb-value" data-vi="${vi}">${optsFor(uc, numFilter)}</select>${_gbConfig.values.length > 1 ? `<button class="gb-rm" data-vi="${vi}" title="remove">✕</button>` : ''}</label>`; });
  h += '</span>';
  h += `<button id="gbAdd" class="gb-add">+ add variable</button>`;
  h += `<label>Weight by <select id="gbWeight"><option value="">none</option>${optsFor(_gbConfig.weight == null ? -1 : _gbConfig.weight, numFilter)}</select></label>`;
  h += `<button id="gbRun" class="gb-run">Group</button>`;
  h += '</div>';
  h += `<div id="gbResults">${_gbResult ? renderGroupResult(c) : '<div style="color:var(--dim);margin-top:8px">pick a group column + value(s), then Group</div>'}</div>`;
  $('#helpBody').innerHTML = h;
  wireGroupBy(c);
}
function groupTable(c) {
  const res = _gbResult, cfg = res.config, schema = c.schema;
  const groupName = schema[cfg.group] ? schema[cfg.group].name : 'group';
  const aggs = res.weighted ? ['sum', 'mean', 'wmean', 'std', 'min', 'max'] : ['sum', 'mean', 'std', 'min', 'max'];
  const COLS = [{ k: 'key', label: groupName, txt: true }, { k: 'n', label: 'n' }];
  cfg.values.forEach((uc, vi) => aggs.forEach((agg) => COLS.push({ k: `${vi}.${agg}`, label: `${schema[uc] ? schema[uc].name : '?'}·${agg}` })));
  const rowOf = (g) => { const o = { key: g.key, n: g.count }; cfg.values.forEach((uc, vi) => { const v = g.vars[vi]; aggs.forEach((agg) => { o[`${vi}.${agg}`] = v[agg]; }); }); return o; };
  let rows = res.groups.map(rowOf);
  const srt = _gbSort;
  const numKey = srt.col === 'key' && schema[cfg.group] && schema[cfg.group].type === 'number';   // numeric group keys (incl. bin() edges) sort numerically, not lexically
  if (srt.col) rows.sort((a, b) => {
    let x = a[srt.col], y = b[srt.col];
    if (numKey) { x = Number(x); y = Number(y); if (Number.isNaN(x)) x = Infinity; if (Number.isNaN(y)) y = Infinity; }   // '(blank)' → end
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return typeof x === 'string' ? srt.dir * x.localeCompare(y) : srt.dir * (x - y);
  });
  return { COLS, rows, totalRow: rowOf({ key: 'Σ total', count: res.total.count, vars: res.total.vars }), truncated: res.truncated };
}
function renderGroupResult(c) {
  const { COLS, rows, totalRow, truncated } = groupTable(c);
  const fmtCell = (v, col) => v == null ? '' : col.txt ? esc(String(v)) : fmtN(v);
  let h = '<button id="gbCopy" class="sum-copy">copy all</button>';
  if (truncated) h += `<div style="color:var(--accent);font-size:11px;margin:4px 0">⚠ over 1000 groups — table truncated (totals still cover all rows)</div>`;
  h += '<div style="overflow:auto;max-height:54vh;margin-top:4px"><table class="sum-tbl"><thead><tr>';
  for (const col of COLS) h += `<th data-k="${col.k}" class="${col.txt ? '' : 'num'}${_gbSort.col === col.k ? ' sorted' : ''}">${esc(col.label)}${_gbSort.col === col.k ? (_gbSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  h += '</tr></thead><tbody>';
  for (const r of rows) { h += `<tr data-key="${esc(String(r.key)).replace(/"/g, '&quot;')}">`; for (const col of COLS) h += `<td class="${col.txt ? '' : 'num'}">${fmtCell(r[col.k], col)}</td>`; h += '</tr>'; }
  h += '<tr class="gb-total">'; for (const col of COLS) h += `<td class="${col.txt ? '' : 'num'}">${fmtCell(totalRow[col.k], col)}</td>`; h += '</tr>';
  return h + '</tbody></table></div>';
}
function groupTSV(c) {
  const { COLS, rows, totalRow } = groupTable(c);
  const line = (r) => COLS.map((col) => { const v = r[col.k]; return v == null ? '' : v; }).join('\t');
  return [COLS.map((col) => col.label).join('\t'), ...rows.map(line), line(totalRow)].join('\n');
}
async function computeGroupBy() {
  const c = current; if (!c) return;
  const cfg = { group: _gbConfig.group, values: _gbConfig.values.slice(), weight: _gbConfig.weight };
  if (!cfg.values.length) return;
  const ac = newFooterScan();
  const rEl = $('#gbResults'); if (rEl) rEl.innerHTML = '<div style="color:#777;margin-top:8px">grouping… <span id="scanPct">0%</span></div>';
  $('#meta').textContent = 'grouping…';
  try {
    const res = await scanGroupBy(c.source, {
      groupCol: cfg.group, valueCols: cfg.values, weightCol: cfg.weight, dataStart: c.dataStart, decimal: c.d.decimal, rows: c.filterResult ? c.filterResult.nums : null, signal: ac.signal,
      onProgress: (b, n) => { const e = $('#scanPct'); if (e) e.textContent = `${n ? Math.round(100 * b / n) : 0}%`; $('#meta').textContent = `grouping… ${n ? Math.round(100 * b / n) : 0}% · Esc to cancel`; },
    });
    if (ac.signal.aborted) return;
    _gbResult = { ...res, config: cfg };
    $('#meta').textContent = c._meta || '';
    paintGroupBy();
  } catch (e) {
    if (e && e.name === 'AbortError') { $('#meta').textContent = c._meta || 'group cancelled'; const r = $('#gbResults'); if (r) r.innerHTML = '<div style="color:var(--dim);margin-top:8px">cancelled</div>'; }
    else { const r = $('#gbResults'); if (r) r.innerHTML = `<div style="color:var(--fault);margin-top:8px">${esc(e.message)}</div>`; }
  } finally { if (_footerScanAbort === ac) _footerScanAbort = null; }
}
function wireGroupBy(c) {
  const g = $('#gbGroup'); if (g) g.onchange = () => { _gbConfig.group = +g.value; };
  $('#helpBody').querySelectorAll('.gb-value').forEach((sel) => sel.onchange = () => { _gbConfig.values[+sel.dataset.vi] = +sel.value; });
  $('#helpBody').querySelectorAll('.gb-rm').forEach((b) => b.onclick = () => { _gbConfig.values.splice(+b.dataset.vi, 1); paintGroupBy(); });
  const add = $('#gbAdd'); if (add) add.onclick = () => { const fn = c.schema.findIndex((s) => s.type === 'number'); _gbConfig.values.push(fn >= 0 ? fn : 0); paintGroupBy(); };
  const w = $('#gbWeight'); if (w) w.onchange = () => { _gbConfig.weight = w.value === '' ? null : +w.value; };
  const run = $('#gbRun'); if (run) run.onclick = () => computeGroupBy();
  $('#helpBody').querySelectorAll('.sum-tbl th[data-k]').forEach((th) => th.onclick = () => { const k = th.getAttribute('data-k'); if (_gbSort.col === k) _gbSort.dir *= -1; else _gbSort = { col: k, dir: k === 'key' ? 1 : -1 }; paintGroupBy(); });
  $('#helpBody').querySelectorAll('.sum-tbl tbody tr:not(.gb-total)').forEach((tr) => tr.onclick = () => {
    const key = tr.getAttribute('data-key'), gname = c.schema[_gbResult.config.group].name;
    $('.help-box').classList.remove('wide'); $('#help').classList.remove('show');
    if (key === '(blank)') applyFilter(`${colRef(gname)} is blank`); else filterByValue(_gbResult.config.group, key);
  });
  const cp = $('#gbCopy'); if (cp) cp.onclick = () => { copyText(groupTSV(c)); cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy all'; }, 1200); };
}

// ── Grade–tonnage: group-by with a tonnage weight (volume × density × ore proportion),
// reporting tonnes + tonnage-weighted grade + contained metal per group. The mining
// report that turns "CSV viewer" into "speaks my domain". Reuses the #help overlay.
let _gtConfig = null, _gtResult = null, _gtSort = { col: 'tonnes', dir: -1 };
function openGradeTonnage() {
  const c = current; if (!c || c.d.kind !== 'delimited') return;
  const num = c.schema.map((s, i) => ({ s, i })).filter((o) => o.s.type === 'number');
  const colName = (re) => { const s = c.schema.find((x) => re.test(x.name)); return s ? colRef(s.name) : null; };
  const d3 = c.schema.filter((s) => /^d[xyz]$/i.test(s.name));   // block dims → volume = dx·dy·dz
  const firstCat = c.schema.findIndex((s) => s.type !== 'number');
  const grade = num.find((o) => !/^(id|x|y|z|dx|dy|dz|east|north|elev|rl|row)$/i.test(o.s.name));
  _gtConfig = {   // volume/density/proportion are EXPRESSIONS (a column, a constant, dx*dy*dz, or blank = 1)
    group: firstCat >= 0 ? firstCat : null,
    volume: d3.length === 3 ? d3.map((s) => colRef(s.name)).join(' * ') : (colName(/vol/i) || '1'),
    density: colName(/dens|(^|_)sg($|_)/i) || '2.7',
    densityUnit: 't/m3',   // DECLARED unit of the density factor — converted to t/m³ so tonnes are tonnes
    proportion: colName(/(^|_)ore|prop|ore.?pct/i) || '1',
    grades: [grade ? grade.i : (num[0] ? num[0].i : 0)],
    gradeUnits: [''],      // DECLARED grade unit per field ('' = undeclared) — labels + metal-in-tonnes
    cutoffs: [''],   // per grade field: comma-separated cutoffs, blank = auto (round bin edges)
    ranges: [''],    // per grade field: manual plot ranges "x:0..2 t:5e6 g:3" — blank = auto
  };
  // seed from a lens's GT setup (consumed once — after this the live config wins).
  // Names → indices; a grade whose column is gone is dropped (auto if none left).
  if (c._lensGt) {
    const g = c._lensGt; c._lensGt = null;
    const nidx = (nm) => c.schema.findIndex((s) => s && s.name === nm);
    for (const k of ['volume', 'density', 'densityUnit', 'proportion']) if (g[k] != null) _gtConfig[k] = g[k];
    if (g.group) { const gi = nidx(g.group); if (gi >= 0) _gtConfig.group = gi; }
    if (Array.isArray(g.grades)) {
      const gg = g.grades.map((x) => ({ i: nidx(x.col), ...x })).filter((x) => x.i >= 0);
      if (gg.length) {
        _gtConfig.grades = gg.map((x) => x.i);
        _gtConfig.gradeUnits = gg.map((x) => x.unit || '');
        _gtConfig.cutoffs = gg.map((x) => x.cutoffs || '');
        _gtConfig.ranges = gg.map((x) => x.ranges || '');
      }
    }
  }
  _gtResult = null;
  $('#helpTitle').textContent = `Grade–tonnage — ${c.label}${c.filterResult ? ' (filtered)' : ''}`;
  $('.help-box').classList.add('wide');
  $('#help').classList.add('show');
  paintGradeTonnage();
}
// declared-unit helpers: display label + the metal-in-tonnes conversion
// (metal is accumulated raw as t × grade-in-its-unit; a declared unit converts
// the grade factor to a FRACTION so metal = tonnes × fraction = tonnes)
const GT_GRADE_UNITS = [['', '— unit'], ['pct', '%'], ['g/t', 'g/t'], ['ppm', 'ppm'], ['oz/t', 'oz/t']];
const gtUnitLabel = (u) => (u === 'pct' ? '%' : u || '');
const gtMetalScale = (u) => (u ? unitConvert(1, u, 'fraction') : 1);
function paintGradeTonnage() {
  const c = current; if (!c) return;
  const cols = c.schema;
  let h = '<div class="gb-form gt-form">';
  h += `<label>Group by <select id="gtGroup"><option value=""${_gtConfig.group == null ? ' selected' : ''}>— whole deposit —</option>${cols.map((s, i) => `<option value="${i}"${i === _gtConfig.group ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`;
  const exprInp = (f, ph) => `<input class="gt-expr" data-f="${f}" value="${esc(_gtConfig[f])}" placeholder="${ph}" spellcheck="false" autocomplete="off" style="width:150px;font-family:var(--mono)">`;
  h += `<label>Volume ${exprInp('volume', 'e.g. dx*dy*dz')}</label>`;
  h += `<label>Density ${exprInp('density', 'e.g. density or 2.7')} <select id="gtDensUnit" title="declared unit of the density factor — converted to t/m³ so tonnes are tonnes">${[['t/m3', 't/m³ (=g/cm³)'], ['kg/m3', 'kg/m³'], ['lb/ft3', 'lb/ft³']].map(([v, t]) => `<option value="${v}"${v === (_gtConfig.densityUnit || 't/m3') ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  h += `<label>Ore proportion ${exprInp('proportion', 'e.g. ore_pct or 1')}</label>`;
  h += '<span class="gb-vals">';
  _gtConfig.grades.forEach((uc, gi) => { h += `<label class="gb-val">Grade <select class="gt-grade" data-gi="${gi}">${cols.map((s, i) => s.type === 'number' ? `<option value="${i}"${i === uc ? ' selected' : ''}>${esc(s.name)}</option>` : '').join('')}</select><select class="gt-unit" data-gi="${gi}" title="declared grade unit — labels the report + makes metal come out in tonnes">${GT_GRADE_UNITS.map(([v, t]) => `<option value="${v}"${v === (_gtConfig.gradeUnits[gi] || '') ? ' selected' : ''}>${t}</option>`).join('')}</select><input class="gt-cut" data-gi="${gi}" value="${esc(_gtConfig.cutoffs[gi] || '')}" placeholder="cutoffs · auto" title="comma-separated cutoffs for this grade, e.g. 0.5, 1, 2 — blank = automatic round steps" spellcheck="false" autocomplete="off" style="width:120px;font-family:var(--mono)"><input class="gt-rng" data-gi="${gi}" value="${esc(_gtConfig.ranges[gi] || '')}" placeholder="ranges · auto" title="manual plot ranges — tokens: x:0..2 (cutoff axis) · t:5e6 (tonnes max, or t:1e6..5e6) · g:3.2 (grade max, or g:1..3) — blank = auto" spellcheck="false" autocomplete="off" style="width:110px;font-family:var(--mono)">${_gtConfig.grades.length > 1 ? `<button class="gt-rm" data-gi="${gi}" title="remove">✕</button>` : ''}</label>`; });
  h += '</span>';
  h += `<button id="gtAdd" class="gb-add">+ add grade</button>`;
  h += `<button id="gtRun" class="gb-run">Report</button>`;
  h += '</div>';
  h += `<div id="gtResults">${_gtResult ? renderGTResult(c) : '<div style="color:var(--dim);margin-top:8px">set volume · density · ore proportion (a column or a constant) + grade(s), then Report</div>'}</div>`;
  $('#helpBody').innerHTML = h;
  wireGradeTonnage(c);
  if (_gtResult) drawGTCurves(c);   // canvases exist only after the innerHTML lands
}
function gtTable(c) {
  const res = _gtResult, cfg = res.config, schema = c.schema, grouped = res.grouped;
  const groupName = grouped && schema[cfg.group] ? schema[cfg.group].name : 'deposit';
  const COLS = [{ k: 'key', label: groupName, txt: true }, { k: 'blocks', label: 'blocks' }, { k: 'tonnes', label: 'tonnes' }];
  const mScale = cfg.grades.map((_, gi) => gtMetalScale(cfg.gradeUnits && cfg.gradeUnits[gi]));
  cfg.grades.forEach((uc, gi) => {
    const gn = schema[uc] ? schema[uc].name : '?', u = cfg.gradeUnits && cfg.gradeUnits[gi], uL = gtUnitLabel(u);
    COLS.push({ k: `g${gi}`, label: uL ? `${gn} (${uL})` : gn });
    COLS.push({ k: `m${gi}`, label: u ? `${gn} metal (t)` : `${gn}·t`, fN: !!u });   // declared → metal in tonnes (fmtN — Au tonnages are small)
  });
  const rowOf = (key, g) => { const o = { key, blocks: g.count, tonnes: g.tonnes }; cfg.grades.forEach((uc, gi) => { o[`g${gi}`] = g.grades[gi].grade; o[`m${gi}`] = g.grades[gi].metal * mScale[gi]; }); return o; };
  let rows = grouped ? res.groups.map((g) => rowOf(g.key, g)) : [];
  const srt = _gtSort, numKey = srt.col === 'key' && grouped && schema[cfg.group] && schema[cfg.group].type === 'number';
  if (srt.col && rows.length) rows.sort((a, b) => {
    let x = a[srt.col], y = b[srt.col];
    if (numKey) { x = Number(x); y = Number(y); if (Number.isNaN(x)) x = Infinity; if (Number.isNaN(y)) y = Infinity; }
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return typeof x === 'string' ? srt.dir * x.localeCompare(y) : srt.dir * (x - y);
  });
  return { COLS, rows, totalRow: rowOf(grouped ? 'Σ total' : 'deposit', res.total), grouped };
}
function renderGTResult(c) {
  const { COLS, rows, totalRow } = gtTable(c);
  const fmtCell = (v, col) => v == null ? '' : col.txt ? esc(String(v)) : (col.fN ? fmtN(v) : col.k === 'tonnes' || col.k === 'blocks' || col.k[0] === 'm' ? fmtInt(v) : fmtN(v));
  let h = '<button id="gtCopy" class="sum-copy">copy all</button>';
  if (_gtResult.truncated) h += `<div style="color:var(--accent);font-size:11px;margin:4px 0">⚠ over 1000 groups — table truncated (total still covers all rows)</div>`;
  const cf = _gtResult.config;
  h += `<div style="color:var(--dim);font-size:11px;margin:4px 0">tonnes = Σ(<code>${esc(cf.volExpr)}</code> × <code>${esc(cf.densExpr)}</code>${cf.densityUnit && cf.densityUnit !== 't/m3' ? ` <i>[${cf.densityUnit === 'kg/m3' ? 'kg/m³' : 'lb/ft³'} → t/m³]</i>` : ''} × <code>${esc(cf.propExpr)}</code>) · grade = tonnage-weighted mean · metal ${cf.gradeUnits && cf.gradeUnits.some(Boolean) ? 'in tonnes where the grade unit is declared' : '(<i>name</i>·t = tonnes × grade, unit undeclared)'}</div>`;
  h += '<div style="overflow:auto;max-height:50vh;margin-top:4px"><table class="sum-tbl"><thead><tr>';
  for (const col of COLS) h += `<th data-k="${col.k}" class="${col.txt ? '' : 'num'}${_gtSort.col === col.k ? ' sorted' : ''}">${esc(col.label)}${_gtSort.col === col.k ? (_gtSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  h += '</tr></thead><tbody>';
  for (const r of rows) { h += '<tr>'; for (const col of COLS) h += `<td class="${col.txt ? '' : 'num'}">${fmtCell(r[col.k], col)}</td>`; h += '</tr>'; }
  h += '<tr class="gb-total">'; for (const col of COLS) h += `<td class="${col.txt ? '' : 'num'}">${fmtCell(totalRow[col.k], col)}</td>`; h += '</tr>';
  return h + '</tbody></table></div>' + renderGTCurves(c);
}
function gtTSV(c) {
  const { COLS, rows, totalRow } = gtTable(c);
  const line = (r) => COLS.map((col) => { const v = r[col.k]; return v == null ? '' : v; }).join('\t');
  return [COLS.map((col) => col.label).join('\t'), ...rows.map(line), line(totalRow)].join('\n');
}

// ── grade–tonnage by cutoff (the curve) — sluice's gradeTonnage accumulator driven
// from lamina's record cursor. Pass 1 (the grouped report) already yields each grade's
// observed extents; pass 2 bins (grade, weight) into one accumulator per grade field.
// The weight is the SAME expr-compiled volume×density×proportion as the report, fed to
// sluice via its `weight` (precomputed tonnage) option — the accumulation math lives in
// @gcu/sluice, only the driver is lamina's. ──

// A "nice" step from {1, 2, 2.5, 5}×10^k covering `raw` — bin edges land on round cutoffs.
function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// Pass 2: one more windowed scan → per-grade-field cumulative curves (or null where a
// field has no range). extents come from pass 1's total.grades[gi] (gmin/gmax over
// blocks with mass), so no extra extent pass is needed.
async function scanGTCurves(c, cfg, factors, extents, { rows, signal, onProgress } = {}) {
  const accs = cfg.grades.map((uc, gi) => {
    const e = extents[gi];
    if (!e || e.gmin == null || e.gmax == null) return null;
    const floor = Math.min(0, e.gmin);                       // grades bin from 0 (below only if negatives exist)
    if (!(e.gmax > floor)) return null;                      // constant/degenerate → no curve
    const step = niceStep((e.gmax - floor) / 150);           // ~150–200 nice-edged bins
    const bins = Math.max(20, Math.min(400, Math.ceil((e.gmax - floor) / step)));
    const acc = gradeTonnage({ grade: 'g', weight: 'w', gradeMin: floor, gradeMax: floor + bins * step, bins });
    // user-specified cutoffs → EXACT at-or-above accumulation (not snapped to bins)
    const cuts = cfg.cutoffs && cfg.cutoffs[gi];
    const cust = cuts ? { c: cuts, t: new Float64Array(cuts.length), m: new Float64Array(cuts.length) } : null;
    return { acc, s: acc.create(), step, cust };
  });
  if (!accs.some(Boolean)) return null;
  const { volume: vol, density: dens, proportion: prop } = factors;
  await c.source.eachRecord({ dataStart: c.dataStart, rows, signal, onProgress }, (disp, fields) => {
    const w = vol.fn(fields) * dens.fn(fields) * prop.fn(fields);
    if (!Number.isFinite(w) || w <= 0) return;               // no mass → skip (same rule as the report)
    for (let gi = 0; gi < accs.length; gi++) {
      const a = accs[gi]; if (!a) continue;
      const g = parseNum(fields[cfg.grades[gi]], c.d.decimal);
      if (Number.isNaN(g)) continue;
      a.acc.push(a.s, { g, w });
      if (a.cust) {
        const cc = a.cust.c;                                 // ascending; add to every cutoff ≤ g
        for (let k = 0; k < cc.length && cc[k] <= g; k++) { a.cust.t[k] += w; a.cust.m[k] += w * g; }
      }
    }
  });
  return accs.map((a) => (a ? {
    ...a.acc.result(a.s), step: a.step,
    custom: a.cust ? a.cust.c.map((cut, k) => ({ cutoff: cut, tonnage: a.cust.t[k], grade: a.cust.t[k] > 0 ? a.cust.m[k] / a.cust.t[k] : 0, metal: a.cust.m[k] })) : null,
  } : null));
}

// The cutoff table rows: user cutoffs when given (exact, in their order), else exact
// bin edges at a nice stride (~8–10 rows), trailing zero-tonnage rows trimmed (the
// curve is cumulative-from-top → monotone falling).
function gtCurveRows(cv) {
  if (cv.custom) return cv.custom;                           // the user asked for these — show all
  const range = cv.gradeMax - cv.gradeMin;
  const stride = Math.max(1, Math.round(niceStep(range / 8) / cv.step));
  const rows = [];
  for (let i = 0; i < cv.bins; i += stride) {
    const pt = cv.curve[i];
    if (!(pt.tonnage > 0) && rows.length) break;             // past the last mass — stop
    rows.push(pt);
  }
  return rows;
}
function gtCurveTSV(cv, gradeName, unit) {
  const t0 = cv.curve[0].tonnage || 1, uL = gtUnitLabel(unit), mS = gtMetalScale(unit);
  const L = [`cutoff${uL ? ` (${uL})` : ''}\ttonnes ≥\t${gradeName}${uL ? ` (${uL})` : ''}\t${unit ? `${gradeName} metal (t)` : `${gradeName}·t`}\t% of tonnes`];
  for (const p of gtCurveRows(cv)) L.push(`${p.cutoff}\t${p.tonnage}\t${p.grade}\t${unit ? p.metal * mS : p.metal}\t${(100 * p.tonnage / t0).toFixed(1)}`);
  return L.join('\n');
}

// manual plot ranges per grade: "x:0..2 t:5e6 g:1..3" → { x, t, g } with [lo, hi]
// pairs (null bound = auto). A single number after t:/g: means "max".
function parseGtRanges(s) {
  const out = { x: null, t: null, g: null };
  for (const m of String(s || '').matchAll(/([xtg])\s*:\s*(-?[\d.eE+]+)?\s*(?:\.\.)?\s*(-?[\d.eE+]+)?/g)) {
    const lo = m[2] != null ? +m[2] : null, hi = m[3] != null ? +m[3] : null;
    // one number + no ".." = a max; "a..b" = both; "a.." = min only
    const dots = m[0].includes('..');
    out[m[1]] = dots ? [lo, hi] : [null, lo];
    if (out[m[1]][0] != null && !Number.isFinite(out[m[1]][0])) out[m[1]][0] = null;
    if (out[m[1]][1] != null && !Number.isFinite(out[m[1]][1])) out[m[1]][1] = null;
  }
  return out;
}
// Save a chart canvas as PNG (at its dpr-scaled resolution) — blob + a[download],
// no network involved. The memo-paste path until report export lands.
function saveCanvasPng(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// Curve sections (per grade field with a computed curve): canvas + cutoff table.
function renderGTCurves(c) {
  const curves = _gtResult.curves; if (!curves) return '';
  const cfg = _gtResult.config;
  let h = '';
  cfg.grades.forEach((uc, gi) => {
    const cv = curves[gi]; if (!cv || !(cv.curve[0] && cv.curve[0].tonnage > 0)) return;
    const gn = c.schema[uc] ? c.schema[uc].name : '?';
    const u = cfg.gradeUnits && cfg.gradeUnits[gi], uL = gtUnitLabel(u), mS = gtMetalScale(u);
    const t0 = cv.curve[0].tonnage;
    h += `<div class="gt-curve-sec">`;
    h += `<div class="gt-curve-head">${esc(gn)}${uL ? ` (${uL})` : ''} — by cutoff <button class="gt-ccopy" data-gi="${gi}">copy</button><button class="gt-ccopy gt-cpng" data-gi="${gi}" title="copy the plot image to the clipboard">copy png</button><button class="gt-ccopy gt-csave" data-gi="${gi}">save png</button></div>`;
    h += `<canvas class="gt-curve" data-gi="${gi}"></canvas>`;
    h += `<div class="gt-curve-legend"><span class="lg-t">—</span> tonnes ≥ cutoff &nbsp; <span class="lg-g">—</span> mean grade ≥ cutoff</div>`;
    h += `<table class="sum-tbl gt-cut-tbl"><thead><tr><th class="num">cutoff${uL ? ` (${uL})` : ''}</th><th class="num">tonnes ≥</th><th class="num">${esc(gn)}</th><th class="num">${u ? `${esc(gn)} metal (t)` : `${esc(gn)}·t`}</th><th class="num">% of tonnes</th></tr></thead><tbody>`;
    for (const p of gtCurveRows(cv)) h += `<tr><td class="num">${fmtN(p.cutoff)}</td><td class="num">${fmtInt(p.tonnage)}</td><td class="num">${fmtN(p.grade)}</td><td class="num">${u ? fmtN(p.metal * mS) : fmtInt(p.metal)}</td><td class="num">${(100 * p.tonnage / t0).toFixed(1)}%</td></tr>`;
    h += '</tbody></table></div>';
  });
  return h;
}

// Draw each curve canvas: tonnes (accent, falling) + mean grade (info, rising) vs
// cutoff. Theme-aware (CSS vars), dpr-scaled — same pattern as drawProfileHist.
function drawGTCurves(c) {
  const curves = _gtResult && _gtResult.curves; if (!curves) return;
  $('#helpBody').querySelectorAll('canvas.gt-curve').forEach((canvas) => {
    const cv = curves[+canvas.dataset.gi]; if (!cv) return;
    const W = canvas.clientWidth || 560, H = canvas.clientHeight || 140, dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const acc = css.getPropertyValue('--accent').trim() || '#c89b3c';
    const info = css.getPropertyValue('--info').trim() || '#4a78b0';
    const dim = css.getPropertyValue('--dim').trim() || '#777';
    const bd = css.getPropertyValue('--border').trim() || '#2a2a2a';
    const padL = 6, padR = 6, padT = 12, padB = 16, plotW = W - padL - padR, plotH = H - padT - padB;
    const n = cv.bins, t0 = cv.curve[0].tonnage || 1;
    let gMax = 0; for (const p of cv.curve) if (p.tonnage > 0 && p.grade > gMax) gMax = p.grade;
    if (!(gMax > 0)) gMax = 1;
    // manual ranges (per grade): x windows the cutoff axis; t / g pin the y scales
    const rng = parseGtRanges(_gtConfig && _gtConfig.ranges && _gtConfig.ranges[+canvas.dataset.gi]);
    const x0 = rng.x && rng.x[0] != null ? rng.x[0] : cv.gradeMin, x1 = rng.x && rng.x[1] != null ? rng.x[1] : cv.gradeMax;
    const tLo = rng.t && rng.t[0] != null ? rng.t[0] : 0, tHi = rng.t && rng.t[1] != null ? rng.t[1] : t0;
    const gLo = rng.g && rng.g[0] != null ? rng.g[0] : 0, gHi = rng.g && rng.g[1] != null ? rng.g[1] : gMax;
    const span = (x1 - x0) || 1;
    const Xv = (c2) => padL + ((c2 - x0) / span) * plotW;    // value-based x (handles custom cutoffs + windows)
    const Yt = (t) => padT + plotH * (1 - (t - tLo) / ((tHi - tLo) || 1));
    const Yg = (g2) => padT + plotH * (1 - (g2 - gLo) / ((gHi - gLo) || 1));
    // axes: baseline + x tick labels at the table's stride cutoffs
    ctx.strokeStyle = bd; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT + plotH + 0.5); ctx.lineTo(padL + plotW, padT + plotH + 0.5); ctx.stroke();
    ctx.fillStyle = dim; ctx.font = '10px ' + (css.getPropertyValue('--mono').trim() || 'monospace'); ctx.textAlign = 'center';
    for (const p of gtCurveRows(cv)) {
      if (p.cutoff < x0 || p.cutoff > x1) continue;
      const x = Xv(p.cutoff);
      ctx.fillRect(x, padT + plotH, 1, 3); ctx.fillText(fmtN(p.cutoff), x, H - 3);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();   // windows may cut the curves
    // tonnes (falling) — accent
    ctx.strokeStyle = acc; ctx.lineWidth = 1.5; ctx.beginPath();
    let st2 = false;
    for (let i = 0; i < n; i++) { const p = cv.curve[i]; const x = Xv(p.cutoff), y = Yt(p.tonnage); st2 ? ctx.lineTo(x, y) : ctx.moveTo(x, y); st2 = true; }
    ctx.stroke();
    // mean grade (rising) — info; only over bins that still have mass
    ctx.strokeStyle = info; ctx.lineWidth = 1.5; ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const p = cv.curve[i]; if (!(p.tonnage > 0)) break;
      const x = Xv(p.cutoff), y = Yg(p.grade);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    }
    ctx.stroke();
    ctx.restore();
    // scale hints: y-max tonnes (left, accent) + y-max grade (right, info)
    ctx.textAlign = 'left'; ctx.fillStyle = acc; ctx.fillText(fmtInt(tHi) + ' t', padL + 2, padT - 2);
    const uL = gtUnitLabel(_gtResult.config.gradeUnits && _gtResult.config.gradeUnits[+canvas.dataset.gi]);
    ctx.textAlign = 'right'; ctx.fillStyle = info; ctx.fillText(fmtN(gHi) + (uL ? ' ' + uL : ''), W - padR - 2, padT - 2);
  });
}
async function computeGradeTonnage() {
  const c = current; if (!c) return;
  if (!_gtConfig.grades.length) return;
  let vol, dens, prop;
  try {   // compile the volume/density/proportion expressions (a column, constant, dx*dy*dz — blank = 1)
    const one = () => 1;
    const mk = (label, s) => {
      if (!(s || '').trim()) return { fn: one };               // blank factor = 1 (no error)
      const v = validate(s, c.schema);
      if (!v.ok) throw new Error(`${label}: ${friendlyError(v.errors, c.schema)}`);
      return { fn: compile(s, c.schema, { decimal: c.d.decimal }) };
    };
    vol = mk('Volume', _gtConfig.volume); dens = mk('Density', _gtConfig.density); prop = mk('Ore proportion', _gtConfig.proportion);
    // declared density unit → t/m³ (a kg/m³ column no longer inflates tonnage 1000×)
    const dScale = unitConvert(1, _gtConfig.densityUnit || 't/m3', 't/m3');
    if (dScale !== 1) { const f0 = dens.fn; dens = { fn: (fields) => f0(fields) * dScale }; }
  } catch (e) { const r = $('#gtResults'); if (r) r.innerHTML = `<div style="color:var(--fault);margin-top:8px">${esc(e.message)}</div>`; return; }
  // per-grade custom cutoffs: comma/space-separated numbers → sorted unique; blank/junk = auto
  const parseCutoffs = (s) => {
    const nums = String(s || '').split(/[\s,;]+/).map((t) => parseFloat(t)).filter((v) => Number.isFinite(v));
    return nums.length ? [...new Set(nums)].sort((a, b) => a - b) : null;
  };
  const cfg = { group: _gtConfig.group, grades: _gtConfig.grades.slice(), gradeUnits: _gtConfig.gradeUnits.slice(), densityUnit: _gtConfig.densityUnit || 't/m3', cutoffs: _gtConfig.grades.map((g, gi) => parseCutoffs(_gtConfig.cutoffs[gi])), volExpr: _gtConfig.volume || '1', densExpr: _gtConfig.density || '1', propExpr: _gtConfig.proportion || '1' };
  const ac = newFooterScan();
  const rEl = $('#gtResults'); if (rEl) rEl.innerHTML = '<div style="color:#777;margin-top:8px">computing… <span id="scanPct">0%</span></div>';
  $('#meta').textContent = 'grade–tonnage…';
  try {
    const prog = (b, n) => { const p = n ? Math.round(100 * b / n) : 0; const e = $('#scanPct'); if (e) e.textContent = `${p}%`; $('#meta').textContent = `grade–tonnage… ${p}% · Esc to cancel`; };
    const filterRows = c.filterResult ? c.filterResult.nums : null;
    // pass 1 — the grouped report (also yields each grade's extents for the curve bins)
    const res = await scanGradeTonnage(c.source, {
      groupCol: cfg.group, gradeCols: cfg.grades, volume: vol, density: dens, proportion: prop,
      dataStart: c.dataStart, decimal: c.d.decimal, rows: filterRows, signal: ac.signal,
      onProgress: (b, n) => prog(b, n * 2),
    });
    if (ac.signal.aborted) return;
    // pass 2 — cutoff curves via sluice's gradeTonnage accumulators (skipped when no grade has a range)
    const curves = await scanGTCurves(c, cfg, { volume: vol, density: dens, proportion: prop }, res.total.grades,
      { rows: filterRows, signal: ac.signal, onProgress: (b, n) => prog(n + b, n * 2) });
    if (ac.signal.aborted) return;
    _gtResult = { ...res, curves, config: cfg };
    $('#meta').textContent = c._meta || '';
    paintGradeTonnage();
  } catch (e) {
    if (e && e.name === 'AbortError') { $('#meta').textContent = c._meta || 'cancelled'; const r = $('#gtResults'); if (r) r.innerHTML = '<div style="color:var(--dim);margin-top:8px">cancelled</div>'; }
    else { const r = $('#gtResults'); if (r) r.innerHTML = `<div style="color:var(--fault);margin-top:8px">${esc(e.message)}</div>`; }
  } finally { if (_footerScanAbort === ac) _footerScanAbort = null; }
}
function wireGradeTonnage(c) {
  const g = $('#gtGroup'); if (g) g.onchange = () => { _gtConfig.group = g.value === '' ? null : +g.value; };
  $('#helpBody').querySelectorAll('.gt-expr').forEach((inp) => { inp.oninput = () => { _gtConfig[inp.dataset.f] = inp.value; }; attachAutocomplete(inp, calcCtx); });
  $('#helpBody').querySelectorAll('.gt-grade').forEach((sel) => sel.onchange = () => { _gtConfig.grades[+sel.dataset.gi] = +sel.value; });
  $('#helpBody').querySelectorAll('.gt-unit').forEach((sel) => sel.onchange = () => { _gtConfig.gradeUnits[+sel.dataset.gi] = sel.value; });
  const du = $('#gtDensUnit'); if (du) du.onchange = () => { _gtConfig.densityUnit = du.value; };
  $('#helpBody').querySelectorAll('.gt-cut').forEach((inp) => inp.oninput = () => { _gtConfig.cutoffs[+inp.dataset.gi] = inp.value; });
  $('#helpBody').querySelectorAll('.gt-rng').forEach((inp) => { inp.oninput = () => { _gtConfig.ranges[+inp.dataset.gi] = inp.value; }; inp.onchange = () => { if (_gtResult) drawGTCurves(c); }; });
  $('#helpBody').querySelectorAll('.gt-rm').forEach((b) => b.onclick = () => { const gi = +b.dataset.gi; _gtConfig.grades.splice(gi, 1); _gtConfig.gradeUnits.splice(gi, 1); _gtConfig.cutoffs.splice(gi, 1); _gtConfig.ranges.splice(gi, 1); paintGradeTonnage(); });
  const add = $('#gtAdd'); if (add) add.onclick = () => { const fn = c.schema.findIndex((s) => s.type === 'number'); _gtConfig.grades.push(fn >= 0 ? fn : 0); _gtConfig.gradeUnits.push(''); _gtConfig.cutoffs.push(''); _gtConfig.ranges.push(''); paintGradeTonnage(); };
  const run = $('#gtRun'); if (run) run.onclick = () => computeGradeTonnage();
  $('#helpBody').querySelectorAll('.sum-tbl th[data-k]').forEach((th) => th.onclick = () => { const k = th.getAttribute('data-k'); if (_gtSort.col === k) _gtSort.dir *= -1; else _gtSort = { col: k, dir: k === 'key' ? 1 : -1 }; paintGradeTonnage(); });
  const cp = $('#gtCopy'); if (cp) cp.onclick = () => { copyText(gtTSV(c)); cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy all'; }, 1200); };
  $('#helpBody').querySelectorAll('.gt-cpng').forEach((b) => b.onclick = () => {
    const canvas = $('#helpBody').querySelector(`canvas.gt-curve[data-gi="${b.dataset.gi}"]`); if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); b.textContent = 'copied ✓'; }
      catch { b.textContent = 'copy failed'; }
      setTimeout(() => { b.textContent = 'copy png'; }, 1200);
    }, 'image/png');
  });
  $('#helpBody').querySelectorAll('.gt-ccopy:not(.gt-csave):not(.gt-cpng)').forEach((b) => b.onclick = () => {
    const gi = +b.dataset.gi, cv = _gtResult && _gtResult.curves && _gtResult.curves[gi]; if (!cv) return;
    const gn = c.schema[_gtResult.config.grades[gi]] ? c.schema[_gtResult.config.grades[gi]].name : '?';
    copyText(gtCurveTSV(cv, gn, _gtResult.config.gradeUnits && _gtResult.config.gradeUnits[gi])); b.textContent = 'copied ✓'; setTimeout(() => { b.textContent = 'copy'; }, 1200);
  });
  $('#helpBody').querySelectorAll('.gt-csave').forEach((b) => b.onclick = () => {
    const gi = +b.dataset.gi;
    const canvas = $('#helpBody').querySelector(`canvas.gt-curve[data-gi="${gi}"]`); if (!canvas) return;
    const gn = c.schema[_gtResult.config.grades[gi]] ? c.schema[_gtResult.config.grades[gi]].name : 'grade';
    const stem = String(c.label || 'file').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_');
    saveCanvasPng(canvas, `${stem}_gt_${gn}.png`);
  });
}

// ── grid summary — @gcu/recon's geometry inference (harvested from BMA) driven from
// lamina's record cursor: one windowed pass collecting per-axis coord material, then
// inferGeometry → origin / block size / count / coordinate ordering / sub-blocks. ──
let _gsConfig = null, _gsResult = null;
function openGridSummary() {
  const c = current; if (!c || c.d.kind !== 'delimited') return;
  const num = (re) => { const i = c.schema.findIndex((s) => s.type === 'number' && re.test(s.name)); return i >= 0 ? i : null; };
  _gsConfig = {
    x: num(/^(x|xc|xcent(er|re)?|xmid|east(ing)?|xpt)$/i),
    y: num(/^(y|yc|ycent(er|re)?|ymid|north(ing)?|ypt)$/i),
    z: num(/^(z|zc|zcent(er|re)?|zmid|elev(ation)?|rl|level)$/i),
    dx: num(/^(dx|xinc|xsize|xdim|dim_?x)$/i),
    dy: num(/^(dy|yinc|ysize|ydim|dim_?y)$/i),
    dz: num(/^(dz|zinc|zsize|zdim|dim_?z)$/i),
  };
  _gsResult = null;
  $('#helpTitle').textContent = `Grid summary — ${c.label}${c.filterResult ? ' (filtered)' : ''}`;
  $('.help-box').classList.add('wide');
  $('#help').classList.add('show');
  paintGridSummary();
}
function paintGridSummary() {
  const c = current; if (!c) return;
  const sel = (f, label) => {
    let h = `<label>${label} <select class="gs-col" data-f="${f}"><option value=""${_gsConfig[f] == null ? ' selected' : ''}>— none —</option>`;
    c.schema.forEach((s, i) => { if (s.type === 'number') h += `<option value="${i}"${i === _gsConfig[f] ? ' selected' : ''}>${esc(s.name)}</option>`; });
    return h + '</select></label>';
  };
  let h = '<div class="gb-form">';
  h += sel('x', 'X') + sel('y', 'Y') + sel('z', 'Z');
  h += sel('dx', 'dx') + sel('dy', 'dy') + sel('dz', 'dz');
  h += `<button id="gsRun" class="gb-run">Summarize</button>`;
  h += '</div>';
  h += `<div id="gsResults">${_gsResult ? renderGSResult(c) : '<div style="color:var(--dim);margin-top:8px">pick the centroid columns (dx/dy/dz optional — they override spacing inference), then Summarize</div>'}</div>`;
  $('#helpBody').innerHTML = h;
  $('#helpBody').querySelectorAll('.gs-col').forEach((s) => s.onchange = () => { _gsConfig[s.dataset.f] = s.value === '' ? null : +s.value; });
  const run = $('#gsRun'); if (run) run.onclick = () => computeGridSummary();
  const cp = $('#gsCopy'); if (cp) cp.onclick = () => { copyText(gsTSV(c)); cp.textContent = 'copied ✓'; setTimeout(() => { cp.textContent = 'copy all'; }, 1200); };
  $('#helpBody').querySelectorAll('.gs-v').forEach((td) => td.onclick = () => {
    const v = td.getAttribute('data-copy'); if (!v) return;
    copyText(v);
    td.classList.add('copied'); setTimeout(() => td.classList.remove('copied'), 700);
  });
}
async function computeGridSummary() {
  const c = current; if (!c) return;
  if (_gsConfig.x == null || _gsConfig.y == null) { const r = $('#gsResults'); if (r) r.innerHTML = '<div style="color:var(--fault);margin-top:8px">pick at least X and Y centroid columns</div>'; return; }
  const cols = {};   // recon takes column KEYS on the row object — use the axis names as keys
  for (const f of ['x', 'y', 'z', 'dx', 'dy', 'dz']) if (_gsConfig[f] != null) cols[f] = f;
  const acc = geometryAccumulator(cols);
  let s = acc.create(), rowsTotal = 0;
  const ac = newFooterScan();
  const rEl = $('#gsResults'); if (rEl) rEl.innerHTML = '<div style="color:#777;margin-top:8px">scanning… <span id="scanPct">0%</span></div>';
  $('#meta').textContent = 'grid summary…';
  try {
    const dec = c.d.decimal, cfg = _gsConfig;
    await c.source.eachRecord({
      dataStart: c.dataStart, rows: c.filterResult ? c.filterResult.nums : null, signal: ac.signal,
      onProgress: (b, n) => { const p = n ? Math.round(100 * b / n) : 0; const e = $('#scanPct'); if (e) e.textContent = `${p}%`; $('#meta').textContent = `grid summary… ${p}% · Esc to cancel`; },
    }, (disp, fields) => {
      rowsTotal++;
      const row = {};
      for (const f in cols) { const v = parseNum(fields[cfg[f]], dec); if (!Number.isNaN(v)) row[f] = v; }
      acc.push(s, row);
    });
    if (ac.signal.aborted) return;
    const accResult = acc.result(s);
    _gsResult = { facet: inferGeometry(accResult), accResult, rowsTotal, config: { ..._gsConfig } };
    $('#meta').textContent = c._meta || '';
    paintGridSummary();
  } catch (e) {
    if (e && e.name === 'AbortError') { $('#meta').textContent = c._meta || 'cancelled'; if (rEl) rEl.innerHTML = '<div style="color:var(--dim);margin-top:8px">cancelled</div>'; }
    else if (rEl) rEl.innerHTML = `<div style="color:var(--fault);margin-top:8px">${esc(e.message)}</div>`;
  } finally { if (_footerScanAbort === ac) _footerScanAbort = null; }
}
// The summary as data: an axis × parameter table + scalar key-values. All numbers RAW
// (String(v) — no thousands separators, no exponential) because every value is a
// click-to-copy destined for another package's dialog box.
function gsData(c) {
  const { facet, accResult, rowsTotal, config } = _gsResult;
  const name = (i) => (c.schema[i] ? c.schema[i].name : '?');
  const raw = (v) => (v == null ? '' : String(v));
  const gridded = facet.kind === 'gridded';
  const axes = [];
  if (gridded) {
    ['x', 'y', 'z'].forEach((a, i) => {
      const ax = accResult.axes[a];
      axes.push({ axis: a.toUpperCase(), col: name(config[a]), origin: raw(facet.origin[i]), size: raw(facet.size[i]), count: raw(facet.count[i]), min: raw(ax.min), max: raw(ax.max) });
    });
  } else {
    for (const a in accResult.axes) {
      const ax = accResult.axes[a];
      if (!ax.count) continue;
      axes.push({ axis: a.toUpperCase(), col: name(config[a]), origin: '', size: '', count: `${ax.values.length}${ax.overflow ? '+' : ''} distinct`, min: raw(ax.min), max: raw(ax.max) });
    }
  }
  const kv = [];
  if (gridded) {
    const [nx, ny, nz] = facet.count, cells = nx * ny * nz;
    const o = facet.order;
    kv.push(['ordering', `${o.fastest} fastest · ${o.middle} · ${o.slowest} slowest`, '']);
    kv.push(['parent cells', raw(cells), `${nx} × ${ny} × ${nz}`]);
    kv.push(['parent block volume', raw(facet.size[0] * facet.size[1] * facet.size[2]), '']);
    kv.push(['rows scanned', raw(rowsTotal), '']);
    const fill = cells ? rowsTotal / cells : 0;
    kv.push(['fill %', (100 * fill).toFixed(1), fill > 1 ? 'over 100% — sub-blocked or duplicate blocks' : '']);
    if (facet.subBlocked) {
      for (const a of ['x', 'y', 'z']) {
        const subs = facet.subBlocks && facet.subBlocks[a];
        if (subs && subs.length) kv.push([`${a.toUpperCase()} sub-blocks`, subs.map((sb) => `${sb.size} (÷${sb.ratio})`).join(' · '), '']);
      }
    }
  } else {
    kv.push(['grid', 'none detected', 'coordinates don\'t sit on one consistent spacing']);
    kv.push(['rows scanned', raw(rowsTotal), '']);
  }
  if (Object.values(accResult.axes).some((ax) => ax.overflow)) kv.push(['note', 'distinct-coordinate cap hit on an axis', 'inference used the capped set']);
  return { gridded, axes, kv };
}
function renderGSResult(c) {
  const { gridded, axes, kv } = gsData(c);
  const vcell = (v, num = true) => `<td class="${num ? 'num ' : ''}gs-v" data-copy="${esc(v)}" title="click to copy">${esc(v)}</td>`;
  let h = '<button id="gsCopy" class="sum-copy">copy all</button>';
  if (!gridded) h += '<div style="color:var(--accent);font-size:11px;margin:4px 0">no regular grid detected</div>';
  h += '<div style="overflow:auto;max-height:60vh;margin-top:4px;width:fit-content;max-width:100%">';
  h += '<table class="sum-tbl"><thead><tr><th>axis</th><th>column</th><th class="num">origin</th><th class="num">block size</th><th class="num">count</th><th class="num">min</th><th class="num">max</th></tr></thead><tbody>';
  for (const a of axes) h += `<tr><td>${esc(a.axis)}</td><td>${esc(a.col)}</td>${vcell(a.origin)}${vcell(a.size)}${vcell(a.count)}${vcell(a.min)}${vcell(a.max)}</tr>`;
  h += '</tbody></table>';
  h += '<table class="sum-tbl" style="margin-top:10px"><tbody>';
  for (const [k, v, note] of kv) h += `<tr><td style="color:var(--muted)">${esc(k)}</td>${vcell(v, false)}<td style="color:var(--dim)">${note ? esc(note) : ''}</td></tr>`;
  h += '</tbody></table></div>';
  h += '<div style="color:var(--dim);font-size:10px;margin-top:6px">click any value to copy it (raw, paste-ready)</div>';
  return h;
}
function gsTSV(c) {
  const { axes, kv } = gsData(c);
  const L = ['axis\tcolumn\torigin\tblock size\tcount\tmin\tmax'];
  for (const a of axes) L.push([a.axis, a.col, a.origin, a.size, a.count, a.min, a.max].join('\t'));
  L.push('');
  for (const [k, v, note] of kv) L.push(`${k}\t${v}${note ? '\t' + note : ''}`);
  return L.join('\n');
}

// A synthetic orebody block model generated in-page (networkless — no fetch, no bundled
// file) so a first-time visitor with nothing to open can see lamina work: coordinates,
// grades (Au/Cu/Ag/Fe), density + ore proportion (→ grade-tonnage), lithology + zone.
function openSampleData() {
  let s = 987654321;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff, s / 0x7fffffff);
  const randn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const nx = 60, ny = 50, nz = 40, x0 = 620000, y0 = 7780000, z0 = 400, cx = nx / 2, cy = ny / 2, cz = nz * 0.45;
  const rows = ['ID,X,Y,Z,dx,dy,dz,Au_gpt,Cu_pct,Ag_gpt,Fe_pct,density,ore_pct,recovery,LITO,ZONE'];
  let id = 1;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const dxi = (i - cx) / nx, dyj = (j - cy) / ny, dzk = (k - cz) / nz;
    const ore = Math.exp(-(dxi * dxi * 4 + dyj * dyj * 4 + dzk * dzk * 6) * 3);
    const cu = Math.max(0, ore * 1.8 * Math.exp(0.5 * randn()) - 0.02), au = Math.max(0, ore * 1.2 * Math.exp(0.6 * randn()) - 0.01);
    const ag = Math.max(0, cu * 8 * Math.exp(0.4 * randn())), fe = Math.max(1, 8 + ore * 12 + 2 * randn());
    const dens = 2.55 + ore * 0.35 + 0.03 * randn(), rec = Math.min(98, Math.max(60, 78 + ore * 14 + 2 * randn()));
    const orep = Math.min(1, Math.max(0, ore * 1.2)), depth = k / nz;
    const lito = (cu < 0.05 && au < 0.05) ? 'WASTE' : depth < 0.25 ? 'OXIDE' : depth < 0.45 ? 'TRANSITION' : 'SULPHIDE';
    rows.push([id++, x0 + i * 10, y0 + j * 10, z0 + k * 5, 10, 10, 5, au.toFixed(3), cu.toFixed(3), ag.toFixed(2), fe.toFixed(2), dens.toFixed(3), orep.toFixed(3), rec.toFixed(1), lito, 'Z' + (1 + Math.min(4, Math.floor(depth * 5)))].join(','));
  }
  open('sample_blockmodel.csv', new TextEncoder().encode(rows.join('\n')));
}

// Precompute exact stats for EVERY column in one BMA-style two-pass scan (moments +
// histogram; ≈ quantiles), filling the per-column cache so every popup is instant.
// Respects the current filter. Progress in the footer; Esc cancels. opts.show → open
// the column summary after (and skip the scan if every column is already cached).
async function precomputeStats(opts = {}) {
  const c = current; if (!c || c.d.kind !== 'delimited') return;
  const allCached = c._statsCache && c.schema.every((_, uc) => c._statsCache.has(`${uc}|0|0`));
  if (allCached) { if (opts.show) showSummary(); return; }   // cache already warm → no rescan
  const btn = $('#precomputeBtn'); if (btn) btn.classList.add('busy');
  const ac = newFooterScan();
  $('#meta').textContent = 'precomputing stats…';
  try {
    const all = await scanAllColumnStats(c.source, {
      schema: c.schema, dataStart: c.dataStart, decimal: c.d.decimal, rows: c.filterResult ? c.filterResult.nums : null, signal: ac.signal,
      onProgress: (b, n) => { $('#meta').textContent = `precomputing stats… ${n ? Math.round(100 * b / n) : 0}% · Esc to cancel`; },
    });
    if (ac.signal.aborted) return;
    c._statsCache = c._statsCache || new Map();
    let nfilled = 0;
    for (let uc = 0; uc < all.length; uc++) if (all[uc]) { c._statsCache.set(`${uc}|0|0`, all[uc]); nfilled++; }
    $('#meta').textContent = c._meta || `stats precomputed for ${nfilled} columns`;
    if (opts.show) showSummary();
  } catch (e) {
    if (e && e.name === 'AbortError') $('#meta').textContent = c._meta || 'precompute cancelled';
    else $('#meta').textContent = `precompute: ${e.message}`;
  } finally { if (_footerScanAbort === ac) _footerScanAbort = null; if (btn) btn.classList.remove('busy'); }
}

// ── drag-drop ──
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) { addRecent(f, null); openFile(f); }            // no FSAA handle from a drop → name-only recent
});

// ── filter box ──
// Set the filter box text so it lands in the input's native undo stack (Ctrl+Z
// restores the prior content) — a plain `.value =` bypasses undo. Used by the
// "Filter by <col>…" context action.
function setFilterText(text) {
  const inp = $('#filter');
  inp.focus();
  inp.select();
  if (!document.execCommand('insertText', false, text)) inp.value = text;   // fallback
  syncFilterClear();
}
function syncFilterClear() { $('#filterWrap').classList.toggle('has', $('#filter').value.length > 0); syncHL($('#filter'), $('#filterHL')); }
$('#filter').addEventListener('input', syncFilterClear);
$('#filter').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyFilter(e.target.value);
  else if (e.key === 'Escape') { e.target.value = ''; syncFilterClear(); applyFilter(''); e.target.blur(); }
});
$('#filterClear').onclick = () => { $('#filter').value = ''; syncFilterClear(); applyFilter(''); $('#filter').focus(); };
$('#filterGo').onclick = () => applyFilter($('#filter').value);

// ── global keys: Ctrl+O open, Esc closes the help overlay ──
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); pickFile(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openFind(); }
  else if (e.key === 'Escape') { $('#help').classList.remove('show'); closeCalcEditor(); closeCalcManager(); closeExportDialog(); }
});

window._lamina = { open, openFile, applyFilter, toggleSort, reopen, gotoRow, hideColumn, showColumn, showAllColumns, setColType, setColFormat, toggleColorScale, setColScaleOpt, autofitAll, resetColWidths, showAllColumns, toggleColPanel, reorderCol, togglePin, scrollToColumn, residentEstimate, statsToTSV, gutterSampleRows, scanColumnStats, scanAllColumnStats, scanGroupBy, scanDataQuality, precomputeStats, showSummary, openGroupBy, computeGroupBy, openGradeTonnage, computeGradeTonnage, openGridSummary, computeGridSummary, openSampleData, showDataQuality, setGutterLog, toggleRecordPanel, renderRecordCard, updateSelStats, openFind, closeFind, findNext, findCountAll, addRecent, clearRecents, setRemember, openRecent, get recents() { return _recents; }, showColumnStats, copySelection, filterByValue, addCalc, removeCalc, openCalcEditor, openCalcManager, brushFilter, showBrushTip, showGutterTip, gutterClick, gutterDblClick, gutterTapFilter, gutterBrush, setBrushMode, exportToString, openExportDialog, saveLens, buildLens, applyLensView, applyLens, applyLensFromFile, sniffLens, setTheme, get theme() { return theme; }, pickFile, showHelp, cache: idbCache, build: __LAMINA_BUILD__, get brushMode() { return brushMode; }, get grid() { return grid; }, get lastScan() { return lastScan; }, get current() { return current; }, get calcs() { return current && current.calcs; }, get gutter() { return current && current.gutter; }, canWorker };

// Build stamp in the footer (far right) — set once; persists past file meta updates.
$('#build').textContent = __LAMINA_BUILD__;
$('#build').title = `lamina build — ${__LAMINA_BUILD__} · verify at gentropic.org/security`;
applyTheme();                                          // sync data-theme + meta theme-color (the first-paint script set the attr; this keeps it authoritative)

// Keep --tb (the layout's top offset) synced to the toolbar's ACTUAL height, so
// everything below follows however the toolbar wraps on narrow / phone widths
// (one row on desktop, two-plus when the filter cluster drops below the menus).
{
  const tb = $('#toolbar');
  const syncTb = () => document.documentElement.style.setProperty('--tb', tb.offsetHeight + 'px');
  if (window.ResizeObserver) new ResizeObserver(syncTb).observe(tb); else window.addEventListener('resize', syncTb);
  syncTb();
}

// File Handling API: when the installed PWA is launched by opening a .lam/.lamina
// file (manifest file_handlers), the handle(s) arrive here. No-op in a normal tab.
if ('launchQueue' in window && 'LaunchParams' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    try { const h = params.files[0]; const f = await h.getFile(); addRecent(f, h); openFile(f); } catch { /* permission / not a file */ }
  });
}

refreshRecents();   // load the recents list (empty-state + File menu) on boot

// Jump-list "Open file…" shortcut (manifest shortcuts → ./?open=1): pop the
// picker on launch. Best-effort — the launch may not carry a user gesture, in
// which case the picker is declined silently and the user clicks File → Open.
if (new URLSearchParams(location.search).has('open')) {
  try { pickFile(); } catch { /* no activation on launch */ }
}
