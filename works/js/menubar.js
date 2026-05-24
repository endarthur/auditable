// The desktop menu bar — @gcu/menu's MenuBar.

import { MenuBar } from '#menu';
import { WKS, setStatus } from './state.js';
import { spawnSurface } from './surfaces.js';
import { newProject } from './tree.js';
import { importNotebookViaPicker } from './import.js';
import { mountFolder } from './mount.js';
import { openWorkspaceFolder, resetWorkspace } from './workspace.js';
import { exportWorkspace, openWorkspaceFile, saveWorkspace } from './persist.js';
import { confirm as dlgConfirm } from '#dialog';
import { showAbout } from './about.js';

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
    { label: 'Help', items: () => [
      { label: 'About Auditable Works', action: 'help:about' },
    ] },
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
    if (action === 'help:about') { await showAbout(); return; }
    setStatus(`menu: ${action}`);  // workspace:save lands with 5b
  });

  // Ctrl/Cmd+S → the Save flush barrier.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveWorkspace();
    }
  });

  WKS.menubar = bar;
}
