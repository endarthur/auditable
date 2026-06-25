# @gcu/dm

Read-only reader for **Datamine `.DM`** files — block models, drillholes,
wireframes, strings, points. Zero-dependency, browser-native, windowed (read the
header + any record without loading the whole file).

```js
import { readDM, detectDM, parseHeader, recordRange, decodeRecord } from '@gcu/dm';

// whole-file
const dm = readDM(await file.arrayBuffer());
dm.fields;           // [{ name, type:'number'|'string' }]
dm.recordCount;
dm.getRecord(0);     // { BHID: 'DDH001', FROM: 0, TO: 1.5, ... }
dm.getColumns();     // { FROM: Float32Array, BHID: string[], ... } (missing → NaN)

// windowed (huge files): header off the first page, then any record by offset
const fmt = detectDM(headBytes);            // { precision:'sp'|'ep', byteOrder:'le'|'be' } | null
const h = parseHeader(firstPageBytes, fmt);
const { offset, length } = recordRange(h, i);
const values = decodeRecord(fileSlice, h);  // [v0, v1, …]; numeric|null|string
```

Handles both **SP** (2048-byte pages, Float32) and **EP** (4096-byte, Float64),
either endianness (auto-detected), multi-word alpha fields, file constants
(`SW=0`), and the missing-value sentinel (`±1e30` → `null`/`NaN`).

## Provenance / legal

The format is reverse-engineered from two public, independent sources — VMine.com's
description (explicitly *not* from Datamine/Constellation copyright material) and
Jeremy Maccelari's BSD-licensed ParaViewGeo `dmfile.h` (1999). The `.DM` format is
excluded from copyright under the EU Software Directive. Read-only; no writer.
Full spec + references in `SPEC.md`. MIT.
