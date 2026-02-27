import { S, $ } from './state.js';
import { createCellEl, autoResize, cssSummary } from './cell-dom.js';
import { isManual } from './dag.js';
import { runAll, renderHtmlCell, renderMdCell } from './exec.js';
import { updateStatus } from './ui.js';
import { selectCell } from './keyboard.js';
import { notifyDirty } from './editor.js';
import { getEditor } from './cm6.js';

// ── CELL OPERATIONS ──

export function addCell(type, code = '', afterId = null, beforeId = null) {
  const id = S.cellId++;
  const cell = {
    id, type, code,
    defines: new Set(),
    uses: new Set(),
    error: null,
    el: createCellEl(type, id, code)
  };

  const nb = $('#notebook');
  if (beforeId !== null) {
    const idx = S.cells.findIndex(c => c.id === beforeId);
    if (idx >= 0) {
      S.cells.splice(idx, 0, cell);
      S.cells[idx + 1].el.before(cell.el);
    } else {
      S.cells.push(cell);
      nb.appendChild(cell.el);
    }
  } else if (afterId !== null) {
    const idx = S.cells.findIndex(c => c.id === afterId);
    if (idx >= 0) {
      S.cells.splice(idx + 1, 0, cell);
      if (idx < S.cells.length - 2) {
        S.cells[idx + 2].el.before(cell.el);
      } else {
        nb.appendChild(cell.el);
      }
    } else {
      S.cells.push(cell);
      nb.appendChild(cell.el);
    }
  } else {
    S.cells.push(cell);
    nb.appendChild(cell.el);
  }

  // set code (CM6 editors receive initialCode via createCellEl; only md needs post-init setup)
  if (code) {
    if (type === 'md') {
      const ta = cell.el.querySelector('textarea');
      ta.value = code;
      autoResize({ target: ta });
      renderMdCell(cell);
    } else {
      if (type === 'code' && isManual(code)) cell.el.classList.add('manual');
    }
  }

  // CSS cell: create <style> element in <head>
  if (type === 'css') {
    const cssView = cell.el.querySelector('.cell-css-view');
    if (cssView && code) cssView.textContent = cssSummary(code);
    const styleEl = document.createElement('style');
    styleEl.dataset.cellId = id;
    styleEl.textContent = code;
    document.head.appendChild(styleEl);
    cell._styleEl = styleEl;
  }

  // HTML cell: render template
  if (type === 'html' && code) {
    renderHtmlCell(cell);
  }

  if (S.initialized) {
    if (type === 'md') {
      const ta = cell.el.querySelector('textarea');
      if (ta) ta.focus();
    } else {
      const editor = getEditor(id);
      if (editor) editor.focus();
    }
  }
  updateStatus();
  notifyDirty();
  return cell;
}

export function deleteCell(id) {
  const idx = S.cells.findIndex(c => c.id === id);
  if (idx < 0) return;
  // fire invalidation so cell resources (timers, etc.) clean up
  if (S.cells[idx]._invalidate) { S.cells[idx]._invalidate(); S.cells[idx]._invalidate = null; }
  // tear down workshop DOM if this cell had one
  if (S.cells[idx]._workshopCleanup) { S.cells[idx]._workshopCleanup(); S.cells[idx]._workshopCleanup = null; }
  if (S.cells[idx]._styleEl) {
    S.cells[idx]._styleEl.remove();
    S.cells[idx]._styleEl = null;
  }
  // destroy CM6 editor
  const editor = getEditor(id);
  if (editor) editor.destroy();
  S.cells[idx].el.remove();
  S.cells.splice(idx, 1);
  // re-run to clean scope
  if (S.cells.some(c => c.type === 'code' || c.type === 'html' || c.type === 'md')) runAll();
  updateStatus();
  notifyDirty();
}

export function convertCell(id, newType) {
  const cell = S.cells.find(c => c.id === id);
  if (!cell || cell.type === newType) return;

  const code = cell.code;

  // cleanup old type
  if (cell._styleEl) {
    cell._styleEl.remove();
    cell._styleEl = null;
  }
  // destroy old CM6 editor
  const oldEditor = getEditor(id);
  if (oldEditor) oldEditor.destroy();

  // create new cell element (CM6 editors receive code via initialCode)
  const newEl = createCellEl(newType, id, code);
  cell.el.replaceWith(newEl);
  cell.el = newEl;
  cell.type = newType;
  cell.code = code;

  // set code (only md needs post-init setup; CM6 editors already have the code)
  if (newType === 'md') {
    const ta = newEl.querySelector('textarea');
    ta.value = code;
    autoResize({ target: ta });
    renderMdCell(cell);
  }

  if (newType === 'css') {
    const cssView = newEl.querySelector('.cell-css-view');
    if (cssView && code) cssView.textContent = cssSummary(code);
    const styleEl = document.createElement('style');
    styleEl.dataset.cellId = id;
    styleEl.textContent = code;
    document.head.appendChild(styleEl);
    cell._styleEl = styleEl;
  }
  if (newType === 'html') {
    renderHtmlCell(cell);
  }

  selectCell(id);
  updateStatus();
  notifyDirty();
  if (S.cells.some(c => c.type === 'code' || c.type === 'html' || c.type === 'md')) runAll();
}

export function moveCell(id, dir) {
  const idx = S.cells.findIndex(c => c.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= S.cells.length) return;

  const [cell] = S.cells.splice(idx, 1);
  S.cells.splice(newIdx, 0, cell);

  // re-order DOM
  const nb = $('#notebook');
  nb.innerHTML = '';
  for (const c of S.cells) nb.appendChild(c.el);

  // re-order CSS <style> elements in <head> to match cell order
  for (const c of S.cells) {
    if (c._styleEl) document.head.appendChild(c._styleEl);
  }

  notifyDirty();
  if (S.cells.some(c => c.type === 'code' || c.type === 'html' || c.type === 'md')) runAll();
}
