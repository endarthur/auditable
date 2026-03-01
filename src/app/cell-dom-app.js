// ── CELL DOM (app runtime — no editors, no headers) ──

export function createCellEl(type, id) {
  const div = document.createElement('div');
  div.className = 'cell';
  div.dataset.id = id;
  div.dataset.type = type;

  if (type === 'code') {
    div.innerHTML = '<div class="cell-widgets"></div><div class="cell-output"></div>';
  } else if (type === 'html') {
    div.innerHTML = '<div class="cell-html-view"></div><div class="cell-output"></div>';
  } else if (type === 'md') {
    div.innerHTML = '<div class="cell-md-view"></div>';
  } else if (type === 'css') {
    // css cells are invisible in app mode
  }

  return div;
}

export function cssSummary() { return ''; }
export function autoResize() {}
export function handleTab() {}
