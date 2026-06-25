# @gcu/lamina

Open **any** file — even a multi-gigabyte one — and scroll, filter, and sort it.
Windowed, read-only, offline. Delimited → grid, text → lines, binary → hex
handoff; reads inside `zip` / `tar` / `gz` / `zst` / `xz` / `bz2`, and windows
huge **compressed** entries without unpacking to disk.

The name: *lamina* — the finest stratum, a thin slice. lamina shows you thin
slices (windows) of a file you could never hold whole.

## Why

Spreadsheets choke at ~1M rows; editors choke at a few hundred MB; "big data"
tools want a server. A block model export, a drillhole dump, a log can be tens of
GB. lamina opens it **instantly** and lets you *scroll and filter*, because it
never holds the file — only a coarse index and a few screenfuls of rows.

It's the read-only walking skeleton of the strata windowing engine: the same
`ViewSource` a windowed [`@gcu/strata`](../strata) reuses and grows an editable
overlay on top of.

## How it scales

- **Coarse block index** — one byte-offset per *K* records (K = 4096), not per
  record. ~1 MB even at 500M rows. The index is never the wall.
- **Never resident** — a streaming scan builds the index from `File.stream()`,
  discarding chunks; windows are served lazily by `File.slice`.
- **Off the main thread** — the index scan runs in a `@gcu/proc` worker (the tab
  stays live while a tens-of-GB index builds); inline fallback on `file://`.
- **Instant reopen** — the index is cacheable (a host-supplied sidecar).
- **Compressed, no disk** — a rewindable *tape* (one decompression reader + a
  rolling buffer) windows a huge `.gz` / zip entry: forward scroll is cheap, a far
  jump rewinds. No RAM or disk blow-up.
- **Filter / sort** — a forward scan yields a row-order array; a thin remap view
  reuses all the windowing machinery. Decagigabyte-safe (selectivity-bounded;
  filter→sort composes for the rest).

## Quickstart

```js
import {
  detectKind, buildFileSource, createRecordViewSource,
  createLaminaProvider, parseFilter, scanFilter, createFilteredViewSource,
} from '@gcu/lamina';
import { createGrid, PENDING } from '@gcu/loom';

const file = /* a File from a drop / picker / vfs.toFile(path) */;
const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
const d = detectKind(head);                                  // kind + delimiter + schema + header

const source = await buildFileSource(file, { kind: d.kind, delimiter: d.delimiter });
const vs = createRecordViewSource(source, { schema: d.schema, dataStart: d.hasHeader ? 1 : 0 });
const grid = createGrid(el, createLaminaProvider(vs, { PENDING }), { readOnly: true });

// filter
const matches = await scanFilter(source, { predicate: parseFilter('grade > 1', d.schema), dataStart: 1 });
createGrid(el, createLaminaProvider(createFilteredViewSource(vs, matches), { PENDING }), { readOnly: true });
```

A complete host (file pick, detection, archives, filter box, header-sort,
go-to-row, interpretation override, the index cache) lives in
[`tools/lamina`](../../tools/lamina) — the standalone app, deployed at
**gentropic.org/lamina**.

## API

| Function | Purpose |
|---|---|
| `detectKind(sample, {sniff?, force?})` | kind / delimiter / header / schema from a head sample; `force` overrides a wrong guess |
| `createRecordScanner(opts)` · `scanRecords` · `scanFileToIndex(file, opts)` | the chunk-fed record-boundary scanner → block index |
| `splitRecords(bytes, opts)` · `parseFields(recordBytes, opts)` | read-time record + field splitting |
| `buildMemorySource(bytes, opts)` | a resident source (small/medium files, tests) |
| `buildFileSource(file, {…, scan?})` | a streaming, never-resident source; `scan` injects an off-thread scanner |
| `buildStreamSource({openStream, index?, …})` | the rewindable tape over a compressed stream |
| `buildSourceFromIndex(file, index)` · `indexOf(source)` · `fileKey(file)` | index caching primitives |
| `createRecordViewSource(source, {schema, dataStart, cacheBlocks?})` | the windowed view (`rowAt` → fields \| `LOADING` \| null; LRU; `onReady`) |
| `parseFilter(str, columns)` · `scanFilter(source, opts)` → `{offsets,lengths,nums}` · `createResultView(source, result, schema)` | filter: predicate → matching rows (byte positions) → per-row result view |
| `scanSortKeys(source, {col, dir, numeric, rows?, …})` → `{offsets,lengths,nums}` | sort: key scan → ordered result (same shape, consumed by `createResultView`) |
| `scanColumnStats(source, {col, numeric, rows?, …})` | one-pass column summary — numeric (count/nulls/min/max/mean/std/sum + quantiles) or categorical (distinct + top-N); `rows` restricts to a filter's matches |
| `createLaminaProvider(vs, {PENDING})` | adapt a view to the `@gcu/loom` cell-provider contract |

## Limitations

- **Read-only.** No editing — an editable overlay is `@gcu/strata`'s job.
- **Sort is in-memory + capped** (~few-M rows). A true decagigabyte sort is
  external-merge-to-OPFS (deferred); until then, filter→sort handles huge files.
- **`zst` / `xz` / `bz2` are resident-only** — no browser streaming decoder
  (unlike gzip/deflate), so they're size-guarded.
- **Stored-zip-entry random windowing** and a **worker progress channel** are
  deferred (see `SPEC.md`).

## License

MIT.
