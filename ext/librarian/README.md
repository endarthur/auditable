# @gcu/librarian

**A tiny in-process text search engine.** Inverted index, BM25F scoring with field boosts, Damerau-Levenshtein fuzzy expansion, synonym dictionary, prefix matching, snippet generation, did-you-mean suggestions.

Designed for browser-sized corpora (hundreds to low thousands of documents): docs sites, command palettes, in-page table search, the help system inside [Auditable Works](https://github.com/endarthur/auditable). Zero dependencies. ~18 KB unminified, gzips to ~6 KB.

```js
import { Librarian } from '@gcu/librarian';

const idx = Librarian.index({
  docs: [
    { id: 1, title: 'The Fox and the Grapes',  body: 'A hungry Fox saw …' },
    { id: 2, title: 'The Hare and the Tortoise', body: 'A Hare was making fun …' },
    { id: 3, title: 'The Wolf and the Lamb',  body: 'A Wolf, meeting with …' },
  ],
  fields: { title: { boost: 4 }, body: { boost: 1 } },
  synonyms: { fox: ['foxes'], wolf: ['wolves'] },
});

Librarian.search(idx, 'wolves');
// [{ id: 3, score: 1.23, doc: { … }, snippet: 'A <mark>Wolf</mark>, meeting with …', hits: { body: [{ token: 'wolf', count: 1 }] } }]
```

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/librarian
```

## Quick start

Build an index from a list of documents, then search it:

```js
import { Librarian } from '@gcu/librarian';

// 1. Define your documents. Field names are arbitrary; each field is a
//    string that contributes to the searchable text.
const docs = [
  { id: 'a', title: 'getting started',  body: 'install, build, first run …' },
  { id: 'b', title: 'cell types',       body: 'code, markdown, html, css …' },
  { id: 'c', title: 'directives',       body: '// %manual, // %hide, // %goto …' },
];

// 2. Build the index. fields' `boost` weights a match in that field by N×.
const idx = Librarian.index({
  docs,
  fields: { title: { boost: 4 }, body: { boost: 1 } },
});

// 3. Search. Returns ranked { id, score, doc, snippet, hits } entries.
const hits = Librarian.search(idx, 'directive', { limit: 10, fuzzy: 1 });
console.log(hits);
```

## API

### `Librarian.index(spec)`

Builds an inverted index. `spec`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `docs` | `Array<{ id, ...fields }>` | required | Each doc must have a unique `id`. Non-field properties are preserved as `meta` and surface on search hits. |
| `fields` | `Record<name, { boost: number }>` | inferred from first doc | Per-field BM25F boost. Missing → boost 1. |
| `synonyms` | `Record<term, string[]>` | `{}` | Query-time expansion. Lowercase keys + values. |

Returns an index object (treat as opaque; pass to `search`, `suggest`, etc.).

### `Librarian.search(index, query, opts?)`

Tokenises `query`, expands each token via synonyms + fuzzy + prefix, scores BM25F across fields, adds a proximity bonus for close-by hits within a doc, returns ranked results.

`opts`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `fuzzy` | `0 \| 1 \| 2` | `1` | Max edit distance for fuzzy expansion. 0 disables. |
| `limit` | `number` | `10` | Top-N results. |

Each result:

```js
{
  id: <doc.id>,
  score: <number, higher is better>,
  doc: <doc, with .meta keys merged>,
  snippet: '<string, <mark>-tagged>',
  hits: { <fieldName>: [{ token, count }, …] },
}
```

### `Librarian.suggest(index, query, maxEdits?)`

Did-you-mean fallback. For each query token, returns the closest in-vocabulary term (Damerau-Levenshtein, default max 2 edits). Returns the reconstructed suggested query string. Useful when `search` returns zero hits.

### `Librarian.serialize(index)` / `Librarian.deserialize(json)`

JSON round-trip. Use to pre-build an index at build time and ship the JSON instead of the raw corpus — saves indexing time at page load, lets you bundle a pre-tokenised search target with a binary docpack.

### `Librarian.merge(indexes)`

Merge multiple indexes into one. Doc IDs must be unique across sources.

### `Librarian.tokenize(text)`

Exposed for callers who want to tokenise outside the index pipeline (e.g. to compute a custom synonym table). Lowercases, strips punctuation, splits on whitespace, removes a small stopword set, returns `[{ token, start }, …]`.

### `Librarian.editDistance(a, b, max?)`

Damerau-Levenshtein with early-abort. Returns the edit distance, or `max + 1` if it would exceed `max` (saves work on obvious non-matches).

## Synonyms

A demo-grade synonym table looks like:

```js
{
  fox:   ['foxes'],
  wolf:  ['wolves'],
  pride: ['proud', 'vanity', 'vain'],
  watson:['john', 'doctor'],
}
```

At search time, each query token is expanded to itself plus its synonyms; hits via synonyms score at the same weight as the original term. Fuzzy expansion adds another layer (each token also matches typo variants within `fuzzy` edits). Prefix expansion is unconditional — `enc` matches `encryption`, `encrypted`, etc.

## Files

```
ext/librarian/
  src/
    tokenize.js    — tokeniser (positions, stopword filter, CJK-aware)
    fuzzy.js       — Damerau-Levenshtein + nearTerms()
    index.js       — buildIndex + mergeIndexes
    search.js      — BM25F + expansion + proximity + snippet
    serialize.js   — JSON round-trip
    api.js         — public Librarian namespace
    main.js        — concat manifest
  build.js         — concatenates src/ into index.js
  index.js         — BUILD OUTPUT (~18 KB)
```

## What's not supported

- **Streaming index updates** — the index is built once from the full corpus. To add a doc, re-index. (Future work; the postings structure could support it.)
- **Stemming** — no Porter stemmer or language-specific stemming. Synonyms cover the obvious cases; if you need real stemming, pre-process before indexing.
- **Multi-language tokenisation** — CJK is handled (whole-character tokens); right-to-left scripts and morphologically-rich languages (Finnish, Turkish) will under-index.
- **Distributed sharding** — single in-process index. For corpora > ~10 000 docs, consider a real search engine.

## Status

Pre-1.0. Ships in Auditable Works (Ctrl+K docs search), Sherlock+Aesop example notebook.

## License

MIT.
