// soft — cell type, tagged language, plugin registration

import { softParseNames, softFindUses, softExecute } from './cell.js';
import { tokenizeSoft, softCompletions, softIndent } from './highlight.js';
import { softTag } from './tag.js';
import { softParse } from './parse.js';

const handler = {
  label: 'soft',
  color: '#c89b3c',
  shortcut: 'f',
  editDebounce: 500,
  indent: softIndent,
  indentUnit: '  ',
  parseNames: softParseNames,
  syntaxCheck: (code) => {
    try { softParse(code); return true; }
    catch { return false; }
  },
  findUses: softFindUses,
  execute: softExecute,
  tokenize: tokenizeSoft,
  completions: (prefix) => softCompletions(prefix),
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
};

// guard: only register once
if (!window._cellTypes?.['soft']) {
  // register 'soft' cell type
  if (window.registerCellType) {
    window.registerCellType('soft', handler, '@gcu/soft');
  } else if (window._cellTypes) {
    window._cellTypes['soft'] = handler;
  }

  // register tagged language for soft`` syntax highlighting
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages['soft'] = {
    tokenize: tokenizeSoft,
    completions: softCompletions,
    indent: softIndent,
  };

  // register as plugin
  if (window.registerPlugin) {
    window.registerPlugin('@gcu/soft', { description: 'English keyword programming language — soft cells and tagged template' });
  } else if (window._auditablePlugins) {
    window._auditablePlugins.set('@gcu/soft', { description: 'English keyword programming language — soft cells and tagged template' });
  }

  // global tag
  window.soft = softTag;

  // configure autocomplete for any existing soft cells (they were created before this plugin loaded)
  if (window._configurePluginAutocomplete) {
    window._configurePluginAutocomplete('soft');
  }
}

import { softSetLocale, softGetLocale } from './tokenize.js';

// expose for manual use (e.g. from browser console)
window._softSetLocale = softSetLocale;

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

  const localeHandler = {
    label: cellType,
    color: '#c89b3c',
    shortcut: null, // no keyboard shortcut for locale variants
    editDebounce: 500,
    indent: softIndent,
    indentUnit: '  ',
    parseNames: withLocale(softParseNames),
    syntaxCheck: withLocale((code) => { try { softParse(code); return true; } catch { return false; } }),
    findUses: withLocale(softFindUses),
    execute: async (code, scopeIn, cell) => {
      softSetLocale(localeData);
      return softExecute(code, scopeIn, cell);
    },
    tokenize: withLocale(tokenizeSoft),
    completions: withLocale((prefix) => softCompletions(prefix)),
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
  };

  // register cell type
  if (window.registerCellType) {
    window.registerCellType(cellType, localeHandler, '@gcu/soft/' + localeData.locale);
  } else if (window._cellTypes) {
    window._cellTypes[cellType] = localeHandler;
  }

  // register tagged language
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages[cellType] = {
    tokenize: localeHandler.tokenize,
    completions: localeHandler.completions,
    indent: softIndent,
  };

  // configure autocomplete for existing cells of this type
  if (window._configurePluginAutocomplete) {
    window._configurePluginAutocomplete(cellType);
  }

}

// load a locale by name — handles dev-mode fetch + installed module decompression
async function loadLocale(name) {
  // check import cache
  if (window._importCache?.['@gcu/soft/' + name]) {
    registerLocale(window._importCache['@gcu/soft/' + name]);
    return;
  }
  // check installed modules (saved notebook — gzip+base64 compressed JSON)
  const key = '@gcu/soft/' + name;
  if (window._installedModules?.[key]) {
    let src = window._installedModules[key];
    if (src.compressed && !src.binary && typeof src.source === 'string') {
      // decompress gzip+base64
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
  // dev-mode: fetch from filesystem
  const resp = await fetch(`./ext/soft/locales/${name}.json`);
  if (!resp.ok) throw new Error(`Locale "${name}" not found`);
  const data = await resp.json();
  window._importCache = window._importCache || {};
  window._importCache[key] = data;
  registerLocale(data);
}

export const soft = {
  softTag,
  handler,
  softParseNames,
  softFindUses,
  tokenizeSoft,
  softCompletions,
  setLocale: softSetLocale,
  registerLocale,
  loadLocale,
};
