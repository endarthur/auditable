// strata standalone app — wires the host seam to @gcu/strata + @gcu/loom.
//
// Dev-first: imports the ext libs as ES modules over http. The single-file PWA
// build (registry/import-map, like auditable) is a follow-up; until then this
// runs from a local server. app.js holds no environment branches — file I/O is
// the host's job — so the Works surface reuses this verbatim with a Works host.

import { createGrid } from '../../../ext/loom/index.js';
import { tableFromCsv, createTableProvider, createView, groupBy, readStrata, writeStrata } from '../../../ext/strata/index.js';
import { sniff } from '../../../ext/recon/index.js';
import { createWriter, readZip } from '../../../ext/archive/index.js';
import { createStandaloneHost } from './host.js';

const $ = (s) => document.querySelector(s);
const host = createStandaloneHost();

let table = null, provider = null, grid = null, view = null, docName = 'untitled';
let sortState = null;                 // { col, dir } — the click-to-sort cycle
let detailTable = null, detailName = null; // the pre-group table, for "← Data"

function stripExt(n) { return (n || 'untitled').replace(/\.[^.]+$/, ''); }

// A .strata is a zip (PK magic); a CSV/TSV is text. Decide by extension first,
// fall back to magic for extension-less drops.
function looksLikeStrata(name, bytes) {
  if (/\.strata$/i.test(name)) return true;
  if (/\.(csv|tsv|txt)$/i.test(name)) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
}

// Mount a StrataTable into a fresh view + provider + grid. Funnel for opening
// files, group-by results, and ungroup. Caller sets docName first.
function mountTable(t) {
  table = t;
  view = createView(table);
  sortState = null;
  $('#filter').value = '';
  $('#filter').classList.remove('err');
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

  setTitle();
  updateFooter();
  for (const id of ['#btnSave', '#btnSaveAs', '#btnAddCol', '#btnGroup']) $(id).disabled = false;
}

// Open bytes into a live grid. The single entry point — toolbar, drag-drop and
// the test hook all funnel here.
function openBytes(name, bytes) {
  let t;
  if (looksLikeStrata(name, bytes)) {
    const r = readStrata(bytes, { readZip });
    t = r.table;
    docName = r.document.name || stripExt(name);
  } else {
    t = tableFromCsv(new TextDecoder().decode(bytes), { sniff });
    docName = stripExt(name);
  }
  detailTable = null; detailName = null;
  $('#btnUngroup').style.display = 'none';
  mountTable(t);
  host.setDirty(false);
}

// Group-by → a summary table (count + mean of each numeric non-key column).
// Aggregates the currently filtered set (view.rows()). Keeps the detail table
// so "← Data" can return. Returns true on success.
function groupByColumn(keyName) {
  if (!table) return false;
  if (table.schema.findIndex((s) => s.name === keyName) < 0) { flash('no such column: ' + keyName); return false; }
  const aggs = [{ op: 'count', as: 'n' }];
  for (const s of table.schema) {
    if (s.name !== keyName && s.type === 'number') aggs.push({ op: 'mean', col: s.name });
  }
  let summary;
  try { summary = groupBy(table, { by: keyName, aggs }, view ? view.rows() : null); }
  catch (e) { flash('group error: ' + e.message); return false; }
  detailTable = table; detailName = docName;
  docName = `${docName} — by ${keyName}`;
  mountTable(summary);
  host.setDirty(true);
  $('#btnUngroup').style.display = '';
  return true;
}

function ungroup() {
  if (!detailTable) return;
  const t = detailTable;
  docName = detailName;
  detailTable = null; detailName = null;
  mountTable(t);
  $('#btnUngroup').style.display = 'none';
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
$('#btnGroup').onclick = () => {
  if (!table) return;
  const key = prompt('Group by column (count + mean of each numeric column):');
  if (!key || !key.trim()) return;
  groupByColumn(key.trim());
};
$('#btnUngroup').onclick = ungroup;
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
  groupByColumn,
  ungroup,
  get table() { return table; },
  get grid() { return grid; },
  get view() { return view; },
  get host() { return host; },
};
