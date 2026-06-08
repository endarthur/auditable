# Sheet Module

**Read and write xlsx files in the browser.** Sheet is a minimal xlsx I/O library.
It reads spreadsheets into typed JavaScript arrays and writes cells with values and
optional formula strings back to xlsx. No formula evaluation, no spreadsheet engine
— just the file format.

!!! abstract "Full specification"
    This page is an overview. See
    [`ext/sheet/SPEC.md`](https://github.com/gentropic/auditable/blob/main/ext/sheet/SPEC.md)
    for the complete specification including internals and XML pipeline details.

---

## Quick Start

Load the module:

```js
const sheet = await load("@sheet")
```

### Reading a file

Use `file()` to open a file picker, then pass the bytes to `sheet.read()`:

```js
const sheet = await load("@sheet")
const f = await file(".xlsx")
const workbook = await sheet.read(f.data)

ui.display(workbook.sheets[0].name)
ui.table(workbook.sheets[0].columns)
```

### Writing a file

Build a workbook object and pass it to `sheet.write()`:

```js
const sheet = await load("@sheet")

const bytes = await sheet.write({
  sheets: [{
    name: "Results",
    columns: {
      Item: ["Widget", "Gadget"],
      Price: [9.99, 24.50],
      Tax: { values: [1.50, 3.68], formulas: ["=B2*0.15", "=B3*0.15"] },
    }
  }]
})

std.download(bytes, "results.xlsx")
```

---

## Reading: `sheet.read(source, options?)`

Parses an xlsx file and returns a promise that resolves to a workbook object.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | `Uint8Array` or `ArrayBuffer` | The xlsx file bytes |
| `options` | object (optional) | Read options (see below) |

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sheet` | string | all sheets | Read only the named sheet |
| `headerRow` | number | `1` | 1-indexed row to use as column headers |
| `range` | string | used range | Limit to a cell range (e.g. `"A1:F100"`) |

**Returns** a workbook object:

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
      formulas: { Revenue: [null, null, null] },  // if any formulas present
      colLetterMap: { A: "Name", B: "Revenue", C: "Active" },
    }
  ]
}
```

### Column Typing

Each column gets a single type based on the majority of its non-blank values:

| Cell data | Column type | JS representation |
|-----------|-------------|-------------------|
| Numbers (no date format) | `number` | `Float64Array` |
| Numbers with date format | `date` | `Float64Array` (serial numbers) |
| Strings (shared or inline) | `string` | `string[]` |
| Booleans | `boolean` | `Uint8Array` (0/1) |
| Mixed types | `string` | `string[]` (coerced) |

Blanks are `NaN` in numeric columns, `""` in string columns, `0` in boolean columns.

### Header Detection

Row 1 is assumed to be headers. If all row 1 values are strings, those become column
names. If row 1 contains non-string values, columns are named by letter (`A`, `B`,
`C`, ...). Override with the `headerRow` option.

### Date Handling

Date values remain as Excel serial numbers (days since 1899-12-30, with the 1900
leap year bug preserved). Use `sheet.serialToDate()` to convert to JS `Date` objects:

```js
const wb = await sheet.read(data)
const dates = wb.sheets[0].columns.HireDate  // Float64Array of serial numbers
const jsDates = Array.from(dates, d => sheet.serialToDate(d))
```

---

## Writing: `sheet.write(workbook)`

Produces a valid xlsx file from a workbook object.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `workbook` | object | Workbook structure (see below) |

**Returns** a `Promise<Uint8Array>` of xlsx bytes.

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

// object -- values + formulas + optional format
Tax: {
  values: [6300, 5700],
  formulas: ["=B2*0.15", "=B3*0.15"],
  format: "$#,##0.00",  // optional Excel number format code
}
```

When both `values` and `formulas` are present, the writer emits both `<f>` and `<v>`
elements. This produces files that open instantly (cached values) and remain editable
(live formulas).

A formula of `null` in the array means that cell has a value but no formula.

### Value Types

The writer infers cell types from JS types:

| JS type | xlsx type | Notes |
|---------|-----------|-------|
| `number` | number | |
| `string` | shared string | |
| `boolean` | boolean | |
| `null` | blank | Cell omitted |
| `Date` | number + date style | Auto-converted to serial number |

### Shared Formulas

For columns where many rows share the same formula pattern:

```js
Tax: {
  values: [6300, 5700, 4200],
  sharedFormula: { base: "=B2*0.15", ref: "C2:C4" },
}
```

Excel fills in relative references automatically. More efficient than per-cell
formulas for large sheets.

### Excel Tables

Generate structured Excel Tables with auto-filter:

```js
tables: [{
  ref: "A1:C100",
  name: "SalesTable",
  style: "TableStyleMedium2",  // optional, this is the default
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

### Number Formats

Apply Excel number format codes via the `format` property on column objects:

```js
columns: {
  Revenue: {
    values: [42000, 38000],
    format: "$#,##0.00",
  },
  HireDate: {
    values: [new Date(2025, 0, 15), new Date(2025, 2, 3)],
    format: "yyyy-mm-dd",
  },
}
```

!!! note "Style support"
    Only number formats are supported. No fonts, borders, fills, or conditional
    formatting.

---

## Utility Functions

### Cell Address Helpers

```js
sheet.colLetter(0)           // "A"
sheet.colLetter(25)          // "Z"
sheet.colLetter(26)          // "AA"

sheet.colIndex("A")          // 0
sheet.colIndex("AA")         // 26

sheet.cellRef(0, 0)          // "A1"
sheet.cellRef(2, 3)          // "D3" (column 2, row 3)
sheet.cellRef(2, 3, true)    // "$D$3" (absolute reference)

sheet.parseRef("B3")         // { col: 1, row: 2 } (0-indexed)
```

### Date Conversion

```js
sheet.dateToSerial(new Date(2025, 2, 3))  // 45719
sheet.serialToDate(45719)                  // Date(2025-03-03)
```

Both account for the 1900 leap year bug (serial 60 = Feb 29, 1900, which didn't
exist).

---

## File Input with Widgets

Use `ui.upload()` or `ui.drop()` to create persistent file picker widgets that
read binary data for sheet:

### Upload Button

```js
const sheet = await load("@sheet")

const f = ui.upload("spreadsheet", { accept: ".xlsx", as: "arrayBuffer" })
if (f) {
  const wb = await sheet.read(f.data)
  ui.table(wb.sheets[0].columns)
}
```

### Drop Zone

```js
const sheet = await load("@sheet")

const f = ui.drop("drop xlsx here", { accept: ".xlsx", as: "arrayBuffer" })
if (f) {
  const wb = await sheet.read(f.data)
  ui.table(wb.sheets[0].columns)
}
```

!!! tip "Binary reads"
    Pass `as: "arrayBuffer"` to `ui.upload()` or `ui.drop()` so that `f.data` is
    an `ArrayBuffer` suitable for `sheet.read()`. The default `as: "text"` won't
    work for xlsx files.

---

## Round-Trip Example

Read an xlsx, modify a column, and write it back:

```js
const sheet = await load("@sheet")

// read
const f = ui.drop("drop xlsx", { accept: ".xlsx", as: "arrayBuffer" })
if (!f) return

const wb = await sheet.read(f.data)
const s = wb.sheets[0]

// add a computed column
const revenue = s.columns.Revenue
const taxValues = Array.from(revenue, v => v * 0.15)

// write back with formulas
const bytes = await sheet.write({
  sheets: [{
    name: s.name,
    columns: {
      ...s.columns,
      Tax: {
        values: taxValues,
        sharedFormula: { base: "=B2*0.15", ref: `C2:C${revenue.length + 1}` },
      },
    },
  }]
})

std.download(bytes, "with-tax.xlsx")
```

---

## Non-Goals

- **Formula evaluation.** Sheet reads cached values. It never parses or evaluates
  formula expressions.
- **Full style engine.** No fonts, borders, fills, or conditional formatting.
  Just number formats.
- **Legacy formats.** No xls (BIFF), no xlsb, no ods. xlsx only.
- **Streaming.** The entire file is in memory. Designed for browser-sized files.
