import { S, $ } from '../js/state.js';
import { createCellEl, cssSummary } from './cell-dom-app.js';
import { isManual } from '../js/dag.js';
import { renderHtmlCell, renderMdCell } from '../js/exec.js';
import { renderMd } from '../js/markdown.js';

// ── CELL OPERATIONS (app runtime) ──

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

  // markdown: render content
  if (type === 'md' && code) {
    renderMdCell(cell);
  }

  // CSS cell: create <style> element in <head>
  if (type === 'css') {
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

  return cell;
}

export function deleteCell(id) {
  const idx = S.cells.findIndex(c => c.id === id);
  if (idx < 0) return;
  if (S.cells[idx]._invalidate) { S.cells[idx]._invalidate(); S.cells[idx]._invalidate = null; }
  if (S.cells[idx]._styleEl) {
    S.cells[idx]._styleEl.remove();
    S.cells[idx]._styleEl = null;
  }
  S.cells[idx].el.remove();
  S.cells.splice(idx, 1);
}

export function convertCell() {}
export function moveCell() {}
