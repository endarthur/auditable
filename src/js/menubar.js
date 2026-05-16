// Menu bar — consolidates the toolbar overflow + loose cell-type buttons into a
// classic File/Edit/View/Run/Tools/Help menu. Uses @gcu/menu's MenuBar with
// factory items so checkmarks (Reactive Mode) and dynamic plugin cell types
// reflect current state every open. Right-side toolbar (run trio, SAVE) stays.

import { MenuBar } from '#menu';
import { S } from './state.js';

const BUILTIN_INSERT = [
  { label: 'Insert JS Cell',   type: 'code', shortcut: 'Y' },
  { label: 'Insert MD Cell',   type: 'md',   shortcut: 'M' },
  { label: 'Insert CSS Cell',  type: 'css',  shortcut: 'S' },
  { label: 'Insert HTML Cell', type: 'html', shortcut: 'T' },
];

function pluginInsertItems() {
  const all = Object.entries(window._cellTypes || {});
  return all
    .filter(([, h]) => !h?.capabilities?.builtin)
    .map(([name, h]) => ({
      label: `Insert ${h.label || name} Cell`,
      action: `edit:insert:${name}`,
    }));
}

function sections() {
  return [
    { label: 'File', items: () => [
      { label: 'New', action: 'file:new' },
      '---',
      { label: 'Save', action: 'file:save', shortcut: 'Ctrl+S' },
      { label: 'Save Packed', action: 'file:save-packed' },
      '---',
      { label: 'Open .ipynb…', action: 'file:open-ipynb' },
      '---',
      { label: 'Export .txt', action: 'file:export-txt' },
      { label: 'Export .ipynb', action: 'file:export-ipynb' },
      { label: 'Export App…', action: 'file:export-app' },
      '---',
      { label: 'Files…', action: 'file:files' },
      { label: 'Settings…', action: 'file:settings' },
      '---',
      { label: 'Lock Notebook', action: 'file:lock' },
    ]},

    { label: 'Edit', items: () => {
      const items = [
        { label: 'Find / Replace', action: 'edit:find', shortcut: 'Ctrl+F' },
        '---',
        ...BUILTIN_INSERT.map(b => ({
          label: b.label, action: `edit:insert:${b.type}`, shortcut: b.shortcut,
        })),
      ];
      const plugins = pluginInsertItems();
      if (plugins.length) {
        items.push('---', ...plugins);
      }
      return items;
    }},

    { label: 'View', items: () => [
      { label: 'Collapse All', action: 'view:collapse-all' },
      { label: 'Expand All',   action: 'view:expand-all' },
      '---',
      { label: 'Editor View',  action: 'view:editor' },
      { label: 'Present',      action: 'view:present' },
    ]},

    { label: 'Run', items: () => [
      { label: 'Run Cell', action: 'run:cell', shortcut: 'Shift+Enter' },
      { label: 'Run All',  action: 'run:all',  shortcut: 'Ctrl+Shift+Enter' },
      '---',
      { label: 'Reactive Mode', action: 'run:toggle-autorun', checked: !!S.autorun },
    ]},

    { label: 'Tools', items: () => [
      { label: 'MCP…', action: 'tools:mcp' },
    ]},

    { label: 'Help', items: () => [
      { label: 'Documentation', action: 'help:docs', shortcut: 'F1' },
      '---',
      { label: 'Check for Updates…', action: 'help:update' },
    ]},
  ];
}

function dispatch(action) {
  if (typeof action !== 'string') return;

  // Insert cell types — variable suffix
  if (action.startsWith('edit:insert:')) {
    const type = action.slice('edit:insert:'.length);
    window.addCellWithUndo(type, '', S.selectedId);
    return;
  }

  switch (action) {
    case 'file:new':         window.newNotebook(); break;
    case 'file:save':        window.setSaveMode('normal'); window.saveNotebook(); break;
    case 'file:save-packed': window.setSaveMode('packed'); window.saveNotebook(); break;
    case 'file:open-ipynb':   window.openIpynbDialog(); break;
    case 'file:export-txt':   window.exportAsTxt(); break;
    case 'file:export-ipynb': window.exportAsIpynb(); break;
    case 'file:export-app':   window.showExportDialog(); break;
    case 'file:files':       window.toggleFs(); break;
    case 'file:settings':    window.toggleSettings(); break;
    case 'file:lock':        window.lockNotebook(); break;

    case 'edit:find':        window.openFind(false); break;

    case 'view:collapse-all': window.collapseAll(); break;
    case 'view:expand-all':   window.expandAll(); break;
    case 'view:editor':       window.toggleSplitView(); break;
    case 'view:present':      window.togglePresent(); break;

    case 'run:cell':           window.runSelectedCell(); break;
    case 'run:all':            window.runAll(); break;
    case 'run:toggle-autorun': window.toggleAutorun(); break;

    case 'tools:mcp':        window.toggleMcpPanel(); break;

    case 'help:docs':        document.getElementById('helpOverlay')?.classList.toggle('visible'); break;
    case 'help:update':      window.toggleUpdate(); break;
  }
}

let _bar = null;

export function initMenuBar() {
  const mount = document.getElementById('menubar');
  if (!mount) return;
  _bar = new MenuBar(mount, sections);
  _bar.on('action', dispatch);
}

// Public refresh hook — call after cell-type registration to re-evaluate
// the Edit menu's plugin section. (Factory items already evaluate on open,
// so this is only needed if the bar's topology changes — currently a no-op
// in practice, but exported for future use.)
export function refreshMenuBar() {
  _bar?.refresh();
}

// Boot once the DOM is ready (init.js calls into here too, but this covers
// the case where menubar.js loads after DOMContentLoaded has already fired).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMenuBar, { once: true });
} else {
  initMenuBar();
}
