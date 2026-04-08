// ── GLOBAL BINDINGS ──
// This module wires exported functions to window.* for use by onclick/onchange
// handlers in template HTML and dynamically generated markup.
// Modules stay pure (no side effects, no window assignments).

import { $, S } from './state.js';
import { registerCellType, registerExtension, hasExtension, getExtension, registerPlugin, _ctUninstallPlugin } from './cell-types.js';
import { registerProvider } from './stdlib.js';
import { convertCell, moveCell } from './cell-ops.js';
import { toggleAutorun, notifyDirty } from './editor.js';
import { toggleSettings, togglePresent, applyTheme, applyFontSize, applyWidth, applyLineNumbers, applyHeader, applyExecMode, applyRunOnLoad, applyShowToggle, applyGlobalExecMode, applyGlobalRunOnLoad, applyEditorView } from './settings.js';
import { toggleUpdate, checkForUpdate, applyOnlineUpdate, proceedUpdate, cancelUpdate, updateFromFile } from './update.js';
import { saveNotebook, savePackedNotebook, setSaveMode, toggleSaveTray, exportAsTxt, showExportDialog, doExportApp, closeExportDialog } from './save.js';
import { insertAt, getPreferredCodeType, setPreferredCodeType, setPreferredAndInsert, toggleCodeTray, updateToolbarCodeBtn } from './ui.js';
import { toggleFs, fsImport } from './fs.js';
import { toggleMcpPanel, mcpConnect } from './mcp-adapter.js';
import { openFind, closeFind } from './find.js';
import { runAll, runDAG } from './exec.js';
import { createEditor } from './cm6.js';
import { toggleSplitView } from './split.js';
import { addCellWithUndo, deleteCellWithUndo, runSelectedCell, toggleToolbarMenu, toggleAddTray, toggleMoreTray, showInsertPicker, toggleTypePicker, collapseAll, expandAll, newNotebook } from './keyboard.js';
import { enableEncryption, disableEncryption, changePassphrase, regenerateRecovery, lockNotebook, updateStrengthFeedback } from './init.js';
import { refreshPluginList, refreshModuleList } from './settings.js';
import { VFS, CommentBackend, MemoryBackend, path } from './vfs.js';

// state
window.$ = $;
window.S = S;

// editor
window.toggleAutorun = toggleAutorun;
window._notifyDirty = notifyDirty;

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
window.applyShowToggle = applyShowToggle;
window.applyGlobalExecMode = applyGlobalExecMode;
window.applyGlobalRunOnLoad = applyGlobalRunOnLoad;
window.applyEditorView = applyEditorView;

// update
window.toggleUpdate = toggleUpdate;
window.checkForUpdate = checkForUpdate;
window.applyOnlineUpdate = applyOnlineUpdate;
window.proceedUpdate = proceedUpdate;
window.cancelUpdate = cancelUpdate;
window.updateFromFile = updateFromFile;

// save
window.saveNotebook = saveNotebook;
window.savePackedNotebook = savePackedNotebook;
window.setSaveMode = setSaveMode;
window.toggleSaveTray = toggleSaveTray;
window.exportAsTxt = exportAsTxt;
window.showExportDialog = showExportDialog;
window.doExportApp = doExportApp;
window.closeExportDialog = closeExportDialog;

// exec
window.runAll = runAll;

// ui
window.insertAt = insertAt;
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
window.updateStrengthFeedback = updateStrengthFeedback;

// cell types / plugins
window.registerCellType = registerCellType;
window.registerExtension = registerExtension;
window.hasExtension = hasExtension;
window.getExtension = getExtension;
window.registerPlugin = registerPlugin;
window._ctUninstallPlugin = _ctUninstallPlugin;
window._ctCreateEditor = createEditor;
window._configurePluginAutocomplete = null; // set by complete.js init

// Shared VFS instance — notebook.fs delegates here, adder/Python uses it directly
const _notebookVFS = new VFS();
const _commentBackend = new CommentBackend({});
// Always read from the current _notebookFS Map (survives reassignment in init/crypto)
Object.defineProperty(_commentBackend, '_map', {
  get: () => {
    if (!window._notebookFS) window._notebookFS = new Map();
    return window._notebookFS;
  },
  configurable: true,
});
_commentBackend._syncComment = () => {
  if (window._notifyDirty) window._notifyDirty();
  clearTimeout(_commentBackend._syncTimer);
  _commentBackend._syncTimer = setTimeout(() => { if (window._syncFs) window._syncFs(); }, 500);
};
_notebookVFS._mounts.set('/home/nb', _commentBackend);
// /tmp — volatile scratch space (MemoryBackend, not saved in notebook)
_notebookVFS._mounts.set('/tmp', new MemoryBackend());
// /usr/lib/python — system Python modules (extensions install here)
_notebookVFS._mounts.set('/usr/lib/python', new MemoryBackend());
window._notebookVFS = _notebookVFS;
// auto-refresh files panel on VFS changes
let _fsRefreshTimer = null;
const _debouncedRefresh = () => {
  clearTimeout(_fsRefreshTimer);
  _fsRefreshTimer = setTimeout(() => { if (window._fsPanelRefresh) window._fsPanelRefresh(); }, 150);
};
_notebookVFS.on('write', _debouncedRefresh);
_notebookVFS.on('delete', _debouncedRefresh);
_notebookVFS.on('rename', _debouncedRefresh);
// VFS path utils for adder fs modules
window._vfsPath = path;

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
