# @gcu/sift — SPEC

*A safe, structured predicate spec (no eval) with a JS-flavoured string parser.*

| | |
|---|---|
| **Package** | `@gcu/sift` |
| **Version** | 0.1.0 |
| **Build** | concat (`node ext/sift/build.js` → `index.js`) |
| **Deps** | none |
| **Runtime** | any JS env (pure, zero DOM) |
| **Tests** | `test/predicate.test.mjs` (in `npm test`) |

## Premise

A selection/filter that crosses a trust boundary cannot be a JS string (Works
hosts untrusted `.gcupkg` surfaces → cross-surface arbitrary-code-exec). So a
predicate is a **structured spec, evaluated by walking the tree** — never
`eval`/`new Function` on the receiver. The op set is deliberately restricted
(comparisons, and/or/not, in/between, null-checks, arithmetic over col/lit); the
restriction *is* the safety. Full-JS expressiveness relocates to owner-evaluated
derived columns, which never cross the bus.

## Surface

`parsePredicate` (string→spec, authoring side) · `evaluatePredicate(pred, get)`
(walk over one row) · `predicateColumns` (deps) · `validatePredicate`
(shape-check) · `predicateToString` (spec→string, round-trip).

Spec: `Predicate = { form, root: Expr }`. `form:"spec"` is the universal floor
every surface speaks; `form:"js"` is the reserved elevated tier, evaluated only
by trusted/privileged surfaces (the trusted-tier seam in `ext/surface/SPEC.md`).

## Lineage

Extracted from `@gcu/strata`'s filter engine (`predicate.js`) once `@gcu/plate`
became the second consumer — the two-examples discipline. strata build-inlines
this source (its build's `files` list points at `../sift/src/predicate.js`) so it
stays a self-contained leaf bundle and re-exports the symbols; plate consumes
them via that re-export; a notebook `load('@gcu/sift')`s directly. No source
duplication — sift is the single owner.

## NOT (v0.1)

- Set-algebra combinators (intersect/union of predicates) — a v2 add.
- The `"js"` elevated form's evaluator (owner/trusted side only).
- Schema-aware validation (does the receiver *have* these columns) — caller's job
  via `predicateColumns`.

## Versioning

Pre-1.0. The spec shape follows the selection/linking contract, whose committed
home is `ext/surface/SPEC.md` (§ "The selection / linking contract"); changes
there drive changes here.
