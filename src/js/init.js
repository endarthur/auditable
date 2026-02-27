import { S } from './state.js';
import { loadFromEmbed, saveNotebook, setSaveMode } from './save.js';
import { addCell } from './cell-ops.js';
import { setMsg } from './ui.js';
import { setBadge } from './update.js';
import { registerProvider } from './stdlib.js';
import { configureAllAutocomplete } from './complete.js';
import { getEditorViewSetting } from './settings.js';
import { toggleSplitView } from './split.js';

// ── INIT ──

(function init() {
  // detect packed format (meta tag injected by loader)
  const packedMeta = document.querySelector('meta[name="auditable-packed"]');
  if (packedMeta) {
    packedMeta.remove();
    setBadge('packed', 'packed', 'toolbar-badge toolbar-badge-packed');
    setSaveMode('packed');
  }

  if (!loadFromEmbed()) {
    addCell('md', '');
    addCell('code', '');
  }
  // configure CM6 autocomplete for all code cells
  configureAllAutocomplete();
  S.initialized = true;

  // enter editor view if notebook setting requests it
  if (getEditorViewSetting() === 'yes') {
    setTimeout(toggleSplitView, 60);
  }
})();

// ── AF BRIDGE ──
// When running inside AF shell (iframe), establish postMessage communication.
// No-op when running standalone (window.parent === window).
//
// Message protocol (notebook ↔ AF shell):
//   af:ready          → sent on init with { title }
//   af:serialize      ← received to trigger saveNotebook()
//   af:saved          ← received after save (shows "saved" status)
//   af:setTitle       ← received to update docTitle input
//   af:resize         ← received when iframe becomes visible (recalc textareas)
//   af:titleChanged   → sent when user edits the title
//   af:fileRequest    → sent to request file picker { id, accept }
//   af:fileResult     ← received with picked file { id, file }
//   af:download       → sent to request download { data, filename, mimeType }
//   af:dirty          → sent when notebook has unsaved changes

(function afBridge() {
  if (window.parent === window) return;
  window.__AF_BRIDGE__ = true;

  // register AF-specific providers for file/download
  registerProvider('file', (accept) => {
    return new Promise((resolve) => {
      const id = 'af_file_' + Date.now();
      function handler(e) {
        if (e.data?.type === 'af:fileResult' && e.data.payload?.id === id) {
          window.removeEventListener('message', handler);
          resolve(e.data.payload.file);
        }
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({ type: 'af:fileRequest', payload: { id, accept } }, '*');
    });
  });

  registerProvider('download', (data, filename, mimeType) => {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const mime = mimeType || (typeof data === 'string' ? 'text/plain' : 'application/json');
    window.parent.postMessage({
      type: 'af:download',
      payload: { data: str, filename, mimeType: mime }
    }, '*');
  });

  const title = document.getElementById('docTitle')?.value || 'untitled';
  window.parent.postMessage({ type: 'af:ready', payload: { title } }, '*');

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg?.type) return;
    if (msg.type === 'af:serialize') saveNotebook();
    else if (msg.type === 'af:saved') setMsg('saved', 'ok');
    else if (msg.type === 'af:setTitle') {
      const input = document.getElementById('docTitle');
      if (input && msg.payload?.title) input.value = msg.payload.title;
    } else if (msg.type === 'af:resize') {
      // recalculate editor sizes after becoming visible
      document.querySelectorAll('.cm-editor').forEach(el => {
        const view = el.cmView?.view;
        if (view) view.requestMeasure();
      });
      // md textareas
      document.querySelectorAll('.cell-md-edit textarea').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
    }
  });

  document.getElementById('docTitle')?.addEventListener('input', () => {
    window.parent.postMessage({
      type: 'af:titleChanged',
      payload: { title: document.getElementById('docTitle').value }
    }, '*');
  });
})();
