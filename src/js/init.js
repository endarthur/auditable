import { S } from './state.js';
import * as hooks from './hooks.js';
import { loadFromEmbed, setSaveMode, buildNotebookHtml } from './save.js';
import { createStandaloneHost, createWorksHost, setHost, getHost } from './host.js';
import { connectSurface, installSurfaceContract } from './surface.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable } from './cell-types.js';
import { setMsg } from './ui.js';
import { setBadge } from './update.js';
import { configureAllAutocomplete, configurePluginAutocomplete } from './complete.js';
import { applySettings, getEditorViewSetting, resolveExecMode, resolveRunOnLoad } from './settings.js';
import { toggleSplitView } from './split.js';
import { cryptoDetect, cryptoUnlock, cryptoUnlockRecovery, cryptoSetLocked, cryptoIsEncrypted, syncCryptoDebounced, cryptoPassphraseStrength, cryptoEnable, cryptoDisable, cryptoChangePassphrase, cryptoRegenerateRecovery, cryptoLock } from './crypto.js';
import { decodeModules, encodeModules, parseNotebookTxt, hydrateVfs } from './serialize.js';
import { hydrateModulesFromVfs, hydrateNotebook, flushPendingDirty, migrateLegacyDump } from './persist.js';
import { installOutputCapture } from './outputs.js';

// Subscribe at module-eval so output capture is wired regardless of
// which boot path (standalone init, worksBoot, _resumeAfterUnlock)
// actually runs. Idempotent: hooks.on is just a listener registration.
installOutputCapture();
import { getSettings } from './settings.js';
import { Dialog } from '#dialog';
import { runAll, autoLoadFromCells } from './exec.js';
import { installIpynbDragDrop } from './ipynb-bridge.js';
import { checkAndWarnCopyleft } from './license-warn.js';

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
      await _resumeAfterUnlock(data);
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
      await _resumeAfterUnlock(data);
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

