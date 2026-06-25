// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, buildFileSource, buildStreamSource, buildSourceFromIndex, indexOf, fileKey, createRecordViewSource, parseFilter, scanFilter, createFilteredViewSource, scanSortKeys, createLaminaProvider } from '@gcu/lamina';
import { ProcessManager } from '@gcu/proc';
import { detectFormat, listZip, readZip, gunzipBytes } from '@gcu/archive';
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
  current = null; $('#filter').value = '';        // nothing filterable on a note panel
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
  const dataStart = kind === 'delimited' && d.hasHeader ? 1 : 0;
  const baseVs = createRecordViewSource(src, { schema, dataStart });
  current = { source: src, d, schema, dataStart, baseVs, label: name, totalBytes, filterMatches: null, sort: null };
  $('#filter').value = ''; $('#filter').classList.remove('err');     // fresh file → clear filter + sort
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
  const subset = c.filterMatches;                       // ascending display rows, or null = all
  if (c.sort) {
    $('#meta').textContent = 'sorting…';
    try {
      const numeric = (c.schema[c.sort.col] && c.schema[c.sort.col].type) === 'number';
      const order = await scanSortKeys(c.source, {
        col: c.sort.col, dir: c.sort.dir, dataStart: c.dataStart, numeric, rows: subset,
        onProgress: (b, n) => { $('#meta').textContent = `sorting… ${n ? Math.round((100 * b) / n) : 0}%`; },
      });
      view = createFilteredViewSource(c.baseVs, order);
      info = { filtered: !!subset, sorted: true };
    } catch (e) { $('#meta').textContent = `sort: ${e.message}`; c.sort = null; view = subset ? createFilteredViewSource(c.baseVs, subset) : c.baseVs; info = { filtered: !!subset }; }
  } else if (subset) {
    view = createFilteredViewSource(c.baseVs, subset);
    info = { filtered: true };
  }
  mountView(view, info);
}

// (Re)create the grid for a view + wire header-click sorting + update the footer.
function mountView(vs, info = {}) {
  if (grid) { grid.destroy(); grid = null; }
  const c = current;
  $('#fileName').textContent = c.label;
  $('#binary').style.display = 'none';
  $('#empty').style.display = 'none';
  const badge = $('#kindBadge'); badge.style.display = '';
  badge.textContent = c.d.kind === 'delimited' ? `CSV · ${c.d.delimiter === '\t' ? 'TSV' : 'delimited'}` : c.d.kind;

  // Provider with a sort indicator stamped onto the active column's header.
  const provider = createLaminaProvider(vs, { PENDING });
  const baseHeader = provider.header.bind(provider);
  provider.header = (col) => { const h = baseHeader(col); if (c.sort && c.sort.col === col) h.sort = c.sort.dir; return h; };

  grid = createGrid($('#grid'), provider, { readOnly: true, theme: 'dark', defaultColW: c.d.kind === 'text' ? 900 : 130 });
  if (c.d.kind === 'delimited') grid.onHeaderClick((col) => toggleSort(col));   // click a header to sort

  const shown = vs.rowCount();
  const base = c.baseVs.rowCount();
  let rows = info.filtered ? `${shown.toLocaleString()} of ${base.toLocaleString()} rows (filtered)` : `${shown.toLocaleString()} rows`;
  if (info.sorted) rows += ` · sorted ${c.sort.dir} by ${c.schema[c.sort.col].name}`;
  $('#meta').textContent = `${rows} × ${vs.cols} cols · ${fmtBytes(c.totalBytes)} · ${c.d.kind}`;
  window._laminaVS = vs;                                // automation hook
}

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
  if (!str.trim()) { $('#filter').classList.remove('err'); c.filterMatches = null; return recompute(); }
  const cols = c.d.kind === 'delimited' ? c.d.schema : [{ name: 'line' }];
  let predicate;
  try { predicate = parseFilter(str, cols); } catch (e) { return filterErr(e); }
  if (!predicate) { c.filterMatches = null; return recompute(); }
  $('#filter').classList.remove('err');
  $('#meta').textContent = 'filtering…';
  try {
    c.filterMatches = await scanFilter(c.source, {
      predicate, dataStart: c.dataStart,
      onProgress: (b, n) => { $('#meta').textContent = `filtering… ${n ? Math.round((100 * b) / n) : 0}%`; },
    });
    return recompute();
  } catch (e) { filterErr(e); }
}
function filterErr(e) { $('#filter').classList.add('err'); $('#meta').textContent = `filter: ${e.message}`; }

