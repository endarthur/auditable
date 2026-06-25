// lamina app — the standalone harness. Open any file → detect its kind → window
// it read-only: CSV/TSV in a loom grid, text in a one-wide-column line view,
// binary handed off to a hex viewer. Proto: a memory source (reads the whole file
// — fine for memory-sized files). The @gcu/proc streaming source (vfs.toFile →
// worker scan → vfs.readRange) swaps in behind the SAME shape for actually-huge.
//
// Bare @gcu/* specifiers resolve via the <import map> in index.html (a single-file
// build inlines them later).

import { createGrid, PENDING } from '@gcu/loom';
import { detectKind, buildMemorySource, createRecordViewSource, createLaminaProvider } from '@gcu/lamina';

const $ = (s) => document.querySelector(s);
let grid = null;

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// Open raw bytes (the single entry point — Open…, drag-drop, and the test hook).
function open(name, bytes) {
  if (grid) { grid.destroy(); grid = null; }
  $('#fileName').textContent = name;
  $('#binary').style.display = 'none';
  $('#empty').style.display = 'none';

  const d = detectKind(bytes.subarray(0, 65536));
  const badge = $('#kindBadge');
  badge.style.display = '';
  badge.textContent = d.kind === 'delimited' ? `CSV · ${d.delimiter === '\t' ? 'TSV' : 'delimited'}` : d.kind;

  if (d.kind === 'binary') {
    $('#grid').innerHTML = '';
    $('#binary').style.display = 'flex';
    $('#meta').textContent = `${fmtBytes(bytes.length)} · binary`;
    return;
  }

  const kind = d.kind;                                  // 'delimited' | 'text'
  const schema = kind === 'delimited' ? d.schema : [{ name: 'line', type: 'string' }];
  const dataStart = kind === 'delimited' && d.hasHeader ? 1 : 0;
  const src = buildMemorySource(bytes, { kind, delimiter: d.delimiter || ',', quote: d.quote || '"' });
  const vs = createRecordViewSource(src, { schema, dataStart });
  const provider = createLaminaProvider(vs, { PENDING });
  grid = createGrid($('#grid'), provider, { readOnly: true, theme: 'dark', defaultColW: kind === 'text' ? 900 : 130 });

  $('#meta').textContent = `${vs.rowCount().toLocaleString()} rows × ${vs.cols} cols · ${fmtBytes(bytes.length)} · ${d.kind}`;
  window._laminaVS = vs;                                // automation hook
}

async function openFile(file) {
  // Proto: read the whole file (memory-sized). Streaming source is increment 4.
  open(file.name, new Uint8Array(await file.arrayBuffer()));
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

window._lamina = { open, openFile, get grid() { return grid; } };
