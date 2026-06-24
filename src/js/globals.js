// ── GLOBAL BINDINGS ──
// This module wires exported functions to window.* for use by onclick/onchange
// handlers in template HTML and dynamically generated markup.
// Modules stay pure (no side effects, no window assignments).

import { $, S } from './state.js';
import * as hooks from './hooks.js';
import { renderMd } from './markdown.js';
import { TaggedContent } from './engine.js';
import { registerExtension, _ctUninstallPlugin, getExtension, getCellType, getTaggedLanguage, getExports, hasExports, listExtensions } from './cell-types.js';
import { registerProvider } from './stdlib.js';
import { convertCell, moveCell } from './cell-ops.js';
import { toggleAutorun } from './editor.js';
import { toggleSettings, togglePresent, applyTheme, applyFontSize, applyWidth, applyLineNumbers, applyHeader, applyExecMode, applyRunOnLoad, applyShowToggle, applyGlobalExecMode, applyGlobalRunOnLoad, applyEditorView, applyEmbedFonts, applyLicensesStrict, applyConfirmDataPackInstall, applyDefaultLang } from './settings.js';
import { toggleUpdate } from './update.js';
import { saveNotebook, savePackedNotebook, setSaveMode, toggleSaveTray, exportAsTxt, showExportDialog } from './save.js';
import { openIpynbDialog, exportAsIpynb } from './ipynb-bridge.js';
import { insertAt, getPreferredCodeType, setPreferredCodeType, setPreferredAndInsert, toggleCodeTray, updateToolbarCodeBtn, updateInsertBars, pickLang, addLangCell } from './ui.js';
import { toggleFs, fsImport } from './fs.js';
import { toggleMcpPanel, mcpConnect } from './mcp-adapter.js';
import { openFind, closeFind } from './find.js';
import { runAll, runDAG } from './exec.js';
import { clearAllOutputs as _clearAllOutputs } from './outputs.js';
import { createEditor } from './cm6.js';
import { toggleSplitView } from './split.js';
import { addCellWithUndo, deleteCellWithUndo, runSelectedCell, toggleToolbarMenu, toggleAddTray, toggleMoreTray, showInsertPicker, toggleTypePicker, collapseAll, expandAll, newNotebook, selectCell } from './keyboard.js';
import { enableEncryption, disableEncryption, changePassphrase, regenerateRecovery, lockNotebook } from './init.js';
import { refreshPluginList, refreshModuleList } from './settings.js';

// state
window.$ = $;
window.S = S;

// auditable namespace — single canonical surface for hooks, registries, services.
// Replaces the ad-hoc window._x slot pattern; see spec_inbox/shipped/auditable-hook-bus-spec.md.
window.auditable = window.auditable || {};
window.auditable.hooks = {
  on: hooks.on,
  once: hooks.once,
  off: hooks.off,
  emit: hooks.emit,
  emitAsync: hooks.emitAsync,
  listenerCount: hooks.listenerCount,
  setDagCellInterceptor: hooks.setDagCellInterceptor,
  getDagCellInterceptor: hooks.getDagCellInterceptor,
};
window.auditable.registerExtension = registerExtension;
window.auditable.getExtension = getExtension;
window.auditable.listExtensions = listExtensions;
window.auditable.getCellType = getCellType;
window.auditable.getTaggedLanguage = getTaggedLanguage;
window.auditable.getExports = getExports;
window.auditable.hasExports = hasExports;
// Display utilities — exposed so extensions can construct rich output
// without importing through the build's #-prefixed module map.
window.auditable.renderMd = renderMd;
window.auditable.TaggedContent = TaggedContent;

// editor
window.toggleAutorun = toggleAutorun;

// settings
window.toggleSettings = toggleSettings;
window.togglePresent = togglePresent;
window.applyTheme = applyTheme;
window.applyFontSize = applyFontSize;
window.applyWidth = applyWidth;
window.applyLineNumbers = applyLineNumbers;
window.applyHeader = applyHeader;
window.applyExecMode = applyExecMode;
window.applyRunOnLoad = applyRunOnLoad;
window.applyDefaultLang = applyDefaultLang;
window.applyShowToggle = applyShowToggle;
window.applyGlobalExecMode = applyGlobalExecMode;
window.applyGlobalRunOnLoad = applyGlobalRunOnLoad;
window.applyEditorView = applyEditorView;
window.applyEmbedFonts = applyEmbedFonts;
window.applyLicensesStrict = applyLicensesStrict;
window.applyConfirmDataPackInstall = applyConfirmDataPackInstall;

// update
window.toggleUpdate = toggleUpdate;

