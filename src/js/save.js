import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { isCollapsed } from './dag.js';
import { getSettings, applySettings, resolveExecMode, resolveRunOnLoad } from './settings.js';
import { runAll } from './exec.js';
import { setMsg } from './ui.js';

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

function buildNotebookHtml() {
  // serialize current state back to a self-contained HTML file
  const title = $('#docTitle').value || 'untitled';

  // collect cells as data
  const cellData = S.cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: c.el.classList.contains('collapsed') || undefined
  }));

  // get the runtime and styles from current document
  const styleEl = document.querySelector('style');
  const styles = styleEl.textContent;

  // get the script
  const scriptEl = document.querySelector('script');
  const script = scriptEl.textContent;

  // read static elements from live DOM
  const helpHTML = $('#helpOverlay').outerHTML;
  const settingsOvHTML = $('#settingsOverlay').outerHTML;
  const settingsPanHTML = $('#settingsPanel').outerHTML.replace(/display:\s*block;?/, '');
  const updateOvHTML = $('#updateOverlay').outerHTML.replace(/\bvisible\b/, '').replace(/class="\s*"/, 'class=""');
  const updatePanEl = $('#updatePanel').cloneNode(true);
  updatePanEl.style.display = '';
  // reset update status and dynamic text
  const uStatus = updatePanEl.querySelector('#updateStatus');
  if (uStatus) { uStatus.innerHTML = ''; uStatus.className = 'update-status'; }
  const updatePanHTML = updatePanEl.outerHTML.replace(/display:\s*block;?/, '');
  const statusbarHTML = document.querySelector('.statusbar').outerHTML;

  // read toolbar from live DOM and patch the title value
  const toolbarEl = document.querySelector('.toolbar').cloneNode(true);
  toolbarEl.querySelector('#docTitle').value = title;
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable \u2014 ${esc(title)}</title>
<style>\n${styles}\n</style>
</head>
<body>

${helpHTML}

${settingsOvHTML}
${settingsPanHTML}

${updateOvHTML}
${updatePanHTML}

${toolbarHTML}

${findBarHTML}

<button class="present-exit" onclick="togglePresent()">\u2715 exit</button>

<div class="notebook" id="notebook">
</div>

${statusbarHTML}

${'<!-- cell data: JSON array of {type, code, collapsed?} -->\n<!--AUDITABLE-DATA\n' + JSON.stringify(cellData) + '\nAUDITABLE-DATA-->'}
${Object.keys(window._installedModules || {}).length ? '<!-- installed modules: base64-encoded JSON mapping URLs to {source, cellId} -->\n<!--AUDITABLE-MODULES\n' + encodeModules(window._installedModules) + '\nAUDITABLE-MODULES-->' : ''}
${'<!-- notebook settings: JSON {theme, fontSize, width, ...} -->\n<!--AUDITABLE-SETTINGS\n' + JSON.stringify(getSettings()) + '\nAUDITABLE-SETTINGS-->'}

<script>\n${script}\n<\/script>
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

export function saveNotebook() {
  if (_saveMode === 'packed') {
    savePackedNotebook();
    return;
  }
  const title = $('#docTitle').value || 'untitled';
  const html = buildNotebookHtml();

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
  const html = buildNotebookHtml();

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
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function exportAsTxt() {
  const title = $('#docTitle').value || 'untitled';
  const html = buildNotebookHtml();

  // extract notebook data from HTML
  const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  let cells = [];
  if (dataMatch) {
    try { cells = JSON.parse(dataMatch[1]); } catch {}
  }

  const setMatch = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  let settings = {};
  if (setMatch) {
    try { settings = JSON.parse(setMatch[1]); } catch {}
  }

  // extract module URLs (without sources — standalone export just records URLs)
  const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  let moduleUrls = [];
  if (modMatch) {
    try {
      const decoded = decodeModules(modMatch[1]);
      moduleUrls = Object.keys(decoded);
    } catch {}
  }

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
      for (const c of data) {
        const cell = addCell(c.type, c.code);
        if (c.collapsed || isCollapsed(c.code)) cell.el.classList.add('collapsed');
      }
      // run after load (gated on resolved runOnLoad)
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
