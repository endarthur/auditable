# `@gcu/dm` — Datamine .DM File Reader Specification

## Provenance & Legal Context

This specification is derived exclusively from two public, independent sources:

1. **VMine.com format description** by the original format designer (archived at `web.archive.org/web/20200217101321/http://www.vmine.net/vmine/dmformat.asp`). The author explicitly states: *"this description is not taken from the old coding but is reverse-engineered from actual .DM files"* and *"was not taken from any Constellation Software Inc copyright material."*

2. **ParaViewGeo `dmfile.h`** (1999, Jeremy Maccelari, BSD-licensed, `github.com/ObjectivitySRC/PVGPlugins/blob/master/NonBSDPlugins/DataMineReader/dmfile.h`). Released under BSD license by the original author, contributed to ParaView (Kitware/GitLab). Acknowledges *"Many thanks to Ben Heather of Datamine for providing the format specification."*

Additional cross-reference: Isatis.neo public documentation at `docs.dataminesoftware.com/IsatisNeo/Latest/Isatis-Users-Guide/Import-Datamine-Information-about-Datamine-format.html` (published by Datamine/Vela themselves, publicly accessible without authentication).

The `.dm` file format is specifically noted as excluded from copyright protection under the EU Software Directive.

**This package is read-only. No writer.**

---

## 1. Overview

The Datamine `.dm` format is a page-based random-access binary format used for tabular geological data (drillholes, block models, wireframes, strings, etc.). It originated from the G-STAR file structure (British Geological Survey, 1972–73).

There are two sub-formats sharing the `.dm` extension:

| Variant | Page size | Word size | Numeric type | Text per word |
|---------|-----------|-----------|-------------|---------------|
| **Single Precision (SP)** | 2048 bytes | 4 bytes | Float32 | 4 chars |
| **Extended Precision (EP)** | 4096 bytes | 8 bytes | Float64 | 4 chars (wastes 4 bytes) |

Both variants use the same logical structure: page 1 is the **Data Definition (DD)**, pages 2+ contain **data records**.

---

## 2. Page Structure

### 2.1 General

Every page has a fixed size. The **last 16 bytes** (4 words in SP, 2 words in EP) of every page are reserved for legacy security information. These are no longer used and will typically be blank/zero, but they are **not available for data**.

| Variant | Page size (bytes) | Usable bytes | Usable words |
|---------|-------------------|-------------|-------------|
| SP | 2048 | 2032 | 508 (× 4 bytes) |
| EP | 4096 | 4064 | 508 (× 8 bytes) |

### 2.2 Detecting SP vs EP

There is no magic number or explicit version flag. Detection strategy:

1. Read the first 4 bytes as a potential 8-char filename packed into 4-byte words (SP) or as the first half of an 8-byte word (EP).
2. **Heuristic**: Read the file size. If it's a multiple of 4096 but not 2048, it's likely EP. If a multiple of 2048 (but not 4096), it's SP. If both, use field-count validation (see below).
3. **Field-count validation**: Parse the DD under both assumptions. The SP interpretation should yield a sensible `NVAR` (1–256) and the field definitions should contain valid ASCII field names and type codes (`'A   '` or `'N   '`). The EP interpretation will yield garbage under the wrong assumption.
4. **Byte-swap detection**: If neither endianness produces valid field names/types, try byte-swapping (the format may be written on big-endian or little-endian machines). The ParaViewGeo reader includes byte-swap detection.

Recommendation: attempt SP little-endian first (most common), then SP big-endian, then EP little-endian, then EP big-endian. Validate by checking that parsed field names contain printable ASCII and types are `'A'` or `'N'`.

---

## 3. Data Definition (DD) — Page 1

All integer values in the DD are stored as floating-point (Float32 in SP, Float64 in EP) and must be rounded to integer on read.

### 3.1 DD Header

| SP byte offset | EP byte offset | Size (SP) | Content |
|---------------|---------------|-----------|---------|
| 0–7 | 0–3, 8–11 | 8 chars | **File name** (max 8 chars, usually matches filename stem, not case-sensitive) |
| 8–15 | 16–19, 24–27 | 8 chars | **Database name** (legacy, not used) |
| 16–95 | 32–35, 40–43, …, 184–187 | 80 chars | **File description** (free text) |
| 96–99 | 192–199 | 1 word | **Date** as numeric: `10000×year + 100×month + day` |
| 100–103 | 200–207 | 1 word | **NVAR**: Total number of field entries (alpha fields counted as number of 4-byte blocks they occupy) |
| 104–107 | 208–215 | 1 word | **LASTPAGE**: Number (1-based) of the last page in the file |
| 108–111 | 216–223 | 1 word | **LASTREC**: Number of the last logical data record within the last page |

