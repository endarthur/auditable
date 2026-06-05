// @gcu/over — module manifest (build concat order).
//
// Chunk 1 (shipped): the parse front-end — lex → parse → AST (v0 row-map grammar).
// Coming: schema.js (the static schema pass), lower.js (the `over` AIR lowerer +
// browser self-registration), driver.js (apply a transform to a table), api.js
// (compile/transform). See SPEC §12 for the build order.

export * from './lex.js';
export * from './parse.js';
export * from './schema.js';
