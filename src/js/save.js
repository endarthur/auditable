import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable } from './cell-types.js';
import { isCollapsed, isBare } from './dag.js';
import { getSettings, applySettings, resolveExecMode, resolveRunOnLoad, getEditorViewSetting } from './settings.js';
import { runAll } from './exec.js';
import { setMsg } from './ui.js';
import { cryptoIsEncrypted, cryptoIsLocked, cryptoBuildBlock, cryptoDetect } from './crypto.js';
import { serializeCells, encodeModules, decodeModules, esc as _esc, buildTxtExport, serializeVfs, hydrateVfs, parseNotebookTxt } from './serialize.js';
import { flushPendingDirty, hydrateModulesFromVfs, isLegacyFormat, importLegacyFormat } from './persist.js';
import { Dialog } from '#dialog';

// re-export for backward compatibility (init.js, update.js import from save.js)
export { encodeModules, decodeModules };

// ── APP RUNTIME ──
// Injected at build time — contains the minimal JS bundle for exported apps.
const __APP_RUNTIME__ = '';

// ── SWITCHBOARD FONTS (on-demand fetch + localStorage cache) ──
// Per spec_inbox/auditable-theme-spec.md §4.3, fonts are NOT bundled in
// the runtime — fetched from Google Fonts when the user opts in via
// Settings → "embed fonts". Cached in localStorage; emitted as @font-face
// in saved notebooks when the per-notebook embedFonts setting is on.
const __SWITCHBOARD_OFL__ = '';  // injected at build time from ext/switchboard/fonts/OFL.txt
const _SW_FONTS_LS_KEY = 'auditable.switchboardFonts.v1';

// Roman/italic + weight matrix the notebook needs. Order = canonical face order.
const _SW_FONT_FACES = [
  { family: 'Barlow',     weight: 400, style: 'normal', key: 'barlow400' },
  { family: 'Barlow',     weight: 500, style: 'normal', key: 'barlow500' },
  { family: 'Barlow',     weight: 600, style: 'normal', key: 'barlow600' },
  { family: 'Barlow',     weight: 700, style: 'normal', key: 'barlow700' },
  { family: 'Space Mono', weight: 400, style: 'normal', key: 'spaceMono400' },
  { family: 'Space Mono', weight: 700, style: 'normal', key: 'spaceMono700' },
  { family: 'Space Mono', weight: 400, style: 'italic', key: 'spaceMono400i' },
];

let _switchboardFonts = null;  // loaded lazily from localStorage on first read

function _loadFontsFromCache() {
  if (_switchboardFonts !== null) return _switchboardFonts;
  try {
    const raw = localStorage.getItem(_SW_FONTS_LS_KEY);
    if (raw) _switchboardFonts = JSON.parse(raw);
  } catch (e) { /* localStorage unavailable */ }
  if (!_switchboardFonts) _switchboardFonts = {};
  return _switchboardFonts;
}

function _saveFontsToCache(fonts) {
  _switchboardFonts = fonts;
  try { localStorage.setItem(_SW_FONTS_LS_KEY, JSON.stringify(fonts)); }
  catch (e) { /* quota or disabled */ }
}

export function hasSwitchboardFonts() {
  const f = _loadFontsFromCache();
  return _SW_FONT_FACES.every(face => f[face.key]);
}

