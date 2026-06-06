# @gcu/over — SPEC (design, draft)

**OVER — Ordered/Vectorized Expression Runner.** A row-wise table-transform DSL:
faithful **compat** with Datamine Studio's EXTRA, and a **native** superset that's
distinctly ours. *(The extra that went over the top.)*

| | |
|---|---|
| **Package** | `@gcu/over` |
| **Version** | 0.1.0 — **design only, no code yet** |
| **Status** | Draft spec — the artifact we iterate on before building |
| **Build (planned)** | concat (like the other ext libs) |
| **Lowers via** | `@gcu/air` (a frontend alongside adder + soft) |
| **Produces** | a `@gcu/strata` / Workbench table→table transform |
| **Uses (native)** | `@gcu/sluice` (windows), `@gcu/units` (units), `@gcu/sift` (filter predicates) |
| **Lineage** | Datamine Studio EXTRA (EXpression TRAnslator); origin jot: `spec_inbox/strata-extra-spec.md` |

---

## 1. What it is — and what it is NOT

OVER is the foundational table verb — **map each row to a new row** — with
**filter** (drop rows) and **project** (select columns) bolted on, plus a little
control flow and a mining-domain function set. Datamine had this (as EXTRA)
decades before dplyr/SQL named mutate/filter/select.

**It is one more dialect, never a replacement.** strata's formulas are JS/adder
via AIR; OVER is *composition* — a familiar-syntax frontend for the same engine,
the way `calque` is for Excel people and `adder` is for Python people. A geologist
who thinks in EXTRA gets an on-ramp; everyone else keeps their JS derived columns.
OVER earns its place by what it adds (below), not by displacing anything.

**Two jobs:**
1. **Replay real Datamine EXTRA** (`compat` dialect) — bring existing `.dm`
   transforms into the GCU world. *Translation, not emulation* (cf. the `.ipynb`
   bridge, `calque` xlsx, OMF import).
2. **A nice modern table-transform DSL** (`native` dialect, the default) — typed,
   unit-aware, null-aware, window-capable, multi-table, auditable.

---

## 2. Architecture — a thin frontend on machinery we already have

OVER is deliberately **not** the standalone lexer→parser→evaluator the origin jot
sketched. The stack already has the layers it needs:

```
OVER text → lex → parse → AST → schema pass → lower to AIR → V8-hinted JS
                              │                     │
                       (auditable core)      (window/filter/project/emit driver)
```

- **Lower to AIR** (`window._airRegisterLowerer('over', lowerOver)`), exactly like
  adder and soft. OVER's semantics (everything-is-float in compat, relational →
  `1.0`/`0.0`, absent propagation) become *lowering rules*, not a new runtime. It
  inherits type propagation + V8-hinted emission for free.
- **The per-row body** lowers to a row function `(row, ctx) → row`. The **driver**
  wraps it with the stream concerns: filter (`delete`), early-out (`exit`),
  projection (`keep`/`saveonly`/`erase`), windows (two-pass), and `emit` (1→many).
