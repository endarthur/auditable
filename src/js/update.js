import { S, $ } from './state.js';
import { setMsg } from './ui.js';
import { getSettings, __AUDITABLE_VERSION__, __AUDITABLE_RELEASE__ } from './settings.js';
import { renderMd } from './markdown.js';
import { encodeModules } from './save.js';
import { Dialog } from '#dialog';

// ── SELF-UPDATE SYSTEM ──

const __AUDITABLE_PUBLIC_KEY__ = '';
const __AUDITABLE_REPO__ = 'endarthur/auditable';
const __AUDITABLE_PAGES_URL__ = 'https://endarthur.github.io/auditable';

// Cached result of the load-time signature self-verification (sets the
// toolbar badge as a side effect; surfaced inside the update dialog when
// it opens). Form: { text, cls } — text shows in the dialog, cls maps to
// .update-{ok,warn,err} classes.
let _verifySelfResult = null;

// ── SIGNATURE EXTRACTION ──

function extractSignature(html) {
  const m = html.match(/<!--AUDITABLE-SIGNATURE\n([\s\S]*?)\nAUDITABLE-SIGNATURE-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ── RUNTIME EXTRACTION ──

function extractRuntime(html) {
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!style || !script) return null;
  return { style: style[1], script: script[1] };
}

// ── DATA EXTRACTION ──

function extractData(html) {
  const data = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  const settings = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  const modules = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  const title = html.match(/<title>([^<]*)<\/title>/);
  return {
    data: data ? data[0] : null,
    settings: settings ? settings[0] : null,
    modules: modules ? modules[0] : null,
    title: title ? title[1].replace(/^Auditable\s*—\s*/, '') : 'untitled',
  };
}

// ── SIGNED CONTENT CONSTRUCTION ──

function buildSignedContent(style, script) {
  return 'AUDITABLE-SIGNED-CONTENT\n'
    + style + '\n'
    + 'AUDITABLE-STYLE-SCRIPT-BOUNDARY\n'
    + script;
}

// ── SIGNATURE VERIFICATION (Web Crypto) ──

async function verifySignature(html) {
  const sig = extractSignature(html);
  if (!sig) return { status: 'unsigned' };

  const pubKeyB64 = __AUDITABLE_PUBLIC_KEY__;
  if (!pubKeyB64) return { status: 'no-key', sig };

  // Check if the signature's public key matches ours
  if (sig.pub !== pubKeyB64) return { status: 'wrong-key', sig };

  const runtime = extractRuntime(html);
  if (!runtime) return { status: 'error', message: 'could not extract runtime' };

  const content = buildSignedContent(runtime.style, runtime.script);

  try {
    const pubBytes = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw', pubBytes, { name: 'Ed25519' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig.sig), c => c.charCodeAt(0));
    const msgBytes = new TextEncoder().encode(content);
    const valid = await crypto.subtle.verify('Ed25519', key, sigBytes, msgBytes);
    return { status: valid ? 'valid' : 'invalid', sig };
  } catch (e) {
    if (e.name === 'NotSupportedError') {
      return { status: 'unsupported', message: 'browser does not support Ed25519 verification' };
    }
    return { status: 'error', message: e.message };
  }
}

// ── REASSEMBLE ──

function reassemble(newHtml, oldData) {
  let html = newHtml;

  // Remove any existing data/settings/modules comments (and their description comments) from the new template
  html = html.replace(/(?:<!-- [^\n]*-->\n)?<!--AUDITABLE-DATA\n[\s\S]*?\nAUDITABLE-DATA-->\n?/g, '');
  html = html.replace(/(?:<!-- [^\n]*-->\n)?<!--AUDITABLE-SETTINGS\n[\s\S]*?\nAUDITABLE-SETTINGS-->\n?/g, '');
  html = html.replace(/(?:<!-- [^\n]*-->\n)?<!--AUDITABLE-MODULES\n[\s\S]*?\nAUDITABLE-MODULES-->\n?/g, '');

  // Build data block to inject
  const parts = [];
  if (oldData.data) parts.push(oldData.data);
  if (oldData.modules) parts.push(oldData.modules);
  if (oldData.settings) parts.push(oldData.settings);
  const dataBlock = parts.length ? '\n' + parts.join('\n') + '\n' : '';

  // Inject before the signature comment or before <script>
  const sigIdx = html.indexOf('<!--AUDITABLE-SIGNATURE');
  const scriptIdx = html.indexOf('<script>');
  const insertIdx = sigIdx >= 0 ? sigIdx : scriptIdx;
  if (insertIdx >= 0) {
    html = html.slice(0, insertIdx) + dataBlock + html.slice(insertIdx);
  }

  // Update title
  if (oldData.title && oldData.title !== 'untitled') {
    html = html.replace(/<title>[^<]*<\/title>/, '<title>Auditable — ' + escHtml(oldData.title) + '</title>');
    // Also update the docTitle input value
    html = html.replace(/(<input[^>]*id="docTitle"[^>]*value=")[^"]*"/, '$1' + escHtml(oldData.title) + '"');
  }

  return html;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── VERSION COMPARISON ──

function compareVersions(a, b) {
  // compare semver strings like "0.1.0" vs "0.2.0"
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// ── TOOLBAR BADGES ──

export function setBadge(id, label, cls) {
  const container = $('#toolbarBadges');
  if (!container) return;
  let el = container.querySelector('[data-badge="' + id + '"]');
  if (!label) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('span');
    el.className = 'toolbar-badge toolbar-badge-' + id;
    el.setAttribute('data-badge', id);
    container.appendChild(el);
  }
  el.textContent = label;
  if (cls) el.className = 'toolbar-badge ' + cls;
}

// ── REASSEMBLE + DOWNLOAD (shared by online + from-file paths) ──

function finishUpdate(newHtml, version, setStatus) {
  setStatus('reassembling...', '');

  // Extract current document as HTML to get data comments
  const bodyHtml = document.body.innerHTML;
  const fullHtml = '<!DOCTYPE html>\n<html>' + document.head.outerHTML + '<body>' + bodyHtml + '</body></html>';

  const oldData = extractData(fullHtml);
  // Override title from live doc
  const titleInput = $('#docTitle');
  if (titleInput) oldData.title = titleInput.value || 'untitled';

  // Build fresh data comments from live state (more reliable than regex from DOM)
  if (S.cells.length) {
    const cellData = S.cells.map(c => ({
      type: c.type,
      code: c.code,
      collapsed: c.collapsed || undefined
    }));
    oldData.data = '<!-- cell data: JSON array of {type, code, collapsed?} -->\n<!--AUDITABLE-DATA\n' + JSON.stringify(cellData) + '\nAUDITABLE-DATA-->';
  }
  if (window._installedModules && Object.keys(window._installedModules).length) {
    oldData.modules = '<!-- installed modules: base64-encoded JSON mapping URLs to {source, cellId} -->\n<!--AUDITABLE-MODULES\n' + encodeModules(window._installedModules) + '\nAUDITABLE-MODULES-->';
  }
  oldData.settings = '<!-- notebook settings: JSON {theme, fontSize, width, ...} -->\n<!--AUDITABLE-SETTINGS\n' + JSON.stringify(getSettings()) + '\nAUDITABLE-SETTINGS-->';

  const result = reassemble(newHtml, oldData);

  // Offer as download
  const title = (titleInput ? titleInput.value : 'untitled') || 'untitled';
  const blob = new Blob([result], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.html';
  a.click();
  URL.revokeObjectURL(url);

  const vLabel = version ? ' to ' + version : '';
  setStatus('updated' + vLabel + ' — saved as ' + a.download, 'ok');
  setMsg('updated' + vLabel, 'ok');
}

// ── UPDATE DIALOG (single entry point) ──

// Closure state lives in the render: pending update bytes for "proceed
// anyway" warnings, latest setStatus impl. No window.* slots needed.
function openUpdateDialog() {
  return new Dialog({
    title: 'update',
    width: 480,
    render(body, ctx) {
      // ── Header info rows ──
      const sigInfo = _verifySelfResult ?? { text: 'checking...', cls: 'warn' };
      const releaseCls = __AUDITABLE_RELEASE__ === 'dev' ? 'update-warn' : '';
      const pubKeyText = __AUDITABLE_PUBLIC_KEY__
        ? __AUDITABLE_PUBLIC_KEY__.slice(0, 8) + '...'
        : 'not configured';
      const pubKeyCls = __AUDITABLE_PUBLIC_KEY__ ? '' : 'update-warn';

      const info = document.createElement('div');
      info.innerHTML =
        `<div class="settings-row"><label>version</label><span>v${escHtml(__AUDITABLE_VERSION__)}</span></div>` +
        `<div class="settings-row"><label>release</label><span class="${releaseCls}">${escHtml(__AUDITABLE_RELEASE__)}</span></div>` +
        `<div class="settings-row"><label>signature</label><span class="update-sig update-${sigInfo.cls}">${escHtml(sigInfo.text)}</span></div>` +
        `<div class="settings-row"><label>public key</label><span class="update-sig ${pubKeyCls}" data-pubkey>${escHtml(pubKeyText)}</span></div>`;
      body.appendChild(info);

      // Click pubkey to expand/collapse the full base64.
      const pubKeyEl = info.querySelector('[data-pubkey]');
      if (pubKeyEl && __AUDITABLE_PUBLIC_KEY__) {
        pubKeyEl.classList.add('update-key-truncated');
        pubKeyEl.style.cursor = 'pointer';
        pubKeyEl.onclick = () => {
          if (pubKeyEl.classList.toggle('update-key-expanded')) {
            pubKeyEl.classList.remove('update-key-truncated');
            pubKeyEl.textContent = __AUDITABLE_PUBLIC_KEY__;
          } else {
            pubKeyEl.classList.add('update-key-truncated');
            pubKeyEl.textContent = __AUDITABLE_PUBLIC_KEY__.slice(0, 8) + '...';
          }
        };
      }

      // ── Live status area ──
      const statusEl = document.createElement('div');
      statusEl.className = 'update-status';
      body.appendChild(statusEl);

      const setStatus = (html, cls) => {
        statusEl.innerHTML = html;
        statusEl.className = 'update-status' + (cls ? ' update-' + cls : '');
      };

      // ── Action buttons ──
      const actions = document.createElement('div');
      actions.className = 'update-actions';

      const checkBtn = document.createElement('button');
      checkBtn.textContent = 'check for updates';
      checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        setStatus('checking...', '');
        try {
          const vResp = await fetch(__AUDITABLE_PAGES_URL__ + '/version.json');
          if (!vResp.ok) throw new Error('version check failed: ' + vResp.status);
          const vData = await vResp.json();
          const remoteVersion = vData.version || '';

          if (__AUDITABLE_RELEASE__ === 'dev') {
            // Dev builds always offer the latest release.
          } else if (compareVersions(__AUDITABLE_RELEASE__, remoteVersion) >= 0) {
            setStatus('up to date (' + escHtml(__AUDITABLE_RELEASE__) + ')', 'ok');
            checkBtn.disabled = false;
            return;
          }

          const notes = vData.notes || '';
          const notesHtml = notes
            ? '<div class="update-notes">' + renderMd(notes) + '</div>'
            : '';

          setStatus(
            '<strong>' + escHtml(remoteVersion) + '</strong> available' + notesHtml,
            'available'
          );
          // Inject an "update" button under the status.
          const applyBtn = document.createElement('button');
          applyBtn.className = 'accent';
          applyBtn.textContent = 'update';
          applyBtn.style.marginTop = '8px';
          applyBtn.onclick = () => applyOnline(remoteVersion);
          statusEl.appendChild(applyBtn);
        } catch (e) {
          setStatus('error: ' + escHtml(e.message), 'err');
        }
        checkBtn.disabled = false;
      };

      const fileBtn = document.createElement('button');
      fileBtn.textContent = 'update from file';
      fileBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.html';
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          setStatus('reading file...', '');
          const text = await file.text();
          const vMatch = text.match(/__AUDITABLE_VERSION__\s*=\s*'([^']+)'/);
          const version = vMatch ? 'v' + vMatch[1] : null;
          await applyUpdate(text, version);
        };
        input.click();
      };

      actions.append(checkBtn, fileBtn);
      body.appendChild(actions);

      // ── Internal apply paths ──

      async function applyOnline(version) {
        setStatus('downloading...', '');
        try {
          const resp = await fetch(__AUDITABLE_PAGES_URL__ + '/auditable.html');
          if (!resp.ok) throw new Error('download failed: ' + resp.status);
          const newHtml = await resp.text();
          await applyUpdate(newHtml, version);
        } catch (e) {
          setStatus('error: ' + escHtml(e.message), 'err');
        }
      }

      async function applyUpdate(newHtml, version) {
        setStatus('verifying signature...', '');
        const result = await verifySignature(newHtml);

        if (result.status === 'invalid') {
          setStatus('signature verification FAILED — update rejected', 'err');
          return;
        }

        const warnMessages = {
          'unsigned': 'this file is not signed',
          'no-key': 'no public key configured — cannot verify signature',
          'wrong-key': 'signed with an unknown key',
          'unsupported': result.message,
        };
        if (warnMessages[result.status]) {
          renderConfirm(warnMessages[result.status], () => finishUpdate(newHtml, version, setStatus));
          return;
        }

        if (result.status === 'error') {
          setStatus('verification error: ' + escHtml(result.message), 'err');
          return;
        }

        // Valid signature — proceed
        finishUpdate(newHtml, version, setStatus);
      }

      function renderConfirm(message, onProceed) {
        statusEl.innerHTML = '';
        statusEl.className = 'update-status update-warn';

        const msg = document.createElement('div');
        msg.textContent = 'warning: ' + message;
        statusEl.appendChild(msg);

        const row = document.createElement('div');
        row.className = 'update-confirm';
        const proceedBtn = document.createElement('button');
        proceedBtn.textContent = 'proceed anyway';
        proceedBtn.onclick = onProceed;
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'cancel';
        cancelBtn.onclick = () => setStatus('update cancelled', '');
        row.append(proceedBtn, cancelBtn);
        statusEl.appendChild(row);
      }
    },
  }).show();
}

