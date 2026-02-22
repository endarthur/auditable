import { S, $, $$ } from './state.js';
import { addCell, deleteCell, convertCell } from './cell-ops.js';
import { runDAG, runAll, renderHtmlCell } from './exec.js';
import { toggleAutorun } from './editor.js';
import { toggleSettings, togglePresent, applyLineNumbers, getSettings } from './settings.js';
import { saveNotebook, savePackedNotebook, setSaveMode, toggleSaveTray } from './save.js';
import { setMsg } from './ui.js';
import { toggleComment, autoResize, cssSummary } from './cell-dom.js';
import { openFind, closeFind } from './find.js';

// ── KEYBOARD / SELECTION ──

export function addCellWithUndo(type, code, afterId, beforeId) {
  const cell = addCell(type, code, afterId, beforeId);
  S.trash.push({ action: 'add', id: cell.id });
  return cell;
}

export function deleteCellWithUndo(id) {
  const idx = S.cells.findIndex(c => c.id === id);
  if (idx < 0) return;
  const cell = S.cells[idx];
  const afterId = idx > 0 ? S.cells[idx - 1].id : null;
  S.trash.push({ action: 'delete', type: cell.type, code: cell.code, afterId });
  if (cell._styleEl) {
    cell._styleEl.remove();
    cell._styleEl = null;
  }
  cell.el.remove();
  S.cells.splice(idx, 1);
  if (S.cells.some(c => c.type === 'code' || c.type === 'html')) runAll();
  updateStatus();
  setMsg('deleted cell (z to undo)', 'ok');
}

export function undo() {
  if (!S.trash.length) { setMsg('nothing to undo', ''); return; }
  const entry = S.trash.pop();

  if (entry.action === 'add') {
    // undo add = delete the cell (without pushing to undo stack)
    const idx = S.cells.findIndex(c => c.id === entry.id);
    if (idx < 0) return;
    const cell = S.cells[idx];
    if (cell._styleEl) { cell._styleEl.remove(); cell._styleEl = null; }
    cell.el.remove();
    S.cells.splice(idx, 1);
    if (S.cells.some(c => c.type === 'code' || c.type === 'html')) runAll();
    updateStatus();
    setMsg('undid add', 'ok');
  } else {
    // undo delete = restore the cell
    const { type, code, afterId } = entry;
    const validAfter = afterId !== null && S.cells.find(c => c.id === afterId) ? afterId : null;
    const newCell = addCell(type, code, validAfter);
    selectCell(newCell.id);
    if ((type === 'code' || type === 'html') && S.cells.some(c => c.type === 'code' || c.type === 'html')) runAll();
    setMsg('restored cell', 'ok');
  }
}

export function selectCell(id, scroll) {
  // deselect previous
  $$('.cell.selected').forEach(el => el.classList.remove('selected'));
  S.selectedId = id;
  if (id === null) return;
  const cell = S.cells.find(c => c.id === id);
  if (cell) {
    cell.el.classList.add('selected');
    if (scroll) cell.el.scrollIntoView({ block: 'nearest' });
  }
}

function getEditingCell() {
  const active = document.activeElement;
  if (active && active.tagName === 'TEXTAREA') {
    const cellEl = active.closest('.cell');
    if (cellEl) {
      const id = parseInt(cellEl.dataset.id);
      return S.cells.find(c => c.id === id) || null;
    }
  }
  return null;
}

export function editCell(id) {
  const cell = S.cells.find(c => c.id === id);
  if (!cell) return;
  selectCell(id);

  if (cell.type === 'md') {
    // open md editor
    const view = cell.el.querySelector('.cell-md-view');
    const editWrap = cell.el.querySelector('.cell-md-edit');
    const ta = cell.el.querySelector('.cell-md-edit textarea');
    editWrap.style.display = '';
    view.style.display = 'none';
    ta.value = cell.code;
    ta.focus();
    autoResize({ target: ta });
  } else if (cell.type === 'css') {
    // open css editor
    const view = cell.el.querySelector('.cell-css-view');
    const editWrap = cell.el.querySelector('.cell-css-edit');
    const ta = cell.el.querySelector('.cell-css-edit textarea');
    editWrap.style.display = '';
    view.style.display = 'none';
    ta.value = cell.code;
    ta.focus();
    autoResize({ target: ta });
  } else if (cell.type === 'html') {
    // open html editor
    const view = cell.el.querySelector('.cell-html-view');
    const editWrap = cell.el.querySelector('.cell-html-edit');
    const ta = cell.el.querySelector('.cell-html-edit textarea');
    editWrap.style.display = '';
    view.style.display = 'none';
    ta.value = cell.code;
    ta.focus();
    autoResize({ target: ta });
  } else {
    cell.el.querySelector('textarea').focus();
  }
}

