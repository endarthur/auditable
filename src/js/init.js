import { S } from './state.js';
import { loadFromEmbed, saveNotebook, setSaveMode } from './save.js';
import { addCell } from './cell-ops.js';
import { setMsg } from './ui.js';
import { setBadge } from './update.js';

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
  S.initialized = true;
})();

// ── AF BRIDGE ──
// When running inside AF shell (iframe), establish postMessage communication.
// No-op when running standalone (window.parent === window).

(function afBridge() {
  if (window.parent === window) return;
  window.__AF_BRIDGE__ = true;

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
      // recalculate textarea heights after becoming visible
      document.querySelectorAll('textarea').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
        const hl = ta.parentElement?.querySelector('.highlight-layer');
        if (hl) hl.style.height = ta.style.height;
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