#### EP byte mapping note

In EP, text data occupies only the **first 4 bytes of each 8-byte word**. The remaining 4 bytes are padding/unused. So for an 8-character file name in EP:

- Word 0 (bytes 0–7): chars 0–3 in bytes 0–3, bytes 4–7 unused
- Word 1 (bytes 8–15): chars 4–7 in bytes 8–11, bytes 12–15 unused

Numeric values in EP use the full 8 bytes (Float64).

### 3.2 Field Definitions

Starting immediately after the DD header, field definitions are packed contiguously. Each field definition occupies **28 bytes (7 words) in SP** or **56 bytes (7 words) in EP**.

| Word | SP bytes | EP bytes | Content |
|------|----------|----------|---------|
| 0–1 | 0–7 | 0–3, 8–11 | **Field name** (max 8 chars, padded with spaces) |
| 2 | 8–11 | 16–19 | **Field type**: ASCII `'A   '` (alpha) or `'N   '` (numeric). Only first char matters. |
| 3 | 12–15 | 24–31 | **SW** (Stored Word): Position of this field within a logical data record (1-based). **0 = file constant** (not stored in records; value comes from Default). |
| 4 | 16–19 | 32–39 | **WORDNO**: Word number within a multi-word alpha field. Always 1 for numeric fields. For alpha fields wider than 4 chars: 1, 2, 3, … |
| 5 | 20–23 | 40–47 | **Unused** (was reserved for units-of-measurement code, never implemented) |
| 6 | 24–27 | 48–55 | **Default value** / file constant value. For numeric fields: a Float32/64. For alpha fields: 4 characters. |

**Total number of field definitions** = `NVAR` (from DD header).

The maximum field definition capacity per DD page:

- SP: `(2032 - 112) / 28 = 68` field entries (floor). Since multi-word alpha fields consume multiple entries, the actual number of logical fields may be fewer.
- EP: `(4064 - 224) / 56 = 68` field entries (same count by design).

