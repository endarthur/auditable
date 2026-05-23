// Auditable Works — shell entry point.
//
// The registry boot imports this module last, after template.html is in the
// DOM, so the shell wires itself up immediately.

import { WKS, setStatus } from './state.js';
import { setupBus } from './bus.js';
import { setupWorkspace } from './workspace.js';
import { setupLayout, restoreLayout } from './layout.js';
import { setupMenuBar } from './menubar.js';
import { setupTree, refreshTree, newProject, newFile } from './tree.js';
import { setupWorksService } from './works-service.js';
import { setupSurfaces, spawnSurface, openPath } from './surfaces.js';
import { decompressLibs, decompressSurfaces, installSharedLibsToVfs } from './surface-registry.js';
import { serializeWorkspace, buildWorksHtml } from './persist.js';
import { importNotebook, importFileAsNotebook } from './import.js';
import { buildProjectExportHtml, exportProject } from './project-export.js';
import { mountHandle, unmountAt, restoreMounts } from './mount.js';

async function boot() {
  setupBus();                  // the A-Bus broker
  await setupWorkspace();      // the workspace VFS (storage home)
  await restoreMounts();       // reconnect saved /mnt/* disk-folder mounts
  await decompressLibs();      // shared library payloads → source strings
  await installSharedLibsToVfs(WKS.vfs);   // expose them at /usr/lib as @gcu/*
  await decompressSurfaces();  // embedded surface payloads → blob URLs
  setupLayout();               // the rails surface host
  setupMenuBar();              // the desktop menu bar
  setupTree();                 // the file-tree explorer
  await setupWorksService();   // the `works` A-Bus service
  setupSurfaces();             // surface-signal tracking
  await restoreLayout();       // reopen the saved tabs

  // Debug + smoke-test handles.
  WKS.spawnSurface = spawnSurface;
  WKS.openPath = openPath;
  WKS.refreshTree = refreshTree;
  WKS.newProject = newProject;
  WKS.importNotebook = importNotebook;
  WKS.importFileAsNotebook = importFileAsNotebook;
  WKS.buildProjectExportHtml = buildProjectExportHtml;
  WKS.exportProject = exportProject;
  WKS.newFile = newFile;
  WKS.mountHandle = mountHandle;
  WKS.unmountAt = unmountAt;
  WKS.serializeWorkspace = serializeWorkspace;
  WKS.buildWorksHtml = buildWorksHtml;
  window.WKS = WKS;

  setStatus('Auditable Works — ready');
}

boot().catch((err) => {
  console.error('Works shell failed to boot:', err);
  setStatus('boot failed: ' + ((err && err.message) || err));
});
