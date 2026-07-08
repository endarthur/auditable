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

- **Recents list** — SHIPPED (local IndexedDB, permission-gated reopen, transparent
  + clearable + disableable, declared in capability.json/SECURITY.md).
- **"Data smells" panel** — the mojibake hint, generalized into a quiet-bug detector.
  Per-column heuristics on the gutter sample (already computed): **leading zeros lost**
  (raw string `^0\d` but parsed numeric → a sample-ID code silently broken — the
  high-value one), all-null, constant, mixed-type, looks-like-a-date-but-text, stray
  thousands-separators. Pure GUIDANCE (no mutation), surfaced as flags in the columns
  panel + a summary. Extends the encoding-hint pattern; the highest-bet roadmap item
  (catches silent, costly errors). NB leading-zeros needs the RAW field string at
  parse (the numeric type-detection discards it) — detect during the sample scan.
- **Folder as one virtual table** — point at a folder of same-schema exports (a year
  of monthly block models) and window across ALL of them as one concatenated,
  never-resident table. A multi-source cursor: an ordered source list, `rowCount` =
  Σ, a row → (fileIndex, localRow) via a prefix-sum offset map; each file keeps its
  own block index; schema from the first file (validate/union the rest). FSAA
  `showDirectoryPicker` lists the files. Still pure viewing — the block model just
  spans files. Second-highest bet (real geo workflow).
- **Value-scrubber minimap** — a thin rail beside the scrollbar showing the sorted
  column's distribution along its length, so you scrub a 10M-row file straight to a
  value band. NEEDS CAREFUL DESIGN (Arthur flagged): decide what it shows (sort-key
  value-at-position vs a vertical binned histogram; the filtered overlay too?), the
  position↔row mapping (rows are uniform-height so scroll pos = row index), and the
  interaction (click-to-jump vs drag-scrub). Probably a loom hook or an overlay
  beside `#grid`. Someday, only if designed well.
- **Diff two views** — read-only comparison ("what moved?"). The hard part is
  ANCHORING, two modes: **positional** (row N of A vs B — zero-config, for before/after
  the same export; fragile to inserts) and **keyed** (pick key column(s) — IJK /
  hole+from+to / sample-id; survives reorder/insert/delete → true added/removed/
  changed). Shape: open A, "Compare with…" opens B as a SECONDARY source (own block
  index), pick mode + key, tint onto A's view. Never-resident tension = B's key→row
  index (one entry/row — fine for two ~100k exports, needs a cap/hint or "diff the
  current filter only" at 10M rows); diff is selectivity-bounded like the filter.
  Future, needs design. Speculative.
- **Remote windowing via HTTP Range** — point at a URL of a huge file, window it with
  range requests, never downloading the whole thing (`readRange` → a ranged fetch).
  The never-resident model taken to never-local — but it's network egress, so it'd be
  a separate **Connected** lamina (seal verifies "network only for an explicitly
  opened remote file"), NOT the Sealed build. Architecturally trivial; profile-changing.
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
- **Strided/projected `.dm` FILTER — SHIPPED 2026-07-07.** lamina's `eachRecord`
  handed every op the WHOLE record; `.dm` is row-major fixed-width, so a column
  sits at a constant word offset and reads by **striding** (skip the rest, no
  per-row allocation) via `@gcu/dm`'s `readField(dv, h, col, recBase)`. WIRED for
  the FILTER: the DM cursor's `eachRecord({ cols })` decodes only the requested
  field indices (`projectDmRecord`, app.js); `scanFilter` forwards `cols`
  (filter.js, ignored by the CSV backing which decodes full rows anyway);
  `applyFilter` computes the predicate's `@gcu/expr` `deps` → column indices and
  passes them — UNLESS calc columns are present (their formulas may reach any
  column → full decode). **Measured 33.7× on a real 486k-record, 17-column
  Leapfrog `.dm`** (524→16 ms for a 1-column predicate), byte-identical hits;
  verified `experiments/verify-lamina-dm-projection.mjs` (projected count ==
  full-decode count). NB: `@gcu/dm`'s `main.js` export surface had to add
  `readField` (lamina imports the BUNDLE, not the source micro uses).
  **Remaining (smaller wins):** SORT by a key column + the single-column PROFILE
  histogram could project too (the cursor already accepts `cols`); the gutter/
  all-columns scan can't (needs everything). The CSV/text backing can't stride
  (variable-width rows).
- **Project-awareness** (planned, Arthur 2026-07-08) — lamina opens single files
  today; make it read the shared **GCU project standard** (a directory marked by
  `project.json` `{ kind, id, title }` — Works uses it; micro's project folder is the
  rich version: layers + kind subfolders `drillholes/models/clouds/meshes/grids/` +
  sidecars under one FSAA dir handle). lamina should: recognise a project (a dir
  handle with a `project.json`) → **browse its data files** (a tree over the dir,
  honouring the kind subfolders) → open any it can read (`.dm`/`.csv`/`.parquet`/…)
  → save its view as a **`.lamina` lens beside the data**. `kind` is advisory — a
  `kind:'micro'` project is still a folder of readable files lamina can *view* without
  *owning*; that's the point of a shared standard (any GCU tool = a viewer onto any
  GCU project). Rides the same-origin substrate: a project is a directory handle, so
  it's a `gcuOpened` `kind:'directory'` entry → "Open project in lamina ↗" is the same
  no-re-pick handoff as a file. Full design (handoff + projects + the deferred A-Bus
  linked-views layer): `spec_inbox/gcu-opened-handoff-spec.md`.

## Versioning

Pre-1.0; the source/view/provider contracts are stable enough that `@gcu/strata`
windowing builds on them, but may still shift. No migration guarantees.
