// strata app core — host-agnostic. The SAME core runs standalone and as a Works
// surface; the only thing that differs is the `host` it's handed (file I/O,
// title, dirty, flush). createStrataApp(host) wires the toolbar + grid against a
// host implementing the small strata host interface (the contract + rationale
// live in ../HOST.md — the seed of @gcu/surface; js/host.js is the standalone
// adapter). No environment branches live here.
//
// Imports are bare @gcu/* specifiers: resolved by an <import map> in index.html
// when standalone, inlined by the works build when a surface. So this file is
// Works-ready as-is.

import { createGrid } from '@gcu/loom';
import { tableFromCsv, createTableProvider, createView, groupBy, readStrata, writeStrata } from '@gcu/strata';
import { sniff } from '@gcu/recon';
import { createWriter, readZip } from '@gcu/archive';

const $ = (s) => document.querySelector(s);

function stripExt(n) { return (n || 'untitled').replace(/\.[^.]+$/, ''); }

// A .strata is a zip (PK magic); a CSV/TSV is text. Decide by extension first,
// fall back to magic for extension-less inputs.
function looksLikeStrata(name, bytes) {
  if (/\.strata$/i.test(name)) return true;
  if (/\.(csv|tsv|txt)$/i.test(name)) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
}

/**
 * Build the strata app against a host.
 * @param {object} host  the strata host interface (js/host.js):
 *   open() · save(name,bytes) · saveAs(name,bytes) · setDirty(b) ·
 *   setTitle(name) · onFlush(cb) · .dirty
 * @returns the app handle (also stored on window._strataApp for automation).
 */
export function createStrataApp(host) {
  let table = null, provider = null, grid = null, view = null, docName = 'untitled';
  let sortState = null;                       // { col, dir } — the click-to-sort cycle
  let detailTable = null, detailName = null;  // the pre-group table, for "← Data"

  // ── mounting ──
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

  // Open bytes into a live grid. The single entry point — toolbar, drag-drop,
  // the Works file read, and the test hook all funnel here.
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

  // Group-by → a summary table (count + mean of each numeric non-key column),
  // over the currently filtered set. Keeps the detail table so "← Data" returns.
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

  // Add a derived column (a JS formula over column names).
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

  function buildStrataBytes() {
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

  // Apply the filter box (a boolean formula over columns).
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

  // ── chrome ──
  function setTitle() {
    $('#fileName').firstChild.textContent = docName;  // app's own filename display
    host.setTitle(docName);                           // environment title (tab / window)
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
  function flash(msg) {
    $('#meta').textContent = msg;
    setTimeout(updateFooter, 1500);
  }

  // ── toolbar / input wiring ──
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
  $('#filter').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilter(e.target.value.trim()); });
  $('#btnGroup').onclick = () => {
    if (!table) return;
    const key = prompt('Group by column (count + mean of each numeric column):');
    if (key && key.trim()) groupByColumn(key.trim());
  };
  $('#btnUngroup').onclick = ungroup;
  $('#btnAddCol').onclick = () => {
    if (!table) return;
    const name = prompt('New column name:');
    if (!name || !name.trim()) return;
    const formula = prompt(`Formula for "${name.trim()}" — JS over column names, e.g. grade * tonnes:`);
    if (formula && formula.trim()) addColumn(name.trim(), formula.trim());
  };

  // ── drag-drop ──
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
  });

  // The host's save-now handler (Works Surface.Flush calls it; standalone may
  // wire beforeunload). Writes the current doc through the host.
  host.onFlush(async () => {
    if (!table) return;
    await host.save(docName + '.strata', await buildStrataBytes());
    updateFooter();
  });

  const app = {
    open: openBytes,
    openFile: (name, bytes) => openBytes(name, bytes),
    saveBytes: buildStrataBytes,
    addColumn, applyFilter, cycleSort, groupByColumn, ungroup,
    get table() { return table; },
    get grid() { return grid; },
    get view() { return view; },
    get host() { return host; },
  };
  window._strataApp = app;   // automation hook (no UI dialogs)
  return app;
}
