// The desktop menu bar — @gcu/menu's MenuBar.

import { MenuBar } from '#menu';
import { WKS, setStatus } from './state.js';
import { spawnSurface } from './surfaces.js';
import { newProject } from './tree.js';
import { importNotebookViaPicker, importFileAsNotebook } from './import.js';
import { mountFolder } from './mount.js';
import { openWorkspaceFolder, resetWorkspace } from './workspace.js';
import { exportWorkspace, openWorkspaceFile, saveWorkspace } from './persist.js';
import { confirm as dlgConfirm, Dialog } from '#dialog';
import { showAbout } from './about.js';
import { hasExamples, getExamplesManifest } from './examples-loader.js';

export function setupMenuBar() {
  const el = document.getElementById('works-menubar');

  const bar = new MenuBar(el, () => [
    { label: 'File', items: () => [
      { label: 'New notebook…',    action: 'project:new' },
      { label: 'Import notebook…', action: 'project:import' },
      '---',
      { label: 'New workspace…',       action: 'workspace:new' },
      { label: 'Open folder…',         action: 'workspace:open' },
      { label: 'Mount folder…',        action: 'workspace:mount' },
      { label: 'Open workspace file…', action: 'workspace:openfile' },
      '---',
      { label: 'Save',              action: 'workspace:save', shortcut: 'Ctrl+S' },
      { label: 'Export workspace…', action: 'workspace:export' },
    ] },
    { label: 'View', items: () => [
      { label: 'Toggle sidebar', action: 'view:sidebar' },
    ] },
    { label: 'Tools', items: () => [
      { label: 'Terminal',  action: 'tools:terminal' },
      { label: 'Settings…', action: 'tools:settings' },
    ] },
    { label: 'Debug', items: () => [
      { label: 'New stub surface', action: 'debug:stub' },
      { label: 'A-Bus inspector', action: 'debug:inspector' },
    ] },
    { label: 'Help', items: () => {
      const items = [
        { label: 'Documentation',        action: 'help:docs', shortcut: 'F1' },
      ];
      if (hasExamples()) {
        items.push({ label: 'Open example…',           action: 'help:openexample' });
      }
      items.push('---');
      items.push({ label: 'About Auditable Works', action: 'help:about' });
      return items;
    } },
  ]);

  bar.on('action', async (action) => {
    if (action === 'project:new') { newProject('/projects'); return; }
    if (action === 'project:import') { importNotebookViaPicker(); return; }
    if (action === 'workspace:open') { await openWorkspaceFolder(); return; }
    if (action === 'workspace:mount') { await mountFolder(); return; }
    if (action === 'workspace:openfile') { openWorkspaceFile(); return; }
    if (action === 'workspace:save') { await saveWorkspace(); return; }
    if (action === 'workspace:export') { await exportWorkspace(); return; }
    if (action === 'workspace:new') {
      if (await dlgConfirm('Discard the current workspace and start fresh?', { danger: true })) {
        await resetWorkspace();
      }
      return;
    }
    if (action === 'tools:terminal') {
      spawnSurface('terminal', { title: 'Terminal' });
      return;
    }
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

// Help → Open example… — picker over /usr/share/examples/ (works-all
// only; the menu item is hidden when the examples payload is absent).
// Each row imports its def as a new project under /projects and opens
// it in a notebook surface.
async function openExamplePicker() {
  const manifest = getExamplesManifest();
  if (!manifest) return;
  const categories = manifest.categories || {};
  const catNames = Object.keys(categories).sort();

  const dlg = new Dialog({
    title: 'Open example',
    width: 540,
    render: (body, ctx) => {
      const root = document.createElement('div');
      root.style.cssText = 'max-height:60vh;overflow:auto;padding:8px 12px;font:13px/1.5 var(--sw-sans,sans-serif)';
      body.appendChild(root);

      if (catNames.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:16px;color:var(--sw-text-soft);font-style:italic';
        empty.textContent = 'No examples bundled.';
        root.appendChild(empty);
        return;
      }

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
          row.onclick = () => ctx.close(entry.file);
          row.onkeydown = (e) => { if (e.key === 'Enter') ctx.close(entry.file); };
          sect.appendChild(row);
        }
        root.appendChild(sect);
      }
    },
  });

  const picked = await dlg.show();
  if (!picked) return;
  const vfsPath = '/usr/share/examples/' + picked;
  try {
    await importFileAsNotebook(vfsPath);
  } catch (e) {
    setStatus('open example failed: ' + (e.message || e));
  }
}
