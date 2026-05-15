// Public surface for @gcu/ipynb.

import { parseIpynb } from './parse.js';
import { serializeIpynb } from './serialize.js';

export { parseIpynb, serializeIpynb };
export { SUBSTITUTIONS, rewriteImports, rewriteImportLine } from './substitutions.js';
export { rewriteImportsBack } from './serialize.js';

// One-shot import: text → { cells, warnings, rewrites }.
// The auditable side calls this then feeds `cells` into the notebook.
export function importNotebook(ipynbText) {
  return parseIpynb(ipynbText);
}

// One-shot export: cells → .ipynb JSON string ready to write to disk.
export function exportNotebook(cells, opts = {}) {
  const json = serializeIpynb(cells, opts);
  return JSON.stringify(json, null, 1);
}
