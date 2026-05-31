// Build ext/qr/index.js — concat the vendored Arase encoder (MIT) + the UTF-8
// byte helper + the @gcu/qr wrapper into one self-contained ES module, stripping
// the vendored ESM export statements (so there's a single top-level `qrcode`),
// and preserving the Arase MIT notice.
//
//   node ext/qr/build.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8').replace(/\r\n/g, '\n');

// 1. The encoder. Strip its ESM exports → leave a top-level `const qrcode`.
let enc = read('vendor/qrcode-generator.mjs')
  .replace(/^export default qrcode;\s*$/m, '')
  .replace(/^export const stringToBytes = qrcode\.stringToBytes;\s*$/m, '')
  .replace(/^export const qrcode =/m, 'const qrcode =');

// 2. The UTF-8 byte function. Keep `function toUTF8Array`; drop its export.
let utf8 = read('vendor/qrcode-generator-utf8.mjs')
  .replace(/^export const stringToBytes = toUTF8Array;\s*$/m, '');

// 3. Glue: proper UTF-8 byte mode. 4. The wrapper (keeps its `export`s).
const glue = '\n// Proper UTF-8 byte mode (Arase optional UTF8 support).\nqrcode.stringToBytes = toUTF8Array;\n';
const wrapper = read('src/qr.js');

const header =
  '// @gcu/qr — BUILD OUTPUT (ext/qr/build.js). Do not edit here.\n'
  + '// Bundles the Arase qrcode-generator (MIT, (c) 2009 Kazuhiko Arase,\n'
  + '// http://www.d-project.com/) + UTF-8 support + the GCU wrapper.\n\n';

const out = header + enc.trim() + '\n\n' + utf8.trim() + '\n' + glue + '\n' + wrapper.trim() + '\n';
fs.writeFileSync(path.join(here, 'index.js'), out);
console.log('Built ext/qr/index.js (' + (out.length / 1024).toFixed(0) + ' KB)');
