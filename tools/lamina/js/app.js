// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, buildFileSource, buildSourceFromIndex, indexOf, fileKey, createRecordViewSource, createLaminaProvider } from '@gcu/lamina';
import { ProcessManager } from '@gcu/proc';
import { detectFormat, listZip, readZip, gunzipBytes } from '@gcu/archive';
import { idbCache } from './idb-cache.js';

// Resident-zip ceiling: @gcu/archive reads whole-zip-in-memory today (no range
// reader), and a deflate entry can inflate to many× its stored size, so cap the
// outer archive. Huge-archive windowing is a later slice gated on an archive
// range-reader (spec §7a). 256 MB outer keeps us well under the buffer ceiling.
const MAX_RESIDENT_ARCHIVE = 256 * 1024 * 1024;

const $ = (s) => document.querySelector(s);
let grid = null;
let lastScan = null;            // 'worker' | 'inline' — which index-scan path the last openFile took (automation hook)

// ── off-thread index scan (a @gcu/proc module-call imports the lamina bundle and
// runs scanFileToIndex over File.stream(); the File crosses by reference, the
// ~1 MB index comes back). Keeps the tab responsive on tens-of-GB. On file://
// cross-blob workers are blocked, so we skip it; any worker failure falls back to
// the inline scan in openFile. ──
const LAMINA_URL = new URL('../../ext/lamina/index.js', document.baseURI).href;  // matches the import map (relative to the document, not js/app.js)
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

// Mount a built source (memory or streaming) read-only. The source shape is the
// same either way, so this is shared.
function mount(name, d, src, totalBytes) {
  if (grid) { grid.destroy(); grid = null; }
  $('#fileName').textContent = name;
  $('#binary').style.display = 'none';
  $('#empty').style.display = 'none';
  const badge = $('#kindBadge'); badge.style.display = '';
  badge.textContent = d.kind === 'delimited' ? `CSV · ${d.delimiter === '\t' ? 'TSV' : 'delimited'}` : d.kind;

  const kind = d.kind;                                  // 'delimited' | 'text'
  const schema = kind === 'delimited' ? d.schema : [{ name: 'line', type: 'string' }];
  const dataStart = kind === 'delimited' && d.hasHeader ? 1 : 0;
  const vs = createRecordViewSource(src, { schema, dataStart });
  grid = createGrid($('#grid'), createLaminaProvider(vs, { PENDING }), { readOnly: true, theme: 'dark', defaultColW: kind === 'text' ? 900 : 130 });
  $('#meta').textContent = `${vs.rowCount().toLocaleString()} rows × ${vs.cols} cols · ${fmtBytes(totalBytes)} · ${d.kind}`;
  window._laminaVS = vs;                                // automation hook
}

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

// ── archives (cheap RESIDENT tier, spec §7a): peek at a file inside a zip / a
// .gz stream. Whole-archive-in-memory (archive has no range reader yet), so it's
// guarded by size; huge-inner-file windowing is a later slice. ──
async function openArchive(file, fmt) {
  if (file.size > MAX_RESIDENT_ARCHIVE)
    return showNote(file.name, fmt, 'archive too large',
      `${fmtBytes(file.size)} — resident archive reading is memory-bound; huge-archive windowing is a later slice`,
      `${fmtBytes(file.size)} · ${fmt}`);
  $('#fileName').textContent = file.name; $('#empty').style.display = 'none';
  $('#meta').textContent = 'decompressing…';
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (fmt === 'gz') {
    const inner = await gunzipBytes(bytes);
    return openInner(`${file.name} › ${file.name.replace(/\.gz$/i, '')}`, inner instanceof Uint8Array ? inner : new Uint8Array(inner));
  }
  const entries = listZip(bytes).filter((e) => e.type === 'file' && !e.path.endsWith('/'));
  if (!entries.length) return showNote(file.name, 'zip', 'empty archive', 'no files inside', `${fmtBytes(file.size)} · zip`);
  if (entries.length === 1) return openZipEntry(file.name, bytes, entries[0].path);
  showPicker(entries, (path) => openZipEntry(file.name, bytes, path));   // many → choose one
}

function openZipEntry(archiveName, bytes, path) {
  const inner = readZip(bytes, path);
  if (!inner) return showNote(archiveName, 'zip', 'entry not found', path, '—');
  openInner(`${archiveName} › ${path}`, inner);
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

window._lamina = { open, openFile, cache: idbCache, get grid() { return grid; }, get lastScan() { return lastScan; }, canWorker };
