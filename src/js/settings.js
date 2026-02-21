import { $ } from './state.js';
import { updateStatus } from './ui.js';

// ── SETTINGS ──

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

export function getSettings() {
  const s = {
    theme: document.documentElement.classList.contains('light') ? 'light' : 'dark',
    fontSize: parseInt($('#setFontSize').value),
    width: $('#setWidth').value,
    header: $('#setHeader').value,
    lineNumbers: document.documentElement.classList.contains('hide-line-numbers') ? 'off' : 'on',
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
  if (s.sizeCompare !== undefined && typeof applySizeCompare === 'function') applySizeCompare(s.sizeCompare);
  if (s.sizeCompareRef !== undefined && typeof applySizeCompareRef === 'function') applySizeCompareRef(s.sizeCompareRef);
}

export function togglePresent() {
  document.body.classList.toggle('presenting');
}

// ── MODULE MANAGEMENT ──

function formatSize(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

export function refreshModuleList() {
  const list = $('#moduleList');
  if (!list) return;
  list.innerHTML = '';

  const mods = window._installedModules || {};
  const urls = Object.keys(mods);

  if (urls.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'module-empty';
    empty.textContent = 'no modules installed';
    list.appendChild(empty);
    return;
  }

  let totalSize = 0;
  for (const url of urls) {
    const entry = mods[url];
    const src = typeof entry === 'string' ? entry : entry.source;
    const cellId = typeof entry === 'string' ? null : entry.cellId;
    const size = src ? src.length : 0;
    totalSize += size;

    const row = document.createElement('div');
    row.className = 'module-row';

    const urlSpan = document.createElement('span');
    urlSpan.className = 'module-url';
    urlSpan.textContent = url;
    urlSpan.title = url;
    row.appendChild(urlSpan);

    const info = document.createElement('span');
    info.className = 'module-info';
    info.textContent = (cellId != null ? 'cell ' + cellId + '  ' : '') + formatSize(size);
    row.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'module-remove';
    btn.textContent = '\u00d7';
    btn.title = 'remove module';
    btn.onclick = () => removeModule(url);
    row.appendChild(btn);

    list.appendChild(row);
  }

  const total = document.createElement('div');
  total.className = 'module-total';
  total.textContent = 'total  ' + formatSize(totalSize);
  list.appendChild(total);
}

export function removeModule(url) {
  if (window._installedModules) delete window._installedModules[url];
  if (window._importCache) delete window._importCache[url];
  refreshModuleList();
  updateStatus();
}
