// Auditable-side wiring for @gcu/ipynb. Adds File-menu actions:
//   "Open .ipynb…"   — file picker → import → replace current notebook
//   "Export .ipynb"  — current cells → .ipynb JSON download
// Plus a global drag-drop handler that routes a dropped .ipynb file
// through the same import path. The user is asked to confirm before
// the import clobbers the current notebook (same UX as File > New).

import { importNotebook, exportNotebook } from '#ipynb';
import { S, $ } from './state.js';
import { addCell, deleteCell } from './cell-ops.js';
import { getEditor } from './cm6.js';
import { setMsg } from './ui.js';
import { applyExecMode } from './settings.js';
import { confirm as dialogConfirm, alert as dialogAlert } from '#dialog';

// Clear the current notebook (cells + style elements + selection state)
// to make room for an imported set. Mirrors keyboard.js#newNotebook's
// teardown but skips the confirm — the caller already asked.
function clearCurrentNotebook() {
  while (S.cells.length) {
    const cell = S.cells[0];
    if (cell._styleEl) { cell._styleEl.remove(); cell._styleEl = null; }
    const editor = getEditor(cell.id);
    if (editor) editor.destroy();
    cell.el.remove();
    S.cells.shift();
  }
  S.scope = {};
  S.selectedId = null;
  S.clipboard = null;
  S.trash = [];
}

// Ensure the @gcu/adder extension is loaded and registered as a cell
// type. .ipynb imports produce 'adder' cells and they need the plugin's
// handler/tokenizer/executor wired up. In dev (running from the repo)
// this dynamic import resolves to ./ext/adder/index.js. In a saved
// notebook with adder already in _installedModules, the existing
// auto-load path will have registered it; this call is then a no-op
// because the cell-type is already in the registry.
async function ensureAdderLoaded() {
  if (window._cellTypes && window._cellTypes['adder']) return true;
  if (window._installedModules && window._installedModules['@gcu/adder']) {
    // Already installed (saved notebook); a cell-side `load("@gcu/adder")`
    // would normally trigger registration. Surface to the user that they
    // need to run something to wake it up — for now, the next `load(...)`
    // call from a cell will do it.
    return false;
  }
  try {
    await import('./ext/adder/index.js');
    return !!(window._cellTypes && window._cellTypes['adder']);
  } catch (e) {
    return false;
  }
}

// Import a .ipynb-shaped text into the current notebook. Asks to confirm
// the overwrite if the notebook isn't blank. Returns true on success.
export async function importIpynbText(text, { sourceName } = {}) {
  let result;
  try {
    result = importNotebook(text);
  } catch (e) {
    await dialogAlert(`Could not read .ipynb: ${e.message}`,
      { title: 'Import failed', width: 480 });
    return false;
  }

  // Confirm overwrite unless notebook is empty / default-shaped.
  const isBlank = S.cells.length <= 2 && S.cells.every(c => !c.code);
  if (!isBlank) {
    const ok = await dialogConfirm(
      `Replace the current notebook with ${result.cells.length} cell${result.cells.length === 1 ? '' : 's'} from ${sourceName || 'the imported .ipynb'}?`,
      { okLabel: 'replace', danger: true, title: 'Import .ipynb', width: 480 },
    );
    if (!ok) return false;
  }

  // Load @gcu/adder so Python cells get their tokenizer + executor
  // registered. Required: without it, imported cells appear as plain
  // text and never run.
  const hasPython = result.cells.some(c => c.type === 'adder');
  if (hasPython) {
    const ok = await ensureAdderLoaded();
    if (!ok) {
      await dialogAlert(
        '@gcu/adder is not loaded. Python cells will be added but will not ' +
        'execute or syntax-highlight until you install it (Settings → Modules).',
        { title: 'Python support unavailable', width: 480 },
      );
    }
  }

  clearCurrentNotebook();

  // Jupyter notebooks are written for manual execution — a user dragging a
  // slider in cell 4 doesn't expect cell 12 to re-run automatically. Switch
  // the imported notebook to manual mode unless the user has explicitly
  // opted in to reactive-on-import via Settings.
  const reactiveOnImport = $('#setIpynbReactive')?.value === 'reactive';
  if (!reactiveOnImport) applyExecMode('manual');

  for (const c of result.cells) {
    addCell(c.type, c.code);
  }

  // Title from filename if provided
  if (sourceName) {
    const titleInput = $('#docTitle');
    const baseName = sourceName.replace(/\.ipynb$/i, '');
    if (titleInput) titleInput.value = baseName;
    document.title = 'Auditable — ' + baseName;
  }

  // Summarize the import: cell count + rewrite count + any warnings.
  const parts = [`imported ${result.cells.length} cell${result.cells.length === 1 ? '' : 's'}`];
  if (result.rewrites.length) parts.push(`${result.rewrites.length} import${result.rewrites.length === 1 ? '' : 's'} rewritten`);
  if (result.warnings.length) parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`);
  setMsg(parts.join(' · '), 'ok');

  // Surface warnings in a dialog so they're not lost in the statusbar flash.
  if (result.warnings.length) {
    const w = result.warnings.slice(0, 10).map(s => '• ' + s).join('\n');
    const more = result.warnings.length > 10 ? `\n\n(… and ${result.warnings.length - 10} more)` : '';
    await dialogAlert(w + more, { title: 'Import notes', width: 480 });
  }

  return true;
}

// File-menu handler. Opens a file picker for .ipynb files.
export function openIpynbDialog() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.ipynb,application/x-ipynb+json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const text = await file.text();
    await importIpynbText(text, { sourceName: file.name });
  };
  input.click();
}

// File-menu handler. Exports the current notebook as a .ipynb download.
export function exportAsIpynb() {
  const title = $('#docTitle')?.value || 'untitled';
  let json;
  try {
    json = exportNotebook(S.cells.map(c => ({ type: c.type, code: c.code })), { title });
  } catch (e) {
    setMsg('export failed: ' + e.message, 'err');
    return;
  }

  const blob = new Blob([json], { type: 'application/x-ipynb+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.ipynb';
  a.click();
  URL.revokeObjectURL(url);
  setMsg('exported .ipynb', 'ok');
}

// Global drag-drop handler. Listens on document body for files; if any
// dropped file ends in .ipynb, routes to the import path and prevents
// the browser's default open-in-tab behavior.
export function installIpynbDragDrop() {
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    const types = e.dataTransfer.types;
    if (types && types.includes && types.includes('Files')) {
      e.preventDefault();
    }
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files) return;
    const files = [...e.dataTransfer.files];
    const ipynb = files.find(f => /\.ipynb$/i.test(f.name));
    if (!ipynb) return;
    e.preventDefault();
    const text = await ipynb.text();
    await importIpynbText(text, { sourceName: ipynb.name });
  });
}
