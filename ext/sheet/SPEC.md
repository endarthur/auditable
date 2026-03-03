# sheet

**Read and write xlsx files in the browser.**

A minimal xlsx IO library. Reads spreadsheets into typed JavaScript arrays. Writes cells with values and optional formula strings back to xlsx. No formula evaluation, no spreadsheet engine -- just the file format.

```js
import { sheet } from './sheet.js';

// read
const workbook = sheet.read(arrayBuffer);
workbook.sheets[0].name;              // "Sales"
workbook.sheets[0].columns.Revenue;   // Float64Array [42000, 38000, 55000]

// write
const bytes = sheet.write({
  sheets: [{
    name: "Results",
    columns: {
      Item: ["Widget", "Gadget"],
      Price: [9.99, 24.50],
      Tax: { values: [1.50, 3.68], formulas: ["=B2*0.15", "=B3*0.15"] },
    }
  }]
});
// bytes is a Uint8Array -- a valid .xlsx file
```

Part of the Auditable ecosystem. Single dependency: fflate (ZIP).

---

## Design Principles

- **Dumb IO.** Read values in, write values out. No formula evaluation, no recalculation engine, no cell dependency tracking. That's Calque's job.
- **Typed arrays.** Numeric columns are `Float64Array`. String columns are `string[]`. Booleans are `Uint8Array`. No wrapper objects per cell.
- **Columnar, not cellular.** The API works with named columns, not A1-addressed cells. The grid is an implementation detail of the file format.
- **Formula strings are opaque.** The writer accepts formula strings (e.g. `"=SUM(A2:A10)"`) but never parses or validates them. The caller is responsible for correctness.
- **Single-file, fflate-only.** Follows the Auditable/atra philosophy.

---

## Reader

### API

```js
const workbook = sheet.read(source);
```

`source` is a `Uint8Array` or `ArrayBuffer` of xlsx bytes.

Returns a workbook object:

```js
{
  sheets: [
    {
      name: "Sheet1",
      columns: {
        Name: ["Alice", "Bob", "Carol"],
        Revenue: Float64Array [42000, 38000, 55000],
        Active: Uint8Array [1, 1, 0],
      },
      headers: ["Name", "Revenue", "Active"],
      rows: 3,
    },
    ...
  ]
}
```

### Column Typing

Each column gets a single type based on the majority of its non-blank values:

| Cell data                        | Column type     | JS representation |
|----------------------------------|-----------------|-------------------|
| Numbers (no date format)         | `number`        | `Float64Array`    |
| Numbers with date format         | `date`          | `Float64Array` (serial numbers) |
| Strings (shared or inline)       | `string`        | `string[]`        |
| Booleans                         | `boolean`       | `Uint8Array` (0/1)|
| Mixed types                      | `string`        | `string[]` (coerced) |

Blanks are `NaN` in numeric columns, `""` in string columns, `0` in boolean columns.

### Date Detection

A numeric cell is treated as a date if its style's `numFmtId` matches:

- Built-in date formats: IDs 14-22
- Custom formats containing date/time tokens: `y`, `m`, `d`, `h`, `s` (but not when part of other patterns like `#,##0`)

Date values remain as Excel serial numbers (days since 1899-12-30, with the 1900 leap year bug preserved). Conversion to JS `Date` objects is the caller's responsibility.

### Header Detection

Row 1 is assumed to be headers. If row 1 contains all strings, those become column names. If row 1 contains non-string values, columns are named by letter (`A`, `B`, `C`, ...).

### Options

```js
const workbook = sheet.read(source, {
  sheet: "Q3 Data",       // read only this sheet (default: all)
  headerRow: 2,           // 1-indexed row for headers (default: 1)
  range: "A1:F100",       // limit to range (default: used range)
});
```

### Read Pipeline