// save
window.saveNotebook = saveNotebook;
window.savePackedNotebook = savePackedNotebook;
window.setSaveMode = setSaveMode;
window.toggleSaveTray = toggleSaveTray;
window.exportAsTxt = exportAsTxt;
window.showExportDialog = showExportDialog;
window.openIpynbDialog = openIpynbDialog;
window.exportAsIpynb = exportAsIpynb;

// exec
window.runAll = runAll;
window.clearAllOutputs = async () => {
  await _clearAllOutputs();
  // Also clear the live output elements so the user sees the effect
  // immediately. Saved-output flag dropped so a subsequent run starts
  // from clean state.
  for (const cell of S.cells) {
    const el = cell.el?.querySelector?.('.cell-output');
    if (el) { el.innerHTML = ''; el.className = 'cell-output'; }
    cell.el?.classList?.remove('output-restored', 'error');
    delete cell._savedOutput;
  }
};

// ui
window.insertAt = insertAt;
window.updateInsertBars = updateInsertBars;
window.pickLang = pickLang;
window.addLangCell = addLangCell;
window.getPreferredCodeType = getPreferredCodeType;
window.setPreferredCodeType = setPreferredCodeType;
window.setPreferredAndInsert = setPreferredAndInsert;
window.toggleCodeTray = toggleCodeTray;
window.updateToolbarCodeBtn = updateToolbarCodeBtn;

// find
window.openFind = openFind;
window.closeFind = closeFind;

// stdlib
window.__auditable_registerProvider = registerProvider;

// cell ops
window.convertCell = convertCell;
window.moveCell = moveCell;

// keyboard / toolbar
window.addCellWithUndo = addCellWithUndo;
window.selectCell = selectCell;
window.deleteCellWithUndo = deleteCellWithUndo;
window.runSelectedCell = runSelectedCell;
window.toggleToolbarMenu = toggleToolbarMenu;
window.toggleAddTray = toggleAddTray;
window.toggleMoreTray = toggleMoreTray;
window.showInsertPicker = showInsertPicker;
window.toggleTypePicker = toggleTypePicker;
window.collapseAll = collapseAll;
window.expandAll = expandAll;
window.newNotebook = newNotebook;

// split view
window.toggleSplitView = toggleSplitView;

// filesystem panel
window.toggleFs = toggleFs;
window.fsImport = fsImport;

// mcp panel
window.toggleMcpPanel = toggleMcpPanel;
window.mcpConnect = mcpConnect;

// encryption
window.enableEncryption = enableEncryption;
window.disableEncryption = disableEncryption;
window.changePassphrase = changePassphrase;
window.regenerateRecovery = regenerateRecovery;
window.lockNotebook = lockNotebook;

// cell types / plugins — public surface lives on window.auditable.* (see top
// of file). _ctUninstallPlugin stays exposed because the settings panel UI
// references it inline.
window._ctUninstallPlugin = _ctUninstallPlugin;
window._ctCreateEditor = createEditor;
window._configurePluginAutocomplete = null; // set by complete.js init

// The notebook's VFS (window._notebookVFS / window._vfsPath) is built by the
// Host's provideVFS() — see host.js — called at the start of init(). The Host
// seam is what lets a standalone notebook and a Works surface differ only in
// which backend sits under /projects/self.

// late-bound helpers for cell-types.js (avoids circular dep)
window._ctRunDAG = (...args) => runDAG(...args);
window._ctRunAll = (...args) => runAll(...args);

// plugin install from settings panel
window._ctDoInstallPlugin = async () => {
  const input = document.getElementById('pluginInstallInput');
  if (!input || !input.value.trim()) return;
  const url = input.value.trim();
  input.value = '';
  try {
    // use the same install path as code cells
    if (window._installedModules?.[url]) {
      // already installed — just re-import (decompress if needed)
      const entry = window._installedModules[url];
      let src;
      if (typeof entry === 'object' && entry.compressed && !entry.binary) {
        const bytes = Uint8Array.from(atob(entry.source), c => c.charCodeAt(0));
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        src = await new Response(stream).text();
      } else {
        src = typeof entry === 'string' ? entry : entry.source;
      }
      const blob = new Blob([src], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      await import(blobUrl);
    } else {
      // fetch and install
      let bundleUrl = url;
      if (bundleUrl.includes('esm.sh') && !bundleUrl.includes('?bundle')) {
        bundleUrl += (bundleUrl.includes('?') ? '&' : '?') + 'bundle';
      }
      const resp = await fetch(bundleUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${bundleUrl}: ${resp.status}`);
      const source = await resp.text();
      if (!window._installedModules) window._installedModules = {};
      window._installedModules[url] = { source };
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      await import(blobUrl);
      if (!window._importCache) window._importCache = {};
      window._importCache[url] = await import(blobUrl);
    }
    refreshPluginList();
    refreshModuleList();
  } catch (e) {
    alert('Plugin install failed: ' + e.message);
  }
};
