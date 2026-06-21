// Auditable Works — shell entry point.
//
// The registry boot imports this module last, after template.html is in the
// DOM, so the shell wires itself up immediately.

import { WKS, setStatus } from './state.js';
import { setupBus } from './bus.js';
import { setupWorkspace } from './workspace.js';
import { migrateLibraryLayout } from './migrate-library.js';
import { setupLayout, restoreLayout, isLayoutEmpty } from './layout.js';
import { setupMenuBar } from './menubar.js';
import { setupTree, refreshTree, newProject, newFile, duplicateProject } from './tree.js';
import { setupWorksService } from './works-service.js';
import { setupWorksMcp, connectAgentPeer, worksTools, agentToolsFor, grantAgent, revokeAgent, listAgentGrants, getAuditLog } from './mcp-adapter.js';
import { setupSurfaces, spawnSurface, openPath, getActiveSurface, callActiveNotebook } from './surfaces.js';
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
import { listProfiles, provisionProfile, provisionProfileSpec, exportProfileSpec, isProvisioned, getProvisioned } from './provision.js';
import { maybeShowFirstRunSetup, showSetupDialog } from './setup.js';
import { fragmentDecode, resolveCapsule } from '#capsule';
import { installGcudatBytes } from './gcudat-install.js';
import { buildProjectExportHtml, exportProject } from './project-export.js';
import { mountHandle, unmountAt, restoreMounts } from './mount.js';
import { installGlobalFileDrop, installGcupkgBytes } from './file-ops.js';
import { installShellAuditable, evaluateAllWorksScripts } from './extension-loader.js';
import { installBuiltinPackages } from './lib-builtins-loader.js';
import { declareInstalledServices } from './extension-services.js';
import { buildSurfaceToolRegistry, registerSurfaceTools } from './surface-tools.js';
import { registerGcuSw } from '#sw-register';
import { readSettings } from './settings-store.js';

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
  // Surface-contributed agent tools: scan /lib for gcu.agentTools into the
  // registry the worksListSurfaceTools/worksCallSurfaceTool meta-tools serve.
  await buildSurfaceToolRegistry();
  // numen-for-Works: register the shell's MCP tools through the numen shim, if
  // present. No-op without the shim (the live transport isn't wired yet) — the
  // gated-agent-peer machinery is here and exercised by works-smoke regardless.
  try { await setupWorksMcp(); } catch (e) { console.warn('[works] mcp:', e); }
  setupSurfaces();             // surface-signal tracking
  await restoreLayout();       // reopen the saved tabs
  // An empty workspace (fresh, or all tabs closed last session) opens the
  // Launcher — Works' "what do you want to make?" home (JupyterLab-style). A
  // returning user's saved tabs reopen above, so this only fires when nothing
  // was restored. (A first-run setup modal, if any, layers over it.)
  if (isLayoutEmpty()) { try { spawnSurface('launcher', { title: 'Launcher' }); } catch (e) { console.warn('[works] launcher autostart:', e); } }

  // Debug + smoke-test handles.
  WKS.spawnSurface = spawnSurface;
  WKS.openPath = openPath;
  WKS.getActiveSurface = getActiveSurface;      // the focused surface record
  WKS.callActiveNotebook = callActiveNotebook;  // drive the active notebook over A-Bus (Run All, etc.)
  WKS.connectAgentPeer = connectAgentPeer;      // numen-for-Works: a gated agent A-Bus peer
  WKS.worksTools = worksTools;                   // numen-for-Works: the agent tool set (over a peer)
  WKS.agentToolsFor = agentToolsFor;             // numen multichannel: per-identity tool set + gated peer
  WKS.grantAgent = grantAgent;                   // consent backend: scope an agent's workspace writes
  WKS.revokeAgent = revokeAgent;
  WKS.listAgentGrants = listAgentGrants;
  WKS.getAuditLog = getAuditLog;                 // observability: the agent-action ledger
  WKS.registerSurfaceTools = registerSurfaceTools; // surface tools: programmatic/post-install registry add
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
  WKS.listProfiles = listProfiles;          // baked distribution profiles (first-run setup list)
  WKS.provisionProfile = provisionProfile;  // (name, catalogUrl) → install a profile's packages + settings + marker
  WKS.provisionProfileSpec = provisionProfileSpec; // (spec, catalogUrl) → provision a raw .gcuprofile spec
  WKS.exportProfileSpec = exportProfileSpec; // ({name,title,description}) → .gcuprofile spec of this workspace
  WKS.isProvisioned = isProvisioned;        // has this workspace been provisioned?
  WKS.getProvisioned = getProvisioned;      // the provisioned marker (profile + what installed)
  WKS.showSetup = showSetupDialog;          // open the setup / change-profile dialog (Tools / Help)
  WKS.registryAddSource = addSourceSilent;  // (url, name) → add a registry source
  WKS.metaGet = metaGet;                    // shell-meta read (e.g. registry.catalogUrl override)
  WKS.metaSet = metaSet;                    // shell-meta write
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

  // First-run setup — on the lean works-core, if this workspace hasn't been
  // provisioned yet, offer the profile picker. No-op on a monolith (no profiles)
  // or an already-provisioned workspace. Fire-and-forget over the ready shell.
  maybeShowFirstRunSetup().catch((e) => console.warn('[works] setup:', (e && e.message) || e));

  // PWA: @gcu/sw page-side companion — persistent storage (the workspace
  // lives in IndexedDB) + the gcu-sw:* update protocol. When the deploy-only
  // service worker finds a newer shell it posts update-available → the banner;
  // Reload applies via a COORDINATED reload (every tab lands on the new shell
  // together). Registration itself is owned by the works repo's injected
  // snippet (it knows the deploy layout), so no `url` here. All best-effort —
  // registerGcuSw no-ops on file:// / older engines.
  WKS.sw = registerGcuSw({ persist: true, onUpdateAvailable: () => _showUpdateBanner() });
  // Re-apply the persisted auto-check preference. The service worker resets
  // its own _autoCheck flag whenever it restarts, so the shell settings are
  // the source of truth across reloads — that's what makes the Settings →
  // Updates toggle actually stick. Fire-and-forget; best-effort.
  readSettings(WKS.vfs)
    .then((s) => { if (WKS.sw && s && s.updates) WKS.sw.setAutoCheck(s.updates.autoCheck !== false); })
    .catch(() => { /* */ });
}

