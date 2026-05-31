// The desktop menu bar — @gcu/menu's MenuBar.

import { MenuBar } from '#menu';
import { WKS, setStatus } from './state.js';
import { spawnSurface, openPath } from './surfaces.js';
import { newProject } from './tree.js';
import { importNotebookViaPicker, importFileAsNotebook } from './import.js';
import { importEpubViaPicker } from './book-import.js';
import { installGcudatViaPicker } from './gcudat-install.js';
import { mountFolder } from './mount.js';
import { openWorkspaceFolder, resetWorkspace } from './workspace.js';
import { exportWorkspace, openWorkspaceFile, saveWorkspace } from './persist.js';
import { confirm as dlgConfirm, Dialog } from '#dialog';
import { showAbout } from './about.js';
import { openLibraryDialog } from './registry.js';
import { getExamplesManifest } from './examples-loader.js';
import { aggregateLicenses, formatNoticesFile } from '#licenses';

export function setupMenuBar() {
  const el = document.getElementById('works-menubar');

  const bar = new MenuBar(el, () => [
    { label: 'File', items: () => [
      { label: 'New notebook…',    action: 'project:new' },
      { label: 'Import notebook…', action: 'project:import' },
      { label: 'Import book (EPUB)…', action: 'book:import' },
      { label: 'Install data pack…', action: 'pack:install' },
      { label: 'Browse Library…', action: 'library:browse' },
      '---',
      { label: 'New workspace…',       action: 'workspace:new' },
      { label: 'Open folder…',         action: 'workspace:open' },
      { label: 'Mount folder…',        action: 'workspace:mount' },
      { label: 'Open workspace file…', action: 'workspace:openfile' },
      '---',
      { label: 'Save',                       action: 'workspace:save', shortcut: 'Ctrl+S' },
      { label: 'Export workspace…',          action: 'workspace:export' },
      { label: 'Export THIRD-PARTY-NOTICES…', action: 'workspace:export-notices' },
    ] },
    { label: 'View', items: () => [
      { label: 'Toggle sidebar', action: 'view:sidebar' },
    ] },
    { label: 'Tools', items: () => [
      { label: 'Terminal',  action: 'tools:terminal' },
      { label: 'Library',   action: 'tools:library' },
      { label: 'Data workbench', action: 'tools:workbench' },
      { label: 'New rack',  action: 'tools:patchbay' },
      { label: 'Settings…', action: 'tools:settings' },
    ] },
    { label: 'Debug', items: () => [
      { label: 'New stub surface', action: 'debug:stub' },
      { label: 'A-Bus inspector', action: 'debug:inspector' },
    ] },
    { label: 'Help', items: () => [
      // Open example… is always available — it carries the built-in Patchbay
      // examples even when no bundled notebook examples are present.
      { label: 'Documentation', action: 'help:docs', shortcut: 'F1' },
      { label: 'Documentation (as a book)', action: 'help:docsbook' },
      { label: 'Open example…', action: 'help:openexample' },
      '---',
      { label: 'About Auditable Works', action: 'help:about' },
    ] },
  ]);

  bar.on('action', async (action) => {
    if (action === 'project:new') { newProject('/projects'); return; }
    if (action === 'project:import') { importNotebookViaPicker(); return; }
    if (action === 'book:import') { importEpubViaPicker(); return; }
    if (action === 'pack:install') { installGcudatViaPicker(); return; }
    if (action === 'library:browse') { openLibraryDialog(); return; }
    if (action === 'workspace:open') { await openWorkspaceFolder(); return; }
    if (action === 'workspace:mount') { await mountFolder(); return; }
    if (action === 'workspace:openfile') { openWorkspaceFile(); return; }
    if (action === 'workspace:save') { await saveWorkspace(); return; }
    if (action === 'workspace:export') { await exportWorkspace(); return; }
    if (action === 'workspace:export-notices') { await exportNotices(); return; }
    if (action === 'workspace:new') {
      if (await dlgConfirm('Discard the current workspace and start fresh?', { danger: true })) {
        await resetWorkspace();
      }
      return;
    }
    if (action === 'view:sidebar') {
      document.querySelector('.works-sidebar')?.classList.toggle('hidden');
      return;
    }
    if (action === 'tools:terminal') {
      spawnSurface('terminal', { title: 'Terminal' });
      return;
    }
    if (action === 'tools:library') { spawnSurface('library', { title: 'Library' }); return; }
    if (action === 'tools:workbench') { spawnSurface('workbench', { title: 'Data Workbench' }); return; }
    if (action === 'tools:patchbay') { await newRack(); return; }
    if (action === 'tools:settings') {
      // Single-instance: focus the existing settings tab if any.
      for (const rec of WKS.surfaces.values()) {
        if (rec.kind === 'settings') { WKS.rails.activateTab(rec.tabId); return; }
      }
      spawnSurface('settings', { title: 'Settings' });
      return;
    }
    if (action === 'debug:stub') {
      spawnSurface('stub', { path: '/projects', title: 'Stub surface' });
      return;
    }
    if (action === 'debug:inspector') {
      spawnSurface('inspector', { title: 'A-Bus Inspector' });
      return;
    }
    if (action === 'help:docs') {
      // Single-instance: focus existing docs tab if any.
      for (const rec of WKS.surfaces.values()) {
        if (rec.kind === 'docs') { WKS.rails.activateTab(rec.tabId); return; }
      }
      spawnSurface('docs', { title: 'Documentation' });
      return;
    }
    if (action === 'help:docsbook') { await openPath('/usr/share/books/gcu-docs'); return; }
    if (action === 'help:openexample') { await openExamplePicker(); return; }
    if (action === 'help:about') { await showAbout(); return; }
    setStatus(`menu: ${action}`);  // workspace:save lands with 5b
  });

  // Ctrl/Cmd+S → the Save flush barrier.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveWorkspace();
    }
    // F1 → docs surface (Help → Documentation accelerator).
    if (e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      for (const rec of WKS.surfaces.values()) {
        if (rec.kind === 'docs') { WKS.rails.activateTab(rec.tabId); return; }
      }
      spawnSurface('docs', { title: 'Documentation' });
    }
  });

  WKS.menubar = bar;
}

