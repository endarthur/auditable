// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, buildFileSource, buildStreamSource, buildSourceFromIndex, indexOf, fileKey, createRecordViewSource, scanFilter, createResultView, scanSortKeys, scanColumnStats, parseNum, createLaminaProvider, LOADING, withCalcCursor, withCalcView } from '@gcu/lamina';
import { compile, compileBool, validate, deps } from '@gcu/expr';   // the filter + calc-column language (superset of the old parseFilter — || / parens / functions / between, on top of && / == / ~ / in)
import { ProcessManager } from '@gcu/proc';
import { detectFormat, listZip, readZip, gunzipBytes, listTar, readTar, unzstdBytes, unxzBytes, unbz2Bytes } from '@gcu/archive';
import { detectDM, parseHeader, recordRange, decodeRecord } from '@gcu/dm';
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
  $('#filter').value = ''; $('#filter').classList.remove('err'); syncFilterClear();   // fresh file → clear filter + sort
  initCalcState();
  recompute();
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
  if (c.sort) {
    $('#meta').textContent = 'sorting…';
    try {
      const numeric = (c.schema[c.sort.col] && c.schema[c.sort.col].type) === 'number';
      const order = await scanSortKeys(c.source, {
        col: c.sort.col, dir: c.sort.dir, dataStart: c.dataStart, numeric, decimal: c.d.decimal, rows: fr ? fr.nums : null,
        onProgress: (b, n) => { $('#meta').textContent = `sorting… ${n ? Math.round((100 * b) / n) : 0}%`; },
      });
      view = createResultView(c.source, order, c.schema);
      info = { filtered: !!fr, sorted: true };
    } catch (e) { $('#meta').textContent = `sort: ${e.message}`; c.sort = null; view = fr ? createResultView(c.source, fr, c.schema) : c.baseVs; info = { filtered: !!fr }; }
  } else if (fr) {
    view = createResultView(c.source, fr, c.schema);
    info = { filtered: true };
  }
  mountView(view, info);
}

