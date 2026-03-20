#!/usr/bin/env node
// Generates a pre-encrypted example notebook.
// Usage: node make_encrypted_example.mjs
//
// Reads the example def, encrypts it with a known passphrase,
// outputs the encrypted HTML + recovery key sidecar.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { webcrypto } from 'crypto';

// Ensure crypto.subtle is available
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import crypto functions
const {
  cryptoEnable,
  cryptoBuildBlock,
  cryptoDisable,
} = await import('./src/js/crypto.js');

// ── Parse the def file (same logic as gen_examples.js) ──

function parseDef(text) {
  const lines = text.split('\n');
  let title = 'untitled';
  let settings = { theme: 'dark', fontSize: 13, width: '860' };
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    if (line.startsWith('/// ')) {
      const directive = line.slice(4);
      if (currentCell) {
        currentCell.code = currentCell.code.replace(/^\n/, '').replace(/\n$/, '');
        cells.push(currentCell);
        currentCell = null;
      }
      if (directive === 'auditable') continue;
      else if (directive.startsWith('title: ')) title = directive.slice(7);
      else if (directive.startsWith('settings: ')) settings = JSON.parse(directive.slice(10));
      else {
        const parts = directive.split(' ');
        currentCell = { type: parts[0] };
        if (parts.includes('collapsed')) currentCell.collapsed = true;
        currentCell.code = '';
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + line;
    }
  }
  if (currentCell) {
    currentCell.code = currentCell.code.replace(/^\n/, '').replace(/\n$/, '');
    cells.push(currentCell);
  }
  return { title, settings, cells };
}

// ── Modules encoding (same as save.js) ──

function encodeModules(obj) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

// ── Main ──

const PASSPHRASE = 'auditable';

// Parse the def
const defPath = join(__dirname, 'examples', 'defs', 'basics', 'example_encrypted.txt');
const defText = readFileSync(defPath, 'utf8');
const notebook = parseDef(defText);

// Enable encryption and get recovery key
const recoveryHex = await cryptoEnable(PASSPHRASE);

// Build encrypted payload
const payload = {
  data: notebook.cells,
  settings: notebook.settings,
  modules: null,
  fs: null,
  title: notebook.title,
};
const cryptoBlock = await cryptoBuildBlock(payload);

// Read auditable.html base
const basePath = join(__dirname, 'auditable.html');
if (!existsSync(basePath)) {
  console.error('auditable.html not found — run `node build.js` first');
  process.exit(1);
}
let html = readFileSync(basePath, 'utf8');

// Set title to encrypted
html = html.replace(
  '<title>Auditable</title>',
  '<title>Auditable \u2014 Encrypted</title>'
);

// Insert CRYPTO block before <script>
const cryptoComment = '<!-- encrypted notebook data: passphrase required to access cells, settings, and modules -->\n<!--AUDITABLE-CRYPTO\n' + JSON.stringify(cryptoBlock) + '\nAUDITABLE-CRYPTO-->';
html = html.replace('\n<script>', () => '\n' + cryptoComment + '\n\n<script>');

// Write output
const outDir = join(__dirname, 'examples', 'basics');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const outName = `example_encrypted_password-is-${PASSPHRASE}`;
const htmlPath = join(outDir, outName + '.html');
const recoveryPath = join(outDir, outName + '.recovery.txt');

writeFileSync(htmlPath, html);
writeFileSync(recoveryPath, recoveryHex + '\n');

const kb = (html.length / 1024).toFixed(1);
console.log(`  ${outName}.html (${kb} KB) [encrypted, passphrase: "${PASSPHRASE}"]`);
console.log(`  ${outName}.recovery.txt`);

cryptoDisable();
