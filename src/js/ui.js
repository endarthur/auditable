import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable, listAvailableLanguages, getDeclaredLanguage } from './cell-types.js';
import { selectCell, editCell, addCellWithUndo } from './keyboard.js';
import * as hooks from './hooks.js';

// ── PREFERRED CODE TYPE ──

let _preferredCodeType = 'code';

export function getPreferredCodeType() {
  if (_preferredCodeType === 'code') return 'code';
  const h = window._cellTypes?.[_preferredCodeType];
  if (h && _ctIsExecutable(_preferredCodeType)) return _preferredCodeType;
  // An installed-but-not-yet-loaded language (declared, cold) is a valid
  // preferred type — it activates on insert (ensureLanguageLoaded).
  if (getDeclaredLanguage(_preferredCodeType)) return _preferredCodeType;
  return 'code';
}

export function getRawPreferredCodeType() {
  return _preferredCodeType;
}

export function setPreferredCodeType(type) {
  _preferredCodeType = type;
  hooks.emit("notebook:dirty");
}

export function setPreferredAndInsert(afterId, type) {
  _preferredCodeType = type;
  // close any open code tray
  document.querySelectorAll('.code-tray.open').forEach(el => el.classList.remove('open'));
  insertAt(afterId, type);
}

export function toggleCodeTray(el) {
  const tray = el.closest('.code-split')?.querySelector('.code-tray')
    || el.closest('.insert-btns')?.querySelector('.code-tray');
  if (tray) tray.classList.toggle('open');
}

// ── STATUS ──

function estimateContentSize() {
  let modules = 0;
  for (const v of Object.values(window._installedModules || {})) {
    modules += typeof v === 'string' ? v.length : (v.source?.length || 0);
  }
  const cells = JSON.stringify(S.cells.map(c => ({ type: c.type, code: c.code }))).length;
  return modules + cells;
}

function estimateFileSize() {
  const style = document.querySelector('style')?.textContent.length || 0;
  const script = document.querySelector('script')?.textContent.length || 0;
  return style + script + estimateContentSize() + 2000; // ~2KB HTML boilerplate
}

export function updateStatus() {
  const counts = { code: 0, md: 0, css: 0, html: 0 };
  for (const c of S.cells) {
    if (counts[c.type] !== undefined) counts[c.type]++;
    else {
      if (!counts[c.type]) counts[c.type] = 0;
      counts[c.type]++;
    }
  }
  const parts = [];
  for (const [t, n] of Object.entries(counts)) if (n > 0) parts.push(`${n} ${t === 'code' ? 'js' : t}`);
  const statusText = parts.join(' \u00b7 ') || '0 cells';
  const totalBytes = estimateFileSize();
  const contentBytes = estimateContentSize();
  const useContent = window._sizeCompareRef === 'content';
  const displayBytes = useContent ? contentBytes : totalBytes;
  const sizeKB = displayBytes >= 1024 ? Math.round(displayBytes / 1024) : 1;
  const sizeText = '~' + sizeKB + ' KB' + (useContent ? ' content' : '');
  $('#statusCells').textContent = statusText;
  const compare = typeof sizeCompare === 'function' ? sizeCompare(displayBytes) : '';
  let fsText = '';
  if (window._notebookFS?.size > 0) {
    let fsBytes = 0;
    for (const e of window._notebookFS.values()) fsBytes += e.size;
    fsText = ' \u00b7 fs: ' + (fsBytes >= 1024 * 1024 ? (fsBytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(fsBytes / 1024)) + ' KB');
  }
  const sizeEl = document.getElementById('statusSize');
  if (sizeEl) sizeEl.textContent = (compare ? sizeText + ' \u00b7 ' + compare : sizeText) + fsText + ' \u00b7 ';
  // mirror to toolbar for mobile
  const toolbarStatus = document.getElementById('toolbarStatus');
  if (toolbarStatus) toolbarStatus.textContent = (compare || sizeText) + ' \u00b7 ' + statusText;
  updateInsertBars();
}

function buildCodeCombo(afterId) {
  // Languages = loaded executable cell types + declared-but-installed packs
  // (the latter cold-load on insert). 'code' (js) is the always-present default,
  // rendered separately below.
  const langs = listAvailableLanguages().filter(l => l.cellType !== 'code');
  const pref = getPreferredCodeType();
  const prefLabel = pref === 'code' ? 'js'
    : (window._cellTypes?.[pref]?.label || getDeclaredLanguage(pref)?.label || pref);
  const aid = afterId !== null ? afterId : 'null';

  if (langs.length === 0) {
    return `<button onclick="insertAt(${aid},'code')">+ js</button>`;
  }

  let trayItems = `<button onclick="setPreferredAndInsert(${aid},'code')">js</button>`;
  for (const l of langs) {
    const color = window._cellTypes?.[l.cellType]?.color;
    trayItems += `<button onclick="setPreferredAndInsert(${aid},'${l.cellType}')"${color ? ` style="color:${color}"` : ''}>${l.label}</button>`;
  }

  return `<span class="code-split"><button onclick="insertAt(${aid},'${pref}')">+ ${prefLabel}</button><button class="code-caret" onclick="toggleCodeTray(this)">\u25be</button><div class="code-tray">${trayItems}</div></span>`;
}

