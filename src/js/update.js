import { S, $ } from './state.js';
import { setMsg } from './ui.js';
import { getSettings } from './settings.js';
import { renderMd } from './markdown.js';
import { encodeModules } from './save.js';

// ── UPDATE PANEL ──

export function toggleUpdate() {
  const overlay = $('#updateOverlay');
  const panel = $('#updatePanel');
  const open = !overlay.classList.contains('visible');
  overlay.classList.toggle('visible');
  panel.style.display = open ? 'block' : 'none';
}

// ── SELF-UPDATE SYSTEM ──

const __AUDITABLE_PUBLIC_KEY__ = '';
const __AUDITABLE_REPO__ = 'endarthur/auditable';
const __AUDITABLE_PAGES_URL__ = 'https://endarthur.github.io/auditable';

// ── SIGNATURE EXTRACTION ──

function extractSignature(html) {
  const m = html.match(/<!--AUDITABLE-SIGNATURE\n([\s\S]*?)\nAUDITABLE-SIGNATURE-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ── RUNTIME EXTRACTION ──

function extractRuntime(html) {
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
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
    title: title ? title[1].replace(/^Auditable\s*\u2014\s*/, '') : 'untitled',
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
    html = html.replace(/<title>[^<]*<\/title>/, '<title>Auditable \u2014 ' + escHtml(oldData.title) + '</title>');
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

// ── UPDATE STATUS UI ──

function setUpdateStatus(html, cls) {
  const el = $('#updateStatus');
  if (el) {
    el.innerHTML = html;
    el.className = 'update-status' + (cls ? ' update-' + cls : '');
  }
}

// ── CHECK FOR UPDATE (GitHub API) ──

export async function checkForUpdate() {
  const btn = $('#updateCheckBtn');
  if (btn) btn.disabled = true;
  setUpdateStatus('checking...', '');

  try {
    // Fetch version.json from GitHub Pages (CORS-friendly)
    const vResp = await fetch(__AUDITABLE_PAGES_URL__ + '/version.json');
    if (!vResp.ok) throw new Error('version check failed: ' + vResp.status);
    const vData = await vResp.json();
    const remoteVersion = vData.version || '';
    const currentRelease = $('#updateRelease')?.textContent || 'dev';

    if (currentRelease === 'dev') {
      // Dev builds always offer the latest release
    } else if (compareVersions(currentRelease, remoteVersion) >= 0) {
      setUpdateStatus('up to date (' + currentRelease + ')', 'ok');
      if (btn) btn.disabled = false;
      return;
    }

    const notes = vData.notes || '';
    const notesHtml = notes
      ? '<div class="update-notes">' + renderMd(notes) + '</div>'
      : '';

    setUpdateStatus(
      '<strong>' + remoteVersion + '</strong> available'
      + notesHtml
      + '<button id="updateApplyBtn" onclick="applyOnlineUpdate()">update</button>',
      'available'
    );

    window._updateVersion = remoteVersion;
  } catch (e) {
    setUpdateStatus('error: ' + escHtml(e.message), 'err');
  }
  if (btn) btn.disabled = false;
}

// ── APPLY ONLINE UPDATE ──

export async function applyOnlineUpdate() {
  setUpdateStatus('downloading...', '');

  try {
    // Download signed build from GitHub Pages (CORS-friendly)
    const resp = await fetch(__AUDITABLE_PAGES_URL__ + '/auditable.html');
    if (!resp.ok) throw new Error('download failed: ' + resp.status);
    const newHtml = await resp.text();
    await applyUpdate(newHtml, window._updateVersion);
  } catch (e) {
    setUpdateStatus('error: ' + escHtml(e.message), 'err');
  }
}

// ── APPLY UPDATE (verify + reassemble + download) ──

async function applyUpdate(newHtml, version) {
  setUpdateStatus('verifying signature...', '');

  const result = await verifySignature(newHtml);

  if (result.status === 'invalid') {
    setUpdateStatus('signature verification FAILED \u2014 update rejected', 'err');
    return;
  }

  const warnMessages = {
    'unsigned': 'this file is not signed',
    'no-key': 'no public key configured \u2014 cannot verify signature',
    'wrong-key': 'signed with an unknown key',
  };
  if (warnMessages[result.status]) {
    setUpdateStatus(
      'warning: ' + warnMessages[result.status]
      + '<div class="update-confirm">'
      + '<button onclick="proceedUpdate()">proceed anyway</button>'
      + '<button onclick="cancelUpdate()">cancel</button>'
      + '</div>',
      'warn'
    );
    window._pendingUpdateHtml = newHtml;
    window._pendingUpdateVersion = version;
    return;
  }

  if (result.status === 'unsupported') {
    setUpdateStatus(
      result.message
      + '<div class="update-confirm">'
      + '<button onclick="proceedUpdate()">proceed without verification</button>'
      + '<button onclick="cancelUpdate()">cancel</button>'
      + '</div>',
      'warn'
    );
    window._pendingUpdateHtml = newHtml;
    window._pendingUpdateVersion = version;
    return;
  }

  if (result.status === 'error') {
    setUpdateStatus('verification error: ' + escHtml(result.message), 'err');
    return;
  }

  // Valid signature — proceed
  finishUpdate(newHtml, version);
}

export function proceedUpdate() {
  if (window._pendingUpdateHtml) {
    finishUpdate(window._pendingUpdateHtml, window._pendingUpdateVersion);
    delete window._pendingUpdateHtml;
    delete window._pendingUpdateVersion;
  }
}

export function cancelUpdate() {
  delete window._pendingUpdateHtml;
  delete window._pendingUpdateVersion;
  setUpdateStatus('update cancelled', '');
}

function finishUpdate(newHtml, version) {
  setUpdateStatus('reassembling...', '');

  // Extract current document as HTML to get data comments
  const currentHtml = document.documentElement.outerHTML;
  // But the data comments are in the body innerHTML at load time; grab from live source
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
      collapsed: c.el?.classList.contains('collapsed') || undefined
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
  setUpdateStatus('updated' + vLabel + ' \u2014 saved as ' + a.download, 'ok');
  setMsg('updated' + vLabel, 'ok');
}

// ── UPDATE FROM FILE ──

export function updateFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    setUpdateStatus('reading file...', '');
    const text = await file.text();

    // Try to extract version from the file
    const vMatch = text.match(/__AUDITABLE_VERSION__\s*=\s*'([^']+)'/);
    const version = vMatch ? 'v' + vMatch[1] : null;

    await applyUpdate(text, version);
  };
  input.click();
}

