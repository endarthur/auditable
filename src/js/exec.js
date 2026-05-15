import { S } from './state.js';
import { buildDAG, topoSort, parseCellName } from './dag.js';
import { _ctGetHandler, _ctRenderOutput, _ctIsExecutable } from './cell-types.js';
import { setMsg } from './ui.js';
import { INJECTED_NAMES, cellErrorLine, compileCellCode, cellCacheKey, executeDAG } from './engine.js';
import * as hooks from './hooks.js';
import { renderMdCell, renderHtmlCell } from './cell-render.js';
import { createCellContext } from './cell-context.js';

// ── EXECUTION ENGINE ──
//
// This file is now orchestration only. The cell builtins (ui, modules,
// workers, file-io, notebook, workshop, text-compression) live under
// src/js/cell-builtins/. Cell rendering (md / html templates) lives in
// cell-render.js. The cell context factory lives in cell-context.js.
//
// Scope model: each cell runs inside an AsyncFunction (or plain Function
// when AIR detects no `await`). Upstream variables become parameters.
// Pass-by-value for primitives — mutating `grid = next` in cell A doesn't
// propagate to cell B. Cells with mutable state should use %manual.
//
// Cell builtins (display, canvas, slider, load, install, etc.) are
// injected as parameters listed in INJECTED_NAMES — not in scope, not
// propagated to downstream cells.

export { cellErrorLine, renderMdCell, renderHtmlCell };

// ── AIR COMPILATION ──
// Tries V8-hinted JS emission via window._airEmit; null on failure
// triggers the fallback to the regex-driven compileCellCode in engine.js.

function _airCompile(cell, scopeKeys, defNames) {
  if (!window._airEmit || !cell._air) return null;
  if (window._airBypass || (typeof location !== 'undefined' && location.search.includes('airbypass=1'))) {
    return null;
  }
  try {
    const emittedJS = window._airEmit(cell._air, scopeKeys, INJECTED_NAMES, {
      hinted: true,
      cellId: cell.id,
      cellName: parseCellName(cell.code),
    });
    // DEBUG: dump emitted JS to console when ?airdebug=1.
    if (typeof location !== 'undefined' && location.search.includes('airdebug=1')) {
      console.log('[AIR] cell ' + cell.id + ' (' + (parseCellName(cell.code) || 'unnamed') +
        ') scope=[' + scopeKeys.join(',') + ']\n' + emittedJS);
    }
    const isAsync = window._airNeedsAsync ? window._airNeedsAsync(cell._air) : true;
    const Ctor = isAsync
      ? Object.getPrototypeOf(async function(){}).constructor
      : Function;
    return new Ctor(...scopeKeys, ...INJECTED_NAMES, emittedJS);
  } catch (e) {
    if (window._airDebug) console.warn('[AIR] emit fallback for cell', cell.id, ':', e.message);
    return null;
  }
}

// ── CELL EXECUTION ──

export async function execCell(cell) {
  const ctx = createCellContext(cell);
  const { ui, std, sr, load, install, installBinary, invalidation, display,
          md, html, css, workshop, notebook, worker, workerPool, vfs,
          usedWidgets, outputEl, widgetEl } = ctx;

  const scopeKeys = cell.uses ? [...cell.uses].filter(k => !INJECTED_NAMES.includes(k)).sort() : [];
  const defNames = cell.defines ? [...cell.defines].sort().join(', ') : '';
  const cacheKey = cellCacheKey(scopeKeys, defNames, cell.code);

  try {
    let fn;
    if (cell._cacheKey === cacheKey && cell._cachedFn) {
      fn = cell._cachedFn;
    } else {
      fn = _airCompile(cell, scopeKeys, defNames) ||
           compileCellCode(cell.code, scopeKeys, defNames, cell.id, parseCellName(cell.code));
      cell._cachedFn = fn;
      cell._cacheKey = cacheKey;
    }

    const scopeVals = scopeKeys.map(k => S.scope[k]);
    const injectedVals = [ui, std, sr, load, install, installBinary, invalidation, display, display,
      md, html, css, workshop, notebook, worker, workerPool, vfs];
    const result = await fn(...scopeVals, ...injectedVals);

    if (result && typeof result === 'object') cell._lastResult = result;

    cell.error = null;
    cell.el.classList.remove('stale', 'error');
    cell.el.classList.add('fresh');
    setTimeout(() => cell.el.classList.remove('fresh'), 800);

    // remove widgets no longer referenced by code
    for (const w of widgetEl.querySelectorAll('[data-widget-key]')) {
      if (!usedWidgets.has(w.dataset.widgetKey)) {
        delete cell._inputs[w.dataset.widgetKey];
        delete cell._callbacks[w.dataset.widgetKey];
        w.remove();
      }
    }

    return { defines: cell._lastResult || {}, error: null };
  } catch (e) {
    const line = cellErrorLine(e, cell.id);
    const lineInfo = line > 0 ? ` (line ${line})` : '';
    cell.error = e.message;
    outputEl.textContent = e.message + lineInfo;
    outputEl.className = 'cell-output error';
    cell.el.classList.remove('stale', 'fresh');
    cell.el.classList.add('error');
    return { defines: {}, error: e };
  }
}

