// Registration: cell type, tagged language, plugin, extension

import { pythonParseNames, pythonFindUses, pythonExecute } from './cell.js';
import { tokenizePython, pythonCompletions } from './highlight.js';
import { getInterpreter } from './init.js';
import { mpy } from './tag.js';

const handler = {
  label: 'python',
  color: '#4B8BBE',
  shortcut: 'n',
  editDebounce: 500,
  parseNames: pythonParseNames,
  syntaxCheck: (code) => {
    const mp = getInterpreter();
    if (!mp) return true; // not initialized yet — allow execution
    try {
      mp.globals.set('_adder_check', code);
      mp.runPython('compile(_adder_check, "<check>", "exec")');
      try { mp.globals.delete('_adder_check'); } catch {}
      return true;
    } catch {
      try { mp.globals.delete('_adder_check'); } catch {}
      return false;
    }
  },
  findUses: pythonFindUses,
  execute: pythonExecute,
  tokenize: tokenizePython,
  completions: (prefix) => pythonCompletions(prefix),
  createEditor: (cell, onChange) => {
    if (!window._ctCreateEditor) return null;
    const wrap = document.createElement('div');
    wrap.className = 'editor-wrap';
    const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'python', onChange);
    return {
      el: wrap,
      getCode: () => editor.view.state.doc.toString(),
      setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
      destroy: () => editor.destroy(),
    };
  },
};

// guard: only register once (module may be re-imported from different blob URLs)
if (!window._cellTypes?.['python']) {
  // register cell type
  if (window.registerCellType) {
    window.registerCellType('python', handler, '@gcu/adder');
  } else if (window._cellTypes) {
    window._cellTypes['python'] = handler;
  }

  // register tagged language for mpy`` syntax highlighting
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages['mpy'] = {
    tokenize: tokenizePython,
    completions: pythonCompletions,
  };

  // register as plugin
  if (window.registerPlugin) {
    window.registerPlugin('@gcu/adder', { description: 'Python cells and mpy tagged template' });
  } else if (window._auditablePlugins) {
    window._auditablePlugins.set('@gcu/adder', { description: 'Python cells and mpy tagged template' });
  }

  // global mpy tag
  window.mpy = mpy;
}

export const adder = {
  mpy,
  handler,
  pythonParseNames,
  pythonFindUses,
  tokenizePython,
  pythonCompletions,
};