// (Re)create the grid for a view + wire header sort/context + column hide/show +
// update the footer. The provider is wrapped to (a) remap display columns past
// hidden ones and (b) stamp the sort arrow onto the active column.
function mountView(vs, info = {}) {
  captureWidths();                                       // persist the outgoing grid's column widths
  if (grid) { grid.destroy(); grid = null; }
  const c = current;
  c.view = vs; c.info = info;                           // remember for a cheap re-render (hide/show)
  $('#fileName').textContent = c.label;
  $('#binary').style.display = 'none';
  $('#empty').style.display = 'none';
  const badge = $('#kindBadge'); badge.style.display = '';
  badge.textContent = c.d.dm ? 'dm' : c.d.kind === 'delimited' ? `CSV · ${c.d.delimiter === '\t' ? 'TSV' : 'delimited'}` : c.d.kind;

  const base = createLaminaProvider(vs, { PENDING });
  const total = c.baseVs.cols;
  const vis = [];                                        // display col → underlying col (skipping hidden)
  for (let i = 0; i < total; i++) if (!c.hidden.has(i)) vis.push(i);
  c._vis = vis;
  const provider = {
    dims() { return { rows: vs.rowCount(), cols: vis.length }; },
    cellAt(r, dc) {
      const uc = vis[dc];
      const cell = base.cellAt(r, uc);
      const fmt = c.colFormats[uc];
      if (fmt && cell && typeof cell === 'object' && cell.type === 'number') {
        const num = parseNum(cell.value, c.d.decimal);
        if (!Number.isNaN(num)) { const t = fmtNumber(num, fmt); if (t != null) return { ...cell, style: { ...cell.style, text: t } }; }
      }
      return cell;
    },
    header(dc) { const uc = vis[dc]; const h = base.header(uc); if (c.sort && c.sort.col === uc) h.sort = c.sort.dir; return h; },
    rowHeader(r) { return base.rowHeader(r); },
    onReady(cb) { return base.onReady(cb); },
  };

  grid = createGrid($('#grid'), provider, { readOnly: true, theme: 'dark', defaultColW: c.d.kind === 'text' ? 900 : 130 });
  // reapply persisted column widths (stored by UNDERLYING col → display indices)
  const dw = {};
  for (let dc = 0; dc < vis.length; dc++) { const w = c.colWidths[vis[dc]]; if (w != null) dw[dc] = w; }
  if (Object.keys(dw).length) grid.setColWidths(dw);
  if (c.d.kind === 'delimited') {
    grid.onHeaderClick((dc) => toggleSort(vis[dc]));                                   // click → sort (underlying col)
    grid.onHeaderContextMenu(({ col, clientX, clientY }) => showColumnMenu(vis[col], clientX, clientY));
  }
  grid.onContextMenu(({ row, col, sel, clientX, clientY }) => showCellMenu(row, col, sel, clientX, clientY));

  const shownRows = vs.rowCount();
  const baseRows = c.baseVs.rowCount();
  let rows = info.filtered ? `${shownRows.toLocaleString()} of ${baseRows.toLocaleString()} rows (filtered)` : `${shownRows.toLocaleString()} rows`;
  if (info.sorted) rows += ` · sorted ${c.sort.dir} by ${c.schema[c.sort.col].name}`;
  const cols = c.hidden.size ? `${vis.length} of ${total} cols` : `${vis.length} cols`;
  const skipped = c.d.skip ? ` · ${c.d.skip} ${c.d.comment ? c.d.comment + '-' : ''}comment lines skipped` : '';
  const kindLabel = c.d.dm ? 'dm' : c.d.kind;
  c._meta = `${rows} × ${cols} · ${fmtBytes(c.totalBytes)} · ${kindLabel}${skipped}`;   // remembered so a copy-flash can restore it
  $('#meta').textContent = c._meta;
  window._laminaVS = vs;                                // automation hook
}

