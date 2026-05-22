// The desktop menu bar — @gcu/menu's MenuBar.

import { MenuBar } from '#menu';
import { WKS, setStatus } from './state.js';
import { spawnSurface } from './surfaces.js';
import { newProject } from './tree.js';
import { openWorkspaceFolder, resetWorkspace } from './workspace.js';
import { confirm as dlgConfirm } from '#dialog';

export function setupMenuBar() {
  const el = document.getElementById('works-menubar');

  const bar = new MenuBar(el, () => [
    { label: 'File', items: () => [
      { label: 'New project…', action: 'project:new' },
      '---',
      { label: 'New workspace…', action: 'workspace:new' },
      { label: 'Open folder…',   action: 'workspace:open' },
      '---',
      { label: 'Save', action: 'workspace:save', shortcut: 'Ctrl+S' },
    ] },
    { label: 'View', items: () => [
      { label: 'Toggle sidebar', action: 'view:sidebar' },
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
    if (action === 'workspace:open') { await openWorkspaceFolder(); return; }
    if (action === 'workspace:new') {
      if (await dlgConfirm('Discard the current workspace and start fresh?', { danger: true })) {
        await resetWorkspace();
      }
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
    setStatus(`menu: ${action}`);  // workspace:save lands with 5b
  });

  WKS.menubar = bar;
}
