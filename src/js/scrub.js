// scrub.js — scrubbable number literals (@optional)
//
// Alt+drag a numeric literal in any cell editor and it scrubs: each step
// rewrites the literal's span in the source and re-runs the cell + its
// dependents immediately (bypassing the edit debounce). The source text stays
// the single truth — a scrub IS an edit, just a faster way to type. Undo
// restores the pre-drag value in one step (drag dispatches skip history; the
// release replays original → final as one real change).

import { S } from './state.js';
import { getEditor } from './cm6.js';
import { buildDAG } from './dag.js';
import { runDAG } from './exec.js';
import { findNumberSpan, applySteps } from './scrub-core.js';

// ── interaction ──

const PX_PER_STEP = 5;

let _drag = null;   // { cellId, view, lineFrom, start, end, original, startX, lastText, shift }
let _tip = null;
let _runTimer = 0;

function _tipEl() {
  if (_tip) return _tip;
  _tip = document.createElement('div');
  _tip.style.cssText =
    'position:fixed;z-index:9999;pointer-events:none;padding:2px 8px;' +
    'font:12px var(--au-font-mono, monospace);color:var(--au-fg, #ddd);' +
    'background:var(--au-bg-raised, #222);border:1px solid var(--au-accent-action, #c89b3c);' +
    'border-radius:3px;display:none';
  document.body.appendChild(_tip);
  return _tip;
}

function _spanAt(view, clientX, clientY) {
  const pos = view.posAtCoords({ x: clientX, y: clientY });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  const span = findNumberSpan(line.text, pos - line.from);
  if (!span) return null;
  return { lineFrom: line.from, ...span };
}

function _editorFromEvent(e) {
  const container = e.target && e.target.closest ? e.target.closest('[data-cm-cell-id]') : null;
  if (!container) return null;
  const cellId = container.dataset.cmCellId;   // ids are strings ('c-<n>')
  const editor = getEditor(cellId);
  return editor ? { cellId, view: editor.view } : null;
}

function _dispatchSpan(text, addToHistory) {
  const { view, lineFrom, start, lastText } = _drag;
  const Tr = window.CM6 && window.CM6.Transaction;
  view.dispatch({
    changes: { from: lineFrom + start, to: lineFrom + start + lastText.length, insert: text },
    ...(Tr && !addToHistory ? { annotations: Tr.addToHistory.of(false) } : {}),
  });
  _drag.lastText = text;
}

function _runNow() {
  // the CM6 updateListener already synced cell.code and armed the 400 ms
  // debounce (onCodeEdit) — cancel it and run directly, force=true so a
  // %manual cell honors the explicit gesture
  clearTimeout(S.editTimer);
  if (!S.autorun) return;
  if (_runTimer) return;
  _runTimer = setTimeout(() => {
    _runTimer = 0;
    if (!_drag) return;
    buildDAG();
    runDAG([_drag.cellId], true);
  }, 60);
}

function _onMouseDown(e) {
  if (!e.altKey || e.button !== 0) return;
  if (document.body.classList.contains('presenting')) return;
  const hit = _editorFromEvent(e);
  if (!hit) return;
  const span = _spanAt(hit.view, e.clientX, e.clientY);
  if (!span) return;
  e.preventDefault();
  e.stopPropagation();
  _drag = { cellId: hit.cellId, view: hit.view, ...span, original: span.text, lastText: span.text, startX: e.clientX };
  document.body.style.cursor = 'ew-resize';
  const tip = _tipEl();
  tip.textContent = span.text;
  tip.style.display = 'block';
  tip.style.left = (e.clientX + 14) + 'px';
  tip.style.top = (e.clientY - 28) + 'px';
}

function _onMouseMove(e) {
  if (_drag) {
    const steps = Math.round((e.clientX - _drag.startX) / PX_PER_STEP);
    const next = applySteps(_drag.original, steps, e.shiftKey ? 10 : 1);
    if (next !== _drag.lastText) {
      _dispatchSpan(next, false);
      _runNow();
    }
    const tip = _tipEl();
    tip.textContent = next;
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY - 28) + 'px';
    e.preventDefault();
    return;
  }
  // hover affordance: ew-resize over a literal while Alt is held
  if (e.altKey) {
    const hit = _editorFromEvent(e);
    const over = hit && _spanAt(hit.view, e.clientX, e.clientY);
    document.body.style.cursor = over ? 'ew-resize' : '';
  } else if (document.body.style.cursor === 'ew-resize') {
    document.body.style.cursor = '';
  }
}

function _onMouseUp() {
  if (!_drag) return;
  const { original, lastText } = _drag;
  if (lastText !== original) {
    // one clean undo step: revert (no history), then original → final (history)
    _dispatchSpan(original, false);
    _dispatchSpan(lastText, true);
    clearTimeout(S.editTimer);
    if (S.autorun) { buildDAG(); runDAG([_drag.cellId], true); }
  }
  _drag = null;
  document.body.style.cursor = '';
  if (_tip) _tip.style.display = 'none';
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('mousedown', _onMouseDown, true);
  document.addEventListener('mousemove', _onMouseMove, true);
  document.addEventListener('mouseup', _onMouseUp, true);
}
