import { S, $ } from './state.js';
import { addCell } from './cell-ops.js';
import { selectCell, editCell, addCellWithUndo } from './keyboard.js';

// ── STATUS ──

export function updateStatus() {
  const counts = { code: 0, md: 0, css: 0, html: 0 };
  for (const c of S.cells) if (counts[c.type] !== undefined) counts[c.type]++;
  const parts = [];
  for (const [t, n] of Object.entries(counts)) if (n > 0) parts.push(`${n} ${t}`);
  const statusText = parts.join(' \u00b7 ') || '0 cells';
  $('#statusCells').textContent = statusText;
  // mirror to toolbar for mobile
  const toolbarStatus = document.getElementById('toolbarStatus');
  if (toolbarStatus) toolbarStatus.textContent = statusText;
  updateInsertBars();
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
    bar.innerHTML = `<div class="insert-btns">
      <button onclick="insertAt(${afterId},'code')">+ code</button>
      <button onclick="insertAt(${afterId},'md')">+ md</button>
      <button onclick="insertAt(${afterId},'css')">+ css</button>
      <button onclick="insertAt(${afterId},'html')">+ html</button>
    </div>`;
    if (i < S.cells.length) {
      S.cells[i].el.before(bar);
    } else {
      nb.appendChild(bar);
    }
  }
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

export function setMsg(msg, cls = '') {
  const el = $('#statusMsg');
  el.textContent = msg;
  el.className = 'status-msg' + (cls ? ' ' + cls : '');
  if (cls) setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3000);
}
