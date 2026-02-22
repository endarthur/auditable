import { S, $ } from './state.js';
import { createCellEl, autoResize, cssSummary } from './cell-dom.js';
import { highlightCode, highlightCss } from './syntax.js';
import { isManual } from './dag.js';
import { runAll, renderHtmlCell } from './exec.js';
import { renderMd } from './markdown.js';
import { updateStatus } from './ui.js';
import { selectCell } from './keyboard.js';
import { notifyDirty } from './editor.js';

// ── CELL OPERATIONS ──

export function addCell(type, code = '', afterId = null, beforeId = null) {
  const id = S.cellId++;
  const cell = {
    id, type, code,
    defines: new Set(),
    uses: new Set(),
    error: null,
    el: createCellEl(type, id)
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

  // set code
  const ta = cell.el.querySelector('textarea');
  if (code) {
    ta.value = code;
    autoResize({ target: ta });
    if (type === 'code') {
      const hl = cell.el.querySelector('.highlight-layer');
      if (hl) highlightCode(ta, hl);
      if (isManual(code)) cell.el.classList.add('manual');
    }
    if (type === 'md') {
      cell.el.querySelector('.cell-md-view').innerHTML = renderMd(code);
    }
  }

  // CSS cell: create <style> element in <head>
  if (type === 'css') {
    const hl = cell.el.querySelector('.highlight-layer');
    if (hl && code) highlightCss(ta, hl);
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

  ta.focus();
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
  S.cells[idx].el.remove();
  S.cells.splice(idx, 1);
  // re-run to clean scope
  if (S.cells.some(c => c.type === 'code' || c.type === 'html')) runAll();
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

  // create new cell element
  const newEl = createCellEl(newType, id);
  cell.el.replaceWith(newEl);
  cell.el = newEl;
  cell.type = newType;

  // set code
  const ta = newEl.querySelector('textarea');
  ta.value = code;
  cell.code = code;
  autoResize({ target: ta });

  if (newType === 'code') {
    const hl = newEl.querySelector('.highlight-layer');
    if (hl) highlightCode(ta, hl);
  }
  if (newType === 'md') {
    newEl.querySelector('.cell-md-view').innerHTML = renderMd(code);
  }
  if (newType === 'css') {
    const hl = newEl.querySelector('.highlight-layer');
    if (hl) highlightCss(ta, hl);
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
  if (S.cells.some(c => c.type === 'code' || c.type === 'html')) runAll();
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
  if (S.cells.some(c => c.type === 'code' || c.type === 'html')) runAll();
}
