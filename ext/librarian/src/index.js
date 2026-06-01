// Index construction. The nested-Map v1 representation is RETIRED — the unified
// typed-array CSR engine (csr.js) is the sole index representation. This module
// is now a thin re-export so the public name `buildIndex` is preserved.
//
//   buildIndex(spec)   -> buildCsrIndex (csr.js). Defaults reproduce v1's
//                         behaviour (mode:'multi', storeText, positions); the
//                         lean path opts in via mode:'folded' + storeText/
//                         positions:false. See csr.js for the representation.
//   mergeIndexes(idxs) -> CSR segment merge (incremental.js mergeCsr), the
//                         multi-source / docpack combiner; compact() is its
//                         incremental cousin.

import { buildCsrIndex } from './csr.js';
import { mergeCsr } from './incremental.js';

export const buildIndex = buildCsrIndex;

export function mergeIndexes(indexes) {
  const list = indexes || [];
  const segs = list.map((i) => ({ index: i, deleted: i._deleted || null }));
  const opts = (list[0] && list[0]._buildOpts) || { mode: 'multi' };
  return mergeCsr(segs, opts);
}
