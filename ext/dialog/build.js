#!/usr/bin/env node
// Bundles ext/dialog/src/ ES modules into a single index.js for the browser
// concat loader. Mirrors the pattern used by ext/menu/build.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, 'src');
const mainPath = path.join(srcDir, 'main.js');
const mainSrc = fs.readFileSync(mainPath, 'utf8');

const importPaths = [];
for (const line of mainSrc.split('\n')) {
  const m = line.match(/^import\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m && !importPaths.includes(m[1])) importPaths.push(m[1]);
}
importPaths.push('main.js');

const chunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(srcDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"].*['"];?\s*$/gm, '');

  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^export async function /gm, 'async function ');

  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${basename} --\n\n${src}`);
}

const header = '// \u26a0 GENERATED FILE \u2014 DO NOT EDIT. Source: ext/dialog/src/  Build: node ext/dialog/build.js\n'
  + '// @gcu/dialog \u2014 modal dialogs (confirm, prompt, alert, custom forms)\n'
  + '// Promise-resolving show(), focus trap, stacking, ARIA. Zero dependencies.\n';

// Static-method aliases on Dialog mirror the ES-module export wiring at the
// bottom of src/index.js so the bundled artifact has the same shape.
const tail = `
Dialog.confirm    = confirm;
Dialog.prompt     = prompt;
Dialog.alert      = alert;
Dialog.dismissAll = dismissAll;

export { Dialog, confirm, prompt, alert, dismissAll, openCount };
`;

const output = header + '\n' + chunks.join('\n\n') + tail;

const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
const size = fs.statSync(outPath).size;
console.log(`Built ext/dialog/index.js (${(size / 1024).toFixed(1)} KB)`);
