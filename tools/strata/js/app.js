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
import { tableFromCsv, createTableProvider, createView, groupBy, transformWithOver, previewOverTransform, readStrata, writeStrata, evaluatePredicate, fmtCell } from '@gcu/strata';
import { sniff } from '@gcu/recon';
import { createWriter, readZip } from '@gcu/archive';
import { compile } from '@gcu/over';

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
  // Capability: can the user open arbitrary files from inside the app? True
  // standalone (picker + drag-drop); false in a Works loose-file surface (files
  // open via the tree as new surfaces). Default true.
  const canOpenFiles = host.canOpenFiles !== false;

  let table = null, provider = null, grid = null, view = null, docName = 'untitled';
  let sortState = null;                       // { col, dir } — the click-to-sort cycle
  let detailTable = null, detailName = null;  // the pre-group table, for "← Data"

  // ── cross-surface brushing/linking (Works only; host.selection capability) ──
  // host.selection = { publish(payload), subscribe(cb) } over the A-Bus Selection
  // channel; the host fills dataset/origin/epoch, echo-suppresses + dataset-scopes.
  // Absent standalone → linking is a no-op. The publish-side; the visible
  // highlight response to incoming selections is the next step.
  const link = host.selection || null;
  let incomingSelection = null;
  let linked = !!link;   // react to incoming selections by tinting the rows (opt-in + visible §7)

  // Resolve an incoming selection descriptor → a set of base-ordinal rows (§4.1
  // identity). 'rows' carries ids directly; 'filter' carries a structured
  // predicate evaluated against our own table (same dataset). Other kinds clear.
  function rowsForSelection(desc) {
    if (!desc || !table) return null;
    if (desc.kind === 'rows') return new Set((desc.rows || []).map(Number));
    if (desc.kind === 'filter' && desc.predicate) {
      const nameIdx = new Map(table.schema.map((s, k) => [s.name, k]));
      const out = new Set();
      for (let i = 0; i < table.nrows; i++) {
        const get = (name) => { const ci = nameIdx.get(name); return ci === undefined ? undefined : table.getCell(i, ci).value; };
        try { if (evaluatePredicate(desc.predicate, get)) out.add(i); } catch { /* skip row */ }
      }
      return out;
    }
    return null;   // 'none' / 'cols' / etc → clear the highlight
  }
  // Push the current incoming selection into the grid as a row tint (or clear).
  function applyHighlight() {
    if (provider) provider.setHighlight(linked ? rowsForSelection(incomingSelection) : null);
  }
  if (link) link.subscribe((desc) => { incomingSelection = desc; applyHighlight(); });

  function publishRowSelection(sel) {
    if (!link || !view) return;
    if (!sel) { link.publish({ kind: 'none', key: '#row' }); return; }
    const rows = [];
    for (let r = sel.r0; r <= sel.r1; r++) rows.push(String(view.at(r)));  // base-ordinal identity (§4.1)
    const cols = [];
    for (let c = sel.c0; c <= sel.c1; c++) cols.push(table.schema[c].name);
    link.publish({ kind: 'rows', key: '#row', rows, cols });
  }
  function publishFilterSelection() {
    if (!link || !view) return;
    const pred = view.filterPredicate;
    link.publish(pred ? { kind: 'filter', key: '#row', predicate: pred } : { kind: 'none', key: '#row' });
  }

  // ── mounting ──
  function mountTable(t) {
    closeContextMenu();
    table = t;
    view = createView(table);
    sortState = null;
    $('#filter').value = '';
    $('#filter').classList.remove('err');
    provider = createTableProvider(table, view);
    // Track dirty + footer on every commit (loom repaints on its own).
    const commit = provider.commit.bind(provider);
    provider.commit = (r, c, v) => { commit(r, c, v); host.setDirty(true); updateFooter(); };
    // Undo/redo/revert are mutations too — wrap them to refresh dirty + footer
    // (loom calls undo/redo on Ctrl+Z/Y; revert is driven by the context menu).
    for (const m of ['undo', 'redo', 'revert']) {
      const fn = provider[m] && provider[m].bind(provider);
      if (fn) provider[m] = (...a) => { const r = fn(...a); host.setDirty(true); updateFooter(); return r; };
    }

    if (grid) grid.destroy();
    $('#empty').style.display = 'none';
    grid = createGrid($('#grid'), provider, { theme: 'dark', defaultColW: 92 });
    grid.onSelect((s) => { updateSel(s); publishRowSelection(s); });
    grid.onHeaderClick(cycleSort);
    grid.onContextMenu(onCellContextMenu);
    grid.onHeaderContextMenu(onHeaderContextMenu);
    grid.focus();

    setTitle();
    updateFooter();
    refreshCommands();  // enable/show the table-dependent commands (+ ungroup vis)
    applyHighlight();   // re-tint for the current incoming selection (new provider)
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
    return true;
  }

  function ungroup() {
    if (!detailTable) return;
    const t = detailTable;
    docName = detailName;
    detailTable = null; detailName = null;
    mountTable(t);
  }

  // Run an OVER transform over the current table → a NEW table (the whole-table
  // declarative verb: map/filter/project + windows + joins + check/require + units).
  // Reuses the group "← Data" back mechanism. A failing `require` (gate) flashes the
  // report and keeps the current table.
  function transformWith(src) {
    if (!table || !src || !src.trim()) return false;
    let res;
    try { res = transformWithOver(table, src, { compile }); }
    catch (e) {
      if (e.name === 'OverCheckError') {
        const f = e.checks.filter((c) => c.severity === 'error' && c.failed).map((c) => `${c.rule} (${c.failed})`).join(', ');
        flash(`required check failed: ${f}`);
      } else flash('transform error: ' + e.message);
      return false;
    }
    detailTable = table; detailName = docName;
    docName = `${docName} — transformed`;
    mountTable(res.table);
    host.setDirty(true);
    const nWarn = res.warnings.length;
    const nFail = res.checks.reduce((n, c) => n + c.failed, 0);
    const tags = [`${res.table.cols} cols`];
    if (nWarn) tags.push(`${nWarn} warning${nWarn > 1 ? 's' : ''}`);
    if (nFail) tags.push(`${nFail} check failure${nFail > 1 ? 's' : ''}`);
    else if (res.checks.length) tags.push('checks ok');
    flash('transformed → ' + tags.join(' · '));
    return true;
  }

  // The Transform dialog — a multi-line OVER editor with a live schema/warnings
  // preview (the auditable win: the output shape resolves before you run). Built
  // once, lazily, into document.body (shared by surface + standalone).
  let txModal = null;
  function openTransformDialog() {
    if (!table) return;
    if (!txModal) txModal = buildTransformModal();
    const ta = txModal.querySelector('textarea');
    const pre = txModal.querySelector('.tx-preview');
    const renderPreview = () => {
      const src = ta.value.trim();
      if (!src) { pre.textContent = ''; pre.style.color = '#7fb37f'; return; }
      try {
        const p = previewOverTransform(table, src, { compile });
        const cols = p.columns.map((c) => c.name).join(', ');
        pre.textContent = `→ ${p.columns.length} cols: ${cols}` + (p.warnings.length ? '\n⚠ ' + p.warnings.join('\n⚠ ') : '');
        pre.style.color = p.warnings.length ? '#d9a441' : '#7fb37f';
      } catch (e) { pre.textContent = e.message; pre.style.color = '#d46a6a'; }
    };
    let deb; ta.oninput = () => { clearTimeout(deb); deb = setTimeout(renderPreview, 200); };
    txModal.querySelector('.tx-run').onclick = () => { if (transformWith(ta.value)) txModal.style.display = 'none'; };
    txModal.querySelector('.tx-cancel').onclick = () => { txModal.style.display = 'none'; };
    txModal.style.display = 'flex';
    ta.focus();
    renderPreview();
  }

  function buildTransformModal() {
    const ph = ['# transform this table — OVER (map / match / windows / check / units)',
      'FE_REL = FE / mean(FE) over LITHO', 'ORE = match FE { >=62: "ore", _: "waste" }',
      'check "fe present": present(FE)', 'saveonly(hole, FE, FE_REL, ORE)'].join('\n');
    const overlay = document.createElement('div');
    overlay.id = 'transformModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:1000';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:6px;width:min(700px,92vw);max-height:88vh;display:flex;flex-direction:column;gap:10px;padding:14px;font-family:var(--mono,monospace)';
    box.innerHTML =
      '<div style="color:#c89b3c;font-size:13px">Transform — OVER over this table</div>'
      + '<textarea spellcheck="false" style="width:100%;height:220px;resize:vertical;background:#141414;color:#ddd;border:1px solid #333;border-radius:4px;padding:8px;font:12px/1.5 var(--mono,monospace);box-sizing:border-box"></textarea>'
      + '<pre class="tx-preview" style="margin:0;min-height:2.4em;max-height:160px;overflow:auto;color:#7fb37f;font:11px/1.4 var(--mono,monospace);white-space:pre-wrap"></pre>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button class="tx-cancel" style="background:#2a2a2a;color:#ccc;border:1px solid #444;border-radius:4px;padding:5px 12px;cursor:pointer">Cancel</button>'
      + '<button class="tx-run" style="background:#3a2f1a;color:#e0b050;border:1px solid #6b5524;border-radius:4px;padding:5px 12px;cursor:pointer">Run ▸</button>'
      + '</div>';
    box.querySelector('textarea').placeholder = ph;
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.style.display = 'none'; });
    document.body.appendChild(overlay);
    return overlay;
  }

  // A tiny form modal — replaces native prompt() for the +Col / Group commands
  // so those first-class actions feel like the app, not the browser. Mirrors the
  // Transform modal's styling. Resolves a {name: value} map, or null on cancel.
  // (Field labels/placeholders are app-authored constants — no untrusted HTML.)
  function formModal(title, fields) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:1000';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:6px;width:min(440px,92vw);display:flex;flex-direction:column;gap:10px;padding:14px;font-family:var(--mono,monospace)';
      let html = `<div style="color:#c89b3c;font-size:13px">${title}</div>`;
      for (const f of fields) {
        html += `<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#999">${f.label}`
          + `<input data-name="${f.name}" spellcheck="false" placeholder="${f.placeholder || ''}"`
          + ` style="background:#141414;color:#ddd;border:1px solid #333;border-radius:4px;padding:6px 8px;font:12px var(--mono,monospace)"></label>`;
      }
      html += '<div style="display:flex;gap:8px;justify-content:flex-end">'
        + '<button class="fm-cancel" style="background:#2a2a2a;color:#ccc;border:1px solid #444;border-radius:4px;padding:5px 12px;cursor:pointer">Cancel</button>'
        + '<button class="fm-ok" style="background:#3a2f1a;color:#e0b050;border:1px solid #6b5524;border-radius:4px;padding:5px 12px;cursor:pointer">OK</button></div>';
      box.innerHTML = html;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const inputs = [...box.querySelectorAll('input[data-name]')];
      const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
      const submit = () => { const out = {}; for (const i of inputs) out[i.dataset.name] = i.value; close(out); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } else if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      box.querySelector('.fm-cancel').onclick = () => close(null);
      box.querySelector('.fm-ok').onclick = submit;
      if (inputs[0]) inputs[0].focus();
    });
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

  // Apply an explicit sort to a column. dir: 'asc' | 'desc' | null (clear).
  function applySort(col, dir) {
    if (!view) return;
    sortState = dir ? { col, dir } : null;
    view.setSort(dir ? { by: table.schema[col].name, dir } : null);
    grid.refresh();
    updateFooter();
  }
  // Left-click a column header → cycle its sort: none → asc → desc → none.
  function cycleSort(col) {
    let dir;
    if (!sortState || sortState.col !== col) dir = 'asc';
    else if (sortState.dir === 'asc') dir = 'desc';
    else dir = null;
    applySort(col, dir);
  }

  // Apply the filter box (a boolean formula over columns).
  function applyFilter(formula) {
    if (!view) return false;
    try {
      view.setFilter(formula || null);
      $('#filter').classList.remove('err');
      grid.refresh();
      updateFooter();
      publishFilterSelection();
      return true;
    } catch (e) {
      $('#filter').classList.add('err');
      flash('filter error: ' + e.message);
      return false;
    }
  }

  // ── cell context menu (right-click → revert provenance) ──
  // loom emits the gesture; the app builds the menu so revert flows through the
  // wrapped provider.revert (dirty/footer) and the table's undo log. The noun-
  // first "verbs come to the object" layer (see the GCU command-model direction).
  function editedCellsInSel(sel) {
    const out = [];
    if (!sel || !table || !view) return out;
    for (let r = sel.r0; r <= sel.r1; r++) {
      const ur = view.at(r);
      for (let c = sel.c0; c <= sel.c1; c++) if (!table.isDerived(c) && table.isEdited(ur, c)) out.push([r, c]);
    }
    return out;
  }
  function onCellContextMenu({ row, col, sel, clientX, clientY }) {
    if (!table || !view) return;
    const items = [];
    const ur = view.at(row);
    if (!table.isDerived(col) && table.isEdited(ur, col)) {
      items.push({ label: `Revert to ${fmtCell(table.baseValue(ur, col))}`, run: () => { provider.revert(row, col); grid.refresh(); } });
    }
    const edited = editedCellsInSel(sel);
    if (edited.length > 1) {
      items.push({ label: `Revert ${edited.length} edits in selection`, run: () => {
        if (provider.beginBatch) provider.beginBatch();
        for (const [r, c] of edited) provider.revert(r, c);
        if (provider.endBatch) provider.endBatch();
        grid.refresh();
      } });
    }
    if (!items.length) items.push({ label: 'No edits to revert', disabled: true });
    showContextMenu(items, clientX, clientY);
  }

  // Column-header right-click → the ▾ menu (sort / autofit / revert-column /
  // show-formula). The typed-table control center; reuses the same popup.
  function editedInColumn(c) {
    if (!table || table.isDerived(c)) return 0;
    let n = 0;
    for (let r = 0; r < table.nrows; r++) if (table.isEdited(r, c)) n++;
    return n;
  }
  function revertColumn(c) {
    const rows = [];
    for (let r = 0; r < table.nrows; r++) if (table.isEdited(r, c)) rows.push(r);
    if (!rows.length) return;
    table.beginTxn();
    for (const r of rows) table.revert(r, c);
    table.endTxn();
    host.setDirty(true); updateFooter(); grid.refresh();
  }
  function onHeaderContextMenu({ col, clientX, clientY }) {
    if (!table || !view) return;
    const name = table.schema[col].name;
    const sorted = view.sortSpec && view.sortSpec.by === name ? view.sortSpec.dir : null;
    const items = [
      { label: (sorted === 'asc' ? '✓ ' : '') + 'Sort ascending', run: () => applySort(col, 'asc') },
      { label: (sorted === 'desc' ? '✓ ' : '') + 'Sort descending', run: () => applySort(col, 'desc') },
    ];
    if (sorted) items.push({ label: 'Clear sort', run: () => applySort(col, null) });
    items.push('---', { label: 'Autofit column', run: () => grid.autofitColumn(col) });
    const nEd = editedInColumn(col);
    if (nEd > 0) items.push({ label: `Revert ${nEd} edit${nEd > 1 ? 's' : ''} in column`, run: () => revertColumn(col) });
    if (table.isDerived(col)) items.push('---', { label: 'Show formula', run: () => flash('= ' + table.schema[col].formula) });
    showContextMenu(items, clientX, clientY);
  }

  let _ctxMenu = null;
  function closeContextMenu() {
    if (!_ctxMenu) return;
    _ctxMenu.remove(); _ctxMenu = null;
    document.removeEventListener('mousedown', _ctxOutside, true);
    document.removeEventListener('keydown', _ctxKey, true);
  }
  function _ctxOutside(e) { if (_ctxMenu && !_ctxMenu.contains(e.target)) closeContextMenu(); }
  function _ctxKey(e) { if (e.key === 'Escape') closeContextMenu(); }
  function showContextMenu(items, x, y) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'strata-ctx';
    menu.style.cssText = 'position:fixed;z-index:1100;background:#1e1e1e;border:1px solid #444;border-radius:5px;padding:4px;min-width:150px;font-family:var(--mono,monospace);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.5)';
    for (const it of items) {
      if (it === '---') {
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:#3a3a3a;margin:4px 2px';
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('div');
      b.textContent = it.label;
      b.style.cssText = `padding:5px 10px;border-radius:3px;white-space:nowrap;cursor:${it.disabled ? 'default' : 'pointer'};color:${it.disabled ? '#666' : '#ccc'}`;
      if (!it.disabled) {
        b.onmouseenter = () => { b.style.background = '#2e2e2e'; };
        b.onmouseleave = () => { b.style.background = ''; };
        b.onclick = () => { closeContextMenu(); it.run(); };
      }
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 4;
    menu.style.left = Math.max(2, x) + 'px';
    menu.style.top = Math.max(2, y) + 'px';
    _ctxMenu = menu;
    // Defer the dismiss listeners so the opening right-click doesn't close it.
    setTimeout(() => {
      document.addEventListener('mousedown', _ctxOutside, true);
      document.addEventListener('keydown', _ctxKey, true);
    }, 0);
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

  // ── commands (the registry) ──
  // Commands-as-data: the single source of truth for the toolbar verbs, and the
  // shape a future shared command palette / keybindings / MCP agent will consume.
  // Converges on the two established GCU conventions — the namespaced string `id`
  // is the menubar action convention (auditable/works `dispatch`), `run` is the
  // weir-palette callback, `when` adds enablement. `btn` binds to the existing
  // toolbar button (HTML owns layout; the list owns label + behaviour + state).
  // `visible` (bool | () => bool) hides a command from the toolbar entirely.
  const commands = [
    { id: 'strata:open', btn: '#btnOpen', label: 'Open…', visible: canOpenFiles, when: () => true,
      run: async () => { const f = await host.open(); if (f) openBytes(f.name, f.bytes); } },
    { id: 'strata:save', btn: '#btnSave', label: 'Save', when: () => !!table,
      run: async () => { if (!table) return; const msg = await host.save(docName + '.strata', await buildStrataBytes()); if (msg) { updateFooter(); flash(msg); } } },
    { id: 'strata:save-as', btn: '#btnSaveAs', label: 'Save As…', when: () => !!table,
      run: async () => { if (!table) return; const msg = await host.saveAs(docName + '.strata', await buildStrataBytes()); if (msg) { setTitle(); updateFooter(); flash(msg); } } },
    { id: 'strata:add-column', btn: '#btnAddCol', label: '+ Col', when: () => !!table,
      run: async () => {
        if (!table) return;
        const v = await formModal('Add column', [
          { name: 'name', label: 'Column name', placeholder: 'e.g. metal' },
          { name: 'formula', label: 'Formula — JS over column names', placeholder: 'grade * tonnes' },
        ]);
        if (v && v.name.trim() && v.formula.trim()) addColumn(v.name.trim(), v.formula.trim());
      } },
    { id: 'strata:group', btn: '#btnGroup', label: 'Group…', when: () => !!table,
      run: async () => {
        if (!table) return;
        const v = await formModal('Group by', [
          { name: 'key', label: 'Group by column (count + mean of each numeric column)', placeholder: 'e.g. LITO' },
        ]);
        if (v && v.key.trim()) groupByColumn(v.key.trim());
      } },
    { id: 'strata:transform', btn: '#btnTransform', label: 'Transform…', when: () => !!table,
      run: () => openTransformDialog() },
    // No toolbar button (Ctrl+Z/Y + the future palette); registered so they're in
    // the command surface a palette / agent will drive.
    { id: 'strata:undo', label: 'Undo', when: () => !!table && table.canUndo(),
      run: () => { if (provider && provider.undo) { provider.undo(); grid.refresh(); } } },
    { id: 'strata:redo', label: 'Redo', when: () => !!table && table.canRedo(),
      run: () => { if (provider && provider.redo) { provider.redo(); grid.refresh(); } } },
    { id: 'strata:ungroup', btn: '#btnUngroup', label: '← Data', visible: () => !!detailTable, when: () => true,
      run: () => ungroup() },
  ];
  function commandById(id) { return commands.find((c) => c.id === id) || null; }
  function runCommand(id) { const c = commandById(id); if (c && (!c.when || c.when())) return c.run(); }
  // Bind each command to its toolbar button (label + click). Called once.
  function renderToolbar() {
    for (const c of commands) {
      const el = $(c.btn); if (!el) continue;
      el.textContent = c.label;
      el.onclick = () => { if (!c.when || c.when()) c.run(); };
    }
    refreshCommands();
  }
  // Sync enabled/visible state from the predicates. Called on every state change.
  function refreshCommands() {
    for (const c of commands) {
      const el = $(c.btn); if (!el) continue;
      const vis = typeof c.visible === 'function' ? c.visible() : (c.visible !== false);
      el.style.display = vis ? '' : 'none';
      el.disabled = c.when ? !c.when() : false;
    }
  }
  renderToolbar();

  // Linking toggle (Works only; opt-in + visible §7). Hidden standalone (no link).
  // Stateful toggle — kept out of the command list for now (it'll become a
  // checked/toggle command when the shared palette lib lands).
  const btnLinked = $('#btnLinked');
  if (btnLinked) {
    if (!link) { btnLinked.style.display = 'none'; }
    else {
      const renderLinked = () => { btnLinked.classList.toggle('on', linked); btnLinked.textContent = linked ? 'Linked' : 'Link off'; };
      renderLinked();
      btnLinked.onclick = () => { linked = !linked; renderLinked(); applyHighlight(); };
    }
  }
  $('#filter').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilter(e.target.value.trim()); });

  // ── drag-drop (only where opening arbitrary files makes sense) ──
  if (canOpenFiles) {
    window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragging'); });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    });
  }

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
    addColumn, applyFilter, cycleSort, groupByColumn, ungroup, transformWith,
    // The command registry — enumerable + invokable by id (the seam a shared
    // palette / keybindings / MCP agent will drive; today the toolbar does).
    get commands() { return commands.map((c) => ({ id: c.id, label: c.label, enabled: c.when ? !!c.when() : true })); },
    runCommand,
    get table() { return table; },
    get grid() { return grid; },
    get view() { return view; },
    get host() { return host; },
    get linked() { return linked; },
    setLinked(v) { linked = !!v; applyHighlight(); },
    get lastSelection() { return incomingSelection; },  // last selection received from another surface
  };
  window._strataApp = app;   // automation hook (no UI dialogs)
  return app;
}
