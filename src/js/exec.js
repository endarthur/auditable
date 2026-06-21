import { S } from './state.js';
import { buildDAG, topoSort, parseCellName } from './dag.js';
import { _ctGetHandler, _ctRenderOutput, _ctIsExecutable } from './cell-types.js';
import { setMsg } from './ui.js';
import { INJECTED_NAMES, cellErrorLine, compileCellCode, cellCacheKey, executeDAG } from './engine.js';
import * as hooks from './hooks.js';
import { renderMdCell, renderHtmlCell } from './cell-render.js';
import { createCellContext } from './cell-context.js';
import { loadInstalledModule } from './cell-builtins/modules.js';
import { refreshTaggedLanguages } from './cm6.js';

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
  // Internal bookkeeping not part of INJECTED_NAMES — destructured because
  // the catch block + post-run cleanup below reach for them directly.
  const { usedWidgets, outputEl, widgetEl } = ctx;

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
    // Build injected values directly from INJECTED_NAMES so the two can
    // never drift out of sync — adding a new builtin only needs the name
    // in engine.js's INJECTED_NAMES and a matching property on ctx (set
    // up by cell-context.js). Earlier shape kept a hardcoded parallel
    // array that silently shifted positional params when names were
    // appended.
    const injectedVals = INJECTED_NAMES.map((n) => ctx[n]);
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
    // '✗ ' marks error status without relying on the red color alone (WCAG 1.4.1).
    outputEl.textContent = '✗ ' + e.message + lineInfo;
    outputEl.className = 'cell-output error';
    cell.el.classList.remove('stale', 'fresh');
    cell.el.classList.add('error');
    return { defines: {}, error: e };
  }
}

// ── DAG ORCHESTRATION ──

let _dagGen = 0;

// Known language-pack mappings — cell type / tagged-language tag → npm spec.
// The runtime auto-loads these when it finds matching fallback cells, so a
// notebook with /// adder cells doesn't need a JS preamble that manually
// runs `await load("@gcu/adder")`. Extension authors that ship new
// languages can register here (the registration shape is a small bit of
// boilerplate per language — the spec doesn't ask for an extension to
// describe its own auto-load, since the host gets to choose what's bundled).
export const LANGUAGE_PACKS = {
  adder: '@gcu/adder',
  mpy:   '@gcu/adder',
  soft:  '@gcu/soft',
  stereonet: '@gcu/stereonet',
};

// Adder ↔ auditable module bridge. adder calls this (via the window hook below) when
// an `import <name>` misses its own resolvers, so `import plt` / `import sadpan` work
// offline with no bootstrap `load()` cell: we find the INSTALLED auditable extension
// that exports <name> and load it (which registers the export under <name>).
// Resolution order: the live alias map (filled as extensions register this session) →
// the persisted `adderExports` on installed-module entries (the pre-load path — from a
// saved notebook or an embedded edition, known before anything is loaded). Only ever
// loads from _installedModules; never touches the network.
export async function resolveAdderModule(name) {
  let url = window._auditableAdderAliases && window._auditableAdderAliases[name];
  if (!url && window._installedModules) {
    for (const [u, e] of Object.entries(window._installedModules)) {
      if (e && Array.isArray(e.adderExports) && e.adderExports.includes(name)) { url = u; break; }
    }
  }
  if (!url) return null;
  let mod;
  try { mod = await loadInstalledModule(url); } catch { return null; }
  // Prefer the extension's named export (registerExtension libs — plt, sadpan); fall
  // back to the loaded module itself for plain libs that don't registerExtension but are
  // declared importable via adderExports (e.g. the @atra/gslib namespace of sgsim/kb2d).
  return (window._auditableExtensions && window._auditableExtensions[name]) || mod || null;
}
if (typeof window !== 'undefined') window._auditableResolveModule = resolveAdderModule;

// Diagnostic log helper — emits to this frame's console AND the parent
// frame's console when running as a Works surface, so users don't have
// to dig into the per-iframe console context in DevTools.
function _diagLog(level, ...args) {
  const fn = console[level] || console.log;
  fn.call(console, ...args);
  // Best-effort cross-frame mirror. SecurityError when origins differ
  // (e.g. http vs file://) is swallowed — the main-frame log is the
  // bonus, the local log is the source of truth.
  try {
    if (window.parent && window.parent !== window) {
      const p = window.parent.console;
      if (p && typeof p[level] === 'function') p[level].call(p, '[notebook]', ...args);
    }
  } catch { /* cross-origin guard */ }
}

// Public wrapper — exposed so init.js can fire it once at notebook
// hydration time. Without this, cells of an extension-provided type
// render as fallback (no language-aware editor) on first open and
// only upgrade after the user clicks Run All. Calling this immediately
// after hydrateNotebook lets the cells boot in their proper editor
// from the first paint.
export async function autoLoadFromCells() {
  await _autoLoadLanguagePacks();
  await _autoLoadAdapters();
}

