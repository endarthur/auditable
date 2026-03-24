import { S } from './state.js';
import { loadFromEmbed, saveNotebook, setSaveMode, initLiveSync, syncData, syncSettings, syncModules } from './save.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable } from './cell-types.js';
import { setMsg } from './ui.js';
import { setBadge } from './update.js';
import { registerProvider } from './stdlib.js';
import { configureAllAutocomplete } from './complete.js';
import { applySettings, getEditorViewSetting, resolveExecMode, resolveRunOnLoad } from './settings.js';
import { toggleSplitView } from './split.js';
import { cryptoDetect, cryptoUnlock, cryptoUnlockRecovery, cryptoSetLocked, cryptoIsEncrypted, initCryptoSync, syncCryptoDebounced, removeCleartextNodes, cryptoPassphraseStrength, cryptoEnable, cryptoDisable, cryptoChangePassphrase, cryptoRegenerateRecovery, cryptoLock } from './crypto.js';
import { decodeModules, encodeModules } from './save.js';
import { getSettings } from './settings.js';
import { runAll } from './exec.js';

// ── LOCK SCREEN ──

function _showLockScreen(block) {
  const lockScreen = document.getElementById('lockScreen');
  if (!lockScreen) return;

  document.body.classList.add('locked');
  lockScreen.style.display = '';

  const passphraseInput = document.getElementById('lockPassphrase');
  const unlockBtn = document.getElementById('lockUnlockBtn');
  const errorEl = document.getElementById('lockError');
  const spinnerEl = document.getElementById('lockSpinner');
  const recoveryToggle = document.getElementById('lockRecoveryToggle');
  const recoverySection = document.getElementById('lockRecoverySection');
  const recoveryInput = document.getElementById('lockRecoveryInput');
  const recoveryBtn = document.getElementById('lockRecoveryBtn');

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = '';
    spinnerEl.style.display = 'none';
    unlockBtn.disabled = false;
    if (recoveryBtn) recoveryBtn.disabled = false;
  }

  async function doUnlock(passphrase) {
    errorEl.style.display = 'none';
    spinnerEl.style.display = '';
    unlockBtn.disabled = true;
    try {
      const data = await cryptoUnlock(passphrase, block);
      _resumeAfterUnlock(data);
    } catch (e) {
      showError(e.message === 'Wrong passphrase' ? 'wrong passphrase' : 'decryption failed');
    }
  }

  async function doUnlockRecovery(hex) {
    errorEl.style.display = 'none';
    spinnerEl.style.display = '';
    if (recoveryBtn) recoveryBtn.disabled = true;
    try {
      const data = await cryptoUnlockRecovery(hex, block);
      _resumeAfterUnlock(data);
    } catch (e) {
      showError(e.message === 'Invalid recovery key' ? 'invalid recovery key' : 'decryption failed');
    }
  }

  unlockBtn.onclick = () => {
    const p = passphraseInput.value;
    if (!p) return;
    doUnlock(p);
  };

  passphraseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const p = passphraseInput.value;
      if (p) doUnlock(p);
    }
  });

  if (recoveryToggle) {
    recoveryToggle.onclick = (e) => {
      e.preventDefault();
      recoverySection.style.display = recoverySection.style.display === 'none' ? '' : 'none';
    };
  }

  if (recoveryBtn) {
    recoveryBtn.onclick = () => {
      const hex = recoveryInput.value.trim();
      if (hex) doUnlockRecovery(hex);
    };
  }

  // Focus passphrase input
  setTimeout(() => passphraseInput.focus(), 100);
}

