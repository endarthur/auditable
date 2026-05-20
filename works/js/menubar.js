// The desktop menu bar — @gcu/menu's MenuBar. The File/View actions are
// stubs until persistence (Chunk 5); the Debug menu can spawn a stub
// surface, which is how Chunk 2 is exercised by hand.

import { MenuBar } from '#menu';
import { WKS, setStatus } from './state.js';
import { spawnSurface } from './surfaces.js';

export function setupMenuBar() {
  const el = document.getElementById('works-menubar');

  const bar = new MenuBar(el, () => [
    { label: 'File', items: () => [
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
    ] },
    { label: 'Help', items: () => [
      { label: 'About Auditable Works', action: 'help:about' },
    ] },
  ]);

  bar.on('action', (action) => {
    if (action === 'debug:stub') {
      spawnSurface('stub', { path: '/projects', title: 'Stub surface' });
      return;
    }
    setStatus(`menu: ${action}`);  // Chunk 1/2 stubs
  });

  WKS.menubar = bar;
}
