// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, buildFileSource, buildStreamSource, buildSourceFromIndex, indexOf, fileKey, createRecordViewSource, parseFilter, scanFilter, createResultView, scanSortKeys, scanColumnStats, createLaminaProvider } from '@gcu/lamina';
import { ProcessManager } from '@gcu/proc';
import { detectFormat, listZip, readZip, gunzipBytes, listTar, readTar, unzstdBytes, unxzBytes, unbz2Bytes } from '@gcu/archive';
import { Unzip, UnzipInflate } from 'fflate';
import { idbCache } from './idb-cache.js';

// Below this COMPRESSED size we decompress the archive whole (resident — best UX:
// true random access + cacheable index). Above it we WINDOW the entry through the
// rewindable tape (buildStreamSource): no RAM/disk blowup, forward-cheap, far-seek
// rewinds. (spec §7a — the third backing between resident and materialized-OPFS.)
const RESIDENT_LIMIT = 32 * 1024 * 1024;
const residentLimit = () => (typeof window.__LAMINA_RESIDENT_LIMIT__ === 'number' ? window.__LAMINA_RESIDENT_LIMIT__ : RESIDENT_LIMIT);

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
        col: c.sort.col, dir: c.sort.dir, dataStart: c.dataStart, numeric, rows: fr ? fr.nums : null,
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
  badge.textContent = c.d.kind === 'delimited' ? `CSV · ${c.d.delimiter === '\t' ? 'TSV' : 'delimited'}` : c.d.kind;

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
        const num = Number(cell.value);
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

  const shownRows = vs.rowCount();
  const baseRows = c.baseVs.rowCount();
  let rows = info.filtered ? `${shownRows.toLocaleString()} of ${baseRows.toLocaleString()} rows (filtered)` : `${shownRows.toLocaleString()} rows`;
  if (info.sorted) rows += ` · sorted ${c.sort.dir} by ${c.schema[c.sort.col].name}`;
  const cols = c.hidden.size ? `${vis.length} of ${total} cols` : `${vis.length} cols`;
  $('#meta').textContent = `${rows} × ${cols} · ${fmtBytes(c.totalBytes)} · ${c.d.kind}`;
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
function showFormatMenu(uc, x, y) {
  const set = (fmt) => setColFormat(uc, fmt);
  showMenu(x, y, [
    { label: 'Auto', action: () => set(null) },
    { label: '0 decimals', action: () => set({ mode: 'fixed', digits: 0 }) },
    { label: '2 decimals', action: () => set({ mode: 'fixed', digits: 2 }) },
    { label: '3 decimals', action: () => set({ mode: 'fixed', digits: 3 }) },
    { label: '4 decimals', action: () => set({ mode: 'fixed', digits: 4 }) },
    { label: 'Scientific', action: () => set({ mode: 'sci', digits: 3 }) },
    { label: 'Thousands (1,234)', action: () => set({ mode: 'group' }) },
  ]);
}
function hideColumn(uc) { if (current) { current.hidden.add(uc); rerender(); } }
function showColumn(uc) { if (current) { current.hidden.delete(uc); rerender(); } }
function showAllColumns() { if (current) { current.hidden.clear(); rerender(); } }
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
  items.push({ label: `Filter by ${name}…`, action: () => setFilterText(`${name} `) });
  const isNum = c.schema[uc] && c.schema[uc].type === 'number';       // force-type override (fixes a mis-detected column)
  items.push(isNum ? { label: 'Treat as text', action: () => setColType(uc, 'string') }
                   : { label: 'Treat as number', action: () => setColType(uc, 'number') });
  if (isNum) items.push({ label: 'Number format ▸', action: (r) => showFormatMenu(uc, r.right, r.top) });
  items.push({ sep: true }, { label: `Hide ${name}`, action: () => hideColumn(uc) });
  for (let i = 0; i < c.baseVs.cols; i++) {
    if (c.hidden.has(i)) items.push({ label: `Show ${c.baseVs.header(i).label}`, action: () => showColumn(i) });
  }
  if (c.hidden.size) items.push({ label: 'Show all columns', action: () => showAllColumns() });
  items.push({ sep: true }, { label: 'Autofit all columns', action: () => autofitAll() });
  showMenu(x, y, items);
}

// A lightweight context menu (items: {label, action} | {sep:true}).
function showMenu(x, y, items) {
  closeMenu();
  const m = document.createElement('div'); m.id = 'ctxmenu';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const el = document.createElement('div'); el.className = 'item'; el.textContent = it.label;
    el.onclick = () => { const r = el.getBoundingClientRect(); closeMenu(); it.action(r); };   // rect → submenus can anchor
    m.appendChild(el);
  }
  m.style.left = x + 'px'; m.style.top = y + 'px';
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();                  // keep on-screen
  if (r.right > innerWidth) m.style.left = Math.max(0, x - r.width) + 'px';
  if (r.bottom > innerHeight) m.style.top = Math.max(0, y - r.height) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
}
function onDocDown(e) { const m = document.getElementById('ctxmenu'); if (m && !m.contains(e.target)) closeMenu(); }
function closeMenu() { const m = document.getElementById('ctxmenu'); if (m) m.remove(); document.removeEventListener('mousedown', onDocDown); }
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
  let predicate;
  try { predicate = parseFilter(str, cols); } catch (e) { return filterErr(e); }
  if (!predicate) { c.filterResult = null; return recompute(); }
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
  if (cached && cached.index) {
    lastScan = 'cache';
    src = await buildStreamSource({ openStream, index: cached.index, ...opts });
  } else {
    lastScan = 'stream';
    $('#meta').textContent = 'indexing…';
    src = await buildStreamSource({ openStream, ...opts });
    idbCache.set(key, { detect: d, index: indexOf(src) });               // best-effort sidecar
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
  }

  // 1. Cache hit → rebuild the source from the stored index, no scan (instant).
  const key = fileKey(file);
  const cached = forced ? null : await idbCache.get(key);
  if (cached) {
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
  if (d.kind === 'binary') { if (!forced) idbCache.set(key, { detect: d, index: null }); return showBinary(file.name, file.size); }
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
  if (!forced) idbCache.set(key, { detect: d, index: indexOf(src) });   // cache only the auto interpretation
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

// Go to a 1-based row: select it (loom scrolls the selection into view).
function gotoRow(n) {
  if (!grid || !window._laminaVS) return;
  const row = Math.max(0, Math.min(window._laminaVS.rowCount() - 1, (n | 0) - 1));
  grid.setSelection({ r0: row, c0: 0, r1: row, c1: 0 });
  grid.focus();
}
$('#goto').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value) { gotoRow(Number(e.target.value)); } });

