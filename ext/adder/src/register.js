// Registration: cell type, tagged language, plugin, extension

import { pythonParseNames, pythonFindUses, pythonExecute } from './cell.js';
import { tokenizePython, pythonCompletions } from './highlight.js';
import { adderTag, mpy } from './tag.js';
import { adderParse } from './parse.js';

const handler = {
  label: 'adder',
  color: '#4B8BBE',
  shortcut: 'n',
  editDebounce: 500,
  parseNames: pythonParseNames,
  syntaxCheck: (code) => {
    try { adderParse(code); return true; }
    catch { return false; }
  },
  findUses: pythonFindUses,
  execute: pythonExecute,
  tokenize: tokenizePython,
  completions: (prefix) => pythonCompletions(prefix),
  createEditor: (cell, onChange) => {
    if (!window._ctCreateEditor) return null;
    const wrap = document.createElement('div');
    wrap.className = 'editor-wrap';
    const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'adder', onChange);
    return {
      el: wrap,
      getCode: () => editor.view.state.doc.toString(),
      setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
      focus: () => editor.focus(),
      destroy: () => editor.destroy(),
    };
  },
};

// guard: only register once (module may be re-imported from different blob URLs)
if (!window._cellTypes?.['adder']) {
  // register 'adder' cell type (shows in insert bar)
  if (window.registerCellType) {
    window.registerCellType('adder', handler, '@gcu/adder');
  } else if (window._cellTypes) {
    window._cellTypes['adder'] = handler;
  }

  // register tagged language for both adder`` and mpy`` syntax highlighting
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages['adder'] = {
    tokenize: tokenizePython,
    completions: pythonCompletions,
  };
  window._taggedLanguages['mpy'] = {
    tokenize: tokenizePython,
    completions: pythonCompletions,
  };

  // register as plugin
  if (window.registerPlugin) {
    window.registerPlugin('@gcu/adder', { description: 'JS-targeting Python dialect — adder cells and tagged template' });
  } else if (window._auditablePlugins) {
    window._auditablePlugins.set('@gcu/adder', { description: 'JS-targeting Python dialect — adder cells and tagged template' });
  }

  // global tags
  window.adder = adderTag;
  window.mpy = mpy;
}

export const adder = {
  adderTag,
  mpy,
  handler,
  pythonParseNames,
  pythonFindUses,
  tokenizePython,
  pythonCompletions,
};