// Tools → New rack — write a starter .patchbay (a live LFO→scope + const→number
// demo) under /projects, then open it in the patchbay surface. A `.patchbay`
// file already in the tree opens on double-click via the registry's extension
// dispatch; this is just the "create a fresh one" entry point.
// The companion notebook (created once) — reads what the rack LOGs and writes
// a message the rack's FILE module shows, both over the shared workspace /tmp.
const PATCHBAY_BRIDGE_NB = `/// auditable
/// title: Patchbay Bridge

/// md
# Patchbay ↔ notebook — live over A-Bus

This notebook drives a **patchbay rack** through the workspace bus with
\`notebook.tag\` — no files, no polling. Open the rack (**Help → Open example →
Patchbay → Example rack**) in another tab, then run these cells and watch the
two surfaces move together.

A topic is just \`"Interface.Member"\`. (Patchbay can also bridge through VFS
files via its FILE / LOG modules — add them from **Add** — but \`notebook.tag\`
is the live, push path.)

/// code
// PUBLISH → the rack's TAG IN (topic user.level) drives its gauge needle.
// Drag the slider; the rack reacts as you move it.
const level = ui.slider('user.level', 0.6, { min: 0, max: 1, step: 0.01 });
notebook.tag.publish('user.level', level);
display('published  user.level → ' + level.toFixed(2) + '   (watch the rack gauge)');

/// code
// SUBSCRIBE → see the rack's SETPOINT knob live (topic rack.setpoint).
// Turn the knob on the rack tab; this readout tracks it with no re-run.
// sr.signal + sr.effect bind it live; tag.latest seeds the first value.
const [setpoint, setSetpoint] = sr.signal(notebook.tag.latest('rack.setpoint') ?? 0);
notebook.tag.subscribe('rack.setpoint', setSetpoint);
const readout = document.createElement('div');
readout.style.cssText = 'font:14px monospace;padding:4px 0';
sr.effect(() => { readout.textContent = 'rack setpoint → ' + Number(setpoint()).toFixed(3); });
display(readout);
`;

// Tools → New rack — a fresh, empty rack. (The demo lives under Help.)
async function newRack() {
  const blank = { format: 'patchbay', version: 1, rack: { hp: 64, rows: [{ kind: '3U' }, { kind: '3U' }] }, modules: [], cables: [] };
  let path = '/projects/rack.patchbay';
  try {
    for (let i = 2; await WKS.vfs.exists(path); i++) path = `/projects/rack-${i}.patchbay`;
    await WKS.vfs.mkdir('/projects', { recursive: true }).catch(() => {});
    await WKS.vfs.writeFile(path, JSON.stringify(blank, null, 2));
  } catch (e) {
    setStatus('New rack failed: ' + (e.message || e));
    return;
  }
  await openPath(path);
}

