// The desktop menu bar — @gcu/menu's MenuBar. Chunk 1 wires the structure;
// the actions are stubs until the file tree (Chunk 3) and persistence
// (Chunk 5) give them something to do.

import { MenuBar } from '#menu';
import { WKS, setStatus } from './state.js';

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
    { label: 'Help', items: () => [
      { label: 'About Auditable Works', action: 'help:about' },
    ] },
  ]);

  bar.on('action', (action) => {
    // Chunk 1: stubs — just acknowledge in the statusbar.
    setStatus(`menu: ${action}`);
  });

  WKS.menubar = bar;
}
