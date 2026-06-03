// @gcu/loom — a virtualized canvas grid renderer behind a rich async cell
// provider. The loom interlaces warp (columns) and weft (rows) into the visible
// fabric of cells — a host-agnostic render core extracted from the calque
// spreadsheet grid and reseamed for strata: read = provider.cellAt (async-shaped,
// windowed), write = provider.commit (to an overlay), cells carry state+type so
// auditability is visual, and mount(el, provider) drops into a standalone page
// or a Works surface unchanged. The forcing-function renderer behind strata
// (and, eventually, a retrofitted calque — two consumers keep it honest).
//
// Module manifest (build concat order):
//   model.js           — PENDING sentinel, CellState/CellType enums, helpers (pure)
//   geometry.js        — column-width + virtualization math (pure)
//   memory-provider.js — trivial in-memory reference provider (pure)
//   render.js          — canvas paint core (browser)
//   grid.js            — createGrid factory: scaffold, events, edit→commit (browser)

export * from './model.js';
export * from './geometry.js';
export * from './memory-provider.js';
export * from './render.js';
export * from './grid.js';
