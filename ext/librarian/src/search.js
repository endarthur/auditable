// Query-time search. The nested-Map v1 scorer is RETIRED; search/suggest are
// thin wrappers over the unified CSR engine (csr.js), which implements BM25(F)
// scoring (folded or multi-field), synonym/fuzzy/prefix expansion, proximity,
// snippets, and transparent base+delta merge for incremental indexes.

import { searchCsr, suggestCsr } from './csr.js';

export function search(index, query, opts = {}) {
  return searchCsr(index, query, opts);
}

export function suggest(index, query, maxEdits = 2) {
  return suggestCsr(index, query, maxEdits);
}
