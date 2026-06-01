// Vendor the current @gcu/bearing build into ext/bearing/index.js.
//
// @gcu/bearing is developed in the sibling repo (gentropic/bearing.js). The
// npm/esm.sh copy lags, so auditable vendors the built ESM here and ships it
// as a /usr/lib builtin (so `load('@gcu/bearing')` resolves to the current
// version offline). Canonical source stays the bearing.js repo — never
// hand-edit ext/bearing/index.js; re-run this to update:
//
//   node ext/bearing/sync.mjs            (sibling at ../bearing.js)
//   node ext/bearing/sync.mjs <path>     (sibling elsewhere)
//
// Requires a local bearing.js checkout with a built dist/bearing.mjs
// (run `node build.js` in that repo first).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] || path.join(__dirname, '..', '..', '..', 'bearing.js');
const src = path.join(repo, 'dist', 'bearing.mjs');
if (!fs.existsSync(src)) {
  console.error(`bearing source not found: ${src}\nPass the bearing.js repo path, or build dist/ there first.`);
  process.exit(1);
}
let version = 'unknown';
try { version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version; } catch { /* */ }

const body = fs.readFileSync(src, 'utf8');
const header = `// ⚠ VENDORED — DO NOT EDIT. @gcu/bearing v${version}, built ESM bundle.\n`
  + `// Source of truth: gentropic/bearing.js (dist/bearing.mjs). Update with:\n`
  + `//   node ext/bearing/sync.mjs\n`
  + `// See ext/bearing/README.md.\n\n`;
const out = path.join(__dirname, 'index.js');
fs.writeFileSync(out, header + body);
console.log(`Vendored @gcu/bearing v${version} → ext/bearing/index.js (${(Buffer.byteLength(header + body) / 1024).toFixed(1)} KB)`);
