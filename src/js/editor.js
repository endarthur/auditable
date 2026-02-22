import { S, $ } from './state.js';
import { isManual } from './dag.js';
import { runDAG } from './exec.js';
import { setMsg } from './ui.js';

// ── EDITING ──

export function toggleAutorun() {
  S.autorun = !S.autorun;
  const btn = $('#autorunBtn');
  const btnMobile = document.getElementById('autorunBtnMobile');
  const cls = S.autorun ? 'autorun-on' : 'autorun-off';
  const text = S.autorun ? '\u25b6' : '\u2016';
  btn.textContent = text;
  btn.title = S.autorun ? 'reactive mode \u2014 cells auto-run on edit' : 'manual mode \u2014 only Run All or Ctrl+Enter';
  btn.className = cls;
  if (btnMobile) {
    btnMobile.textContent = text;
    btnMobile.className = cls;
  }
  const sel = $('#setExecMode');
  if (sel) sel.value = S.autorun ? 'reactive' : 'manual';
  setMsg(S.autorun ? 'autorun on' : 'autorun off', 'ok');
}

export function onCssEdit(id) {
  const cell = S.cells.find(c => c.id === id);
  if (!cell) return;
  cell.code = cell.el.querySelector('textarea').value;
  if (cell._styleEl) cell._styleEl.textContent = cell.code;
}

export function onHtmlEdit(id) {
  const cell = S.cells.find(c => c.id === id);
  if (!cell) return;
  cell.code = cell.el.querySelector('textarea').value;
  cell.el.classList.add('stale');

  if (S.autorun) {
    clearTimeout(S.editTimer);
    S.editTimer = setTimeout(() => runDAG([id], false), 400);
  }
}

export function onCodeEdit(id) {
  const cell = S.cells.find(c => c.id === id);
  if (!cell) return;
  const ta = cell.el.querySelector('textarea');
  cell.code = ta.value;

  // update manual state
  if (isManual(cell.code)) {
    cell.el.classList.add('manual');
  } else {
    cell.el.classList.remove('manual');
  }

  cell.el.classList.add('stale');

  if (S.autorun) {
    clearTimeout(S.editTimer);
    S.editTimer = setTimeout(() => runDAG([id], false), 400);
  }
}