Newer `.dm` files may support up to 256 field entries total (the format's known upper limit). If `NVAR` exceeds the DD page capacity, additional DD pages may exist — but this is rare and undocumented. The safe assumption for a first implementation is single-page DD.

### 3.3 Reconstructing Fields from Definitions

Alpha fields wider than 4 characters are split across multiple consecutive field definitions sharing the same name but with incrementing `WORDNO` values (1, 2, 3, …). To reconstruct:

1. Group field definitions by name.
2. For groups with `type = 'A'`: sort by `WORDNO`, concatenate the 4-byte text values read from each `SW` position. Total string length = `4 × count` characters.
3. For `type = 'N'`: single entry, one numeric value per record.

**Note**: The constituent words of a multi-word alpha field are **not guaranteed to be contiguous** in the record (i.e., their `SW` values may not be sequential). Always use the `SW` value from each definition to locate the correct position.

### 3.4 Logical Record Length

```
MAXLEN = max(SW) across all field definitions where SW > 0
```

This is the length (in words) of each logical data record.

### 3.5 Records Per Page

```
NRPP = floor(508 / MAXLEN)
```

(508 usable words per page for both SP and EP.)

---

## 4. Data Pages (Pages 2+)

### 4.1 Layout

Each data page contains up to `NRPP` logical records packed sequentially:

```
Record 1: words 0 to MAXLEN-1
Record 2: words MAXLEN to 2×MAXLEN-1
...
Record NRPP: words (NRPP-1)×MAXLEN to NRPP×MAXLEN-1
(unused words, if any)
(last 4 words SP / 2 words EP: security block, skip)
```

### 4.2 Total Record Count

```
totalRecords = (LASTPAGE - 2) × NRPP + LASTREC
```

Where `LASTPAGE` is 1-based (page 1 = DD, page 2 = first data page), and `LASTREC` is the count of records in the final page (1-based).

Wait — clarification on page numbering. The VMine spec says:

- "Number of last page in the file" — this is the 1-based page number. Page 1 is the DD. Page 2 is the first data page.
- "Number of last logical data record within the last page" — 1-based count within that page.

So:

```
totalRecords = (LASTPAGE - 1 - 1) × NRPP + LASTREC
             = (LASTPAGE - 2) × NRPP + LASTREC
```

If `LASTPAGE = 2` (only one data page), then `totalRecords = LASTREC`.

### 4.3 Reading a Record

For record index `i` (0-based):

```
pageIndex = floor(i / NRPP) + 1  // 0-based page index; +1 to skip DD page
recordInPage = i % NRPP

fileOffset = (pageIndex + 1) × PAGE_SIZE + recordInPage × MAXLEN × WORD_SIZE
// +1 because page 1 (DD) is at file offset 0
// actually: pageIndex 0 = page 2 in file = byte offset 1×PAGE_SIZE (SP) or 1×PAGE_SIZE (EP)
```

Simpler:

```
// Page numbers are 1-based. DD is page 1. Data starts at page 2.
// File offset of page P (1-based) = (P - 1) × PAGE_SIZE
dataPageNumber = floor(i / NRPP) + 2   // 1-based
fileOffset = (dataPageNumber - 1) × PAGE_SIZE + recordInPage × MAXLEN × WORD_SIZE
```

For each field in the record:
- Read the word at position `SW - 1` (converting to 0-based) within the record's word array.
- Numeric: interpret as Float32 (SP) or Float64 (EP).
- Alpha: interpret as 4 ASCII characters. For multi-word fields, read each word at its respective `SW - 1` position and concatenate in `WORDNO` order.

---

## 5. Special Numeric Values

| Value | Meaning | Suggested JS representation |
|-------|---------|---------------------------|
| `-1.0e30` | Missing data / undefined | `null` or `NaN` |
| `+1.0e30` | Infinity / "top" | `Infinity` |
| `+1.0e-30` | Trace / below detection limit | A sentinel, e.g. `{ trace: true, value: 1e-30 }` or just preserve as-is with metadata |

For alpha fields, missing data = all blanks (spaces).

When comparing, use a tolerance: `Math.abs(value) > 0.9e30` for the large sentinels.

---

## 6. Byte Order Detection

The format was born on VAX (big-endian) and later used on PCs (little-endian). Files may be either endianness.

**Detection strategy** (from ParaViewGeo):

1. Read `NVAR` from its known DD position under little-endian assumption.
2. If the resulting integer is in range [1, 256] and the field type at the first field definition is `'A'` or `'N'`, accept little-endian.
3. Otherwise, try big-endian (byte-swap all 4-byte or 8-byte words).
4. If neither works, the file is corrupt or not a `.dm` file.

---

## 7. Known File Types (by field name conventions)

The `.dm` format is generic tabular data. The *type* of geological object is determined by which standard field names are present. From the ParaViewGeo reader and Datamine documentation:

| File type | Key fields present |
|-----------|--------------------|
| **Drillhole** | `BHID`, `FROM`, `TO` (and optionally `XCOLLAR`, `YCOLLAR`, `ZCOLLAR`) |
| **Point** | `XPT`, `YPT`, `ZPT` (or `X`, `Y`, `Z`) |
| **String/Polyline** | `XP`, `YP`, `ZP`, `PVALUE` |
| **Block model** | `XC`, `YC`, `ZC`, `XINC`, `YINC`, `ZINC` (or `IJK` indexing) |
| **Wireframe triangles** | `X1PT`, `Y1PT`, `Z1PT`, `X2PT`, `Y2PT`, `Z2PT`, `X3PT`, `Y3PT`, `Z3PT` |
| **Wireframe points** | `XP`, `YP`, `ZP`, `PVALUE` (with `PTN` point number) |
| **Perimeter** | `XP`, `YP`, `ZP`, `PTN`, `TAG` |
| **Section definition** | Specific section geometry fields |
| **Catalogue** | Metadata table |
| **Scheduling** | Mine scheduling data |

The reader does not need to interpret these semantics — just expose the raw table. Type detection can be a separate utility.

---

## 8. Implementation Requirements

### 8.1 Package Identity

- **Name**: `@gcu/dm`
- **License**: CC0 (algorithm transcription) or MIT (original tooling) — Arthur's call.
- **Zero dependencies**. Browser-native. Single file.
- **Works with**: `File` / `ArrayBuffer` / `Uint8Array` input.

### 8.2 API Surface

```typescript
// Core read function
function readDM(buffer: ArrayBuffer): DMFile;

// Return type
interface DMFile {
  /** Original filename from DD header */
  filename: string;
  /** File description from DD header */
  description: string;
  /** Date from DD header (as JS Date or null) */
  date: Date | null;
  /** Detected format: 'sp' or 'ep' */
  precision: 'sp' | 'ep';
  /** Detected byte order */
  byteOrder: 'le' | 'be';
  /** Field descriptors (deduplicated: multi-word alpha fields merged) */
  fields: DMField[];
  /** Total record count */
  recordCount: number;
  /** Read all records into columnar arrays */
  getColumns(): DMColumns;
  /** Read a single record by index (0-based) */
  getRecord(index: number): DMRecord;
  /** Iterate records lazily */
  [Symbol.iterator](): Iterator<DMRecord>;
}

interface DMField {
  /** Field name (trimmed) */
  name: string;
  /** 'N' for numeric, 'A' for alpha */
  type: 'N' | 'A';
  /** True if this is a file constant (SW = 0 for all words) */
  implicit: boolean;
  /** Default/constant value */
  defaultValue: number | string;
  /** For alpha fields: total character width (multiple of 4) */
  width?: number;
}

/** Columnar representation — keys are field names */
type DMColumns = Record<string, Float32Array | Float64Array | string[]>;

/** Single record — keys are field names */
type DMRecord = Record<string, number | string>;
```

### 8.3 Columnar Read Strategy

For large block model files (millions of records), the preferred read path is `getColumns()` which returns typed arrays. This avoids per-record object allocation and integrates naturally with the GCU numeric stack (natra, etc.).

For numeric columns: return `Float32Array` (SP) or `Float64Array` (EP).
For alpha columns: return `string[]`.
For implicit/constant fields: return a single value rather than a full array (or optionally a filled array for API uniformity — implementer's choice, but document the behavior).

### 8.4 Missing Data Handling

In `getColumns()`, map `-1.0e30` to `NaN` in the typed arrays. This allows natural use with standard JS numeric operations (`isNaN()` checks, NaN propagation in arithmetic).

In `getRecord()`, map `-1.0e30` to `null`.

Alpha missing data (all spaces) → empty string `""`.

### 8.5 Error Handling

- Throw `DMFormatError` (extends `Error`) for:
  - File too small (less than one page)
  - No valid SP/EP + endianness combination found
  - `NVAR` out of range
  - `LASTPAGE` inconsistent with file size
- Do **not** throw for:
  - Trailing garbage after last page
  - Security bytes containing unexpected values
  - Field names with non-printable characters (warn, don't crash)

### 8.6 Streaming / Partial Read

Nice-to-have for v2: accept a `DataView` or `ArrayBuffer` slice for the DD page only, parse field definitions, and compute record layout without needing the full file. This enables "header-only" inspection of large files.

---

## 9. Test Strategy

### 9.1 Synthetic Test Files

Create minimal valid `.dm` files programmatically (in the test harness, not as a shipped writer):

1. **SP, 3 numeric fields, 5 records** — basic smoke test
2. **SP, mixed numeric + alpha fields** — test multi-word alpha reconstruction
3. **SP, with file constants (SW=0)** — test implicit field handling
4. **SP, with special values (-1e30, +1e30, +1e-30)** — test sentinel mapping
5. **EP equivalent of test 1** — test format detection
6. **Big-endian SP** — test byte-swap detection

### 9.2 Real-World Validation

Arthur will supply sample `.dm` files from public datasets (Datamine sample projects, geo-logaritmica tutorial files, etc.) for integration testing.

---

## 10. Non-Goals (Explicitly Out of Scope)

- **No `.dmx` support.** The DMX format is new, proprietary, compressed, and undocumented. Don't touch it.
- **No writer.** Read-only.
- **No file type detection.** The reader returns raw tabular data. A separate `@gcu/dm-types` or similar could detect drillhole vs block model vs wireframe by field name conventions, but that's a different package.
- **No coordinate system handling.** `.dm` files don't contain CRS metadata.
- **No multi-page DD.** If `NVAR > 68`, log a warning and read only the first 68 field definitions. This can be extended later if real-world files with >68 fields surface.

---

## 11. References

1. VMine.com — "The Datamine .DM File Format" (archived 2020-02-17): `web.archive.org/web/20200217101321/http://www.vmine.net/vmine/dmformat.asp`
2. ParaViewGeo DataMineReader — `dmfile.h`, Jeremy Maccelari, 1999 (BSD): `github.com/ObjectivitySRC/PVGPlugins/blob/master/NonBSDPlugins/DataMineReader/dmfile.h`
3. Isatis.neo — "Information about Datamine format": `docs.dataminesoftware.com/IsatisNeo/Latest/Isatis-Users-Guide/Import-Datamine-Information-about-Datamine-format.html`
4. Datamine — "Datamine File Formats" (public docs): `docs.dataminesoftware.com/StudioRM/Latest/COMMON/Datamine-File-Format.htm`
