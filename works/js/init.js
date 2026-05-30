// Auditable Works — shell entry point.
//
// The registry boot imports this module last, after template.html is in the
// DOM, so the shell wires itself up immediately.

import { WKS, setStatus } from './state.js';
import { setupBus } from './bus.js';
import { setupWorkspace } from './workspace.js';
import { setupLayout, restoreLayout } from './layout.js';
import { setupMenuBar } from './menubar.js';
import { setupTree, refreshTree, newProject, newFile, duplicateProject } from './tree.js';
import { setupWorksService } from './works-service.js';
import { setupSurfaces, spawnSurface, openPath } from './surfaces.js';
import { decompressLibs, decompressSurfaces, installSharedLibsToVfs } from './surface-registry.js';
import { installDocsToVfs } from './docs-loader.js';
import { installBuiltinBooks } from './books-loader.js';
import { installExamplesToVfs, hasExamples } from './examples-loader.js';
import { serializeWorkspace, buildWorksHtml } from './persist.js';
import { importNotebook, importFileAsNotebook } from './import.js';
import { importEpubBytes } from './book-import.js';
import { metaGet, metaSet } from './meta.js';
import { installGcudatBytes } from './gcudat-install.js';
import { buildProjectExportHtml, exportProject } from './project-export.js';
import { mountHandle, unmountAt, restoreMounts } from './mount.js';
import { installGlobalFileDrop } from './file-ops.js';
import { installShellAuditable, evaluateAllWorksScripts } from './extension-loader.js';

async function boot() {
  setupBus();                  // the A-Bus broker
  await setupWorkspace();      // the workspace VFS (storage home)
  await restoreMounts();       // reconnect saved /mnt/* disk-folder mounts
  await decompressLibs();      // shared library payloads → source strings
  await installSharedLibsToVfs(WKS.vfs);   // expose them at /usr/lib as @gcu/*
  await installDocsToVfs(WKS.vfs);         // /usr/share/doc/ for the docs surface
  await installBuiltinBooks(WKS.vfs);      // /usr/share/books/gcu-docs/ (the docs, as a reader book)
  await installExamplesToVfs(WKS.vfs);     // /usr/share/examples/ (works-all only)
  await decompressSurfaces();  // embedded surface payloads → blob URLs
  installShellAuditable();     // window.auditable.registerExtension in shell context
  await evaluateAllWorksScripts();  // run /lib/<pkg>/works.js for each installed extension
  setupLayout();               // the rails surface host
  setupMenuBar();              // the desktop menu bar
  setupTree();                 // the file-tree explorer
  installGlobalFileDrop();     // drag OS files (.txt/.html/.ipynb) onto the shell
  await setupWorksService();   // the `works` A-Bus service
  setupSurfaces();             // surface-signal tracking
  await restoreLayout();       // reopen the saved tabs

  // Debug + smoke-test handles.
  WKS.spawnSurface = spawnSurface;
  WKS.openPath = openPath;
  WKS.refreshTree = refreshTree;
  WKS.newProject = newProject;
  WKS.duplicateProject = duplicateProject;
  WKS.importNotebook = importNotebook;
  WKS.importFileAsNotebook = importFileAsNotebook;
  WKS.importBook = importEpubBytes;   // .epub bytes → /home/.books/library/<slug>/
  WKS.installGcudat = installGcudatBytes;   // .gcudat bytes → routed by kind
  WKS.buildProjectExportHtml = buildProjectExportHtml;
  WKS.exportProject = exportProject;
  WKS.newFile = newFile;
  WKS.mountHandle = mountHandle;
  WKS.unmountAt = unmountAt;
  WKS.serializeWorkspace = serializeWorkspace;
  WKS.buildWorksHtml = buildWorksHtml;

  // Extension diagnostics + on-demand reload. If a contributed surface
  // or context-menu item vanishes between reloads, run reloadExtensions()
  // in the console to re-evaluate every /lib/<pkg>/works.js without a
  // full page reload. listExtensions() returns the current registry —
  // names that don't appear there didn't register on boot.
  WKS.reloadExtensions = () => evaluateAllWorksScripts();
  WKS.listExtensions = () =>
    (window.auditable?.listExtensions?.() || []).map((m) => ({
      name: m.name, version: m.version,
      surfaces: (m.surfaces || []).map((s) => s.kind || s.name),
      contextMenu: (m.contextMenu || []).map((c) => c.label),
    }));

  // Diagnostic: list every file under /lib/<pkg>/ recursively so we can
  // verify exactly what the gcupkg installer wrote and what survived a
  // reload. Usage: `await WKS.lsLib('@gcu/carotte')` in the shell console.
  WKS.lsLib = async (pkgName) => {
    const base = /^@[\w.-]+\/[\w.-]+$/.test(pkgName) ? '/lib/' + pkgName : '/lib/local/' + pkgName;
    const out = [];
    async function walk(p) {
      let entries;
      try { entries = await WKS.vfs.readdir(p, { stat: true }); }
      catch (e) { out.push({ path: p, error: e.message }); return; }
      for (const e of entries) {
        const sub = p + '/' + e.name;
        if (e.type === 'directory') {
          out.push({ path: sub, type: 'directory' });
          await walk(sub);
        } else {
          let size = e.size;
          if (size == null) {
            try { const s = await WKS.vfs.stat(sub); size = s.size; } catch {}
          }
          out.push({ path: sub, type: 'file', size });
        }
      }
    }
    await walk(base);
    return out;
  };

  // Broadcast a debug flag to every surface iframe — the iframes are
  // in opaque origins (blob:file://) so devtools-set `window.*` flags
  // on the parent don't reach them. postMessage crosses the boundary.
  // Usage from the shell console:
  //   WKS.setOutputsDebug(true)   // turn on
  //   WKS.setOutputsDebug(false)  // turn off
  WKS.setOutputsDebug = (value) => {
    for (const f of document.querySelectorAll('iframe')) {
      try { f.contentWindow.postMessage({ type: 'set-outputs-debug', value: !!value }, '*'); }
      catch { /* not a peer that listens — skip */ }
    }
  };

  // Easter egg — the DD-60 "DADA Diskman" reader skin. Off by default and out of
  // the way: nothing dispatches books to it. Type "dada" anywhere in the shell
  // (outside a text field) to toggle it; when on, a book directory's right-click
  // menu offers "Open in DADA Diskman". The flag persists in shell meta.
  WKS.dd60Enabled = (await metaGet('skin.dd60').catch(() => false)) === true;
  let _dadaSeq = '';
  window.addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) { _dadaSeq = ''; return; }
    if (!e.key || e.key.length !== 1) { _dadaSeq = ''; return; }
    _dadaSeq = (_dadaSeq + e.key.toLowerCase()).slice(-4);
    if (_dadaSeq === 'dada') {
      _dadaSeq = '';
      WKS.dd60Enabled = !WKS.dd60Enabled;
      metaSet('skin.dd60', WKS.dd60Enabled).catch(() => {});
      setStatus(WKS.dd60Enabled
        ? '▥ DADA Diskman unlocked — right-click a book → Open in DADA Diskman'
        : 'DADA Diskman skin off');
    }
  });

  window.WKS = WKS;

  setStatus('Auditable Works — ready');
}

boot().catch((err) => {
  console.error('Works shell failed to boot:', err);
  setStatus('boot failed: ' + ((err && err.message) || err));
});