function exitEdit() {
  const active = document.activeElement;
  if (active && active.tagName === 'TEXTAREA') {
    active.blur();
  }
}

function runSelected() {
  if (S.selectedId === null && S.cells.length) selectCell(S.cells[0].id);
  const cell = S.cells.find(c => c.id === S.selectedId);
  if (!cell) return;
  if (cell.type === 'code') {
    cell.code = cell.el.querySelector('.cell-code textarea').value;
    runDAG([cell.id]);
  } else if (cell.type === 'html') {
    renderHtmlCell(cell);
  }
}

// ── MOBILE TRAY TOGGLES ──

function closeAllTrays() {
  document.querySelectorAll('.action-add-tray.open, .action-more-tray.open, .cell-type-picker.open, .cell-insert-picker.open').forEach(el => el.classList.remove('open'));
}

export function toggleToolbarMenu() {
  const menu = document.querySelector('.toolbar-overflow');
  if (!menu) return;
  menu.classList.toggle('open');
}

export function toggleAddTray() {
  const tray = document.querySelector('.action-add-tray');
  if (!tray) return;
  const wasOpen = tray.classList.contains('open');
  closeAllTrays();
  if (!wasOpen) tray.classList.add('open');
}

export function toggleMoreTray() {
  const tray = document.querySelector('.action-more-tray');
  if (!tray) return;
  const wasOpen = tray.classList.contains('open');
  closeAllTrays();
  if (!wasOpen) tray.classList.add('open');
}

export function showInsertPicker(id, dir) {
  closeAllTrays();
  const cell = S.cells.find(c => c.id === id);
  if (!cell) return;
  document.querySelectorAll('.cell-insert-picker').forEach(el => el.remove());
  const picker = document.createElement('div');
  picker.className = 'cell-insert-picker open';
  let afterId;
  if (dir === 'after') {
    afterId = id;
  } else {
    const idx = S.cells.findIndex(c => c.id === id);
    afterId = idx > 0 ? S.cells[idx - 1].id : null;
  }
  picker.innerHTML = ['code', 'md', 'css', 'html'].map(t =>
    `<button onclick="insertAt(${afterId !== null ? afterId : 'null'},'${t}');this.closest('.cell-insert-picker').remove()">${t}</button>`
  ).join('');
  const header = cell.el.querySelector('.cell-header');
  header.style.position = 'relative';
  picker.style.top = '100%';
  picker.style.left = dir === 'before' ? '0' : 'auto';
  picker.style.right = dir === 'after' ? '0' : 'auto';
  header.appendChild(picker);
}

export function toggleTypePicker(id) {
  closeAllTrays();
  const picker = document.querySelector(`.cell-type-picker[data-cell-id="${id}"]`);
  if (picker) picker.classList.toggle('open');
}

export function collapseAll() {
  S.cells.forEach(c => c.el.classList.add('collapsed'));
  setMsg('collapsed all', 'ok');
}

export function expandAll() {
  S.cells.forEach(c => c.el.classList.remove('collapsed'));
  setMsg('expanded all', 'ok');
}

export function newNotebook() {
  if (!confirm('Clear all cells?')) return;
  while (S.cells.length) {
    const cell = S.cells[0];
    if (cell._styleEl) { cell._styleEl.remove(); cell._styleEl = null; }
    cell.el.remove();
    S.cells.shift();
  }
  S.scope = {};
  S.selectedId = null;
  S.clipboard = null;
  S.trash = [];
  $('#docTitle').value = 'untitled';
  updateStatus();
  setMsg('new notebook', 'ok');
}

export function runSelectedCell() { runSelectedAndAdvance(); }

function runSelectedAndAdvance() {
  runSelected();
  if (S.selectedId === null) return;
  // respect goto target if set
  const gotoIdx = window._lastGotoTarget;
  if (gotoIdx != null && gotoIdx >= 0 && gotoIdx < S.cells.length) {
    editCell(S.cells[gotoIdx].id);
  } else {
    const idx = S.cells.findIndex(c => c.id === S.selectedId);
    if (idx < S.cells.length - 1) {
      editCell(S.cells[idx + 1].id);
    } else {
      const newCell = addCellWithUndo('code', '', S.selectedId);
      selectCell(newCell.id);
    }
  }
}

