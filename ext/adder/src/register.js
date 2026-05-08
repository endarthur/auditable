// Registration: cell type, tagged languages, AIR lowerer, plugin metadata.
// Single auditable.registerExtension(manifest) call replaces the legacy
// fan-out across registerCellType / _taggedLanguages / registerPlugin /
// _airRegisterLowerer / window.adder / window.mpy.

import { pythonParseNames, pythonFindUses, pythonExecute, setAdderVFS } from './cell.js';
import { tokenizePython, pythonCompletions } from './highlight.js';
import { adderTag, mpy } from './tag.js';
import { adderParse } from './parse.js';
import { lowerAdder } from './air-lower.js';

const ADDER_VERSION = '0.3.0';

if (typeof window !== 'undefined' && !window._cellTypes?.['adder']) {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/adder',
      version: ADDER_VERSION,
      apiVersion: '0.x',
      description: 'JS-targeting Python dialect — adder cells and tagged template',
      pluginUrl: '@gcu/adder',

      cellType: {
        name: 'adder',
        label: 'adder',
        color: '#4B8BBE',
        shortcut: 'n',
        editDebounce: 500,
        capabilities: {
          executable: true,
          definesScope: true,
          hasOutput: true,
          hasEditor: true,
          builtin: false,
        },
        parseNames: pythonParseNames,
        findUses: pythonFindUses,
        execute: pythonExecute,
        tokenize: tokenizePython,
        completions: (prefix) => pythonCompletions(prefix),
        syntaxCheck: (code) => { try { adderParse(code); return true; } catch { return false; } },
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
      },

      taggedLanguages: [
        { name: 'adder', tokenize: tokenizePython, completions: pythonCompletions },
        { name: 'mpy',   tokenize: tokenizePython, completions: pythonCompletions },
      ],

      airLowerer: { language: 'adder', fn: lowerAdder },

      globals: { adder: adderTag, mpy: mpy },
    });
  }
}

export const adder = {
  adderTag,
  mpy,
  pythonParseNames,
  pythonFindUses,
  tokenizePython,
  pythonCompletions,
  setVFS: setAdderVFS,
};
