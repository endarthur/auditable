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

    // Strip import statements (single-line and multiline)
    src = src.replace(/^import\b[\s\S]*?from\s+['"][^'"]*['"];?\s*$/gm, '');
    src = src.replace(/^import\s+['"][^'"]*['"];?\s*$/gm, ''); // side-effect imports

    // Replace export declarations → plain declarations
    src = src.replace(/^export function /gm, 'function ');
    src = src.replace(/^export async function /gm, 'async function ');
    src = src.replace(/^export const /gm, 'const ');
    src = src.replace(/^export let /gm, 'let ');
    src = src.replace(/^export class /gm, 'class ');

    // Strip export { ... } (single-line and multiline) and export default
    src = src.replace(/^export\s*\{[\s\S]*?\}\s*;?\s*$/gm, '');
    src = src.replace(/^export\s+default\s+.*$/gm, '');

    // Trim leading/trailing blank lines
    src = src.replace(/^\n+/, '').replace(/\n+$/, '');

    chunks.push(`// -- ${basename} --\n\n${src}`);
  }

  return chunks.join('\n\n');
}

// ══════════════════════════════════════════════════
// TARGET: works
// ══════════════════════════════════════════════════

if (target === 'works') {
  // Auditable Works — the GCU desktop shell. Registry build: every shell
  // module and every ext-library bundle gets its own ES-module scope via
  // blob URLs + an import map — the machinery the auditable target uses.
  const worksDir = path.join(__dirname, 'works');
  const worksJsDir = path.join(worksDir, 'js');

  // Shell modules from works/js/main.js (relative imports → '#name').
  const modules = processModulesAsRegistry(path.join(worksJsDir, 'main.js'), worksJsDir);

  // Ext-library bundles as registry entries — shell code imports them as
  // '#abus', '#vfs', '#rails', '#menu', '#dialog'.
  for (const [name, rel] of [
    ['abus',   'ext/abus/index.js'],
    ['vfs',    'ext/vfs/index.js'],
    ['rails',  'ext/rails/index.js'],
    ['menu',   'ext/menu/index.js'],
    ['dialog', 'ext/dialog/index.js'],
    // The notebook's pure serializer — shared so the shell can import a
    // standalone notebook into a project (works/js/import.js).
    ['serialize', 'src/js/serialize.js'],
  ]) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) {
      console.error(`Error: ${rel} not found — build the ext package first.`);
      process.exit(1);
    }
    const src = fs.readFileSync(p, 'utf8').replace(/^\n+/, '').replace(/\n+$/, '');
    modules.unshift({ name, source: src });
  }

  const worksJs = generateModuleBoot('', modules, '');

  // CSS: the shell's own stylesheet + the component theme sheets appended
  // whole — the components self-theme via their bundled :root defaults.
  let worksCss = fs.readFileSync(path.join(worksDir, 'style.css'), 'utf8');
  for (const cssRel of [
    'ext/rails/rails.css', 'ext/rails/rails-default.css',
    'ext/menu/menu.css', 'ext/menu/menu-default.css',
    'ext/dialog/dialog.css', 'ext/dialog/dialog-default.css',
  ]) {
    const p = path.join(__dirname, cssRel);
    if (fs.existsSync(p)) worksCss += '\n\n' + fs.readFileSync(p, 'utf8').trimEnd();
  }

  const worksTemplate = fs.readFileSync(path.join(worksDir, 'template.html'), 'utf8');

  // ── Surface payloads (auditable-works-spec §15.1) ──
  // Every surface is embedded as a gzip+base64 payload; the shell decompresses
  // it to a blob URL on first spawn. A blob URL is same-origin with the shell,
  // so works.html runs from file://, not only over HTTP — that is what makes
  // it a true single file. (The notebook payload makes works.html ~1.5 MB —
  // the §15.1 duplication cost; §15.2 dynamic linking dedups it later.)
  const worksZlib = require('zlib');

  function inlineSurfaceImports(html, name, allowDeps) {
    // Inline the surface's ESM imports into the page so it is fully
    // self-contained — no cross-file imports, which file:// would CORS-
    // block. Each surface declares its allow-list of `ext/<dep>/index.js`
    // dependencies; any stray import errors out the build.
    const imports = html.match(/^\s*import\s[^\n]*$/gm) || [];
    const stray = imports.filter((i) =>
      !allowDeps.some((d) => i.includes(`ext/${d}/index.js`)));
    if (stray.length) {
      console.error(`Error: surface ${name} has stray imports — allow-list is `
        + `[${allowDeps.join(', ')}]:\n  ` + stray.join('\n  '));
      process.exit(1);
    }
    let out = html;
    for (const dep of allowDeps) {
      const depPath = path.join(__dirname, 'ext', dep, 'index.js');
      if (!fs.existsSync(depPath)) {
        console.error(`Error: ext/${dep}/index.js not found — build it first`);
        process.exit(1);
      }
      // Rewrite the bundle's trailing named-export list to local consts so
      // the surface module can use the exported names. Necessary for
      // terser-mangled ESM bundles (xterm: `export{mn as FitAddon}`); a
      // plain strip would lose those names. For concat bundles whose
      // exports are already top-level (geas/vfs/abus), `as`-less entries
      // become harmless no-op `const Foo = Foo;` (redundant but valid).
      const src = fs.readFileSync(depPath, 'utf8')
        .replace(/export\s*\{([^}]+)\};?\s*$/, (_, body) => {
          const aliases = body.split(',').map((s) => s.trim()).filter(Boolean)
            .map((decl) => {
              const m = decl.match(/^(\S+)\s+as\s+(\S+)$/);
              return m ? `const ${m[2]} = ${m[1]};` : `;`;   // already top-level
            }).join('\n');
          return '\n' + aliases + '\n';
        });
      const re = new RegExp(
        `import\\s*\\{[^}]*\\}\\s*from\\s*['"][^'"]*ext/${dep}/index\\.js['"];?`);
      // Replacement function (not string) — String.prototype.replace treats
      // $&, $', $`, etc. in a *string* replacement as special tokens. The
      // vfs bundle contains literal `'$'` (a regex anchor in a string), so
      // a string replacement would have `$'` re-interpreted as "after-match
      // text" and corrupt the inlined output. A function replacement gets
      // its return value used verbatim.
      const banner = `/* @gcu/${dep} — inlined for a self-contained surface */\n`;
      out = out.replace(re, () => banner + src);
    }
    return out;
  }

  // Terminal-specific build extras: inline xterm.css into the <style> tag
  // and embed the geas worker payload (geas bundle + setupGeasWorker
  // wrapper) as a gzip+base64 <script type="text/plain"> the surface
  // decompresses to a blob URL on boot.
  function buildTerminalSurfaceExtras(html) {
    const css = fs.readFileSync(path.join(__dirname, 'ext/xterm/xterm.css'), 'utf8');
    html = html.replace('/* @xterm-css */', css);

    const geasPath = path.join(__dirname, 'ext/geas/index.js');
    if (!fs.existsSync(geasPath)) {
      console.error('Error: ext/geas/index.js not found — build geas first');
      process.exit(1);
    }
    const geasSrc = fs.readFileSync(geasPath, 'utf8')
      .replace(/export\s*\{[^}]*\};?\s*$/, '');   // worker has no consumer
    // — strip is fine; createShell/isTyped are top-level in the bundle.
    // Inside the worker, createShell + isTyped are top-level after the
    // export line is stripped. The wrapper hands them to setupGeasWorker.
    const workerSrc = geasSrc + '\nsetupGeasWorker(self, { createShell, isTyped });\n';
    const gz = worksZlib.gzipSync(Buffer.from(workerSrc, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    return html.replace('<!-- @worker-payload -->',
      `<script type="text/plain" id="worker-payload">\n${b64}\n</script>`);
  }

  const surfaceParts = [];
  for (const s of [
    { kind: 'stub',      file: 'works/surfaces/stub.html',      deps: ['abus'] },
    { kind: 'text',      file: 'works/surfaces/text.html',      deps: ['abus'] },
    { kind: 'preview',   file: 'works/surfaces/preview.html',   deps: ['abus'] },
    { kind: 'inspector', file: 'works/surfaces/inspector.html', deps: ['abus'] },
    { kind: 'terminal',  file: 'works/surfaces/terminal.html',
      deps: ['abus', 'vfs', 'xterm', 'geas'], extras: 'terminal' },
    { kind: 'notebook',  file: 'auditable.html',                deps: null },
  ]) {
    const sp = path.join(__dirname, s.file);
    if (!fs.existsSync(sp)) {
      console.error(`Error: surface source ${s.file} not found`
        + (s.kind === 'notebook' ? ' — build auditable.html first (node build.js).' : '.'));
      process.exit(1);
    }
    let surfaceHtml = fs.readFileSync(sp, 'utf8');
    if (s.deps) surfaceHtml = inlineSurfaceImports(surfaceHtml, s.kind, s.deps);
    if (s.extras === 'terminal') surfaceHtml = buildTerminalSurfaceExtras(surfaceHtml);
    const gz = worksZlib.gzipSync(Buffer.from(surfaceHtml, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    surfaceParts.push(`<script type="text/plain" id="surface-${s.kind}">\n${b64}\n</script>`);
  }
  const surfacePayloads = surfaceParts.join('\n');

  const worksHtml = `<!DOCTYPE html>
<!-- Auditable Works — the GCU desktop -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable Works</title>
<style>
${worksCss}
</style>
</head>
<body>

${worksTemplate}

<!-- Auditable Works surfaces — embedded payloads, blob-URL'd on spawn (§15.1) -->
${surfacePayloads}

<script>
${worksJs}
</script>
</body>
</html>
`;

  fs.writeFileSync(path.join(__dirname, 'works.html'), worksHtml);
  const worksSize = fs.statSync(path.join(__dirname, 'works.html')).size;
  console.log(`Built works.html (${(worksSize / 1024).toFixed(1)} KB)`);
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
// TARGET: geas (standalone shell terminal PWA)
// ══════════════════════════════════════════════════

if (target === 'geas') {
  const toolDir = path.join(__dirname, 'tools', 'geas');
  const toolJsDir = path.join(toolDir, 'js');

  // 1. Tool modules → one classic-script IIFE.
  const toolJs = processModules(path.join(toolJsDir, 'main.js'), toolJsDir);

  // 2. Embed the ESM bundles the tool blob-URLs at runtime:
  //    - geas: dynamic-imported on the main thread for the client API,
  //      and (with the setup call appended) inlined into the worker.
  //    - term / vfs: dynamic-imported on the main thread.
  const geasSrc = fs.readFileSync(path.join(__dirname, 'ext/geas/index.js'), 'utf8');
  const termSrc = fs.readFileSync(path.join(__dirname, 'ext/term/index.js'), 'utf8');
  const vfsSrc  = fs.readFileSync(path.join(__dirname, 'ext/vfs/index.js'), 'utf8');
  const embeds =
    'const GEAS_BUNDLE_SOURCE = ' + JSON.stringify(geasSrc) + ';\n' +
    'const TERM_BUNDLE_SOURCE = ' + JSON.stringify(termSrc) + ';\n' +
    'const VFS_BUNDLE_SOURCE = '  + JSON.stringify(vfsSrc)  + ';\n';

  const js = embeds + '\n' + toolJs;

  // 3. CSS: @gcu/term structural + default theme, then the tool's own.
  const termCss = fs.readFileSync(path.join(__dirname, 'ext/term/term.css'), 'utf8');
  const termDefaultCss = fs.readFileSync(path.join(__dirname, 'ext/term/term-default.css'), 'utf8');
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const css = termCss + '\n' + termDefaultCss + '\n' + toolCss;

  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  const html = `<!DOCTYPE html>
<!-- geas — the GCU shell, standalone terminal -->
<!-- Part of the Auditable project — https://github.com/endarthur/auditable -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="manifest" href="./manifest.json">
<meta name="theme-color" content="#0a0c10">
<title>geas</title>
<style>
${css}
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
  console.log(`Built tools/geas/index.html (${(size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: dee (3D block model viewer)
// ══════════════════════════════════════════════════

if (target === 'dee') {
  const toolDir = path.join(__dirname, 'tools', 'dee');
  const toolJsDir = path.join(toolDir, 'js');

  // 1. Process tool modules
  let toolJs = processModules(path.join(toolJsDir, 'main.js'), toolJsDir);

  // 2. Prepend dependencies as IIFE namespaces (avoid name collisions)
  const extPaths = [
    ['_grid', path.join(__dirname, 'ext/grid/index.js')],
    ['_voxmesh', path.join(__dirname, 'ext/voxmesh/index.js')],
  ];

  let deps = '';
  for (const [ns, p] of extPaths) {
    let src = fs.readFileSync(p, 'utf8');
    // extract export names
    const exportMatch = src.match(/^export\s*\{([^}]+)\}/m);
    const exportNames = exportMatch ? exportMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean) : [];
    // strip exports
    src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
    src = src.replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');
    deps += `const ${ns} = (function() {\n${src}\nreturn { ${exportNames.join(', ')} };\n})();\n\n`;
  }

  // dee and peel have unique names — prepend bare (no IIFE wrapping)
  for (const p of [path.join(__dirname, 'ext/dee/index.js'), path.join(__dirname, 'ext/peel/index.js')]) {
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    src = src.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
    src = src.replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');
    deps += src + '\n\n';
  }

  const js = deps + toolJs;

  // 3. Read CSS and template
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  // 4. Assemble
  const html = `<!DOCTYPE html>
<!-- dee \u2014 3D block model viewer -->
<!-- Part of the Auditable project \u2014 https://github.com/endarthur/auditable -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="manifest" href="./manifest.json">
<meta name="theme-color" content="#c89b3c">
<title>dee</title>
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
  console.log(`Built tools/dee/index.html (${(size / 1024).toFixed(1)} KB)`);
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

// ── Module registry: preserve ES module import/export, rewrite paths ──

function processModulesAsRegistry(mainPath, moduleDir, opts = {}) {
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const importPaths = [];
  for (const line of mainSrc.split('\n')) {
    if (opts.lean && line.includes('@optional')) continue;
    const m = line.match(/^import\s+.*['"](\.\.?\/.+?)['"];?\s*(?:\/\/.*)?$/);
    if (m) importPaths.push(m[1]);
  }

  const modules = [];
  for (const relPath of importPaths) {
    const filePath = path.join(moduleDir, relPath);
    let src = fs.readFileSync(filePath, 'utf8');

    // Registry name preserves subdirectory structure so `./cell-builtins/ui.js`
    // becomes `#cell-builtins/ui`, distinct from a hypothetical top-level `ui.js`.
    const name = relPath.replace(/^\.\//, '').replace(/\.js$/, '').replace(/\\/g, '/');
    const currentDir = path.dirname(relPath);

    // Rewrite relative imports to hash-prefixed specifiers, resolved against
    // the importer's directory. Handles both './x.js' and '../x.js' forms,
    // including cross-subdir paths like '../engine.js' from cell-builtins/.
    const rewriteImport = (match, pre, relative) => {
      const joined = currentDir === '.' ? relative : path.join(currentDir, relative);
      const resolvedNoExt = path.normalize(joined).replace(/\\/g, '/').replace(/\.js$/, '').replace(/^\.\//, '');
      return `${pre}'#${resolvedNoExt}'`;
    };
    src = src.replace(/(from\s+)['"](\.\.?\/.+?\.js)['"]/g, rewriteImport);
    src = src.replace(/(import\s+)['"](\.\.?\/.+?\.js)['"]/g, rewriteImport);

    src = src.replace(/^\n+/, '').replace(/\n+$/, '');
    modules.push({ name, source: src });
  }

  return modules;
}

// Process an extension's src/ tree as a set of ES-module registry entries.
// Unlike processModulesAsRegistry, this supports subfolders (e.g. ext/air/src/lower/js.js)
// and namespaces each module under the extension name to avoid collisions:
//   ext/air/src/types.js       → registry entry 'air/types',     imported as '#air/types'
//   ext/air/src/lower/js.js    → registry entry 'air/lower/js',  imported as '#air/lower/js'
//
// Each file's relative imports are rewritten to the '#<ext>/<resolved-path>' form,
// resolved against the file's own location (so '../types.js' from lower/js.js
// becomes '#air/types'). This preserves real ES-module scope per file — each file
// has its own closure, eliminating the identifier-collision class of bug the
// naive concat suffers from.
//
// main.js is treated purely as a build-time manifest and is NOT registered
// (its job is to define ordering and it has no runtime significance).
function processExtensionAsRegistry(extName, srcDir) {
  const mainPath = path.join(srcDir, 'main.js');
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const importPaths = [];
  for (const line of mainSrc.split('\n')) {
    const m = line.match(/^(?:import|export)\s+.*['"]\.\/(.+?)['"];?\s*(?:\/\/.*)?$/);
    if (m) importPaths.push(m[1]); // e.g. 'types.js' or 'lower/js.js'
  }

  const modules = [];
  for (const relPath of importPaths) {
    const filePath = path.join(srcDir, relPath);
    let src = fs.readFileSync(filePath, 'utf8');
    const moduleRelNoExt = relPath.replace(/\.js$/, '').replace(/\\/g, '/');
    const name = `${extName}/${moduleRelNoExt}`;
    const currentDir = path.dirname(relPath);

    // Rewrite relative imports in this file, resolved against its directory.
    const rewriteImport = (_, pre, relative) => {
      const joined = currentDir === '.' ? relative : path.join(currentDir, relative);
      const resolvedNoExt = path.normalize(joined).replace(/\\/g, '/').replace(/\.js$/, '');
      return `${pre}'#${extName}/${resolvedNoExt}'`;
    };
    src = src.replace(/(from\s+)['"](\.\.?\/.+?\.js)['"]/g, rewriteImport);
    src = src.replace(/(import\s+)['"](\.\.?\/.+?\.js)['"]/g, rewriteImport);

    src = src.replace(/^\n+/, '').replace(/\n+$/, '');
    modules.push({ name, source: src });
  }

  return modules;
}

function generateModuleBoot(cm6Src, modules, acornSrc) {
  const entries = [];
  for (const m of modules) {
    let json = JSON.stringify(m.source);
    // Prevent </script> from closing the HTML script tag (only </script> matters)
    json = json.replace(/<\/script>/gi, '<\\/script>');
    entries.push(JSON.stringify(m.name) + ': ' + json);
  }

  const order = JSON.stringify(modules.map(m => m.name));

  const boot =
    '(async () => {\n' +
    'const _S = {\n' + entries.join(',\n') + '\n};\n' +
    'const _O = ' + order + ';\n' +
    'const _U = {};\n' +
    'for (const n of _O) {\n' +
    "  _U[n] = URL.createObjectURL(new Blob([_S[n] + '\\n//# sourceURL=auditable/' + n + '.js\\n'], {type: 'application/javascript'}));\n" +
    '}\n' +
    "const _m = document.createElement('script');\n" +
    "_m.type = 'importmap';\n" +
    'const _im = {};\n' +
    "for (const n of _O) _im['#' + n] = _U[n];\n" +
    "_m.textContent = JSON.stringify({imports: _im});\n" +
    'document.body.appendChild(_m);\n' +
    "for (const n of _O) await import(_U[n]);\n" +
    '_m.remove();\n' +
    '})();\n';

  let js = '';
  if (cm6Src) js = cm6Src + '\n\n';
  if (acornSrc) js += acornSrc + '\n\n';
  js += boot;
  return js;
}

// ── Build module registry ──

const modules = processModulesAsRegistry(path.join(jsDir, 'main.js'), jsDir, { lean });

// Add VFS bundle as a module entry (ES module with exports intact)
const vfsPath = path.join(__dirname, 'ext/vfs/index.js');
if (fs.existsSync(vfsPath)) {
  let vfsSrc = fs.readFileSync(vfsPath, 'utf8');
  vfsSrc = vfsSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'vfs', source: vfsSrc });
}

// Add @gcu/abus bundle as a module entry (the A-Bus coordination layer —
// used by the notebook's Works surface adapter)
const abusPath = path.join(__dirname, 'ext/abus/index.js');
if (fs.existsSync(abusPath)) {
  let abusSrc = fs.readFileSync(abusPath, 'utf8');
  abusSrc = abusSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'abus', source: abusSrc });
}

// Add sideact bundle as a module entry
const sideactPath = path.join(__dirname, 'ext/sideact/index.js');
if (fs.existsSync(sideactPath)) {
  let sideactSrc = fs.readFileSync(sideactPath, 'utf8');
  sideactSrc = sideactSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'sideact', source: sideactSrc });
}

// Add @gcu/menu bundle as a module entry (ES module with named exports)
const menuPath = path.join(__dirname, 'ext/menu/index.js');
if (fs.existsSync(menuPath)) {
  let menuSrc = fs.readFileSync(menuPath, 'utf8');
  menuSrc = menuSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'menu', source: menuSrc });
}

// Add @gcu/dialog bundle as a module entry (ES module with named exports)
const dialogPath = path.join(__dirname, 'ext/dialog/index.js');
if (fs.existsSync(dialogPath)) {
  let dialogSrc = fs.readFileSync(dialogPath, 'utf8');
  dialogSrc = dialogSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'dialog', source: dialogSrc });
}

// Add @gcu/term bundle as a module entry (ES module with named exports)
const termPath = path.join(__dirname, 'ext/term/index.js');
if (fs.existsSync(termPath)) {
  let termSrc = fs.readFileSync(termPath, 'utf8');
  termSrc = termSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'term', source: termSrc });
}

// Add @gcu/ipynb bundle as a module entry (Jupyter import/export bridge)
const ipynbPath = path.join(__dirname, 'ext/ipynb/index.js');
if (fs.existsSync(ipynbPath)) {
  let ipynbSrc = fs.readFileSync(ipynbPath, 'utf8');
  ipynbSrc = ipynbSrc.replace(/^\n+/, '').replace(/\n+$/, '');
  modules.unshift({ name: 'ipynb', source: ipynbSrc });
}

// Read CM6 bundle (classic IIFE, not an ES module — sets window.CM6 via var)
const cm6Path = path.join(__dirname, 'ext/cm6/cm6.min.js');
const cm6Src = fs.existsSync(cm6Path) ? fs.readFileSync(cm6Path, 'utf8') : '';

// Read Acorn bundle (IIFE, sets window.Acorn — Parser + tsPlugin for AIR)
const acornPath = path.join(__dirname, 'ext/acorn/acorn.min.js');
const acornSrc = fs.existsSync(acornPath) ? fs.readFileSync(acornPath, 'utf8') : '';

// Add AIR as individual ES-module registry entries (real per-file scope, no concat flattening).
// Each ext/air/src/*.js becomes its own module under the #air/... namespace. This is the same
// pattern src/js/ uses and avoids the identifier-collision class of bug naive concat is prone to.
// The concat ext/air/index.js is still produced by ext/air/build.js, but only as the /bundled
// artifact for npm consumers — Auditable's own runtime no longer loads it.
const airSrcDir = path.join(__dirname, 'ext/air/src');
if (fs.existsSync(airSrcDir)) {
  const airModules = processExtensionAsRegistry('air', airSrcDir);
  for (const m of airModules) modules.push(m);
}

// 3. Read CSS and HTML template
const cssRaw = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf8');
const template = fs.readFileSync(path.join(srcDir, 'template.html'), 'utf8');

// 3b. Split CSS on marker into app and editor sections
const cssMarker = '/* \u2550\u2550 APP CSS ABOVE \u2550\u2550\u2550 EDITOR CSS BELOW \u2550\u2550 */';
const cssParts = cssRaw.split(cssMarker);
let appCss = cssParts[0].trimEnd();
const editorCss = cssParts.length > 1 ? cssParts[1].trimStart() : '';

// 3c. Append @gcu/menu structural CSS + decorative rules. The decorative file
// ships with its own :root defaults — strip those so auditable's palette
// (mapped to --ui-* in src/style.css) isn't overridden.
const menuCssPath = path.join(__dirname, 'ext/menu/menu.css');
const menuDefaultCssPath = path.join(__dirname, 'ext/menu/menu-default.css');
if (fs.existsSync(menuCssPath)) {
  appCss += '\n\n' + fs.readFileSync(menuCssPath, 'utf8').trimEnd();
}
if (fs.existsSync(menuDefaultCssPath)) {
  let menuDefault = fs.readFileSync(menuDefaultCssPath, 'utf8');
  menuDefault = menuDefault.replace(/:root\s*\{[\s\S]*?\}\s*/m, '');
  appCss += '\n\n' + menuDefault.trimEnd();
}

// 3d. Append @gcu/dialog structural CSS + decorative rules. Same :root strip
// as menu — auditable's palette already maps to --ui-* in src/style.css.
const dialogCssPath = path.join(__dirname, 'ext/dialog/dialog.css');
const dialogDefaultCssPath = path.join(__dirname, 'ext/dialog/dialog-default.css');
if (fs.existsSync(dialogCssPath)) {
  appCss += '\n\n' + fs.readFileSync(dialogCssPath, 'utf8').trimEnd();
}
if (fs.existsSync(dialogDefaultCssPath)) {
  let dialogDefault = fs.readFileSync(dialogDefaultCssPath, 'utf8');
  dialogDefault = dialogDefault.replace(/:root\s*\{[\s\S]*?\}\s*/m, '');
  appCss += '\n\n' + dialogDefault.trimEnd();
}

// 3e. Append @gcu/term structural + decorative CSS. term-default.css uses
// .screen rather than :root so no swatches need stripping; the
// --gcu-term-* custom properties live there and become the cssVarTheme
// defaults for ui.terminal() cells.
const termCssPath = path.join(__dirname, 'ext/term/term.css');
const termDefaultCssPath = path.join(__dirname, 'ext/term/term-default.css');
if (fs.existsSync(termCssPath)) {
  appCss += '\n\n' + fs.readFileSync(termCssPath, 'utf8').trimEnd();
}
if (fs.existsSync(termDefaultCssPath)) {
  appCss += '\n\n' + fs.readFileSync(termDefaultCssPath, 'utf8').trimEnd();
}

// 4. Inject build-time constants into module sources
// These placeholders get replaced with environment or computed values.
// Applied per-module (no-op for modules that don't contain the placeholder).
const builtins = fs.readFileSync(path.join(srcDir, 'builtins.json'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const buildDate = new Date().toISOString().slice(0, 10);
const release = process.env.AUDITABLE_RELEASE || 'dev';
const pubKey = process.env.AUDITABLE_PUBLIC_KEY || '';
const repo = process.env.AUDITABLE_REPO || 'endarthur/auditable';
const pagesUrl = process.env.AUDITABLE_PAGES_URL || 'https://endarthur.github.io/auditable';

for (const mod of modules) {
  mod.source = mod.source.replace("'__AUDITABLE_BUILTINS__'", builtins.trim());
  mod.source = mod.source.replace(
    "const __AUDITABLE_VERSION__ = '0.0.0';",
    `const __AUDITABLE_VERSION__ = '${pkg.version || '0.0.0'}';`
  );
  mod.source = mod.source.replace(
    "const __AUDITABLE_RELEASE__ = 'dev';",
    `const __AUDITABLE_RELEASE__ = '${release}';`
  );
  mod.source = mod.source.replace(
    "const __AUDITABLE_BUILD_DATE__ = 'dev';",
    `const __AUDITABLE_BUILD_DATE__ = '${buildDate}';`
  );
  mod.source = mod.source.replace(
    "const __AUDITABLE_PUBLIC_KEY__ = '';",
    `const __AUDITABLE_PUBLIC_KEY__ = '${pubKey}';`
  );
  mod.source = mod.source.replace(
    "const __AUDITABLE_REPO__ = 'endarthur/auditable';",
    `const __AUDITABLE_REPO__ = '${repo}';`
  );
  mod.source = mod.source.replace(
    "const __AUDITABLE_PAGES_URL__ = 'https://endarthur.github.io/auditable';",
    `const __AUDITABLE_PAGES_URL__ = '${pagesUrl}';`
  );
  if (execModeArg) {
    mod.source = mod.source.replace(
      "const __AUDITABLE_DEFAULT_EXEC_MODE__ = 'reactive';",
      `const __AUDITABLE_DEFAULT_EXEC_MODE__ = '${execModeArg}';`
    );
  }
  if (runOnLoadArg) {
    mod.source = mod.source.replace(
      "const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = 'yes';",
      `const __AUDITABLE_DEFAULT_RUN_ON_LOAD__ = '${runOnLoadArg}';`
    );
  }
}

// 4b. Inject app runtime as escaped string constant into save module
const appRuntimeEscaped = appRuntime.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/<\/script>/gi, '<\\/script>');
const saveMod = modules.find(m => m.name === 'save');
if (saveMod) {
  saveMod.source = saveMod.source.replace(
    "const __APP_RUNTIME__ = '';",
    () => 'const __APP_RUNTIME__ = `' + appRuntimeEscaped + '`;'
  );
}

// Note: Switchboard font BINARIES are not bundled into the runtime —
// they're fetched from Google Fonts on user opt-in (toggle in Settings)
// and cached in localStorage. See save.js's fetchSwitchboardFonts().
// We DO bundle the OFL.txt license string, since it must accompany any
// embedded font payload and is small (~4.5 KB → ~1 KB gzipped).
const oflPath = path.join(__dirname, 'ext/switchboard/fonts/OFL.txt');
const oflText = fs.existsSync(oflPath) ? fs.readFileSync(oflPath, 'utf8') : '';
if (saveMod) {
  saveMod.source = saveMod.source.replace(
    "const __SWITCHBOARD_OFL__ = '';",
    () => 'const __SWITCHBOARD_OFL__ = ' + JSON.stringify(oflText) + ';'
  );
}

// 5. Assemble final HTML
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
<script data-theme-init>
// First-paint theme: honor explicit data-theme attribute (saved notebooks
// embed their chosen theme), otherwise OS preference, falling back to dark.
// Runs before <style> so styles paint with the right swatches from frame 0.
// data-theme-init attribute keeps the runtime-compression regex from
// matching this script instead of the main runtime block.
(function(){try{
  if(document.documentElement.hasAttribute('data-theme'))return;
  var prefersLight=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.setAttribute('data-theme',prefersLight?'light':'dark');
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
</script>
<script data-abus-catch>
// Buffer an Auditable Works abus:welcome that arrives before the async
// runtime — and its surface adapter (surface.js) — has finished loading.
// Runs synchronously during parse, so it is listening before the shell's
// iframe-load welcome. The data-abus-catch attribute keeps the runtime-
// compression regex off this script.
(function(){
  window.__abusWelcome = null;
  window.__abusWelcomeCb = null;
  window.addEventListener('message', function _c(e){
    if (e.data && e.data.type === 'abus:welcome') {
      window.removeEventListener('message', _c);
      if (window.__abusWelcomeCb) window.__abusWelcomeCb(e);
      else window.__abusWelcome = e;
    }
  });
})();
</script>
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

// compute base size then inject it (two-pass: first with placeholder, then with actual value)
let js = generateModuleBoot(cm6Src, modules, acornSrc);
const baseSize = Buffer.byteLength(assemble(js), 'utf8');
const sizeCompareMod = modules.find(m => m.name === 'size-compare');
if (sizeCompareMod) {
  sizeCompareMod.source = sizeCompareMod.source.replace(
    'const __AUDITABLE_BASE_SIZE__ = 0;',
    `const __AUDITABLE_BASE_SIZE__ = ${baseSize};`
  );
}
js = generateModuleBoot(cm6Src, modules, acornSrc);
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
    + '<html lang="en" data-theme="dark"><head><meta charset="UTF-8">'
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
