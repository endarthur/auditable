import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { _ctIsExecutable } from './cell-types.js';
import { selectCell, editCell, addCellWithUndo } from './keyboard.js';
import * as hooks from './hooks.js';

// ── PREFERRED CODE TYPE ──

let _preferredCodeType = 'code';

export function getPreferredCodeType() {
  if (_preferredCodeType === 'code') return 'code';
  const h = window._cellTypes?.[_preferredCodeType];
  if (h && _ctIsExecutable(_preferredCodeType)) return _preferredCodeType;
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
  const execPlugins = Object.entries(window._cellTypes || {}).filter(([n, h]) => _ctIsExecutable(n));
  const pref = getPreferredCodeType();
  const prefLabel = pref === 'code' ? 'js' : (window._cellTypes?.[pref]?.label || pref);
  const aid = afterId !== null ? afterId : 'null';

  if (execPlugins.length === 0) {
    return `<button onclick="insertAt(${aid},'code')">+ js</button>`;
  }

  let trayItems = `<button onclick="setPreferredAndInsert(${aid},'code')">js</button>`;
  for (const [name, h] of execPlugins) {
    trayItems += `<button onclick="setPreferredAndInsert(${aid},'${name}')"${h.color ? ` style="color:${h.color}"` : ''}>${h.label || name}</button>`;
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

export function insertAt(afterId, type) {
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

export function updateToolbarCodeBtn() {
  const wrap = document.getElementById('toolbarCodeCombo');
  if (!wrap) return;
  const execPlugins = Object.entries(window._cellTypes || {}).filter(([n]) => _ctIsExecutable(n));
  const pref = getPreferredCodeType();
  const prefLabel = pref === 'code' ? 'js' : (window._cellTypes?.[pref]?.label || pref);

  const mainBtn = wrap.querySelector('.toolbar-add');
  if (mainBtn) {
    mainBtn.textContent = '+ ' + prefLabel;
    mainBtn.onclick = () => addCellWithUndo(pref, '', S.selectedId);
  }

  const caret = wrap.querySelector('.code-caret');
  if (caret) caret.style.display = execPlugins.length > 0 ? '' : 'none';

  const tray = wrap.querySelector('.code-tray');
  if (tray) {
    let html = `<button onclick="setPreferredCodeType('code');updateToolbarCodeBtn();addCellWithUndo('code','',S.selectedId);toggleCodeTray(this)">js</button>`;
    for (const [name, h] of execPlugins) {
      html += `<button onclick="setPreferredCodeType('${name}');updateToolbarCodeBtn();addCellWithUndo('${name}','',S.selectedId);toggleCodeTray(this)"${h.color ? ` style="color:${h.color}"` : ''}>${h.label || name}</button>`;
    }
    tray.innerHTML = html;
  }
}

export function updateMobileAddTray() {
  const tray = document.getElementById('mobileAddTray');
  if (!tray) return;
  const pref = getPreferredCodeType();
  const execPlugins = Object.entries(window._cellTypes || {}).filter(([n]) => _ctIsExecutable(n));

  let html = '';
  // preferred code type first
  const prefLabel = pref === 'code' ? 'js' : (window._cellTypes?.[pref]?.label || pref);
  html += `<button onclick="insertAt(S.selectedId,'${pref}');toggleAddTray()">+ ${prefLabel}</button>`;
  // other code types
  if (pref !== 'code') {
    html += `<button onclick="setPreferredCodeType('code');insertAt(S.selectedId,'code');toggleAddTray()">+ js</button>`;
  }
  for (const [name, h] of execPlugins) {
    if (name === pref) continue;
    html += `<button onclick="setPreferredCodeType('${name}');insertAt(S.selectedId,'${name}');toggleAddTray()"${h.color ? ` style="color:${h.color}"` : ''}>+ ${h.label || name}</button>`;
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
