// Public surface for @gcu/licenses.
//
// Foundation (this commit):
//   - validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId  (from spdx.js)
//   - classify, classifyExpression                         (from classify.js)
//   - formatTable, formatNoticesFile                       (from format.js)
//
// Follow-up commits will add:
//   - fetchLicense (per-registry fetchers)
//   - aggregateLicenses (VFS view function)
//   - inferLicense (fingerprint fallback)

export {
  validateSpdx,
  parseSpdx,
  SPDX_CORPUS,
  isKnownSpdxId,
  SPDX_KINDS,
} from './spdx.js';

export { classify, classifyExpression } from './classify.js';

export { formatTable, formatNoticesFile } from './format.js';
