// strata standalone app — wires the host seam to @gcu/strata + @gcu/loom.
//
// Dev-first: imports the ext libs as ES modules over http. The single-file PWA
// build (registry/import-map, like auditable) is a follow-up; until then this
// runs from a local server. app.js holds no environment branches — file I/O is
// the host's job — so the Works surface reuses this verbatim with a Works host.

import { createGrid } from '../../../ext/loom/index.js';
import { tableFromCsv, createTableProvider, readStrata, writeStrata } from '../../../ext/strata/index.js';
import { sniff } from '../../../ext/recon/index.js';
import { createWriter, readZip } from '../../../ext/archive/index.js';
import { createStandaloneHost } from './host.js';

const $ = (s) => document.querySelector(s);
const host = createStandaloneHost();

let table = null, provider = null, grid = null, docName = 'untitled';

function stripExt(n) { return (n || 'untitled').replace(/\.[^.]+$/, ''); }

// A .strata is a zip (PK magic); a CSV/TSV is text. Decide by extension first,
// fall back to magic for extension-less drops.
function looksLikeStrata(name, bytes) {
  if (/\.strata$/i.test(name)) return true;
  if (/\.(csv|tsv|txt)$/i.test(name)) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
}

// Open bytes into a live grid. The single entry point — toolbar, drag-drop and
// the test hook all funnel here.
function openBytes(name, bytes) {
  if (looksLikeStrata(name, bytes)) {
    const r = readStrata(bytes, { readZip });
    table = r.table;
    docName = r.document.name || stripExt(name);
  } else {
    table = tableFromCsv(new TextDecoder().decode(bytes), { sniff });
    docName = stripExt(name);
  }

  provider = createTableProvider(table);
  // Track dirty + footer on every commit (loom repaints on its own).
  const commit = provider.commit.bind(provider);
  provider.commit = (r, c, v) => { commit(r, c, v); host.setDirty(true); updateFooter(); };

  if (grid) grid.destroy();
  $('#empty').style.display = 'none';
  grid = createGrid($('#grid'), provider, { theme: 'dark', defaultColW: 92 });
  grid.onSelect(updateSel);
  grid.focus();

  host.setDirty(false);
  setTitle();
  updateFooter();
  $('#btnSave').disabled = false;
  $('#btnSaveAs').disabled = false;
}

async function buildStrataBytes() {
  return writeStrata(table, { createWriter, name: docName, source: 'strata-app' });
}

function setTitle() {
  document.title = `${docName} — strata`;
  $('#fileName').firstChild.textContent = docName;
}
function updateFooter() {
  if (!table) { $('#meta').textContent = 'no file'; return; }
  const units = table.schema.filter((s) => s.unit).map((s) => `${s.name}=${s.unit}`).join(' ');
  $('#meta').textContent = `${table.nrows.toLocaleString()} rows × ${table.cols} cols${units ? ' · ' + units : ''}`;
  $('#dirty').textContent = table.dirtyCount();
  $('#dot').style.visibility = host.dirty ? 'visible' : 'hidden';
}
function updateSel(s) {
  $('#sel').textContent = s
    ? `r${s.r0}:c${s.c0}` + (s.r0 !== s.r1 || s.c0 !== s.c1 ? ` → r${s.r1}:c${s.c1}` : '')
    : '—';
}

// ── toolbar ──
$('#btnOpen').onclick = async () => {
  const f = await host.open();
  if (f) openBytes(f.name, f.bytes);
};
$('#btnSave').onclick = async () => {
  if (!table) return;
  const msg = await host.save(docName + '.strata', await buildStrataBytes());
  if (msg) { updateFooter(); flash(msg); }
};
$('#btnSaveAs').onclick = async () => {
  if (!table) return;
  const msg = await host.saveAs(docName + '.strata', await buildStrataBytes());
  if (msg) { setTitle(); updateFooter(); flash(msg); }
};

function flash(msg) {
  const el = $('#meta'); const prev = el.textContent;
  el.textContent = msg;
  setTimeout(() => { updateFooter(); }, 1500);
  void prev;
}

// ── drag-drop ──
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
});

// ── test/automation hook (no UI dialogs) ──
window._strataApp = {
  open: openBytes,
  saveBytes: buildStrataBytes,
  get table() { return table; },
  get grid() { return grid; },
  get host() { return host; },
};