// Open raw bytes — memory source (the test hook + small files).
function open(name, bytes) {
  const d = detectKind(bytes.subarray(0, 65536));
  if (d.kind === 'binary') return showBinary(name, bytes.length);
  mount(name, d, buildMemorySource(bytes, { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"' }), bytes.length);
}

// Render in-memory bytes (a small file, or a decompressed archive entry) through
// the RESIDENT memory source — no streaming, no index cache.
function openInner(label, bytes) {
  const d = detectKind(bytes.subarray(0, 65536));
  if (d.kind === 'binary') return showBinary(label, bytes.length);
  lastScan = 'resident';
  mount(label, d, buildMemorySource(bytes, { kind: d.kind, delimiter: d.delimiter || ',', quote: d.quote || '"' }), bytes.length);
}

// ── archives (spec §7a): peek inside a zip / a .gz. Small archives decompress
// whole (RESIDENT — best UX). Large ones WINDOW the entry through the rewindable
// tape (no RAM/disk), keyed off the COMPRESSED size so we never load a huge zip. ──
async function openArchive(file, fmt) {
  $('#fileName').textContent = file.name; $('#empty').style.display = 'none';

  if (fmt === 'gz') {
    const innerLabel = `${file.name} › ${file.name.replace(/\.gz$/i, '')}`;
    const gzStream = () => file.stream().pipeThrough(new DecompressionStream('gzip'));
    if (file.size <= residentLimit()) {
      $('#meta').textContent = 'decompressing…';
      const inner = await gunzipBytes(new Uint8Array(await file.arrayBuffer()));
      return openInner(innerLabel, inner instanceof Uint8Array ? inner : new Uint8Array(inner));
    }
    return openStreamSource(file, innerLabel, gzStream, 'gz');           // huge → tape
  }

  // zip
  if (file.size <= residentLimit()) {
    $('#meta').textContent = 'decompressing…';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = listZip(bytes).filter((e) => e.type === 'file' && !e.path.endsWith('/'));
    if (!entries.length) return showNote(file.name, 'zip', 'empty archive', 'no files inside', `${fmtBytes(file.size)} · zip`);
    const openOne = (path) => { const inner = readZip(bytes, path); inner ? openInner(`${file.name} › ${path}`, inner) : showNote(file.name, 'zip', 'entry not found', path, '—'); };
    return entries.length === 1 ? openOne(entries[0].path) : showPicker(entries, openOne);
  }

  // huge zip → stream-enumerate (no full load), then window the chosen entry via the tape
  $('#meta').textContent = 'reading archive…';
  const entries = (await listZipStreaming(file)).filter((e) => !e.path.endsWith('/'));
  if (!entries.length) return showNote(file.name, 'zip', 'empty archive', 'no files inside', `${fmtBytes(file.size)} · zip`);
  const openOne = (path) => openStreamSource(file, `${file.name} › ${path}`, zipEntryStream(file, path), 'zip', path);
  return entries.length === 1 ? openOne(entries[0].path) : showPicker(entries, openOne);
}

// Build a windowed source over a re-openable decompressed stream (the tape). Peek
// the decompressed head to detect kind, reuse a cached index when present.
async function openStreamSource(file, label, openStream, badge, entryPath) {
  $('#fileName').textContent = label; $('#empty').style.display = 'none';
  const head = await readHead(openStream, 65536);
  const d = detectKind(head);
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
async function openFile(file) {
  // 0. Archive? Peek inside (resident tier). Sniff the head's magic bytes.
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const fmt = detectFormat(head);
  if (fmt === 'zip' || fmt === 'gz') return openArchive(file, fmt);

  // 1. Cache hit → rebuild the source from the stored index, no scan (instant).
  const key = fileKey(file);
  const cached = await idbCache.get(key);
  if (cached) {
    lastScan = 'cache';
    if (cached.detect.kind === 'binary') return showBinary(file.name, file.size);
    $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
    return mount(file.name, cached.detect, buildSourceFromIndex(file, cached.index), file.size);
  }

  // 2. Miss → detect off the head, scan (off-thread when we can), then cache.
  const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const d = detectKind(sample);
  if (d.kind === 'binary') { idbCache.set(key, { detect: d, index: null }); return showBinary(file.name, file.size); }
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
  idbCache.set(key, { detect: d, index: indexOf(src) });           // sidecar for next open (best-effort)
  mount(file.name, d, src, file.size);
}

// ── file pick ──
$('#btnOpen').onclick = async () => {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker();
      if (h) openFile(await h.getFile());
    } catch { /* cancelled */ }
  } else {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = () => { if (inp.files[0]) openFile(inp.files[0]); };
    inp.click();
  }
};

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
$('#filter').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyFilter(e.target.value);
  else if (e.key === 'Escape') { e.target.value = ''; applyFilter(''); e.target.blur(); }
});

window._lamina = { open, openFile, applyFilter, toggleSort, cache: idbCache, get grid() { return grid; }, get lastScan() { return lastScan; }, canWorker };
