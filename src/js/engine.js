// ── ENGINE — pure computational core (no DOM dependencies) ──
//
// Extracted from exec.js to enable headless execution in Node.js.
// exec.js becomes a thin DOM wrapper calling these functions.

import { isManual as _isManual, isNorun as _isNorun } from './dag-core.js';

// ── ERROR LINE EXTRACTION ──
// AsyncFunction wraps cell code with a header (function signature + blank line +
// "use strict"). the exact line offset varies by engine, so we detect it once.

let _lineOffset = 0;
try {
  const fn = new Function('"use strict";\nthrow new Error();\n//# sourceURL=auditable://_probe.js');
  fn();
} catch (e) {
  const m = e.stack?.match(/auditable:\/\/_probe\.js:(\d+)/);
  if (m) _lineOffset = parseInt(m[1], 10) - 1;
}
if (!_lineOffset) _lineOffset = 3;

export function cellErrorLine(err, cellId) {
  const tag = 'auditable://cell-' + cellId;
  if (err.stack) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = err.stack.match(new RegExp(escaped + '[^:]*:(\\d+)'));
    if (m) { const n = parseInt(m[1], 10) - _lineOffset; if (n > 0) return n; }
  }
  if (err.message) {
    const m = err.message.match(/\((\d+):(\d+)\)\s*$/) || err.message.match(/line (\d+)/i);
    if (m) { const n = parseInt(m[1], 10) - _lineOffset; if (n > 0) return n; }
  }
  return 0;
}

// ── TAGGED CONTENT ──

export class TaggedContent {
  constructor(type, content) { this.type = type; this.content = content; }
  toString() { return this.content; }
}

export function taggedTemplate(type) {
  return (strings, ...values) => {
    let result = strings[0];
    for (let i = 0; i < values.length; i++) result += String(values[i]) + strings[i + 1];
    return new TaggedContent(type, result);
  };
}

// ── INJECTED NAMES ──

export const INJECTED_NAMES = [
  'ui', 'std', 'load', 'install', 'installBinary', 'invalidation',
  'print', 'display', 'md', 'html', 'css', 'workshop', 'notebook',
  'worker', 'workerPool', 'vfs'
];

// ── COMPILATION ──

export function compileCellCode(code, scopeKeys, defineNames, cellId, cellName) {
  const AF = Object.getPrototypeOf(async function(){}).constructor;
  const slug = cellName
    ? '-' + cellName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    : '';
  return new AF(
    ...scopeKeys, ...INJECTED_NAMES,
    `"use strict";\n${code}\n\nreturn { ${defineNames} };\n` +
    `//# sourceURL=auditable://cell-${cellId}${slug}.js`
  );
}

export function cellCacheKey(scopeKeys, defineNames, code) {
  return scopeKeys.join(',') + '|' + defineNames + '|' + code;
}

// ── EXECUTION ──

export async function executeCellCode(fn, scopeVals, injectedVals) {
  try {
    const result = await fn(...scopeVals, ...injectedVals);
    return { defines: result && typeof result === 'object' ? result : {}, error: null };
  } catch (e) {
    return { defines: {}, error: e };
  }
}

// ── DAG ORCHESTRATION ──

function _restoreCachedResult(cell, scope) {
  if (cell._lastResult) {
    for (const [k, v] of Object.entries(cell._lastResult)) {
      if (v !== undefined) scope[k] = v;
    }
  }
}

function _isBlocked(cell, poisoned) {
  if (!cell.uses || !cell.uses.size) return false;
  for (const name of cell.uses) {
    if (poisoned.has(name)) return true;
  }
  return false;
}

/**
 * Execute a DAG of cells with scope management, error isolation, and value-equality gating.
 *
 * @param {Array} cells — ordered array of cell objects
 * @param {Array} dirtyIds — IDs of directly-triggered cells
 * @param {Set} runSet — IDs of cells to execute (from topoSort)
 * @param {Object} scope — mutable scope object (modified in place)
 * @param {Object} options — callbacks for all side effects:
 *   onExecCode(cell)    → Promise<{defines, error}>
 *   onExecHtml(cell)    → void
 *   onExecMd(cell)      → void
 *   onExecPlugin(cell)  → Promise<{defines, error}|null>
 *   onCellStatus(cell, status) → void  (status: 'stale'|'blocked')
 *   checkGeneration()   → boolean (false to abort)
 *   onAfterExec(cell, i) → number|undefined (jump index for %goto)
 *   isAutorun           → boolean
 * @returns {{ poisoned: Set, aborted: boolean }}
 */
