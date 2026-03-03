# calque

**A spreadsheet language that compiles to xlsx.**

Calque is a minimal, pure-functional, array-oriented language for expressing spreadsheet computations. The source of truth is Calque; "Save as xlsx" is a codegen pass. The exported file opens instantly with correct values AND has editable formulas.

```
Sales {
  name = ["Alice", "Bob", "Carol"]
  revenue = [42000, 38000, 55000]
  tax = revenue * 0.15
  net = revenue - tax
}

Summary {
  grand = sum(Sales.revenue)
  avg = mean(Sales.revenue)
  headcount = count(Sales.name)
}
```

The name is a linguistic term: a *calque* is a structural translation from one language to another. Calque structurally translates human-readable array expressions into Excel's formula language. It also sounds like *calc*.

Part of the Auditable ecosystem. Built for the browser, zero dependencies beyond fflate (ZIP library).

---

## Lineage

- **C** is to the PDP-11 as **Calque** is to xlsx.
- **FORTRAN** = FORmula TRANslator (IBM 704 machine code, 1957)
- **atra** = Arithmetic TRAnspiler (WebAssembly bytecode, 2026)
- **calque** = structural translation (xlsx formulas, 2026)

Same philosophy as atra: single-file compiler, vanilla JS, zero frameworks, hand-rolled parser, browser-native. Different target: xlsx instead of Wasm bytecode. The atra treatment for Excel.

---

## Design Principles

