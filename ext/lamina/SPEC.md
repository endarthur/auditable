# @gcu/lamina — SPEC

**Open any file, however large, and scroll/filter/sort it — by holding only a
coarse index, never the bytes.**

| | |
|---|---|
| Status | v0.1 (shipped) |
| Deps | none hard; `@gcu/loom` (renderer, via the provider contract), `@gcu/proc` (off-thread scan, injected), `@gcu/archive` (host-side, for archives) |
| Runtime | browser (File / Blob / streams / IndexedDB via the host); pure modules are Node-testable |
| Tests | `test/lamina.test.mjs` (37, in `npm test`) · `test/lamina-smoke.mjs` + `test/lamina-built-smoke.mjs` (browser, not in `npm test`) |

## Lineage

The read-only walking skeleton of the strata-windowing engine
(`spec_inbox/strata-windowing-spec.md`). `RecordViewSource` **is** that spec's
read-only indexed-original `ViewSource`; a windowed `@gcu/strata` later reuses it
as a backing and layers the editable overlay + materialized sort on top. lamina
ships the windowing core early, standalone.

## Premise

A file of *N* records is navigable in O(window) memory if you keep:
1. a **coarse block index** — one byte-offset per *K* records (K = 4096). Size is
   `N/K × 8` bytes ≈ 1 MB at 500M rows. This is the load-bearing decision: the
   index is never the wall, at any realistic scale.
2. a **windowed read** — to show rows `[from, from+count)`, read the covering
   block(s)' bytes (`readRange`), split them into records, slice the window. An
   LRU of a few screenfuls is the only resident data beyond the index.

Everything else (streaming, off-thread, compressed, filter, sort) is built so
those two invariants hold from a memory-sized CSV up to a tens-of-GB block model.

## Data model

- **scan** (`scan.js`) — `createRecordScanner` is chunk-fed (`push`/`end`),
  quote-aware (a `\n` inside a quoted field is not a boundary), CRLF-aware,
  carrying record + in-quote state across chunk edges. Emits a `Float64Array`
  block index + `rowCount` + `totalBytes`. `scanFileToIndex(file)` streams
  `file.stream()` through it (worker-callable). `splitRecords` / `parseFields` are
  the read-time inverse.
- **source** (`source.js`) — `{ kind, delimiter, quote, blockSize, blockOffsets,
  rowCount, totalBytes, readRange(off,len) }`. Three builders, one shape:
  - `buildMemorySource` — resident; `readRange` = subarray.
  - `buildFileSource` — streaming/never-resident; `readRange` = `File.slice`. The
    scan is dependency-injected (`scan`) so it can run off-thread.
  - `buildStreamSource` — the **tape** over a compressed stream (below).
  - `indexOf` / `buildSourceFromIndex` / `fileKey` — the cache primitives.
- **viewsource** (`viewsource.js`) — `createRecordViewSource(source, {schema,
  dataStart, cacheBlocks})`: `rowAt(r)` is sync → fields \| `LOADING` (block fetch
  kicked) \| null; blocks fetched on demand into an LRU; `onReady` repaints.
- **detect** (`detect.js`) — `detectKind(sample, {sniff?, force?})` → binary /
  delimited / text + delimiter + header + typed schema. `@gcu/recon` `sniff`
  injectable for richer schema; `force` overrides a wrong guess.
