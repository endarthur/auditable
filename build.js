#!/usr/bin/env node
// Zero-dependency build script for Auditable
// Reads ES modules from src/js/, strips import/export, concatenates into a single HTML file.

const fs = require('fs');
const path = require('path');

const target = (process.argv.find(a => a.startsWith('--target=')) || '').split('=')[1] || '';
const lean = process.argv.includes('--lean');
const compress = process.argv.includes('--compress');
const execModeArg = (process.argv.find(a => a.startsWith('--exec-mode=')) || '').split('=')[1] || '';
const runOnLoadArg = (process.argv.find(a => a.startsWith('--run-on-load=')) || '').split('=')[1] || '';

// ── Shared: process modules from a main.js ──

function processModules(mainPath, moduleDir, opts = {}) {
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const importPaths = [];
  for (const line of mainSrc.split('\n')) {
    if (opts.lean && line.includes('@optional')) continue;
    const m = line.match(/^import\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
    if (m) importPaths.push(m[1]);
  }

  const chunks = [];
  for (const relPath of importPaths) {
    const filePath = path.join(moduleDir, relPath);
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

    chunks.push(`// -- ${basename} --\n\n${src}`);
  }

  return chunks.join('\n\n');
}

// ══════════════════════════════════════════════════
// TARGET: af
// ══════════════════════════════════════════════════

if (target === 'af') {
  const afDir = path.join(__dirname, 'af');
  const afJsDir = path.join(afDir, 'js');

  // 1. Process AF modules
  let afJs = processModules(path.join(afJsDir, 'main.js'), afJsDir);

  // 2. Read the already-built auditable.html and embed as template literal
  const auditablePath = path.join(__dirname, 'auditable.html');
  if (!fs.existsSync(auditablePath)) {
    console.error('Error: auditable.html not found. Run `node build.js` first.');
    process.exit(1);
  }
  const auditableHtml = fs.readFileSync(auditablePath, 'utf8');
  const escaped = auditableHtml.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/<\/script>/gi, '<\\/script>');
  afJs = `const __AUDITABLE_RUNTIME__ = \`${escaped}\`;\n\n` + afJs;

  // 3. Read AF CSS and template
  const afCss = fs.readFileSync(path.join(afDir, 'style.css'), 'utf8');
  const afTemplate = fs.readFileSync(path.join(afDir, 'template.html'), 'utf8');

  // 4. Assemble af.html
  const afHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable Files</title>
<style>
${afCss}
</style>
</head>
<body>

${afTemplate}

<script>
${afJs}
</script>
</body>
</html>
`;

  const afOutPath = path.join(__dirname, 'af.html');
  fs.writeFileSync(afOutPath, afHtml);
  const afSize = fs.statSync(afOutPath).size;
  console.log(`Built af.html (${(afSize / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: scan
// ══════════════════════════════════════════════════

if (target === 'scan') {
  const scanDir = path.join(__dirname, 'scan');
  const scanPath = path.join(scanDir, 'index.html');
  let scanHtml = fs.readFileSync(scanPath, 'utf8');

  const pubKey = process.env.AUDITABLE_PUBLIC_KEY || '';
  scanHtml = scanHtml.replace(
    "const __SCANNER_PUBLIC_KEY__ = '';",
    `const __SCANNER_PUBLIC_KEY__ = '${pubKey}';`
  );

  fs.writeFileSync(scanPath, scanHtml);
  const scanSize = fs.statSync(scanPath).size;
  console.log(`Built scan/index.html (${(scanSize / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: auditable (default)
// ══════════════════════════════════════════════════

const srcDir = path.join(__dirname, 'src');
const jsDir = path.join(srcDir, 'js');

let js = processModules(path.join(jsDir, 'main.js'), jsDir, { lean });

// 3. Read CSS and HTML template
const css = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf8');
const template = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8');

// 4. Inject build-time constants
const builtins = fs.readFileSync(path.join(srcDir, 'builtins.json'), 'utf8');
js = js.replace("'__AUDITABLE_BUILTINS__'", builtins.trim());

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const buildDate = new Date().toISOString().slice(0, 10);
js = js.replace(
  "const __AUDITABLE_VERSION__ = '0.0.0';",
  `const __AUDITABLE_VERSION__ = '${pkg.version || '0.0.0'}';`
);
const release = process.env.AUDITABLE_RELEASE || 'dev';
js = js.replace(
  "const __AUDITABLE_RELEASE__ = 'dev';",
  `const __AUDITABLE_RELEASE__ = '${release}';`
);
js = js.replace(
  "const __AUDITABLE_BUILD_DATE__ = 'dev';",
  `const __AUDITABLE_BUILD_DATE__ = '${buildDate}';`
);
const pubKey = process.env.AUDITABLE_PUBLIC_KEY || '';
const repo = process.env.AUDITABLE_REPO || 'endarthur/auditable';
js = js.replace(
  "const __AUDITABLE_PUBLIC_KEY__ = '';",
  `const __AUDITABLE_PUBLIC_KEY__ = '${pubKey}';`
);
js = js.replace(
  "const __AUDITABLE_REPO__ = 'endarthur/auditable';",
  `const __AUDITABLE_REPO__ = '${repo}';`
);
const pagesUrl = process.env.AUDITABLE_PAGES_URL || 'https://endarthur.github.io/auditable';
js = js.replace(
  "const __AUDITABLE_PAGES_URL__ = 'https://endarthur.github.io/auditable';",
  `const __AUDITABLE_PAGES_URL__ = '${pagesUrl}';`
);
if (execModeArg) {
  js = js.replace(
    "const __AUDITABLE_DEFAULT_EXEC_MODE__ = 'reactive';",
    `const __AUDITABLE_DEFAULT_EXEC_MODE__ = '${execModeArg}';`
  );
}
if (runOnLoadArg) {
  js = js.replace(
    "const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = 'yes';",
    `const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = '${runOnLoadArg}';`
  );
}

// 5. Assemble final HTML (first pass — placeholder size)
function assemble(jsCode) {
  return `<!DOCTYPE html>
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
${jsCode}
</script>
</body>
</html>
`;
}

// compute base size then inject it
const baseSize = Buffer.byteLength(assemble(js), 'utf8');
js = js.replace(
  'const __AUDITABLE_BASE_SIZE__ = 0;',
  `const __AUDITABLE_BASE_SIZE__ = ${baseSize};`
);
const html = assemble(js);

// 6. Write output
if (compress) {
  const zlib = require('zlib');
  const gz = zlib.gzipSync(html, { level: 9 });
  const b64 = gz.toString('base64');
  const title = 'Auditable';
  const packed = '<!DOCTYPE html>\n'
    + '<html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>' + title + '</title>'
    + '<style>html{background:#1a1a1a}'
    + 'body{color:#999;font:14px/1.5 monospace;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}'
    + '</style></head><body>'
    + '<div id="_l">unpacking\u2026</div>'
    + '<script>'
    + "(async()=>{"
    + "var b='" + b64 + "';"
    + "var r=new Response(new Blob([Uint8Array.from(atob(b),c=>c.charCodeAt(0))]));"
    + "var s=r.body.pipeThrough(new DecompressionStream('gzip'));"
    + "var h=await new Response(s).text();"
    + "h=h.replace('<head>','<head><meta name=\"auditable-packed\">');"
    + "document.open();document.write(h);document.close();"
    + "})().catch(function(e){document.getElementById('_l').textContent='error: '+e.message});"
    + '<\/script></body></html>';
  const outPath = path.join(__dirname, 'auditable.html');
  fs.writeFileSync(outPath, packed);
  const size = fs.statSync(outPath).size;
  const unpackedKb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`Built auditable.html packed (${(size / 1024).toFixed(1)} KB, unpacked ${unpackedKb} KB)`);
} else {
  const outPath = path.join(__dirname, 'auditable.html');
  fs.writeFileSync(outPath, html);
  const size = fs.statSync(outPath).size;
  console.log(`Built auditable.html (${(size / 1024).toFixed(1)} KB)`);
}
