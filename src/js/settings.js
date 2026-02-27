import { S, $ } from './state.js';
import { updateStatus, setMsg } from './ui.js';
import { updateAllEditorThemes, updateAllEditorLineNumbers, updateAllEditorReadOnly } from './cm6.js';

// ── SETTINGS ──

// Safe localStorage access — blob URL iframes have opaque origins where localStorage throws
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch {} }
function lsRemove(key) { try { localStorage.removeItem(key); } catch {} }

export function toggleSettings() {
  const overlay = $('#settingsOverlay');
  const panel = $('#settingsPanel');
  const open = !overlay.classList.contains('visible');
  overlay.classList.toggle('visible');
  panel.style.display = open ? 'block' : 'none';
  if (open) refreshModuleList();
}

export function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }
  $('#setTheme').value = theme;
  updateAllEditorThemes(theme !== 'light');
}

export function applyFontSize(size) {
  size = parseInt(size);
  document.documentElement.style.setProperty('--editor-font-size', size + 'px');
  $('#setFontSize').value = size;
  $('#setFontSizeVal').textContent = size;
}

export function applyWidth(w) {
  const nb = $('#notebook');
  nb.style.maxWidth = w;
  $('#setWidth').value = w;
}

export function applyLineNumbers(show) {
  const on = show === true || show === 'true' || show === 'on';
  document.documentElement.classList.toggle('hide-line-numbers', !on);
  const el = $('#setLineNumbers');
  if (el) el.value = on ? 'on' : 'off';
  updateAllEditorLineNumbers(on);
}

export function applyHeader(mode) {
  const root = document.documentElement;
  root.classList.remove('header-always', 'header-hover', 'header-compact');
  if (mode === 'always') root.classList.add('header-always');
  else if (mode === 'hover') root.classList.add('header-hover');
  else if (mode === 'compact') root.classList.add('header-compact');
  // 'auto' = no class, CSS media queries handle it
  $('#setHeader').value = mode;
}

// ── EXECUTION MODE ──

const __AUDITABLE_DEFAULT_EXEC_MODE__ = 'reactive';
const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = 'yes';

let _runOnLoad = 'yes';
let _showToggle = 'yes';
let _editorView = 'no';

export function applyExecMode(mode) {
  S.autorun = (mode === 'reactive');
  const btn = $('#autorunBtn');
  const btnMobile = document.getElementById('autorunBtnMobile');
  const cls = S.autorun ? 'autorun-on' : 'autorun-off';
  const text = S.autorun ? '\u25b6' : '\u2016';
  if (btn) { btn.textContent = text; btn.className = cls; btn.title = S.autorun ? 'reactive mode \u2014 cells auto-run on edit' : 'manual mode \u2014 only Run All or Ctrl+Enter'; }
  if (btnMobile) { btnMobile.textContent = text; btnMobile.className = cls; }
  const sel = $('#setExecMode');
  if (sel) sel.value = mode;
}

export function applyRunOnLoad(val) {
  _runOnLoad = val;
  const sel = $('#setRunOnLoad');
  if (sel) sel.value = val;
}

export function applyShowToggle(val) {
  _showToggle = val;
  document.documentElement.classList.toggle('hide-run-toggle', val === 'no');
  const sel = $('#setShowToggle');
  if (sel) sel.value = val;
}

export function applyGlobalExecMode(val) {
  if (val) lsSet('auditable-exec-mode', val);
  else lsRemove('auditable-exec-mode');
}

export function applyGlobalRunOnLoad(val) {
  if (val) lsSet('auditable-run-on-load', val);
  else lsRemove('auditable-run-on-load');
}

export function resolveExecMode() {
  return lsGet('auditable-exec-mode')
    || $('#setExecMode')?.value
    || __AUDITABLE_DEFAULT_EXEC_MODE__;
}

export function resolveRunOnLoad() {
  return lsGet('auditable-run-on-load')
    || _runOnLoad
    || __AUDITABLE_DEFAULT_RUN_ON_LOAD__;
}

export function applyEditorView(val) {
  _editorView = val;
  const sel = $('#setEditorView');
  if (sel) sel.value = val;
}

export function getEditorViewSetting() { return _editorView; }

export function getSettings() {
  const s = {
    theme: document.documentElement.classList.contains('light') ? 'light' : 'dark',
    fontSize: parseInt($('#setFontSize').value),
    width: $('#setWidth').value,
    header: $('#setHeader').value,
    lineNumbers: document.documentElement.classList.contains('hide-line-numbers') ? 'off' : 'on',
    execMode: S.autorun ? 'reactive' : 'manual',
    runOnLoad: _runOnLoad,
    showToggle: _showToggle,
    editorView: _editorView,
  };
  if (window._sizeCompare) s.sizeCompare = true;
  if (window._sizeCompareRef === 'content') s.sizeCompareRef = 'content';
  return s;
}