function _resumeAfterUnlock(payload) {
  // Restore modules
  if (payload.modules) {
    try {
      window._installedModules = decodeModules(payload.modules);
    } catch (e) { console.error('Failed to restore modules:', e); }
  }

  // Restore filesystem
  if (payload.fs) {
    try {
      window._notebookFS = new Map(Object.entries(decodeModules(payload.fs)));
    } catch (e) { console.error('Failed to restore FS:', e); }
  }

  // Restore settings
  if (payload.settings) {
    try { applySettings(payload.settings); } catch (e) { console.error('Failed to restore settings:', e); }
  }

  // Restore title
  const realTitle = payload.title || payload.settings?.title || 'untitled';
  const titleInput = document.getElementById('docTitle');
  if (titleInput) titleInput.value = realTitle;
  document.title = 'Auditable \u2014 ' + realTitle;

  // Clean dirty DOM
  const nb = document.getElementById('notebook');
  if (nb) nb.innerHTML = '';
  document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

  // Load cells
  if (payload.data && Array.isArray(payload.data)) {
    for (const c of payload.data) {
      const cell = addCell(c.type, c.code);
      if (c.collapsed) { cell.el.classList.add('collapsed'); cell.collapsed = true; }
    }
  }

  S.initialized = true;

  // Configure autocomplete
  configureAllAutocomplete();

  // Initialize crypto live sync (replaces cleartext sync)
  removeCleartextNodes();
  initCryptoSync();

  // Schedule crypto sync on edits
  _setupCryptoLiveSync();

  // Update statusbar
  _showCryptoStatus();

  // Hide lock screen
  document.body.classList.remove('locked');
  const lockScreen = document.getElementById('lockScreen');
  if (lockScreen) lockScreen.style.display = 'none';

  // Notify MCP
  if (window._mcpOnUnlock) window._mcpOnUnlock();

  // Run all if configured
  const effectiveRun = resolveRunOnLoad();
  if (effectiveRun === 'yes' && getEditorViewSetting() !== 'yes' && S.cells.some(c => _ctIsExecutable(c.type))) {
    setTimeout(runAll, 50);
  }

  // Enter editor view if configured
  if (getEditorViewSetting() === 'yes') {
    setTimeout(toggleSplitView, 60);
  }
}

function _setupCryptoLiveSync() {
  // Override the normal sync to use crypto sync instead
  // This hooks into the existing edit/settings change flow
  window._cryptoSyncTrigger = () => {
    if (!cryptoIsEncrypted()) return;
    const cellData = S.cells.map(c => ({
      type: c.type,
      code: c.code,
      collapsed: c.collapsed || undefined,
    }));
    const payload = {
      data: cellData,
      settings: getSettings(),
      modules: Object.keys(window._installedModules || {}).length ? encodeModules(window._installedModules) : null,
      fs: window._notebookFS?.size ? encodeModules(Object.fromEntries(window._notebookFS)) : null,
      title: document.getElementById('docTitle')?.value || 'untitled',
    };
    syncCryptoDebounced(payload);
  };
}

function _showCryptoStatus() {
  const el = document.getElementById('statusCrypto');
  if (el) {
    el.textContent = '\ud83d\udd13';
    el.title = 'encrypted notebook (unlocked)';
    el.style.cursor = 'pointer';
    el.onclick = () => window.toggleSettings?.();
  }
}

function _showCryptoError() {
  const lockScreen = document.getElementById('lockScreen');
  if (!lockScreen) return;
  document.body.classList.add('locked');
  lockScreen.style.display = '';
  const subtitle = lockScreen.querySelector('.lock-subtitle');
  if (subtitle) subtitle.textContent = 'your browser does not support Web Crypto API';
  const form = lockScreen.querySelector('.lock-form');
  if (form) form.style.display = 'none';
}

// ── Encryption settings UI handlers ──

export async function enableEncryption() {
  const p1 = document.getElementById('cryptoPassphrase')?.value;
  const p2 = document.getElementById('cryptoPassphraseConfirm')?.value;
  if (!p1 || !p2) { setMsg('enter passphrase', 'err'); return; }
  if (p1 !== p2) { setMsg('passphrases do not match', 'err'); return; }

  try {
    const recoveryHex = await cryptoEnable(p1);
    // Show recovery key modal
    _showRecoveryModal(recoveryHex);
    // Setup crypto sync
    removeCleartextNodes();
    initCryptoSync();
    _setupCryptoLiveSync();
    _showCryptoStatus();
    _updateCryptoSettingsUI();
    setMsg('encryption enabled', 'ok');
  } catch (e) {
    setMsg('encryption failed: ' + e.message, 'err');
  }
}

export function disableEncryption() {
  cryptoDisable();
  _updateCryptoSettingsUI();
  // Re-enable cleartext sync
  initLiveSync();
  syncData();
  syncSettings();
  if (window._installedModules && Object.keys(window._installedModules).length) syncModules();
  const el = document.getElementById('statusCrypto');
  if (el) { el.textContent = ''; el.onclick = null; }
  setMsg('encryption disabled', 'ok');
}

export async function changePassphrase() {
  const p1 = document.getElementById('cryptoNewPassphrase')?.value;
  const p2 = document.getElementById('cryptoNewPassphraseConfirm')?.value;
  if (!p1 || !p2) { setMsg('enter new passphrase', 'err'); return; }
  if (p1 !== p2) { setMsg('passphrases do not match', 'err'); return; }
  try {
    await cryptoChangePassphrase(p1);
    document.getElementById('cryptoNewPassphrase').value = '';
    document.getElementById('cryptoNewPassphraseConfirm').value = '';
    setMsg('passphrase changed', 'ok');
  } catch (e) {
    setMsg('failed: ' + e.message, 'err');
  }
}

