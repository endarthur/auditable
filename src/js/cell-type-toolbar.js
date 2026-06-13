// The toolbar cell-type changer (#cellTypeSelect) — a Jupyter-style dropdown
// that reflects the SELECTED cell's type and converts it on change. Useful in
// standalone and (especially) as part of the slim cell toolbar a notebook
// surface shows inside Auditable Works.
//
// Subscribes to the `cell:selected` hook to stay in sync; the inline
// onchange (template.html) calls convertSelectedCellType. Plugin / tagged cell
// types (not one of the four builtins) are shown as a transient, non-selectable
// option so the dropdown never lies about the current cell.

import { S, $ } from './state.js';
import { convertCell } from './cell-ops.js';
import { selectCell } from './keyboard.js';
import * as hooks from './hooks.js';

const BUILTIN_OPTS = [['code', 'code'], ['md', 'md'], ['css', 'css'], ['html', 'html']];

// (Re)build the dropdown options = the four builtins + every registered
// non-builtin (plugin / tagged) cell type — the SAME set Edit → Convert offers,
// so the dropdown is a full convert target list (it owns conversion once the
// menubar is hidden in works). `currentType` not in the registry is appended so
// the dropdown never lies about an unknown cell's type. Rebuilt per sync — cheap
// (a handful of options) and naturally picks up late-registered plugin types.
function buildOptions(sel, currentType) {
  const opts = BUILTIN_OPTS.slice();
  const reg = (typeof window !== 'undefined' && window._cellTypes) || {};
  for (const [name, h] of Object.entries(reg)) {
    if (h && h.capabilities && h.capabilities.builtin) continue;   // builtins already listed
    opts.push([name, (h && h.label) || name]);
  }
  if (currentType && !opts.some(([v]) => v === currentType)) opts.push([currentType, currentType]);
  sel.innerHTML = '';
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
}

// Reflect the selected cell's type in the dropdown (or disable it when nothing's
// selected).
function syncSelect(id) {
  const sel = $('#cellTypeSelect');
  if (!sel) return;
  const cell = id != null ? S.cells.find((c) => c.id === id) : null;
  if (!cell) { buildOptions(sel, null); sel.disabled = true; return; }
  sel.disabled = false;
  buildOptions(sel, cell.type);
  sel.value = cell.type;
}

// Convert the selected cell to `type` (from the dropdown). convertCell replaces
// the cell element, so re-select to restore the highlight — which re-emits
// cell:selected and re-syncs the dropdown to the new type.
export function convertSelectedCellType(type) {
  const id = S.selectedId;
  if (id == null) return;
  const cell = S.cells.find((c) => c.id === id);
  if (!cell || cell.type === type) return;
  convertCell(id, type);
  selectCell(id);
}

// The ▾ beside the toolbar + : a popup to ADD a cell of a chosen type below the
// selected one (the four builtins + registered plugin types). Anchored under the
// caret button; closes on outside click. Inserts via the same `insertAt` the
// per-cell insert pickers use.
export function toggleAddTypeMenu(btn) {
  const existing = document.getElementById('addTypeMenu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'addTypeMenu';
  menu.className = 'add-type-menu';
  const types = [['code', 'code'], ['md', 'md'], ['css', 'css'], ['html', 'html']];
  const reg = (typeof window !== 'undefined' && window._cellTypes) || {};
  for (const [name, h] of Object.entries(reg)) {
    if (h && h.capabilities && h.capabilities.builtin) continue;
    types.push([name, (h && h.label) || name]);
  }
  for (const [type, label] of types) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      window.insertAt?.(S.selectedId != null ? S.selectedId : null, type);
      menu.remove();
    });
    menu.appendChild(b);
  }
  const r = btn.getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top = (r.bottom + 2) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

if (typeof window !== 'undefined') {
  window.convertSelectedCellType = convertSelectedCellType;
  window.toggleAddTypeMenu = toggleAddTypeMenu;
}
hooks.on('cell:selected', syncSelect);
