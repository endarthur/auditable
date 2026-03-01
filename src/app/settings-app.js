import { S, $ } from '../js/state.js';

// ── SETTINGS (app runtime — minimal) ──

const __AUDITABLE_DEFAULT_EXEC_MODE__ = 'reactive';
const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = 'yes';

let _runOnLoad = 'yes';

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }

export function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }
}

export function applyFontSize(size) {
  size = parseInt(size);
  document.documentElement.style.setProperty('--editor-font-size', size + 'px');
}

export function applyWidth(w) {
  const nb = $('#notebook');
  if (nb) nb.style.maxWidth = w;
}

export function applyExecMode(mode) {
  S.autorun = (mode === 'reactive');
}

export function applyRunOnLoad(val) {
  _runOnLoad = val;
}

export function applySettings(s) {
  if (!s) return;
  if (s.theme) applyTheme(s.theme);
  if (s.fontSize) applyFontSize(s.fontSize);
  if (s.width) applyWidth(s.width);
  if (s.execMode) applyExecMode(s.execMode);
  if (s.runOnLoad) applyRunOnLoad(s.runOnLoad);
}

export function resolveExecMode() {
  return lsGet('auditable-exec-mode') || __AUDITABLE_DEFAULT_EXEC_MODE__;
}

export function resolveRunOnLoad() {
  return lsGet('auditable-run-on-load') || _runOnLoad || __AUDITABLE_DEFAULT_RUN_ON_LOAD__;
}

// stubs for symbols referenced elsewhere
export function getSettings() { return {}; }
export function getEditorViewSetting() { return 'no'; }
export function togglePresent() {}
function syncSettings() {}
