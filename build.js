#!/usr/bin/env node
// Zero-dependency build script for Auditable
// Reads ES modules from src/js/, strips import/export, concatenates into a single HTML file.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Deterministic build date: the HEAD commit's date (YYYY-MM-DD), not wall-clock, so the
// same source tree builds byte-identically — no spurious churn across the examples and
// editions that embed the runtime, and the output is sha256-pinnable. Falls back to
// 'dev' outside a git checkout.
function buildDateFromGit() {
  try {
    return execSync('git log -1 --date=short --format=%cd', { cwd: __dirname, encoding: 'utf8' }).trim() || 'dev';
  } catch {
    return 'dev';
  }
}

const target = (process.argv.find(a => a.startsWith('--target=')) || '').split('=')[1] || '';
const lean = process.argv.includes('--lean');
// `@collab` modules are OPT-IN: excluded by default, included only with --collab.
// (The inverse of `@optional`, which ships by default and drops under --lean.) Used
// to fence the P2P-presence collab feature out of the default/public artifact — it
// runtime-imports its carrier from a CDN, which the networkless/Sealed story can't
// carry. See spec_inbox/SPEC-gcu-seal.md + the federated-collab roadmap.
const collab = process.argv.includes('--collab');
const compress = process.argv.includes('--compress');
const execModeArg = (process.argv.find(a => a.startsWith('--exec-mode=')) || '').split('=')[1] || '';
const runOnLoadArg = (process.argv.find(a => a.startsWith('--run-on-load=')) || '').split('=')[1] || '';

// ── Shared: process modules from a main.js ──

// Read vendor-licenses.json + each entry's LICENSE file, return a manifest
// shape `{ <name>: { spdx, version, homepage, description, text } }`. Used
// by both the auditable and the works build paths.
function readBuildLicensesManifest() {
  const manifestPath = path.join(__dirname, 'vendor-licenses.json');
  const out = {};
  if (!fs.existsSync(manifestPath)) {
    console.warn('vendor-licenses: vendor-licenses.json not found at repo root — no vendored deps will be surfaced');
    return out;
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) {
    console.warn(`vendor-licenses: failed to parse vendor-licenses.json: ${e.message}`);
    return out;
  }
  for (const [name, entry] of Object.entries(manifest.vendored || {})) {
    const o = {
      spdx: entry.spdx || 'UNKNOWN',
      version: entry.version || null,
      homepage: entry.homepage || null,
      description: entry.description || null,
      text: null,
    };
    if (entry.licenseFile) {
      const lp = path.join(__dirname, entry.licenseFile);
      if (fs.existsSync(lp)) o.text = fs.readFileSync(lp, 'utf8');
      else console.warn(`vendor-licenses: ${name}: licenseFile ${entry.licenseFile} not found — entry will be metadata-only`);
    }
    out[name] = o;
  }
  return out;
}

// Walk every module in the bundle and replace any
// `const __BUILD_LICENSES__ = {};` placeholder with the real manifest.
// Returns the manifest so the caller can log a summary.
function injectBuildLicenses(modules) {
  const buildLicenses = readBuildLicensesManifest();
  const literal = 'const __BUILD_LICENSES__ = ' + JSON.stringify(buildLicenses) + ';';
  for (const mod of modules) {
    if (mod.source && mod.source.includes('const __BUILD_LICENSES__ = {};')) {
      mod.source = mod.source.replace('const __BUILD_LICENSES__ = {};', () => literal);
    }
  }
  return buildLicenses;
}

