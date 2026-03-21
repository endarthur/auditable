import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { isCollapsed, isBare } from './dag.js';
import { getSettings, applySettings, resolveExecMode, resolveRunOnLoad, getEditorViewSetting } from './settings.js';
import { runAll } from './exec.js';
import { setMsg } from './ui.js';
import { cryptoIsEncrypted, cryptoIsLocked, cryptoBuildBlock, cryptoDetect } from './crypto.js';

// ── APP RUNTIME ──
// Injected at build time — contains the minimal JS bundle for exported apps.
const __APP_RUNTIME__ = '';

// ── MODULES ENCODING ──
// base64-encode modules JSON to avoid HTML comment / String.replace issues
// (source code can contain --, $', etc.)

export function encodeModules(obj) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

export function decodeModules(raw) {
  const b64 = raw.replace(/\s/g, '');
  // detect legacy format: starts with { means raw JSON (not base64)
  if (b64.startsWith('{') || b64.startsWith('%7B')) return JSON.parse(raw);
  return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

// ── LIVE COMMENT SYNC ──
// keep AUDITABLE-DATA/SETTINGS/MODULES comment nodes up-to-date in the live DOM
// so that a native browser Ctrl+S (which dumps the DOM) produces a loadable file.

let _dataNode = null, _settingsNode = null, _modulesNode = null, _fsNode = null;
let _liveSyncTimer = null;

function findCommentNode(tag) {
  const iter = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  let node;
  while ((node = iter.nextNode())) {
    if (node.nodeValue.startsWith(tag + '\n')) return node;
  }
  return null;
}

function ensureCommentNode(tag, descComment) {
  let node = findCommentNode(tag);
  if (!node) {
    // create the description comment + data comment pair
    if (descComment) document.body.appendChild(document.createComment(' ' + descComment + ' '));
    node = document.createComment(tag + '\n\n' + tag);
    document.body.appendChild(node);
  }
  return node;
}

export function initLiveSync() {
  _dataNode = ensureCommentNode('AUDITABLE-DATA', 'cell data: JSON array of {type, code, collapsed?}');
  _settingsNode = ensureCommentNode('AUDITABLE-SETTINGS', 'notebook settings: JSON {theme, fontSize, width, ...}');
  // modules node is created on demand when modules exist
  _modulesNode = findCommentNode('AUDITABLE-MODULES');
  // fs node is created on demand when files exist
  _fsNode = findCommentNode('AUDITABLE-FS');
}

export function syncData() {
  if (cryptoIsEncrypted()) { if (window._cryptoSyncTrigger) window._cryptoSyncTrigger(); return; }
  if (!_dataNode) return;
  const cellData = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: (c._splitOrigEl || c.el).classList.contains('collapsed') || undefined
  }));
  _dataNode.nodeValue = 'AUDITABLE-DATA\n' + JSON.stringify(cellData) + '\nAUDITABLE-DATA';
}

export function syncDataDebounced() {
  clearTimeout(_liveSyncTimer);
  _liveSyncTimer = setTimeout(syncData, 500);
}

export function syncSettings() {
  if (cryptoIsEncrypted()) { if (window._cryptoSyncTrigger) window._cryptoSyncTrigger(); return; }
  if (!_settingsNode) return;
  _settingsNode.nodeValue = 'AUDITABLE-SETTINGS\n' + JSON.stringify(getSettings()) + '\nAUDITABLE-SETTINGS';
}

export function syncModules() {
  if (cryptoIsEncrypted()) { if (window._cryptoSyncTrigger) window._cryptoSyncTrigger(); return; }
  const mods = window._installedModules;
  if (!mods || !Object.keys(mods).length) {
    // remove node if no modules
    if (_modulesNode) {
      // also remove description comment before it
      if (_modulesNode.previousSibling?.nodeType === 8) _modulesNode.previousSibling.remove();
      _modulesNode.remove();
      _modulesNode = null;
    }
    return;
  }
  if (!_modulesNode) {
    _modulesNode = ensureCommentNode('AUDITABLE-MODULES', 'installed modules: base64-encoded JSON mapping URLs to {source, cellId, compressed?, binary?, type?}');
  }
  _modulesNode.nodeValue = 'AUDITABLE-MODULES\n' + encodeModules(mods) + '\nAUDITABLE-MODULES';
}

