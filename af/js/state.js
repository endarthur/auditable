// ═══════════════════════════════════════════════════
// AUDITABLE FILES — workspace shell
// Geoscientific Chaos Union, 2025
// ═══════════════════════════════════════════════════

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ── STATE ──
const AFS = {
  roots: [],          // WorkspaceRoot[] — { type, name, dirHandle?, boxId? }
  tabs: [],           // { id, path, rootIndex, blobUrl, iframe, dirty, title }
  activeTabId: null,
  tabId: 0,
  sidebarWidth: 240,
  hasFSAA: typeof showDirectoryPicker === 'function',
  contextMenu: null,  // currently open context menu element
  db: null,           // IndexedDB reference
  treeOpen: {},       // expanded state: { "r0": true, "r0:src": true, ... }
};