- **filter** (`filter.js`) — `parseFilter(str, columns)` compiles `col OP value`
  terms (`== != > >= < <= ~ !~`, `&&`) to a field-array predicate; `scanFilter`
  forward-scans → a **result** `{ offsets, lengths, nums }` (byte offset + length
  + original row # per match); `createResultView(source, result, schema)` reads
  each result row **directly by byte offset** with its own row LRU. (NOT a remap
  onto the base view: a selective result is scattered, so going through the base's
  4096-row blocks would touch one block per visible row → LRU thrash. Per-row
  reads touch only the visible rows.)
- **sort** (`sort.js`) — `scanSortKeys` extracts a key column + each row's byte
  position, sorts (nulls last, stable), returns the same `{ offsets, lengths,
  nums }` result shape — consumed by the same `createResultView`.
- **provider** (`provider.js`) — adapts a view to `@gcu/loom`'s cell-provider;
  `LOADING` → loom's injected `PENDING`.

## Architecture — the scaling ladder

| Backing | When | Cost |
|---|---|---|
| resident (memory source) | small/medium | whole file in RAM |
| streaming file source | huge plain file | ~1 MB index; `File.slice` windows |
| off-thread scan (`@gcu/proc`) | the open path | index built in a worker |
| index cache (host sidecar) | reopen | instant (no re-scan) |
| rewindable tape | huge **compressed** entry | one reader + a rolling buffer |

**The tape** (`makeTape`): a deflate/gzip stream can't random-seek, so keep one
decompression reader + a cursor + a rolling tail buffer. `readRange`: in-buffer →
free; forward → inflate ahead; behind the buffer → **rewind** (reopen from 0,
fast-forward). Sequential/near scrolling is cheap; a far jump inflates
proportional to distance (the inherent cost). `openStream()` must return a fresh
decompressed stream from 0 each call (re-openable = rewindable).

**Filter/sort** target the view *interface* and push down through one forward
scan; the result is a permutation array, so they compose (filter then sort the
matches) and are selectivity-bounded (capped, "filter first" rather than OOM).

## NOT

- Not editable (that's `@gcu/strata`). Not a database / query engine. Not
  Parquet/Arrow (binary columnar — deferred; would vendor a reader). Not a true
  external-merge sort yet. `zst`/`xz`/`bz2` are resident-only (no browser
  streaming decoder).

## Deferred

- Stored-zip-entry random windowing (offset-shifted `readRange` — needs an
  `@gcu/archive` range reader).
- Materialize-to-OPFS (true random access for the compressed case, at disk cost)
  + external-merge sort (the decagigabyte sort).
- A worker progress channel (the off-thread scan reports no % today).
- A zran-style snapshot index (bounds the tape's far-seek — needs a custom
  checkpointing inflate; out of scope for now).
- A Works `@gcu/lamina` surface.

### UI / viewer (the formatting+stats slice)

- Per-cell **color + conditional formatting** (value→color scales, data bars,
  thresholds) — needs a loom render addition (`style.color`/`style.fill`; today
  only `style.text`/`highlight`/`invalid` are honored) + a small rules engine.
- **Popup distribution plots** in the stats panel (histogram / t-digest on
  `@gcu/sluice`).
- A **copy-friendly stats render** (clean TSV / Excel paste of a column summary).
- **Toolbar / filter layout polish:** reserve space so the kind-badge popover
  doesn't sit under the toolbar edge; keep the filter box from growing under it;
  fold the apply button into the box; let the filter box grow to multiple lines
  for long expressions.

### Far-ahead (deliberate slices, not soon)

- **Recents list** — persist FSAA `FileSystemFileHandle`s to IndexedDB; show in
  the launcher empty-state + the File menu; re-grant permission on click →
  `buildSourceFromIndex` from the existing index cache = instant reopen. Degrade
  to metadata-only (re-pick) for drag/`<input>`/`file://` (no handle). Pairs with
  the `name:size:mtime` cache key already in place.
- **Multiple windows** — independent tables in their own windows/tabs (each its
  own `current` + cache scope).
- **File-type association** — a marker extension (`.lam` / `.lamina`, following
  the GCU `.gcu` double-extension convention — see `design_gcu_extension_
  convention`) registered via the deploy PWA manifest's `file_handlers`, so a
  double-clicked `data.csv.lam` opens in the installed lamina PWA.
- **numen (MCP) integration** — drive lamina as an agent surface (open a file,
  filter, read a column's stats / a windowed slice), with affordances for
  contrived/headless scenarios.
- **Touch / mobile ergonomics** — the engine is platform-agnostic and, being
  never-resident, a multi-GB file is actually viable on a tablet / phone-via-DeX
  (the index + a few windows are all that's resident; just slower scan I/O). The
  rough edges are interaction: context menus need long-press (today right-click),
  column-resize drag is fiddly on touch (autofit-all covers it), and the toolbar
  wants a narrow-width reflow.

## Versioning

Pre-1.0; the source/view/provider contracts are stable enough that `@gcu/strata`
windowing builds on them, but may still shift. No migration guarantees.
