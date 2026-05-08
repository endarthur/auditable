// Registration: cell type, tagged language, AIR lowerer, plugin metadata.
// Single auditable.registerExtension(manifest) call replaces the legacy
// fan-out. Locale handling stays on a side channel since locales register
// additional cell types dynamically.

import { softParseNames, softFindUses, softExecute } from './cell.js';
import { tokenizeSoft, softCompletions, softIndent } from './highlight.js';
import { softTag } from './tag.js';
import { softParse } from './parse.js';
import { lowerSoft } from './air-lower.js';
import { softSetLocale, softGetLocale } from './tokenize.js';

const SOFT_VERSION = '0.1.0';

const _baseHandler = {
  parseNames: softParseNames,
  findUses: softFindUses,
  execute: softExecute,
  tokenize: tokenizeSoft,
  completions: (prefix) => softCompletions(prefix),
  syntaxCheck: (code) => { try { softParse(code); return true; } catch { return false; } },
  indent: softIndent,
  indentUnit: '  ',
};

if (typeof window !== 'undefined' && !window._cellTypes?.['soft']) {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/soft',
      version: SOFT_VERSION,
      apiVersion: '0.x',
      description: 'English keyword programming language — soft cells and tagged template',
      pluginUrl: '@gcu/soft',

      cellType: {
        name: 'soft',
        label: 'soft',
        color: '#c89b3c',
        shortcut: 'f',
        editDebounce: 500,
        capabilities: {
          executable: true,
          definesScope: true,
          hasOutput: true,
          hasEditor: true,
          builtin: false,
        },
        ..._baseHandler,
        createEditor: (cell, onChange) => {
          if (!window._ctCreateEditor) return null;
          const wrap = document.createElement('div');
          wrap.className = 'editor-wrap';
          const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'soft', onChange);
          return {
            el: wrap,
            getCode: () => editor.view.state.doc.toString(),
            setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
            focus: () => editor.focus(),
            destroy: () => editor.destroy(),
          };
        },
      },

      taggedLanguage: {
        name: 'soft',
        tokenize: tokenizeSoft,
        completions: softCompletions,
        indent: softIndent,
      },

      airLowerer: { language: 'soft', fn: lowerSoft },

      globals: { soft: softTag },

      onActivate: () => {
        // configure autocomplete for any existing soft cells (created before plugin loaded)
        if (window._configurePluginAutocomplete) window._configurePluginAutocomplete('soft');
      },
    });
  }
}

// Locale switcher kept as a side channel — not a cell-type contribution per se.
if (typeof window !== 'undefined') window._softSetLocale = softSetLocale;

// register a locale as a new cell type (e.g. 'soft-ptbr')
function registerLocale(localeData) {
  const localeName = (localeData.locale || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cellType = 'soft-' + localeName;

  // activate globally (for the base 'soft' type too)
  softSetLocale(localeData);

  // create locale-aware wrapper functions
  const withLocale = (fn) => (...args) => {
    const prev = softGetLocale();
    softSetLocale(localeData);
    try { return fn(...args); } finally { if (!prev) softSetLocale(null); }
  };

  const register = window.auditable?.registerExtension;
  if (!register) return;

  register({
    name: '@gcu/soft/' + localeData.locale,
    version: SOFT_VERSION,
    pluginUrl: '@gcu/soft/' + localeData.locale,

    cellType: {
      name: cellType,
      label: cellType,
      color: '#c89b3c',
      editDebounce: 500,
      capabilities: {
        executable: true,
        definesScope: true,
        hasOutput: true,
        hasEditor: true,
        builtin: false,
      },
      parseNames: withLocale(softParseNames),
      findUses: withLocale(softFindUses),
      execute: async (code, scopeIn, cell) => { softSetLocale(localeData); return softExecute(code, scopeIn, cell); },
      tokenize: withLocale(tokenizeSoft),
      completions: withLocale((prefix) => softCompletions(prefix)),
      syntaxCheck: withLocale((code) => { try { softParse(code); return true; } catch { return false; } }),
      indent: softIndent,
      indentUnit: '  ',
      createEditor: (cell, onChange) => {
        if (!window._ctCreateEditor) return null;
        const wrap = document.createElement('div');
        wrap.className = 'editor-wrap';
        const editor = window._ctCreateEditor(wrap, cell.id, cell.code, cellType, onChange);
        return {
          el: wrap,
          getCode: () => editor.view.state.doc.toString(),
          setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
          focus: () => editor.focus(),
          destroy: () => editor.destroy(),
        };
      },
    },

    taggedLanguage: {
      name: cellType,
      tokenize: withLocale(tokenizeSoft),
      completions: withLocale(softCompletions),
      indent: softIndent,
    },

    onActivate: () => {
      if (window._configurePluginAutocomplete) window._configurePluginAutocomplete(cellType);
    },
  });
}

// load a locale by name — handles dev-mode fetch + installed module decompression
async function loadLocale(name) {
  if (window._importCache?.['@gcu/soft/' + name]) {
    registerLocale(window._importCache['@gcu/soft/' + name]);
    return;
  }
  const key = '@gcu/soft/' + name;
  if (window._installedModules?.[key]) {
    let src = window._installedModules[key];
    if (src.compressed && !src.binary && typeof src.source === 'string') {
      const bin = Uint8Array.from(atob(src.source), c => c.charCodeAt(0));
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bin); writer.close();
      src = await new Response(ds.readable).text();
    } else if (src.source) {
      src = src.source;
    }
    const data = typeof src === 'string' ? JSON.parse(src) : src;
    window._importCache = window._importCache || {};
    window._importCache[key] = data;
    registerLocale(data);
    return;
  }
  const resp = await fetch(`./ext/soft/locales/${name}.json`);
  if (!resp.ok) throw new Error(`Locale "${name}" not found`);
  const data = await resp.json();
  window._importCache = window._importCache || {};
  window._importCache[key] = data;
  registerLocale(data);
}

export const soft = {
  softTag,
  softParseNames,
  softFindUses,
  tokenizeSoft,
  softCompletions,
  setLocale: softSetLocale,
  registerLocale,
  loadLocale,
};