// Open example → Patchbay → Example rack. The punk-SCADA demo, paired with the
// integrated notebook over A-Bus: row 0 is the monitor (a SIGNAL fanning into
// TREND / GAUGE / ALARM); row 1 is the notebook bridge — SETPOINT → TAG OUT
// publishes topic rack.setpoint (the notebook subscribes), and TAG IN ←
// user.level (the notebook publishes) drives a GAUGE. Both directions are
// user-driven / low-rate by design. Overwritten on open — it's the canonical
// example, not user data, so it always reflects the current build.
async function openExampleRack() {
  const EXAMPLE = '/projects/patchbay-example.patchbay';
  const rack = {
    format: 'patchbay', version: 1,
    rack: { hp: 84, rows: [{ kind: '3U' }, { kind: '3U' }] },
    modules: [
      // row 0 — monitor
      { id: 'signal', type: 'src.lfo',     row: 0, hpPos: 2,  knobs: { rate: 0.3 }, params: {} },
      { id: 'trend',  type: 'disp.scope',  row: 0, hpPos: 14, knobs: {}, params: {} },
      { id: 'gauge',  type: 'disp.gauge',  row: 0, hpPos: 32, knobs: {}, params: {} },
      { id: 'alarm',  type: 'ctrl.alarm',  row: 0, hpPos: 44, knobs: { level: 0.7, hyst: 0.05 }, params: {} },
      // row 1 — notebook bridge over A-Bus (notebook.tag)
      { id: 'setpt',  type: 'src.const',   row: 1, hpPos: 2,  knobs: { value: 0.6 }, params: {} },
      { id: 'tagout', type: 'io.abus-out', row: 1, hpPos: 12, knobs: {}, params: { topic: 'rack.setpoint' } },
      { id: 'tagin',  type: 'io.abus-in',  row: 1, hpPos: 26, knobs: {}, params: { topic: 'user.level' } },
      { id: 'level',  type: 'disp.gauge',  row: 1, hpPos: 38, knobs: {}, params: {} },
      { id: 'note',   type: 'panel.note',  row: 1, hpPos: 52,
        params: { text: 'A-Bus bridge · notebook.tag → open the integrated notebook' } },
    ],
    cables: [
      { from: { id: 'signal', port: 'sin' }, to: { id: 'trend', port: 'x' }, color: 'teal' },
      { from: { id: 'signal', port: 'tri' }, to: { id: 'gauge', port: 'x' }, color: 'teal' },
      { from: { id: 'signal', port: 'sin' }, to: { id: 'alarm', port: 'x' }, color: 'red' },
      { from: { id: 'setpt',  port: 'v' },   to: { id: 'tagout', port: 'value' }, color: 'orange' },
      { from: { id: 'tagin',  port: 'value' }, to: { id: 'level', port: 'x' }, color: 'indigo' },
    ],
  };
  try {
    await WKS.vfs.mkdir('/projects', { recursive: true }).catch(() => {});
    await WKS.vfs.writeFile(EXAMPLE, JSON.stringify(rack, null, 2));
  } catch (e) { setStatus('example rack failed: ' + (e.message || e)); return; }
  await openPath(EXAMPLE);
}

// Open example → Patchbay → Integrated notebook — the companion that bridges.
async function openExampleNotebook() {
  const nbDir = '/projects/Patchbay Bridge';
  try {
    await WKS.vfs.mkdir(nbDir, { recursive: true });
    // Stable project id (keep it across opens); always refresh notebook.txt so
    // the canonical example reflects the current build.
    if (!(await WKS.vfs.exists(nbDir + '/project.json'))) {
      await WKS.vfs.writeFile(nbDir + '/project.json',
        JSON.stringify({ kind: 'notebook', id: 'pb-bridge', title: 'Patchbay Bridge' }));
    }
    await WKS.vfs.writeFile(nbDir + '/notebook.txt', PATCHBAY_BRIDGE_NB);
  } catch (e) { setStatus('example notebook failed: ' + (e.message || e)); return; }
  await openPath(nbDir);
}