// Fetch Barlow + Space Mono from Google Fonts. Pulls the CSS, parses the
// per-subset @font-face blocks, picks the latin (U+0000-00FF) subset for
// each face, fetches the woff2 binaries, base64-encodes them, and caches
// the result in localStorage. Returns the populated fonts object.
export async function fetchSwitchboardFonts() {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap';
  const cssResp = await fetch(cssUrl, { headers: { 'Accept': 'text/css' } });
  if (!cssResp.ok) throw new Error('Failed to fetch font CSS: ' + cssResp.status);
  const css = await cssResp.text();

  // Parse all @font-face blocks, pick latin subset for each requested face.
  const blocks = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(m => m[1]);
  const urls = {};
  for (const block of blocks) {
    if (!/U\+0000-00FF/.test(block)) continue;  // skip non-latin subsets
    const family = (block.match(/font-family:\s*['"]([^'"]+)['"]/) || [])[1];
    const weight = parseInt((block.match(/font-weight:\s*(\d+)/) || [])[1], 10);
    const style = (block.match(/font-style:\s*(\w+)/) || [])[1] || 'normal';
    const url = (block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/) || [])[1];
    if (!family || !url) continue;
    const face = _SW_FONT_FACES.find(f => f.family === family && f.weight === weight && f.style === style);
    if (face) urls[face.key] = url;
  }

  const missing = _SW_FONT_FACES.filter(f => !urls[f.key]);
  if (missing.length) throw new Error('Missing font face URLs: ' + missing.map(f => `${f.family} ${f.weight}${f.style === 'italic' ? 'i' : ''}`).join(', '));

  // Fetch each woff2, base64-encode.
  const fonts = {};
  for (const face of _SW_FONT_FACES) {
    const r = await fetch(urls[face.key]);
    if (!r.ok) throw new Error('Failed to fetch ' + face.family + ' ' + face.weight + ': ' + r.status);
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    fonts[face.key] = btoa(bin);
  }
  _saveFontsToCache(fonts);
  return fonts;
}

function buildFontEmbedBlock() {
  const f = _loadFontsFromCache();
  if (!f || !Object.keys(f).length) return { style: '', license: '' };
  const faces = _SW_FONT_FACES
    .filter(face => f[face.key])
    .map(face => `@font-face{font-family:'${face.family}';font-weight:${face.weight};font-style:${face.style};font-display:swap;src:url(data:font/woff2;base64,${f[face.key]}) format('woff2');}`)
    .join('\n');
  if (!faces) return { style: '', license: '' };
  return {
    style: `<style id="auditable-fonts">\n${faces}\n</style>`,
    license: __SWITCHBOARD_OFL__
      ? `<!--AUDITABLE-FONTS-LICENSE\n${__SWITCHBOARD_OFL__.trim()}\nAUDITABLE-FONTS-LICENSE-->`
      : '',
  };
}

