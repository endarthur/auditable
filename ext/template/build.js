#!/usr/bin/env node
// Bundle ext/template/src/ into ext/template/index.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'src');

const files = ['util.js', 'parse.js', 'filters.js', 'render.js', 'api.js'];

const chunks = [];
for (const file of files) {
  let src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  // CRLF-safe + line-anchored: strip ES module statements that don't
  // survive concatenation (cross-file imports become identifier refs).
  src = src.replace(/\r$/gm, '');
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\}\s*from\s*['"].*['"];?\s*$/gm, '');
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');
  chunks.push(`// -- ${file} --\n\n${src}`);
}

const header = `// @gcu/template — VFS-backed template engine with {{path | filter}} syntax.
// Auto-generated from ext/template/src/ — do not edit directly.
`;

const footer = `
export {
  parseText, parseTagged, listPaths,
  render, resolvePath, renderText, tpl,
  registerFilter, lookupFilter, getDependencies,
  TemplateParseError, TemplateRenderError, TemplateCycleError,
};
`;

const output = header + '\n' + chunks.join('\n\n') + footer;
const outPath = path.join(__dirname, 'index.js');
fs.writeFileSync(outPath, output);
console.log(`Built ${outPath} (${(output.length / 1024).toFixed(1)} KB)`);
