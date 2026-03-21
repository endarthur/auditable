import { S } from './state.js';
import { buildDAG } from './dag.js';

// ── EXTENSIBLE CELL TYPES ──
//
// Registration API for plugin cell types. The four built-in types (code, md,
// css, html) stay hardcoded. This module provides dispatch helpers and
// activation logic for plugin-registered types.

const _builtinTypes = new Set(['code', 'md', 'css', 'html']);

// name → handler
window._cellTypes = window._cellTypes || {};

// name → exports (for cross-language imports)
window._auditableExtensions = window._auditableExtensions || {};

// url → { description }
window._auditablePlugins = window._auditablePlugins || new Map();

// pluginUrl → handler.name (for uninstall tracking)
const _pluginCellTypes = new Map(); // pluginUrl → Set<name>

// ── REGISTRATION ──

export function registerCellType(name, handler, pluginUrl) {
  if (_builtinTypes.has(name)) {
    console.warn(`Cannot register built-in type "${name}"`);
    return;
  }
  if (window._cellTypes[name]) {
    console.warn(`Cell type "${name}" already registered`);
    return;
  }
  window._cellTypes[name] = handler;
  if (pluginUrl) {
    handler._pluginUrl = pluginUrl;
    if (!_pluginCellTypes.has(pluginUrl)) _pluginCellTypes.set(pluginUrl, new Set());
    _pluginCellTypes.get(pluginUrl).add(name);
  }
  // activate any fallback cells of this type
  _ctActivatePendingCells(name);
}

export function registerExtension(name, exports) {
  window._auditableExtensions[name] = exports;
}

export function hasExtension(name) {
  return !!(window._auditableExtensions && window._auditableExtensions[name]);
}

export function getExtension(name) {
  return window._auditableExtensions?.[name] || null;
}

export function registerPlugin(url, meta) {
  window._auditablePlugins.set(url, meta || {});
}

// ── DISPATCH HELPERS ──

export function _ctGetHandler(type) {
  return window._cellTypes?.[type] || null;
}

export function _ctIsPlugin(type) {
  return !_builtinTypes.has(type) && !!window._cellTypes?.[type];
}

export function _ctIsFallback(cell) {
  return !!cell._fallback;
}

export function _ctIsBuiltin(type) {
  return _builtinTypes.has(type);
}

export function _ctAllTypeNames() {
  // built-in types + registered plugin types
  return [..._builtinTypes, ...Object.keys(window._cellTypes || {})];
}

export function _ctRegisteredTypes() {
  return Object.keys(window._cellTypes || {});
}

// ── ACTIVATION ──

function _ctActivatePendingCells(typeName) {
  const handler = window._cellTypes[typeName];
  if (!handler) return;

  let activated = false;
  for (const cell of S.cells) {
    if (cell.type === typeName && cell._fallback) {
      cell._fallback = false;
      activated = true;

      // update header label
      const labelEl = cell.el?.querySelector?.('.cell-type');
      if (labelEl) {
        labelEl.textContent = handler.label || typeName;
        if (handler.color) labelEl.style.color = handler.color;
      }

      // replace textarea with plugin editor if handler provides one
      if (handler.createEditor) {
        const codeWrap = cell.el?.querySelector?.('.cell-plugin-code');
        if (codeWrap) {
          const ta = codeWrap.querySelector('textarea');
          const debounce = handler.editDebounce || 300;
          const editorObj = handler.createEditor(cell, (newCode) => {
            cell.code = newCode;
            if (S.autorun) {
              clearTimeout(S.editTimer);
              if (handler.syntaxCheck) {
                // syntax-gated execution: only run if code compiles
                const ok = handler.syntaxCheck(newCode);
                cell.el?.classList.toggle('syntax-pending', !ok);
                if (!ok) return; // wait for valid syntax
                cell.el?.classList.remove('syntax-pending');
              }
              S.editTimer = setTimeout(() => {
                if (window._ctRunDAG) {
                  buildDAG();
                  window._ctRunDAG([cell.id]);
                }
              }, debounce);
            }
          });
          if (editorObj && editorObj.el) {
            if (ta) ta.remove();
            codeWrap.appendChild(editorObj.el);
            cell._pluginEditor = editorObj;
          }
        }
      }
    }
  }

  if (!activated) return;

  // rebuild DAG to pick up new cells
  buildDAG();
  // re-run to include newly activated cells
  if (window._ctRunAll) window._ctRunAll();
}

// ── PLUGIN OUTPUT RENDERING ──

export function _ctRenderOutput(cell, output) {
  const el = cell.el.querySelector('.cell-output');
  if (!el) return;
  el.className = 'cell-output'; // clear error/stale classes
  if (output === undefined || output === null) {
    el.textContent = '';
    return;
  }
  if (output instanceof Element || output instanceof DocumentFragment) {
    el.innerHTML = '';
    el.appendChild(output);
  } else if (typeof output === 'string') {
    el.textContent = output;
  } else {
    const pre = document.createElement('span');
    try { pre.textContent = JSON.stringify(output, null, 2); }
    catch { pre.textContent = String(output); }
    el.innerHTML = '';
    el.appendChild(pre);
  }
}

// ── UNINSTALL ──

export function _ctUninstallPlugin(url) {
  // unregister cell types from this plugin
  const types = _pluginCellTypes.get(url);
  if (types) {
    for (const name of types) {
      delete window._cellTypes[name];
      // revert cells to fallback
      for (const cell of S.cells) {
        if (cell.type === name) {
          cell._fallback = true;
          if (cell._pluginEditor) {
            if (cell._pluginEditor.destroy) cell._pluginEditor.destroy();
            cell._pluginEditor = null;
          }
          // rebuild cell element header
          const labelEl = cell.el.querySelector('.cell-type');
          if (labelEl) {
            labelEl.textContent = name + ' (not installed)';
            labelEl.style.color = '';
          }
          // restore textarea if needed
          const codeWrap = cell.el.querySelector('.cell-plugin-code');
          if (codeWrap && !codeWrap.querySelector('textarea')) {
            const ta = document.createElement('textarea');
            ta.className = 'plugin-textarea';
            ta.rows = 4;
            ta.spellcheck = false;
            ta.value = cell.code;
            ta.addEventListener('input', () => { cell.code = ta.value; });
            codeWrap.insertBefore(ta, codeWrap.firstChild);
          }
        }
      }
    }
    _pluginCellTypes.delete(url);
  }
  // remove from registries
  window._auditablePlugins.delete(url);
  if (window._installedModules) delete window._installedModules[url];
  if (window._importCache) delete window._importCache[url];

  buildDAG();
}

