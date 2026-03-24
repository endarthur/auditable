// ── RUNTIME — headless notebook execution for Node.js ──
//
// NOT added to main.js (not part of browser build).
// Provides createNotebook() for running notebooks without DOM.
//
// Usage:
//   import { createNotebook } from './src/js/runtime.js';
//   const nb = createNotebook();
//   nb.addCell('code', 'const x = 1');
//   nb.addCell('code', 'const y = x + 1');
//   const result = await nb.run();
//   // result.scope → { x: 1, y: 2 }

import {
  INJECTED_NAMES, taggedTemplate,
  compileCellCode, cellCacheKey, executeCellCode, executeDAG
} from './engine.js';

import {
  serializeCells, parseNotebookHtml, buildTxtExport
} from './serialize.js';

import {
  parseCellName, buildDAG, topoSort
} from './dag-core.js';

import { std as stdCore } from './stdlib-core.js';

// ── TXT PARSING (duplicated from split.js to avoid DOM import chain) ──

function _parseTxt(content) {
  const lines = content.split('\n');
  let title = 'untitled';
  let settings = null;
  const moduleUrls = [];
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l.startsWith('/// ')) {
      if (currentCell) {
        currentCell.code = currentCell.code.replace(/^\n/, '').replace(/\n$/, '');
        cells.push(currentCell);
        currentCell = null;
      }
      const directive = l.slice(4);
      if (directive === 'auditable') continue;
      else if (directive.startsWith('title: ')) title = directive.slice(7);
      else if (directive.startsWith('settings: ')) {
        try { settings = JSON.parse(directive.slice(10)); } catch {}
      } else if (directive.startsWith('module: ')) {
        moduleUrls.push(directive.slice(8));
      } else {
        const parts = directive.split(' ');
        const type = parts[0];
        const collapsed = parts.includes('collapsed');
        currentCell = { type, collapsed: collapsed || false, code: '' };
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + l;
    }
  }
  if (currentCell) {
    currentCell.code = currentCell.code.replace(/^\n/, '').replace(/\n$/, '');
    cells.push(currentCell);
  }
  return { title, cells, settings, moduleUrls };
}

// ── NOTEBOOK API ──