export function syncFs() {
  if (cryptoIsEncrypted()) { if (window._cryptoSyncTrigger) window._cryptoSyncTrigger(); return; }
  const fs = window._notebookFS;
  if (!fs || !fs.size) {
    // remove node if no files
    if (_fsNode) {
      if (_fsNode.previousSibling?.nodeType === 8) _fsNode.previousSibling.remove();
      _fsNode.remove();
      _fsNode = null;
    }
    return;
  }
  if (!_fsNode) {
    _fsNode = ensureCommentNode('AUDITABLE-FS', 'notebook filesystem: base64-encoded JSON mapping paths to {type, compressed, size, data}');
  }
  _fsNode.nodeValue = 'AUDITABLE-FS\n' + encodeModules(Object.fromEntries(fs)) + '\nAUDITABLE-FS';
}

// wire syncFs to window for fs.js debounced callback
if (typeof window !== 'undefined') window._syncFs = syncFs;

// ── SAVE / LOAD ──

// save mode: 'normal' or 'packed'
let _saveMode = 'normal';

export function getSaveMode() { return _saveMode; }

export function toggleSaveTray() {
  const tray = $('#saveTray');
  if (tray) tray.classList.toggle('open');
}

export function setSaveMode(mode) {
  _saveMode = mode;
  // update UI
  const label = $('#saveLabel');
  if (label) label.textContent = mode === 'packed' ? 'pack' : 'save';
  const tray = $('#saveTray');
  if (tray) tray.classList.remove('open');
  // update mobile buttons
  const mobSave = $('#mobileSaveBtn');
  const mobPack = $('#mobilePackBtn');
  if (mobSave) mobSave.classList.toggle('active-mode', mode === 'normal');
  if (mobPack) mobPack.classList.toggle('active-mode', mode === 'packed');
}

// ── RUNTIME COMPRESSION ──
// Gzip + base64 the JS runtime for smaller saved notebooks.
// The loader decompresses, normalizes the DOM (so verifySelf/update still work),
// then evals the runtime in global scope.

async function compressRuntime(script) {
  const blob = new Blob([script]);
  const cs = new CompressionStream('gzip');
  const compressed = await new Response(blob.stream().pipeThrough(cs)).arrayBuffer();
  const bytes = new Uint8Array(compressed);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary).replace(/.{1,76}/g, '$&\n');

  // Loader: decompress, normalize DOM (replace script content, remove data element),
  // then eval. Capturing 'me' synchronously before async ensures we get the right element.
  const loader =
    '(function(){var me=document.scripts[document.scripts.length-1];(async function(){' +
    "var b=document.getElementById('_rt').textContent.replace(/\\\\s/g,'');" +
    'var d=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});' +
    "var s=await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'))).text();" +
    "me.textContent=s;document.getElementById('_rt').remove();" +
    '(0,eval)(s)})()})()';

  return `<script type="text/plain" id="_rt">\n${b64}<\/script>\n<script>\n${loader}\n<\/script>`;
}