let _updateBannerShown = false;
function _showUpdateBanner() {
  if (_updateBannerShown || typeof document === 'undefined') return;
  _updateBannerShown = true;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed; left:50%; transform:translateX(-50%); bottom:16px; z-index:99999; '
    + 'display:flex; gap:10px; align-items:center; padding:8px 14px; border-radius:8px; '
    + 'background:var(--au-surface-raised,#1b2026); color:var(--au-fg,#e6e9ec); '
    + 'border:1px solid var(--au-border,#2a313a); box-shadow:0 4px 16px rgba(0,0,0,.4); font:13px ui-sans-serif,system-ui;';
  const txt = document.createElement('span');
  txt.textContent = 'A new version of Works is available.';
  const reload = document.createElement('button');
  reload.textContent = 'Reload';
  reload.style.cssText = 'font:inherit; font-weight:600; padding:4px 12px; border-radius:5px; cursor:pointer; '
    + 'border:1px solid var(--au-action,#d97a3c); background:var(--au-action,#d97a3c); color:var(--au-surface-deep,#0d1014);';
  reload.addEventListener('click', () => WKS.sw ? WKS.sw.applyUpdate() : location.reload());
  const dismiss = document.createElement('button');
  dismiss.textContent = '✕';
  dismiss.style.cssText = 'font:inherit; padding:4px 8px; border-radius:5px; cursor:pointer; '
    + 'border:1px solid var(--au-border,#2a313a); background:transparent; color:var(--au-fg-soft,#9aa3ad);';
  dismiss.addEventListener('click', () => bar.remove());
  bar.append(txt, reload, dismiss);
  document.body.appendChild(bar);
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