// (Legacy sync surfaces — initLiveSync, syncData, syncDataDebounced,
// syncSettings, syncModules, syncFs — removed in spec E. Persistence is
// write-on-save-only via the Persister; dirty notifications flow through
// the `notebook:dirty` hook bus event.)

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

  const cellData = serializeCells(S.cells);

  // get the runtime and styles from current document (two style tags since CSS split)
  const appStyleEl = document.querySelector('#auditable-app-css');
  const editorStyleEl = document.querySelector('#auditable-editor-css');
  const appStyles = appStyleEl ? appStyleEl.textContent : '';
  const editorStyles = editorStyleEl ? editorStyleEl.textContent : '';
  // fallback: single #auditable-css for older builds
  const fallbackStyleEl = document.querySelector('#auditable-css');
  const styles = fallbackStyleEl ? fallbackStyleEl.textContent : (appStyles + '\n' + editorStyles);

  // get the script — compress runtime by default for smaller saved notebooks
  // Find the runtime <script>, not the inline data-theme-init helper in <head>.
  const scriptEl = document.querySelector('script:not([data-theme-init])');
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
  const settingsPanHTML = settingsPanEl.outerHTML.replace(/display:\s*block;?/, '');
  // FS panel — reset to empty state
  const fsPanEl = document.getElementById('fsPanel');
  let fsPanHTML = '';
  if (fsPanEl) {
    const clone = fsPanEl.cloneNode(true);
    clone.style.display = '';
    const body = clone.querySelector('#fsPanelBody');
    if (body) body.innerHTML = '';
    const breadcrumb = clone.querySelector('#fsBreadcrumb');
    if (breadcrumb) breadcrumb.innerHTML = '';
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
  const lockScreenHTML = captureOverlay('lockScreen');

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
  // reset code combo tray
  const codeCombo = toolbarEl.querySelector('#toolbarCodeCombo');
  if (codeCombo) {
    const codeTray = codeCombo.querySelector('.code-tray');
    if (codeTray) { codeTray.classList.remove('open'); codeTray.innerHTML = ''; }
    const codeCaret = codeCombo.querySelector('.code-caret');
    if (codeCaret) codeCaret.style.display = 'none';
    const codeBtn = codeCombo.querySelector('.toolbar-add');
    if (codeBtn) codeBtn.textContent = '+ js';
  }
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
  const themeAttr = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  // optional embedded fonts (per-notebook setting; data lives in __SWITCHBOARD_FONTS__)
  const fontEmbed = getSettings().embedFonts ? buildFontEmbedBlock() : { style: '', license: '' };

  // data blocks: VFS-unified single block (AUDITABLE-VFS or AUDITABLE-CRYPTO).
  // Persistence flow per spec_inbox/shipped/auditable-persistence-spec.md.
  const effectiveTitle = cryptoIsEncrypted() ? 'Encrypted' : esc(title);
  let dataBlocks;
  {
    const vfs = window._notebookVFS;
    if (vfs) {
      // 1. Sync runtime state (cells, settings, modules) → VFS files
      await flushPendingDirty(vfs, S, getSettings(), title);

      // 2. Walk persistent mounts → JSON dump
      const dump = await serializeVfs(vfs);

      if (cryptoIsEncrypted()) {
        const block = await cryptoBuildBlock(dump);
        dataBlocks = '<!-- encrypted notebook data: passphrase required to access cells, settings, modules, files -->\n<!--AUDITABLE-CRYPTO\n' + JSON.stringify(block) + '\nAUDITABLE-CRYPTO-->';
      } else {
        dataBlocks = '<!-- auditable notebook data: VFS dump (persistent mounts only) -->\n<!--AUDITABLE-VFS\n' + JSON.stringify(dump) + '\nAUDITABLE-VFS-->';
      }
    } else {
      // Fallback path (no VFS available — shouldn't happen in browser builds)
      dataBlocks = '<!--AUDITABLE-VFS\n{}\nAUDITABLE-VFS-->';
    }
  }

  return `<!DOCTYPE html>
${fontEmbed.license ? fontEmbed.license + '\n' : ''}<html lang="en" data-theme="${themeAttr}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable \u2014 ${effectiveTitle}</title>
${fontEmbed.style ? fontEmbed.style + '\n' : ''}${styleBlock}
</head>
<body>

${helpHTML}

${settingsOvHTML}
${settingsPanHTML}

${fsPanHTML}

${mcpPanHTML}

${lockScreenHTML}

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

  // Works bridge: send serialized HTML to parent shell instead of downloading
  if (window.__WORKS_BRIDGE__) {
    window.parent.postMessage({ type: 'works:serialized', payload: { html } }, '*');
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
<html lang="en" data-theme="dark">
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

export const esc = _esc;

export function exportAsTxt() {
  if (cryptoIsLocked()) { setMsg('unlock first', 'err'); return; }
  const title = $('#docTitle').value || 'untitled';
  const txt = buildTxtExport({
    title,
    cells: serializeCells(S.cells),
    settings: getSettings(),
    moduleUrls: Object.keys(window._installedModules || {}),
  });

  // download
  if (window.__WORKS_BRIDGE__) {
    window.parent.postMessage({ type: 'works:download', payload: { data: txt, filename: title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt', mime: 'text/plain' } }, '*');
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

export async function loadFromEmbed() {
  const raw = document.body.innerHTML;
  const vfs = window._notebookVFS;

  // encrypted notebook — skip normal loading, init.js handles it
  if (cryptoDetect(raw).found) return false;

  // Try new format (AUDITABLE-VFS); fall back to legacy four-block format.
  const vfsMatch = raw.match(/<!--AUDITABLE-VFS\n([\s\S]*?)\nAUDITABLE-VFS-->/);
  let dump = null;
  if (vfsMatch) {
    try { dump = JSON.parse(vfsMatch[1]); }
    catch (e) { console.error('Failed to parse AUDITABLE-VFS:', e); }
  } else if (isLegacyFormat(raw)) {
    if (vfs) await importLegacyFormat(vfs, raw, decodeModules);
  }

  if (dump && vfs) await hydrateVfs(vfs, dump);

  if (vfs) {
    const modules = await hydrateModulesFromVfs(vfs);
    if (Object.keys(modules).length > 0) window._installedModules = modules;
  }

  let parsed = null;
  if (vfs) {
    try {
      const txt = await vfs.readFile('/var/notebook.txt', 'text');
      parsed = parseNotebookTxt(txt);
      if (parsed.title) {
        const titleInput = document.getElementById('docTitle');
        if (titleInput) titleInput.value = parsed.title;
        document.title = 'Auditable — ' + parsed.title;
      }
      if (parsed.settings) applySettings(parsed.settings);
    } catch { /* fresh notebook */ }
  }

  const effectiveMode = resolveExecMode();
  const effectiveRun = resolveRunOnLoad();
  if (effectiveMode === 'manual') {
    S.autorun = false;
    const btn = document.getElementById('autorunBtn');
    const btnMobile = document.getElementById('autorunBtnMobile');
    if (btn) { btn.className = 'autorun-off'; btn.textContent = '‖'; btn.title = 'manual mode — only Run All or Ctrl+Enter'; }
    if (btnMobile) { btnMobile.className = 'autorun-off'; btnMobile.textContent = '‖'; }
    const sel = document.getElementById('setExecMode');
    if (sel) sel.value = 'manual';
  }

  if (parsed && parsed.cells && parsed.cells.length > 0) {
    const nb = document.getElementById('notebook');
    if (nb) nb.innerHTML = '';
    document.querySelectorAll('style[data-cell-id]').forEach(el => el.remove());

    for (const c of parsed.cells) {
      const cell = addCell(c.type, c.code);
      if (c.collapsed || isCollapsed(c.code)) { cell.el.classList.add('collapsed'); cell.collapsed = true; }
    }
    if (effectiveRun === 'yes' && getEditorViewSetting() !== 'yes' && S.cells.some(c => _ctIsExecutable(c.type))) {
      setTimeout(runAll, 50);
    }
    return true;
  }
  return false;
}

// ── EXPORT AS APP ──

export function exportAsApp(opts = {}) {
  const title = opts.title || $('#docTitle').value || 'untitled';
  const includeBase = opts.includeBaseStyles !== false;

  const cellData = serializeCells(S.cells);
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

  const appThemeAttr = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${appThemeAttr}">
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

  if (window.__WORKS_BRIDGE__) {
    window.parent.postMessage({ type: 'works:download', payload: { data: html, filename: title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.html', mime: 'text/html' } }, '*');
  } else {
    downloadHtml(html, title);
  }

  const kb = (html.length / 1024).toFixed(0);
  setMsg('exported app (' + kb + ' KB)', 'ok');
}

export async function showExportDialog() {
  if (cryptoIsLocked()) { setMsg('unlock first', 'err'); return; }
  const hasBare = S.cells.some(c => isBare(c.code));
  const defaultTitle = $('#docTitle').value || 'untitled';

  const result = await new Dialog({
    title: 'export as app',
    width: 420,
    render(body, ctx) {
      const titleLabel = document.createElement('label');
      titleLabel.append(document.createTextNode('title '));
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.spellcheck = false;
      titleInput.value = defaultTitle;
      titleLabel.appendChild(titleInput);

      const baseLabel = document.createElement('label');
      const baseCheck = document.createElement('input');
      baseCheck.type = 'checkbox';
      baseCheck.checked = !hasBare;
      baseLabel.append(baseCheck, document.createTextNode(' include base styles'));

      const actions = document.createElement('div');
      actions.className = 'export-actions';
      const exportBtn = document.createElement('button');
      exportBtn.className = 'accent';
      exportBtn.textContent = 'export';
      exportBtn.dataset.default = 'true';
      exportBtn.onclick = () => ctx.close({
        title: titleInput.value,
        includeBaseStyles: baseCheck.checked,
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'cancel';
      cancelBtn.onclick = () => ctx.close(null);
      actions.append(exportBtn, cancelBtn);

      body.append(titleLabel, baseLabel, actions);
    },
  }).show();

  if (result) exportAsApp(result);
}