// ── file pick ──
async function pickFile() {
  if (window.showOpenFilePicker) {
    try { const [h] = await window.showOpenFilePicker(); if (h) openFile(await h.getFile()); } catch { /* cancelled */ }
  } else {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = () => { if (inp.files[0]) openFile(inp.files[0]); };
    inp.click();
  }
}

// ── menubar (File / View / Help) — reuses the showMenu helper, dark-themed ──
function menuAt(btn, items) { const r = btn.getBoundingClientRect(); showMenu(r.left, r.bottom + 2, items); }
const hasFile = () => !!current;
$('#mFile').onclick = () => menuAt($('#mFile'), [
  { label: 'Open…    Ctrl+O', action: pickFile },
]);
$('#mView').onclick = () => menuAt($('#mView'), [
  { label: 'Interpretation (delimiter / header / skip)…', action: () => { if (hasFile()) openOpts(); } },
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
  { label: 'Filter syntax…', action: () => showHelp('filter') },
  { label: 'Keyboard & mouse…', action: () => showHelp('keys') },
  { sep: true },
  { label: 'About lamina', action: () => showHelp('about') },
]);

// ── help overlay ──
const HELP = {
  filter: ['Filter syntax',
    `Type an expression in the <b>filter</b> box — <b>Enter</b> applies, <b>Esc</b> clears.<br><br>`
    + `A condition is <code>column OP value</code>, e.g. <code>grade > 1</code>.<br>`
    + `Operators: <code>==</code> <code>!=</code> <code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code> <code>~</code> (contains) <code>!~</code> (not contains).<br>`
    + `Combine with <code>&amp;&amp;</code> — all must hold: <code>grade >= 1 && lito == OXIDE</code>.<br><br>`
    + `Values that look numeric compare numerically, otherwise as text. Column names are case-insensitive; quote values with spaces: <code>name == "Main Zone"</code>.<br>`
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
    + `Delimited → grid, text → lines, binary → hex. Reads inside zip / tar / gz / zst / xz / bz2, and windows huge compressed entries without unpacking. Detects GSLIB / Geo-EAS + whitespace dumps and skips <code>#</code> comment preambles.<br><br>`
    + `Part of the Geoscientific Chaos Union — <code>gentropic.org</code>.`],
};
function showOverlay(title, html) {
  $('#helpTitle').textContent = title;
  $('#helpBody').innerHTML = html;
  $('#help').classList.add('show');
}
function showHelp(topic) { const [title, body] = HELP[topic] || HELP.about; showOverlay(title, body); }
$('#helpClose').onclick = () => $('#help').classList.remove('show');
$('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').classList.remove('show'); };

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
  h += '</table><div style="margin-top:12px;color:#888">top values</div><table style="border-collapse:collapse;margin-top:4px">';
  for (const t of st.top) {
    const pct = st.count ? (100 * t.n / st.count).toFixed(1) : '0';
    h += `<tr><td style="color:#ddd;padding-right:18px;max-width:340px;overflow:hidden;text-overflow:ellipsis">${esc(t.value)}</td><td style="text-align:right;color:#bbb">${t.n.toLocaleString()} <span style="color:#777">(${pct}%)</span></td></tr>`;
  }
  return h + '</table>';
}

async function showColumnStats(uc) {
  const c = current; if (!c) return;
  const name = c.baseVs.header(uc).label;
  const numeric = (c.schema[uc] && c.schema[uc].type) === 'number';
  const suffix = c.filterResult ? ' (filtered)' : '';
  showOverlay(`Statistics — ${name}${suffix}`, '<div style="color:#777">computing…</div>');
  try {
    const st = await scanColumnStats(c.source, { col: uc, dataStart: c.dataStart, numeric, rows: c.filterResult ? c.filterResult.nums : null });
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

// ── global keys: Ctrl+O open, Esc closes the help overlay ──
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); pickFile(); }
  else if (e.key === 'Escape') $('#help').classList.remove('show');
});

window._lamina = { open, openFile, applyFilter, toggleSort, reopen, gotoRow, hideColumn, showColumn, showAllColumns, setColType, setColFormat, autofitAll, resetColWidths, showColumnStats, pickFile, showHelp, cache: idbCache, get grid() { return grid; }, get lastScan() { return lastScan; }, get current() { return current; }, canWorker };