// Cheap re-render of the current view (after a column hide/show — the data view
// is unchanged, only which columns show).
function rerender() { if (current && current.view) mountView(current.view, current.info); }
// Override a column's detected type (number ↔ text). The schema array is shared
// live with the views, so this changes alignment + how stats/sort treat it;
// recompute re-applies a sort on that column under the new type.
function setColType(uc, type) {
  if (!current || !current.schema[uc]) return;
  current.schema[uc].type = type;
  recompute();
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
  const items = [
    { label: `Sort ${name} ↑`, action: () => { c.sort = { col: uc, dir: 'asc' }; recompute(); } },
    { label: `Sort ${name} ↓`, action: () => { c.sort = { col: uc, dir: 'desc' }; recompute(); } },
  ];
  if (c.sort && c.sort.col === uc) items.push({ label: 'Clear sort', action: () => { c.sort = null; recompute(); } });
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
function openLevel(items, x, y, level) {
  closeFrom(level);
  const m = document.createElement('div'); m.className = 'ctxmenu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const el = document.createElement('div'); el.className = 'item';
    const lab = document.createElement('span'); lab.textContent = it.label; el.appendChild(lab);
    if (it.submenu) {
      const arr = document.createElement('span'); arr.className = 'arr'; arr.textContent = '▸'; el.appendChild(arr);
      const open = () => { const r = el.getBoundingClientRect(); openLevel(it.submenu, r.right - 3, r.top - 5, level + 1); };
      el.onmouseenter = open;
      el.onclick = (e) => { e.stopPropagation(); open(); };
    } else {
      el.onmouseenter = () => closeFrom(level + 1);      // leaving the submenu-opener row closes the child
      el.onclick = () => { const r = el.getBoundingClientRect(); closeMenu(); it.action && it.action(r); };
    }
    m.appendChild(el);
  }
  document.body.appendChild(m);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  const r = m.getBoundingClientRect();                   // keep on-screen
  if (r.right > innerWidth) m.style.left = Math.max(0, x - r.width - (level ? 8 : 0)) + 'px';
  if (r.bottom > innerHeight) m.style.top = Math.max(0, innerHeight - r.height) + 'px';
  _menus[level] = m;
}
function closeFrom(level) { for (let i = _menus.length - 1; i >= level; i--) if (_menus[i]) _menus[i].remove(); _menus.length = Math.min(_menus.length, level); }
function closeMenu() { closeFrom(0); document.removeEventListener('mousedown', onDocDown); }
function onDocDown(e) { if (!_menus.some((m) => m && m.contains(e.target))) closeMenu(); }
function showMenu(x, y, items) { closeMenu(); openLevel(items, x, y, 0); setTimeout(() => document.addEventListener('mousedown', onDocDown), 0); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// Cycle a column's sort: none → asc → desc → none. Switching columns starts asc.
function toggleSort(col) {
  const c = current; if (!c) return;
  if (!c.sort || c.sort.col !== col) c.sort = { col, dir: 'asc' };
  else if (c.sort.dir === 'asc') c.sort = { col, dir: 'desc' };
  else c.sort = null;
  return recompute();
}

// Apply a filter expression (forward scan → matching rows), then recompute (sort
// re-applies over the new matches). Empty clears. Bad column/expr marks red.
async function applyFilter(str) {
  const c = current;
  if (!c) return;
  if (!str.trim()) { $('#filter').classList.remove('err'); c.filterResult = null; return recompute(); }
  const cols = c.d.kind === 'delimited' ? c.d.schema : [{ name: 'line' }];
  const v = validate(str, cols);                          // parse + unknown-column → red box, friendly message
  if (!v.ok) return filterErr(new Error(v.errors[0].message));
  let predicate;
  try { predicate = compileBool(str, cols, { decimal: c.d.decimal }); } catch (e) { return filterErr(e); }
  $('#filter').classList.remove('err');
  $('#meta').textContent = 'filtering…';
  try {
    c.filterResult = await scanFilter(c.source, {
      predicate, dataStart: c.dataStart,
      onProgress: (b, n) => { $('#meta').textContent = `filtering… ${n ? Math.round((100 * b) / n) : 0}%`; },
    });
    return recompute();
  } catch (e) { filterErr(e); }
}
function filterErr(e) { $('#filter').classList.add('err'); $('#meta').textContent = `filter: ${e.message}`; }

// Open raw bytes — memory source (the test hook + small files). `force` overrides
// auto-detection (the interpretation popover re-opens with it).
function open(name, bytes, force) {
  if (!force) {                                                        // Datamine .dm?
    const dmFmt = detectDM(bytes.subarray(0, Math.min(4096, bytes.length)));
    if (dmFmt) {
      try {
        const h = parseHeader(bytes, dmFmt);
        const reader = (off, len) => Promise.resolve(bytes.subarray(off, off + len));   // already resident
        return mountDm(name, reader, h, bytes.length);
      } catch { /* fall through */ }
    }
  }
  const d = detectKind(bytes.subarray(0, 65536), { force, name });
  if (d.kind === 'binary') return showBinary(name, bytes.length);
  mount(name, d, buildMemorySource(bytes, { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"' }), bytes.length);
  current.bytes = bytes; current.force = force || {};                 // remember for re-open with new force
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
function createDmCursor(reader, h, { chunk = 4096 } = {}) {
  const n = h.recordCount;
  return {
    kind: 'dm', rowCount: n, schema: h.schema, delimiter: '\t', quote: '"',
    async eachRecord({ dataStart = 0, rows = null, onProgress } = {}, visit) {
      let sp = 0;
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
          visit(disp, decodeRecord(bytes.subarray(r.offset - start, r.offset - start + r.length), h), i, 0);   // loc0 = record index
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
  $('#filter').value = ''; $('#filter').classList.remove('err'); syncFilterClear();
  lastScan = 'dm';
  initCalcState();
  recompute();
}

// ── calculated columns (read-time derived columns; @gcu/expr) ──────────────────
// Each is { name, expr, type }. They're NEVER materialized — applyCalcs rebuilds
// the cursor + browse view as calc-decorated wrappers over the pristine originals
// (kept as _src0 / _vs0 / _schema0), so filter / sort / stats / browse all see the
// derived columns. Session-only (lost on reload); a saved "lens" is a future step.

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
  const calcs = c.calcs;
  if (!calcs.length) {
    c.source = c._src0; c.baseVs = c._vs0; c.schema = c._schema0; c.d.schema = c._schema0;
  } else {
    const ext = [...c._schema0, ...calcs.map((x) => ({ name: x.name, type: x.type }))];
    const compiled = calcs.map((x) => ({ name: x.name, type: x.type, fn: compile(x.expr, ext, { decimal: c.d.decimal }) }));
    const baseCount = c._schema0.length;
    c.schema = ext; c.d.schema = ext;
    c.source = withCalcCursor(c._src0, baseCount, compiled);
    c.baseVs = withCalcView(c._vs0, baseCount, compiled);
  }
  if (c.sort && c.sort.col >= c.schema.length) c.sort = null;     // a removed calc → drop a now-dangling sort
  const box = $('#filter').value;                                 // a filter that referenced a removed calc → clear it (don't strand a red box)
  if (box.trim() && !validate(box, c.schema).ok) { $('#filter').value = ''; $('#filter').classList.remove('err'); syncFilterClear(); }
  return applyFilter($('#filter').value);                         // re-validate + re-run the filter, then recompute (sort)
}

// Programmatic add (the automation hook + the editor's commit share applyCalcs).
async function addCalc(name, expr) {
  const c = current; if (!c) return;
  c.calcs.push({ name, expr, type: await inferCalcType(expr, c.schema) });
  return applyCalcs();
}
function removeCalc(idx) { const c = current; if (!c) return; c.calcs.splice(idx, 1); return applyCalcs(); }

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

// ── the calc-column editor popover ──
let _calcEdit = null;                       // index being edited, or null (add mode)
let _calcDraft = { ok: false };             // { ok, name, expr, type } from the live preview

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
function closeCalcEditor() { $('#calcEditor').classList.remove('show'); document.removeEventListener('mousedown', onCalcDown); }
function onCalcDown(e) { if (!$('#calcEditor').contains(e.target)) closeCalcEditor(); }

// Live: validate name + expression, show deps, preview over the first visible rows.
async function previewCalc() {
  const c = current; if (!c) return;
  _calcDraft = { ok: false };
  const name = $('#ceName').value.trim();
  const expr = $('#ceExpr').value;
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
  if (!v.ok) { $('#ceExpr').classList.add('err'); status.className = 'ce-status err'; status.textContent = v.errors[0].message; prev.textContent = ''; $('#ceCommit').disabled = true; return; }

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

// Single-stream decoders that have NO browser streaming primitive (only gzip/
// deflate do via DecompressionStream) → resident-only, size-guarded.
const SINGLE_STREAM = { zst: unzstdBytes, xz: unxzBytes, bz2: unbz2Bytes };

// ── archives (spec §7a): peek inside zip / tar / gz / zst / xz / bz2. Small
// archives decompress whole (RESIDENT — best UX). A huge zip/gz WINDOWS the entry
// through the rewindable tape (no RAM/disk); zst/xz/bz2 have no browser streaming
// decoder so they stay resident (size-guarded). ──
async function openArchive(file, fmt) {
  $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
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

  if (SINGLE_STREAM[fmt]) {                                   // zst / xz / bz2 — resident only
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
  const d = detectKind(sample, { force, name: file.name });
  if (d.kind === 'binary') { if (!forced) idbCache.set(key, { v: CACHE_VERSION, detect: d, index: null }); return showBinary(file.name, file.size); }
  $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
  const opts = { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"' };
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

// Open the interpretation popover (delimiter / header / kind / skip / comment).
// Dismiss-on-outside is attached AFTER this click (setTimeout 0) so the very
// click that opens it — from the kind badge OR View → Interpretation — doesn't
// immediately close it.
function openOpts() {
  if (!current) return;
  const opts = $('#opts');
  if (opts.classList.contains('show')) return closeOpts();
  const f = current.force || {};
  $('#optKind').value = f.kind || '';
  $('#optDelim').value = f.delimiter || '';
  $('#optHeader').value = f.hasHeader === true ? 'yes' : f.hasHeader === false ? 'no' : '';
  $('#optSkip').value = f.skip != null ? f.skip : '';
  $('#optComment').value = f.comment != null ? f.comment : '';
  $('#optDecimal').value = f.decimal === ',' ? ',' : '';
  opts.classList.add('show');
  setTimeout(() => document.addEventListener('mousedown', onOptsDown), 0);
}
function closeOpts() { $('#opts').classList.remove('show'); document.removeEventListener('mousedown', onOptsDown); }
function onOptsDown(e) { if (!$('#opts').contains(e.target) && e.target.id !== 'kindBadge') closeOpts(); }
$('#kindBadge').onclick = () => openOpts();
$('#optKind').onchange = (e) => reopen({ kind: e.target.value });
$('#optDelim').onchange = (e) => reopen({ delimiter: e.target.value });
$('#optHeader').onchange = (e) => reopen({ hasHeader: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : '' });
$('#optSkip').onchange = (e) => reopen({ skip: e.target.value === '' ? '' : Math.max(0, e.target.value | 0) });   // '' = auto
$('#optComment').onchange = (e) => reopen({ comment: e.target.value });                                           // '' = none/auto
$('#optDecimal').onchange = (e) => reopen({ decimal: e.target.value });                                           // '' = point, ',' = comma

// Go to a 1-based row: select it (loom scrolls the selection into view).
function gotoRow(n) {
  if (!grid || !window._laminaVS) return;
  const row = Math.max(0, Math.min(window._laminaVS.rowCount() - 1, (n | 0) - 1));
  grid.setSelection({ r0: row, c0: 0, r1: row, c1: 0 });
  grid.focus();
}
$('#goto').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value) { gotoRow(Number(e.target.value)); } });

// ── file pick ──
// Type hints for the OS dialog (lamina still opens anything — All Files stays).
const PICK_TYPES = [
  { description: 'Tables', accept: { 'text/csv': ['.csv', '.tsv', '.tab', '.txt'], 'application/octet-stream': ['.dm', '.lam', '.lamina'] } },
  { description: 'Archives', accept: { 'application/octet-stream': ['.zip', '.tar', '.gz', '.zst', '.xz', '.bz2'] } },
];
async function pickFile() {
  if (window.showOpenFilePicker) {
    try { const [h] = await window.showOpenFilePicker({ types: PICK_TYPES }); if (h) openFile(await h.getFile()); } catch { /* cancelled */ }
  } else {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,.tsv,.tab,.txt,.dm,.lam,.lamina,.zip,.tar,.gz,.zst,.xz,.bz2';
    inp.onchange = () => { if (inp.files[0]) openFile(inp.files[0]); };
    inp.click();
  }
}

// ── menubar (File / View / Help) — reuses the showMenu helper, dark-themed ──
function menuAt(btn, items) { const r = btn.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, items); }
const hasFile = () => !!current;
$('#mFile').onclick = () => menuAt($('#mFile'), [
  { label: 'Open…    Ctrl+O', action: pickFile },
  { label: 'New window', action: () => window.open(location.href, '_blank') },
]);
$('#mView').onclick = () => menuAt($('#mView'), [
  { label: 'Interpretation (delimiter / header / skip)…', action: () => { if (hasFile()) openOpts(); } },
  { label: 'Add calculated column…', action: () => { if (hasFile()) openCalcEditor(null); } },
  { label: 'Go to row…', action: () => $('#goto').focus() },
  { sep: true },
  { label: 'Clear filter', action: () => { $('#filter').value = ''; syncFilterClear(); applyFilter(''); } },
  { label: 'Clear sort', action: () => { if (current) { current.sort = null; recompute(); } } },
  { sep: true },
  { label: 'Autofit all columns', action: () => autofitAll() },
  { label: 'Reset column widths', action: () => resetColWidths() },
  { label: 'Show all columns', action: () => showAllColumns() },
]);
$('#mHelp').onclick = () => menuAt($('#mHelp'), [
  { label: 'Getting started…', action: () => showHelp('start') },
  { label: 'Filter syntax…', action: () => showHelp('filter') },
  { label: 'Keyboard & mouse…', action: () => showHelp('keys') },
  { sep: true },
  { label: 'About lamina', action: () => showHelp('about') },
]);

// ── help overlay ──
const HELP = {
  start: ['Getting started',
    `<b>lamina</b> opens any file — even a multi-gigabyte one — and lets you scroll, filter, and sort it. It never loads the whole file, so size isn't the problem.<br><br>`
    + `<b>Open</b> — File → Open (<code>Ctrl+O</code>) or drag a file in. CSV/TSV → table · Datamine <code>.dm</code> → table · text → lines · binary → hex · <code>.zip</code>/<code>.tar</code>/<code>.gz</code>/<code>.zst</code>/<code>.xz</code>/<code>.bz2</code> → peek inside.<br><br>`
    + `<b>If a file reads wrong</b> — click the <b>kind badge</b> (top-right) or <b>View → Interpretation</b> to force the delimiter, header on/off, skip comment lines, or switch the decimal point/comma.<br><br>`
    + `<b>Most actions live in right-click menus:</b><br>`
    + `• <b>Right-click a column header</b> — Statistics · sort · filter by · number format · treat as text/number · hide/show · autofit · <b>add a calculated column</b>.<br>`
    + `• <b>Right-click a cell or selection</b> — copy (with header / row #) · filter by this value · column statistics.<br><br>`
    + `<b>Filter</b> in the box (Enter) — e.g. <code>grade > 1 && lito == "OXIDE"</code> (see Filter syntax). <b>Sort</b> by clicking a header. <b>Jump</b> with the row # box. In a column's Statistics, click values to build a set filter.<br><br>`
    + `<b>Calculated columns</b> — <b>View → Add calculated column…</b> (or a header's right-click). A derived column from a formula in the same language as the filter (<code>grade * density</code>, <code>if(au > 1, "ore", "waste")</code>); it's computed on the fly (never written), and you can filter, sort, and stat it like any column. Right-click its header to edit or remove it.`],
  filter: ['Filter syntax',
    `Type an expression in the <b>filter</b> box — <b>Enter</b> applies, <b>Esc</b> clears.<br><br>`
    + `A condition is <code>column OP value</code>, e.g. <code>grade > 1</code>.<br>`
    + `Operators: <code>==</code> <code>!=</code> <code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code> <code>~</code> (contains) <code>!~</code> (not contains).<br>`
    + `Combine with <code>&amp;&amp;</code> / <code>and</code> and <code>||</code> / <code>or</code>; group with parentheses: <code>(grade >= 1 || cu &gt; 0.3) && lito == "OXIDE"</code>.<br>`
    + `Ranges: <code>grade between 1 and 5</code>. Sets: <code>lito in "OXIDE", "SULF"</code> (or click values in a column's Statistics panel). Patterns: <code>hole matches "^DDH"</code>. Blanks: <code>au is blank</code> / <code>au is filled</code>.<br>`
    + `Functions: <code>round</code> <code>int</code> <code>abs</code> <code>sqrt</code> <code>log</code> <code>min</code> <code>max</code> <code>clamp</code> <code>if(c, a, b)</code> — e.g. <code>sqrt(au) > 0.5</code>.<br><br>`
    + `<b>Quote text values</b> — a bare word is a <i>column name</i> (so <code>fe &gt; cu</code> compares two columns), a quoted word is text: <code>lito == "OXIDE"</code>. Column names are case-insensitive; bracket awkward ones: <code>["Cu (ppm)"] &gt; 30</code>.<br>`
    + `Right-click a column header for <b>Filter by &lt;col&gt;…</b> to prefill it.`],
  keys: ['Keyboard & mouse',
    `<b>Ctrl+O</b> — open a file<br><b>Enter</b> / <b>Esc</b> in the filter box — apply / clear<br>`
    + `<b>Click a column header</b> — sort (cycles ascending → descending → off)<br>`
    + `<b>Right-click a column header</b> — statistics · sort · filter by · number format · treat as text/number · hide / show<br>`
    + `<b>Click the kind badge</b> (top right) — change how the file is read (delimiter, header, skip rows, comment)<br>`
    + `<b>Drag a column border</b> — resize · <b>double-click a border</b> — autofit that column · <b>View → Autofit all columns</b><br>`
    + `<b>row # box</b> — jump to a row<br>Selected cells <b>copy</b> as TSV (Ctrl+C).`],
  about: ['About lamina',
    `<b>lamina</b> — open any file, however large, and scroll, filter, and sort it. Windowed, read-only, offline.<br><br>`
    + `Delimited → grid, text → lines, binary → hex. Opens <b>Datamine .dm</b> tables directly — at any size, decoded on the fly (no conversion), with the same filter / sort / stats as CSV. Reads inside zip / tar / gz / zst / xz / bz2, and windows huge compressed entries without unpacking. Detects GSLIB / Geo-EAS + whitespace dumps and skips <code>#</code> comment preambles.<br><br>`
    + `Part of the Geoscientific Chaos Union — <code>gentropic.org</code>.<br><br>`
    + `<span style="color:#666">build <code>${__LAMINA_BUILD__}</code></span>`],
};
function showOverlay(title, html) {
  $('#helpTitle').textContent = title;
  $('#helpBody').innerHTML = html;
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

// ── column statistics (respects the current filter) ──
const fmtN = (x) => x == null ? '—' : (Math.abs(x) >= 1e6 || (x !== 0 && Math.abs(x) < 1e-4) ? x.toExponential(4) : (Number.isInteger(x) ? x.toLocaleString() : x.toPrecision(6).replace(/\.?0+$/, '')));
const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

function renderStats(st) {
  const row = (k, v) => `<tr><td style="color:#888;padding-right:18px">${k}</td><td style="text-align:right">${v}</td></tr>`;
  if (st.kind === 'number') {
    let h = '<table style="border-collapse:collapse">';
    h += row('count', st.count.toLocaleString()) + row('non-null', st.n.toLocaleString()) + row('nulls', st.nulls.toLocaleString());
    if (st.bad) h += row('<span style="color:#c89b3c">non-numeric</span>', `<span style="color:#c89b3c">${st.bad.toLocaleString()}</span>`);   // failed to parse
    h += row('min', fmtN(st.min)) + row('max', fmtN(st.max)) + row('mean', fmtN(st.mean)) + row('std', fmtN(st.std)) + row('sum', fmtN(st.sum));
    if (st.quantiles) {
      const q = st.quantiles;
      h += row('p5', fmtN(q.p5)) + row('p25', fmtN(q.p25)) + row('<b>median</b>', `<b>${fmtN(q.p50)}</b>`) + row('p75', fmtN(q.p75)) + row('p95', fmtN(q.p95));
    } else if (st.quantilesCapped) h += row('quantiles', '<span style="color:#777">too many values</span>');
    return h + '</table>';
  }
  let h = '<table style="border-collapse:collapse">';
  h += row('count', st.count.toLocaleString()) + row('nulls', st.nulls.toLocaleString()) + row('distinct', st.distinct.toLocaleString() + (st.cappedDistinct ? '+' : ''));
  h += '</table><div style="margin-top:12px;color:#888">top values <span style="color:#666">(click to toggle a filter set)</span></div><table style="border-collapse:collapse;margin-top:4px">';
  for (const t of st.top) {
    const pct = st.count ? (100 * t.n / st.count).toFixed(1) : '0';
    const v = esc(t.value).replace(/"/g, '&quot;');
    h += `<tr><td style="padding-right:18px;max-width:340px;overflow:hidden;text-overflow:ellipsis"><span class="sfilter" data-v="${v}">${esc(t.value)}</span></td><td style="text-align:right;color:#bbb">${t.n.toLocaleString()} <span style="color:#777">(${pct}%)</span></td></tr>`;
  }
  return h + '</table>';
}

let _statsCol = null;          // the column the open stats panel describes (for click-to-filter)
const _statsSelected = new Set();   // categorical values toggled in the panel → an `in` filter
async function showColumnStats(uc) {
  const c = current; if (!c) return;
  _statsCol = uc; _statsSelected.clear();
  const name = c.baseVs.header(uc).label;
  const numeric = (c.schema[uc] && c.schema[uc].type) === 'number';
  const suffix = c.filterResult ? ' (filtered)' : '';
  showOverlay(`Statistics — ${name}${suffix}`, '<div style="color:#777">computing… 0%</div>');
  try {
    const st = await scanColumnStats(c.source, {
      col: uc, dataStart: c.dataStart, numeric, decimal: c.d.decimal, rows: c.filterResult ? c.filterResult.nums : null,
      onProgress: (b, n) => { if ($('#help').classList.contains('show')) $('#helpBody').innerHTML = `<div style="color:#777">computing… ${n ? Math.round((100 * b) / n) : 0}%</div>`; },
    });
    showOverlay(`Statistics — ${name}${suffix}`, renderStats(st));
  } catch (e) { showOverlay(`Statistics — ${name}`, `<div style="color:#c0584a">${e.message}</div>`); }
}

// ── drag-drop ──
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
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
function syncFilterClear() { $('#filterWrap').classList.toggle('has', $('#filter').value.length > 0); }
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
  else if (e.key === 'Escape') { $('#help').classList.remove('show'); closeCalcEditor(); }
});

window._lamina = { open, openFile, applyFilter, toggleSort, reopen, gotoRow, hideColumn, showColumn, showAllColumns, setColType, setColFormat, autofitAll, resetColWidths, showColumnStats, copySelection, filterByValue, addCalc, removeCalc, openCalcEditor, pickFile, showHelp, cache: idbCache, build: __LAMINA_BUILD__, get grid() { return grid; }, get lastScan() { return lastScan; }, get current() { return current; }, get calcs() { return current && current.calcs; }, canWorker };

// Build stamp in the footer (far right) — set once; persists past file meta updates.
$('#build').textContent = __LAMINA_BUILD__;
$('#build').title = `lamina build — ${__LAMINA_BUILD__}`;

// File Handling API: when the installed PWA is launched by opening a .lam/.lamina
// file (manifest file_handlers), the handle(s) arrive here. No-op in a normal tab.
if ('launchQueue' in window && 'LaunchParams' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    try { openFile(await params.files[0].getFile()); } catch { /* permission / not a file */ }
  });
}

// Jump-list "Open file…" shortcut (manifest shortcuts → ./?open=1): pop the
// picker on launch. Best-effort — the launch may not carry a user gesture, in
// which case the picker is declined silently and the user clicks File → Open.
if (new URLSearchParams(location.search).has('open')) {
  try { pickFile(); } catch { /* no activation on launch */ }
}