export function createNotebook(options = {}) {
  const cellTypes = options.cellTypes || {};
  const moduleRegistry = { '@std': stdCore, ...options.modules };
  const moduleCache = {};
  const customLoad = options.load || null;
  let _cellId = 0;
  const cells = [];

  function _makeCell(type, code) {
    return {
      id: _cellId++,
      type,
      code: code || '',
      collapsed: false,
      defines: new Set(),
      uses: new Set(),
      error: null,
      _lastResult: null,
      _prevInputs: null,
      _blocked: false,
      _inputs: {},
      _fallback: !['code', 'md', 'css', 'html'].includes(type) && !cellTypes[type],
    };
  }

  function addCell(type, code) {
    const cell = _makeCell(type, code);
    cells.push(cell);
    return cell;
  }

  function removeCell(id) {
    const idx = cells.findIndex(c => c.id === id);
    if (idx >= 0) cells.splice(idx, 1);
  }

  async function run() {
    buildDAG(cells, cellTypes);
    const isExecutable = (c) =>
      c.type === 'code' || c.type === 'html' || c.type === 'md'
      || (cellTypes[c.type]?.execute && !c._fallback);
    const dirtyIds = cells.filter(isExecutable).map(c => c.id);
    const runSet = new Set(topoSort(cells, dirtyIds));

    const scope = {};
    const cellResults = [];

    const result = await executeDAG(cells, dirtyIds, runSet, scope, {
      isAutorun: false,

      onExecCode: async (cell) => {
        const scopeKeys = cell.uses
          ? [...cell.uses].filter(k => !INJECTED_NAMES.includes(k)).sort()
          : [];
        const defNames = cell.defines ? [...cell.defines].sort().join(', ') : '';
        const cacheKey = cellCacheKey(scopeKeys, defNames, cell.code);

        let fn;
        if (cell._cacheKey === cacheKey && cell._cachedFn) {
          fn = cell._cachedFn;
        } else {
          fn = compileCellCode(cell.code, scopeKeys, defNames, cell.id, parseCellName(cell.code));
          cell._cachedFn = fn;
          cell._cacheKey = cacheKey;
        }

        const scopeVals = scopeKeys.map(k => scope[k]);

        // headless injected values
        const output = [];
        const display = (...args) => output.push(...args);
        const md = taggedTemplate('md');
        const html = taggedTemplate('html');
        const css = taggedTemplate('css');

        // headless load: registry → custom loader → error
        const load = async (url) => {
          if (moduleCache[url]) return moduleCache[url];
          if (moduleRegistry[url]) { moduleCache[url] = moduleRegistry[url]; return moduleRegistry[url]; }
          if (customLoad) { const mod = await customLoad(url); moduleCache[url] = mod; return mod; }
          throw new Error(`Module not available in headless mode: ${url}`);
        };
        // install delegates to load (no persistence in headless mode)
        const install = async (url) => load(url);

        const injected = new Array(INJECTED_NAMES.length).fill(undefined);
        injected[INJECTED_NAMES.indexOf('display')] = display;
        injected[INJECTED_NAMES.indexOf('print')] = display;
        injected[INJECTED_NAMES.indexOf('ui')] = { display, print: display };
        injected[INJECTED_NAMES.indexOf('std')] = stdCore;
        injected[INJECTED_NAMES.indexOf('load')] = load;
        injected[INJECTED_NAMES.indexOf('install')] = install;
        injected[INJECTED_NAMES.indexOf('md')] = md;
        injected[INJECTED_NAMES.indexOf('html')] = html;
        injected[INJECTED_NAMES.indexOf('css')] = css;

        const { defines, error } = await executeCellCode(fn, scopeVals, injected);

        if (error) {
          cell.error = error.message;
          cellResults.push({ id: cell.id, defines: {}, output, error: error.message });
        } else {
          cell.error = null;
          cell._lastResult = defines;
          cellResults.push({ id: cell.id, defines, output, error: null });
        }
        return { defines, error };
      },

      onExecHtml: (cell) => {
        cellResults.push({ id: cell.id, defines: {}, output: [], error: null });
      },

      onExecMd: (cell) => {
        cellResults.push({ id: cell.id, defines: {}, output: [cell.code], error: null });
      },

      onExecPlugin: async (cell) => {
        const handler = cellTypes[cell.type];
        if (!handler?.execute) return null;

        const upstream = {};
        if (cell.uses) {
          for (const name of cell.uses) {
            if (scope[name] !== undefined) upstream[name] = scope[name];
          }
        }

        try {
          const result = await handler.execute(cell.code, upstream, cell);
          const defines = result?.defines || {};
          cell._lastResult = defines;
          cell.error = null;
          const output = result?.output !== undefined ? [result.output] : [];
          cellResults.push({ id: cell.id, defines, output, error: null });
          return { defines, error: null };
        } catch (e) {
          cell.error = e.message;
          cellResults.push({ id: cell.id, defines: {}, output: [], error: e.message });
          return { defines: {}, error: e };
        }
      },

      onCellStatus: () => {},
      checkGeneration: () => true,
    });

    return { scope, cells: cellResults, poisoned: result.poisoned };
  }

  function loadTxt(content) {
    cells.length = 0;
    _cellId = 0;
    const parsed = _parseTxt(content);
    for (const c of parsed.cells) {
      const cell = addCell(c.type, c.code);
      cell.collapsed = c.collapsed || false;
    }
    return { title: parsed.title, settings: parsed.settings, moduleUrls: parsed.moduleUrls };
  }

  function loadHtml(html) {
    cells.length = 0;
    _cellId = 0;
    const parsed = parseNotebookHtml(html);
    if (parsed.cells) {
      for (const c of parsed.cells) {
        const cell = addCell(c.type, c.code);
        cell.collapsed = c.collapsed || false;
      }
    }
    return { title: parsed.title, settings: parsed.settings, modules: parsed.modules };
  }

  function serialize() {
    return serializeCells(cells);
  }

  function toTxt(title = 'untitled', settings = null, moduleUrls = null) {
    return buildTxtExport({
      title,
      cells: serializeCells(cells),
      settings,
      moduleUrls,
    });
  }

  function analyze() {
    buildDAG(cells, cellTypes);
    const graph = cells.map(c => ({
      id: c.id,
      type: c.type,
      defines: c.defines ? [...c.defines] : [],
      uses: c.uses ? [...c.uses] : [],
    }));
    return graph;
  }

  return {
    get cells() { return cells; },
    addCell,
    removeCell,
    run,
    analyze,
    loadTxt,
    loadHtml,
    serialize,
    toTxt,
  };
}
