// strata standalone app — wires the host seam to @gcu/strata + @gcu/loom.
//
// Dev-first: imports the ext libs as ES modules over http. The single-file PWA
// build (registry/import-map, like auditable) is a follow-up; until then this
// runs from a local server. app.js holds no environment branches — file I/O is
// the host's job — so the Works surface reuses this verbatim with a Works host.

import { createGrid } from '../../../ext/loom/index.js';
import { tableFromCsv, createTableProvider, createView, readStrata, writeStrata } from '../../../ext/strata/index.js';
import { sniff } from '../../../ext/recon/index.js';
import { createWriter, readZip } from '../../../ext/archive/index.js';
import { createStandaloneHost } from './host.js';

const $ = (s) => document.querySelector(s);
const host = createStandaloneHost();

let table = null, provider = null, grid = null, view = null, docName = 'untitled';
let sortState = null; // { col, dir } — the click-to-sort cycle

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

  view = createView(table);
  sortState = null;
  $('#filter').value = '';
  provider = createTableProvider(table, view);
  // Track dirty + footer on every commit (loom repaints on its own).
  const commit = provider.commit.bind(provider);
  provider.commit = (r, c, v) => { commit(r, c, v); host.setDirty(true); updateFooter(); };

  if (grid) grid.destroy();
  $('#empty').style.display = 'none';
  grid = createGrid($('#grid'), provider, { theme: 'dark', defaultColW: 92 });
  grid.onSelect(updateSel);
  grid.onHeaderClick(cycleSort);
  grid.focus();

  host.setDirty(false);
  setTitle();
  updateFooter();
  $('#btnSave').disabled = false;
  $('#btnSaveAs').disabled = false;
  $('#btnAddCol').disabled = false;
}

// Add a derived column (a JS formula over column names). Returns true on success.
function addColumn(name, formula) {
  if (!table) return false;
  try {
    table.addDerivedColumn({ name, formula });
    host.setDirty(true);
    grid.refresh();
    updateFooter();
    flash(`+ ${name} = ${formula}`);
    return true;
  } catch (e) {
    flash('formula error: ' + e.message);
    return false;
  }
}

async function buildStrataBytes() {
  return writeStrata(table, { createWriter, name: docName, source: 'strata-app' });
}

// Click a column header → cycle its sort: none → asc → desc → none.
function cycleSort(col) {
  if (!view) return;
  if (!sortState || sortState.col !== col) sortState = { col, dir: 'asc' };
  else if (sortState.dir === 'asc') sortState.dir = 'desc';
  else sortState = null;
  view.setSort(sortState ? { by: table.schema[col].name, dir: sortState.dir } : null);
  grid.refresh();
  updateFooter();
}

// Apply the filter box (a boolean formula over columns). Returns true on success.
function applyFilter(formula) {
  if (!view) return false;
  try {
    view.setFilter(formula || null);
    $('#filter').classList.remove('err');
    grid.refresh();
    updateFooter();
    return true;
  } catch (e) {
    $('#filter').classList.add('err');
    flash('filter error: ' + e.message);
    return false;
  }
}

function setTitle() {
  document.title = `${docName} — strata`;
  $('#fileName').firstChild.textContent = docName;
}
function updateFooter() {
  if (!table) { $('#meta').textContent = 'no file'; return; }
  const shown = view ? view.length : table.nrows;
  const total = table.nrows;
  const rowsStr = shown !== total
    ? `${shown.toLocaleString()} / ${total.toLocaleString()} rows`
    : `${total.toLocaleString()} rows`;
  const sortStr = sortState ? ` · sort ${table.schema[sortState.col].name} ${sortState.dir === 'desc' ? '↓' : '↑'}` : '';
  const units = table.schema.filter((s) => s.unit).map((s) => `${s.name}=${s.unit}`).join(' ');
  $('#meta').textContent = `${rowsStr} × ${table.cols} cols${sortStr}${units ? ' · ' + units : ''}`;
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
$('#filter').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyFilter(e.target.value.trim());
});
$('#btnAddCol').onclick = () => {
  if (!table) return;
  const name = prompt('New column name:');
  if (!name || !name.trim()) return;
  const formula = prompt(`Formula for "${name.trim()}" — JS over column names, e.g. grade * tonnes:`);
  if (!formula || !formula.trim()) return;
  addColumn(name.trim(), formula.trim());
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
  addColumn,
  applyFilter,
  cycleSort,
  get table() { return table; },
  get grid() { return grid; },
  get view() { return view; },
  get host() { return host; },
};
