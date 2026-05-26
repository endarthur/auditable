import { S, $ } from './state.js';
import { updateStatus, setMsg, setPreferredCodeType, getRawPreferredCodeType } from './ui.js';
import { updateAllEditorThemes, updateAllEditorLineNumbers, updateAllEditorReadOnly } from './cm6.js';
import { hasSwitchboardFonts, fetchSwitchboardFonts } from './save.js';
import * as hooks from './hooks.js';
import { aggregateFromInstalledModules, aggregateFromBuildLicenses } from '#licenses';

// Build-time injection — populated by build.js from vendor-licenses.json at
// repo root. Shape: { <name>: { spdx, version, homepage, description, text } }.
// Empty {} in source so dev/test runs work without rebuilding; build.js
// rewrites this single line to the real manifest.
const __BUILD_LICENSES__ = {};

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
  if (open) {
    refreshPluginList();
    refreshModuleList();
    refreshLicensesList();
  }
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  $('#setTheme').value = theme;
  updateAllEditorThemes(theme !== 'light');
  hooks.emit("notebook:dirty");
}

export function applyFontSize(size) {
  size = parseInt(size);
  document.documentElement.style.setProperty('--editor-font-size', size + 'px');
  $('#setFontSize').value = size;
  $('#setFontSizeVal').textContent = size;
  hooks.emit("notebook:dirty");
}

export function applyWidth(w) {
  const nb = $('#notebook');
  // Bare numeric values are px; percentage / keyword values pass through.
  // Without this, `nb.style.maxWidth = "860"` is rejected as invalid CSS
  // and the previous valid value (e.g. "100%" from "full") sticks.
  const cssVal = /^\d+$/.test(w) ? w + 'px' : w;
  nb.style.maxWidth = cssVal;
  $('#setWidth').value = w;
  hooks.emit("notebook:dirty");
}

export function applyLineNumbers(show) {
  const on = show === true || show === 'true' || show === 'on';
  document.documentElement.classList.toggle('hide-line-numbers', !on);
  const el = $('#setLineNumbers');
  if (el) el.value = on ? 'on' : 'off';
  updateAllEditorLineNumbers(on);
  hooks.emit("notebook:dirty");
}

export function applyHeader(mode) {
  const root = document.documentElement;
  root.classList.remove('header-always', 'header-hover', 'header-compact');
  if (mode === 'always') root.classList.add('header-always');
  else if (mode === 'hover') root.classList.add('header-hover');
  else if (mode === 'compact') root.classList.add('header-compact');
  // 'auto' = no class, CSS media queries handle it
  $('#setHeader').value = mode;
  hooks.emit("notebook:dirty");
}

// ── EXECUTION MODE ──

const __AUDITABLE_DEFAULT_EXEC_MODE__ = 'reactive';
// Default flipped from 'yes' to 'no' alongside the output sidecar
// (outputs.js): the notebook restores its saved outputs on open, so
// auto-running every cell on load is no longer the way to make the
// notebook look "ready" — it would just clobber the saved state and
// re-do work the user already did. Editing a cell still re-runs it
// reactively per S.autorun.
const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = 'no';

let _runOnLoad = 'no';
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
  hooks.emit("notebook:dirty");
}

export function applyRunOnLoad(val) {
  _runOnLoad = val;
  const sel = $('#setRunOnLoad');
  if (sel) sel.value = val;
  hooks.emit("notebook:dirty");
}

export function applyShowToggle(val) {
  _showToggle = val;
  document.documentElement.classList.toggle('hide-run-toggle', val === 'no');
  const sel = $('#setShowToggle');
  if (sel) sel.value = val;
  hooks.emit("notebook:dirty");
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
  hooks.emit("notebook:dirty");
}

export function getEditorViewSetting() { return _editorView; }

let _embedFonts = false;

export async function applyEmbedFonts(val) {
  const next = val === true || val === 'true' || val === 'on';
  const el = $('#setEmbedFonts');
  // If turning ON for the first time, fetch fonts from Google Fonts
  // (cached in localStorage). save.js imports from settings.js but the
  // circular reference resolves at call time, not module-init time.
  if (next && !_embedFonts) {
    if (!hasSwitchboardFonts()) {
      if (el) el.disabled = true;
      setMsg('fetching Switchboard fonts…', 'info');
      try {
        await fetchSwitchboardFonts();
        setMsg('fonts loaded — will embed in next save', 'ok');
      } catch (e) {
        setMsg('font fetch failed: ' + e.message, 'err');
        if (el) { el.value = 'off'; el.disabled = false; }
        return;
      }
      if (el) el.disabled = false;
    }
  }
  _embedFonts = next;
  if (el) el.value = _embedFonts ? 'on' : 'off';
  hooks.emit("notebook:dirty");
}