1. **Unzip** via fflate.
2. **Parse `xl/sharedStrings.xml`** -- build string lookup table. Flatten rich text (`<r><rPr>...<t>`) to plain text.
3. **Parse `xl/styles.xml`** -- extract `numFmtId` for each cell style. Build date format set.
4. **Parse `xl/workbook.xml` + relationships** -- discover sheet names and file paths.
5. **Parse `xl/worksheets/sheetN.xml`** -- extract cells, resolve types, build columns.

### Gotchas

- Column references (`B3`, `AA1`) are base-26 with A=1, 1-indexed rows.
- Rows/cells may be omitted if empty -- don't assume contiguous indices.
- Merged cells: value only in top-left cell, others empty.
- Rich text in shared strings: flatten `<r>` runs to plain text concatenation.
- The `numFmtId` for custom formats lives in `xl/styles.xml` under `<numFmts>`, separate from the built-in IDs.

---

## Writer

### API

```js
const bytes = sheet.write(workbook);
```

Returns a `Uint8Array` of xlsx bytes.

### Workbook Structure

```js
{
  sheets: [
    {
      name: "Sales",
      columns: {
        Name: ["Alice", "Bob"],
        Revenue: [42000, 38000],
        Tax: {
          values: [6300, 5700],
          formulas: ["=B2*0.15", "=B3*0.15"],
        },
      },
      // optional
      tables: [{ ref: "A1:C3", name: "SalesTable" }],
    }
  ],
  // optional
  definedNames: [
    { name: "tax", formula: "LAMBDA(amount,rate,amount*rate)" },
  ],
}
```

### Column Formats

Columns accept three shapes:

```js
// plain array -- values only
Revenue: [42000, 38000]

// typed array -- values only, emitted as numbers
Revenue: Float64Array.of(42000, 38000)

// object -- values + formulas
Tax: {
  values: [6300, 5700],
  formulas: ["=B2*0.15", "=B3*0.15"],
}
```

When both `values` and `formulas` are present, the writer emits `<f>` and `<v>` elements for each cell. This produces xlsx files that open instantly (cached values) and remain editable (live formulas).

A formula of `null` in the array means that cell has a value but no formula (baked value).

### Shared Formulas

For columns where many rows share the same formula pattern, pass a shared formula:

```js
Tax: {
  values: [6300, 5700],
  sharedFormula: { base: "=B2*0.15", ref: "C2:C3" },
}
```

The writer emits a shared formula group: `<f t="shared" si="0" ref="C2:C3">B2*0.15</f>` on the first cell, `<f t="shared" si="0"/>` on subsequent cells. Excel fills in the relative references.

### Value Types

The writer infers cell types from JS types:

| JS type      | xlsx type | `t` attribute |
|--------------|-----------|---------------|
| `number`     | number    | (none)        |
| `string`     | string    | `s` (shared string) |
| `boolean`    | boolean   | `b`           |
| `null`       | blank     | (omitted)     |
| `Date`       | number    | (none) + date style |

### Excel Tables

When `tables` is specified, the writer generates Table parts (`xl/tables/tableN.xml`) with:

- Auto-filter on the header row
- `<tableColumn>` entries for each column
- Structured reference support (full mode)
- Calculated column formulas (if the column has formulas)

```js
tables: [{
  ref: "A1:C3",           // table range including header
  name: "SalesTable",     // Excel Table name
  style: "TableStyleMedium2",  // optional, default: TableStyleMedium2
}]
```

### Defined Names

For LAMBDA-based UDFs and named ranges:

```js
definedNames: [
  { name: "tax", formula: "LAMBDA(amount,rate,amount*rate)" },
  { name: "data_range", formula: "Sales!$A$2:$A$100" },
]
```

### Styles

Minimal style support -- enough for correct round-tripping, not a styling engine:

```js
columns: {
  Revenue: {
    values: [42000, 38000],
    format: "$#,##0.00",     // Excel number format code
  },
  HireDate: {
    values: [45000, 45100],
    format: "yyyy-mm-dd",    // date format → triggers date display
  },
}
```

The writer maintains a style table mapping unique format codes to style IDs. No font, border, or fill support in v1.

