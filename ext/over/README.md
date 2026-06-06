# @gcu/over

**OVER — Ordered/Vectorized Expression Runner.** A row-wise table-transform DSL:
faithful **compat** with Datamine Studio's EXTRA, plus a **native** superset that's
typed, unit-aware, null-aware, window-capable, multi-table, and auditable.

> *The extra that went over the top.*

OVER is the foundational table verb — **map each row to a new row** — with filter,
project, grouped/ordered windows, joins, validation, and dimensional checking on top.
It's one more dialect for the GCU stack, **never a replacement**: a geologist who
thinks in EXTRA gets an on-ramp; everyone else keeps their JS/adder derived columns.
Its load-bearing property is **auditability** — the output schema is resolved as a pure
function of `(transform, input schema)` *before any row runs*, so a transform's result
shape (and its unit soundness) is provable up front.

```
# domain-relative grade, classify, project — schema resolved before any row runs
FE_N    = FE / mean(FE) over LITHO
ORETYPE = match FE { >=64:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }
DENSITY = lookup densities.density where densities.litho == LITHO
saveonly(IJK, FE, FE_N, ORETYPE, DENSITY)
```

## Status — **built**

Shipped and tested (`test/over.test.mjs`). The design of record is **[`SPEC.md`](./SPEC.md)**.
The compiler pipeline: source → lex → parse → schema pass → direct-emit JS row function
(the AIR lowerer is the planned perf swap behind the same AST→row-fn interface).

## The language

| Feature | Form |
|---|---|
| **map / project** | `FE_N = FE / 100` · `saveonly(hole, FE_N)` · `keep` / `erase` |
| **filter / control** | `if FE < 30 delete end` · `exit` |
| **conditionals** | `if … elseif … else … end` · `match X { >=62:"hi", _:"lo" }` |
| **windows** | `mean(FE) over LITHO` · ordered/running `sum(L) over hole order from` · positional `prev/next/first/last` |
| **lookup (join)** | `lookup t.col where t.k == K` (equality → hash); `… and t.from <= D < t.to` (interval → sorted+binary-search) |
| **aggregating join** | `wmean(a.fe, overlap) where a.hole == hole and a.from < TO and a.to > FROM` — length-weighted compositing |
| **check / require** | `check "from<to": FROM < TO` (reports) · `require …` (gates — throws) |
| **bin** | `bin(GRADE, 40,50,60)` → class index · `binlabel(…)` → `"40 - 50"` |
| **units** | `GRADE : float[g/t]` — dimensional checking, schema-pass only (zero runtime cost), warns on `% + g/t` |

Built on **[`@gcu/dimensions`](../dimensions)** for the unit algebra, with grade units
(`%`, `g/t`, `ppm`) deliberately kept as **distinct dimensions** so they never silently mix.

## Use it

**In a notebook** — the `over` tagged template:

```js
const { over } = await load("@gcu/over");
const out = over`
  FE_REL = FE / mean(FE) over LITHO
  ORE    = match FE { >=62:"ore", _:"waste" }
  check "fe present": present(FE)
  saveonly(hole, FE, FE_REL, ORE)
`(rows);                 // → result rows (+ non-enumerable .columns / .checks / .warnings)
```

**Over a strata table** — via [`@gcu/strata`](../strata)'s `transformWithOver` (OVER is
strata's whole-table declarative verb, complementing its per-column JS formulas; the
strata surface exposes it as **Transform…**):

```js
import { transformWithOver } from '@gcu/strata';
const { table, checks, warnings } = transformWithOver(strataTable, src, { compile });
```

**Headless** — `compile(text, { inputSchema }).run(rows, tables) → { columns, rows, checks, warnings }`.

## License

MIT © Arthur Endlein Correia — Geoscientific Chaos Union (gentropic.org)