export function getEmbedFontsSetting() { return _embedFonts; }

export function getSettings() {
  const s = {
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    fontSize: parseInt($('#setFontSize').value),
    width: $('#setWidth').value,
    header: $('#setHeader').value,
    lineNumbers: document.documentElement.classList.contains('hide-line-numbers') ? 'off' : 'on',
    execMode: S.autorun ? 'reactive' : 'manual',
    runOnLoad: _runOnLoad,
    showToggle: _showToggle,
    editorView: _editorView,
  };
  const rawPref = getRawPreferredCodeType();
  if (rawPref && rawPref !== 'code') s.preferredCodeType = rawPref;
  if (window._sizeCompare) s.sizeCompare = true;
  if (window._sizeCompareRef === 'content') s.sizeCompareRef = 'content';
  if (_embedFonts) s.embedFonts = true;
  if (window._auditableLicensesStrict) s.licensesStrict = true;
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
  if (s.embedFonts !== undefined) applyEmbedFonts(s.embedFonts);
  if (s.licensesStrict !== undefined) applyLicensesStrict(s.licensesStrict);
  if (s.preferredCodeType) setPreferredCodeType(s.preferredCodeType);
  // optional: size-compare.js (typeof guards for --lean builds without it)
  if (s.sizeCompare !== undefined && typeof applySizeCompare === 'function') applySizeCompare(s.sizeCompare);
  if (s.sizeCompareRef !== undefined && typeof applySizeCompareRef === 'function') applySizeCompareRef(s.sizeCompareRef);
}

export function togglePresent() {
  document.body.classList.toggle('presenting');
  updateAllEditorReadOnly(document.body.classList.contains('presenting'));
}

// ── ABOUT ──

export const __AUDITABLE_VERSION__ = '0.0.0';
export const __AUDITABLE_RELEASE__ = 'dev';
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
  const isCompressed = typeof entry === 'object' && entry.compressed;
  const size = src ? src.length : 0;
  const displaySize = (isBinary || isCompressed) ? Math.floor(size * 3 / 4) : size;

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
    + (isCompressed ? 'gzipped  ' : '')
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
  const pluginUrls = window._auditablePlugins || new Map();
  const modUrls = [];
  const binUrls = [];
  for (const url of Object.keys(mods)) {
    if (pluginUrls.has(url)) continue; // filter out plugins — shown in plugins section
    const entry = mods[url];
    if (typeof entry === 'object' && entry.binary) binUrls.push(url);
    else modUrls.push(url);
  }

  renderSection(modList, modUrls, mods, 'no modules installed');
  if (binList) renderSection(binList, binUrls, mods, 'no binaries installed');
}

