// @gcu/strata — predicate: re-export of @gcu/sift.
//
// The predicate lib was EXTRACTED to @gcu/sift (ext/sift) once @gcu/plate became
// its second consumer (the selection/linking contract's safe structured filter).
// strata keeps using it through this re-export so view.js / its public API are
// unchanged — but the SOURCE OF TRUTH is now sift:
//   • dev/node: this stub re-exports sift's src (relative import resolves).
//   • build: strata/build.js's `files` list points at ../sift/src/predicate.js
//     directly (build-inline), so strata's bundle stays a self-contained leaf and
//     re-exports the same symbols — no source duplication.
// Surfaces that need the evaluator (plate) get it via @gcu/strata's re-export, so
// they never double-inline sift alongside strata.

export * from '../../sift/src/predicate.js';
