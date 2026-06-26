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
- **cursor** (`cursor.js`) — the backing-AGNOSTIC iteration the scans + result
  views run on, so they aren't welded to the CSV byte-block model. Two methods:
  `eachRecord({dataStart, rows, onProgress}, visit)` — forward-iterate, calling
  `visit(disp, fields, loc0, loc1)` per record (a `rows` subset stops early); and
  `readByLoc(loc0, loc1) → fields[]` — re-read one record for a scattered result
  view. The **locator** `(loc0, loc1)` is opaque to the scans (they only store +
  replay it). `installRecordCursor(source)` adds both to a block source (locator =
  byte offset + length). Any other backing — e.g. a binary table like Datamine
  `.dm` — implements the SAME two methods directly (locator = record index, via
  O(1) record access) and then filter / sort / stats / result-views work on it
  unchanged, with **no decode-to-text intermediate**.
- **viewsource** (`viewsource.js`) — `createRecordViewSource(source, {schema,
  dataStart, cacheBlocks})`: `rowAt(r)` is sync → fields \| `LOADING` (block fetch
  kicked) \| null; blocks fetched on demand into an LRU; `onReady` repaints.
- **detect** (`detect.js`) — `detectKind(sample, {sniff?, force?})` → binary /
  delimited / text + delimiter + header + typed schema. `@gcu/recon` `sniff`
  injectable for richer schema; `force` overrides a wrong guess (incl.
  `force.encoding`). 
