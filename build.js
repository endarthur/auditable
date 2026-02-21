#!/usr/bin/env node
// Zero-dependency build script for Auditable
// Reads ES modules from src/js/, strips import/export, concatenates into a single HTML file.

const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const jsDir = path.join(srcDir, 'js');
const lean = process.argv.includes('--lean');

// 1. Read main.js and extract import paths in order
const mainSrc = fs.readFileSync(path.join(jsDir, 'main.js'), 'utf8');
const importPaths = [];
for (const line of mainSrc.split('\n')) {
  if (lean && line.includes('@optional')) continue;
  const m = line.match(/^import\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
  if (m) importPaths.push(m[1]);
}

// 2. Process each module file
const jsChunks = [];
for (const relPath of importPaths) {
  const filePath = path.join(jsDir, relPath);
  let src = fs.readFileSync(filePath, 'utf8');
  const basename = path.basename(relPath);

  // Strip import lines
  src = src.replace(/^import\s+.*['"].*['"];?\s*$/gm, '');

  // Replace export function -> function, export const -> const, etc.
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');

  // Strip export { ... } and export default lines
  src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');

  // Trim leading/trailing blank lines
  src = src.replace(/^\n+/, '').replace(/\n+$/, '');

  jsChunks.push(`// -- ${basename} --\n\n${src}`);
}

const js = jsChunks.join('\n\n');

// 3. Read CSS and HTML template
const css = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf8');
const template = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8');

// 4. Assemble final HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable</title>
<style>
${css}
</style>
</head>
<body>

${template}

<script>
${js}
</script>
</body>
</html>
`;

// 5. Write output
const outPath = path.join(__dirname, 'auditable.html');
fs.writeFileSync(outPath, html);
const size = fs.statSync(outPath).size;
console.log(`Built auditable.html (${(size / 1024).toFixed(1)} KB)`);