export function applySettings(s) {
  if (!s) return;
  if (s.theme) applyTheme(s.theme);
  if (s.fontSize) applyFontSize(s.fontSize);
  if (s.width) applyWidth(s.width);
  if (s.header) applyHeader(s.header);
  if (s.lineNumbers) applyLineNumbers(s.lineNumbers);
  if (s.execMode) applyExecMode(s.execMode);
  if (s.runOnLoad) applyRunOnLoad(s.runOnLoad);
  if (s.showToggle) applyShowToggle(s.showToggle);
  if (s.editorView) applyEditorView(s.editorView);
  // optional: size-compare.js (typeof guards for --lean builds without it)
  if (s.sizeCompare !== undefined && typeof applySizeCompare === 'function') applySizeCompare(s.sizeCompare);
  if (s.sizeCompareRef !== undefined && typeof applySizeCompareRef === 'function') applySizeCompareRef(s.sizeCompareRef);
}

export function togglePresent() {
  document.body.classList.toggle('presenting');
  updateAllEditorReadOnly(document.body.classList.contains('presenting'));
}

// ── ABOUT ──

const __AUDITABLE_VERSION__ = '0.0.0';
const __AUDITABLE_RELEASE__ = 'dev';
const __AUDITABLE_BUILD_DATE__ = 'dev';
const __AUDITABLE_BASE_SIZE__ = 0;

(function() {
  const ver = $('#aboutVersion');
  const build = $('#aboutBuild');
  const rt = $('#aboutRuntime');
  if (ver) ver.textContent = 'auditable v' + __AUDITABLE_VERSION__;
  if (build) build.textContent = (__AUDITABLE_RELEASE__ !== 'dev' ? __AUDITABLE_RELEASE__ + ' \u00b7 ' : '') + 'built ' + __AUDITABLE_BUILD_DATE__;
  if (rt && __AUDITABLE_BASE_SIZE__ > 0) rt.textContent = 'runtime ' + (__AUDITABLE_BASE_SIZE__ / 1024).toFixed(1) + ' KB';
})();

// ── EXECUTION SETTINGS INIT ──

(function() {
  const gm = lsGet('auditable-exec-mode') || '';
  const gr = lsGet('auditable-run-on-load') || '';
  const selGm = $('#setGlobalExecMode');
  const selGr = $('#setGlobalRunOnLoad');
  if (selGm) selGm.value = gm;
  if (selGr) selGr.value = gr;
})();

// ── MODULE MANAGEMENT ──

function formatSize(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function renderEntryRow(url, entry) {
  const src = typeof entry === 'string' ? entry : entry.source;
  const cellId = typeof entry === 'string' ? null : entry.cellId;
  const isBinary = typeof entry === 'object' && entry.binary;
  const size = src ? src.length : 0;
  const displaySize = isBinary ? Math.floor(size * 3 / 4) : size;

  const row = document.createElement('div');
  row.className = 'module-row';

  const urlSpan = document.createElement('span');
  urlSpan.className = 'module-url';
  urlSpan.textContent = url;
  urlSpan.title = url;
  row.appendChild(urlSpan);

  const info = document.createElement('span');
  info.className = 'module-info';
  info.textContent = (cellId != null ? 'cell ' + cellId + '  ' : '')
    + (isBinary && entry.compressed ? 'gzipped  ' : '')
    + formatSize(displaySize);
  row.appendChild(info);

  const btn = document.createElement('button');
  btn.className = 'module-remove';
  btn.textContent = '\u00d7';
  btn.title = isBinary ? 'remove binary' : 'remove module';
  btn.onclick = () => removeModule(url);
  row.appendChild(btn);

  return { row, size };
}

function renderSection(list, urls, mods, emptyText) {
  list.innerHTML = '';
  if (urls.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'module-empty';
    empty.textContent = emptyText;
    list.appendChild(empty);
    return 0;
  }
  let totalSize = 0;
  for (const url of urls) {
    const { row, size } = renderEntryRow(url, mods[url]);
    list.appendChild(row);
    totalSize += size;
  }
  const total = document.createElement('div');
  total.className = 'module-total';
  total.textContent = 'total  ' + formatSize(totalSize);
  list.appendChild(total);
  return totalSize;
}

export function refreshModuleList() {
  const modList = $('#moduleList');
  const binList = $('#binaryList');
  if (!modList) return;

  const mods = window._installedModules || {};
  const modUrls = [];
  const binUrls = [];
  for (const url of Object.keys(mods)) {
    const entry = mods[url];
    if (typeof entry === 'object' && entry.binary) binUrls.push(url);
    else modUrls.push(url);
  }

  renderSection(modList, modUrls, mods, 'no modules installed');
  if (binList) renderSection(binList, binUrls, mods, 'no binaries installed');
}

export function removeModule(url) {
  const entry = window._installedModules?.[url];
  const cellId = entry && typeof entry === 'object' ? entry.cellId : null;
  const kind = entry?.binary ? 'binary' : 'module';
  if (window._installedModules) delete window._installedModules[url];
  if (window._importCache) delete window._importCache[url];
  refreshModuleList();
  updateStatus();
  if (cellId != null) {
    setMsg(`removed ${kind} \u2014 cell ${cellId} will re-install it on next run`, 'warn');
  }
}
