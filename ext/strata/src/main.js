// @gcu/strata — an auditable, reactive, column-oriented table surface. This
// package is the strata working MODEL: a typed columnar base + a value-patch
// overlay (the auditable, non-destructive spine), CSV ingest (recon-injectable),
// and an adapter to the @gcu/loom grid renderer. The surface shell (standalone↔
// Works parity, the native .strata document, derived columns, the view pipeline)
// builds on top of this.
//
// Module manifest (build concat order):
//   values.js   — coercion, null vocabulary, display formatting (pure)
//   formula.js  — compileFormula: derived-column JS expression → per-row fn (pure)
//   table.js    — createTable: base + value-patch overlay + derived columns (pure)
//   ingest.js   — tableFromCsv (recon-injectable; built-in sniffer fallback) (pure)
//   document.js — writeStrata/readStrata: the native .strata zip (archive-injectable)
//   provider.js — createTableProvider: StrataTable → @gcu/loom provider (pure)

export * from './values.js';
export * from './formula.js';
export * from './table.js';
export * from './ingest.js';
export * from './document.js';
export * from './provider.js';