function navigateCell(dir) {
  if (!S.cells.length) return;
  if (S.selectedId === null) {
    selectCell(S.cells[0].id, true);
    return;
  }
  const idx = S.cells.findIndex(c => c.id === S.selectedId);
  const newIdx = idx + dir;
  if (newIdx >= 0 && newIdx < S.cells.length) {
    selectCell(S.cells[newIdx].id, true);
  }
}

document.addEventListener('keydown', (e) => {
  // find bar shortcuts (must be before edit/command branches)
  if ((e.key === 'f') && (e.ctrlKey || e.metaKey) && !e.altKey) {
    e.preventDefault(); openFind(false); return;
  }
  if ((e.key === 'h') && (e.ctrlKey || e.metaKey) && !e.altKey) {
    e.preventDefault(); openFind(true); return;
  }
  if (e.key === 'Escape' && S.findActive) {
    e.preventDefault(); closeFind(); return;
  }

  const editing = getEditingCell();

  if (editing) {
    // ── EDIT MODE ──
    if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleComment(document.activeElement);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      exitEdit();
      selectCell(editing.id);
      return;
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      editing.code = editing.el.querySelector('textarea').value;
      if (editing.type === 'code') runDAG([editing.id], true);
      return;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      editing.code = editing.el.querySelector('textarea').value;
      if (editing.type === 'code') runDAG([editing.id], true);
      // advance — respect goto target if set
      const gotoIdx = window._lastGotoTarget;
      if (gotoIdx != null && gotoIdx >= 0 && gotoIdx < S.cells.length) {
        editCell(S.cells[gotoIdx].id);
      } else {
        const idx = S.cells.findIndex(c => c.id === editing.id);
        if (idx < S.cells.length - 1) {
          editCell(S.cells[idx + 1].id);
        } else {
          const newCell = addCellWithUndo('code', '', editing.id);
          selectCell(newCell.id);
          editCell(newCell.id);
        }
      }
      return;
    }
  } else {
    // ── COMMAND MODE ──
    // ignore if typing in any input field (title, find bar, etc.)
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.id === 'docTitle')) return;

    // let browser shortcuts through (Ctrl+J downloads, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      navigateCell(-1);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      navigateCell(1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.selectedId !== null) editCell(S.selectedId);
      return;
    }
    if (e.key === 'a') {
      e.preventDefault();
      const newCell = addCellWithUndo('code', '', null, S.selectedId);
      selectCell(newCell.id);
      editCell(newCell.id);
      return;
    }
    if (e.key === 'b') {
      e.preventDefault();
      const newCell = addCellWithUndo('code', '', S.selectedId);
      selectCell(newCell.id);
      editCell(newCell.id);
      return;
    }
    if (e.key === 'd') {
      e.preventDefault();
      if (S.pendingD) {
        // dd — delete
        clearTimeout(S.pendingDTimer);
        S.pendingD = false;
        if (S.selectedId !== null) {
          const idx = S.cells.findIndex(c => c.id === S.selectedId);
          const nextId = idx < S.cells.length - 1 ? S.cells[idx + 1].id
                       : idx > 0 ? S.cells[idx - 1].id : null;
          deleteCellWithUndo(S.selectedId);
          if (nextId !== null) selectCell(nextId);
        }
      } else {
        S.pendingD = true;
        S.pendingDTimer = setTimeout(() => { S.pendingD = false; }, 600);
      }
      return;
    }
    if (e.key !== 'd' && S.pendingD) { S.pendingD = false; clearTimeout(S.pendingDTimer); }
    if (e.key === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.key === 'c' && S.selectedId !== null) {
      e.preventDefault();
      const cell = S.cells.find(c => c.id === S.selectedId);
      if (cell) S.clipboard = { type: cell.type, code: cell.code };
      setMsg('copied cell', 'ok');
      return;
    }
    if (e.key === 'v' && S.clipboard) {
      e.preventDefault();
      const newCell = addCellWithUndo(S.clipboard.type, S.clipboard.code, S.selectedId);
      selectCell(newCell.id);
      if (S.clipboard.type === 'code' && S.cells.some(c => c.type === 'code')) runAll();
      return;
    }
    if (e.key === 'x' && S.selectedId !== null) {
      // cut = copy + delete
      e.preventDefault();
      const cell = S.cells.find(c => c.id === S.selectedId);
      if (cell) S.clipboard = { type: cell.type, code: cell.code };
      const idx = S.cells.findIndex(c => c.id === S.selectedId);
      const nextId = idx < S.cells.length - 1 ? S.cells[idx + 1].id
                   : idx > 0 ? S.cells[idx - 1].id : null;
      deleteCellWithUndo(S.selectedId);
      if (nextId !== null) selectCell(nextId);
      setMsg('cut cell', 'ok');
      return;
    }
    if (e.key === 'h' && S.selectedId !== null) {
      e.preventDefault();
      const cell = S.cells.find(c => c.id === S.selectedId);
      if (cell) cell.el.classList.toggle('collapsed');
      return;
    }
    if (e.key === 'l') {
      e.preventDefault();
      const on = getSettings().lineNumbers === 'on';
      applyLineNumbers(!on);
      setMsg(on ? 'line numbers off' : 'line numbers on', 'ok');
      return;
    }
    if (e.key === 'p') {
      e.preventDefault();
      togglePresent();
      return;
    }
    if (e.key === 'm' && S.selectedId !== null) {
      e.preventDefault();
      convertCell(S.selectedId, 'md');
      return;
    }
    if (e.key === 'y' && S.selectedId !== null) {
      e.preventDefault();
      convertCell(S.selectedId, 'code');
      return;
    }
    if (e.key === 's' && S.selectedId !== null) {
      e.preventDefault();
      convertCell(S.selectedId, 'css');
      return;
    }
    if (e.key === 't' && S.selectedId !== null) {
      e.preventDefault();
      convertCell(S.selectedId, 'html');
      return;
    }
  }

  // global: F1 help overlay
  if (e.key === 'F1') {
    e.preventDefault();
    $('#helpOverlay').classList.toggle('visible');
    return;
  }

  // close presentation mode on Escape
  if (e.key === 'Escape' && document.body.classList.contains('presenting')) {
    togglePresent();
    e.stopImmediatePropagation();
    return;
  }

  // close settings on Escape if visible
  if (e.key === 'Escape' && $('#settingsOverlay').classList.contains('visible')) {
    toggleSettings();
    e.stopImmediatePropagation();
    return;
  }

  // close help on Escape if visible
  if (e.key === 'Escape' && $('#helpOverlay').classList.contains('visible')) {
    $('#helpOverlay').classList.remove('visible');
    e.stopImmediatePropagation();
    return;
  }

  // global: Ctrl+S / Cmd+S
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveNotebook();
  }
});

