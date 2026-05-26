// Notebook-context registration — EXTENSION_SPEC §2.5.
//
// This file runs inside the notebook iframe (or the page in standalone
// auditable). It calls the notebook-side window.auditable.registerExtension,
// which handles cellType / taggedLanguage / exports / globals.
//
// Surfaces + contextMenu are SHELL-context concerns and live in
// works.js (sibling file). The two contexts never coordinate at the
// registration layer — each runs where its capabilities take effect.

import { quipParseNames, quipFindUses, quipExecute } from './cell.js';
import { tokenizeQuip } from './tokenize.js';
import { quipTag } from './tag.js';
import { quipNamespace } from './adapter.js';

const QUIP_VERSION = '0.1.0';

// EXTENSION_SPEC §2.3 guard: only register once per page. Same idiom
// as ext/adder and ext/soft so multiple loads (during dev hot-reload
// or repeated install/load cycles) don't throw the "already registered"
// warning.
if (typeof window !== 'undefined' && !window._cellTypes?.['quip']) {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@example/quip',
      version: QUIP_VERSION,
      description: 'A toy templating language — the EXTENSION_SPEC reference example.',
      pluginUrl: '@example/quip',

      // §3.1 — cell type
      cellType: {
        name: 'quip',
        label: 'quip',
        color: '#9b7eaf',
        shortcut: 'q',
        editDebounce: 250,
        capabilities: {
          executable:   true,
          definesScope: true,
          hasOutput:    true,
          hasEditor:    true,
          builtin:      false,
        },
        parseNames: quipParseNames,
        findUses:   quipFindUses,
        execute:    quipExecute,
        tokenize:   tokenizeQuip,
      },

      // §3.2 — tagged language
      taggedLanguage: {
        name: 'quip',
        tokenize: tokenizeQuip,
      },

      // §3.5 — cross-language adapter (Python-shape namespace)
      exports: { quip: quipNamespace },

      // §3.6 — global (the tagged-template binding so JS cells can
      // write quip`…` without an explicit load)
      globals: { quip: quipTag },
    });
  }
}

// Plain export form so non-auditable consumers (Node tests, raw npm
// imports) get the API too.
export { quipParseNames, quipFindUses, quipExecute } from './cell.js';
export { tokenizeQuip } from './tokenize.js';
export { quipTag } from './tag.js';
export { quipNamespace } from './adapter.js';
export { parseQuip, renderQuip, compileQuip, makePhrases } from './parse.js';