// ── VERIFY CURRENT DOCUMENT ──

async function verifySelf() {
  const el = $('#updateSigStatus');
  if (!el) return;

  // Reconstruct from live DOM
  const styleEl = document.querySelector('style');
  const scriptEl = document.querySelector('script');
  if (!styleEl || !scriptEl) {
    el.textContent = 'error: no style/script';
    el.className = 'update-sig update-err';
    return;
  }

  const raw = document.body.innerHTML;
  const sigMatch = raw.match(/<!--AUDITABLE-SIGNATURE\n([\s\S]*?)\nAUDITABLE-SIGNATURE-->/);
  if (!sigMatch) {
    el.textContent = 'unsigned';
    el.className = 'update-sig update-warn';
    return;
  }

  let sig;
  try { sig = JSON.parse(sigMatch[1]); } catch {
    el.textContent = 'invalid signature format';
    el.className = 'update-sig update-err';
    return;
  }

  const pubKeyB64 = __AUDITABLE_PUBLIC_KEY__;
  if (!pubKeyB64) {
    el.textContent = 'no public key configured';
    el.className = 'update-sig update-warn';
    return;
  }

  if (sig.pub !== pubKeyB64) {
    el.textContent = 'signed with unknown key';
    el.className = 'update-sig update-warn';
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
      el.textContent = 'signed \u2713';
      el.className = 'update-sig update-ok';
      setBadge('signed', 'signed', 'toolbar-badge toolbar-badge-signed');
    } else {
      el.textContent = 'signature invalid';
      el.className = 'update-sig update-err';
    }
  } catch (e) {
    if (e.name === 'NotSupportedError') {
      el.textContent = 'Ed25519 not supported';
      el.className = 'update-sig update-warn';
    } else {
      el.textContent = 'error: ' + e.message;
      el.className = 'update-sig update-err';
    }
  }
}

// ── INIT ──
(function() {
  const ver = $('#updateCurrentVer');
  if (ver) ver.textContent = 'v' + __AUDITABLE_VERSION__;
  const rel = $('#updateRelease');
  if (rel) {
    rel.textContent = __AUDITABLE_RELEASE__;
    if (__AUDITABLE_RELEASE__ === 'dev') rel.className = 'update-sig update-warn';
  }
  // Show public key status
  const keyEl = $('#updatePubKey');
  if (keyEl) {
    if (__AUDITABLE_PUBLIC_KEY__) {
      keyEl.textContent = __AUDITABLE_PUBLIC_KEY__.slice(0, 8) + '...';
      keyEl.className = 'update-sig update-key-truncated';
      keyEl.onclick = () => {
        if (keyEl.classList.contains('update-key-expanded')) {
          keyEl.textContent = __AUDITABLE_PUBLIC_KEY__.slice(0, 8) + '...';
          keyEl.classList.remove('update-key-expanded');
          keyEl.classList.add('update-key-truncated');
        } else {
          keyEl.textContent = __AUDITABLE_PUBLIC_KEY__;
          keyEl.classList.remove('update-key-truncated');
          keyEl.classList.add('update-key-expanded');
        }
      };
    } else {
      keyEl.textContent = 'not configured';
      keyEl.className = 'update-sig update-warn';
    }
  }
  // Run self-verification on load
  verifySelf();
})();
