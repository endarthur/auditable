# @gcu/parquet

Apache Parquet read + write for the browser, **WASM-free** so Sealed builds
keep their claim. A thin micro-facing wrapper over vendored
[hyparquet](https://github.com/hyparam/hyparquet) (read) +
[hyparquet-writer](https://github.com/hyparam/hyparquet-writer) (write), with a
curated pure-JS codec set.

## Format, briefly

Parquet is **columnar** and **single-table** — one file = one schema. It's split
into **row groups** (row slices), each holding one **column chunk** per column,
each a sequence of **pages**. The **footer** (Thrift metadata) carries the
schema, row-group/column offsets, and **per-column-chunk statistics
(min/max/null)** — which is discovery *and* a spatial index, for free.

## Codecs (all pure JS — no WASM)

| codec | read | write |
|---|---|---|
| UNCOMPRESSED | native | native |
| SNAPPY | native (hyparquet) | native (hyparquet-writer default) |
| GZIP | fflate (sync) | fflate (sync) |
| ZSTD | fzstd | — (no pure-JS encoder; read only) |
| BROTLI / LZ4 | — | — |

The decompress callback hyparquet calls is **synchronous**, so gzip goes through
fflate's `gunzipSync` (not the async `DecompressionStream` we use in `@gcu/gtiff`).
Rare codecs fall through to hyparquet's "unsupported codec" error — honest, not a
misread; add them to `readCompressors` when a real file needs one.

## API

```js
import { parquetInfo, readParquet, readParquetColumns, writeParquet } from '@gcu/parquet';

const info = parquetInfo(arrayBuffer);   // footer ONLY — no page decode
// { rowCount, columns:[{name,type,codec}], rowGroups:[{rowCount, columns:{name:{min,max,nulls}}}], codec, meta }

const rows = await readParquet(arrayBuffer, { columns:['XC','YC','ZC'], rowStart, rowEnd });   // row objects
const cols = await readParquetColumns(arrayBuffer, { columns:['FE'] });                        // whole columns

const bytes = writeParquet({
  columnData: [{ name:'XC', data: xc }, { name:'FE', data: fe }],
  rowGroupSize: 65536,          // micro's spatial-index granularity (1<<16)
  codec: 'SNAPPY',              // or 'GZIP'
  kvMetadata: [{ key:'micro:frame', value: JSON.stringify(frame) }],
});
```

## Why vendor (vs. NIH like @gcu/gtiff)

TIFF is frozen and tiny — worth owning. Parquet is a living spec with a Thrift
footer, Dremel nesting, several encodings, and multiple codecs — huge surface,
exactly where a mature pure-JS library beats a hand-roll (same call as cm6 /
acorn / pdfjs). hyparquet supports column + row-group selection and range reads,
so the streaming/lazy model comes for free.

## Build

`node ext/parquet/build.js` (rollup, terser) → `index.js` (~116 KB self-contained
ESM). Deps live in `ext/parquet/package.json`; `cd ext/parquet && npm install`
before building. Tests: `test/parquet.test.mjs` (round-trips snappy/gzip, reads a
zstd fixture, footer discovery, columnar/subset reads, kvMetadata).

## Roadmap

The micro provider (footer→instant discovery, stream row groups), Parquet as the
project store (Morton-sorted, row-group-aligned to render chunks → the footer bbox
becomes a spatial index), and predicate pushdown (skip row groups by column
min/max). The `.ovr`-style multi-level story stays with `@gcu/gtiff`.
