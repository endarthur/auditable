#!/usr/bin/env node
// Bundle ext/licenses/src/ into ext/licenses/index.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

const files = ['spdx.js', 'classify.js', 'format.js', 'fetch.js', 'aggregate.js', 'api.js'];

const chunks = [];
for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/licenses — third-party license attribution for the GCU stack
// Auto-generated from ext/licenses/src/ — do not edit directly
`;

const footer = `
export {
  validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId, SPDX_KINDS,
  classify, classifyExpression,
  formatTable, formatNoticesFile,
  parseUrlToSource, fetchLicense,
  aggregateLicenses, aggregateFromInstalledModules, aggregateFromBuildLicenses,
};
`;

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