export function updateInsertBars() {
  const nb = $('#notebook');
  // remove existing insert bars
  nb.querySelectorAll('.insert-bar').forEach(b => b.remove());

  // add one before first cell and between each pair
  for (let i = 0; i <= S.cells.length; i++) {
    const bar = document.createElement('div');
    bar.className = 'insert-bar';
    const afterId = i > 0 ? S.cells[i - 1].id : null;
    // non-executable plugins get their own buttons (e.g. language tags without execute)
    const nonExecPlugins = Object.entries(window._cellTypes || {}).filter(([n, h]) => !_ctIsExecutable(n));
    const extraBtns = nonExecPlugins.map(([name, h]) =>
      `<button onclick="insertAt(${afterId},'${name}')"${h.color ? ` style="color:${h.color}"` : ''}>+ ${h.label || name}</button>`
    ).join('');
    bar.innerHTML = `<div class="insert-btns">
      ${buildCodeCombo(afterId)}
      <button onclick="insertAt(${afterId},'md')">+ md</button>
      <button onclick="insertAt(${afterId},'css')">+ css</button>
      <button onclick="insertAt(${afterId},'html')">+ html</button>
      ${extraBtns}
    </div>`;
    if (i < S.cells.length) {
      S.cells[i].el.before(bar);
    } else {
      nb.appendChild(bar);
    }
  }
  updateToolbarCodeBtn();
  updateMobileAddTray();
}

export async function insertAt(afterId, type) {
  // Cold→hot: picking an installed-but-unloaded declared language activates its
  // pack first, so the cell is born in its real editor/runtime (no fallback
  // flash). Seamless — the load is from _installedModules, not the network.
  if (type && type !== 'code' && !_ctIsExecutable(type)
      && getDeclaredLanguage(type) && window._ensureLanguageLoaded) {
    try { await window._ensureLanguageLoaded(type); } catch { /* falls back to a fallback cell */ }
  }
  let cell;
  if (afterId === null && S.cells.length > 0) {
    // insert before first cell
    cell = addCellWithUndo(type, '', null, S.cells[0].id);
  } else {
    cell = addCellWithUndo(type, '', afterId);
  }
  selectCell(cell.id);
  editCell(cell.id);
}

// Add a cell at the selection, cold-loading a declared-but-unloaded language
// first so the cell is born in its real editor/runtime (no fallback flash).
export async function addLangCell(type) {
  if (type && type !== 'code' && !_ctIsExecutable(type)
      && getDeclaredLanguage(type) && window._ensureLanguageLoaded) {
    try { await window._ensureLanguageLoaded(type); } catch { /* fallback cell */ }
  }
  addCellWithUndo(type, '', S.selectedId);
}

// Toolbar-tray pick: set preferred, refresh the button, add a cell, close tray.
export async function pickLang(type, btn) {
  setPreferredCodeType(type);
  updateToolbarCodeBtn();
  await addLangCell(type);
  if (btn) toggleCodeTray(btn);
}

export function updateToolbarCodeBtn() {
  const wrap = document.getElementById('toolbarCodeCombo');
  if (!wrap) return;
  const langs = listAvailableLanguages().filter(l => l.cellType !== 'code');
  const pref = getPreferredCodeType();
  const prefLabel = pref === 'code' ? 'js'
    : (window._cellTypes?.[pref]?.label || getDeclaredLanguage(pref)?.label || pref);

  const mainBtn = wrap.querySelector('.toolbar-add');
  if (mainBtn) {
    mainBtn.textContent = '+ ' + prefLabel;
    mainBtn.onclick = () => addLangCell(pref);
  }

  const caret = wrap.querySelector('.code-caret');
  if (caret) caret.style.display = langs.length > 0 ? '' : 'none';

  const tray = wrap.querySelector('.code-tray');
  if (tray) {
    let html = `<button onclick="pickLang('code',this)">js</button>`;
    for (const l of langs) {
      const color = window._cellTypes?.[l.cellType]?.color;
      html += `<button onclick="pickLang('${l.cellType}',this)"${color ? ` style="color:${color}"` : ''}>${l.label}</button>`;
    }
    tray.innerHTML = html;
  }
}

export function updateMobileAddTray() {
  const tray = document.getElementById('mobileAddTray');
  if (!tray) return;
  const pref = getPreferredCodeType();
  const langs = listAvailableLanguages().filter(l => l.cellType !== 'code');

  let html = '';
  // preferred code type first (insertAt cold-loads a declared language)
  const prefLabel = pref === 'code' ? 'js'
    : (window._cellTypes?.[pref]?.label || getDeclaredLanguage(pref)?.label || pref);
  html += `<button onclick="insertAt(S.selectedId,'${pref}');toggleAddTray()">+ ${prefLabel}</button>`;
  // other code types
  if (pref !== 'code') {
    html += `<button onclick="setPreferredCodeType('code');insertAt(S.selectedId,'code');toggleAddTray()">+ js</button>`;
  }
  for (const l of langs) {
    if (l.cellType === pref) continue;
    const color = window._cellTypes?.[l.cellType]?.color;
    html += `<button onclick="setPreferredCodeType('${l.cellType}');insertAt(S.selectedId,'${l.cellType}');toggleAddTray()"${color ? ` style="color:${color}"` : ''}>+ ${l.label}</button>`;
  }
  // non-code types
  html += `<button onclick="insertAt(S.selectedId,'md');toggleAddTray()">+ md</button>`;
  html += `<button onclick="insertAt(S.selectedId,'css');toggleAddTray()">+ css</button>`;
  html += `<button onclick="insertAt(S.selectedId,'html');toggleAddTray()">+ html</button>`;
  tray.innerHTML = html;
}

export function setMsg(msg, cls = '') {
  const el = $('#statusMsg');
  // Never color-alone (WCAG 1.4.1): a severity glyph carries ok/warn/err even
  // when the hue is indistinguishable (CVD, light theme, bad lighting).
  const glyph = cls === 'ok' ? '✓ ' : cls === 'warn' ? '⚠ ' : cls === 'err' ? '✗ ' : '';
  el.textContent = glyph + msg;
  el.className = 'status-msg' + (cls ? ' ' + cls : '');
  if (cls) setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3000);
}