async function _resumeAfterUnlock(payload) {
  const vfs = window._notebookVFS;

  // Detect new VFS-dump shape vs legacy { data, settings, modules, fs, title }
  // shape. New dumps are flat path \u2192 entry maps; legacy payloads have the
  // four named top-level fields.
  const isLegacy = payload && (payload.data || payload.modules || payload.fs || payload.settings || payload.title);

  if (isLegacy) {
    // Legacy notebooks self-upgrade on next save.
    if (payload.modules) {
      try { window._installedModules = decodeModules(payload.modules); }
      catch (e) { console.error('Failed to restore modules:', e); }
    }
    if (payload.fs) {
      try { window._notebookFS = new Map(Object.entries(decodeModules(payload.fs))); }
      catch (e) { console.error('Failed to restore FS:', e); }
    }
    if (payload.settings) {
      try { applySettings(payload.settings); } catch (e) { console.error('Failed to restore settings:', e); }
    }
    const realTitle = payload.title || payload.settings?.title || 'untitled';
    const titleInput = document.getElementById('docTitle');
    if (titleInput) titleInput.value = realTitle;
    document.title = 'Auditable \u2014 ' + realTitle;

    const nb = document.getElementById('notebook');
    if (nb) nb.innerHTML = '';
    document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

    if (payload.data && Array.isArray(payload.data)) {
      for (const c of payload.data) {
        const cell = addCell(c.type, c.code);
        if (c.collapsed) { cell.el.classList.add('collapsed'); cell.collapsed = true; }
      }
    }
  } else {
    // New format: payload IS the VFS dump.
    if (vfs && payload) await hydrateVfs(vfs, migrateLegacyDump(payload));

    // Hydrate runtime state from VFS
    if (vfs) {
      const modules = await hydrateModulesFromVfs(vfs);
      if (Object.keys(modules).length > 0) window._installedModules = modules;
    }

    // Read /// txt notebook content from /projects/self/notebook.txt
    let parsed = null;
    if (vfs) {
      try {
        const txt = await vfs.readFile('/projects/self/notebook.txt', 'text');
        parsed = parseNotebookTxt(txt);
      } catch { /* fresh notebook */ }
    }

    if (parsed) {
      if (parsed.title) {
        const titleInput = document.getElementById('docTitle');
        if (titleInput) titleInput.value = parsed.title;
        document.title = 'Auditable \u2014 ' + parsed.title;
      }
      if (parsed.settings) applySettings(parsed.settings);

      const nb = document.getElementById('notebook');
      if (nb) nb.innerHTML = '';
      document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

      for (const c of parsed.cells || []) {
        const cell = addCell(c.type, c.code);
        if (c.collapsed) { cell.el.classList.add('collapsed'); cell.collapsed = true; }
      }
    }
  }

  S.initialized = true;

  // Copyleft warning runs after decrypted modules hydrate (encrypted save
  // path — mirrors the standalone-load + works-boot wiring).
  try { checkAndWarnCopyleft(); } catch (e) { console.warn('license-warn:', e); }

  // Configure autocomplete
  configureAllAutocomplete();

  // Update statusbar
  _showCryptoStatus();

  // Hide lock screen
  document.body.classList.remove('locked');
  const lockScreen = document.getElementById('lockScreen');
  if (lockScreen) lockScreen.style.display = 'none';

  // Apply user theme from VFS now that decrypted contents are mounted
  await loadUserTheme();

  // Notify subscribers (MCP) via the hook bus
  if (window.auditable?.hooks) window.auditable.hooks.emit('crypto:unlocked');

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

// (legacy _setupCryptoLiveSync retired in spec E — persistence is now
// write-on-save-only via the Persister, not DOM-mutating sync triggers.)

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

// Shared passphrase form: two password inputs + a live strength meter on
// the first one. Resolves with { passphrase } on accept, null on cancel.
// Used by enableEncryption (mode='enable') and changePassphrase (mode='change').
async function _showPassphraseDialog(mode) {
  const isEnable = mode === 'enable';
  return new Dialog({
    title: isEnable ? 'enable encryption' : 'change passphrase',
    width: 420,
    render(body, ctx) {
      if (isEnable) {
        const desc = document.createElement('div');
        desc.className = 'settings-desc';
        desc.textContent =
          'use 4+ random words for a strong passphrase. a recovery key will ' +
          'be generated as backup.';
        body.appendChild(desc);
      }

      const p1 = document.createElement('input');
      p1.type = 'password';
      p1.className = 'crypto-input';
      p1.placeholder = isEnable ? 'passphrase' : 'new passphrase';
      p1.autocomplete = 'off';
      const strength = document.createElement('div');
      strength.className = 'crypto-strength';
      p1.addEventListener('input', () => {
        const { level, label } = cryptoPassphraseStrength(p1.value);
        strength.textContent = label;
        strength.className = 'crypto-strength crypto-strength-' + level;
      });

      const p2 = document.createElement('input');
      p2.type = 'password';
      p2.className = 'crypto-input';
      p2.placeholder = 'confirm passphrase';
      p2.autocomplete = 'off';

      const error = document.createElement('div');
      error.className = 'crypto-strength crypto-strength-weak';
      error.style.minHeight = '14px';

      const actions = document.createElement('div');
      actions.className = 'export-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'cancel';
      cancelBtn.onclick = () => ctx.close(null);
      const okBtn = document.createElement('button');
      okBtn.className = 'accent';
      okBtn.textContent = isEnable ? 'enable' : 'change';
      okBtn.dataset.default = 'true';
      okBtn.onclick = () => {
        if (!p1.value || !p2.value) { error.textContent = 'enter passphrase'; return; }
        if (p1.value !== p2.value) { error.textContent = 'passphrases do not match'; return; }
        ctx.close({ passphrase: p1.value });
      };
      // Enter in either input submits.
      const submit = (e) => { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } };
      p1.addEventListener('keydown', submit);
      p2.addEventListener('keydown', submit);

      actions.append(cancelBtn, okBtn);
      body.append(p1, strength, p2, error, actions);
      setTimeout(() => p1.focus(), 0);
    },
  }).show();
}

export async function enableEncryption() {
  const result = await _showPassphraseDialog('enable');
  if (!result) return;
  try {
    const recoveryHex = await cryptoEnable(result.passphrase);
    _showRecoveryModal(recoveryHex);
    _showCryptoStatus();
    _updateCryptoSettingsUI();
    setMsg('encryption enabled', 'ok');
  } catch (e) {
    setMsg('encryption failed: ' + e.message, 'err');
  }
}

