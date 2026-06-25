// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, buildFileSource, createRecordViewSource, createLaminaProvider } from '@gcu/lamina';
import { ProcessManager } from '@gcu/proc';

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

function showBinary(name, totalBytes) {
  if (grid) { grid.destroy(); grid = null; }
  $('#fileName').textContent = name;
  $('#empty').style.display = 'none';
  $('#grid').innerHTML = '';
  $('#binary').style.display = 'flex';
  const badge = $('#kindBadge'); badge.style.display = ''; badge.textContent = 'binary';
  $('#meta').textContent = `${fmtBytes(totalBytes)} · binary`;
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

// Open a File — STREAMING source (never resident; the huge-file path). Detect off
// the head slice, then stream the whole to build the block index.
async function openFile(file) {
  const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const d = detectKind(sample);
  if (d.kind === 'binary') return showBinary(file.name, file.size);
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

window._lamina = { open, openFile, get grid() { return grid; }, get lastScan() { return lastScan; }, canWorker };