- **The static schema pass** is the auditable core (§5): the output column shape is
  a pure function of `(text, input schema, dialect)`, resolved *before any row
  runs* — so the UI previews the result, and the transform is lintable +
  serializable (an upgrade over strata's opaque `new Function` derived columns).
- **The dialect object** (§4) is read only by the lexer + schema pass; the lowered
  body is dialect-agnostic apart from the absent rule. Compat vs native costs ~nothing.

**One compiled artifact, three homes:** a compiled OVER transform is a
`(table) → table` function, usable as (a) a notebook tagged template
`` over`…`(rawTable) ``, (b) a **strata** surface "Transform…" action (with the
schema-pass preview), and (c) a **Workbench/flowsheet** node (table in → table out).

---

## 3. Design invariants

- **Static output schema.** Evaluation never invents a column; the shape is
  resolved up front (§5). The auditable win.
- **Auditable AST.** Because OVER lowers through AIR (not `new Function`), every
  transform is schema-resolvable, lintable, serializable (persist/travel as a
  recipe), *and* fast. strata's JS derived columns are opaque; OVER's aren't.
- **Row-wise core, opt-in width.** Statements run per record, top to bottom.
  Aggregation/ordering enters only through explicit `over` windows (§7) and `emit`;
  the pure-row path stays simple.
- **Provenance preserved across dialects.** A field keeps its original `.dm` name
  (if any) as metadata even when renamed in native mode — a legacy `FE_OK` can gain
  a human label without losing lineage.
- **Real types + real null in native; float + sentinel in compat.** The superset
  doesn't compromise faithful replay.

---

## 4. Dialects

Selected by a header **pragma**, native is the default (no auto-detect magic):

```
%over compat        # faithful .dm replay — float-only, sentinel absent, 8/24 names…
# (omitted)         → native — the superset
```

```ts
interface Dialect {
  name: string;
  // field NAME rules (the "8/24" rule)
  maxFieldNameLength: number | null;   // 8 (.dm) | 24 (extended) | null (native)
  fieldNameCase: "upper" | "preserve"; // .dm forces uppercase
  fieldNameCharset: RegExp;
  // alpha (string) storage
  alphaQuantization: number;           // 4 => widths round to 4 bytes; 1 => exact
  defaultAlphaSize: number;            // 4 in .dm (silent-truncation footgun)
  alphaOverflow: "truncate" | "error";
  // numeric semantics
  booleanRepresentation: "float" | "bool";
  absentValue: number;                 // sentinel for missing numeric (compat; TBD exact .dm value)
  absentPropagates: boolean;
  // native extensions toggles
  realTypes: boolean;                  // int/bool/string/category/date vs float+alpha
  unitsAware: boolean;
  // provenance
  preserveOriginalFieldName: boolean;
}
```

`DATAMINE_CLASSIC` (8-char upper, alpha-4, sentinel absent, float-only) ·
`DATAMINE_EXTENDED` (= classic, 24-char) · `STRATA_NATIVE` (unlimited names,
preserve case, exact alpha, `error` overflow, real types, units-aware). Presets in
the origin jot; carried forward here.

---

## 5. The schema pass (the auditable core)

Walk the AST once, before any data:

1. Seed output schema = input schema (subject to `keep`/`saveonly`/`erase`).
2. Each `Assignment` with a type/unit spec declares/redeclares its field (validated
   against the dialect name rules); without a spec the field must already exist,
   else it's an implicit numeric/inferred-type column. `let` targets are scratch —
   excluded from the output schema.
3. Clone specs copy an existing field's type.
4. Resolve `keep`/`saveonly`/`erase` against the accumulated schema → final projection.
5. Emit the resolved, ordered, typed (and unit-bearing) column list **without
   evaluating a row** — for preview/validation in the UI.

---

## 6. Syntax

### 6.1 Lexical
- **Identifiers** — bare tokens (`FE`, `SiO2`, `ORETYPE`).
- **Quoted column names** — **backticks** for non-identifier columns:
  `` `Au (g/t)` ``, `` `domain 😅` ``. (Forced choice: `"…"` is string *values*,
  `[…]` is clone-spec; backticks are the pandas/R/dplyr/PRQL standard.)
- **Strings** — `"HEMATITE"`. **Numbers** — `62`, `0.12`. **Comments** — TBD
  (align with the cell idiom).

### 6.2 Statements (compat core — real EXTRA)
```
X = expr                         # assignment ( = ); equality is ==, not-equal !=
if (test) … elseif (test) … else … end
keep(A, B)  saveonly(A, B)  erase(C)      # projection (field NAMES, not exprs)
delete      exit                          # drop this row / stop the stream
```

### 6.3 Operators
Precedence high→low: unary `-`, `* /`, `+ -`, relational (`== != < <= > >=`),
`and`, `or`. Parens override. Logical NOT is `not(expr)`. Relational/logical yield
`1.0`/`0.0` (compat) or real `bool` (native).

### 6.4 Native additions (the superset — see §8 for phasing)
```
HIGRADE: bool = FE >= 62                  # real types
GRADE: g/t                               # units (carried + checked)
P: g/t default 0                          # a declared per-column default/fill
let ratio = SiO2 / FE                     # scratch temp (not in output schema)
FE = FE ?? default(FE)                    # null-coalesce; `absent` is the null literal
ORETYPE = match FE { >=64:"HEMATITE", >=58:"ITABIRITE", _:"WASTE" }
FE_N = FE / mean(FE) over LITHO           # window / group expression  (§7)
DENSITY = lookup densities.density where densities.litho == LITHO   # join another table
check FE <= 100  "iron over 100%?"        # auditable data QA (§8)
emit { … }                                # one row → many rows (§8)
X = @{ Math.erf(z) }                      # escape hatch — inline adder/JS
```

---

## 7. `over` — windows (the headline; it's the name)

`OVER` is the SQL window keyword, and the language's signature feature. A window
expression computes an aggregate over a group (and optionally an order) and uses it
per row:

```
FE_Z   = (FE - mean(FE)) / std(FE)            # over the whole table
FE_N   = FE / mean(FE) over LITHO             # domain-relative grade
RUNLEN = sum(LENGTH) over BHID order DEPTH    # downhole running length
DECL_W = 1 / count() over (X bin 50, Y bin 50)# cell-declustering weight
```

**Status:** group aggregates + **ordered (running) windows** + **`where`** filters
**SHIPPED** (`agg(expr) over GROUP [order EXPR] [where EXPR]`, GROUP = `all` | `()` |
col | `(col,…)`; aggregates count/sum/mean/min/max/std; two-pass, absent ignored;
ordered → a running value per row in `order`, absorbing the first/prev/next
accumulation idiom; **`prev`/`next`/`first`/`last`** positional accessors (lag/lead/
edge) over an ordered window). Still to come: `bin` grouping (declustering cells).

This **absorbs EXTRA's worst part**: the awkward `first()`/`prev()`/`next()` stream
functions become a principled **ordered window** (`prev(RUNLEN)` → a window lag).
Runtime is a two-pass driver — compute group aggregates (via `@gcu/sluice`'s
mergeable accumulators), then the row pass — and the schema pass still resolves the
output shape. `where` filters a window: `mean(FE) over LITHO where FE > 0`.

---

## 8. Superset roster (phased)

Everything we want, tagged by phase. **v0 / v0.1 are proposals to discuss.**

### Core — **v0**
- Lex/parse/AST + the **schema pass** + lower-to-AIR + the strata transform driver.
- **compat dialect**: faithful EXTRA replay — `=`/`==`/`!=`, `if/elseif/else/end`,
  `keep`/`saveonly`/`erase`, `delete`/`exit`, float semantics, absent sentinel,
  the function roster (§9), the **IJK block-model bridge** (`xyzijk`/`ijknum`/`ijkget`).
- **native basics**: real types (int/float/bool/string/category), **`absent`** null
  literal (backed by strata's mining-null vocab), `let` scratch temps, `??`,
  `match`, **backtick** column names, the dialect **pragma**, per-column `default`.

### The differentiator — **v0.1** (strongly want; adds the two-pass driver)
- **`over` windows** (§7) — group/ordered/filtered windows; the name-justifier.
  *Open: pull into v0 so it's distinctly ours on day one, vs land core first?*

### High practical value — **v1**
- **`lookup` / join — SQL-y, SHIPPED.** One form: `lookup TABLE.valueCol where
  PREDICATE`, where the predicate is an `and` of comparisons between `TABLE.col`
  (qualified ref) and this row's values. **The compiler reads the predicate shape and
  picks the index** (the strategy-by-shape idea, applied to joins): pure equality
  (`densities.litho == LITHO`) → hash; equality + a range pair
  (`domains.from <= DEPTH < domains.to`) → per-eq-key sorted intervals + binary search
  (the geology join: domain-by-depth / desurvey). Half-open `[lo, hi)` is *explicit in
  the predicate* (`<=`, `<`) — nothing inferred. Table injected by name; left-join
  (unmatched → absent); index built once per (table, eq-cols, range-cols), shared
  across value columns. Replaced the positional `lookup()`/`lookup_in()`.
- **aggregating join — SHIPPED** (the natural seam past single-match `lookup`).
  `AGG(args) where PREDICATE` (no `over` — that aggregates THIS table; this aggregates
  ANOTHER). Same predicate machinery as `lookup`, but it **enumerates every match and
  folds it through an accumulator**: `count() / sum / mean / min / max / std /
  wmean(value, weight)`. The predicate shape picks the index just as for `lookup` —
  and a range pair becomes an interval-**overlap** query (`assays.from < TO and
  assays.to > FROM` → ref intervals overlapping this row's `[FROM, TO)`). `overlap` (a
  contextual word in the aggregate args) is the per-match overlap length, so the
  compositing grade-math is one line:
  `GRADE = wmean(assays.fe, overlap) where assays.hole == hole and assays.from < TO and assays.to > FROM`.
  Aggregate args read the matched row via qualified refs (`assays.fe`) and this row by
  bare name; left-join (no matches → absent / count 0). This is OVER's half of
  **compositing** — the grade population; *generating the composite skeleton* (1→many)
  and the algorithm knobs (min length, residuals, domain-honoring) stay a dedicated
  tool that *uses* this join. (The seam: OVER owns join+aggregate; the parameterized
  algorithm doesn't belong in the grammar.)
- **units** propagation + checking (native) — grade math that catches %-vs-g/t.

### Auditable QA + power — **v1/v2**
- **`check` — SHIPPED.** `check [ "label": ] PREDICATE` — an observational validation
  rule. Rows pass through unchanged; each rule accumulates a pass/fail count + the
  first few offending rows into a report returned alongside (`run → { columns, rows,
  checks: [{ rule, passed, failed, sample }] }`; the `over` tag exposes it as a
  non-enumerable `.checks` on the returned rows). It rides existing machinery: the
  schema pass already resolves columns before any row runs (so a rule naming a missing
  column warns statically) and the executor already runs a row fn with a ctx (so
  `check` just adds `ctx.check(id, bool)`). Predicates can use windows / joins / lookups
  (downhole gap = `check FROM == prev(TO) over hole order FROM or …`; coverage =
  `check count() where assays.hole == hole …`). Report shape is a plain count → merges
  trivially for the big-data path. Unlabeled rules are labeled by their predicate text.
  *Next here:* a `require` (halting) severity, and `bin` (grouping).
- **`emit`** — one row → many (compositing skeleton / desurvey / subcell fan-out);
  gated, breaks 1:1. The other half of compositing (the aggregating join is built; this
  generates the skeleton it populates).

### Later / maybe
- Parameterized reusable transforms (`define …(…)` — but the flowsheet already composes).
- Dates/time arithmetic.
- **Byte-faithful `.dm` file I/O** (the binary format, absent sentinel exact value,
  alpha padding) — a *separate format project*, explicitly out of the language scope.

---

## 9. Function registry

A `Map<string, (args, ctx) => value>`, dialect-scoped (native can add without
breaking compat fidelity). Seed roster (from EXTRA):
- **Numeric:** `abs absent acos asin atan atan2 azimuth cos decode default exp
  ijkget ijknum int len log loge logn match max maxia min minia mod modc phi pow
  rais round sin special sqrt tan xyzijk`
- **String:** `concat default field join lcase string substr trim type ucase`
- **Record-selection:** `first last prev next` — **native re-expresses these as
  `over … order …` windows** (§7); compat keeps the functions.
- **Block-model bridge:** `xyzijk(X,Y,Z)` → IJK from model coords; `ijknum(I,J,K)`
  combines indices; `ijkget` extracts — coordinate↔IJK conversion as built-ins,
  straight onto the subcell/IJK addressing model. **v0.**

---

## 10. Open questions

**Compat fidelity (need real Studio-RM docs / `.dm` files):**
1. The inline field-type declaration token (`;a8` / `;[FIELD]` clone forms) — the
   one syntax gap; the dedicated EXTRA examples page wouldn't load. Verify before
   freezing the lexer.
2. The absent sentinel's concrete numeric value (+ display form) for byte fidelity.
3. Character-field padding/re-pad rule on assignment for byte-for-byte `.dm` output.

**Design (ours to decide):**
4. **Windows in v0 or v0.1?** (the name-vs-build-cost tradeoff.)
5. Units enforcement in v0 or v1?
6. Exact `emit` semantics (schema of the emitted rows; how the schema pass handles 1→many).
7. `lookup` syntax + how a transform references another strata dataset (by VFS path? a bound handle?).
8. The pragma's exact spelling + comment syntax (align with the auditable cell idiom).
9. How OVER surfaces in strata (a "Transform…" action) + the Workbench (a node) — wiring detail.

---

## 11. Relationship to the stack

- **strata** — OVER is a table→table transform a user applies; the schema-pass
  preview shows the result columns before committing. Composes with derived columns
  + the view pipeline; does not replace them.
- **AIR** — the third language frontend (after adder/soft). One IR, one emitter.
- **sluice** — the window two-pass uses its mergeable accumulators (parallel-ready).
- **units / sift** — native units carry through; a `delete`/retrieval predicate can
  emit a `sift` spec for the selection/linking contract.
- **Workbench / flowsheet** — an OVER node is a lineage-tracked table transform.

---

## 12. Consumption surfaces + build order

OVER is a **table→table operator**, so its shape differs from a general-purpose
language: one headless library, thin wrappers on top — never a reimplementation
(the plate-engine→surface / strata-model→surface discipline).

**The core — `@gcu/over` library.** `compile(text, { dialect, inputSchema }) →
transform`, where `transform(table) → table`, and the schema pass yields the output
columns *before* running. Pure, Node-testable, like air/adder/sluice.

**Surfaces (each a thin wrapper):**
- **Tagged template** (notebook) — `` over`…`(table) ``, like the `glsl`/`sql`
  tags, + cm6 highlighting + completions. **Not a full cell type**: adder/soft are
  cell types because a cell *is* the program; OVER takes a table in and returns one,
  so "tag applied to a table" is the natural fit. The whole-cell feel is the strata
  action instead.
- **strata "Transform…" action** — point at a table, write OVER, see the schema-pass
  preview, apply → new columns / new table. The GUI surface for the table audience.
- **Workbench / flowsheet node** — OVER as a lineage-tracked transform.
- **AIR `over` lowerer** — engine plumbing, not a surface: the library self-registers
  `window._airRegisterLowerer('over', …)` on load, like adder/soft.

**No bespoke adder adapter.** adder values are JS values; an adder cell `load`s the
library directly. The OVER↔adder direction is the internal `@{ … }` escape hatch
(lowers to AIR, which already hosts adder-lowered expressions).

**Build order** (headless-testable-first, then cheapest validating surface):
1. **Library core, native, row-map first** — lex → parse → AST → schema pass →
   `over` AIR lowerer → driver (filter/project). Node-tested, no browser.
2. **Windows** (still v0) — the two-pass (sluice-aggregate → row pass) onto the driver.
3. **Notebook tag** — thinnest user surface + the cm6/completions integration.
4. **strata "Transform…" action** — preview + apply.
5. **Workbench node** + **compat-dialect fidelity** (when Studio-RM refs surface) — last.
