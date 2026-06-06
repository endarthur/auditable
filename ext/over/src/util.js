// @gcu/over — shared zero-dep primitives used across the pipeline modules. Kept in
// ONE place because the concat build flattens every module into a single scope, so a
// helper defined privately in two modules would collide (a hard `const` redeclare).
// Each module imports what it needs; the bundle ends up with one definition.

// absent = null (string/category absent) OR NaN (numeric absent) — the type-
// polymorphic split (the NaN keystone). `x !== x` is the branch-free NaN test.
export const isAbsent = (x) => x == null || x !== x;

// group-key / eq-key field separator — a control char that won't occur in data.
export const SEP = String.fromCharCode(1);

// numeric comparator (sorting interval bounds / lo-keys).
export const numCmp = (a, b) => Number(a) - Number(b);

// a reference table is an array of rows, or a { rows } result (so transforms chain).
export const refRowsOf = (t) => (Array.isArray(t) ? t : (t && t.rows) || null);

// the relational operators — shared by the parser's `isRel` and the emitter's
// `isBoolish` (same set, one definition).
export const REL = new Set(['==', '!=', '<', '<=', '>', '>=']);