async function _autoLoadLanguagePacks() {
  const want = new Set();
  const fallbackTypes = new Set();
  for (const cell of S.cells) {
    // Fallback cell — type registered to a known pack? Auto-load if the
    // pack is actually installed (we only auto-load from _installedModules,
    // never from a network fetch — system-side loads shouldn't surprise
    // the user).
    if (cell._fallback) {
      fallbackTypes.add(cell.type);
      const pack = LANGUAGE_PACKS[cell.type];
      if (pack && !window._importCache?.[pack] && window._installedModules?.[pack]) {
        want.add(pack);
      }
    }
  }
  // Visibility: if there are fallback cells with KNOWN types but the
  // package isn't installed, log it. Helps users discover "I have adder
  // cells but no adder installed".
  for (const t of fallbackTypes) {
    const pack = LANGUAGE_PACKS[t];
    if (pack && !window._installedModules?.[pack]) {
      _diagLog('info', `[runtime] /// ${t} cell present but ${pack} is not installed — install it to enable.`);
    }
  }
  if (want.size === 0) return;
  // Serial loads — order doesn't matter for independence, but serializing
  // keeps refreshTaggedLanguages's CM6 reconfigure from racing across
  // multiple registrations in the same microtask.
  const langsBefore = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;
  for (const pack of want) {
    try {
      await loadInstalledModule(pack);
      _diagLog('info', `[runtime] auto-loaded language pack "${pack}"`);
    }
    catch (e) { _diagLog('warn', `[runtime] auto-load("${pack}") failed:`, e.message); }
  }
  const langsAfter = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;
  if (langsAfter > langsBefore) refreshTaggedLanguages();
}

// Auto-discover and load adapter bridges referenced by adder cells.
// Scans `from <name> import` statements; for each <name> that isn't
// already in _auditableExtensions, looks for an installed module with
// key */<name>/adder (e.g. @gcu/carotte/adder for `from carotte import`)
// and loads it. Same "installed-only, never network" rule as the
// language-pack loader. EXTENSION_SPEC §3.5 + §6.1.
async function _autoLoadAdapters() {
  const installed = window._installedModules || {};
  const keys = Object.keys(installed);
  const adapterSuffix = '/adder';
  const hasAdapter = (name) => keys.some(k => k.endsWith('/' + name + adapterSuffix));

  const wantNames = new Set();
  const fromNames = new Set();   // explicit `from X import` — worth a "missing adapter" hint
  for (const cell of S.cells) {
    if (cell.type !== 'adder' && cell.type !== 'mpy') continue;
    if (!cell.code) continue;
    let m;
    // `from <name> import …` — the canonical adapter trigger.
    const fromRe = /^\s*from\s+([a-zA-Z_]\w*)\s+import\b/gm;
    while ((m = fromRe.exec(cell.code)) !== null) { fromNames.add(m[1]); wantNames.add(m[1]); }
    // Plain `import x`, `import x as y`, `import a, b` — also triggers adapter preload so
    // `import natra as np` works with no bootstrap cell. Gated by hasAdapter() so plain
    // builtins (math, random, js, …) and adapter-less libs (sadpan, gslib) don't get
    // probed or logged — only names that actually ship a */<name>/adder bridge.
    const impRe = /^\s*import\s+(.+)$/gm;
    while ((m = impRe.exec(cell.code)) !== null) {
      for (const part of m[1].split(',')) {
        const nm = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[a-zA-Z_]\w*$/.test(nm) && hasAdapter(nm)) wantNames.add(nm);
      }
    }
  }
  if (wantNames.size === 0) return;

  const exts = window._auditableExtensions || {};

  for (const name of wantNames) {
    if (exts[name]) continue;   // namespace already published — nothing to do
    // Suffix match: `/<name>/adder` — keep the @gcu/ preference but
    // accept any scope. Most adapters are @gcu, but the convention
    // doesn't enforce it.
    const candidates = keys.filter(k => k.endsWith('/' + name + adapterSuffix));
    if (candidates.length === 0) {
      // Helpful for diagnosing "I wrote `from carotte import` but
      // nothing happened" — point at the most likely cause.
      _diagLog('info', `[runtime] adder import "from ${name} import …" present — but no */${name}/adder package is installed.`);
      continue;
    }
    const chosen = candidates.find(k => k.startsWith('@gcu/')) || candidates[0];
    // Adapter bridges typically need their engine in _importCache first
    // (the convention is `_engine = window._importCache["@gcu/<pkg>"]`
    // at module-eval time — see carotte's adder.js for the canonical
    // pattern). Load the engine first if it's installed but not yet
    // cached. Same scope, no /adder suffix.
    const enginePath = chosen.slice(0, -adapterSuffix.length);
    if (installed[enginePath] && !window._importCache?.[enginePath]) {
      try {
        await loadInstalledModule(enginePath);
        _diagLog('info', `[runtime] auto-loaded engine "${enginePath}" (prerequisite of "${chosen}")`);
      }
      catch (e) { _diagLog('warn', `[runtime] auto-load engine "${enginePath}":`, e.message); }
    }
    try {
      await loadInstalledModule(chosen);
      _diagLog('info', `[runtime] auto-loaded adapter "${chosen}" (referenced by adder import "${name}")`);
    }
    catch (e) { _diagLog('warn', `[runtime] auto-load adapter "${chosen}":`, e.message); }
  }
}

export async function runDAG(dirtyIds, force = false) {
  const gen = ++_dagGen;
  // Auto-load language packs for any fallback cell types we recognize. The
  // load() call upgrades the cell from fallback to a real handler before
  // buildDAG runs, so its parseNames/findUses bind correctly.
  await _autoLoadLanguagePacks();
  // Auto-discover adapter bridges referenced by adder cells' `from X import`
  // statements (carotte, natra, learn, …). Runs after the language pack
  // so the adder runtime is ready before any adapter registers exports
  // into it.
  await _autoLoadAdapters();
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
          outputEl.textContent = '✗ ' + e.message;   // glyph, not color alone (WCAG 1.4.1)
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
