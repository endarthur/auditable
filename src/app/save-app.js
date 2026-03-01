import { S, $ } from '../js/state.js';
import { addCell } from './cell-ops-app.js';
import { isCollapsed } from '../js/dag.js';
import { applySettings, resolveExecMode, resolveRunOnLoad } from './settings-app.js';
import { runAll } from '../js/exec.js';

// ── MODULES ENCODING ──

function encodeModules(obj) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

function decodeModules(raw) {
  const b64 = raw.replace(/\s/g, '');
  if (b64.startsWith('{') || b64.startsWith('%7B')) return JSON.parse(raw);
  return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

// ── STUBS ──

function syncModules() {}
function syncData() {}
function syncDataDebounced() {}
function syncSettings() {}
function initLiveSync() {}

// ── LOAD ──

export function loadFromEmbed() {
  const raw = document.body.innerHTML;

  // restore installed modules first (before cells run)
  const modMatch = raw.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  if (modMatch) {
    try {
      window._installedModules = decodeModules(modMatch[1]);
    } catch (e) {
      console.error('Failed to parse installed modules:', e);
    }
  }

  // restore settings
  const setMatch = raw.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  if (setMatch) {
    try {
      applySettings(JSON.parse(setMatch[1]));
    } catch (e) {
      console.error('Failed to parse settings:', e);
    }
  }

  // apply execution mode
  const effectiveMode = resolveExecMode();
  const effectiveRun = resolveRunOnLoad();
  if (effectiveMode === 'manual') {
    S.autorun = false;
  }

  const match = raw.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);

      const nb = document.getElementById('notebook');
      if (nb) nb.innerHTML = '';
      document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

      for (const c of data) {
        const cell = addCell(c.type, c.code);
        if (c.collapsed || isCollapsed(c.code)) cell.el.classList.add('collapsed');
      }
      // run after load
      if (effectiveRun === 'yes' && S.cells.some(c => c.type === 'code')) {
        setTimeout(runAll, 50);
      }
      return true;
    } catch (e) {
      console.error('Failed to parse embedded data:', e);
    }
  }
  return false;
}