export async function disableEncryption() {
  const ok = await new Dialog({
    title: 'disable encryption',
    width: 380,
    render(body, ctx) {
      const msg = document.createElement('div');
      msg.className = 'gcu-dialog-message';
      msg.textContent =
        'this will remove encryption from the notebook. the next save will ' +
        'write cleartext data blocks. continue?';

      const actions = document.createElement('div');
      actions.className = 'export-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'cancel';
      cancelBtn.onclick = () => ctx.close(false);
      const okBtn = document.createElement('button');
      okBtn.className = 'accent';
      okBtn.textContent = 'disable';
      okBtn.dataset.default = 'true';
      okBtn.onclick = () => ctx.close(true);
      actions.append(cancelBtn, okBtn);

      body.append(msg, actions);
    },
  }).show();
  if (!ok) return;
  cryptoDisable();
  _updateCryptoSettingsUI();
  const el = document.getElementById('statusCrypto');
  if (el) { el.textContent = ''; el.onclick = null; }
  setMsg('encryption disabled', 'ok');
}

export async function changePassphrase() {
  const result = await _showPassphraseDialog('change');
  if (!result) return;
  try {
    await cryptoChangePassphrase(result.passphrase);
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

function _showRecoveryModal(hex) {
  // closable=false + backdropDismiss=false so the user must explicitly
  // confirm "I have saved my recovery key" before the dialog goes away.
  // Without this guard the secret could be dismissed unsaved.
  new Dialog({
    title: 'recovery key',
    width: 480,
    closable: false,
    backdropDismiss: false,
    render(body, ctx) {
      const desc = document.createElement('p');
      desc.className = 'recovery-desc';
      desc.textContent =
        'save this key somewhere safe. it is the only way to recover your data ' +
        'if you forget your passphrase.';

      const pre = document.createElement('pre');
      pre.className = 'recovery-key';
      pre.textContent = hex;

      const copyRow = document.createElement('div');
      copyRow.className = 'export-actions';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'accent';
      copyBtn.textContent = 'copy';
      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = 'download .txt';
      copyRow.append(copyBtn, downloadBtn);

      const copyNote = document.createElement('div');
      copyNote.className = 'recovery-copy-note';
      copyNote.style.display = 'none';
      copyNote.textContent = 'copied — clear your clipboard when done';

      const savedLabel = document.createElement('label');
      savedLabel.className = 'recovery-saved';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      savedLabel.append(checkbox, document.createTextNode(' I have saved my recovery key'));

      const doneRow = document.createElement('div');
      doneRow.className = 'export-actions';
      const doneBtn = document.createElement('button');
      doneBtn.className = 'accent';
      doneBtn.textContent = 'done';
      doneBtn.disabled = true;
      doneBtn.dataset.default = 'true';
      doneRow.append(doneBtn);

      checkbox.onchange = () => { doneBtn.disabled = !checkbox.checked; };
      copyBtn.onclick = () => {
        navigator.clipboard?.writeText(hex);
        copyNote.style.display = '';
      };
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
      doneBtn.onclick = () => ctx.close(true);

      body.append(desc, pre, copyRow, copyNote, savedLabel, doneRow);
    },
  }).show();
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

// ── USER THEME (VFS) ──
// Per spec_inbox/auditable-theme-spec.md §6.2: a CSS file at
// /projects/self/theme.css is auto-injected after the built-in theme so
// it can override --au-* tokens (or even --sw-* swatches for a full
// re-skin). Reapplies on fs:changed; removes the style element if the
// file is deleted.

const USER_THEME_PATH = '/projects/self/theme.css';

async function loadUserTheme() {
  const vfs = window._notebookVFS;
  if (!vfs) return;
  let css = '';
  try {
    if (await vfs.exists(USER_THEME_PATH)) {
      css = await vfs.readFile(USER_THEME_PATH, 'text');
    }
  } catch (e) { /* file missing or unreadable — drop styles */ }
  let styleEl = document.getElementById('user-theme');
  if (!css) {
    if (styleEl) styleEl.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'user-theme';
    // Inject after auditable-editor-css so the user theme overrides
    // both the app and editor stylesheets.
    const editorCss = document.getElementById('auditable-editor-css');
    if (editorCss && editorCss.nextSibling) {
      editorCss.parentNode.insertBefore(styleEl, editorCss.nextSibling);
    } else {
      document.head.appendChild(styleEl);
    }
  }
  styleEl.textContent = css;
}

// Debounced re-apply on fs:changed (any VFS write may have touched
// /projects/self/theme.css — we just re-check rather than tracking paths).
// Subscribe via the direct hooks-module import rather than
// window.auditable.hooks — globals.js wires the latter at *its* own
// module-eval time, and depending on import order it's not always
// ready when init.js runs. The direct import is the canonical channel.
let _userThemeReloadTimer = null;
function scheduleUserThemeReload() {
  if (_userThemeReloadTimer) return;
  _userThemeReloadTimer = setTimeout(() => {
    _userThemeReloadTimer = null;
    loadUserTheme().catch(() => {});
  }, 150);
}
hooks.on('fs:changed', scheduleUserThemeReload);

// ── INIT (standalone) ──
// The standalone boot: detect packed/encrypted, load the notebook from its
// embedded AUDITABLE-VFS block, apply the user theme, run.
async function init() {
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

  if (!await loadFromEmbed()) {
    addCell('md', '');
    addCell('code', '');
  }
  // Pre-load language packs + adapter bridges referenced by the cells
  // we just hydrated. Without this, /// adder (and friends) render in
  // fallback mode until the user hits Run All — the auto-load is
  // wired to runDAG, which doesn't fire on a passive open. Calling it
  // here triggers registerExtension → _ctActivatePendingCells → cells
  // upgrade to their proper editor before first paint.
  try { await autoLoadFromCells(); }
  catch (e) { console.warn('[init] autoLoadFromCells:', e.message); }
  // Warn about copyleft components bundled inside this saved notebook.
  // Quiet for permissive-only notebooks; banner + console line otherwise.
  try { checkAndWarnCopyleft(); } catch (e) { console.warn('license-warn:', e); }
  // Apply user theme from /projects/self/theme.css (if any) — runs after the
  // VFS is hydrated so saved notebooks pick up their bundled theme on load.
  await loadUserTheme();
  // configure CM6 autocomplete for all code cells
  configureAllAutocomplete();
  // wire global drag-drop for .ipynb files (importIpynbText handles confirm)
  installIpynbDragDrop();
  S.initialized = true;

  // enter editor view if notebook setting requests it
  if (getEditorViewSetting() === 'yes') {
    setTimeout(toggleSplitView, 60);
  }
}

// ── WORKS SURFACE BOOT ──
// Runs when the notebook is hosted as an Auditable Works surface. The Works
// Host builds a VFS whose own project is a local working copy of the
// workspace project and the rest is an A-Bus proxy; the notebook then loads
// from that VFS the same way it would from a self-contained one.
async function worksBoot(conn) {
  const { bus, tab, home } = conn;

  // The inline head script speculatively added .in-works to
  // documentElement when iframed; we make it persistent here (CSS uses
  // :root:not(.in-works) for mobile-mode + standalone-only chrome).
  document.documentElement.classList.add('in-works');

  // Stash the bus so cross-frame calls from notebook → shell can find it.
  // Cell-side install("...gcupkg") needs to ask the shell to evaluate the
  // newly-installed /lib/<pkg>/works.js (EXTENSION_SPEC §3.8.7 — see
  // cell-builtins/modules.js _installFromGcupkg).
  window._worksBus = bus;

  // Theme propagation — the workspace owns the theme choice (Workspace
  // Settings → Theme). Subscribe to Shell.SettingsChanged so a flip on the
  // shell side reaches the embedded notebook too. The notebook's own
  // Settings → Theme stays functional for standalone use; in works the
  // workspace setting overrides on every load.
  const _applyTheme = (theme) => {
    const root = document.documentElement;
    if (!theme || theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  };
  try {
    const settings = await bus.call(
      { to: 'works', path: '/', interface: 'Settings', member: 'Get' }, []);
    _applyTheme(settings && settings.appearance && settings.appearance.theme);
  } catch { /* workspace settings unavailable — keep current */ }
  try {
    bus.subscribe(
      { interface: 'Shell', member: 'SettingsChanged', from: 'works' },
      (msg) => {
        const next = msg && msg.args && msg.args[0];
        _applyTheme(next && next.appearance && next.appearance.theme);
      });
  } catch { /* */ }

  // Write current cells/settings/modules into the VFS so the Host can flush
  // them through to the shared workspace.
  const syncToVfs = () => flushPendingDirty(
    window._notebookVFS, S, getSettings(),
    document.getElementById('docTitle')?.value || 'untitled');

  const host = createWorksHost({ bus, projectPath: tab.path, syncToVfs, home });
  setHost(host);

  // Auto-save: in Works, /projects/self is a local working copy and
  // writeBack to the actual workspace project only fires on persist().
  // Without an auto-save, running cells produces outputs that exist
  // only in the iframe's memory until the user hits Ctrl+S. Subscribe
  // to notebook:dirty (cell edits, settings changes, notebook.fs writes)
  // AND dag:cell:after-exec (cell completions update output sidecars)
  // and debounce-call host.persist(). 1.5s collapses bursts; longer
  // than the 400ms output-save debounce so the output file is on disk
  // before we writeBack the project tree.
  let _autoSaveTimer = null;
  const scheduleAutoSave = () => {
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(async () => {
      _autoSaveTimer = null;
      try { await host.persist(); }
      catch (e) { console.warn('[autosave]', e.message); }
    }, 1500);
  };
  hooks.on('notebook:dirty', scheduleAutoSave);
  hooks.on('dag:cell:after-exec', scheduleAutoSave);

  // Build the surface VFS and boot-load the project from the workspace.
  const vfs = await host.provideVFS();

  // Hydrate installed modules, then cells + settings — straight from the
  // VFS, no embedded block.
  const modules = await hydrateModulesFromVfs(vfs);
  if (Object.keys(modules).length > 0) window._installedModules = modules;
  await hydrateNotebook(vfs);

  // Pre-load language packs + adapter bridges referenced by the cells
  // we just hydrated, so /// adder (and friends) render in their proper
  // editor before first paint instead of fallback mode. The auto-load
  // is normally wired to runDAG which doesn't fire on a passive open.
  try { await autoLoadFromCells(); }
  catch (e) { console.warn('[init] autoLoadFromCells (works):', e.message); }

  // Live re-hydrate of _installedModules when /lib changes underneath us.
  // The drag-drop and `pkg install` paths update the workspace VFS but
  // don't reach into this iframe's in-memory map. Subscribing to the
  // shell's VFS.Changed signal lets the notebook pick up newly-installed
  // extensions without a full reload.
  try {
    let _refreshScheduled = false;
    bus.subscribe(
      { interface: 'VFS', member: 'Changed', from: 'works' },
      (msg) => {
        const ev = msg && msg.args && msg.args[0];
        const p = ev && (typeof ev === 'string' ? ev : ev.path);
        if (typeof p !== 'string' || !p.startsWith('/lib')) return;
        // Coalesce — a single install can fire several Changed events.
        // One refresh per microtask is plenty.
        if (_refreshScheduled) return;
        _refreshScheduled = true;
        queueMicrotask(async () => {
          _refreshScheduled = false;
          try {
            const fresh = await hydrateModulesFromVfs(vfs);
            // Merge — preserve any session-only entries (URL installs etc)
            // that aren't on disk. /lib-backed entries always win since
            // they're authoritative.
            for (const [k, v] of Object.entries(fresh)) {
              window._installedModules[k] = v;
            }
            console.info(`[notebook] _installedModules refreshed from /lib (${Object.keys(fresh).length} entries)`);
          } catch (e) {
            console.warn('[notebook] /lib refresh failed:', e.message);
          }
        });
      });
  } catch { /* bus or VFS service unavailable — fine */ }

  try { checkAndWarnCopyleft(); } catch (e) { console.warn('license-warn:', e); }

  await loadUserTheme();
  configureAllAutocomplete();
  installIpynbDragDrop();
  S.initialized = true;

  // The §5.2 Surface contract — methods, signals, self-flush, Ready.
  installSurfaceContract({ bus, host });

  if (getEditorViewSetting() === 'yes') {
    setTimeout(toggleSplitView, 60);
  }

  // Run cells if configured.
  if (resolveRunOnLoad() === 'yes' && getEditorViewSetting() !== 'yes'
      && S.cells.some(c => _ctIsExecutable(c.type))) {
    setTimeout(runAll, 50);
  }
}

// ── BOOT ──
// Standalone vs. Auditable Works surface. Standalone (the common case):
// build the VFS synchronously, run init() on the next macrotask. Iframed:
// listen for the shell's abus:welcome synchronously — so it can't race ahead
// of the listener — then on the next macrotask run the Works boot, or fall
// back to standalone if no welcome arrives.
if (window.parent === window) {
  setHost(createStandaloneHost({ buildHtml: buildNotebookHtml }));
  getHost().provideVFS();
  setTimeout(init, 0);
} else {
  // Speculative .in-works on documentElement was added by the head's
  // inline data-abus-catch script (so first paint already reflects
  // Works chrome and skips mobile @media). If the welcome never
  // arrives, strip it before booting standalone.
  const welcomeP = connectSurface(3000);
  setTimeout(async () => {
    const conn = await welcomeP;
    if (conn) {
      await worksBoot(conn);
    } else {
      document.documentElement.classList.remove('in-works');
      setHost(createStandaloneHost({ buildHtml: buildNotebookHtml }));
      getHost().provideVFS();
      await init();
    }
  }, 0);
}
