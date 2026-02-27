// ── GLOBAL BINDINGS ──
// This module wires exported functions to window.* for use by onclick/onchange
// handlers in template HTML and dynamically generated markup.
// Modules stay pure (no side effects, no window assignments).

import { $, S } from './state.js';
import { registerProvider } from './stdlib.js';
import { toggleAutorun } from './editor.js';
import { toggleSettings, togglePresent, applyTheme, applyFontSize, applyWidth, applyLineNumbers, applyHeader, applyExecMode, applyRunOnLoad, applyShowToggle, applyGlobalExecMode, applyGlobalRunOnLoad, applyEditorView } from './settings.js';
import { toggleUpdate, checkForUpdate, applyOnlineUpdate, proceedUpdate, cancelUpdate, updateFromFile } from './update.js';
import { saveNotebook, savePackedNotebook, setSaveMode, toggleSaveTray, exportAsTxt } from './save.js';
import { insertAt } from './ui.js';
import { openFind, closeFind } from './find.js';
import { runAll } from './exec.js';
import { toggleSplitView } from './split.js';
import { addCellWithUndo, deleteCellWithUndo, runSelectedCell, toggleToolbarMenu, toggleAddTray, toggleMoreTray, showInsertPicker, toggleTypePicker, collapseAll, expandAll, newNotebook } from './keyboard.js';

// state
window.$ = $;
window.S = S;

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

// exec
window.runAll = runAll;

// ui
window.insertAt = insertAt;

// find
window.openFind = openFind;
window.closeFind = closeFind;

// stdlib
window.__auditable_registerProvider = registerProvider;

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
