# Calque Module

**A spreadsheet language that compiles to xlsx.** Calque is a minimal, pure-functional,
array-oriented language for expressing spreadsheet computations. The source of truth is
Calque code; xlsx export is a codegen pass. The exported file opens instantly with correct
values *and* has editable formulas.

The name is a linguistic term: a *calque* is a structural translation from one language to
another. Calque structurally translates array expressions into Excel's formula language.

!!! abstract "Full specification"
    This page is an overview. See
    [`ext/calque/SPEC.md`](https://github.com/gentropic/auditable/blob/main/ext/calque/SPEC.md)
    for the complete language specification.

---

## Quick Start

Load calque as a tagged language extension:

```js
const calque = await load("@calque")
```

Use the `calque` tagged template to write and evaluate a program:

```js
const result = calque`
  Sales {
    name = ["Alice", "Bob", "Carol"]
    revenue = [42000, 38000, 55000]
    tax = revenue * 0.15
    net = revenue - tax
  }

  Summary {
    grand = sum(Sales.revenue)
    avg = mean(Sales.revenue)
  }
`

ui.display(result.Sales.net)    // [35700, 32300, 46750]
ui.display(result.Summary.grand) // 135000
```

Compile to xlsx and trigger a download:

```js
const { workbook, warnings } = result.compile()
std.download(workbook, "sales.xlsx")
```

---

## Language Overview

### Bindings

The only statement is `name = expr`. All bindings are immutable.

```
x = [1, 2, 3]
y = x * 2
total = sum(y)
```

Bindings starting with `_` are non-exported: they exist at runtime but are excluded from
xlsx output.

```
_raw = import "dump.xlsx"
_cleaned = _raw.Value[_raw.Value > 0]
result = mean(_cleaned)
```

### Types

Types are inferred from values — no annotations.

| Type | Syntax | Description |
|------|--------|-------------|
| Number | `42`, `3.14` | 64-bit float |
| String | `"Alice"` | Text |
| Boolean | `true`, `false` | Logical value |
| Null | `null` | Empty / blank (Excel blank) |
| Column | `[10, 20, 30]` | Array of values |

### Sheet Blocks

An identifier followed by `{ }` at the top level defines a sheet. Each block becomes a
separate sheet in the exported xlsx.

```
Sales {
  raw = import "sales.xlsx"
  total = raw.Q1 + raw.Q2
}

Summary {
  grand = sum(Sales.total)
  avg = mean(Sales.total)
}
```

Cross-sheet references use dot notation: `Sales.total` compiles to a cross-sheet formula
like `=SUM(Sales!C:C)`.

A bare file with no sheet blocks produces a single sheet.

### Table Literals

A `{ }` with named fields where values are equal-length arrays is a table:

```
employees = {
  Name: ["Alice", "Bob", "Carol"],
  Dept: ["Mining", "Geo", "Mining"],
  Salary: [80000, 75000, 92000],
}
```

Column access: `employees.Name`, `employees.Salary`. Column lengths must match.

### Ranges

```
idx = 1..100
squared = idx * idx         -- [1, 4, 9, ..., 10000]
labels = "Row " & str(idx)  -- ["Row 1", "Row 2", ...]
```

### Conditionals

```
label = if revenue > 10000 then "big" else "small"
```

Broadcasting rules apply based on the shapes of condition and branches. Compiles to
`=IF(B2>10000,"big","small")`.

### Template Strings

Syntactic sugar over `&` (concatenation) and `text()` (formatting):

```
msg = `${name} earned ${revenue:$#,##0.00} in Q1`
```

Format specifiers after `:` use Excel's native format codes.

### User-Defined Functions

```
tax(amount, rate) = amount * rate
effective(gross, deductions) = gross - sum(deductions)
```

A binding with parameters on the left side is a function. Compiles to Excel `LAMBDA`.

### Lambdas

```
(x, y) -> x + y
(acc, val) -> max(acc, val)
```

Used with `scan`, `rolling`, and user-defined functions.

### Comments

```
-- this is a comment
```

### Imports

```
data = import "sales.xlsx"                  -- first sheet, auto-detect headers
data = import "sales.xlsx" sheet "Q3 Data"  -- named sheet
```

Imported data becomes a table with typed columns. Formulas are not evaluated — only
cached values are imported.

---

## Broadcasting

Calque uses shape-based broadcasting with no explicit vectorization keyword:

| Left | Right | Result |
|------|-------|--------|
| Scalar | Scalar | Scalar |
| Column | Scalar | Column |
| Column | Column | Column (same length required) |

Mismatched column lengths produce an error, matching Excel's spill behavior.

---

## Standard Library

Every function maps 1:1 to an xlsx formula.

### Reductions

| Function | Excel formula |
|----------|---------------|
| `sum(col)` | `SUM` |
| `mean(col)` | `AVERAGE` |
| `count(col)` | `COUNT` |
| `min(col)` | `MIN` |
| `max(col)` | `MAX` |

### Lookup

```
budget = lookup(employees.Dept, departments.Name, departments.Budget)
```

Compiles to `XLOOKUP`. Optional match mode:

```
bracket = lookup(income, brackets.Min, brackets.Rate, nearest: "below")
```

### Filter, Sort, Unique

```
big = revenue[revenue > 1000]                         -- FILTER
sorted = sort(table, table.Revenue, desc: true)       -- SORT / SORTBY
unique_depts = unique(employees.Dept)                  -- UNIQUE
```

### Aggregation Patterns

No dedicated `groupby`. The filter-then-reduce pattern compiles to `SUMIF`/`SUMIFS`:

```
mining_total = sum(employees.Salary[employees.Dept == "Mining"])
-- compiles to: =SUMIFS(C:C, B:B, "Mining")
```

### Sequential Computation (Scan)

```
cumsum = scan(revenue, 0, (acc, x) -> acc + x)
-- output: [10, 30, 60, 100]
```

Compiles to `=SCAN(0, range, LAMBDA(acc, x, acc + x))`. Works in Excel 365 and Google Sheets.

### Windowed Computation (Rolling)

```
moving_avg = rolling(revenue, 5, mean)
```

When no clean formula equivalent exists, rolling expressions emit baked values (only
cached values, no live formulas) with a compiler warning.

### String Functions

| Function | Excel formula |
|----------|---------------|
| `left(s, n)` | `LEFT` |
| `right(s, n)` | `RIGHT` |
| `mid(s, start, len)` | `MID` |
| `len(s)` | `LEN` |
| `trim(s)` | `TRIM` |
| `text(val, fmt)` | `TEXT` |
| `str(val)` | `TEXT` (default format) |
| `a & b` | Concatenation |

### Date Functions

| Function | Excel formula |
|----------|---------------|
| `date(y, m, d)` | `DATE` |
| `year(d)` | `YEAR` |
| `month(d)` | `MONTH` |
| `day(d)` | `DAY` |
| `today()` | `TODAY` |

Date arithmetic works via serial numbers: `today() - hire_date` gives days elapsed.

### Math Functions

| Function | Excel formula |
|----------|---------------|
| `round(x)` | `ROUND` |
| `abs(x)` | `ABS` |
| `floor(x)` | `FLOOR` |
| `ceil(x)` | `CEIL` |
| `sqrt(x)` | `SQRT` |
| `log(x)` | `LOG` |
| `exp(x)` | `EXP` |
| `mod(x, y)` | `MOD` |

### Error Handling

| Function | Excel formula |
|----------|---------------|
| `iferror(expr, fallback)` | `IFERROR` |
| `ifna(expr, fallback)` | `IFNA` |

---

## xlsx Codegen

Calque compiles to xlsx with both live formulas and pre-computed cached values.

### Two Modes

**Compat mode (default):** Plain A1-style cell references. Works in Excel (all versions),
Google Sheets, LibreOffice.

**Full mode:** Excel Tables with structured references (`Sales[Revenue]`, `[@Tax]`),
auto-expanding ranges. Works in Excel 365 and recent LibreOffice. Not compatible with
Google Sheets.

### Layout

Column bindings lay out left to right in declaration order. Binding names become the header
row (row 1), data starts at row 2. Explicit placement directives are available:

```
@anchor(A1)
results = { ... }

@right(results, gap: 1)
summary = { Total: sum(results.Revenue) }

@below(results)
notes = { Updated: today() }
```

### Baked Values Fallback

Expressions without a clean xlsx target (e.g., `rolling`) emit baked values — cached
numbers with no live formula. The compiler warns when this happens.

In compat mode, modern-tier functions (`SCAN`, `LAMBDA`, `FILTER`, etc.) also fall back
to baked values.

---

## API Reference

Load calque with `const calque = await load("@calque")`.

### Tagged Template

```js
const result = calque`
  x = [1, 2, 3]
  y = x * 2
`
```

Returns an evaluated result object. Sheet bindings are accessible as properties:
`result.x`, `result.y`, or for sheet blocks: `result.SheetName.binding`.

### `calque(options)`

Curried form with options:

```js
const result = calque({ imports: { data: xlsxData } })`
  cleaned = data.Value[data.Value > 0]
  total = sum(cleaned)
`
```

### `calque.run(source, opts?)`

Evaluate a calque source string:

```js
const result = calque.run(`x = [1,2,3]\ny = sum(x)`)
result.y // 6
```

The result object has a `.compile()` method that returns `{ workbook, warnings }`.

### `result.compile()`

Compile the evaluated result to an xlsx workbook (Uint8Array):

```js
const { workbook, warnings } = result.compile()
std.download(workbook, "output.xlsx")
```

`warnings` is an array of strings for any baked-value fallbacks or compatibility notes.

### `calque.compile(source)`

One-step evaluate + compile:

```js
const { workbook, warnings, result } = calque.compile(`
  x = [1, 2, 3]
  y = x * 2
`)
```

Also works as a tagged template: `calque.compile`\`...\``.

### `calque.parse(source)`

Parse source into an AST without evaluating:

```js
const ast = calque.parse(`x = [1, 2, 3]`)
```

### `calque.lex(source)`

Tokenize source into a token array:

```js
const tokens = calque.lex(`x = sum([1, 2, 3])`)
```

### `calque.grid(result)`

Generate a grid representation for display:

```js
const gridData = calque.grid(result)
```

---

## Standalone Editor

The calque standalone editor is a PWA at `tools/calque/`. Build it with:

```bash
node build.js --target=calque
```

Output: `tools/calque/index.html` — a single HTML file with a canvas-based spreadsheet
grid and a floating CodeMirror 6 editor.

### Features

- Live evaluation: edit calque source, see results instantly in the grid
- Canvas-based spreadsheet grid with virtual scrolling
- Multi-cell selection, inline editing, copy/paste (including from Excel)
- Drag-and-drop .xlsx and .calque files
- Export to xlsx
- Project system with localStorage persistence (up to 20 projects)
- Built-in examples
- Offline support via service worker

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+S | Save project |
| Ctrl+O | Open .calque file |
| Ctrl+N | New project |
| Ctrl+E | Toggle editor / focus |
| F2 | Edit current cell |
| Arrows | Navigate grid |
| Enter / Tab | Move down / right |
| Delete | Clear cell |
| Ctrl+C / Ctrl+V | Copy / paste |
| Alt+T | Create binding from selection |
| Alt+PageUp/Dn | Switch sheet |
