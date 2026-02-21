import { $ } from './state.js';

// ── SETTINGS ──

export function toggleSettings() {
  const overlay = $('#settingsOverlay');
  const panel = $('#settingsPanel');
  const open = !overlay.classList.contains('visible');
  overlay.classList.toggle('visible');
  panel.style.display = open ? 'block' : 'none';
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
  return {
    theme: document.documentElement.classList.contains('light') ? 'light' : 'dark',
    fontSize: parseInt($('#setFontSize').value),
    width: $('#setWidth').value,
    header: $('#setHeader').value,
  };
}

export function applySettings(s) {
  if (!s) return;
  if (s.theme) applyTheme(s.theme);
  if (s.fontSize) applyFontSize(s.fontSize);
  if (s.width) applyWidth(s.width);
  if (s.header) applyHeader(s.header);
}

export function togglePresent() {
  document.body.classList.toggle('presenting');
}