export function refreshPluginList() {
  const list = $('#pluginList');
  if (!list) return;
  list.innerHTML = '';

  const plugins = window._auditablePlugins || new Map();
  if (plugins.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'module-empty';
    empty.textContent = 'no plugins installed';
    list.appendChild(empty);
    return;
  }

  for (const [url, meta] of plugins) {
    const row = document.createElement('div');
    row.className = 'module-row';
    row.style.flexWrap = 'wrap';

    const urlSpan = document.createElement('span');
    urlSpan.className = 'module-url';
    // show short name before the dash, full url on hover
    const shortName = url.replace(/^@\w+\//, '');
    urlSpan.textContent = shortName;
    urlSpan.title = url;
    row.appendChild(urlSpan);

    const entry = window._installedModules?.[url];
    const src = entry ? (typeof entry === 'string' ? entry : entry.source) : null;
    const sizeText = src ? formatSize(src.length) : '';
    if (sizeText) {
      const info = document.createElement('span');
      info.className = 'module-info';
      info.textContent = sizeText;
      row.appendChild(info);
    }

    const btn = document.createElement('button');
    btn.className = 'module-remove';
    btn.textContent = '\u00d7';
    btn.title = 'uninstall plugin';
    btn.onclick = () => {
      if (window._ctUninstallPlugin) window._ctUninstallPlugin(url);
      hooks.emit("notebook:dirty");
      refreshPluginList();
      refreshModuleList();
      updateStatus();
    };
    row.appendChild(btn);
    list.appendChild(row);

    // description line — wraps below the name
    if (meta.description) {
      const desc = document.createElement('div');
      desc.className = 'module-desc';
      desc.textContent = meta.description;
      list.appendChild(desc);
    }
  }
}

export function removeModule(url) {
  const entry = window._installedModules?.[url];
  const cellId = entry && typeof entry === 'object' ? entry.cellId : null;
  const kind = entry?.binary ? 'binary' : 'module';
  if (window._installedModules) delete window._installedModules[url];
  if (window._importCache) delete window._importCache[url];
  hooks.emit("notebook:dirty");
  refreshModuleList();
  refreshLicensesList();
  updateStatus();
  if (cellId != null) {
    setMsg(`removed ${kind} \u2014 cell ${cellId} will re-install it on next run`, 'warn');
  }
}

// \u2500\u2500 LICENSES \u2500\u2500
// Strict mode flips a window-level flag read by cell-builtins/modules.js
// at install() time. When true, install() throws on copyleft/unknown
// licenses (the user must remove the install or relax the policy).

export function applyLicensesStrict(on) {
  window._auditableLicensesStrict = !!on;
  const sel = $('#setLicensesStrict');
  if (sel) sel.value = on ? 'on' : 'off';
  hooks.emit("notebook:dirty");
}

const _CLS_BADGE_STYLE = {
  'permissive':       'color: var(--au-text); background: rgba(40,160,80,0.12); border: 1px solid rgba(40,160,80,0.35);',
  'weak-copyleft':    'color: var(--au-text); background: rgba(220,160,40,0.14); border: 1px solid rgba(220,160,40,0.40);',
  'strong-copyleft': 'color: var(--au-text); background: rgba(220,80,60,0.18); border: 1px solid rgba(220,80,60,0.45);',
  'unknown':          'color: var(--au-text); background: rgba(140,140,140,0.16); border: 1px solid rgba(140,140,140,0.40);',
};

function _renderLicenseRow(entry) {
  const row = document.createElement('div');
  row.className = 'module-row';

  const label = entry.version ? `${entry.pkg}@${entry.version}` : entry.pkg;
  const nameSpan = document.createElement('span');
  nameSpan.className = 'module-url';
  nameSpan.textContent = label;
  nameSpan.title = entry.path || '';
  row.appendChild(nameSpan);

  const badge = document.createElement('span');
  badge.className = 'license-badge';
  badge.textContent = entry.spdx || 'UNKNOWN';
  badge.title = entry.classification + (entry.copyright ? ' \u2014 ' + entry.copyright : '');
  badge.style.cssText = (_CLS_BADGE_STYLE[entry.classification] || _CLS_BADGE_STYLE.unknown)
    + ' padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-left: 8px;';
  row.appendChild(badge);

  const info = document.createElement('span');
  info.className = 'module-info';
  info.textContent = entry.source || '';
  info.style.cssText = 'margin-left: auto; color: var(--au-text-muted); font-size: 11px;';
  row.appendChild(info);

  return row;
}

export function refreshLicensesList() {
  const list = $('#licenseList');
  if (!list) return;
  list.innerHTML = '';

  const mods = window._installedModules || {};
  const installed = aggregateFromInstalledModules(mods);
  const vendored = aggregateFromBuildLicenses(__BUILD_LICENSES__);
  const table = [...vendored, ...installed];
  if (table.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'module-empty';
    empty.textContent = 'no installed modules to audit';
    list.appendChild(empty);
    return;
  }

  // Surface copyleft + unknown first \u2014 they're the rows the user wants to see.
  const order = { 'strong-copyleft': 0, 'weak-copyleft': 1, 'unknown': 2, 'permissive': 3 };
  table.sort((a, b) =>
    (order[a.classification] ?? 9) - (order[b.classification] ?? 9)
    || a.pkg.localeCompare(b.pkg));

  // Summary line.
  const counts = { permissive: 0, 'weak-copyleft': 0, 'strong-copyleft': 0, unknown: 0 };
  for (const e of table) counts[e.classification] = (counts[e.classification] || 0) + 1;
  const summary = document.createElement('div');
  summary.className = 'module-total';
  const parts = [];
  if (counts.permissive)         parts.push(`${counts.permissive} permissive`);
  if (counts['weak-copyleft'])   parts.push(`${counts['weak-copyleft']} weak-copyleft`);
  if (counts['strong-copyleft']) parts.push(`${counts['strong-copyleft']} strong-copyleft`);
  if (counts.unknown)            parts.push(`${counts.unknown} unknown`);
  summary.textContent = parts.join(' \u00b7 ');
  list.appendChild(summary);

  for (const entry of table) list.appendChild(_renderLicenseRow(entry));
}
