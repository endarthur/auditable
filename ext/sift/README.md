# @gcu/sift

A **safe, structured predicate** — a boolean-expression spec as plain JSON,
evaluated by *walking the tree* (never `eval`/`new Function`), with a
JS-flavoured string parser on the authoring side. The lib the GCU
**selection/linking contract** rests on: a `kind:"filter"` selection travels as a
sift spec, so any surface — even an untrusted one — can apply it over its own
data without executing arbitrary code.

> Restricted predicate (travels, safe) + full-JS derived columns (stay home,
> owner-evaluated) = no power lost, and the thing on the bus is always safe.

## Why

A filter that crosses a trust boundary (Works hosts untrusted `.gcupkg` surfaces)
can't be a JS string — that's cross-surface arbitrary code execution. So sift is
deliberately **restricted**: comparisons, `and`/`or`/`not`, `in`/`between`,
null-checks, and arithmetic over columns/literals. No function calls, no member
access. That restriction *is* the safety. Users still type
`grade > 2 && domain == "ox"`; the emitter parses it to the spec; only the spec
travels; the receiver walks it.

## Quickstart

```js
import { parsePredicate, evaluatePredicate, predicateColumns } from '@gcu/sift';

const pred = parsePredicate('grade > 2 && domain == "ox"');
// → { form: 'spec', root: { op:'and', args:[ {op:'>',…}, {op:'==',…} ] } }

const rows = data.filter((row) => evaluatePredicate(pred, (col) => row[col]));
predicateColumns(pred);   // ['grade', 'domain'] — can this receiver satisfy it?
```

## API

- `parsePredicate(string) → { form:'spec', root }` — JS-flavoured subset →
  spec. Rejects function calls / member access (the safety). `x == null` lowers
  to `isnull`; a bare term in boolean position becomes `truthy`.
- `evaluatePredicate(pred, get) → boolean` — walk the spec over one row;
  `get(col)` resolves a column → value.
- `predicateColumns(pred) → string[]` — the columns it references.
- `validatePredicate(pred) → true` — shape-check; throws on a malformed spec.
- `predicateToString(pred) → string` — spec → string (display / audit / round-trip).

## Spec shape

```
Predicate = { form:'spec', root: Expr }
Expr  = {op:'and'|'or', args:Expr[]} | {op:'not', arg:Expr}
      | {op:'=='|'!='|'<'|'<='|'>'|'>=', left:Term, right:Term}
      | {op:'in'|'notin', left:Term, set:Lit[]} | {op:'between', arg:Term, lo:Term, hi:Term}
      | {op:'isnull'|'notnull', arg:Term} | {op:'truthy', arg:Term}
Term  = {col:string} | {lit:value} | {op:'+'|'-'|'*'|'/', left,right} | {op:'neg', arg}
```

## Lineage

Extracted from `@gcu/strata`'s filter engine once `@gcu/plate` became the second
consumer (the two-examples discipline). strata build-inlines this file (staying a
self-contained leaf bundle); plate consumes it via strata's re-export; a notebook
can `load('@gcu/sift')` directly. The `predicate.form` tag reserves an elevated
`"js"` tier for trusted/privileged surfaces (see the selection/linking contract).

## Build & test

`node ext/sift/build.js` → `ext/sift/index.js`. Tests: `test/predicate.test.mjs`
(in `npm test`).

## License

MIT © Arthur Endlein Correia — Geoscientific Chaos Union (gentropic.org)