export async function regenerateRecovery() {
  try {
    const hex = await cryptoRegenerateRecovery();
    _showRecoveryModal(hex);
    setMsg('recovery key regenerated', 'ok');
  } catch (e) {
    setMsg('failed: ' + e.message, 'err');
  }
}

export function lockNotebook() {
  cryptoLock();
  // Reload the page to show lock screen
  location.reload();
}

export function updateStrengthFeedback() {
  const el = document.getElementById('cryptoStrength');
  const input = document.getElementById('cryptoPassphrase');
  if (!el || !input) return;
  const { level, label } = cryptoPassphraseStrength(input.value);
  el.textContent = label;
  el.className = 'crypto-strength crypto-strength-' + level;
}

function _showRecoveryModal(hex) {
  const overlay = document.getElementById('recoveryOverlay');
  if (!overlay) return;
  overlay.style.display = '';
  const pre = document.getElementById('recoveryKey');
  if (pre) pre.textContent = hex;

  const copyBtn = document.getElementById('recoveryCopyBtn');
  const copyNote = document.getElementById('recoveryCopyNote');
  const checkbox = document.getElementById('recoverySavedCheck');
  const doneBtn = document.getElementById('recoveryDoneBtn');
  const downloadBtn = document.getElementById('recoveryDownloadBtn');

  if (doneBtn) doneBtn.disabled = true;
  if (checkbox) {
    checkbox.checked = false;
    checkbox.onchange = () => { if (doneBtn) doneBtn.disabled = !checkbox.checked; };
  }
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(hex);
      if (copyNote) copyNote.style.display = '';
    };
  }
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      const title = document.getElementById('docTitle')?.value || 'untitled';
      const blob = new Blob([hex], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '-recovery-key.txt';
      a.click();
      URL.revokeObjectURL(url);
    };
  }
  if (doneBtn) {
    doneBtn.onclick = () => { overlay.style.display = 'none'; };
  }
}

export function _updateCryptoSettingsUI() {
  const statusEl = document.getElementById('cryptoStatus');
  const enableSection = document.getElementById('cryptoEnableSection');
  const manageSection = document.getElementById('cryptoManageSection');

  if (cryptoIsEncrypted()) {
    if (statusEl) statusEl.textContent = 'encrypted \u2014 unlocked';
    if (enableSection) enableSection.style.display = 'none';
    if (manageSection) manageSection.style.display = '';
  } else {
    if (statusEl) statusEl.textContent = 'not encrypted';
    if (enableSection) enableSection.style.display = '';
    if (manageSection) manageSection.style.display = 'none';
  }
}

// ── INIT ──

(function init() {
  // detect packed format (meta tag injected by loader)
  const packedMeta = document.querySelector('meta[name="auditable-packed"]');
  if (packedMeta) {
    packedMeta.remove();
    setBadge('packed', 'packed', 'toolbar-badge toolbar-badge-packed');
    setSaveMode('packed');
  }

  // detect encrypted notebook
  const cryptoBlock = cryptoDetect(document.body.innerHTML);
  if (cryptoBlock.found) {
    if (!crypto?.subtle) {
      _showCryptoError();
      return;
    }
    cryptoSetLocked(true);
    _showLockScreen(cryptoBlock.block);
    return; // init stops, resumed after unlock
  }

  if (!loadFromEmbed()) {
    addCell('md', '');
    addCell('code', '');
  }
  // configure CM6 autocomplete for all code cells
  configureAllAutocomplete();
  S.initialized = true;

  // initialize live comment sync (keeps DOM comments up-to-date for native Ctrl+S)
  initLiveSync();
  syncData();
  syncSettings();
  if (window._installedModules && Object.keys(window._installedModules).length) syncModules();

  // enter editor view if notebook setting requests it
  if (getEditorViewSetting() === 'yes') {
    setTimeout(toggleSplitView, 60);
  }
})();

// ── AF BRIDGE ──
// When running inside AF shell (iframe), establish postMessage communication.
// No-op when running standalone (window.parent === window).
//
// Message protocol (notebook <-> AF shell):
//   af:ready          -> sent on init with { title }
//   af:serialize      <- received to trigger saveNotebook()
//   af:saved          <- received after save (shows "saved" status)
//   af:setTitle       <- received to update docTitle input
//   af:resize         <- received when iframe becomes visible (recalc textareas)
//   af:titleChanged   -> sent when user edits the title
//   af:fileRequest    -> sent to request file picker { id, accept }
//   af:fileResult     <- received with picked file { id, file }
//   af:download       -> sent to request download { data, filename, mimeType }
//   af:dirty          -> sent when notebook has unsaved changes

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
