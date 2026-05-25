// Public surface for @gcu/licenses.
//
// Shipped:
//   - validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId  (from spdx.js)
//   - classify, classifyExpression                         (from classify.js)
//   - formatTable, formatNoticesFile                       (from format.js)
//   - parseUrlToSource, fetchLicense                       (from fetch.js)
//   - aggregateLicenses                                    (from aggregate.js)
//
//   - inferLicense                                          (from infer.js)
//
// inferLicense (added in this commit) is a substring-fingerprint fallback
// the aggregator uses automatically when an entry has LICENSE text but no
// declared SPDX id — rows with `inferred: true` mark heuristic matches.

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

export { inferLicense } from './infer.js';

export { aggregateLicenses, aggregateFromInstalledModules, aggregateFromBuildLicenses } from './aggregate.js';
