// Auditable Works — shell entry point.
//
// The registry boot imports this module last, after template.html is in the
// DOM, so the shell wires itself up immediately.

import { WKS, setStatus } from './state.js';
import { setupBus } from './bus.js';
import { setupWorkspace } from './workspace.js';
import { migrateLibraryLayout } from './migrate-library.js';
import { setupLayout, restoreLayout } from './layout.js';
import { setupMenuBar } from './menubar.js';
import { setupTree, refreshTree, newProject, newFile, duplicateProject } from './tree.js';
import { setupWorksService } from './works-service.js';
import { setupSurfaces, spawnSurface, openPath } from './surfaces.js';
import { decompressLibs, decompressSurfaces, installSharedLibsToVfs } from './surface-registry.js';
import { installDocsToVfs } from './docs-loader.js';
import { installBuiltinBooks } from './books-loader.js';
import { installExamplesToVfs, hasExamples } from './examples-loader.js';
import { serializeWorkspace, buildWorksHtml, categorizeDump, applyExportSelection } from './persist.js';
import { chooseExport } from './export-dialog.js';
import { diskFromDump, hydrateVfsFromDisk, readDiskManifest, mountDisk, openDiskAsWorkspace } from './disk.js';
import { maybePromptReinstall, planReinstall, runReinstall, readRecipe } from './reinstall.js';
import { importNotebook, importFileAsNotebook } from './import.js';
import { importEpubBytes } from './book-import.js';
import { metaGet, metaSet } from './meta.js';
import { openLibraryDialog, installByName, provisionPackage, addSourceSilent, installFromCapsule } from './registry.js';
import { fragmentDecode, resolveCapsule } from '#capsule';
import { installGcudatBytes } from './gcudat-install.js';
import { buildProjectExportHtml, exportProject } from './project-export.js';
import { mountHandle, unmountAt, restoreMounts } from './mount.js';
import { installGlobalFileDrop, installGcupkgBytes } from './file-ops.js';
import { installShellAuditable, evaluateAllWorksScripts } from './extension-loader.js';
import { installBuiltinPackages } from './lib-builtins-loader.js';
import { declareInstalledServices } from './extension-services.js';

async function boot() {
  setupBus();                  // the A-Bus broker
  await setupWorkspace();      // the workspace VFS (storage home)
  await migrateLibraryLayout(WKS.vfs)   // one-time pre-1.0: /home/.books → /home/library
    .catch((e) => console.warn('[works] migrate:', (e && e.message) || e));
  await restoreMounts();       // reconnect saved /mnt/* disk-folder mounts
  await decompressLibs();      // shared library payloads → source strings
  await installSharedLibsToVfs(WKS.vfs);   // expose them at /usr/lib as @gcu/*
  await installBuiltinPackages(WKS.vfs);   // seed /lib with distribution-shipped packages (works/works-all)
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
  await setupWorksService();   // the `works` A-Bus service (core — eager, the bootstrap service)
  // FEATURE services (e.g. the workbench's `pipeline` flowsheet engine) are declared
  // COLD from each installed package's `gcu.services` data manifest — the broker
  // activates one on its first call (dependency-injecting the package's declared libs,
  // then running its setupService). No feature-service code runs until the feature is
  // used; works-core ships none of these packages, so it carries none of their code.
  // (works-contribution-registry-spec — the declarative, provisionable model.)
  await declareInstalledServices();
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
  WKS.importBook = importEpubBytes;   // .epub bytes → /home/library/books/<slug>/
  WKS.installGcudat = installGcudatBytes;   // .gcudat bytes → routed by kind
  WKS.installGcupkgBytes = installGcupkgBytes;   // .gcupkg bytes → parse + install to /lib (registry/programmatic)
  WKS.browseLibrary = openLibraryDialog;    // Browse Library dialog (content registry)
  WKS.registryInstall = installByName;      // (sourceUrl, name) → install an entry (interactive: confirms)
  WKS.provisionPackage = provisionPackage;  // (sourceUrl, name) → install + dep-closure, no prompt (provisioning)
  WKS.registryAddSource = addSourceSilent;  // (url, name) → add a registry source
  WKS.buildProjectExportHtml = buildProjectExportHtml;
  WKS.exportProject = exportProject;
  WKS.newFile = newFile;
  WKS.mountHandle = mountHandle;
  WKS.unmountAt = unmountAt;
  WKS.serializeWorkspace = serializeWorkspace;
  WKS.buildWorksHtml = buildWorksHtml;
  WKS.categorizeDump = categorizeDump;
  WKS.applyExportSelection = applyExportSelection;
  WKS.chooseExport = chooseExport;
  WKS.diskFromDump = diskFromDump;
  WKS.hydrateVfsFromDisk = hydrateVfsFromDisk;
  WKS.readDiskManifest = readDiskManifest;
  WKS.mountDisk = mountDisk;
  WKS.openDiskAsWorkspace = openDiskAsWorkspace;
  WKS.readReinstallRecipe = readRecipe;
  WKS.planReinstall = planReinstall;
  WKS.runReinstall = runReinstall;
  WKS.maybePromptReinstall = maybePromptReinstall;
  WKS.migrateLibraryLayout = migrateLibraryLayout;

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
  // the way: nothing dispatches books to it. Enabled via a discreet toggle in the
  // About dialog (see about.js); when on, a book directory's right-click menu
  // offers "Open in DADA Diskman". The flag persists in shell meta (skin.dd60).
  WKS.dd60Enabled = (await metaGet('skin.dd60').catch(() => false)) === true;
  WKS.setDd60Enabled = (v) => { WKS.dd60Enabled = !!v; metaSet('skin.dd60', WKS.dd60Enabled).catch(() => {}); };

  window.WKS = WKS;

  setStatus('Auditable Works — ready');

  // Capsule consumer — if launched with a `#capsule=…` fragment (a share-link /
  // QR), decode it and act. Today: a registry-pointer payload
  // ({ install: { source, name } }) installs that pack — "QR → install".
  // Fire-and-forget so boot completes; the trust prompt (for a new source)
  // surfaces over the ready shell.
  handleCapsuleBoot().catch((e) => setStatus('capsule: ' + ((e && e.message) || e)));

  // Lean-export reinstall — if this workspace carries a reinstall recipe with
  // missing content, prompt + restore over the ready shell. Fire-and-forget so
  // boot completes; never let a reinstall failure break the desktop.
  maybePromptReinstall().catch((e) => console.warn('[works] reinstall:', (e && e.message) || e));
}

async function handleCapsuleBoot() {
  const m = /[#&]capsule=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  // One-shot: strip the fragment so a reload doesn't re-install.
  history.replaceState(null, '', location.pathname + location.search);
  let payload;
  try { payload = JSON.parse(await resolveCapsule(fragmentDecode(decodeURIComponent(m[1])))); }
  catch (e) { setStatus('capsule: could not decode (' + ((e && e.message) || e) + ')'); return; }
  if (payload && payload.install && payload.install.source && payload.install.name) {
    try { await installFromCapsule(payload.install.source, payload.install.name); }
    catch (e) { setStatus('capsule install failed: ' + ((e && e.message) || e)); }
  } else {
    setStatus('capsule: unsupported payload');
  }
}

boot().catch((err) => {
  console.error('Works shell failed to boot:', err);
  setStatus('boot failed: ' + ((err && err.message) || err));
});
