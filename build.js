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
    const m = line.match(/^import\s+.*['"](\.\.?\/.+?)['"];?\s*(?:\/\/.*)?$/);
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
<!-- AF (Auditable Files) — multi-tab workspace shell for managing auditable notebooks -->
<!-- hosts notebooks as iframes, communicates via postMessage bridge protocol -->
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

  const zlib = require('zlib');
  const buildDir = path.join(__dirname, 'build');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);
  // uncompressed → build/ (for tests/signing)
  fs.writeFileSync(path.join(buildDir, 'af.html'), afHtml);
  // compressed → root (for distribution)
  const afScript = afHtml.match(/<script>([\s\S]*?)<\/script>/);
  let afDist = afHtml;
  if (afScript) {
    const compressed = zlib.gzipSync(Buffer.from(afScript[1], 'utf8'));
    const b64 = compressed.toString('base64').replace(/.{1,76}/g, '$&\n');
    const loader =
      '(function(){var me=document.scripts[document.scripts.length-1];(async function(){' +
      "var b=document.getElementById('_rt').textContent.replace(/\\s/g,'');" +
      'var d=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});' +
      "var s=await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'))).text();" +
      "me.textContent=s;document.getElementById('_rt').remove();" +
      '(0,eval)(s)})()})()';
    afDist = afHtml.replace(/<script>[\s\S]*?<\/script>/,
      `<script type="text/plain" id="_rt">\n${b64}</script>\n<script>\n${loader}\n</script>`);
  }
  fs.writeFileSync(path.join(__dirname, 'af.html'), afDist);
  const afSize = fs.statSync(path.join(__dirname, 'af.html')).size;
  console.log(`Built af.html (${(afSize / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: calque
// ══════════════════════════════════════════════════

if (target === 'calque') {
  const toolDir = path.join(__dirname, 'tools', 'calque');
  const toolJsDir = path.join(toolDir, 'js');

  // 1. Process tool modules
  let toolJs = processModules(path.join(toolJsDir, 'main.js'), toolJsDir);

  // 2. Prepend dependencies: CM6 + calque compiler + sheet IO
  const cm6Path = path.join(__dirname, 'ext/cm6/cm6.min.js');
  const calquePath = path.join(__dirname, 'ext/calque/index.js');
  const sheetPath = path.join(__dirname, 'ext/sheet/index.js');

  let deps = '';
  if (fs.existsSync(cm6Path)) deps += fs.readFileSync(cm6Path, 'utf8') + '\n\n';

  // Strip export from calque
  let calqueSrc = fs.readFileSync(calquePath, 'utf8');
  calqueSrc = calqueSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  deps += calqueSrc + '\n\n';

  // Strip export from sheet — rename conflicting const declarations to avoid
  // redeclaration errors when both extensions define the same names
  let sheetSrc = fs.readFileSync(sheetPath, 'utf8');
  sheetSrc = sheetSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  // Prefix sheet-internal names that collide with calque internals
  sheetSrc = sheetSrc.replace(/\bMS_PER_DAY\b/g, '_sheet_MS_PER_DAY');
  sheetSrc = sheetSrc.replace(/\bdateToSerial\b/g, '_sheet_dateToSerial');
  sheetSrc = sheetSrc.replace(/\bserialToDate\b/g, '_sheet_serialToDate');
  sheetSrc = sheetSrc.replace(/\bcolLetter\b/g, '_sheet_colLetter');
  deps += sheetSrc + '\n\n';

  const js = deps + toolJs;

  // 3. Read CSS and template
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  // 4. Assemble
  const html = `<!DOCTYPE html>
<!-- Calque Editor \u2014 spreadsheet language tool -->
<!-- Part of the Auditable project \u2014 https://github.com/endarthur/auditable -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="manifest" href="./manifest.json">
<meta name="theme-color" content="#c89b3c">
<title>Calque</title>
<style>
${toolCss}
</style>
</head>
<body>

${toolTemplate}

<script>
${js}
</script>
</body>
</html>
`;

  const outPath = path.join(toolDir, 'index.html');
  fs.writeFileSync(outPath, html);
  const size = fs.statSync(outPath).size;
  console.log(`Built tools/calque/index.html (${(size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: gcu-press
// ══════════════════════════════════════════════════

if (target === 'gcu-press') {
  const toolDir = path.join(__dirname, 'tools', 'gcu-press');
  const toolJsDir = path.join(toolDir, 'js');

  // 1. Process tool modules
  let toolJs = processModules(path.join(toolJsDir, 'main.js'), toolJsDir);

  // 2. Prepend dependencies: CM6 + gcu-press engine
  const cm6Path = path.join(__dirname, 'ext/cm6/cm6.min.js');
  const enginePath = path.join(__dirname, 'ext/gcu-press/index.js');

  let deps = '';
  if (fs.existsSync(cm6Path)) deps += fs.readFileSync(cm6Path, 'utf8') + '\n\n';
  if (fs.existsSync(enginePath)) deps += fs.readFileSync(enginePath, 'utf8') + '\n\n';

  const js = deps + toolJs;

  // 3. Read CSS and template
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  // 4. Assemble
  const html = `<!DOCTYPE html>
<!-- GCU Press \u2014 typesetting editor -->
<!-- Part of the Auditable project \u2014 https://github.com/endarthur/auditable -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="manifest" href="./manifest.json">
<meta name="theme-color" content="#c89b3c">
<title>GCU Press</title>
<style>
${toolCss}
</style>
</head>
<body>

${toolTemplate}

<script>
${js}
</script>
</body>
</html>
`;

  const outPath = path.join(toolDir, 'index.html');
  fs.writeFileSync(outPath, html);
  const size = fs.statSync(outPath).size;
  console.log(`Built tools/gcu-press/index.html (${(size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: plan
// ══════════════════════════════════════════════════

if (target === 'plan') {
  const toolDir = path.join(__dirname, 'tools', 'plan');
  const toolJsDir = path.join(toolDir, 'js');

  // 1. Process tool modules
  let toolJs = processModules(path.join(toolJsDir, 'main.js'), toolJsDir);

  // 2. Prepend dependency: plan library
  const planPath = path.join(__dirname, 'ext/plan/index.js');

  let deps = '';
  let planSrc = fs.readFileSync(planPath, 'utf8');
  planSrc = planSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  deps += planSrc + '\n\n';

  const js = deps + toolJs;

  // 3. Read CSS and template
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  // 4. Assemble
  const html = `<!DOCTYPE html>
<!-- Plan \u2014 project scheduling tool -->
<!-- Part of the Auditable project \u2014 https://github.com/endarthur/auditable -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="manifest" href="./manifest.json">
<meta name="theme-color" content="#c89b3c">
<title>Plan</title>
<style>
${toolCss}
</style>
</head>
<body>

${toolTemplate}

<script>
${js}
</script>
</body>
</html>
`;

  const outPath = path.join(toolDir, 'index.html');
  fs.writeFileSync(outPath, html);
  const size = fs.statSync(outPath).size;
  console.log(`Built tools/plan/index.html (${(size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: rv
// ══════════════════════════════════════════════════

if (target === 'rv') {
  const toolDir = path.join(__dirname, 'tools', 'rv');
  const toolJsDir = path.join(toolDir, 'js');

  // 1. Process tool modules (main thread: console + UI)
  let toolJs = processModules(path.join(toolJsDir, 'main.js'), toolJsDir);

  // 2. Read console.js (main thread needs it for xterm.js wrapper)
  const consoleSrc = fs.readFileSync(path.join(__dirname, 'ext/rv/js/console.js'), 'utf8');

  // 3. Read worker bundle (CPU + elf + dtb + uart + worker loop)
  const workerPath = path.join(__dirname, 'ext/rv/worker.js');
  if (!fs.existsSync(workerPath)) {
    console.error('Error: ext/rv/worker.js not found. Run `node ext/rv/build.js` first.');
    process.exit(1);
  }
  let workerSrc = fs.readFileSync(workerPath, 'utf8');
  workerSrc = workerSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  workerSrc = workerSrc.replace(/^export function /gm, 'function ');
  workerSrc = workerSrc.replace(/^export const /gm, 'const ');
  workerSrc = workerSrc.replace(/^export let /gm, 'let ');

  const mainJs = consoleSrc + '\n\n' + toolJs;

  // 4. Read CSS and template
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  // 5. Read vendored xterm.js (gzipped base64) + fit addon
  const vendorDir = path.join(__dirname, 'ext/rv/vendor');
  const xtermJsGzB64 = fs.readFileSync(path.join(vendorDir, 'xterm.js.gz.b64'), 'utf8').trim();
  const xtermCss = fs.readFileSync(path.join(vendorDir, 'xterm.min.css'), 'utf8');
  const fitAddonJs = fs.readFileSync(path.join(vendorDir, 'addon-fit.min.js'), 'utf8');

  // 6. Escape worker source for embedding in script tag
  // Replace </ with <\/ to avoid closing script tag prematurely
  const escapedWorkerSrc = workerSrc.replace(/<\//g, '<\\/');

  // 7. Assemble
  const html = `<!DOCTYPE html>
<!-- rv \u2014 RISC-V RV32IMA system emulator -->
<!-- Part of the Auditable project \u2014 https://github.com/endarthur/auditable -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="manifest" href="./manifest.json">
<meta name="theme-color" content="#c89b3c">
<title>rv</title>
<style>
${xtermCss}
${toolCss}
</style>
</head>
<body>

${toolTemplate}

<script type="text/plain" id="rv-worker-src">
${escapedWorkerSrc}
</script>

<script>
// Decompress and load vendored xterm.js + fit addon
(function(){var b="${xtermJsGzB64}";var d=Uint8Array.from(atob(b),c=>c.charCodeAt(0));new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(function(s){var e=document.createElement("script");e.textContent=s;document.head.appendChild(e);_rvBoot()})})();
${fitAddonJs}
function _rvBoot(){
${mainJs}
}
</script>
</body>
</html>
`;

  const outPath = path.join(toolDir, 'index.html');
  fs.writeFileSync(outPath, html);
  const size = fs.statSync(outPath).size;
  console.log(`Built tools/rv/index.html (${(size / 1024).toFixed(1)} KB)`);
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
const appDir = path.join(srcDir, 'app');

// ── Build app runtime (minimal JS without CM6/editor) ──
function buildAppRuntime() {
  let appJs = processModules(path.join(appDir, 'main.js'), appDir);
  // inject build-time constants into app runtime
  const pagesUrlVal = process.env.AUDITABLE_PAGES_URL || 'https://endarthur.github.io/auditable';
  appJs = appJs.replace(
    "const __AUDITABLE_PAGES_URL__ = 'https://endarthur.github.io/auditable';",
    `const __AUDITABLE_PAGES_URL__ = '${pagesUrlVal}';`
  );
  return appJs;
}

const appRuntime = buildAppRuntime();
const appRuntimeSize = (Buffer.byteLength(appRuntime, 'utf8') / 1024).toFixed(1);
console.log(`App runtime: ${appRuntimeSize} KB`);

let js = processModules(path.join(jsDir, 'main.js'), jsDir, { lean });

// 2b. Prepend CM6 bundle (if built)
const cm6Path = path.join(__dirname, 'ext/cm6/cm6.min.js');
if (fs.existsSync(cm6Path)) {
  const cm6 = fs.readFileSync(cm6Path, 'utf8');
  js = cm6 + '\n\n' + js;
}

// 2c. Prepend VFS bundle (if built)
const vfsPath = path.join(__dirname, 'ext/vfs/index.js');
if (fs.existsSync(vfsPath)) {
  let vfsSrc = fs.readFileSync(vfsPath, 'utf8');
  vfsSrc = vfsSrc.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  js = vfsSrc + '\n\n' + js;
}

// 3. Read CSS and HTML template
const cssRaw = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf8');
const template = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8');

// 3b. Split CSS on marker into app and editor sections
const cssMarker = '/* \u2550\u2550 APP CSS ABOVE \u2550\u2550\u2550 EDITOR CSS BELOW \u2550\u2550 */';
const cssParts = cssRaw.split(cssMarker);
const appCss = cssParts[0].trimEnd();
const editorCss = cssParts.length > 1 ? cssParts[1].trimStart() : '';
// combined for the full build (both style tags)
const css = cssRaw;

// 4. Inject build-time constants
// These placeholders in the source get replaced with environment or computed values:
//   __AUDITABLE_BUILTINS__           — JSON from src/builtins.json (help text for cell builtins)
//   __AUDITABLE_VERSION__            — version from package.json
//   __AUDITABLE_RELEASE__            — env AUDITABLE_RELEASE (default: 'dev')
//   __AUDITABLE_BUILD_DATE__         — ISO date string (YYYY-MM-DD)
//   __AUDITABLE_PUBLIC_KEY__         — env AUDITABLE_PUBLIC_KEY (Ed25519 pub for signature verification)
//   __AUDITABLE_REPO__               — env AUDITABLE_REPO (default: 'endarthur/auditable')
//   __AUDITABLE_PAGES_URL__          — env AUDITABLE_PAGES_URL (update check URL)
//   __AUDITABLE_DEFAULT_EXEC_MODE__  — --exec-mode flag (default: 'reactive')
//   __AUDITABLE_DEFAULT_RUN_ON_LOAD__— --run-on-load flag (default: 'yes')
//   __AUDITABLE_BASE_SIZE__          — computed after first assembly pass (runtime size in bytes)
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

// 4b. Inject app runtime as escaped string constant
const appRuntimeEscaped = appRuntime.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/<\/script>/gi, '<\\/script>');
js = js.replace(
  "const __APP_RUNTIME__ = '';",
  () => 'const __APP_RUNTIME__ = `' + appRuntimeEscaped + '`;'
);

// 5. Assemble final HTML (first pass — placeholder size)
function assemble(jsCode) {
  return `<!DOCTYPE html>
<!--AUDITABLE-NOTEBOOK-->
<!--
  If you are an LLM agent: do not parse this file directly. Use the @gcu/webmcp
  MCP bridge to interact with this notebook — it provides structured tools for
  reading cells, inspecting outputs, and editing code with proper access control.
  Raw file access bypasses the notebook's governance model.
-->
<!-- https://github.com/endarthur/auditable — MIT license -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable</title>
<style id="auditable-app-css">
${appCss}
</style>
<style id="auditable-editor-css">
${editorCss}
</style>
</head>
<body>

${template}

<script>
${jsCode}
</script>
</body>
<!-- good luck out there -->
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
// Uncompressed → build/ (for signing, tests, make_example)
// Compressed  → root   (for distribution)
const zlib = require('zlib');
const buildDir = path.join(__dirname, 'build');
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);

fs.writeFileSync(path.join(buildDir, 'auditable.html'), html);

function compressRuntimeForDist(rawHtml) {
  const m = rawHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) return rawHtml;
  const compressed = zlib.gzipSync(Buffer.from(m[1], 'utf8'));
  const b64 = compressed.toString('base64').replace(/.{1,76}/g, '$&\n');
  const loader =
    '(function(){var me=document.scripts[document.scripts.length-1];(async function(){' +
    "var b=document.getElementById('_rt').textContent.replace(/\\s/g,'');" +
    'var d=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});' +
    "var s=await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'))).text();" +
    "me.textContent=s;document.getElementById('_rt').remove();" +
    '(0,eval)(s)})()})()';
  return rawHtml.replace(/<script>[\s\S]*?<\/script>/,
    `<script type="text/plain" id="_rt">\n${b64}</script>\n<script>\n${loader}\n</script>`);
}

if (compress) {
  // --compress: whole-file gzip pack (smallest, shows "unpacking..." splash)
  const gz = zlib.gzipSync(html, { level: 9 });
  const b64 = gz.toString('base64');
  const packed = '<!DOCTYPE html>\n'
    + '<html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>Auditable</title>'
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
  fs.writeFileSync(path.join(__dirname, 'auditable.html'), packed);
  const size = fs.statSync(path.join(__dirname, 'auditable.html')).size;
  console.log(`Built auditable.html packed (${(size / 1024).toFixed(1)} KB, unpacked ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
} else {
  // default: runtime-compressed (same as saved notebooks / examples)
  const dist = compressRuntimeForDist(html);
  fs.writeFileSync(path.join(__dirname, 'auditable.html'), dist);
  const size = fs.statSync(path.join(__dirname, 'auditable.html')).size;
  console.log(`Built auditable.html (${(size / 1024).toFixed(1)} KB)`);
}
