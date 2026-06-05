# @gcu/over

**OVER — Ordered/Vectorized Expression Runner.** A row-wise table-transform DSL:
faithful **compat** with Datamine Studio's EXTRA, plus a **native** superset that's
typed, unit-aware, null-aware, window-capable, multi-table, and auditable.

> *The extra that went over the top.*

OVER is the foundational table verb — **map each row to a new row** — with filter
and project bolted on. It's one more dialect for the GCU stack, **never a
replacement**: like `adder` (Python) and `soft` (English), it lowers through
`@gcu/air` to the same fast, auditable IR. A geologist who thinks in EXTRA gets an
on-ramp; everyone else keeps their JS/adder derived columns.

```
# domain-relative grade, classify, project — schema resolved before any row runs
FE_N    = FE / mean(FE) over LITHO
ORETYPE = match FE { >=64:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }
DENSITY = lookup(densities, LITHO)
saveonly(IJK, FE, FE_N, ORETYPE, DENSITY)
```

**Status: design only — no code yet.** The design of record is **[`SPEC.md`](./SPEC.md)**
(architecture, dialects, syntax, the phased superset roster, open questions). This
is the artifact under active discussion; the lexer/parser/lowerer come after the
v0 scope is settled.

## License

MIT © Arthur Endlein Correia — Geoscientific Chaos Union (gentropic.org)
