// Manifest registration — EXTENSION_SPEC §2. One call wires every
// capability slot the extension contributes.

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

      // §3.5 — cross-language adapter
      exports: { quip: quipNamespace },

      // §3.6 — global (avoid in production extensions; here it's the
      // tagged-template binding so JS cells can write quip`…` without
      // an explicit load).
      globals: { quip: quipTag },

      // §3.8 — Works surface + context menu. No-op outside Works.
      surfaces: [
        {
          kind:        'example-quip-viewer',
          label:       'Quip Viewer',
          icon:        '◐',
          file:        'surface.html',
          extensions:  ['.quip'],
          openAction:  true,
          requires:    ['abus'],
        },
      ],
      contextMenu: [
        {
          label:  'Export as JSON',
          scope:  'file',
          filter: (path) => path.toLowerCase().endsWith('.quip'),
          action: async (path, ctx) => {
            const src = await ctx.vfs.readFile(path, 'utf8');
            // Lazy parse — fail loud if the file is broken so the user
            // knows where to look.
            const { parseQuip } = await import('./parse.js');
            const parsed = parseQuip(src);
            const jsonPath = path.replace(/\.quip$/i, '.json');
            await ctx.vfs.writeFile(jsonPath, JSON.stringify(parsed, null, 2));
            ctx.setStatus(`wrote ${jsonPath}`);
          },
        },
      ],
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
