import { S } from './state.js';
import { parseCellName } from './dag.js';
import * as hooks from './hooks.js';

// ── GOTO ── @optional

function parseGoto(code) {
  const m = code.match(/^\s*\/\/\s*%goto\b\s*(.*)/m);
  if (!m) return null;
  return m[1].trim() || '';
}

const MAX_VISITS = 1000;
let visits = {};

hooks.on('dag:start', () => {
  visits = {};
  window._lastGotoTarget = null;
});

hooks.on('dag:cell:before-exec', (cell) => {
  const target = parseGoto(cell.code);
  if (target !== null) {
    S.scope.__goto = target;
    cell.defines.add('__goto');
  } else {
    delete S.scope.__goto;
  }
});

// Interceptor: returns the next-cell index to redirect to, or -1 to continue.
// Used by exec.js after each cell runs in manual (force) mode.
hooks.setDagCellInterceptor(function gotoInterceptor(cell, index) {
  const gotoTarget = S.scope.__goto;
  delete S.scope.__goto;
  window._lastGotoTarget = null;

  if (!gotoTarget) return -1;

  // resolve by cellName
  const targetIdx = S.cells.findIndex(c => parseCellName(c.code) === gotoTarget);
  if (targetIdx < 0) {
    const out = cell.el.querySelector('.cell-output');
    if (out) {
      out.appendChild(document.createTextNode('\ngoto: cell “' + gotoTarget + '” not found'));
      out.classList.add('error');
    }
    return -1;
  }

  // loop protection
  const key = index + ':' + targetIdx;
  visits[key] = (visits[key] || 0) + 1;
  if (visits[key] > MAX_VISITS) {
    const out = cell.el.querySelector('.cell-output');
    if (out) {
      out.appendChild(document.createTextNode('\ngoto: loop limit reached (' + MAX_VISITS + ' iterations)'));
      out.classList.add('error');
    }
    return -1;
  }

  window._lastGotoTarget = targetIdx;
  return targetIdx;
});