// click to dismiss help
$('#helpOverlay').addEventListener('click', (e) => {
  if (e.target === $('#helpOverlay')) $('#helpOverlay').classList.remove('visible');
});

// click to select + close trays
document.addEventListener('click', (e) => {
  // close action trays if clicking outside their wrapper (wrapper = parent div with tray + button)
  const addTray = document.querySelector('.action-add-tray');
  const moreTray = document.querySelector('.action-more-tray');
  if (addTray && addTray.classList.contains('open') && !addTray.parentElement.contains(e.target)) {
    addTray.classList.remove('open');
  }
  if (moreTray && moreTray.classList.contains('open') && !moreTray.parentElement.contains(e.target)) {
    moreTray.classList.remove('open');
  }
  // close cell type pickers if clicking outside
  if (!e.target.closest('.cell-type-picker') && !e.target.closest('.cell-type')) {
    document.querySelectorAll('.cell-type-picker.open').forEach(el => el.classList.remove('open'));
  }
  // close cell insert pickers if clicking outside
  if (!e.target.closest('.cell-insert-picker')) {
    document.querySelectorAll('.cell-insert-picker').forEach(el => el.remove());
  }
  // close toolbar overflow menu if clicking outside
  const tbOverflow = document.querySelector('.toolbar-overflow');
  if (tbOverflow && tbOverflow.classList.contains('open') && !tbOverflow.contains(e.target)) {
    tbOverflow.classList.remove('open');
  }
  // close save tray if clicking outside
  const saveTray = document.getElementById('saveTray');
  if (saveTray && saveTray.classList.contains('open') && !saveTray.parentElement.contains(e.target)) {
    saveTray.classList.remove('open');
  }

  const cellEl = e.target.closest('.cell');
  if (cellEl) {
    const id = parseInt(cellEl.dataset.id);
    selectCell(id);
  }
});

// late import to avoid circular dependency at module load time
import { updateStatus } from './ui.js';