// Public entry. Name kept for backward-compat with toolbar / menubar callers
// (they call window.toggleUpdate). Returns the dialog promise.
export function toggleUpdate() {
  return openUpdateDialog();
}

// ── VERIFY CURRENT DOCUMENT (load-time, sets toolbar badge + caches result) ──

async function verifySelf() {
  // Reconstruct from live DOM
  const styleEl = document.querySelector('style');
  const scriptEl = document.querySelector('script');
  if (!styleEl || !scriptEl) {
    _verifySelfResult = { text: 'error: no style/script', cls: 'err' };
    return;
  }

  const raw = document.body.innerHTML;
  const sigMatch = raw.match(/<!--AUDITABLE-SIGNATURE\n([\s\S]*?)\nAUDITABLE-SIGNATURE-->/);
  if (!sigMatch) {
    _verifySelfResult = { text: 'unsigned', cls: 'warn' };
    return;
  }

  let sig;
  try { sig = JSON.parse(sigMatch[1]); } catch {
    _verifySelfResult = { text: 'invalid signature format', cls: 'err' };
    return;
  }

  const pubKeyB64 = __AUDITABLE_PUBLIC_KEY__;
  if (!pubKeyB64) {
    _verifySelfResult = { text: 'no public key configured', cls: 'warn' };
    return;
  }

  if (sig.pub !== pubKeyB64) {
    _verifySelfResult = { text: 'signed with unknown key', cls: 'warn' };
    return;
  }

  const content = buildSignedContent(styleEl.textContent, scriptEl.textContent);

  try {
    const pubBytes = Uint8Array.from(atob(pubKeyB64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw', pubBytes, { name: 'Ed25519' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig.sig), c => c.charCodeAt(0));
    const msgBytes = new TextEncoder().encode(content);
    const valid = await crypto.subtle.verify('Ed25519', key, sigBytes, msgBytes);
    if (valid) {
      _verifySelfResult = { text: 'signed ✓', cls: 'ok' };
      setBadge('signed', 'signed', 'toolbar-badge toolbar-badge-signed');
    } else {
      _verifySelfResult = { text: 'signature invalid', cls: 'err' };
    }
  } catch (e) {
    if (e.name === 'NotSupportedError') {
      _verifySelfResult = { text: 'Ed25519 not supported', cls: 'warn' };
    } else {
      _verifySelfResult = { text: 'error: ' + e.message, cls: 'err' };
    }
  }
}

// ── INIT ──
(function() {
  // Run self-verification on load (sets toolbar badge as a side effect,
  // caches result for the next openUpdateDialog() call).
  verifySelf();
})();
