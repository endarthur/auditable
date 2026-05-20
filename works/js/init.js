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

async function boot() {
  setupBus();              // the A-Bus broker
  await setupWorkspace();  // the workspace VFS
  setupLayout();           // the rails surface host
  setupMenuBar();          // the desktop menu bar
  setupTree();             // the project tree (placeholder)

  window.WKS = WKS;        // debug + smoke-test handle
  setStatus('Auditable Works — ready');
}

boot().catch((err) => {
  console.error('Works shell failed to boot:', err);
  setStatus('boot failed: ' + ((err && err.message) || err));
});
