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

import { softSetLocale } from './tokenize.js';

// expose setLocale on window for easy access from JS cells
window._softSetLocale = (locale) => {
  softSetLocale(locale);
  // store raw locale for _ensureLocale to find on page reload
  if (locale) window._softActiveLocale = locale;
  else delete window._softActiveLocale;
};

export const soft = {
  softTag,
  handler,
  softParseNames,
  softFindUses,
  tokenizeSoft,
  softCompletions,
  setLocale: softSetLocale,
};