// Help → Open example… — picker over /usr/share/examples/ (works-all
// only; the menu item is hidden when the examples payload is absent).
// Each row imports its def as a new project under /projects and opens
// it in a notebook surface.
async function openExamplePicker() {
  // Built-in Patchbay examples (Works surfaces, not bundled notebooks) live at
  // the top; bundled notebook examples (works-all) follow. Patchbay rows carry
  // an `action` instead of a `file`.
  const manifest = getExamplesManifest() || {};
  const categories = {
    Patchbay: [
      { title: 'Example rack', name: 'rack', action: 'pb-rack' },
      { title: 'Integrated notebook', name: 'notebook', action: 'pb-nb' },
    ],
    ...(manifest.categories || {}),
  };
  const catNames = ['Patchbay', ...Object.keys(manifest.categories || {}).sort()];

  const dlg = new Dialog({
    title: 'Open example',
    width: 540,
    render: (body, ctx) => {
      const root = document.createElement('div');
      root.style.cssText = 'max-height:60vh;overflow:auto;padding:8px 12px;font:13px/1.5 var(--sw-sans,sans-serif)';
      body.appendChild(root);

      for (const cat of catNames) {
        const sect = document.createElement('section');
        sect.style.cssText = 'margin-bottom:14px';

        const h = document.createElement('h4');
        h.textContent = cat;
        h.style.cssText = 'font:600 11px/1.4 var(--sw-mono,ui-monospace);'
          + 'letter-spacing:0.14em;text-transform:uppercase;'
          + 'color:var(--sw-orange,#d97a3c);margin:0 0 6px;'
          + 'padding-bottom:3px;border-bottom:1px solid var(--sw-border-soft,#2a2e33)';
        sect.appendChild(h);

        for (const entry of categories[cat]) {
          const row = document.createElement('div');
          row.style.cssText = 'padding:5px 8px;cursor:pointer;border-radius:3px;'
            + 'display:flex;justify-content:space-between;gap:12px;color:var(--sw-text)';
          row.tabIndex = 0;
          row.onmouseenter = () => row.style.background = 'var(--sw-bg-bright,#21262b)';
          row.onmouseleave = () => row.style.background = '';
          row.onfocus    = () => row.style.background = 'var(--sw-bg-bright,#21262b)';
          row.onblur     = () => row.style.background = '';

          const title = document.createElement('span');
          title.textContent = entry.title;
          title.style.fontWeight = '500';
          if (entry.unresolvable && entry.unresolvable.length) {
            // Picker still shows it — the example MAY run partially —
            // but the user gets a hint that something inside the def
            // can't resolve in this workspace.
            const note = document.createElement('span');
            note.textContent = ' ⚠';
            note.title = 'Uses ' + entry.unresolvable.join(', ')
              + ' — not bundled in works-all; cell may error at load.';
            note.style.color = 'var(--sw-amber,#c89b3c)';
            title.appendChild(note);
          }

          const file = document.createElement('span');
          file.textContent = entry.name;
          file.style.cssText = 'color:var(--sw-text-soft);font:11px/1.5 var(--sw-mono,ui-monospace)';

          row.appendChild(title);
          row.appendChild(file);
          const pick = () => ctx.close(entry.action ? { action: entry.action } : { file: entry.file });
          row.onclick = pick;
          row.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
          sect.appendChild(row);
        }
        root.appendChild(sect);
      }
    },
  });

  const picked = await dlg.show();
  if (!picked) return;
  if (picked.action === 'pb-rack') return openExampleRack();
  if (picked.action === 'pb-nb') return openExampleNotebook();
  if (picked.file) {
    try { await importFileAsNotebook('/usr/share/examples/' + picked.file); }
    catch (e) { setStatus('open example failed: ' + (e.message || e)); }
  }
}

// Export a THIRD-PARTY-NOTICES.txt sidecar — every vendored + pkg-managed +
// install()'d third-party component in the workspace, with its full LICENSE
// text. aggregateLicenses walks the workspace VFS (/sys/licenses for the
// build-time vendored deps, /lib for pkg packages, /var/modules for
// legacy install() entries); formatNoticesFile produces a single plaintext
// blob; we trigger the browser save dialog. No transform — what the user
// downloads is what they'd put alongside a re-distribution of this
// workspace.
async function exportNotices() {
  setStatus('Building NOTICES.txt…');
  let table;
  try {
    table = await aggregateLicenses(WKS.vfs);
  } catch (e) {
    setStatus('NOTICES.txt failed: ' + (e.message || e));
    return;
  }
  if (!table || table.length === 0) {
    setStatus('NOTICES.txt: no licensed dependencies to list');
    return;
  }
  const text = formatNoticesFile(table);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'THIRD-PARTY-NOTICES.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Downloaded THIRD-PARTY-NOTICES.txt (' + table.length + ' entries)');
}