function processModules(mainPath, moduleDir, opts = {}) {
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const importPaths = [];
  for (const rawLine of mainSrc.split('\n')) {
    const line = rawLine.replace(/\r$/, '');   // CRLF-safe; $ in the regex won't anchor across \r
    if (opts.lean && line.includes('@optional')) continue;
    if (!opts.collab && line.includes('@collab')) continue;   // opt-in; default off
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

if (target === 'works' || target === 'works-all' || target === 'works-core') {
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
    // Jupyter .ipynb ⇄ Auditable bridge — used by works/js/import.js for
    // File → Import notebook… and the tree's right-click → Import as
    // notebook on .ipynb files.
    ['ipynb',  'ext/ipynb/index.js'],
    // The notebook's pure serializer — shared so the shell can import a
    // standalone notebook into a project (works/js/import.js).
    ['serialize', 'src/js/serialize.js'],
    // Vendored license inventory — used by works-service.js to expose
    // Licenses.Get and by the workspace Settings surface to render the
    // licenses table. See licenses-spec §7.3 + §8.1.
    ['licenses', 'ext/licenses/index.js'],
    // Archive format handling — used by works-service.js's Archive A-Bus
    // service and by tree.js's Extract/Compress/Download actions. Vendors
    // fflate (ZIP) + fzstd (zstd decode) — both inlined in the bundle.
    ['archive',  'ext/archive/index.js'],
    // EPUB reader — used by works/js/book-import.js to ingest a dropped
    // .epub into a /home/.books/library/<slug>/ book.json + html chapters.
    ['epub',     'ext/epub/index.js'],
    // .gcupkg consumer (EXTENSION_SPEC §6.1) — used by file-ops.js to
    // sideload extensions dropped onto the workspace. Pure logic; takes
    // the archive lib as a parameter.
    ['gcupkg',   'src/js/gcupkg.js'],
    // Capsule transport — used by init.js's #capsule boot handler to decode
    // share-link / QR registry-pointers (QR → install). Inline schemes only.
    ['capsule',  'ext/capsule/index.js'],
    // @gcu/sw page-side companion — init.js wires persist + the gcu-sw:*
    // update protocol (toast → coordinated reload) through it. The worker
    // itself is generated by ext/sw/make.mjs in the works repo's deploy.
    ['sw-register', 'ext/sw/register.js'],
    // NB: the geoscience/tabular workbench base libs (sluice/recon/flowsheet)
    // are NO LONGER shell-import registry entries — the @gcu/workbench package's
    // pipeline service is dependency-injected and resolves them via getLibSource
    // (the /usr/lib payloads). proc stays a /usr/lib payload (the terminal +
    // the activator both use it via getLibSource), not a shell-import entry.
  ]) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) {
      console.error(`Error: ${rel} not found — build the ext package first.`);
      process.exit(1);
    }
    const src = fs.readFileSync(p, 'utf8').replace(/^\n+/, '').replace(/\n+$/, '');
    modules.unshift({ name, source: src });
  }

  // Build-time placeholders (version / build date / public key etc.) for
  // the About modal and any future module that needs them. Same shape as
  // the auditable target's injection loop further down — modules opt in
  // by declaring a const with the matching placeholder value.
  const worksPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const worksBuildDate = buildDateFromGit();
  const worksRelease = process.env.AUDITABLE_RELEASE || 'dev';
  const worksPubKey = process.env.AUDITABLE_PUBLIC_KEY || '';
  const worksRepo = process.env.AUDITABLE_REPO || 'gentropic/auditable';
  // The package catalog URL — same-origin with the Works PWA (gentropic.org/works).
  // Overridable for a different deploy via AUDITABLE_CATALOG_URL.
  const worksCatalogUrl = process.env.AUDITABLE_CATALOG_URL || 'https://gentropic.org/works/packages/registry.json';
  for (const mod of modules) {
    mod.source = mod.source.replace(
      "const __GCU_CATALOG_URL__ = 'https://gentropic.org/works/packages/registry.json';",
      `const __GCU_CATALOG_URL__ = '${worksCatalogUrl}';`);
    mod.source = mod.source.replace(
      "const __AUDITABLE_VERSION__ = '0.0.0';",
      `const __AUDITABLE_VERSION__ = '${worksPkg.version || '0.0.0'}';`);
    mod.source = mod.source.replace(
      "const __AUDITABLE_BUILD_DATE__ = 'dev';",
      `const __AUDITABLE_BUILD_DATE__ = '${worksBuildDate}';`);
    mod.source = mod.source.replace(
      "const __AUDITABLE_RELEASE__ = 'dev';",
      `const __AUDITABLE_RELEASE__ = '${worksRelease}';`);
    mod.source = mod.source.replace(
      "const __AUDITABLE_PUBLIC_KEY__ = '';",
      `const __AUDITABLE_PUBLIC_KEY__ = '${worksPubKey}';`);
    mod.source = mod.source.replace(
      "const __AUDITABLE_REPO__ = 'gentropic/auditable';",
      `const __AUDITABLE_REPO__ = '${worksRepo}';`);
  }
  // licenses-spec §7.3 — vendor licenses available to the works shell too.
  // Any works module declaring `const __BUILD_LICENSES__ = {};` opts in.
  const _worksBuildLicenses = injectBuildLicenses(modules);
  console.log(`vendor-licenses (works): bundled ${Object.keys(_worksBuildLicenses).length} entries`);

  const worksJs = generateModuleBoot('', modules, '');

  // CSS: the shell's own stylesheet + the component theme sheets. The
  // structural sheets (rails.css / menu.css / dialog.css) are appended
  // verbatim — they don't define any tokens. The decorative *-default.css
  // sheets get their :root blocks STRIPPED so works/style.css's own :root
  // is what populates --ui-* / --rails-* — same pattern auditable uses.
  // Without this, the component defaults' dark-only tokens would clobber
  // works/style.css's light-defaults + dark-override cascade.
  let worksCss = fs.readFileSync(path.join(worksDir, 'style.css'), 'utf8');
  for (const cssRel of [
    'ext/rails/rails.css', 'ext/rails/rails-default.css',
    'ext/menu/menu.css', 'ext/menu/menu-default.css',
    'ext/dialog/dialog.css', 'ext/dialog/dialog-default.css',
  ]) {
    const p = path.join(__dirname, cssRel);
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    if (cssRel.endsWith('-default.css')) {
      src = src.replace(/:root\s*\{[\s\S]*?\}\s*/m, '');
    }
    worksCss += '\n\n' + src.trimEnd();
  }

  // Bundle the Switchboard fonts (Barlow + Space Mono) directly into
  // works.html so the workspace UI gets them offline + first paint.
  // No size-stingyness here — Works is a desktop bundle, not a single-
  // notebook artefact; ~50 KB for proper typography is rounding error.
  const fontsDir = path.join(__dirname, 'ext/switchboard/fonts');
  const fontFaces = [
    { file: 'barlow-400.woff2',       family: 'Barlow',     weight: 400, style: 'normal' },
    { file: 'barlow-500.woff2',       family: 'Barlow',     weight: 500, style: 'normal' },
    { file: 'barlow-600.woff2',       family: 'Barlow',     weight: 600, style: 'normal' },
    { file: 'barlow-700.woff2',       family: 'Barlow',     weight: 700, style: 'normal' },
    { file: 'space-mono-400.woff2',   family: 'Space Mono', weight: 400, style: 'normal' },
    { file: 'space-mono-400i.woff2',  family: 'Space Mono', weight: 400, style: 'italic' },
    { file: 'space-mono-700.woff2',   family: 'Space Mono', weight: 700, style: 'normal' },
  ];
  const fontFaceBlocks = [];
  for (const f of fontFaces) {
    const p = path.join(fontsDir, f.file);
    if (!fs.existsSync(p)) continue;
    const b64 = fs.readFileSync(p).toString('base64');
    fontFaceBlocks.push(
      `@font-face{font-family:'${f.family}';font-weight:${f.weight};`
      + `font-style:${f.style};font-display:swap;`
      + `src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
  }
  if (fontFaceBlocks.length > 0) {
    worksCss = fontFaceBlocks.join('\n') + '\n\n' + worksCss;
  }

  const worksTemplate = fs.readFileSync(path.join(worksDir, 'template.html'), 'utf8');

  // ── Shared libraries + surface payloads (auditable-works-spec §15) ──
  //
  // §15.2 dynamic linking: deps the small surfaces share (abus, vfs, xterm,
  // geas) are embedded ONCE at the top of works.html as gzipped payloads.
  // Each surface that uses a dep imports it via bare specifier ('@gcu/abus');
  // build-time injects an import map per surface with `##LIB_<name>##`
  // placeholders; the shell decompresses lib payloads to blob URLs at boot
  // and substitutes the placeholders before each surface gets blob-URL'd.
  //
  // Bytes win: the geas bundle (250 KB) was previously inlined twice in
  // the terminal surface alone (main thread + worker payload); abus was
  // inlined in five surfaces. Both collapse to one copy each.
  //
  // §15.1 static linking is still the auditable.html notebook surface's
  // path (embedded whole) — its own runtime resolves its own imports
  // internally, doesn't need to participate in this map.
  const worksZlib = require('zlib');
  // Self-extracting compression for the shell runtime (the lib/surface/docs/examples
  // payloads are already gzipped; this gzips the raw shell JS — the dominant byte cost,
  // ~59% of works-core). The CSS stays raw in <head> to avoid FOUC. DecompressionStream
  // gzip is ~ms, so boot cost is negligible. Reuses make_example's proven loader.
  const { compressRuntimeNode: compressWorksRuntime } = require('./make_example');

  const isWorksAll = (target === 'works-all');
  const isWorksCore = (target === 'works-core');
  // works-core's /usr/lib set = the dep-union of the CORE surfaces (CORE_KINDS at the
  // surfaces loop): stub/text/preview/inspector/settings/library/terminal. Every heavy
  // surface lib is provisioned, not bundled. (The terminal surface uses @gcu/term — the
  // light 20 KB-gz renderer — not xterm.) See spec_inbox/gcu-distributions-spec.md.
  // 'markdown' = @gcu/markdown (~13 KB gz) — the preview surface (CORE) renders
  // .md with it (READMEs, welcome docs), replacing its old line-regex mini-fork.
  const CORE_LIBS = ['abus', 'surface', 'menu', 'qr', 'capsule', 'vfs', 'term', 'geas', 'proc', 'readline', 'markdown'];
  // NB: 'strata-app' (the shared strata app core, source-override below) must
  // precede 'loom'/'strata'/'recon'/'archive' — the runtime surface inliner
  // iterates in this order, and inlining strata-app first is what brings its
  // bare @gcu/* imports into the surface text so those libs inline after it.
  const SHARED_LIBS_BASE = ['abus', 'surface', 'strata-app', 'loom', 'strata', 'over', 'plate', 'sift', 'vfs', 'term', 'geas', 'proc', 'readline', 'markdown', 'librarian', 'docview', 'katex', 'reader-core', 'capsule', 'qr', 'ipynb', 'cm6', 'acorn', 'menu', 'template', 'yaml', 'epub', 'archive', 'sideact', 'patchbay', 'sluice', 'recon', 'flowsheet', 'bearing', 'stereonet', 'omf1', 'wasm4'];
  // For --target=works-all: bundle every ext/<name>/index.js that's a real
  // bundle (skip the re-export shims under ~1 KB — they break the
  // single-file SHARED_LIBS pattern because they import from sibling files).
  // Directories prefixed `example-` are reference examples shipped as
  // standalone .gcupkg distributables (not bundled into any works build);
  // they exist as a documentation aid for EXTENSION_SPEC.md and must be
  // installed by the user to exercise them.
  function _allExtBundles() {
    const base = new Set(SHARED_LIBS_BASE);
    const extra = [];
    const extDir = path.join(__dirname, 'ext');
    for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('example-')) continue;   // reference examples — not bundled
      const idx = path.join(extDir, entry.name, 'index.js');
      if (!fs.existsSync(idx)) continue;
      const size = fs.statSync(idx).size;
      if (size < 1024) continue;                    // re-export shim (lfm, msh)
      if (base.has(entry.name)) continue;           // already in base
      extra.push(entry.name);
    }
    extra.sort();
    return [...SHARED_LIBS_BASE, ...extra];
  }
  const SHARED_LIBS = isWorksAll ? _allExtBundles() : isWorksCore ? CORE_LIBS : SHARED_LIBS_BASE;

  // works-all also bundles the atra libraries (pre-compiled JS+Wasm
  // distributions) under /usr/lib/@atra/<name>/. These are what
  // `load('@atra/alpack')` resolves to (vs the .src.js source-form
  // exports that load('./ext/atra/lib/<name>.src.js') returns).
  function _allAtraLibs() {
    if (!isWorksAll) return [];
    const libDir = path.join(__dirname, 'ext', 'atra', 'lib');
    if (!fs.existsSync(libDir)) return [];
    const out = [];
    for (const f of fs.readdirSync(libDir).sort()) {
      // Bundled distribution (alpack.js, gslib.js, raster.js); skip the
      // .src.js source-form variants and .atra source.
      if (!f.endsWith('.js') || f.endsWith('.src.js')) continue;
      const name = f.slice(0, -'.js'.length);
      out.push({ name, file: path.join(libDir, f) });
    }
    return out;
  }
  const ATRA_LIBS = _allAtraLibs();
  if (isWorksAll) {
    console.log(`works-all: bundling ${SHARED_LIBS.length} libraries (${SHARED_LIBS.join(', ')})`);
    if (ATRA_LIBS.length) {
      console.log(`works-all: bundling ${ATRA_LIBS.length} atra libs (${ATRA_LIBS.map(l => '@atra/' + l.name).join(', ')})`);
    }
  }

  // buildLibPayloads reads via _libSourcePath which checks this map first.
  // (The 'markdown' override is GONE — @gcu/markdown lives at the
  // ext/markdown/index.js convention now; src/js/markdown.js is a thin
  // renderMd wrapper over it. Surfaces import render/presets directly.)
  const SHARED_LIB_SOURCE_OVERRIDES = {
    // The strata app core (createStrataApp) is shared verbatim between the
    // standalone tool and the Works surface; the surface imports it via
    // '../../tools/strata/js/app.js' and the build inlines it as `strata-app`.
    'strata-app': 'tools/strata/js/app.js',
    // CM6 ships as a classic IIFE that sets `var CM6 = ...` (no ESM
    // exports). Surfaces using it can't `import { … } from '@gcu/cm6'`
    // — they place a `/* @cm6-inline */` placeholder where the IIFE
    // source should land, and `_inlineLibsIntoSurface` substitutes it
    // at surface-decompression time. The lib payload itself ships via
    // the standard <script id="lib-cm6"> path; only the inlining
    // mechanism differs.
    cm6: 'ext/cm6/cm6.min.js',
    // Acorn (+ acorn-typescript) — the JS parser for AIR. Also a classic IIFE
    // (sets window.Acorn); the notebook package's `classics` assembly entries
    // resolve it via ensureLibSource. works/works-all bake it (works-core
    // provisions @gcu/acorn from the catalog).
    acorn: 'ext/acorn/acorn.min.js',
  };

  // For SHARED_LIB_SOURCE_OVERRIDES entries (like 'markdown' from
  // src/js/markdown.js) the import path doesn't follow the
  // `ext/<dep>/index.js` convention. The rewrite logic accepts either
  // the conventional path OR the explicit override path for those deps.
  function _depImportPaths(dep) {
    const paths = [`ext/${dep}/index.js`];
    if (SHARED_LIB_SOURCE_OVERRIDES[dep]) {
      paths.push(SHARED_LIB_SOURCE_OVERRIDES[dep]);
    }
    return paths;
  }

  function rewriteSurfaceToDynamic(html, name, allowDeps) {
    // Rewrite each `ext/<dep>/index.js` import to a bare specifier
    // '@gcu/<dep>' and inject a placeholder import map at the top of
    // <head>. Stray imports (not in the allow-list) error out.
    //
    // Strip template literals before scanning — the terminal surface
    // builds its worker source via a backtick string containing an
    // `import` statement; that's text, not a real top-level import.
    const scan = html.replace(/`[^`]*`/g, '``');
    const imports = scan.match(/^\s*import\s[^\n]*$/gm) || [];
    const stray = imports.filter((i) =>
      !allowDeps.some((d) => _depImportPaths(d).some((p) => i.includes(p))));
    if (stray.length) {
      console.error(`Error: surface ${name} has stray imports — allow-list is `
        + `[${allowDeps.join(', ')}]:\n  ` + stray.join('\n  '));
      process.exit(1);
    }
    let out = html;
    for (const dep of allowDeps) {
      for (const depPath of _depImportPaths(dep)) {
        const escaped = depPath.replace(/[/.]/g, (c) => '\\' + c);
        const re = new RegExp(`(['"])[^'"]*${escaped}\\1`, 'g');
        out = out.replace(re, () => `'@gcu/${dep}'`);
      }
    }
    const imports2 = Object.fromEntries(
      allowDeps.map((d) => [`@gcu/${d}`, `##LIB_${d}##`]));
    const importMap = '<script type="importmap">\n'
      + JSON.stringify({ imports: imports2 }, null, 2) + '\n</script>';
    // Insert the importmap as the very first child of <head> so the
    // browser sees it before any <script type="module"> is parsed.
    return out.replace(/<head>/, '<head>\n' + importMap);
  }

  function buildLibPayloads() {
    const parts = [];
    for (const name of SHARED_LIBS) {
      const rel = SHARED_LIB_SOURCE_OVERRIDES[name] || `ext/${name}/index.js`;
      const p = path.join(__dirname, rel);
      if (!fs.existsSync(p)) {
        console.error(`Error: ${rel} not found — build it first`);
        process.exit(1);
      }
      const src = fs.readFileSync(p, 'utf8');
      const gz = worksZlib.gzipSync(Buffer.from(src, 'utf8'));
      const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
      parts.push(`<script type="text/plain" id="lib-${name}">\n${b64}\n</script>`);
    }
    // Atra libraries — separate id namespace (atralib-) so the shell
    // can route them to /usr/lib/@atra/<name>/ rather than the default
    // /usr/lib/@gcu/<name>/ that the lib- prefix implies.
    for (const lib of ATRA_LIBS) {
      const src = fs.readFileSync(lib.file, 'utf8');
      const gz = worksZlib.gzipSync(Buffer.from(src, 'utf8'));
      const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
      parts.push(`<script type="text/plain" id="atralib-${lib.name}">\n${b64}\n</script>`);
    }
    // Shared theme assets — same gzip+base64 envelope as a lib payload,
    // but the runtime routes them into theme-substitution rather than
    // bare-import inlining. Built-in surfaces have these substituted at
    // build time (see injectSharedTheme above); extension surfaces from
    // .gcupkg packages get them substituted at spawn time when the
    // shell inlines /lib/<pkg>/<file>.html.
    for (const [id, rel] of [
      ['theme-css', 'works/surfaces/_theme.css'],
      ['theme-init', 'works/surfaces/_theme-init.js'],
    ]) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const gz = worksZlib.gzipSync(Buffer.from(src, 'utf8'));
      const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
      parts.push(`<script type="text/plain" id="${id}">\n${b64}\n</script>`);
    }
    return parts.join('\n');
  }

  // ── Documentation bundle ────────────────────────────────────────────
  // Read docs/*.md (the mkdocs source, nav from mkdocs.yml) plus every
  // ext/<pkg>/SPEC.md and ext/<pkg>/README.md. Gzip+base64 the whole
  // thing into a single payload; the shell decompresses it into the
  // workspace VFS at /usr/share/doc/ at boot. The docs surface reads
  // from there.
  function _parseMkdocsNav() {
    const ymlPath = path.join(__dirname, 'mkdocs.yml');
    if (!fs.existsSync(ymlPath)) return [];
    const text = fs.readFileSync(ymlPath, 'utf8');
    const lines = text.split('\n');
    const navStart = lines.findIndex((l) => /^nav:/.test(l));
    if (navStart < 0) return [];
    const out = [];
    const stack = [{ indent: -1, list: out }];
    for (let i = navStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*-/.test(line)) {
        if (line.trim() === '' || /^[a-zA-Z]/.test(line)) break;
        continue;
      }
      const m = line.match(/^(\s*)-\s*(.+)$/);
      if (!m) continue;
      const indent = m[1].length;
      const body = m[2];
      while (stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1].list;
      // Two forms: "Label: file.md"  (leaf)  or  "Label:"  (group → next lines are children)
      const leaf = body.match(/^([^:]+):\s*(.+\.md)\s*$/);
      const group = body.match(/^([^:]+):\s*$/);
      if (leaf) {
        parent.push({ label: leaf[1].trim(), file: leaf[2].trim() });
      } else if (group) {
        const node = { label: group[1].trim(), children: [] };
        parent.push(node);
        stack.push({ indent, list: node.children });
      }
    }
    return out;
  }

  function buildDocsPayload() {
    const docs = {};   // path → content
    // docs/*.md (mkdocs source, walked via the nav)
    function walkNav(list) {
      for (const item of list) {
        if (item.file) {
          const p = path.join(__dirname, 'docs', item.file);
          if (fs.existsSync(p)) {
            docs['docs/' + item.file] = fs.readFileSync(p, 'utf8');
          }
        }
        if (item.children) walkNav(item.children);
      }
    }
    const nav = _parseMkdocsNav();
    walkNav(nav);
    // ext/<pkg>/SPEC.md + README.md
    const extDir = path.join(__dirname, 'ext');
    const extPkgs = fs.readdirSync(extDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const extEntries = [];
    for (const pkg of extPkgs) {
      const spec = path.join(extDir, pkg, 'SPEC.md');
      const readme = path.join(extDir, pkg, 'README.md');
      if (fs.existsSync(spec)) {
        const rel = `ext/${pkg}/SPEC.md`;
        docs[rel] = fs.readFileSync(spec, 'utf8');
        extEntries.push({ pkg, file: rel, kind: 'SPEC' });
      }
      if (fs.existsSync(readme)) {
        const rel = `ext/${pkg}/README.md`;
        docs[rel] = fs.readFileSync(readme, 'utf8');
        extEntries.push({ pkg, file: rel, kind: 'README' });
      }
    }
    const manifest = { nav, extensions: extEntries };
    const payload = { version: 1, manifest, docs };
    const json = JSON.stringify(payload);
    const gz = worksZlib.gzipSync(Buffer.from(json, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    return `<script type="text/plain" id="docs-payload">\n${b64}\n</script>`;
  }
  const docsPayload = isWorksCore ? '' : buildDocsPayload();

  // ── Examples payload (works-all only) ──────────────────────────────
  // Walk examples/defs/<category>/*.txt; bundle as { 'category/name.txt':
  // content } JSON, gzip+base64. The shell decompresses into
  // /usr/share/examples/ in the workspace VFS on first boot.
  // Rewrite an example .txt so its module references resolve under
  // works-all's runtime, where extensions live at /usr/lib/@gcu/<name>/
  // rather than at relative ./ext/ paths.
  //
  // Rewrites applied:
  //   ./ext/<name>/index.js          → @gcu/<name>
  //   ./ext/<name>/<sub>.js          → @gcu/<name>/<sub>
  //   @plan                          → @gcu/plan (legacy alias used by a few defs)
  //
  // What stays broken (no clean home in /usr/lib):
  //   @atra/<lib>  (atra libraries — pre-compiled .src.js)
  //   @demo/<name> (per-example data — sherlock, aesop, etc.)
  //
  // Returns { source, unresolvable: ['@atra/alpack', ...] } so the
  // manifest can flag examples whose pickered version won't fully run.
  function _rewriteExampleForWorks(src) {
    let out = src
      // Module directive: /// module: <url> <build-time-path>
      .replace(/^(\/\/\/ module: )\.\/ext\/([\w-]+)\/index\.js( .*)$/gm,
               '$1@gcu/$2$3')
      .replace(/^(\/\/\/ module: )\.\/ext\/([\w-]+)\/([\w-]+)\.js( .*)$/gm,
               '$1@gcu/$2/$3$4')
      .replace(/^(\/\/\/ module: )@plan( .*)$/gm,
               '$1@gcu/plan$2')
      // load()/install() calls in code cells
      .replace(/(load|install|installBinary)\((['"`])\.\/ext\/([\w-]+)\/index\.js\2\)/g,
               '$1($2@gcu/$3$2)')
      .replace(/(load|install|installBinary)\((['"`])\.\/ext\/([\w-]+)\/([\w-]+)\.js\2\)/g,
               '$1($2@gcu/$3/$4$2)')
      .replace(/(load|install|installBinary)\((['"`])@plan\2\)/g,
               '$1($2@gcu/plan$2)');

    // Detect remaining unresolvable references. @atra/* IS resolvable in
    // works-all (we bundle the libraries under /usr/lib/@atra/), so it's
    // not flagged. @demo/* (per-example data) and the .src.js variants of
    // atra libraries (different export shape from @atra/*) stay flagged.
    const unresolvable = new Set();
    for (const m of out.matchAll(/@demo\/[\w-]+/g)) unresolvable.add(m[0]);
    for (const m of out.matchAll(/\.\/ext\/atra\/lib\/[\w-]+\.src\.js/g)) {
      unresolvable.add(m[0]);
    }
    // Leftover ./ext/* refs not caught by the rewrite (multi-segment
    // paths). Skip atra/lib (handled separately above).
    for (const m of out.matchAll(/\.\/ext\/(?!atra\/lib)[\w-]+(?:\/[\w-]+)*/g)) {
      unresolvable.add(m[0]);
    }

    return { source: out, unresolvable: [...unresolvable] };
  }

  function buildExamplesPayload() {
    if (!isWorksAll) return '';
    const examplesRoot = path.join(__dirname, 'examples', 'defs');
    if (!fs.existsSync(examplesRoot)) return '';
    const defs = {};
    const manifest = { categories: {} };
    let rewroteCount = 0;
    let unresolvedCount = 0;
    for (const cat of fs.readdirSync(examplesRoot, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue;
      if (cat.name === 'data-corpora') continue;     // raw Gutenberg dumps + builder
      const catPath = path.join(examplesRoot, cat.name);
      const files = fs.readdirSync(catPath).filter((f) => f.endsWith('.txt')).sort();
      if (files.length === 0) continue;
      manifest.categories[cat.name] = [];
      for (const f of files) {
        const rel = cat.name + '/' + f;
        const raw = fs.readFileSync(path.join(catPath, f), 'utf8');
        const { source, unresolvable } = _rewriteExampleForWorks(raw);
        defs[rel] = source;
        if (source !== raw) rewroteCount++;
        if (unresolvable.length > 0) unresolvedCount++;
        const titleMatch = source.match(/^\/\/\/\s*title:\s*(.+?)\s*$/m);
        const title = titleMatch ? titleMatch[1] : f.replace(/^example_/, '').replace(/\.txt$/, '').replace(/_/g, ' ');
        const entry = { file: rel, name: f, title };
        if (unresolvable.length > 0) entry.unresolvable = unresolvable;
        manifest.categories[cat.name].push(entry);
      }
    }
    console.log(`works-all examples: rewrote ${rewroteCount} defs, ${unresolvedCount} still have unresolvable refs (@atra/* / @demo/* / leftover ./ext/*)`);
    const payload = { version: 1, manifest, defs };
    const json = JSON.stringify(payload);
    const gz = worksZlib.gzipSync(Buffer.from(json, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    return `<script type="text/plain" id="examples-payload">\n${b64}\n</script>`;
  }
  const examplesPayload = buildExamplesPayload();

  // ── Builtin packages payload (works / works-all; NOT works-core) ─────
  // Distribution-shipped packages pre-installed into /lib at boot. Each is a
  // real package directory (package.json + entry files); the shell's
  // lib-builtins-loader unpacks them into /lib/<name>/ (write-if-absent-or-
  // stale) and the surface scan + service scan pick them up like any user
  // install. works-core omits this payload — that's why pipeline + its libs
  // leave the lean shell (works-contribution-registry-spec phase 2).
  //
  // @gcu/workbench: the Data Workbench surface + the shell-side `pipeline`
  // A-Bus service (declared in its package.json gcu.services, activated cold).
  const BUILTIN_PACKAGES = [
    { dir: 'ext/workbench', files: ['package.json', 'service.js', 'works.js', 'surface.html'] },
    // @gcu/hex — a surface-only package (no service). Baked into /lib so
    // works/works-all carry the Hex viewer; works-core omits the payload and
    // provisions it from the catalog. The any-bytes universal fallback.
    { dir: 'ext/hex', files: ['package.json', 'works.js', 'surface.html'] },
    // @gcu/encode — surface-only path-less tool (base64/hex/url/json + hashes).
    { dir: 'ext/encode', files: ['package.json', 'works.js', 'surface.html'] },
    // @gcu/wasm4 — self-contained: index.js IS the engine (→ /source); the
    // surface imports @gcu/wasm4 from its own package source.
    { dir: 'ext/wasm4', files: ['package.json', 'index.js', 'works.js', 'surface.html'] },
    // @gcu/doc — Markdown editor; lib deps (archive/epub/template/yaml/cm6) via gcu.requires.
    { dir: 'ext/doc', files: ['package.json', 'works.js', 'surface.html'] },
    // @gcu/docs — documentation browser (docview/librarian).
    { dir: 'ext/docs', files: ['package.json', 'works.js', 'surface.html'] },
    // @gcu/book — reflowable reader (docview/katex/librarian/reader-core).
    { dir: 'ext/book', files: ['package.json', 'works.js', 'surface.html'] },
    // @gcu/dd60 — retro reader skin (same lib deps as book).
    { dir: 'ext/dd60', files: ['package.json', 'works.js', 'surface.html'] },
    // @gcu/patchbay — self-contained: index.js IS the engine (→ /source); the
    // surface imports @gcu/patchbay from its own source, pulls @gcu/sideact.
    { dir: 'ext/patchbay', files: ['package.json', 'index.js', 'works.js', 'surface.html'] },
    // @gcu/strata — self-contained: index.js IS the table lib (→ /source); the
    // surface's strata-app core pulls strata-app/loom/over/archive/recon.
    { dir: 'ext/strata', files: ['package.json', 'index.js', 'works.js', 'surface.html'] },
    // @gcu/plate — self-contained: index.js IS the compositor lib (→ /source);
    // pulls @gcu/strata + recon/archive.
    { dir: 'ext/plate', files: ['package.json', 'index.js', 'works.js', 'surface.html'] },
  ];
  function buildBuiltinPackagesPayload() {
    if (isWorksCore) return '';
    const packages = [];
    for (const spec of BUILTIN_PACKAGES) {
      const pkgJsonPath = path.join(__dirname, spec.dir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        console.error(`Error: builtin package ${spec.dir}/package.json not found — build the package first.`);
        process.exit(1);
      }
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const files = {};
      for (const rel of spec.files) {
        const fp = path.join(__dirname, spec.dir, rel);
        if (!fs.existsSync(fp)) {
          console.error(`Error: builtin package ${spec.dir}/${rel} not found — run \`node ${spec.dir}/build.js\` first.`);
          process.exit(1);
        }
        files[rel] = fs.readFileSync(fp, 'utf8');
      }
      packages.push({ name: pkgJson.name, version: pkgJson.version || '0.0.0', files });
    }

    // @gcu/air (fragment) + @gcu/notebook (surface) — GENERATED packages (not
    // source dirs), built by the shared hoisted builders (the same file maps
    // the packages catalog ships). Baked into /lib so works/works-all carry the
    // notebook + its AIR fragment; works-core omits this payload and provisions
    // them from the catalog instead. Their lib deps (cm6/acorn baked via
    // SHARED_LIBS_BASE; vfs/abus/… already baked libs) resolve at assemble time.
    for (const spec of [buildAirPackageFiles(), buildNotebookPackageFiles()]) {
      packages.push({ name: spec.name, version: spec.version, files: spec.files });
    }

    if (packages.length === 0) return '';
    console.log(`works: bundling ${packages.length} builtin package(s) (${packages.map((p) => p.name + ' v' + p.version).join(', ')})`);
    const json = JSON.stringify({ version: 1, packages });
    const gz = worksZlib.gzipSync(Buffer.from(json, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    return `<script type="text/plain" id="pkg-builtins-payload">\n${b64}\n</script>`;
  }
  const builtinPkgsPayload = buildBuiltinPackagesPayload();

  // ── Distribution profiles payload (works-core only) ─────────────────
  // The lean shell's first-run setup picks a profile and provisions its packages
  // from the catalog. Bake the RESOLVED profiles (resolveToProvisioned) as a small
  // JSON payload so the profile LIST is available offline/first-paint; only the
  // package install needs the network. works/works-all are baked monoliths — they
  // don't provision, so they don't carry this. (distributions phase 3.)
  function buildProfilesPayload() {
    if (!isWorksCore) return '';
    const { resolveToProvisioned } = require('./profiles/resolve.js');
    const WORKS_PROFILES = ['works-minimal', 'works-notebook', 'works-geoscience', 'works-everything'];
    const profiles = [];
    for (const n of WORKS_PROFILES) {
      try { profiles.push(resolveToProvisioned(n, { profilesDir: path.join(__dirname, 'profiles') })); }
      catch (e) { console.error(`packages: profile ${n} failed to resolve: ${e.message}`); process.exit(1); }
    }
    const json = JSON.stringify({ version: 1, profiles });
    const gz = worksZlib.gzipSync(Buffer.from(json, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    console.log(`works-core: bundling ${profiles.length} distribution profiles (${profiles.map((p) => p.name).join(', ')})`);
    return `<script type="text/plain" id="profiles-payload">\n${b64}\n</script>`;
  }
  const profilesPayload = buildProfilesPayload();

  // Terminal-specific: inline @gcu/term's CSS (structural term.css + default theme),
  // the same pair the standalone geas tool uses. The geas-worker payload that used to
  // live here is gone — the terminal spawns its worker via the geas blob URL discovered
  // in its own import map (§15.2 sharing extends to module workers).
  function buildTerminalSurfaceCss(html) {
    const termCss = fs.readFileSync(path.join(__dirname, 'ext/term/term.css'), 'utf8');
    const termDefaultCss = fs.readFileSync(path.join(__dirname, 'ext/term/term-default.css'), 'utf8');
    return html.replace('/* @term-css */', termCss + '\n' + termDefaultCss);
  }

  // Shared theme tokens + theme-init JS — surfaces opt in by including the
  // `/* @theme-tokens */` placeholder in their <style> block and the
  // `/* @theme-init */` placeholder in their <script> block. Each surface
  // is a sandboxed iframe so the tokens have to land in each one
  // independently; centralizing here keeps the cascade in one place.
  const _themeCss = fs.readFileSync(path.join(worksDir, 'surfaces', '_theme.css'), 'utf8');
  const _themeJs  = fs.readFileSync(path.join(worksDir, 'surfaces', '_theme-init.js'), 'utf8');
  // Use line-anchored regexes — same shape as the runtime substitution in
  // works/js/surface-registry.js. A literal placeholder inside an inlined
  // comment would otherwise match and trigger a runaway second substitution
  // (the inlined _theme-init.js text used to mention `/* @theme-init */` in
  // its comments — fixed at the source, but the regex shape is the
  // defense-in-depth).
  const THEME_TOKEN_RE = /^[ \t]*\/\* @theme-tokens \*\/[ \t]*$/m;
  const THEME_INIT_RE  = /^[ \t]*\/\* @theme-init \*\/[ \t]*$/m;

  function injectSharedTheme(html) {
    if (THEME_TOKEN_RE.test(html)) html = html.replace(THEME_TOKEN_RE, _themeCss);
    if (THEME_INIT_RE.test(html))  html = html.replace(THEME_INIT_RE,  _themeJs);
    return html;
  }

  // For surfaces that import @gcu/menu (or @gcu/dialog), the component's
  // own CSS lives at ext/<dep>/<dep>.css + ext/<dep>/<dep>-default.css.
  // The shell bundles these into its own stylesheet, but surface iframes
  // have their own documents and need a separate copy. Read the CSS once
  // here; each dep gets its :root block stripped so the surface's
  // _theme.css cascade wins on tokens.
  function _loadComponentCss(dep) {
    const paths = [`ext/${dep}/${dep}.css`, `ext/${dep}/${dep}-default.css`];
    let out = '';
    for (const p of paths) {
      const fp = path.join(__dirname, p);
      if (!fs.existsSync(fp)) continue;
      let src = fs.readFileSync(fp, 'utf8');
      if (p.endsWith('-default.css')) {
        src = src.replace(/:root\s*\{[\s\S]*?\}\s*/m, '');
      }
      out += '\n\n/* ── ' + p + ' (inlined for surface) ── */\n' + src.trimEnd();
    }
    return out;
  }
  const _menuCss = _loadComponentCss('menu');

  // Inject menu CSS into a surface's first <style> block (right after the
  // theme tokens so component selectors can reference --au-*).
  function injectComponentCss(html, deps) {
    if (!deps || !deps.includes('menu')) return html;
    // Append menu CSS to the head's existing <style> — find the first
    // </style> and insert before it. Falls back to appending to <head>
    // if there's no <style> (unusual for surfaces).
    if (html.includes('</style>')) {
      return html.replace('</style>', _menuCss + '\n</style>');
    }
    return html.replace('</head>', '<style>' + _menuCss + '</style>\n</head>');
  }

  // works-core ships only the core surfaces (terminal/text/preview/inspector/settings/
  // library/stub); every other surface is provisioned, not bundled.
  const CORE_KINDS = new Set(['stub', 'launcher', 'text', 'preview', 'inspector', 'settings', 'library', 'terminal']);
  const surfaceParts = [];
  for (const s of [
    { kind: 'stub',      file: 'works/surfaces/stub.html',      deps: ['abus', 'surface'] },
    { kind: 'launcher',  file: 'works/surfaces/launcher.html',  deps: ['abus', 'surface'] },
    { kind: 'text',      file: 'works/surfaces/text.html',      deps: ['abus', 'surface', 'menu'] },
    // NB: the 'doc' surface ships as the @gcu/doc builtin package (lib deps
    // archive/epub/template/yaml via gcu.requires).
    { kind: 'preview',   file: 'works/surfaces/preview.html',   deps: ['abus', 'surface', 'markdown'] },
    { kind: 'inspector', file: 'works/surfaces/inspector.html', deps: ['abus', 'surface'] },
    { kind: 'settings',  file: 'works/surfaces/settings.html',  deps: ['abus', 'surface'] },
    // NB: the 'workbench' surface is no longer a built-in payload — it ships
    // inside the @gcu/workbench builtin package (pkg-builtins-payload below),
    // installed into /lib at boot and registered as a contributed surface.
    // NB: 'docs', 'book', 'dd60' ship as the @gcu/docs / @gcu/book / @gcu/dd60
    // builtin packages (docview/librarian/katex/reader-core via gcu.requires).
    { kind: 'library',   file: 'works/surfaces/library.html', deps: ['abus', 'surface', 'qr', 'capsule'] },
    { kind: 'terminal',  file: 'works/surfaces/terminal.html',
      deps: ['abus', 'surface', 'vfs', 'term', 'geas', 'proc', 'readline'], extras: 'terminal' },
    // NB: 'patchbay', 'strata', and 'plate' ship as self-contained @gcu/patchbay
    // / @gcu/strata / @gcu/plate builtin packages (engine index.js + surface).
    // NB: the 'hex', 'encode', and 'wasm4' surfaces are no longer built-in
    // payloads — they ship inside the @gcu/hex / @gcu/encode / @gcu/wasm4
    // builtin packages (pkg-builtins-payload above), installed into /lib at boot
    // and registered as contributed surfaces.
    // NB: the 'notebook' surface is no longer a built-in payload (auditable.html)
    // — it ships as the @gcu/notebook builtin package (pkg-builtins-payload),
    // assembled at spawn from its module tree. works no longer depends on a
    // pre-built auditable.html.
  ]) {
    if (isWorksCore && !CORE_KINDS.has(s.kind)) continue;
    if (isWorksCore && s.deps) {
      for (const d of s.deps) if (!CORE_LIBS.includes(d)) throw new Error(`works-core: surface '${s.kind}' needs lib '${d}' missing from CORE_LIBS`);
    }
    const sp = path.join(__dirname, s.file);
    if (!fs.existsSync(sp)) {
      console.error(`Error: surface source ${s.file} not found.`);
      process.exit(1);
    }
    let surfaceHtml = fs.readFileSync(sp, 'utf8');
    if (s.deps) surfaceHtml = rewriteSurfaceToDynamic(surfaceHtml, s.kind, s.deps);
    if (s.extras === 'terminal') surfaceHtml = buildTerminalSurfaceCss(surfaceHtml);
    surfaceHtml = injectSharedTheme(surfaceHtml);
    surfaceHtml = injectComponentCss(surfaceHtml, s.deps);
    const gz = worksZlib.gzipSync(Buffer.from(surfaceHtml, 'utf8'));
    const b64 = gz.toString('base64').replace(/.{1,76}/g, '$&\n');
    surfaceParts.push(`<script type="text/plain" id="surface-${s.kind}">\n${b64}\n</script>`);
  }
  const surfacePayloads = surfaceParts.join('\n');
  const libPayloads = buildLibPayloads();

  const worksHtml = `<!DOCTYPE html>
<!-- Auditable Works — the GCU desktop -->
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable Works</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='2' y='2' width='7' height='28' fill='%238a9099'/%3E%3Crect x='10' y='2' width='20' height='19' fill='%23d97a3c'/%3E%3Crect x='10' y='22' width='20' height='8' fill='%238a9099'/%3E%3C/svg%3E">
<style>
${worksCss}
</style>
</head>
<body>

${worksTemplate}

<!-- Auditable Works shared libraries — gzipped; the shell decompresses each
     to a blob URL at boot and substitutes ##LIB_<name>## in surface payloads
     (§15.2 dynamic linking). -->
${libPayloads}

<!-- Auditable Works surfaces — embedded payloads, blob-URL'd on spawn (§15.1) -->
${surfacePayloads}

<!-- Auditable Works documentation — docs/ + ext/*/SPEC.md + ext/*/README.md.
     Decompressed at boot into the workspace VFS at /usr/share/doc/ for the
     docs surface to read. -->
${docsPayload}

<!-- Auditable Works examples (works-all build only) — examples/defs/*.txt
     bundled as a gzipped JSON map. Decompressed at boot into the workspace
     VFS at /usr/share/examples/ for the Help → Open example… picker. -->
${examplesPayload}

<!-- Auditable Works builtin packages (works / works-all; omitted from works-core)
     — distribution-shipped .gcupkg-shaped packages (package.json + entry files),
     gzipped. The shell unpacks them into /lib/<name>/ at boot; the surface +
     service scans pick them up like any user install. @gcu/workbench lives here. -->
${builtinPkgsPayload}

<!-- Auditable works-core distribution profiles — resolved .gcuprofiles (the
     first-run setup's profile list), gzipped. works-core only. -->
${profilesPayload}

${compressWorksRuntime(worksJs)}
</body>
</html>
`;

  const outFile = isWorksCore ? 'works-core.html' : isWorksAll ? 'works-all.html' : 'works.html';
  fs.writeFileSync(path.join(__dirname, outFile), worksHtml);
  const worksSize = fs.statSync(path.join(__dirname, outFile)).size;
  console.log(`Built ${outFile} (${(worksSize / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: packages — the first-party code-package catalog
// ══════════════════════════════════════════════════
//
// Packs auditable's distributable first-party extensions (ext/<name>/) into
// .gcupkgs + emits a registry.json catalog, under packages/ (gitignored — a
// build output emitted to the deploy: "auditable hosts its own packages, the
// catalog points at them"; spec_inbox/gcu-packages-spec.md). works-core /
// provisioned shells add this catalog's URL as a (higher-trust) code source;
// gcu-library stays content-only. The artifacts are byte-deterministic (the
// git build date drives the ZIP timestamps), so the SRI in registry.json is
// stable across rebuilds of the same tree.
//
// A distributable here is a SHELL package (surface and/or service, no notebook
// index.js). Its lib deps (a service's `requires`) are NOT yet packaged — the
// dep-closure installer is the next step; until then a provisioned package whose
// libs aren't already present won't fully activate (the lib resolution exists,
// the auto-install of the closure doesn't).
if (target === 'packages') {
  (async () => {
    const { packGcupkg, sriOfBytes } = await import('./ext/pack-gcupkg.mjs');
    const buildDate = buildDateFromGit();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(buildDate) ? new Date(buildDate + 'T00:00:00Z') : new Date(0);

    // The catalog manifest — auditable's distributable first-party extensions.
    const DISTRIBUTABLES = [
      { dir: 'ext/example-service', files: ['package.json', 'service.js', 'LICENSE', 'README.md'],
        contributes: ['service'], integrityCovers: ['service.js'],
        title: 'Echo (reference service)', tags: ['example', 'reference', 'service'] },
      { dir: 'ext/workbench', files: ['package.json', 'service.js', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface', 'service'], integrityCovers: ['service.js', 'works.js', 'surface.html'],
        title: 'Data Workbench', tags: ['geoscience', 'tabular', 'blockmodel'] },
      { dir: 'ext/hex', files: ['package.json', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['works.js', 'surface.html'],
        title: 'Hex viewer', tags: ['binary', 'viewer', 'universal'] },
      { dir: 'ext/encode', files: ['package.json', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['works.js', 'surface.html'],
        title: 'Encode / Hash', tags: ['encode', 'hash', 'tool'] },
      { dir: 'ext/wasm4', files: ['package.json', 'index.js', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['index.js', 'works.js', 'surface.html'],
        title: 'WASM-4 console', tags: ['wasm4', 'fantasy-console', 'game'] },
      { dir: 'ext/doc', files: ['package.json', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['works.js', 'surface.html'],
        title: 'Document editor', tags: ['markdown', 'document', 'editor'] },
      { dir: 'ext/docs', files: ['package.json', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['works.js', 'surface.html'],
        title: 'Documentation browser', tags: ['documentation', 'browser'] },
      { dir: 'ext/book', files: ['package.json', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['works.js', 'surface.html'],
        title: 'Book reader', tags: ['reader', 'book', 'epub'] },
      { dir: 'ext/dd60', files: ['package.json', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['works.js', 'surface.html'],
        title: 'DADA Diskman', tags: ['reader', 'retro', 'skin'] },
      { dir: 'ext/patchbay', files: ['package.json', 'index.js', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['index.js', 'works.js', 'surface.html'],
        title: 'Patchbay', tags: ['patchbay', 'dataflow', 'reactive'] },
      { dir: 'ext/strata', files: ['package.json', 'index.js', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['index.js', 'works.js', 'surface.html'],
        title: 'Strata', tags: ['table', 'columnar', 'geoscience'] },
      { dir: 'ext/plate', files: ['package.json', 'index.js', 'works.js', 'surface.html', 'LICENSE', 'README.md'],
        contributes: ['surface'], integrityCovers: ['index.js', 'works.js', 'surface.html'],
        title: 'Plate (figure)', tags: ['figure', 'compositor', 'plot'] },
      // Language packs — notebook cell types delivered as data-declared (gcu.languages)
      // .gcupkgs. index.js is the bundle (→ /source); it registers the cell type +
      // tag + AIR lowerer on first load (cold→hot). The picker offers it cold.
      { dir: 'ext/adder', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['language'], integrityCovers: ['index.js'],
        title: 'Python (adder)', tags: ['language', 'python', 'adder'] },
      { dir: 'ext/soft', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['language'], integrityCovers: ['index.js'],
        title: 'Soft', tags: ['language', 'soft', 'english-keywords'] },
      // Library packs — importable in adder/JS cells. gcu.adderExports lets
      // `import plt` / `import sadpan` resolve offline (the install surfaces it
      // onto meta.json → resolveAdderModule).
      { dir: 'ext/plot', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['library'], integrityCovers: ['index.js'],
        title: 'plot (matplotlib-style)', tags: ['library', 'plot', 'matplotlib'] },
      { dir: 'ext/sadpan', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['library'], integrityCovers: ['index.js'],
        title: 'sadpan (pandas-style)', tags: ['library', 'dataframe', 'pandas'] },
      // Tagged-language packs — template tags used inside JS cells (e.g. sql`…`);
      // register their tag on load. Not cell-type languages (not picker entries).
      { dir: 'ext/sql', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['taggedLanguage'], integrityCovers: ['index.js'],
        title: 'SQL (tag)', tags: ['language', 'sql', 'tag'] },
      { dir: 'ext/shader', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['taggedLanguage'], integrityCovers: ['index.js'],
        title: 'GLSL shader (tag)', tags: ['language', 'glsl', 'shader'] },
      { dir: 'ext/calque', files: ['package.json', 'index.js', 'LICENSE', 'README.md'],
        contributes: ['taggedLanguage'], integrityCovers: ['index.js'],
        title: 'Calque (tag)', tags: ['language', 'calque', 'spreadsheet'] },
    ];

    // Lib dependencies that the distributables' services `require` — packaged as
    // lib-packages (a .gcupkg whose index.js IS the bundle, so installGcupkg writes
    // it to /lib/@gcu/<lib>/source, where ensureLibSource finds it). These let a
    // provisioned shell install a package's dep-closure (build.js bakes them into
    // works/works-all, but works-core must pull them).
    // sideact/ipynb/template back @gcu/notebook's requires that AREN'T works-core
    // CORE_LIBS (vfs/abus/markdown/proc/menu/term are baked → the closure skips
    // them; cm6/acorn are packed as classic libs above).
    const LIB_DEPS = ['flowsheet', 'sluice', 'recon', 'omf1', 'sideact', 'ipynb', 'template',
      // shared libs the provisionable surface packages require (doc/docs/book/dd60):
      // markdown/menu are CORE_LIBS (baked, skipped by the closure); these aren't.
      'archive', 'epub', 'yaml', 'docview', 'librarian', 'katex', 'reader-core',
      // geo surfaces (strata/plate): strata-app is sourced from tools/strata (see
      // LIB_SRC_OVERRIDE); loom/over are real ext libs. The strata + plate libs
      // ship INSIDE their self-contained surface packages (kind name == lib name),
      // not as standalone lib-packages — same as wasm4/patchbay.
      'strata-app', 'loom', 'over'];   // proc is a works-core CORE_LIB (already baked)
    // Libs whose source isn't ext/<lib>/index.js (mirrors the SHARED_LIBS override).
    const LIB_SRC_OVERRIDE = { 'strata-app': 'tools/strata/js/app.js' };
    const LIB_LICENSE = 'MIT License\n\nCopyright (c) 2026 Arthur Endlein Correia / Geoscientific Chaos Union\n\n'
      + 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in it '
      + 'without restriction. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n';

    const outDir = path.join(__dirname, 'packages');
    const distDir = path.join(outDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    const entries = [];

    // Pack a builder-produced package spec into a .gcupkg catalog entry. `spec`
    // is { name, version, description, license, files: {rel→source},
    // integrityCovers, contributes, title, tags } — the COMPLETE files map the
    // shared builders (buildAirPackageFiles / buildNotebookPackageFiles)
    // assembled, the same map the works builtin payload bakes. Integrity covers
    // whatever the builder declared (assembly.json + module sources + executable
    // extras); the flat npm bundle, if ever shipped, would be non-covered.
    const packSpec = (spec) => {
      const fileBufs = {};
      for (const [k, v] of Object.entries(spec.files)) fileBufs[k] = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
      const { bytes } = packGcupkg({
        name: spec.name, version: spec.version, description: spec.description,
        license: spec.license, files: fileBufs, contributes: spec.contributes,
        integrityCovers: spec.integrityCovers, date,
      });
      const slug = spec.name.replace(/[@/]/g, '_');
      const rel = `dist/${slug}.gcupkg`;
      fs.writeFileSync(path.join(outDir, rel), bytes);
      const moduleCount = Object.keys(spec.files).filter((f) => f.startsWith('modules/')).length;
      entries.push({
        name: spec.name, kind: 'gcupkg', title: spec.title || spec.name,
        description: spec.description || '', version: spec.version,
        license: spec.license || 'MIT', contributes: spec.contributes, size: bytes.length,
        url: rel, integrity: sriOfBytes(bytes), tags: spec.tags || [],
      });
      console.log(`  packed ${spec.name}@${spec.version} → ${rel} (${(bytes.length / 1024).toFixed(1)} KB, ${moduleCount} modules)`);
    };

    // Lib-packages first (so the catalog lists deps before the packages that need them).
    for (const lib of LIB_DEPS) {
      const idx = path.join(__dirname, LIB_SRC_OVERRIDE[lib] || path.join('ext', lib, 'index.js'));
      if (!fs.existsSync(idx)) { console.error(`packages: ${path.relative(__dirname, idx)} missing — build the lib first`); process.exit(1); }
      let version = '0.1.0', description = `@gcu/${lib} — bundled library`;
      const lpj = path.join(__dirname, 'ext', lib, 'package.json');
      if (fs.existsSync(lpj)) { try { const o = JSON.parse(fs.readFileSync(lpj, 'utf8')); version = o.version || version; description = o.description || description; } catch { /* */ } }
      const name = `@gcu/${lib}`;
      const files = {
        'package.json': Buffer.from(JSON.stringify({ name, version, description, license: 'MIT', main: 'index.js' }, null, 2)),
        'index.js': fs.readFileSync(idx),
        'LICENSE': Buffer.from(LIB_LICENSE),
      };
      const { bytes } = packGcupkg({ name, version, description, license: 'MIT', files, contributes: ['lib'], integrityCovers: ['index.js'], date });
      const slug = name.replace(/[@/]/g, '_');
      const rel = `dist/${slug}.gcupkg`;
      fs.writeFileSync(path.join(outDir, rel), bytes);
      entries.push({ name, kind: 'gcupkg', title: name, description, version, license: 'MIT', contributes: ['lib'], size: bytes.length, url: rel, integrity: sriOfBytes(bytes), tags: ['lib'] });
      console.log(`  packed ${name}@${version} → ${rel} (${(bytes.length / 1024).toFixed(1)} KB)`);
    }

    // Classic IIFE libs (cm6, acorn) — not ext/<lib>/index.js shaped, so packed
    // here rather than via LIB_DEPS. index.js IS the IIFE bundle → installs to
    // /lib/@gcu/<lib>/source where ensureLibSource finds it, and the notebook's
    // `classics` assembly entries resolve through it. (cm6 is also a baked works
    // lib; baking acorn into works/works-all pairs with phase C's notebook bake.)
    const auditableVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
    const CLASSIC_LIB_DEPS = [
      { name: 'cm6',   file: 'ext/cm6/cm6.min.js',       description: 'CodeMirror 6 — bundled editor (IIFE, sets window.CM6)' },
      { name: 'acorn', file: 'ext/acorn/acorn.min.js',   description: 'Acorn + acorn-typescript — the JS parser for AIR (IIFE, sets window.Acorn)' },
    ];
    for (const lib of CLASSIC_LIB_DEPS) {
      const srcPath = path.join(__dirname, lib.file);
      if (!fs.existsSync(srcPath)) { console.error(`packages: ${lib.file} missing — build it first`); process.exit(1); }
      const name = `@gcu/${lib.name}`;
      const files = {
        'package.json': Buffer.from(JSON.stringify({ name, version: auditableVersion, description: lib.description, license: 'MIT', main: 'index.js' }, null, 2)),
        'index.js': fs.readFileSync(srcPath),
        'LICENSE': Buffer.from(LIB_LICENSE),
      };
      const { bytes } = packGcupkg({ name, version: auditableVersion, description: lib.description, license: 'MIT', files, contributes: ['lib'], integrityCovers: ['index.js'], date });
      const slug = name.replace(/[@/]/g, '_');
      const rel = `dist/${slug}.gcupkg`;
      fs.writeFileSync(path.join(outDir, rel), bytes);
      entries.push({ name, kind: 'gcupkg', title: name, description: lib.description, version: auditableVersion, license: 'MIT', contributes: ['lib'], size: bytes.length, url: rel, integrity: sriOfBytes(bytes), tags: ['lib', 'classic'] });
      console.log(`  packed ${name}@${auditableVersion} → ${rel} (${(bytes.length / 1024).toFixed(1)} KB)`);
    }

    // @gcu/air (fragment) + @gcu/notebook (surface) — built by the shared
    // hoisted builders (the same content the works builtin payload bakes), here
    // packed into catalog .gcupkgs. air first (the notebook depends on it).
    packSpec(buildAirPackageFiles());
    packSpec(buildNotebookPackageFiles());

    for (const d of DISTRIBUTABLES) {
      const pkgDir = path.join(__dirname, d.dir);
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) { console.error(`packages: ${d.dir}/package.json missing`); process.exit(1); }
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

      const files = {};
      for (const rel of d.files) {
        const fp = path.join(pkgDir, rel);
        if (!fs.existsSync(fp)) continue;   // optional files (README) may be absent
        files[rel] = fs.readFileSync(fp);
      }
      const { bytes } = packGcupkg({
        name: pkgJson.name, version: pkgJson.version,
        description: pkgJson.description, license: pkgJson.license,
        files, contributes: d.contributes, integrityCovers: d.integrityCovers, date,
      });

      const slug = pkgJson.name.replace(/[@/]/g, '_');
      const rel = `dist/${slug}.gcupkg`;
      fs.writeFileSync(path.join(outDir, rel), bytes);
      entries.push({
        name: pkgJson.name, kind: 'gcupkg',
        title: d.title || pkgJson.name, description: pkgJson.description || '',
        version: pkgJson.version, license: pkgJson.license || 'UNLICENSED',
        contributes: d.contributes, size: bytes.length, url: rel,
        integrity: sriOfBytes(bytes), tags: d.tags || [],
      });
      console.log(`  packed ${pkgJson.name}@${pkgJson.version} → ${rel} (${(bytes.length / 1024).toFixed(1)} KB)`);
    }

    const registry = {
      registry: 1,
      name: 'GCU Packages',
      description: 'First-party code extensions for Auditable Works (.gcupkg). Higher-trust — installs run in your workspace.',
      homepage: 'https://github.com/gentropic/auditable',
      updated: buildDate,
      entries,
    };
    fs.writeFileSync(path.join(outDir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
    console.log(`Built packages/registry.json (${entries.length} entries)`);
    process.exit(0);
  })();
  return;
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
<!-- Part of the Auditable project \u2014 https://github.com/gentropic/auditable -->
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
<!-- Part of the Auditable project \u2014 https://github.com/gentropic/auditable -->
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
<!-- Part of the Auditable project \u2014 https://github.com/gentropic/auditable -->
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
  //      and (with the proc-entry tail appended) inlined into the worker.
  //    - term / vfs / proc: dynamic-imported on the main thread.
  const geasSrc = fs.readFileSync(path.join(__dirname, 'ext/geas/index.js'), 'utf8');
  const termSrc = fs.readFileSync(path.join(__dirname, 'ext/term/index.js'), 'utf8');
  const vfsSrc  = fs.readFileSync(path.join(__dirname, 'ext/vfs/index.js'), 'utf8');
  const procSrc = fs.readFileSync(path.join(__dirname, 'ext/proc/index.js'), 'utf8');
  const embeds =
    'const GEAS_BUNDLE_SOURCE = ' + JSON.stringify(geasSrc) + ';\n' +
    'const TERM_BUNDLE_SOURCE = ' + JSON.stringify(termSrc) + ';\n' +
    'const VFS_BUNDLE_SOURCE = '  + JSON.stringify(vfsSrc)  + ';\n' +
    'const PROC_BUNDLE_SOURCE = ' + JSON.stringify(procSrc) + ';\n';

  const js = embeds + '\n' + toolJs;

  // 3. CSS: @gcu/term structural + default theme, then the tool's own.
  const termCss = fs.readFileSync(path.join(__dirname, 'ext/term/term.css'), 'utf8');
  const termDefaultCss = fs.readFileSync(path.join(__dirname, 'ext/term/term-default.css'), 'utf8');
  const toolCss = fs.readFileSync(path.join(toolDir, 'style.css'), 'utf8');
  const css = termCss + '\n' + termDefaultCss + '\n' + toolCss;

  const toolTemplate = fs.readFileSync(path.join(toolDir, 'template.html'), 'utf8');

  const html = `<!DOCTYPE html>
<!-- geas — the GCU shell, standalone terminal -->
<!-- Part of the Auditable project — https://github.com/gentropic/auditable -->
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
<!-- Part of the Auditable project \u2014 https://github.com/gentropic/auditable -->
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
<!-- Part of the Auditable project \u2014 https://github.com/gentropic/auditable -->
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
// TARGET: lamina — the windowed "open any huge file" viewer, single-file
// ══════════════════════════════════════════════════
// A registry build (blob URLs + import map, like auditable/works) but tiny: the
// app (tools/lamina/js) + its four library bundles + fflate. The dev harness's
// bare specifiers (@gcu/loom, …) and the ./idb-cache.js relative import are
// rewritten to '#'-form and resolved by the inline import map. The boot also
// exposes the @gcu/lamina blob URL as window.__LAMINA_BUNDLE_URL__ so the
// off-thread scan worker can import it (same-origin blob → module-call).
// Output: lamina.html (standalone, offline). The PWA shell (manifest/sw/icon)
// is added by the gentropic/lamina deploy repo, exactly as works does.
if (target === 'lamina') {
  const lamDir = path.join(__dirname, 'tools/lamina');
  const lamJsDir = path.join(lamDir, 'js');

  // Specifier → registry name. Order of `libs` is the import/exec order; `app`
  // is appended last so its imports resolve against an already-populated map.
  const SPEC = {
    '@gcu/loom': '#loom', '@gcu/lamina': '#lamina', '@gcu/proc': '#proc',
    '@gcu/archive': '#archive', '@gcu/dm': '#dm', '@gcu/expr': '#expr', 'fflate': '#fflate', './idb-cache.js': '#idb-cache',
  };
  const libs = [
    ['loom',    'ext/loom/index.js'],
    ['lamina',  'ext/lamina/index.js'],
    ['proc',    'ext/proc/index.js'],
    ['archive', 'ext/archive/index.js'],
    ['dm',      'ext/dm/index.js'],
    ['expr',    'ext/expr/index.js'],
    ['fflate',  'ext/archive/vendor/fflate.module.mjs'],
  ];
  const modules = [];
  for (const [name, rel] of libs) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) { console.error(`Error: ${rel} not found — build the ext package first.`); process.exit(1); }
    modules.push({ name, source: fs.readFileSync(p, 'utf8').replace(/^\n+/, '').replace(/\n+$/, '') });
  }
  modules.push({ name: 'idb-cache', source: fs.readFileSync(path.join(lamJsDir, 'idb-cache.js'), 'utf8').trim() });

  // The app: rewrite each `from '<spec>'` to its '#'-form (the import map keys).
  let appSrc = fs.readFileSync(path.join(lamJsDir, 'app.js'), 'utf8');
  for (const [from, to] of Object.entries(SPEC)) appSrc = appSrc.split(`from '${from}'`).join(`from '${to}'`);
  modules.push({ name: 'app', source: appSrc.trim() });

  // Boot: registry → blob URLs → import map (+ the worker bundle URL) → import all.
  const entries = modules.map((m) =>
    JSON.stringify(m.name) + ': ' + JSON.stringify(m.source).replace(/<\/script>/gi, '<\\/script>'));
  const order = JSON.stringify(modules.map((m) => m.name));
  const boot =
    '(async () => {\n' +
    'const _S = {\n' + entries.join(',\n') + '\n};\n' +
    'const _O = ' + order + ';\n' +
    'const _U = {};\n' +
    "for (const n of _O) _U[n] = URL.createObjectURL(new Blob([_S[n] + '\\n//# sourceURL=lamina/' + n + '.js\\n'], { type: 'application/javascript' }));\n" +
    'window.__LAMINA_BUNDLE_URL__ = _U["lamina"];\n' +   // the off-thread scan imports this from its worker
    "const _m = document.createElement('script'); _m.type = 'importmap';\n" +
    'const _im = {}; for (const n of _O) _im["#" + n] = _U[n];\n' +
    "_m.textContent = JSON.stringify({ imports: _im }); document.body.appendChild(_m);\n" +
    'for (const n of _O) await import(_U[n]);\n' +
    '_m.remove();\n' +
    '})();\n';

  // Build stamp: "<version> · <content-hash> · <date>". The hash is a content hash
  // of the bundle (weir's trick — a git SHA can't go here, a commit can't contain
  // its own hash; the content hash changes exactly when the code does). Computed
  // BEFORE substituting the placeholder, so the id is never part of its own hash.
  const lamVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'ext/lamina/package.json'), 'utf8')).version || '0.0.0';
  const lamBuildId = require('crypto').createHash('sha256').update(boot).digest('hex').slice(0, 7);
  const lamStamp = `${lamVersion} · ${lamBuildId} · ${buildDateFromGit()}`;
  const bootStamped = boot.replace("const __LAMINA_BUILD__ = 'dev';", () => `const __LAMINA_BUILD__ = '${lamStamp}';`);

  // Template: strip the dev import map + the module <script src>, inline the boot
  // IN THE CLEAR (no gzip self-extractor → no `eval`, so the CSP needs no
  // 'unsafe-eval'). lamina favors a strict CSP over a smaller on-disk file — the
  // wire size is ~unchanged after the server re-gzips. (`</script>` inside module
  // sources is already escaped in the registry; the function replacement avoids
  // the $&/$1 backref trap since the boot is full of `${…}` from module code.)
  let html = fs.readFileSync(path.join(lamDir, 'index.html'), 'utf8');
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
  html = html.replace(/<script type="module" src="\.\/js\/app\.js"><\/script>/, () => `<script>\n${bootStamped}\n</script>`);

  // Third-party notices — lamina is MIT, but bundles a few MIT-licensed archive
  // decoders via @gcu/archive (fflate/fzstd/seek-bzip/xz-decompress), and some of
  // those minified bundles dropped their copyright headers. Retain the full licenses
  // here so the single-file artifact stays MIT-compliant + self-contained ("view
  // source; that's the point"). lamina carries no @gcu/licenses surface.
  const noticeLibs = ['fflate', 'fzstd', 'seek-bzip', 'xz-decompress'];
  const notices = noticeLibs.map((n) => {
    const p = path.join(__dirname, 'ext/archive/vendor', 'LICENSE-' + n);
    return fs.existsSync(p) ? `\n===== ${n} =====\n${fs.readFileSync(p, 'utf8').trim()}\n` : `\n===== ${n} ===== (MIT — license file missing at build)\n`;
  }).join('');
  const noticeBlock = `<!-- THIRD-PARTY NOTICES\nlamina is MIT (© Arthur Endlein Correia / Geoscientific Chaos Union, gentropic.org).\nIt bundles, via @gcu/archive, these MIT-licensed archive decoders:\n${notices}\n-->\n`
    .replace(/--+(?=[^>])/g, '-');   // no stray `--` runs inside an HTML comment
  html = html.replace('</head>', noticeBlock + '</head>');

  const outPath = path.join(__dirname, 'lamina.html');
  fs.writeFileSync(outPath, html);
  console.log(`Built lamina.html (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB in the clear, ${modules.length} modules) — build ${lamStamp}`);
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: auditable editions (editions/auditable-<name>.html)
// ══════════════════════════════════════════════════
// A pre-bundled "edition" = the base notebook with a curated set of extensions
// embedded in _installedModules, so load("@gcu/<ext>") resolves instantly and offline
// (no network round-trip). Requires build/auditable.html — run `node build.js` first;
// gcu-make orders this after the auditable target. Reproducible thanks to the git-date
// build above. (editions/, not dist/ — the latter is the conventional gitignored
// build-output dir; editions are committed distributables.)
// Editions are now defined as PROFILES: profiles/<name>.gcuprofile (a base + a named set
// of packages + settings + starter; may `extends` another profile — e.g. auditable-geo
// extends auditable-py + gslib). resolve.js flattens that and maps package names → in-repo
// bundles via profiles/packages.json. Same bake (gzip each ext → make_example) as before;
// the per-package detail just moved out of a hand-rolled table. Triggered by --profile=<name>,
// or --target=<name> when profiles/<name>.gcuprofile exists (so gcu-make's --target=auditable-py
// keeps working). Spec: spec_inbox/gcu-distributions-spec.md.
const profileArg = (process.argv.find(a => a.startsWith('--profile=')) || '').split('=')[1] || null;
const profilesDir = path.join(__dirname, 'profiles');
const profileName = profileArg
  || (fs.existsSync(path.join(profilesDir, target + '.gcuprofile')) ? target : null);
if (profileName) {
  const makeExample = require('./make_example');
  const zlib = require('zlib');
  const { resolveToEdition } = require('./profiles/resolve');
  const ed = resolveToEdition(profileName, { profilesDir });
  const modules = {};
  for (const [url, rel, adderExports] of ed.exts) {
    const raw = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    modules[url] = { source: zlib.gzipSync(Buffer.from(raw, 'utf8')).toString('base64'), cellId: null, compressed: true };
    if (adderExports) modules[url].adderExports = adderExports;
  }
  const outDir = path.join(__dirname, 'editions');
  fs.mkdirSync(outDir, { recursive: true });
  makeExample({ title: ed.title, cells: ed.cells, settings: ed.settings, modules, outPath: path.join(outDir, profileName + '.html') });
  process.exit(0);
}

// ══════════════════════════════════════════════════
// TARGET: auditable (default)
// ══════════════════════════════════════════════════

const srcDir = path.join(__dirname, 'src');
const jsDir = path.join(srcDir, 'js');
const appDir = path.join(srcDir, 'app');

// ── Build app runtime (minimal JS without CM6/editor) ──
// `appDir` passed in so the packages target (notebook emitter) can call this
// without the default-branch consts.
function buildAppRuntime(appDir) {
  let appJs = processModules(path.join(appDir, 'main.js'), appDir);
  // Prepend the @gcu/markdown engine, IIFE-wrapped with prefixed names: the
  // app concat is one shared scope and stubs.js carries a top-level `render`
  // (sideact's stub), so the engine must not land unprefixed. markdown.js's
  // stripped import leaves it consuming _mdRender/_mdPresets/_mdSlugify,
  // which this prelude provides (concat-bundle-isolation pattern).
  const mdEnginePath = path.join(__dirname, 'ext/markdown/index.js');
  const mdEngine = fs.readFileSync(mdEnginePath, 'utf8')
    .replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '');
  appJs = 'const { render: _mdRender, presets: _mdPresets, slugify: _mdSlugify } = (() => {\n'
    + mdEngine
    + '\nreturn { render, presets, slugify };\n})();\n\n' + appJs;
  // inject build-time constants into app runtime
  const pagesUrlVal = process.env.AUDITABLE_PAGES_URL || 'https://gentropic.org/auditable';
  appJs = appJs.replace(
    "const __AUDITABLE_PAGES_URL__ = 'https://gentropic.org/auditable';",
    `const __AUDITABLE_PAGES_URL__ = '${pagesUrlVal}';`
  );
  return appJs;
}

const appRuntime = buildAppRuntime(appDir);
const appRuntimeSize = (Buffer.byteLength(appRuntime, 'utf8') / 1024).toFixed(1);
console.log(`App runtime: ${appRuntimeSize} KB`);

// ── Module registry: preserve ES module import/export, rewrite paths ──

function processModulesAsRegistry(mainPath, moduleDir, opts = {}) {
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const importPaths = [];
  for (const rawLine of mainSrc.split('\n')) {
    // Strip trailing \r so CRLF-saved files don't break the anchor-to-end
    // match (the $ in the regex sits before \r, not after, on Windows).
    const line = rawLine.replace(/\r$/, '');
    if (opts.lean && line.includes('@optional')) continue;
    if (!opts.collab && line.includes('@collab')) continue;   // opt-in; default off
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
  for (const rawLine of mainSrc.split('\n')) {
    const line = rawLine.replace(/\r$/, '');   // CRLF-safe
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

// ── Shared module-registry assembler (notebook-as-package phase A) ──
// Gather + rewrite + inject the auditable notebook's module registry. The
// single source of truth for "what modules the notebook is made of", consumed
// by two emitters: the standalone auditable.html target (below — wraps the
// result in HTML + compression + signature) and, in phase B, the @gcu/notebook
// package emitter (writes the same modules out as files + an assembly manifest).
//
// Returns the fully-injected module list plus the classic IIFE sources (cm6,
// acorn) the boot prepends ahead of the ES-module registry. No HTML wrapping,
// no compression, no signing, no base-size pass — those are the consumer's job.
//
// Order is load-bearing: the unshift sequence fixes the registry order, and
// changing it changes the emitted boot byte-for-byte. EXT_MODULE_ENTRIES (local
// to avoid a module-level TDZ when the packages branch calls this early) lists
// the ext bundles in unshift-call order (final array order is its reverse),
// preserved exactly from the historical inline form.
function buildAuditableRegistry(opts) {
  const { lean, jsDir, srcDir, appRuntime, execModeArg, runOnLoadArg } = opts;
  const EXT_MODULE_ENTRIES = [
    { name: 'vfs',          file: 'ext/vfs/index.js' },
    { name: 'abus',         file: 'ext/abus/index.js' },
    { name: 'sideact',      file: 'ext/sideact/index.js' },
    { name: 'gcu-markdown', file: 'ext/markdown/index.js' },
    { name: 'proc',         file: 'ext/proc/index.js' },
    { name: 'coreutils',    file: 'ext/coreutils/index.js' },
    // @gcu/sync ships ONLY with --collab — it's the carrier for presence.js (also
    // @collab-gated). Without it the default/public artifact carries no P2P/federation
    // code at all (clean reach.network for the Sealed declaration). See the seal spec.
    ...(collab ? [{ name: 'sync', file: 'ext/sync/index.js' }] : []),
    { name: 'menu',         file: 'ext/menu/index.js' },
    { name: 'dialog',       file: 'ext/dialog/index.js' },
    { name: 'term',         file: 'ext/term/index.js' },
    { name: 'ipynb',        file: 'ext/ipynb/index.js' },
    { name: 'licenses',     file: 'ext/licenses/index.js' },
    { name: 'template',     file: 'ext/template/index.js' },
  ];

  // ── gather: base src/js modules, then prepend the ext bundles ──
  const modules = processModulesAsRegistry(path.join(jsDir, 'main.js'), jsDir, { lean, collab });
  for (const e of EXT_MODULE_ENTRIES) {
    const p = path.join(__dirname, e.file);
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    src = src.replace(/^\n+/, '').replace(/\n+$/, '');
    modules.unshift({ name: e.name, source: src });
  }

  // CM6 + Acorn — classic IIFE bundles (window.CM6 / window.Acorn), not ES
  // modules; prepended ahead of the registry boot, never registry entries.
  const cm6Path = path.join(__dirname, 'ext/cm6/cm6.min.js');
  const cm6Src = fs.existsSync(cm6Path) ? fs.readFileSync(cm6Path, 'utf8') : '';
  const acornPath = path.join(__dirname, 'ext/acorn/acorn.min.js');
  const acornSrc = fs.existsSync(acornPath) ? fs.readFileSync(acornPath, 'utf8') : '';

  // AIR as individual ES-module registry entries (real per-file scope, no
  // concat flattening) under the #air/... namespace, appended at the end.
  const airSrcDir = path.join(__dirname, 'ext/air/src');
  if (fs.existsSync(airSrcDir)) {
    const airModules = processExtensionAsRegistry('air', airSrcDir);
    for (const m of airModules) modules.push(m);
  }

  // ── inject: build-time placeholders (modules opt in by declaring the const) ──
  const builtins = fs.readFileSync(path.join(srcDir, 'builtins.json'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const buildDate = buildDateFromGit();
  const release = process.env.AUDITABLE_RELEASE || 'dev';
  const pubKey = process.env.AUDITABLE_PUBLIC_KEY || '';
  const repo = process.env.AUDITABLE_REPO || 'gentropic/auditable';
  const pagesUrl = process.env.AUDITABLE_PAGES_URL || 'https://gentropic.org/auditable';

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
      "const __AUDITABLE_REPO__ = 'gentropic/auditable';",
      `const __AUDITABLE_REPO__ = '${repo}';`
    );
    mod.source = mod.source.replace(
      "const __AUDITABLE_PAGES_URL__ = 'https://gentropic.org/auditable';",
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

  // Inject app runtime as escaped string constant into save module
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

  // ── __BUILD_LICENSES__ injection (licenses-spec §7.3) ─────────────────
  // Read vendor-licenses.json + each entry's licenseFile, assemble a manifest
  // keyed by package name, inject into every module containing the
  // `const __BUILD_LICENSES__ = {};` placeholder. The auditable settings panel
  // and the works workspace settings surface both opt in this way.
  // Tolerant of missing manifest / missing LICENSE files — warns but proceeds.
  const _buildLicenses = injectBuildLicenses(modules);
  console.log(`vendor-licenses: bundled ${Object.keys(_buildLicenses).length} entries (${Object.values(_buildLicenses).filter(e => e.text).length} with text)`);

  return { modules, cm6Src, acornSrc };
}

// ── Notebook CSS build (shared) ──
// Read src/style.css, split on the APP/EDITOR marker, and append the
// component theme sheets (@gcu/menu, @gcu/dialog, @gcu/term) with their
// :root swatch blocks stripped so auditable's palette wins. Returns
// { appCss, editorCss }. Used by the standalone target and the
// @gcu/notebook package emitter (so boot.html styles match the standalone).
function buildNotebookCss(srcDir) {
  const cssRaw = fs.readFileSync(path.join(srcDir, 'style.css'), 'utf8');
  const cssMarker = '/* ══ APP CSS ABOVE ═══ EDITOR CSS BELOW ══ */';
  const cssParts = cssRaw.split(cssMarker);
  let appCss = cssParts[0].trimEnd();
  const editorCss = cssParts.length > 1 ? cssParts[1].trimStart() : '';

  // @gcu/menu — structural + decorative; strip the decorative :root defaults.
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

  // @gcu/dialog — same :root strip as menu.
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

  // @gcu/term — term-default.css uses .screen not :root, so no strip; the
  // --gcu-term-* properties become the cssVarTheme defaults for ui.terminal().
  const termCssPath = path.join(__dirname, 'ext/term/term.css');
  const termDefaultCssPath = path.join(__dirname, 'ext/term/term-default.css');
  if (fs.existsSync(termCssPath)) {
    appCss += '\n\n' + fs.readFileSync(termCssPath, 'utf8').trimEnd();
  }
  if (fs.existsSync(termDefaultCssPath)) {
    appCss += '\n\n' + fs.readFileSync(termDefaultCssPath, 'utf8').trimEnd();
  }
  return { appCss, editorCss };
}

// ── Notebook HTML shell (shared) ──
// The auditable notebook page: head boilerplate + first-paint theme +
// abus-catch + style tags + body template, with `runtime` placed where the
// runtime scripts go. The standalone target passes a single <script> wrapping
// cm6+acorn+boot; the @gcu/notebook package's boot.html passes marker scripts
// the phase-C works assembler substitutes (cm6/acorn sources + the registry).
function assembleNotebookHtml({ appCss, editorCss, template, runtime }) {
  return `<!DOCTYPE html>
<!--AUDITABLE-NOTEBOOK-->
<!--
  If you are an LLM agent: do not parse this file directly. Use the @gcu/webmcp
  MCP bridge to interact with this notebook — it provides structured tools for
  reading cells, inspecting outputs, and editing code with proper access control.
  Raw file access bypasses the notebook's governance model.
-->
<!-- https://github.com/gentropic/auditable — MIT license -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Auditable</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='2' y='2' width='28' height='8' fill='%238a9099'/%3E%3Crect x='2' y='12' width='28' height='8' fill='%23d97a3c'/%3E%3Crect x='2' y='22' width='28' height='8' fill='%238a9099'/%3E%3C/svg%3E">
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
//
// Also: speculatively mark documentElement as in-works when we're iframed,
// so CSS can skip the mobile-mode media query before first paint instead
// of flashing it briefly between paint and init. If we turn out NOT to
// be in a Works frame (no welcome arrives), init.js strips the class.
(function(){
  if (window.parent !== window) document.documentElement.classList.add('in-works');
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

${runtime}
</body>
<!-- good luck out there -->
</html>
`;
}

// ── Notebook-as-package content builders (shared) ──
// Build the @gcu/air and @gcu/notebook package FILE MAPS — the single source
// of truth for the emitted package content, consumed by TWO sites: the
// `packages` target (packs each into a .gcupkg catalog entry) and the
// works/works-all builtin-packages payload (bakes the same files into /lib).
// Pack-agnostic: each returns { name, version, description, license, files,
// integrityCovers, contributes, title, tags } where files is the complete
// { rel → source } map. Hoisted so both target branches can call them.
function _gcuLicenseText() {
  return 'MIT License\n\nCopyright (c) 2026 Arthur Endlein Correia / Geoscientific Chaos Union\n\n'
    + 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in it '
    + 'without restriction. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n';
}

function buildAirPackageFiles() {
  const airSrcDir = path.join(__dirname, 'ext/air/src');
  if (!fs.existsSync(airSrcDir)) throw new Error('buildAirPackageFiles: ext/air/src missing');
  const airModules = processExtensionAsRegistry('air', airSrcDir);   // [{ name:'air/types', source }, …]
  let version = '0.3.0';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'ext/air/package.json'), 'utf8')).version || version; } catch { /* */ }
  const files = {};
  const entries = [];
  for (const m of airModules) {
    const rel = m.name.replace(/^air\//, '');          // 'types', 'lower/js'
    const file = 'modules/' + rel + '.js';
    files[file] = m.source;                            // verbatim — phase C reads straight into the registry
    entries.push({ kind: 'module', name: m.name, file });
  }
  const description = 'AIR — the GCU compiler IR (fragment package: per-file modules for runtime assembly)';
  const pkgJson = { name: '@gcu/air', version, description, license: 'MIT', gcu: { fragment: { namespace: 'air' } } };
  const assembly = { version: 1, name: '@gcu/air', fragment: { namespace: 'air' }, entries };
  files['package.json'] = JSON.stringify(pkgJson, null, 2) + '\n';
  files['assembly.json'] = JSON.stringify(assembly, null, 2) + '\n';
  files['LICENSE'] = _gcuLicenseText();
  const integrityCovers = ['assembly.json', ...Object.keys(files).filter((f) => f.startsWith('modules/'))];
  return { name: '@gcu/air', version, description, license: 'MIT', files, integrityCovers,
    contributes: ['fragment'], title: 'AIR compiler IR', tags: ['lib', 'fragment', 'compiler'] };
}

function buildNotebookPackageFiles() {
  const nbSrcDir = path.join(__dirname, 'src');
  const nbJsDir = path.join(nbSrcDir, 'js');
  const nbAppDir = path.join(nbSrcDir, 'app');
  const nbAppRuntime = buildAppRuntime(nbAppDir);
  const { modules: nbModules } = buildAuditableRegistry({
    lean, jsDir: nbJsDir, srcDir: nbSrcDir, appRuntime: nbAppRuntime, execModeArg, runOnLoadArg,
  });
  const { appCss, editorCss } = buildNotebookCss(nbSrcDir);
  const template = fs.readFileSync(path.join(nbSrcDir, 'template.html'), 'utf8');
  const bootHtml = assembleNotebookHtml({
    appCss, editorCss, template,
    runtime: [
      '<script>/*__GCU_CLASSIC_cm6__*/</script>',
      '<script>/*__GCU_CLASSIC_acorn__*/</script>',
      '<script>/*__GCU_REGISTRY__*/</script>',
    ].join('\n'),
  });

  // Works libs shared with the shell — NOT emitted as files (resolved via
  // ensureLibSource at spawn). registry-name == lib-name except markdown.
  const NB_LIBS = [
    { name: 'vfs' }, { name: 'abus' }, { name: 'sideact' },
    { name: 'markdown', as: 'gcu-markdown' }, { name: 'proc' },
    { name: 'menu' }, { name: 'term' }, { name: 'ipynb' }, { name: 'template' },
  ];
  const libByRegName = new Map(NB_LIBS.map((l) => [l.as || l.name, l]));

  const entries = [];
  const files = {};
  let fragmentEmitted = false;
  for (const m of nbModules) {
    if (m.name.startsWith('air/')) {
      if (!fragmentEmitted) { entries.push({ kind: 'fragment', package: '@gcu/air' }); fragmentEmitted = true; }
      continue;   // AIR ships via the @gcu/air fragment
    }
    const lib = libByRegName.get(m.name);
    if (lib) { entries.push(lib.as ? { kind: 'lib', name: lib.name, as: lib.as } : { kind: 'lib', name: lib.name }); continue; }
    const file = 'modules/' + m.name + '.js';
    files[file] = m.source;
    entries.push({ kind: 'module', name: m.name, file });
  }

  const version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  const buildDate = buildDateFromGit();
  // Top-level await: the surface ASSEMBLES at registration (reads its module
  // tree + libs), so importing this works.js must wait for that to finish —
  // otherwise evaluateWorksScript resolves before the blob is ready and a
  // just-provisioned notebook reports unavailable. registerExtensionSurfaces
  // swallows a missing-dep assemble error (logs, no blob); the re-eval after
  // the dep-closure then assembles for real.
  const worksRegister =
    '// ⚠ GENERATED — @gcu/notebook shell registration (surface kind \'notebook\').\n' +
    'if (typeof window !== \'undefined\' && window.auditable && window.auditable.registerExtension) {\n' +
    '  await window.auditable.registerExtension({\n' +
    '    name: \'@gcu/notebook\', version: ' + JSON.stringify(version) + ',\n' +
    '    description: \'Auditable notebook — the reactive computational notebook surface.\',\n' +
    '    surfaces: [{ kind: \'notebook\', label: \'Notebook\', icon: \'▦\', file: \'boot.html\', assemble: true, extensions: [] }],\n' +
    '  });\n}\n';
  const description = 'Auditable notebook — the reactive computational notebook, as a Works surface package.';
  const pkgJson = {
    name: '@gcu/notebook', version, description, license: 'MIT',
    gcu: {
      surfaces: [{ kind: 'notebook', file: 'boot.html', assemble: true, label: 'Notebook', icon: '▦', extensions: [] }],
      requires: ['cm6', 'acorn', 'vfs', 'abus', 'sideact', 'markdown', 'proc', 'menu', 'term', 'ipynb', 'template'],
      dependencies: ['@gcu/air'],
    },
  };
  const assembly = { version: 1, name: '@gcu/notebook', classics: ['cm6', 'acorn'], entries, injected: { version, buildDate } };
  files['package.json'] = JSON.stringify(pkgJson, null, 2) + '\n';
  files['assembly.json'] = JSON.stringify(assembly, null, 2) + '\n';
  files['boot.html'] = bootHtml;
  files['works.js'] = worksRegister;
  files['LICENSE'] = _gcuLicenseText();
  const integrityCovers = ['assembly.json',
    ...Object.keys(files).filter((f) => f.startsWith('modules/')), 'boot.html', 'works.js'];
  return { name: '@gcu/notebook', version, description, license: 'MIT', files, integrityCovers,
    contributes: ['surface'], title: 'Auditable Notebook', tags: ['notebook', 'surface', 'flagship'] };
}

// ── Build module registry (shared assembler) ──
const { modules, cm6Src, acornSrc } = buildAuditableRegistry({
  lean, jsDir, srcDir, appRuntime, execModeArg, runOnLoadArg,
});

// 3. Read template + build CSS (shared helpers — boot.html matches this).
const template = fs.readFileSync(path.join(srcDir, "template.html"), "utf8");
const { appCss, editorCss } = buildNotebookCss(srcDir);

// 4. Build-time placeholder injection, app-runtime/OFL embedding, and
// __BUILD_LICENSES__ all happen inside buildAuditableRegistry above.

// 5. Assemble final HTML — the standalone wraps the runtime in one <script>.
function assemble(jsCode) {
  return assembleNotebookHtml({
    appCss, editorCss, template,
    runtime: '<script>\n' + jsCode + '\n</script>',
  });
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
    + `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='2' y='2' width='28' height='8' fill='%238a9099'/%3E%3Crect x='2' y='12' width='28' height='8' fill='%23d97a3c'/%3E%3Crect x='2' y='22' width='28' height='8' fill='%238a9099'/%3E%3C/svg%3E">`
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