### Write Pipeline

1. **Collect shared strings.** Deduplicate all string values, build lookup index.
2. **Build style table.** Map unique number format codes to `numFmtId` + `xf` entries.
3. **Emit worksheets.** For each sheet, emit `xl/worksheets/sheetN.xml` with rows and cells.
4. **Emit tables.** For each table, emit `xl/tables/tableN.xml`.
5. **Emit shared strings.** `xl/sharedStrings.xml` with the deduplicated string table.
6. **Emit styles.** `xl/styles.xml` with number formats and cell style cross-references.
7. **Emit workbook.** `xl/workbook.xml` + relationships.
8. **Emit boilerplate.** `[Content_Types].xml`, `_rels/.rels`, `xl/_rels/workbook.xml.rels`.
9. **ZIP.** Package all parts via fflate.

---

## XML Builder

A minimal helper (~50 lines) to avoid drowning in string concatenation:

```js
// tag(name, attrs, ...children)
tag("row", { r: 1 },
  tag("c", { r: "A1", t: "s" }, tag("v", {}, "0")),
  tag("c", { r: "B1" }, tag("v", {}, "42000")),
);

// produces:
// <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42000</v></c></row>
```

Self-closing tags when no children. Attribute values are XML-escaped. Not a general-purpose XML library -- just enough to emit xlsx parts without manual `<` and `>` management.

---

## Utilities

### Cell Address Helpers

```js
sheet.colLetter(0)    // "A"
sheet.colLetter(25)   // "Z"
sheet.colLetter(26)   // "AA"
sheet.colLetter(701)  // "ZZ"

sheet.colIndex("A")   // 0
sheet.colIndex("AA")  // 26

sheet.cellRef(0, 0)            // "A1"
sheet.cellRef(2, 3)            // "D3"
sheet.cellRef(2, 3, true)      // "$D$3" (absolute)
```

These are exported for use by Calque's codegen but are general-purpose.

### Date Conversion

```js
sheet.dateToSerial(new Date(2025, 2, 3))  // 45719
sheet.serialToDate(45719)                  // Date(2025-03-03)
```

Both account for the 1900 leap year bug (serial 60 = Feb 29, 1900, which didn't exist).

---

## Project Structure

```
ext/sheet/
  index.js          -- BUILD OUTPUT (single file)
  build.js          -- bundler (concat in import order)
  SPEC.md           -- this file
  src/
    main.js         -- entry point, public API
    zip.js          -- fflate wrapper (deflate/inflate + zip/unzip)
    xml.js          -- minimal XML builder (tag, escape, selfClose)
    reader.js       -- xlsx reader (unzip, parse XML, build columns)
    writer.js       -- xlsx writer (build XML, emit parts, zip)
    util.js         -- cell address helpers, date conversion
```

---

## Integration

### Auditable

```js
const sheet = await load("@sheet");
const wb = sheet.read(await file("sales.xlsx"));
ui.table(wb.sheets[0].columns);
```

`load("@sheet")` resolves via the standard `@atra/<name>` pattern -- installed modules, dev-mode fallback, or CDN fetch.

### Calque

Calque imports sheet for all xlsx IO. The codegen produces formula strings and cell structures, then hands them to `sheet.write()`:

```js
import { sheet } from '@sheet';

// calque codegen produces this structure
const cells = codegen(ast, layout);

// sheet handles the xlsx file format
const bytes = sheet.write(cells);
```

The boundary is clean: sheet doesn't know about Calque's AST or layout engine. Calque doesn't know about XML or ZIP.

---

## Non-Goals

- **Formula evaluation.** Sheet reads cached values. It never parses or evaluates formula expressions.
- **Full style engine.** No fonts, borders, fills, conditional formatting in v1. Just number formats.
- **Charting.** xlsx chart parts are complex and out of scope.
- **Legacy formats.** No xls (BIFF), no xlsb, no ods. xlsx only.
- **Streaming.** The entire file is in memory. Browser context, reasonable file sizes.
