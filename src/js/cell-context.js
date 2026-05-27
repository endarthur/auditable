// Cell context factory.
//
// Builds the `ctx` object passed to each cell run — `ui`, `std`, `sr`, `load`,
// `install`, `installBinary`, `display`, `print`, `md`, `html`, `css`,
// `workshop`, `notebook`, `worker`, `workerPool`, `vfs`, etc. The bulk of
// each builtin lives in cell-builtins/*; this module wires them together
// and applies cell-init side effects (clearing output, setting up the
// invalidation promise, applying directive-based output classes/ids).

import { S } from './state.js';
import { parseOutputId, parseOutputClass } from './dag.js';
import { isHidden } from './dag.js';
import { taggedTemplate } from './engine.js';
import { std } from './stdlib.js';
import { python, zenOfPython } from './python.js';
import { fsRead } from './fs.js';
import { refreshTaggedLanguages } from './cm6.js';
import { signal, computed, effect, batch, h, each, render } from './sideact.js';
import * as hooks from './hooks.js';
// Late-resolved (cycle): exec.js → cell-context.js → exec.js. ESM handles
// this because runDAG is only called at widget-event time, not at module init.
import { runDAG } from './exec.js';

const _notifyDirty = () => hooks.emit('notebook:dirty');

import { makeUi } from './cell-builtins/ui.js';
import { makeFileIo } from './cell-builtins/file-io.js';
import { makeWorker, makeWorkerPool } from './cell-builtins/workers.js';
import { makeNotebookApi } from './cell-builtins/notebook-api.js';
import { makeWorkshop } from './cell-builtins/workshop.js';
import { makeModuleLoaders } from './cell-builtins/modules.js';
import { makeDialog } from './cell-builtins/dialog.js';
import { makeTerminal } from './cell-builtins/terminal.js';
import { makeTemplate } from './cell-builtins/template.js';

export function createCellContext(cell) {
  // fire invalidation promise from previous run (cleanup resources)
  if (cell._invalidate) { cell._invalidate(); cell._invalidate = null; }

  const outputEl = cell.el.querySelector('.cell-output');
  let widgetEl = cell.el.querySelector('.cell-widgets');
  // plugin cells don't have a widget container — create one if missing
  if (!widgetEl) {
    widgetEl = document.createElement('div');
    widgetEl.className = 'cell-widgets';
    outputEl.parentNode.insertBefore(widgetEl, outputEl);
  }

  // preserve canvases before clearing output (canvas() reuses by index)
  const prevCanvases = [...outputEl.querySelectorAll('canvas')];
  outputEl.textContent = '';
  outputEl.className = 'cell-output';
  const outClass = parseOutputClass(cell.code);
  if (outClass) outputEl.classList.add(...outClass.split(/\s+/));
  const outId = parseOutputId(cell.code);
  outputEl.id = outId || '';
  cell.el.classList.toggle('present-hidden', isHidden(cell.code));
  cell.error = null;

  // create invalidation promise for this run
  let invalidationResolve;
  const invalidation = new Promise(r => { invalidationResolve = r; });
  cell._invalidate = invalidationResolve;

  const usedWidgets = new Set();

  // input widget bookkeeping (shared by ui.* widget factories and HTML cell wireup)
  if (!cell._inputs) cell._inputs = {};
  if (!cell._callbacks) cell._callbacks = {};

  // Shared context surface that builtin factories close over.
  const ctx = {
    invalidation,
    outputEl,
    widgetEl,
    prevCanvases,
    usedWidgets,
  };

  // UI builtins — display, canvas, table, slider, dropdown, checkbox, textInput
  const uiCore = makeUi(cell, ctx, runDAG);
  const display = uiCore.display;
  const displayHtml = uiCore.displayHtml;

  // Keep `display` reachable from later factories (used by modules.js for
  // install-progress messages) without re-exposing the whole uiCore.
  ctx.display = display;

  // File I/O — download, upload, drop
  const fileIo = makeFileIo(cell, ctx, runDAG);

  // Module loading — load, install, installBinary
  const modules = makeModuleLoaders(cell, ctx, {
    std, python, zenOfPython, fsRead, refreshTaggedLanguages, notifyDirty: _notifyDirty,
  });

  // Worker / workerPool
  const worker = makeWorker(cell, ctx);
  const workerPool = makeWorkerPool(cell, ctx);

  // Workshop overlay (singleton DOM, persisted page state via cell._inputs)
  const workshop = makeWorkshop(cell, ctx);

  // Notebook API — programmatic notebook control (fs, shell, cells, …)
  const notebook = makeNotebookApi(cell, ctx, runDAG);

  // Modal dialogs — confirm/prompt/alert + custom render. Auto-dismiss
  // open dialogs on cell invalidation unless { persistent: true }.
  const dialogApi = makeDialog(cell, ctx);

  // Terminal — VT/ANSI emulator + DOM grid + input layer (per-cell mount).
  // Auto-disposed on cell re-run via invalidation.
  const terminal = makeTerminal(cell, ctx);

  // VFS-backed templating — {{path | filter args}} over notebook files.
  // Works both as a function (`await template('…')`) and as a tagged-template
  // literal (`await template`…``); the tagged form makes ${interpolations}
  // injection-safe.
  const template = makeTemplate(cell, ctx, runDAG);

  const ui = {
    display, print: display, html: displayHtml,
    canvas: uiCore.canvas, table: uiCore.table,
    slider: uiCore.slider, dropdown: uiCore.dropdown,
    checkbox: uiCore.checkbox, textInput: uiCore.textInput,
    download: fileIo.download, upload: fileIo.upload, drop: fileIo.drop,
    confirm: dialogApi.confirm, prompt: dialogApi.prompt,
    alert: dialogApi.alert, dialog: dialogApi.dialog,
    terminal,
  };

  // Tagged template builtins
  const md = taggedTemplate('md');
  const html = taggedTemplate('html');
  const css = taggedTemplate('css');

  const sr = { signal, computed, effect, batch, h, each, render };
  const vfs = window._notebookVFS || undefined;

  // Compose final ctx surface (matches the legacy shape).
  Object.assign(ctx, {
    ui, std, sr,
    load: modules.load, install: modules.install, installBinary: modules.installBinary,
    display, print: display,
    md, html, css, template,
    workshop, notebook, worker, workerPool, vfs,
  });

  // Run cell-context hooks (e.g. sideact's sr.state persistence)
  for (const hook of (window._cellContextHooks || [])) hook.setup(cell, ctx);

  return ctx;
}