// ── DAG ORCHESTRATION ──

let _dagGen = 0;

export async function runDAG(dirtyIds, force = false) {
  const gen = ++_dagGen;
  buildDAG();
  const isAutorun = S.autorun && !force;
  const runSet = new Set(topoSort(dirtyIds));

  hooks.emit('dag:start', { dirtyIds, force });

  S.scope = {};

  const result = await executeDAG(S.cells, dirtyIds, runSet, S.scope, {
    isAutorun,

    onExecCode: async (cell) => {
      hooks.emit('dag:cell:before-exec', cell);
      return execCell(cell);
    },

    onExecHtml: (cell) => renderHtmlCell(cell),
    onExecMd: (cell) => renderMdCell(cell),

    onExecPlugin: async (cell) => {
      const handler = _ctGetHandler(cell.type);
      if (!handler) return null;

      const upstream = {};
      if (cell.uses) {
        for (const name of cell.uses) {
          if (S.scope[name] !== undefined) upstream[name] = S.scope[name];
        }
      }
      cell._ctx = createCellContext(cell);

      try {
        const result = await handler.execute(cell.code, upstream, cell);
        if (result && result.defines) cell._lastResult = result.defines;
        if (result && result.output !== undefined) _ctRenderOutput(cell, result.output);
        cell.error = null;
        cell.el.classList.remove('stale', 'error');
        cell.el.classList.add('fresh');
        setTimeout(() => cell.el.classList.remove('fresh'), 800);

        if (cell._ctx.usedWidgets) {
          const widgetEl = cell._ctx.widgetEl;
          for (const w of widgetEl.querySelectorAll('[data-widget-key]')) {
            if (!cell._ctx.usedWidgets.has(w.dataset.widgetKey)) {
              delete cell._inputs[w.dataset.widgetKey];
              delete cell._callbacks[w.dataset.widgetKey];
              w.remove();
            }
          }
        }
        return { defines: cell._lastResult || {}, error: null };
      } catch (e) {
        cell.error = e.message;
        const outputEl = cell._ctx?.outputEl || cell.el.querySelector('.cell-output');
        if (outputEl) {
          outputEl.textContent = e.message;
          outputEl.className = 'cell-output error';
        }
        cell.el.classList.remove('stale', 'fresh');
        cell.el.classList.add('error');
        return { defines: {}, error: e };
      }
    },

    onCellStatus: (cell, status) => {
      if (status === 'stale') {
        cell.el.classList.remove('fresh');
        cell.el.classList.add('stale');
      } else if (status === 'blocked') {
        const outputEl = cell.el.querySelector('.cell-output');
        if (outputEl && !cell.error) {
          outputEl.textContent = 'blocked by upstream error';
          outputEl.className = 'cell-output error';
        }
        cell.el.classList.remove('stale', 'fresh');
        cell.el.classList.add('error');
      }
    },

    checkGeneration: () => _dagGen === gen,

    onAfterExec: (cell, i) => {
      hooks.emit('dag:cell:after-exec', cell, i);
      // Single-slot interceptor (used by goto for jump-target redirect).
      // Only consulted in manual mode — autoreruns shouldn't redirect.
      if (!isAutorun) {
        const interceptor = hooks.getDagCellInterceptor();
        if (interceptor) return interceptor(cell, i);
      }
      return -1;
    },
  });

  if (result.aborted) return;

  updateStatus();

  hooks.emit('dag:complete');
}

export async function runAll() {
  const ids = S.cells.filter(c =>
    c.type === 'md' || (_ctIsExecutable(c.type) && !c._fallback)
  ).map(c => c.id);
  if (ids.length === 0) return;
  await runDAG(ids, true);
  setMsg('ran all cells', 'ok');
}

// late import to avoid circular dependency at module load time
import { updateStatus } from './ui.js';