async function buildNotebookHtml(opts = {}) {
  // serialize current state back to a self-contained HTML file
  const title = $('#docTitle').value || 'untitled';

  // collect cells as data
  const cellData = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: (c._splitOrigEl || c.el).classList.contains('collapsed') || undefined
  }));

  // get the runtime and styles from current document (two style tags since CSS split)
  const appStyleEl = document.querySelector('#auditable-app-css');
  const editorStyleEl = document.querySelector('#auditable-editor-css');
  const appStyles = appStyleEl ? appStyleEl.textContent : '';
  const editorStyles = editorStyleEl ? editorStyleEl.textContent : '';
  // fallback: single #auditable-css for older builds
  const fallbackStyleEl = document.querySelector('#auditable-css');
  const styles = fallbackStyleEl ? fallbackStyleEl.textContent : (appStyles + '\n' + editorStyles);

  // get the script — compress runtime by default for smaller saved notebooks
  const scriptEl = document.querySelector('script');
  const script = scriptEl.textContent;
  const compress = opts.compress !== false;
  const scriptBlock = compress
    ? await compressRuntime(script)
    : `<script>\n${script}\n<\/script>`;

  // read static elements from live DOM
  const helpHTML = $('#helpOverlay').outerHTML;
  const settingsOvHTML = $('#settingsOverlay').outerHTML;
  const settingsPanEl = $('#settingsPanel').cloneNode(true);
  settingsPanEl.style.display = '';
  // clear module/binary/plugin lists (they contain URLs that leak when encrypted)
  const plugList = settingsPanEl.querySelector('#pluginList');
  if (plugList) plugList.innerHTML = '';
  const modList = settingsPanEl.querySelector('#moduleList');
  if (modList) modList.innerHTML = '';
  const binList = settingsPanEl.querySelector('#binaryList');
  if (binList) binList.innerHTML = '';
  // reset encryption UI
  const cryptoStatus = settingsPanEl.querySelector('#cryptoStatus');
  if (cryptoStatus) cryptoStatus.textContent = 'not encrypted';
  const cryptoEnable = settingsPanEl.querySelector('#cryptoEnableSection');
  if (cryptoEnable) cryptoEnable.style.display = '';
  const cryptoManage = settingsPanEl.querySelector('#cryptoManageSection');
  if (cryptoManage) cryptoManage.style.display = 'none';
  // clear passphrase inputs
  ['cryptoPassphrase', 'cryptoPassphraseConfirm', 'cryptoNewPassphrase', 'cryptoNewPassphraseConfirm'].forEach(id => {
    const el = settingsPanEl.querySelector('#' + id);
    if (el) el.setAttribute('value', '');
  });
  const cryptoStrength = settingsPanEl.querySelector('#cryptoStrength');
  if (cryptoStrength) cryptoStrength.textContent = '';
  const settingsPanHTML = settingsPanEl.outerHTML.replace(/display:\s*block;?/, '');
  const updateOvHTML = $('#updateOverlay').outerHTML.replace(/\bvisible\b/, '').replace(/class="\s*"/, 'class=""');
  const updatePanEl = $('#updatePanel').cloneNode(true);
  updatePanEl.style.display = '';
  // reset update status and dynamic text
  const uStatus = updatePanEl.querySelector('#updateStatus');
  if (uStatus) { uStatus.innerHTML = ''; uStatus.className = 'update-status'; }
  const updatePanHTML = updatePanEl.outerHTML.replace(/display:\s*block;?/, '');
  // FS panel — reset to empty state
  const fsPanEl = document.getElementById('fsPanel');
  let fsPanHTML = '';
  if (fsPanEl) {
    const clone = fsPanEl.cloneNode(true);
    clone.style.display = '';
    const body = clone.querySelector('#fsPanelBody');
    if (body) body.innerHTML = '';
    const summary = clone.querySelector('#fsSummary');
    if (summary) summary.textContent = 'empty';
    fsPanHTML = clone.outerHTML.replace(/display:\s*block;?/, '');
  }

  // reset statusbar dynamic state
  const statusbarEl = document.querySelector('.statusbar').cloneNode(true);
  const cryptoEl = statusbarEl.querySelector('#statusCrypto');
  if (cryptoEl) { cryptoEl.textContent = ''; cryptoEl.onclick = null; }
  const mcpStatusEl = statusbarEl.querySelector('#statusMcp');
  if (mcpStatusEl) { mcpStatusEl.textContent = ''; mcpStatusEl.className = 'status-mcp'; }
  const statusbarHTML = statusbarEl.outerHTML;

  // capture overlay elements (reset to default hidden state)
  function captureOverlay(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.style.display = 'none';
    return clone.outerHTML;
  }
  const mcpConfirmHTML = captureOverlay('mcpConfirmOverlay');
  const exportOverlayHTML = captureOverlay('exportOverlay');
  const lockScreenHTML = captureOverlay('lockScreen');
  const recoveryHTML = captureOverlay('recoveryOverlay');

  // capture MCP panel (reset to default)
  const mcpPanEl = document.getElementById('mcpPanel');
  let mcpPanHTML = '';
  if (mcpPanEl) {
    const clone = mcpPanEl.cloneNode(true);
    clone.classList.remove('visible');
    const log = clone.querySelector('#mcpPanelLog');
    if (log) log.innerHTML = '<span class="dim">no tool calls yet</span>';
    const info = clone.querySelector('#mcpPanelInfo');
    if (info) info.textContent = '';
    const input = clone.querySelector('#mcpConnectInput');
    if (input) { input.value = ''; input.disabled = false; }
    const nameInput = clone.querySelector('#mcpNameInput');
    if (nameInput) { nameInput.value = ''; nameInput.disabled = false; }
    const status = clone.querySelector('#mcpPanelStatus');
    if (status) { status.textContent = 'disconnected'; status.className = 'mcp-panel-status'; }
    mcpPanHTML = clone.outerHTML;
  }

  // read toolbar from live DOM and patch the title value
  const toolbarEl = document.querySelector('.toolbar').cloneNode(true);
  // mask title when encrypted (setAttribute needed — .value doesn't update the HTML attribute for outerHTML)
  toolbarEl.querySelector('#docTitle').setAttribute('value', cryptoIsEncrypted() ? 'untitled' : title);
  toolbarEl.querySelector('#toolbarStatus').textContent = '';
  // reset autorun button state to match saved mode
  const autoBtn = toolbarEl.querySelector('#autorunBtn');
  const savedMode = S.autorun ? 'reactive' : 'manual';
  if (autoBtn) {
    autoBtn.className = savedMode === 'reactive' ? 'autorun-on' : 'autorun-off';
    autoBtn.textContent = savedMode === 'reactive' ? '\u25b6' : '\u2016';
  }
  // close overflow and save tray if open
  const overflow = toolbarEl.querySelector('.toolbar-overflow');
  if (overflow) overflow.classList.remove('open');
  const saveTray = toolbarEl.querySelector('#saveTray');
  if (saveTray) saveTray.classList.remove('open');
  // reset save label to default
  const saveLabel = toolbarEl.querySelector('#saveLabel');
  if (saveLabel) saveLabel.textContent = 'save';
  // clear badges (they get set dynamically on load)
  const badges = toolbarEl.querySelector('.toolbar-badges');
  if (badges) badges.innerHTML = '';
  const toolbarHTML = toolbarEl.outerHTML;

  // capture find bar and reset to default state
  const findBarEl = $('#findBar').cloneNode(true);
  findBarEl.style.display = '';
  findBarEl.classList.remove('show-replace');
  findBarEl.querySelector('#findInput').value = '';
  findBarEl.querySelector('#replaceInput').value = '';
  findBarEl.querySelector('#findCount').textContent = '';
  findBarEl.querySelector('#findCaseBtn').classList.remove('active');
  findBarEl.querySelector('#findRegexBtn').classList.remove('active');
  const findBarHTML = findBarEl.outerHTML;

  // build output HTML
  const styleBlock = appStyleEl
    ? `<style id="auditable-app-css">\n${appStyles}\n</style>\n<style id="auditable-editor-css">\n${editorStyles}\n</style>`
    : `<style id="auditable-css">\n${styles}\n</style>`;

  // data blocks: encrypted or cleartext
  let dataBlocks;
  const effectiveTitle = cryptoIsEncrypted() ? 'Encrypted' : esc(title);
  if (cryptoIsEncrypted()) {
    const payload = {
      data: cellData,
      settings: getSettings(),
      modules: Object.keys(window._installedModules || {}).length ? encodeModules(window._installedModules) : null,
      fs: window._notebookFS?.size ? encodeModules(Object.fromEntries(window._notebookFS)) : null,
      title: title,
    };
    const block = await cryptoBuildBlock(payload);
    dataBlocks = '<!-- encrypted notebook data: passphrase required to access cells, settings, and modules -->\n<!--AUDITABLE-CRYPTO\n' + JSON.stringify(block) + '\nAUDITABLE-CRYPTO-->';
  } else {
    dataBlocks = '<!-- cell data: JSON array of {type, code, collapsed?} -->\n<!--AUDITABLE-DATA\n' + JSON.stringify(cellData) + '\nAUDITABLE-DATA-->'
      + '\n' + (Object.keys(window._installedModules || {}).length ? '<!-- installed modules: base64-encoded JSON mapping URLs to {source, cellId, compressed?, binary?, type?} -->\n<!--AUDITABLE-MODULES\n' + encodeModules(window._installedModules) + '\nAUDITABLE-MODULES-->' : '')
      + '\n' + (window._notebookFS?.size ? '<!-- notebook filesystem: base64-encoded JSON mapping paths to {type, compressed, size, data} -->\n<!--AUDITABLE-FS\n' + encodeModules(Object.fromEntries(window._notebookFS)) + '\nAUDITABLE-FS-->' : '')
      + '\n' + '<!-- notebook settings: JSON {theme, fontSize, width, ...} -->\n<!--AUDITABLE-SETTINGS\n' + JSON.stringify(getSettings()) + '\nAUDITABLE-SETTINGS-->';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable \u2014 ${effectiveTitle}</title>
${styleBlock}
</head>
<body>

${helpHTML}

${settingsOvHTML}
${settingsPanHTML}

${updateOvHTML}
${updatePanHTML}

${fsPanHTML}

${mcpPanHTML}

${mcpConfirmHTML}
${exportOverlayHTML}

${lockScreenHTML}
${recoveryHTML}

${toolbarHTML}

${findBarHTML}

<button class="present-exit" onclick="togglePresent()">\u2715 exit</button>

<div class="notebook" id="notebook">
</div>

${statusbarHTML}

${dataBlocks}

${scriptBlock}
</body>
</html>`;
}

function downloadHtml(html, title) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.html';
  a.click();
  URL.revokeObjectURL(url);
  return a.download;
}

export async function saveNotebook() {
  if (_saveMode === 'packed') {
    savePackedNotebook();
    return;
  }
  const title = $('#docTitle').value || 'untitled';
  let html;
  try {
    html = await buildNotebookHtml();
  } catch (e) {
    console.error('save failed:', e);
    setMsg('save failed: ' + e.message, 'err');
    return;
  }

  // AF bridge: send serialized HTML to parent shell instead of downloading
  if (window.__AF_BRIDGE__) {
    window.parent.postMessage({ type: 'af:serialized', payload: { html } }, '*');
    setMsg('saved', 'ok');
    return;
  }

  const fn = downloadHtml(html, title);
  setMsg('saved ' + fn, 'ok');
}

export async function savePackedNotebook() {
  const title = $('#docTitle').value || 'untitled';
  const html = await buildNotebookHtml({ compress: false });

  try {
    // compress via CompressionStream
    const blob = new Blob([html]);
    const cs = new CompressionStream('gzip');
    const stream = blob.stream().pipeThrough(cs);
    const compressed = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(compressed);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const b64Lines = b64.replace(/.{1,76}/g, '$&\n');

    const loader = `<!DOCTYPE html>
<!-- packed auditable notebook -->
<!-- the full notebook is gzip-compressed and base64-encoded in the <pre> block below. -->
<!-- on load, the script decodes and decompresses it, then replaces the page contents. -->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Auditable \u2014 ${esc(title)}</title>
  <style>
    html { background: #1a1a1a }
    body { color: #999; font: 14px/1.5 monospace; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0 }
    #_d { display: none }
  </style>
</head>
<body>
<div id="_l">unpacking\u2026</div>

<!-- base64-encoded gzip payload (76-char lines) -->
<pre id="_d">
${b64Lines}</pre>

<script>
(async () => {
  // 1. read base64 from the hidden <pre>, strip whitespace from line wrapping
  var b64 = document.getElementById('_d').textContent.replace(/\\s/g, '');

  // 2. decode base64 to binary
  var bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  // 3. decompress gzip via DecompressionStream
  var stream = new Response(new Blob([bytes])).body.pipeThrough(new DecompressionStream('gzip'));
  var html = await new Response(stream).text();

  // 4. mark as packed (so the notebook knows it was loaded from a packed save)
  html = html.replace('<head>', '<head><meta name="auditable-packed">');

  // 5. replace the current page with the full notebook
  document.open();
  document.write(html);
  document.close();
})().catch(function(e) {
  document.getElementById('_l').textContent = 'error: ' + e.message;
});
<\/script>
</body>
</html>`;


    const fn = downloadHtml(loader, title);
    const kb = (loader.length / 1024).toFixed(0);
    setMsg('packed ' + fn + ' (' + kb + ' KB)', 'ok');
  } catch (e) {
    setMsg('pack failed: ' + e.message, 'err');
  }
}

export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function exportAsTxt() {
  if (cryptoIsLocked()) { setMsg('unlock first', 'err'); return; }
  const title = $('#docTitle').value || 'untitled';

  // read from live state directly (works for both encrypted and unencrypted)
  const cells = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: (c._splitOrigEl || c.el).classList.contains('collapsed') || undefined,
  }));
  const settings = getSettings();
  const moduleUrls = Object.keys(window._installedModules || {});

  // build /// formatted text
  const lines = ['/// auditable'];
  if (title && title !== 'untitled') {
    lines.push('/// title: ' + title);
  }
  const defaultSettings = { theme: 'dark', fontSize: 13, width: '860' };
  if (JSON.stringify(settings) !== JSON.stringify(defaultSettings)) {
    lines.push('/// settings: ' + JSON.stringify(settings));
  }
  for (const url of moduleUrls) {
    lines.push('/// module: ' + url);
  }
  for (const cell of cells) {
    lines.push('');
    const flags = cell.collapsed ? ' collapsed' : '';
    lines.push('/// ' + cell.type + flags);
    lines.push(cell.code || '');
  }
  const txt = lines.join('\n') + '\n';

  // download
  if (window.__AF_BRIDGE__) {
    window.parent.postMessage({ type: 'af:download', payload: { data: txt, filename: title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt', mime: 'text/plain' } }, '*');
  } else {
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
  setMsg('exported .txt', 'ok');
}

export function loadFromEmbed() {
  // look for embedded cell data in HTML comments
  const raw = document.body.innerHTML;

  // encrypted notebook — skip normal loading, init.js handles it
  if (cryptoDetect(raw).found) return false;

  // restore installed modules first (before cells run)
  const modMatch = raw.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  if (modMatch) {
    try {
      window._installedModules = decodeModules(modMatch[1]);
    } catch (e) {
      console.error('Failed to parse installed modules:', e);
    }
  }

  // restore notebook filesystem
  const fsMatch = raw.match(/<!--AUDITABLE-FS\n([\s\S]*?)\nAUDITABLE-FS-->/);
  if (fsMatch) {
    try {
      window._notebookFS = new Map(Object.entries(decodeModules(fsMatch[1])));
    } catch (e) {
      console.error('Failed to parse notebook FS:', e);
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

  // apply execution mode priority chain (localStorage > notebook > build default)
  const effectiveMode = resolveExecMode();
  const effectiveRun = resolveRunOnLoad();
  if (effectiveMode === 'manual') {
    S.autorun = false;
    const btn = document.getElementById('autorunBtn');
    const btnMobile = document.getElementById('autorunBtnMobile');
    if (btn) { btn.className = 'autorun-off'; btn.textContent = '\u2016'; btn.title = 'manual mode \u2014 only Run All or Ctrl+Enter'; }
    if (btnMobile) { btnMobile.className = 'autorun-off'; btnMobile.textContent = '\u2016'; }
    const sel = document.getElementById('setExecMode');
    if (sel) sel.value = 'manual';
  }

  const match = raw.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);

      // clean dirty DOM (native browser save leaves stale cell elements)
      const nb = document.getElementById('notebook');
      if (nb) nb.innerHTML = '';
      // remove stale CSS cell <style> elements from <head>
      document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

      for (const c of data) {
        const cell = addCell(c.type, c.code);
        if (c.collapsed || isCollapsed(c.code)) cell.el.classList.add('collapsed');
      }
      // run after load (gated on resolved runOnLoad)
      // skip if editor view will be activated — enterSplitView() calls runAll() itself
      if (effectiveRun === 'yes' && getEditorViewSetting() !== 'yes' && S.cells.some(c => c.type === 'code')) {
        setTimeout(runAll, 50);
      }
      return true;
    } catch (e) {
      console.error('Failed to parse embedded data:', e);
    }
  }
  return false;
}

// ── EXPORT AS APP ──

export function exportAsApp(opts = {}) {
  const title = opts.title || $('#docTitle').value || 'untitled';
  const includeBase = opts.includeBaseStyles !== false;

  // collect cells as data
  const cellData = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: (c._splitOrigEl || c.el).classList.contains('collapsed') || undefined
  }));

  const settings = getSettings();

  // build CSS for the app
  let appStyles;
  if (includeBase) {
    const appStyleEl = document.querySelector('#auditable-app-css');
    appStyles = appStyleEl ? appStyleEl.textContent : '';
  } else {
    // minimal reset + widget defaults only
    appStyles = `* { margin: 0; padding: 0; box-sizing: border-box; }
audit-slider, audit-dropdown, audit-checkbox, audit-text-input {
  display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px;
}
.audit-widget-label { min-width: 80px; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
.audit-widget-val { min-width: 40px; text-align: right; font-size: 12px; }`;
  }

  // data blocks
  const dataBlock = '<!--AUDITABLE-DATA\n' + JSON.stringify(cellData) + '\nAUDITABLE-DATA-->';
  const settingsBlock = '<!--AUDITABLE-SETTINGS\n' + JSON.stringify(settings) + '\nAUDITABLE-SETTINGS-->';
  const modulesBlock = Object.keys(window._installedModules || {}).length
    ? '<!--AUDITABLE-MODULES\n' + encodeModules(window._installedModules) + '\nAUDITABLE-MODULES-->'
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${appStyles}
</style>
</head>
<body>
<div class="notebook" id="notebook"></div>
${dataBlock}
${modulesBlock}
${settingsBlock}
<script>
${__APP_RUNTIME__}
<\/script>
</body>
</html>`;

  if (window.__AF_BRIDGE__) {
    window.parent.postMessage({ type: 'af:download', payload: { data: html, filename: title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.html', mime: 'text/html' } }, '*');
  } else {
    downloadHtml(html, title);
  }

  const kb = (html.length / 1024).toFixed(0);
  setMsg('exported app (' + kb + ' KB)', 'ok');
}

export function showExportDialog() {
  // check if any cell has %bare directive
  const hasBare = S.cells.some(c => isBare(c.code));

  const overlay = document.getElementById('exportOverlay');
  const titleInput = document.getElementById('exportTitle');
  const baseCheck = document.getElementById('exportBaseStyles');

  if (titleInput) titleInput.value = $('#docTitle').value || 'untitled';
  if (baseCheck) baseCheck.checked = !hasBare;
  if (overlay) overlay.style.display = '';
}

export function doExportApp() {
  if (cryptoIsLocked()) { setMsg('unlock first', 'err'); return; }
  const title = document.getElementById('exportTitle').value;
  const includeBase = document.getElementById('exportBaseStyles').checked;
  closeExportDialog();
  exportAsApp({ title, includeBaseStyles: includeBase });
}

export function closeExportDialog() {
  const overlay = document.getElementById('exportOverlay');
  if (overlay) overlay.style.display = 'none';
}