- **C is to PDP-11 as Calque is to xlsx.** Every Calque primitive maps 1:1 to an xlsx formula. If xlsx can't express it, it's not a Calque primitive.
- **Excel's semantics are Calque's semantics.** Error propagation, type coercion, null/blank behavior, date serial numbers (including the 1900 leap year bug) -- all inherited from Excel. The exported file must produce identical results.
- **Broadcasting from shapes, not annotations.** Scalar op scalar -> scalar. Column op scalar -> column. Column op column -> column (same length required -- mismatched lengths error, following Excel's spill behavior). No explicit vectorization keyword or syntax.
- **Zero-keyword default.** A Calque program is a set of `name = expr` bindings. Sheet blocks, layout hints, and imports are the only structural constructs. No `let`, no `var`, no `function`, no `export`.
- **Single-file, zero-dep, browser-native.** Follows the Auditable/atra philosophy.

---

## Syntax

### Bindings

The only statement is `name = expr`. All bindings are immutable.

```
x = [1, 2, 3]
y = x * 2
total = sum(y)
```

Bindings starting with `_` are non-exported: they exist in the Calque runtime but are excluded from the xlsx output. This preserves the zero-keyword aesthetic -- no `export` annotation needed.

```
_raw = import "dump.xlsx"
_cleaned = _raw.Value[_raw.Value > 0]
result = mean(_cleaned)
```

`_raw` and `_cleaned` are intermediate computations. Only `result` appears in the exported spreadsheet.

### Types

No type annotations. Types are inferred from values:

```
n = 42                     -- scalar number (f64)
name = "Alice"             -- scalar string
flag = true                -- scalar boolean
blank = null               -- empty/missing (Excel blank)
col = [10, 20, 30]        -- column (array)
```

### Sheet Blocks

An identifier followed by `{ }` at the top level defines a sheet. Each sheet block becomes a separate sheet in the exported xlsx. A bare file with no sheet blocks is an implicit single sheet, named from the filename.

```
-- bare file: one sheet
data = import "sales.xlsx"
total = sum(data.Revenue)

-- multiple sheets
Sales {
  raw = import "sales.xlsx"
  total = raw.Q1 + raw.Q2
}

Summary {
  grand = sum(Sales.total)
  avg = mean(Sales.total)
}
```

Cross-sheet references use dot notation: `Sales.total` in the `Summary` block compiles to a cross-sheet formula like `=SUM(Sales!C:C)`.

### Table Literals

A `{ }` with named fields where values are equal-length arrays is a table:

```
employees = {
  Name: ["Alice", "Bob", "Carol"],
  Dept: ["Mining", "Geo", "Mining"],
  Salary: [80000, 75000, 92000],
}
```

Column access: `employees.Name`, `employees.Salary`.

Column lengths within a table must match. Mismatched lengths are a compile-time error.

### Ranges

```
idx = 1..100               -- integers 1 to 100
offsets = 0..n-1            -- expression endpoints
```

Ranges produce columns. Combined with broadcasting, they replace most comprehension use cases:

```
n = 100
idx = 1..n
squared = idx * idx         -- [1, 4, 9, ..., 10000]
labels = "Row " & str(idx)  -- ["Row 1", "Row 2", ...]
```

### Lambdas

```
(x, y) -> x + y
(acc, val) -> max(acc, val)
```

Used with `scan`, `rolling`, and user-defined functions. Compile to Excel's LAMBDA when the target supports it.

### Conditionals

```
label = if revenue > 10000 then "big" else "small"
```

Not inherently pointwise or scalar -- broadcasting rules apply based on the shapes of the condition and branches. Compiles to `=IF(B2>10000,"big","small")`.

### Template Strings

Syntactic sugar over `&` (concatenation) and `text()` (formatting):

```
msg = `${name} earned ${revenue:$#,##0.00} in Q1`

-- desugars to:
msg = name & " earned " & text(revenue, "$#,##0.00") & " in Q1"

-- compiles to xlsx:
-- =A2&" earned "&TEXT(B2,"$#,##0.00")&" in Q1"
```

Format specifiers after `:` use Excel's native format codes directly.

### Comments

```
-- this is a comment
```

### Imports

```
data = import "sales.xlsx"                  -- first sheet, header row auto-detected
data = import "sales.xlsx" sheet "Q3 Data"  -- named sheet
```

Imported data becomes a table with typed columns (numbers, strings, booleans, null for blanks). Date detection uses style/format heuristics from the xlsx. Formulas are not evaluated -- only cached values are imported.

### User-Defined Functions

```
tax(amount, rate) = amount * rate
effective(gross, deductions) = gross - sum(deductions)
```

A binding with parameters on the left side is a function. Compiles to Excel defined names with LAMBDA:

```
tax = LAMBDA(amount, rate, amount * rate)
```

Works in Excel 365 and Google Sheets.

---

## Standard Library

Every Calque function has a known xlsx formula emission. The standard library is 1:1 with xlsx functions.

### Reductions

```
sum(col)                   -- SUM
mean(col)                  -- AVERAGE
count(col)                 -- COUNT (skips blanks)
min(col)                   -- MIN
max(col)                   -- MAX
```

### Lookup

```
budget = lookup(employees.Dept, departments.Name, departments.Budget)
-- compiles to: =XLOOKUP(A2, Departments!A:A, Departments!B:B)
```

Optional match mode:

```
bracket = lookup(income, brackets.Min, brackets.Rate, nearest: "below")
```

### Filter, Sort, Unique

```
big = revenue[revenue > 1000]                         -- FILTER
sorted = sort(table, table.Revenue, desc: true)       -- SORT / SORTBY
multi = sort(table, table.Dept, asc, table.Rev, desc) -- multi-key SORTBY
unique_depts = unique(employees.Dept)                  -- UNIQUE
```

### Sequential Computation (Scan)

`scan` walks a column with an accumulator, emitting all intermediate results:

```
cumsum = scan(revenue, 0, (acc, x) -> acc + x)
-- input:  [10, 20, 30, 40]
-- output: [10, 30, 60, 100]

running_max = scan(revenue, 0, (acc, x) -> max(acc, x))
```

Compiles to `=SCAN(0, range, LAMBDA(acc, x, acc + x))`. Works in both Excel 365 and Google Sheets (LAMBDA/SCAN supported since late 2022). In compat mode (targeting LibreOffice/older Excel), scan expressions are baked as static values.

### Windowed Computation (Rolling)

For operations that depend on a neighborhood of inputs rather than an accumulator:

```
moving_avg = rolling(revenue, 5, mean)
```

Codegen depends on target compatibility. OFFSET-based patterns have broad support but are volatile (recalculate on every change). SCAN-based tricks work on 365+/Google Sheets. When no clean formula equivalent exists, rolling expressions emit baked values (only `<v>`, no `<f>`) with a compiler warning.

### String Functions

```
joined = first & " " & last   -- concatenation (&)
code = left(id, 3)            -- LEFT
tail = right(id, 4)           -- RIGHT
sub = mid(name, 2, 3)         -- MID
n = len(name)                 -- LEN
clean = trim(name)            -- TRIM
formatted = text(val, "0.00") -- TEXT
```

### Date Functions

```
d = date(2025, 3, 3)          -- DATE (returns serial number)
y = year(d)                    -- YEAR
m = month(d)                   -- MONTH
dy = day(d)                    -- DAY
now = today()                  -- TODAY

age_days = today() - hire_date -- date arithmetic (scalar subtraction)
deadline = start + 30          -- date + number = date
```

Dates use Excel's serial number system (days since 1899-12-30, with the 1900 leap year bug preserved for round-trip correctness).

### Conditional Functions

```
safe_lookup = iferror(lookup(key, table.ID, table.Value), 0)
safe_na = ifna(lookup(key, table.ID, table.Value), "not found")
```

### Error Model

Excel's error model is inherited: `#N/A`, `#DIV/0!`, `#VALUE!`, `#REF!`. Errors propagate through expressions. Column length mismatches produce `#VALUE!` / `#CALC!`, matching Excel's spill error behavior.

### Type Coercion

Excel's rules: `"42" + 1` -> `43`. Blanks are 0 in arithmetic, empty string in string context. Calque does not fight this -- diverging from Excel would mean the runtime and the exported file produce different results.

### Aggregation Patterns

No dedicated `groupby` in v1. The filter-then-reduce pattern compiles cleanly to `SUMIF`/`SUMIFS`:

```
mining_total = sum(employees.Salary[employees.Dept == "Mining"])
-- compiles to: =SUMIFS(C:C, B:B, "Mining")
```

A dedicated `groupby` would require `UNIQUE` + dynamic ranges or pivot-table output -- a much harder codegen target. The `SUMIF`/`SUMIFS` pattern is sufficient and well-supported.

---

## Layout

The layout engine positions bindings on the xlsx grid. It is **load-bearing for codegen**: column letters in formulas (e.g., `=SUM(Sales!C:C)`) depend on where the layout engine placed each binding. Layout must be resolved before codegen can emit formulas.

### Auto-placement (default)

Column bindings lay out left to right in declaration order. Binding names become the header row (row 1). Data starts at row 2.

```
Sales {
  name = ["Alice", "Bob"]      -- column A
  revenue = [42000, 38000]     -- column B
  tax = revenue * 0.15         -- column C
}
```

Scalar bindings are placed in standalone cells outside the table region.

### Explicit Directives

```
@anchor(A1)
results = { ... }

@right(results, gap: 1)
summary = { Total: sum(results.Revenue) }

@below(results)
notes = { Updated: today() }
```

Anchoring is relational -- positions are defined relative to other blocks, not just absolute grid coordinates. Default strategy: first table at A1, subsequent blocks to the right.

### Tables

Each table-shaped binding becomes an Excel Table object in the export (in full mode: with autofilter dropdowns, structured references, calculated column formulas). Multiple Tables can coexist on one sheet.

**Mutability warning (full mode):** In full mode, calculated columns (e.g., `tax = revenue * 0.15`) become Excel Table calculated columns. If a user manually edits a cell in such a column in Excel, the table silently breaks the formula for that row. The value stops updating. This is an xlsx landmine -- Calque can't prevent it, only document it.

Excel's row-hiding behavior on filter (hides entire sheet rows, affecting side-by-side Tables) is a known cosmetic artifact -- data and formulas remain correct regardless.

### Future: Constraint Solver

The initial layout engine will be simple (left-to-right auto-placement, relational directives). A constraint solver -- potentially ported to atra and compiled to Wasm -- could handle complex multi-table layouts in the future.

---

## xlsx Codegen

Calque compiles to xlsx with both live formulas (`<f>` elements) and pre-computed cached values (`<v>` elements). The Calque runtime evaluates everything first, so the exported file opens instantly with correct values AND has editable formulas.

### Two Modes

**Compat mode (default):** Plain A1-style cell references, no Excel Table objects. Works in Excel (all versions), Google Sheets, LibreOffice. Simpler codegen.

**Full mode:** Excel Tables with structured references (`Sales[Revenue]`, `[@Tax]`), auto-expanding ranges, calculated column formulas. Works in Excel 365 and recent LibreOffice. Not compatible with Google Sheets.

### Codegen Passes

1. **Layout resolution.** The layout engine assigns grid positions (column letters, row numbers) to every binding. This must happen first -- all subsequent passes depend on it.
2. **Bindings -> columns/cells.** Array bindings become table columns. Scalar bindings become standalone cells.
3. **Expressions -> formulas.** Walk the expression AST, emit xlsx formula syntax. Broadcasting determines whether to emit a single-cell formula or a shared formula group.
4. **Stride analysis -> `$` signs.** For shared formulas, the broadcasting dimensions determine which references get `$` (absolute) vs. relative. Stride-0 dimensions -> `$`, varying dimensions -> bare reference.
5. **Cached values.** Pre-computed results from the Calque runtime are emitted as `<v>` elements alongside formulas.
6. **Boilerplate.** Content types, relationships, workbook, styles, shared strings -- the minimal xlsx skeleton.
7. **ZIP.** Package via fflate.

### Target Function Set

**Universal (all versions):** SUM, AVERAGE, COUNT, MIN, MAX, IF, AND, OR, NOT, IFERROR, LEFT, RIGHT, MID, LEN, TRIM, CONCATENATE, TEXT, DATE, YEAR, MONTH, DAY, TODAY, ROUND, ABS, INDEX, MATCH, VLOOKUP, SUMIF, SUMIFS, COUNTIF, COUNTIFS

**Modern (365 + Google Sheets 2022+):** XLOOKUP, XMATCH, FILTER, SORT, SORTBY, UNIQUE, LAMBDA, SCAN, REDUCE, MAP, MAKEARRAY, BYROW, BYCOL, LET, IFS, SWITCH

**Avoid (Excel 365 only, no Google Sheets):** TEXTSPLIT, VSTACK, HSTACK, TOCOL, TOROW, WRAPROWS, TAKE, DROP

### Baked Values Fallback

Expressions that use `rolling` or other constructs without a clean xlsx target emit baked values (no `<f>`, only `<v>`). The compiler warns: "this expression exports as static values, not live formulas."

In compat mode, modern-tier functions (SCAN, LAMBDA, FILTER, etc.) also fall back to baked values for LibreOffice/older Excel targets.

---

## xlsx Reader

The reader handles import ("dumb mode"): values as typed arrays, formulas as optional string annotations. No formula evaluation, no decompilation.

### Read Pipeline

1. **Unzip** via fflate.
2. **Parse `xl/sharedStrings.xml`** -> build string lookup table.
3. **Parse `xl/styles.xml`** -> extract number format IDs for date detection.
4. **Parse `xl/workbook.xml` + relationships** -> discover sheet names and files.
5. **Parse `xl/worksheets/sheetN.xml`** -> extract cells.

### Cell Type Detection

- `t="s"` -> index into shared strings table
- `t="inlineStr"` -> inline `<is><t>` child, flatten rich text to plain text
- `t="b"` -> boolean (0/1)
- `t="e"` -> error value
- No `t` attribute -> number. Check style's `numFmtId`:
  - Built-in date formats (14-22) or custom formats containing `y`, `m`, `d`, `h` -> date serial
  - Otherwise -> plain number

### Gotchas

- Column references (`B3`, `AA1`) are base-26 with A=1, 1-indexed rows
- Rows/cells may be omitted if empty -- don't assume contiguous indices
- Merged cells: value only in top-left cell, others empty
- Rich text in shared strings: flatten `<r><rPr>...<t>` elements to plain text concatenation
- Date serials: days since 1900-01-01, except Excel thinks 1900 was a leap year (Lotus 1-2-3 bug), so dates after Feb 28, 1900 are off by one (effectively epoch is 1899-12-30)

---

## Architecture

xlsx IO lives in `ext/sheet/` -- a standalone module for reading and writing xlsx files, usable without Calque. Calque imports from sheet and adds its language layer (parser, evaluator, codegen) on top. In Auditable, `load("@sheet")` works independently for spreadsheet import/export without the Calque language.

```
                  +-------------+
                  | .calque src |
                  +------+------+
                         | parse (hand-rolled recursive descent)
                         v
                  +-------------+
                  |     AST     |
                  +--+-------+--+
                     |       |
            evaluate |       | codegen
                     v       v
              +---------+ +----------+
              | Runtime  | | calque   |
              | (Typed   | | codegen  |
              | Arrays)  | | (formula |
              |          | | strings) |
              +----+-----+ +----+----+
                   |            |
                   v            v
            +-----------+ +----------+
            | Auditable  | |  sheet   |  <-- ext/sheet/
            | grid view  | |  writer  |
            +-----------+ +----+-----+
                               |
                               v
                          +---------+
                          |  .xlsx  |
                          |  file   |
                          +---------+

              +---------+
              |  .xlsx   |---- sheet reader ----> Table values
              |  file    |     (ext/sheet/)       (dumb import)
              +---------+
```

### Components

**ext/sheet/ (xlsx IO):**

| Component       | Est. Size      | Dependencies |
|-----------------|----------------|--------------|
| ZIP layer       | ~50-100 lines  | fflate       |
| XML builder     | ~50 lines      | --           |
| xlsx reader     | ~400-500 lines | ZIP layer    |
| xlsx writer     | ~400-500 lines | ZIP, XML     |
| **Subtotal**    | **~900-1150**  | **fflate**   |

The sheet writer takes a simple data structure: sheets containing cells, each cell with a value and an optional formula string. It handles the xlsx skeleton (content types, relationships, styles, shared strings, ZIP packaging) but knows nothing about Calque's AST or layout.

**ext/calque/ (language + codegen):**

| Component       | Est. Size      | Dependencies |
|-----------------|----------------|--------------|
| Parser          | ~200 lines     | --           |
| Evaluator       | ~400-500 lines | --           |
| Standard lib    | ~300-400 lines | --           |
| Layout engine   | ~200-300 lines | --           |
| Codegen         | ~300-400 lines | --           |
| **Subtotal**    | **~1400-1800** | **sheet**    |

Codegen walks the AST, emits formula strings with stride-analyzed `$` signs, and hands them to sheet's writer.

### Build Order

1. **ext/sheet/** -- build first, independently useful.
   1. ZIP layer -- vendor fflate, thin wrapper.
   2. xlsx reader (dumb mode) -- immediately useful standalone, tests ZIP layer.
   3. XML builder -- small helper for the writer.
   4. xlsx writer -- cells with values + optional formula strings.
2. **ext/calque/** -- builds on sheet.
   1. Parser -- hand-rolled recursive descent/Pratt parser, like atra's.
   2. Evaluator -- wire AST to TypedArray operations. Working calculator.
   3. Layout engine -- compute grid positions. Load-bearing for codegen.
   4. Codegen -- AST + layout positions -> formula strings. Passes cells to sheet writer.
   5. Auditable integration -- grid renderer, cell type, reactivity hookup.

---

## Project Structure

Both extensions follow the atra pattern: modular source in `src/`, concatenated by `build.js`, single-file output.

```
ext/sheet/
  index.js          -- BUILD OUTPUT (single file)
  build.js          -- bundler
  SPEC.md           -- xlsx IO spec
  src/
    main.js         -- entry point
    zip.js          -- fflate wrapper
    xml.js          -- minimal XML builder helper
    reader.js       -- xlsx reader (dumb import)
    writer.js       -- xlsx writer (values + optional formulas)

ext/calque/
  index.js          -- BUILD OUTPUT (single file)
  build.js          -- bundler
  SPEC.md           -- this file
  src/
    main.js         -- entry point (imports from @sheet)
    parser.js       -- tokenizer + recursive descent parser
    eval.js         -- evaluator (AST -> TypedArray results)
    stdlib.js       -- standard library (1:1 xlsx function map)
    layout.js       -- auto-placer + directive resolver
    codegen.js      -- AST + layout -> formula strings + $ signs
```

---

## Open Questions

- **Reactive model.** How Calque's DAG integrates with Auditable's existing reactivity. Full recompute vs. incremental on input change.
- **`rolling` codegen.** OFFSET-based (broad compat, volatile) vs. SCAN-based tricks (365+ only) vs. always baked.
- **Grid renderer.** What the Auditable cell type looks like -- spreadsheet-style grid, or something else.
- **Round-trip fidelity.** Can a Calque program be recovered from an xlsx file? Probably not in general, but partial decompilation of simple patterns might be feasible.
