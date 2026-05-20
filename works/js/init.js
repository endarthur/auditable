// Auditable Works — shell entry point.
//
// The registry boot imports this module last, after template.html is in the
// DOM, so the shell wires itself up immediately.

import { WKS, setStatus } from './state.js';
import { setupBus } from './bus.js';
import { setupWorkspace } from './workspace.js';
import { setupLayout } from './layout.js';
import { setupMenuBar } from './menubar.js';
import { setupTree } from './tree.js';
import { setupWorksService } from './works-service.js';
import { setupSurfaces, spawnSurface } from './surfaces.js';

async function boot() {
  setupBus();                  // the A-Bus broker
  await setupWorkspace();      // the workspace VFS
  setupLayout();               // the rails surface host
  setupMenuBar();              // the desktop menu bar
  setupTree();                 // the project tree (placeholder)
  await setupWorksService();   // the `works` A-Bus service
  setupSurfaces();             // surface-signal tracking

  WKS.spawnSurface = spawnSurface;  // debug + smoke-test handle
  window.WKS = WKS;
  setStatus('Auditable Works — ready');
}

boot().catch((err) => {
  console.error('Works shell failed to boot:', err);
  setStatus('boot failed: ' + ((err && err.message) || err));
});
