# Librarian

**A BM25F-shaped text search engine for browser-sized corpora.**

Librarian is the search engine that powers Ctrl+K in [Auditable Works](https://github.com/endarthur/auditable) and any future GCU surface that needs in-page text retrieval — command palettes, table search, in-tool help. Pure JS, zero dependencies, designed to be readable end to end and small enough to inline into a single-file deployable.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 0.1                                            |
| Status     | Pre-1.0; shipped 2026-05                       |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | BM25F (Robertson & Zaragoza 2009) + the small-but-capable in-process search engine tradition (Bleve, Lunr, MiniSearch) |

---

## Lineage

Librarian is in the lineage of [Lunr](https://lunrjs.com), [MiniSearch](https://github.com/lucaong/minisearch), and the older [Bleve](https://blevesearch.com): in-process search engines for "this fits in memory" corpora. We could have vendored one of those. Three reasons we didn't:

1. **Single-file deployability.** Lunr and MiniSearch ship ESM + UMD + minified variants and pull in a dependency tree. Librarian is one source file → one bundle → one entry in `/usr/lib/` inside Works. No build dance for downstream consumers.
2. **Naming discipline.** GCU packages have evocative names that tell you the *kind* of thing they are. `Librarian` reads as "the thing in charge of organizing your text"; `MiniSearch` reads as a hedge.
3. **Readability.** ~600 LOC across six files, no minification in the source tree. A new contributor can read the whole engine in an hour.

The scoring model is straight BM25F (Robertson & Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond", 2009) — well-understood, no surprises, decades of empirical validation. We did not invent any retrieval mathematics here.

## Premise

Three commitments drive the design:

1. **Single in-process index.** No worker offload, no IndexedDB, no shard fanout. The full inverted index lives in JS memory, gets built at page load (or pre-built and shipped as JSON), and serves queries synchronously. Targets corpora from ~10 docs (a UI command palette) up to ~10 000 docs (a full project's documentation).
2. **Field-aware ranking.** Title matches should beat body matches. Every doc is a record of named fields, each with its own BM25F boost. A hit in `title` scores 4× a hit in `body` by default; consumers tune.
3. **Honest about misses.** Empty result sets aren't useful by themselves. Librarian always knows what the closest in-vocabulary term *would have been*; that surfaces as the "did you mean?" fallback. Fuzzy expansion (Damerau-Levenshtein within 1–2 edits) catches typos before they become zero-result queries.

## Data model

A **document** is a record:

```js
{ id: <string|number>, ...fields, ...meta }
```

`id` is the doc's identity (must be unique within the corpus). The remaining keys split into two camps based on the `fields` config:

- **Fields** named in the config are tokenised and indexed. Their string content contributes to ranking.
- **Meta** keys (anything not declared as a field, except `id`) are passed through verbatim — preserved on the doc and surfaced on every search hit. Use for file paths, anchors, timestamps, source labels.

A **field config** is `{ boost: number }`. Boost multiplies that field's BM25F contribution to a hit's score. Defaults to 1.

A **synonym table** is `{ term: [synonym, …], … }`. All lowercase; keys and values both. Synonyms expand at query time (no expansion is baked into the index, so updating the table doesn't require re-indexing).

## Index structure

> **Superseded (v2, 2026-06-01).** The nested-`Map` shape below was the v1
> representation and has been **deleted**. The live index is the typed-array CSR
> form documented in `csr.js` — see the "v2 — one engine, not two" section. The
> shape below is retained for historical context only.

The internal shape of a (v1) index (treat as opaque externally; documented here for contributors):

```js
{
  terms: Map<term, {
    df: number,                              // doc frequency
    postings: Map<docId, Map<fieldName, number[]>>,  // positions
  }>,
  docs: Map<docId, {
    id,
    fields: { name: { text, length } },
    totalLen: number,
    meta: object,                            // non-field, non-id keys
  }>,
  fields: { name: { boost } },
  synonyms: { term: [syn, …] },
  stats: {
    totalDocs: number,
    avgLen: number,                          // tokens per doc, averaged
    fieldAvgLen: { name: number },           // tokens per field, averaged
  },
}
```

The postings map is `term → docId → fieldName → [positions]`. Positions are token offsets within the field (used for snippet generation and proximity scoring), not byte offsets — kept compact this way.

`df` is the number of distinct docs containing the term; the BM25 IDF derives from it.

## Tokenization

`tokenize(text)` returns `[{ token, start }, …]` where `start` is the byte offset of the token in the source. Behaviour:

1. **Lowercasing** — applied first.
2. **Splitting** — on whitespace and punctuation. Curly quotes (`’`, `“`, `”`) split like ASCII apostrophes.
3. **Stopword filter** — a small built-in English stopword set (the, a, an, of, in, to, …). Sized to drop function words but not content.
4. **Length filter** — tokens of 1 character are dropped (single letters carry no retrieval signal); 25+ characters are kept (URLs, identifiers).
5. **CJK** — Chinese/Japanese/Korean characters tokenize per-character (since CJK doesn't space-separate words). Imperfect; bigram tokenization is the obvious upgrade.

The same tokenizer runs over both indexed documents and incoming queries — consistency is the only thing that matters for retrieval.

## Scoring

For each query token, expanded to a set via synonyms + fuzzy + prefix:

```
score(d, q) =
    Σ_term ∈ q_expanded   max_expansion ( weight × BM25F(term, d) )
  + Σ_pair (i,j) adjacent_in_d_within_W  ProximityBonus
```

### BM25F per field

```
BM25F(t, d) = Σ_field f   boost_f × IDF(t) × (tf_f × (k1 + 1)) / (tf_f + k1 × (1 - b + b × len_f / avgLen_f))

IDF(t) = log( 1 + (N - df_t + 0.5) / (df_t + 0.5) )
```

with `k1 = 1.5`, `b = 0.75` (the well-tuned BM25 defaults). `len_f` and `avgLen_f` are token counts; `tf_f` is the in-doc term frequency in field `f`.

A hit in a high-boost field (title) contributes its boost as a multiplier — `boost_title × IDF × tf_normalized`. A doc that has the query term in *both* title and body sums the two field contributions.

### Expansion and weights

Each query token's expansions:

- **Self** — weight 1.0
- **Synonyms** — weight 1.0 (treated as full-credit matches)
- **Fuzzy** — weight `1 - 0.3 × distance` (1-edit hits get 0.7, 2-edit 0.4). Only applied if the exact term isn't in the index — exact matches always preferred.
- **Prefix** — weight 0.8 (only for terms ≥ 3 chars, only if exact term isn't in the index).

Per token, the score uses `max(weight × BM25F)` over all its expansions — synonym + fuzzy variants don't double-count.

### Proximity bonus

After per-token scoring, for each doc, all positions of matched terms within that doc are flattened and sorted. Each adjacent pair within `PROXIMITY_WINDOW = 30` tokens adds `PROXIMITY_BONUS = 0.2` to the doc's score. This is what makes `Baker Street` rank above `Baker … Street` (one paragraph apart).

The window value is empirical; chosen to capture "in the same sentence" without rewarding cross-paragraph coincidences.

## Snippets

For each hit, Librarian picks the densest cluster of matches in any one field and emits a `<mark>`-tagged slice of ±80 characters around the first match. The renderer is intentionally simple: it doesn't try to align byte-perfect highlight ranges (token positions don't carry the original token length), just marks a ~30-character region at each hit position.

This keeps snippets readable and the implementation small. If you need pixel-precise highlights, post-process the result text yourself using the `hits` payload.

## Did-you-mean

When `search` returns zero results, the caller can call `suggest(index, query)`. For each query token:

1. Check if it's already in the index → keep as-is.
2. Otherwise, find the closest in-vocabulary term via Damerau-Levenshtein within `maxEdits` (default 2).
3. If a match exists, substitute; else keep the original.

Returns the reconstructed query string. The UI uses this to surface "did you mean: `query`" links — clicking re-runs search with the suggested terms.

## Serialization

`serialize(index)` returns a JSON-safe object; `deserialize(json)` reconstructs an equivalent index. Use case: pre-compute the index at build time and ship the JSON instead of the raw corpus.

The serialized form preserves all term postings, doc fields, doc meta, field configs, synonyms, and stats — round-trippable. Search results from a deserialized index are identical to search on a freshly-built one.

Wire format is JSON; size depends on corpus. A ~600 KB Sherlock Holmes corpus produces an index of roughly 1 MB JSON (a fair bit larger than the source — postings are explicit). Gzip compresses it back to ~250 KB. For most use cases, just shipping the source docs + building the index at page load is simpler; the JSON form pays off for very large corpora or very long pages.

## Performance

A small handful of representative numbers (indicative, not benchmarked exhaustively):

| Corpus | Docs | Tokens | Index build | Query (warm) |
|---|---|---|---|---|
| Auditable docs | 30 | ~50 000 | < 50 ms | < 1 ms |
| Sherlock Holmes (12 stories) | 12 | ~110 000 | ~80 ms | ~2 ms |
| Aesop's Fables (Vernon Jones tr.) | 284 | ~60 000 | ~70 ms | < 1 ms |

Index build is roughly linear in token count. Query time is dominated by fuzzy expansion (which scans the full term dictionary on misses); on the warm path with an exact-term hit, it's microseconds.

## Architecture

```
ext/librarian/src/
  tokenize.js    — tokenize(), tokenizeStrings(); ~120 LOC
  fuzzy.js       — editDistance(), nearTerms(); ~70 LOC
  csr.js         — buildCsrIndex(), searchCsr(), suggestCsr(); the unified
                    typed-array CSR engine (folded + multi-field BM25F)
  search.js      — search(), suggest() — thin wrappers over csr.js
  index.js       — buildIndex (= buildCsrIndex), mergeIndexes() (CSR merge)
  incremental.js — addDoc(), removeDoc(), compact(), pendingCompaction(),
                    mergeCsr() (the segment-merge primitive)
  scan.js        — buildBlob(), scan() (contiguous blob + bitap substring)
  serialize.js   — serialize(), deserialize() (CSR ↔ JSON, debug/docpack)
  pack.js        — pack(), unpack() (binary, zero-copy reload)
  api.js         — public Librarian namespace
  main.js        — concat manifest
```

Each source file has one job. The CSR representation is documented in the comment header of `csr.js`; the binary format in `pack.js`.

## Testing

`test/librarian.test.mjs` (the v1 assertion suite — runs unchanged on the CSR engine, the parity gate) + `librarian-csr.test.mjs` (head-to-head score parity v1↔CSR, CJK regression, lean-path) + `librarian-incr.test.mjs` (addDoc/removeDoc/compact==fresh-build/pendingCompaction) + `librarian-pack.test.mjs` (binary round-trip, zero-copy, auto-compact). `npm test` runs them all.

Benches in `bench/`: `lean-prototype.mjs` (the original v2 sizing study), `csr-bench.mjs` (real-engine RAM vs v1), `pack-bench.mjs` (reload latency). Measured: 50k excerpts 913 MB → 19 MB; 10k full bodies 2321 MB → 37 MB; 50k full bodies (v1 OOMs) → 175 MB, search 9 ms; pack/unpack reload @ 50k ≈ 13 ms.

## Open questions

- **Streaming index updates** — adding/removing/updating a doc without re-indexing the whole corpus. The postings structure could support it; the bookkeeping (df, avgLen updates) is the work. Useful for live notebooks where the corpus mutates.
- **Better CJK** — per-character tokenization under-indexes; bigram tokenization is the obvious upgrade.
- **Faster fuzzy** — current implementation scans the term dictionary on every miss. A BK-tree (Burkhard-Keller) over the term dictionary would speed this up dramatically for large corpora.
- **Phrase queries** — `"baker street"` as a literal phrase, not just proximity-weighted. Could fall out of the existing positions data.

## What Librarian is NOT

- **A web search engine.** Single in-process, single corpus. Use Elasticsearch or Typesense if you outgrow ~10 000 docs.
- **A vector / embedding search engine.** Pure lexical (BM25F). Embedding-based semantic search is a different shape; not on the roadmap.
- **A relevance learning framework.** Scores are deterministic and tunable via field boosts + synonyms. No click-through learning, no LTR models.
- **A NLP toolkit.** No POS tagging, no parsing, no entity recognition. Tokenize + stopword + done.

## Versioning

Pre-1.0 means the index format is not stabilized — bumps may change the serialization format. APIs are unlikely to change shape, but expansions to `Librarian.*` may add fields to result objects.

## v2 — one engine, not two  *(SHIPPED 2026-06-01)*

A v2 redesign (driven by `@gcu/weir`, which needs ranked full-text over 10k–100k
never-deleted docs) raises the old "~10 000 docs" ceiling to ~100k full-body docs
in a few hundred MB, with faster search. Design of record:
`spec_inbox/librarian-search-spec.md` + `weir-search-requirements.md`.

**The decision that governed the build: unify, don't dual-mode.** The lean
typed-array CSR index (`csr.js`) is the *sole* index representation; the old
nested-`Map` build was **deleted** (`index.js` is now a re-export, `search.js` a
thin wrapper). Everything v1 offered that the lean core drops returns as **opt-in
flags on the one engine**, not a parallel code path:

| flag | default | lean (weir) |
|---|---|---|
| `mode` | `'multi'` (true per-field BM25F) | `'folded'` (boosts folded into one tf; ~48–63× leaner) |
| `storeText` | `true` (snippets from the index) | `false` (+ a `snippet(docId, fieldName)` callback) |
| `positions` | `true` (proximity + aligned snippets) | `false` |

`mode:'folded'` is a **conscious** opt-in (it changes ranking vs BM25F), never the
silent default — so the defaults reproduce v1 exactly.

**API (additive over v1):**

```js
Librarian.index({ docs, fields?, mode?, storeText?, positions?, snippet?, synonyms? })
Librarian.search(index, q, { fuzzy?, limit? })   // { id, score, doc, snippet, hits }
Librarian.suggest(index, q)                       // did-you-mean
Librarian.addDoc(index, doc)                      // delta segment, O(doc)
Librarian.removeDoc(index, id)                    // tombstone, O(1)
Librarian.compact(index)                          // fold delta + drop tombstones
Librarian.pendingCompaction(index)                // { delta, tombstones, ratio }
Librarian.pack(index) / Librarian.unpack(buf, { snippet? })   // binary persistence
Librarian.buildBlob(docs) / Librarian.scan(blob, q, { fuzzy, limit })  // §6 scan path
Librarian.serialize / deserialize / merge         // kept (CSR-backed)
```

**The gate (met):** the unified engine with `storeText` + multi-field on passes
librarian's *existing* test suite byte-for-byte (+ head-to-head score parity v1↔CSR
within 1e-9, + a CJK regression) before the nested-`Map` was deleted. The two
in-repo consumers — docs Ctrl+K and the reader's per-book search — migrated in the
same pass with **no call-site change** (defaults = flags-on = identical behavior).
weir (the large-corpus consumer) flips the flags off and uses the incremental +
`pack`/`unpack` + `scan` surfaces, vendoring upstream-first (below).

Remaining v2 ladder rungs (not built; only climb if a corpus needs them): a
sorted-`Uint8Array`/FST dictionary, disk-backed segments (roaring postings,
block-max WAND) for millions of docs. See `spec_inbox/librarian-search-spec.md` §7.

## Vendoring (canonical source)

**`ext/librarian/` in the `auditable` repo is the single canonical source.**
Consumers (weir, …) **vendor it by a sync script** (mirror
`gcu-library/tools/sync-reader-libs.mjs`) — they do **not** hand-edit the
vendored copy. Fixes and features go **upstream-first**: write a spec, patch the
canon here, rebuild, then re-vendor in the consumer (exactly how the `@gcu/sideact`
multi-root fix and `@gcu/reader-core` flow). **Never fork the vendored copy** —
a patched-in-place vendor is how canon silently drifts. One librarian, everywhere.