export async function executeDAG(cells, dirtyIds, runSet, scope, options) {
  const {
    onExecCode,
    onExecHtml,
    onExecMd,
    onExecPlugin,
    onCellStatus,
    checkGeneration,
    onAfterExec,
    isAutorun = false,
  } = options;

  const poisoned = new Set();

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];

    // ── HTML cells ──
    if (cell.type === 'html') {
      if (runSet.has(cell.id)) {
        if (_isBlocked(cell, poisoned)) {
          if (onCellStatus) onCellStatus(cell, 'stale');
        } else {
          onExecHtml(cell);
        }
      }
      // inject widget-defined variables into scope for downstream cells
      if (cell.defines && cell.defines.size > 0) {
        for (const name of cell.defines) {
          if (cell._inputs && cell._inputs[name] !== undefined) {
            scope[name] = cell._inputs[name];
          }
        }
      }
      continue;
    }

    // ── Markdown cells ──
    if (cell.type === 'md') {
      if (runSet.has(cell.id)) {
        if (_isBlocked(cell, poisoned)) {
          if (onCellStatus) onCellStatus(cell, 'stale');
        } else {
          onExecMd(cell);
        }
      }
      continue;
    }

    // ── Plugin cells ──
    if (cell.type !== 'code' && cell.type !== 'css') {
      if (cell._fallback) continue;
      if (!onExecPlugin) continue;

      if (!runSet.has(cell.id)) {
        _restoreCachedResult(cell, scope);
        continue;
      }

      if (_isBlocked(cell, poisoned)) {
        cell._blocked = true;
        if (onCellStatus) onCellStatus(cell, 'blocked');
        if (cell.defines) for (const name of cell.defines) poisoned.add(name);
        continue;
      }

      cell._blocked = false;
      const result = await onExecPlugin(cell);
      if (checkGeneration && !checkGeneration()) return { poisoned, aborted: true };

      if (result?.error) {
        if (cell.defines) for (const name of cell.defines) poisoned.add(name);
      } else if (result?.defines) {
        for (const [k, v] of Object.entries(result.defines)) {
          if (v !== undefined) scope[k] = v;
        }
      }
      continue;
    }

    // ── CSS cells — no execution ──
    if (cell.type !== 'code') continue;

    // ── Code cells ──

    // norun skip
    if (_isNorun(cell.code) && !dirtyIds.includes(cell.id)) {
      _restoreCachedResult(cell, scope);
      continue;
    }

    // manual skip
    if (_isManual(cell.code) && !dirtyIds.includes(cell.id)) {
      _restoreCachedResult(cell, scope);
      if (onCellStatus) onCellStatus(cell, 'stale');
      continue;
    }

    // not in run set — restore cached results
    if (!runSet.has(cell.id)) {
      _restoreCachedResult(cell, scope);
      continue;
    }

    // blocked by upstream error
    if (_isBlocked(cell, poisoned)) {
      cell._blocked = true;
      if (onCellStatus) onCellStatus(cell, 'blocked');
      if (cell.defines) for (const name of cell.defines) poisoned.add(name);
      continue;
    }

    // value-equality gating: skip re-execution if inputs unchanged
    if (!cell.error && !cell._blocked && !dirtyIds.includes(cell.id)
        && cell._lastResult && cell.uses && cell.uses.size > 0) {
      let inputsChanged = false;
      for (const name of cell.uses) {
        if (scope[name] !== cell._prevInputs?.[name]) { inputsChanged = true; break; }
      }
      if (!inputsChanged) {
        _restoreCachedResult(cell, scope);
        continue;
      }
    }

    // execute
    cell._blocked = false;
    const result = await onExecCode(cell);
    if (checkGeneration && !checkGeneration()) return { poisoned, aborted: true };

    // update scope from result
    if (result.error) {
      if (cell.defines) for (const name of cell.defines) poisoned.add(name);
    } else if (result.defines) {
      for (const [k, v] of Object.entries(result.defines)) {
        if (v !== undefined) scope[k] = v;
      }
    }

    // snapshot input values for future equality checks
    if (cell.uses) {
      cell._prevInputs = {};
      for (const name of cell.uses) cell._prevInputs[name] = scope[name];
    }

    if (onAfterExec && !isAutorun) {
      const jump = onAfterExec(cell, i);
      if (jump >= 0) { i = jump - 1; continue; }
    }
  }

  return { poisoned, aborted: false };
}
