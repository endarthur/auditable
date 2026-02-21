// ═══════════════════════════════════════════════════
// AUDITABLE — reactive notebook runtime
// Geoscientific Chaos Union, 2025
// ═══════════════════════════════════════════════════

export const $ = s => document.querySelector(s);
export const $$ = s => [...document.querySelectorAll(s)];

// ── STATE ──
export const S = {
  cells: [],        // { id, type, code, el, defines, uses, output, error }
  scope: {},        // shared variable scope
  cellId: 0,        // unique cell ID counter
  editTimer: null,  // debounce timer for autorun
  autorun: true,    // reactive mode flag
  selectedId: null, // currently selected cell
  pendingD: false,  // for "dd" double-tap delete
  pendingDTimer: null,
  clipboard: null,  // copied cell data
  trash: [],        // undo stack for deleted cells
};

export const JS_KEYWORDS = new Set([
  'const','let','var','function','return','if','else','for','while','do',
  'switch','case','break','continue','new','this','class','extends','import',
  'export','default','from','of','in','typeof','instanceof','void','delete',
  'throw','try','catch','finally','async','await','yield','true','false',
  'null','undefined','NaN','Infinity'
]);

export const JS_BUILTINS = new Set([
  'Math','Array','Object','String','Number','Float64Array','Float32Array',
  'Int32Array','Uint8Array','Map','Set','Promise','console','JSON',
  'display','canvas','table','slider','dropdown','checkbox','textInput','load','install'
]);