- **encoding** — the byte→string decode is a configurable `TextDecoder` label
  threaded on the `source` (`source.encoding`, default `'utf-8'`) through
  `parseFields`/cursor/viewsource via `decoderFor(label)` (cached). Structure
  (delimiter/quote/newline) is ASCII and so encoding-invariant — only field CONTENT
  decodes per the label, so the block index + splitting are unchanged. The harness
  exposes it in the interpretation popover (UTF-8 / Windows-1252 / ISO-8859-1 /
  UTF-16) + a footer **mojibake hint** (a `�` in the sample while on UTF-8 → "try
  Western/Latin-1"; guidance, not auto-detection).
- **filter** (`filter.js`) — `parseFilter(str, columns)` compiles `col OP value`
  terms (`== != > >= < <= ~ !~`, `&&`) to a field-array predicate; `scanFilter`
  iterates via `source.eachRecord` → a **result** `{ offsets, lengths, nums }`
  (the per-match locator loc0/loc1 + original row #); `createResultView(source,
  result, schema)` reads each result row **directly via `source.readByLoc`** with
  its own row LRU. (NOT a remap onto the base view: a selective result is
  scattered, so going through the base's 4096-row blocks would touch one block per
  visible row → LRU thrash. Per-row reads touch only the visible rows.)
- **sort** (`sort.js`) — `scanSortKeys` iterates via `source.eachRecord`,
  extracting the key column(s) + each row's locator, sorts (nulls last, stable),
  returns the same `{ offsets, lengths, nums }` result shape — consumed by the
  same `createResultView`. **Multi-key**: `keys: [{col, dir, numeric}]` sorts by
  each key left-to-right (ties broken by the next); the single-key `{col,dir,numeric}`
  form still works.
- **stats** (`stats.js`) — `scanColumnStats` iterates via `source.eachRecord` for
  a numeric (Welford + capped quantiles) or categorical (top-N + distinct)
  summary, optionally restricted to a filter's `rows`.
- **calc** (`calc.js`) — calculated (read-time derived) columns. `withCalcCursor`
  + `withCalcView` decorate a cursor / browse view to append computed columns; each
  calc is `{ name, type, fn }` with `fn(fieldsSoFar) → value` precompiled by the
  caller (e.g. @gcu/expr's `compile` against `[...baseColumns, ...calcNames]`), so
  @gcu/lamina stays expression-engine-agnostic. Computed left-to-right (a calc may
  reference an earlier calc); the cursor yields RAW values to the scans and
  STRINGIFIED values to result/browse views. Never materialized.
- **provider** (`provider.js`) — adapts a view to `@gcu/loom`'s cell-provider;
  `LOADING` → loom's injected `PENDING`.

### Lens (the saved view) — host-side

A **lens** is a saved *view*, not data: filter · sort · calc-column definitions ·
per-column number format / color-scale / hidden / width · the forced
interpretation (only the bits that differ from auto-detect). It's a small JSON
file with a `{ kind: 'lamina-lens', version, source, … }` marker, saved as
`.lamina` — lamina's only native artifact (it views *other* files), so the
deploy PWA's `.lam`/`.lamina` `file_handlers` carry it. Columns are referenced
**by name** (case-insensitive, as the filter language is), so a lens made on one
export applies to the next with the same schema; names that resolve are applied,
names that don't are **skipped and reported** (no silent mis-apply; an explicit
column-mapping dialog for the rename case is a roadmap item). Color-scale `lo/hi`
are *not* stored (they're data-specific) — recomputed against the new file's
range on apply. Lives in the harness (`tools/lamina/js/app.js`:
`buildLens`/`applyLens`/`applyLensView`/`sniffLens`), not the engine — it's a
composition of the existing view state. Open a `.lamina` with no file loaded →
held pending until a data file mounts.

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

## Security posture (the shipped tool)

The deployed single-file tool (`tools/lamina` → `lamina.html`) is a **Sealed**
artifact in the GCU enterprise-profile sense:

- **Networkless, enforced.** CSP `connect-src 'none'` (egress impossible, not just
  unused); runtime inlined **in the clear** (no `eval` → no `'unsafe-eval'`); and
  **no WebAssembly** (no `'wasm-unsafe-eval'`). The last point is why the shipped
  tool builds against `@gcu/archive`'s **`index.nowasm.js`** variant — the full
  bundle's xz decoder is WASM, which the strict CSP forbids, so `.xz` is dropped
  (every other archive format works). The library itself is archive-agnostic; this
  is a deployment choice.
- **Capability declaration, build-enforced.** The build emits + verifies
  `capability.json` / `csp.txt` / `sbom.json` / a full-file SHA-256 via **`@gcu/seal`**
  (`build.js` lamina target + the network gate in `test/lamina-built-smoke.mjs`),
  failing if a claim is false. Published at `gentropic.org/security`; the empty-state
  banner + footer build-stamp link there. See `tools/lamina/SECURITY.md` (the IT
  one-pager) and `ext/seal/SPEC.md`.

## NOT

- Not editable (that's `@gcu/strata`). Not a database / query engine. Not
  Parquet/Arrow (binary columnar — deferred; would vendor a reader). Not a true
  external-merge sort yet. `zst`/`bz2` are resident-only (no browser streaming
  decoder); `xz` is dropped from the shipped tool (WASM — see Security posture).

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
- **A fuller in-app guide** — beyond the current Filter-syntax / Keyboard /
  About topics, a "where things live" reference: the right-click surfaces
  (header vs cell menu), the kind-badge / Interpretation escape hatch, the
  never-resident scale story, and a short recipes section (filter→sort, stats on
  a filtered set, peek inside a zip). Discoverability — the useful actions are in
  context menus a newcomer won't think to open.
- **Columns panel:** the right-docked slide-out (View → Columns…) ships —
  searchable column list, per-row visibility checkbox + type badge + sampled
  null-rate + a ⋯ menu (the existing per-column actions), bulk show/hide/invert, and
  **drag-to-reorder** (grip handle → a `c.colOrder` layer reconciled by
  `effectiveOrder`, threaded through `_vis`; display-only, app-side, no loom change).
  Pure consolidation of `c.hidden`/`colOrder`/`pinned`/`colFormats`/`colScale`/`gutter`
  state; the grid re-lays-out via loom's own ResizeObserver when `#grid`'s right inset
  changes. Visibility + order + **pinned** + formats + color-scale + width all
  round-trip through a **lens** (by column name).
- **Pin/freeze (shipped):** a 📌 per-row toggle freezes a column on the left so it
  stays visible while you scroll right across a wide model. Built as a real
  **`@gcu/loom`** capability (`pinnedCols` option + `setPinnedCols(n)`): loom freezes
  the first N *display* columns as a non-horizontally-scrolling band (paint splits
  into scrolling-region-clipped-right + frozen-band; every hit-test path —
  `pointToCell`/`colBorderAt`/gutter-brush — is pin-aware; the scroll spacer is
  unchanged). lamina drives it by hoisting pinned columns to the front of the display
  order (`pinnedFirstOrder`) + passing the visible pinned count. **The strata surface
  inherits it for free.** (Grid-header drag-reorder — vs the panel's — is still a
  future loom add; panel-reorder covers the need.)
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
- **File-type association** — `.lam` / `.lamina` are registered via the deploy
  PWA manifest's `file_handlers`; they now carry the **lens** (above), so a
  double-clicked `.lamina` opens lamina and applies the saved view. (Remaining:
  a column-**mapping** dialog for the rename case — today by-name + a skip report.)
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
