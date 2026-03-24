import { S, $ } from './state.js';
import { createCellEl, autoResize, cssSummary } from './cell-dom.js';
import { isManual } from './dag.js';
import { _ctGetHandler, _ctIsBuiltin } from './cell-types.js';
import { runAll, renderHtmlCell, renderMdCell } from './exec.js';
import { updateStatus } from './ui.js';
import { selectCell } from './keyboard.js';
import { notifyDirty } from './editor.js';
import { getEditor, mcpHighlightEffect } from './cm6.js';

// ── CELL CODE SETTER ──

function _changedLines(oldCode, newCode) {
  const oldL = (oldCode || '').split('\n');
  const newL = newCode.split('\n');
  const lines = [];
  const max = Math.max(oldL.length, newL.length);
  for (let i = 0; i < max; i++) {
    if (oldL[i] !== newL[i]) lines.push(i + 1); // 1-based
  }
  return lines;
}

export function setCellCode(cell, newCode) {
  const oldCode = cell.code || '';

  // Split view registers S._splitSetCode when active
  if (S._splitSetCode) {
    const idx = S.cells.indexOf(cell);
    if (idx >= 0 && S._splitSetCode(idx, newCode)) {
      // highlight changed lines in split editor
      if (S.splitEditor) {
        // find offset of this cell in the split doc to remap line numbers
        const doc = S.splitEditor.state.doc.toString();
        const docLines = doc.split('\n');
        let cellIdx = -1, cellStartLine = -1;
        for (let i = 0; i < docLines.length; i++) {
          if (/^\/\/\/\s+(\w+)/.test(docLines[i].trimEnd())) {
            cellIdx++;
            if (cellIdx === idx) { cellStartLine = i + 1; break; }
          }
        }
        if (cellStartLine >= 0) {
          const changed = _changedLines(oldCode, newCode);
          const mapped = changed.map(l => l + cellStartLine); // remap to split doc lines
          S.splitEditor.dispatch({ effects: mcpHighlightEffect.of(mapped) });
        }
      }
      return;
    }
  }
  const editor = getEditor(cell.id);
  if (editor) {
    editor.setCode(newCode);
    // highlight changed lines
    const changed = _changedLines(oldCode, newCode);
    if (changed.length) {
      editor.view.dispatch({ effects: mcpHighlightEffect.of(changed) });
    }
  } else if (cell._pluginEditor?.setCode) {
    cell._pluginEditor.setCode(newCode);
    cell.code = newCode;
  } else if (cell.type === 'md') {
    const ta = cell.el?.querySelector('textarea');
    if (ta) { ta.value = newCode; cell.code = newCode; renderMdCell(cell); }
  } else {
    // fallback plugin cells or unknown — update textarea if present
    const ta = cell.el?.querySelector('.plugin-textarea');
    if (ta) { ta.value = newCode; }
    cell.code = newCode;
  }
}

// ── CELL OPERATIONS ──

export function addCell(type, code = '', afterId = null, beforeId = null) {
  const id = S.cellId++;
  const cell = {
    id, type, code,
    collapsed: false,
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

  // mark fallback for unknown plugin types
  if (!_ctIsBuiltin(type) && !_ctGetHandler(type)) {
    cell._fallback = true;
  }

  // transfer plugin editor from DOM element
  if (cell.el._pluginEditor) {
    cell._pluginEditor = cell.el._pluginEditor;
    delete cell.el._pluginEditor;
  }

  // set code (CM6 editors receive initialCode via createCellEl; only md needs post-init setup)
  if (code) {
    if (type === 'md') {
      const ta = cell.el.querySelector('textarea');
      ta.value = code;
      autoResize({ target: ta });
      renderMdCell(cell);
    } else if (!_ctIsBuiltin(type)) {
      // plugin cell — textarea already has code from createCellEl
      const ta = cell.el.querySelector('.plugin-textarea');
      if (ta) autoResize({ target: ta });
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
    } else if (cell._pluginEditor?.focus) {
      cell._pluginEditor.focus();
    } else if (!_ctIsBuiltin(type)) {
      const ta = cell.el.querySelector('.plugin-textarea');
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
  // destroy plugin editor
  if (S.cells[idx]._pluginEditor?.destroy) {
    S.cells[idx]._pluginEditor.destroy();
    S.cells[idx]._pluginEditor = null;
  }
  // destroy CM6 editor
  const editor = getEditor(id);
  if (editor) editor.destroy();
  S.cells[idx].el.remove();
  S.cells.splice(idx, 1);
  // re-run to clean scope
  if (S.cells.some(c => c.type === 'code' || c.type === 'html' || c.type === 'md' || (_ctGetHandler(c.type) && !c._fallback))) runAll();
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
  // destroy old plugin editor
  if (cell._pluginEditor?.destroy) {
    cell._pluginEditor.destroy();
    cell._pluginEditor = null;
  }
  cell._fallback = false;
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

  // plugin type post-init
  if (!_ctIsBuiltin(newType)) {
    if (!_ctGetHandler(newType)) cell._fallback = true;
    if (newEl._pluginEditor) {
      cell._pluginEditor = newEl._pluginEditor;
      delete newEl._pluginEditor;
    }
    const ta = newEl.querySelector('.plugin-textarea');
    if (ta) autoResize({ target: ta });
  }

  selectCell(id);
  updateStatus();
  notifyDirty();
  if (S.cells.some(c => c.type === 'code' || c.type === 'html' || c.type === 'md' || (_ctGetHandler(c.type) && !c._fallback))) runAll();
}

export function moveCell(id, dir) {
  const idx = S.cells.findIndex(c => c.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= S.cells.length) return;

  const [cell] = S.cells.splice(idx, 1);
  S.cells.splice(newIdx, 0, cell);

  // re-order DOM — use insertBefore to move only the target cell,
  // preserving CM6 EditorView instances and their state
  const nb = $('#notebook');
  nb.insertBefore(cell.el, S.cells[newIdx + 1]?.el || null);

  // re-order CSS <style> elements in <head> to match cell order
  for (const c of S.cells) {
    if (c._styleEl) document.head.appendChild(c._styleEl);
  }

  notifyDirty();
  if (S.cells.some(c => c.type === 'code' || c.type === 'html' || c.type === 'md' || (_ctGetHandler(c.type) && !c._fallback))) runAll();
}
