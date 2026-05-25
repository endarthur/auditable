// Public surface for @gcu/licenses.
//
// Shipped:
//   - validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId  (from spdx.js)
//   - classify, classifyExpression                         (from classify.js)
//   - formatTable, formatNoticesFile                       (from format.js)
//   - parseUrlToSource, fetchLicense                       (from fetch.js)
//   - aggregateLicenses                                    (from aggregate.js)
//
// Follow-up commits will add:
//   - inferLicense (fingerprint fallback for license-text → SPDX id)

export {
  validateSpdx,
  parseSpdx,
  SPDX_CORPUS,
  isKnownSpdxId,
  SPDX_KINDS,
} from './spdx.js';

export { classify, classifyExpression } from './classify.js';

export { formatTable, formatNoticesFile } from './format.js';

export { parseUrlToSource, fetchLicense } from './fetch.js';

export { aggregateLicenses } from './aggregate.js';
