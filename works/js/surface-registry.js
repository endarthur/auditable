// The surface registry — every surface kind Works can host
// (auditable-works-spec §6). A project's project.json `kind` names an entry
// directly; a loose file dispatches by extension.
//
// Surfaces are embedded in works.html as gzip+base64 payloads (§15.1, built
// by build.js); surfaceUrl() decompresses one to a blob URL on first spawn.

const KINDS = new Map();          // kind → { label, icon, extensions, … }
const _surfaceBlobs = new Map();  // kind → blob URL (decompressed once)
const _libSources = new Map();    // lib name → raw bundle source (string)
const _atraLibSources = new Map();   // atra-lib name → raw .src.js source
const _themeAssets = { css: null, init: null };  // populated by decompressLibs()

// Extension-surface tracking, indexed for fast iteration during path routing
// (Slice 2 will reach into _extensionSurfaces from kindForPath).
const _extensionSurfaces = new Map();   // kind → { manifest, def }

export function registerKind(kind, def) {
  KINDS.set(kind, {
    label:      def.label || kind,
    icon:       def.icon || '■',
    extensions: def.extensions || [],
    extensionlessNames: def.extensionlessNames || null,
    detect:     def.detect || null,
    isExtension: !!def.isExtension,
    extension:  def.extension || null,  // { manifest, file, libPath, requires, openAction }
  });
}

export function unregisterKind(kind) {
  KINDS.delete(kind);
  _extensionSurfaces.delete(kind);
  const url = _surfaceBlobs.get(kind);
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    _surfaceBlobs.delete(kind);
  }
}

// Read-only iterator for path resolution (Slice 2). Returning the
// extensions + detect callback per kind is enough for kindForPath; the
// raw map is kept private.
export function kindsForRouting() {
  const out = [];
  for (const [kind, def] of KINDS) {
    out.push({
      kind,
      extensions: def.extensions || [],
      extensionlessNames: def.extensionlessNames || null,
      detect: def.detect || null,
      isExtension: !!def.isExtension,
    });
  }
  return out;
}

// Sources used by extension-surface registration to inline theme tokens
// + the boot script. Built-ins skip these (substituted at build time).
export function themeAssets() { return { css: _themeAssets.css, init: _themeAssets.init }; }
export function libSources()  { return _libSources; }
export function setSurfaceBlob(kind, url) { _surfaceBlobs.set(kind, url); }
export function registerExtensionSurface(kind, manifest, def) {
  _extensionSurfaces.set(kind, { manifest, def });
}

export function kindDef(kind) {
  return KINDS.get(kind) || null;
}

// The surface kind that handles a loose file, by extension — or null.
// Synchronous + cheap: extension match first, then extensionless-name
// fallback. Use kindForPath() if you also want detect() callbacks
// consulted (async, needs a VFS read).
export function kindForExtension(filename) {
  // Basename, in case a caller passes a full path.
  const base = String(filename).split(/[\\/]/).pop();
  const i = base.lastIndexOf('.');
  // i > 0 not >= 0 — dotfiles like `.gitignore` aren't treated as
  // "extension = .gitignore"; they fall through to the basename match below.
  const ext = i > 0 ? base.slice(i).toLowerCase() : '';
  if (ext) {
    for (const [kind, def] of KINDS) {
      if (def.extensions && def.extensions.includes(ext)) return kind;
    }
  }
  // Extensionless conventional filenames (LICENSE, README, COPYING, …) — open
  // as plain text by default. Case-insensitive exact match on the basename.
  const upper = base.toUpperCase();
  for (const [kind, def] of KINDS) {
    if (def.extensionlessNames && def.extensionlessNames.includes(upper)) return kind;
  }
  return null;
}

// Full path resolution per EXTENSION_SPEC §3.8.3:
//   1. Extension match (kindForExtension's fast path) — first registered wins.
//   2. Extensionless conventional names (LICENSE, README, …).
//   3. detect() callbacks across every kind that declares one — registration
//      order, first truthy wins. Each detect receives a shared `peek(n)`
//      bound to this path; reads are cached for the duration of one
//      resolution pass (so two detect callbacks both asking for 16 bytes
//      perform one VFS read total).
//
// opts.vfs — required to consult detect() callbacks. If absent, kindForPath
//   reduces to kindForExtension. opts.peekBudget — per-resolution byte cap
//   (default 1 MB; detect callbacks asking beyond it get a truncated read
//   and a console.warn).
//
// Returns the matched kind name, or null. Async because detect callbacks
// may need VFS reads.
export async function kindForPath(path, opts = {}) {
  const sync = kindForExtension(path);
  if (sync) return sync;

  const vfs = opts.vfs;
  if (!vfs) return null;  // no way to peek; nothing more we can do

  // Per-path shared peek cache. The VFS has no offset/length API, so the
  // file gets read once on the first peek() call, truncated to the
  // budget, and cached as a Uint8Array. Subsequent peeks slice from that
  // buffer — two detect callbacks both asking for 16 bytes perform one
  // VFS read total. Budget defaults to 1 MB per resolution pass; detect
  // callbacks that need more than that should ship as a contextMenu
  // action instead (per §3.8.3).
  const PEEK_BUDGET = typeof opts.peekBudget === 'number' ? opts.peekBudget : 1 << 20;
  let cached = null;
  let readErr = false;
  async function peek(n) {
    if (n <= 0 || readErr) return new Uint8Array(0);
    if (!cached) {
      try {
        const raw = await vfs.readFile(path);
        if (raw instanceof Uint8Array) {
          cached = raw.length > PEEK_BUDGET ? raw.slice(0, PEEK_BUDGET) : raw;
        } else {
          cached = new Uint8Array(0);
        }
      } catch {
        readErr = true;
        return new Uint8Array(0);
      }
    }
    return cached.subarray(0, Math.min(n, cached.length));
  }

  for (const [kind, def] of KINDS) {
    if (typeof def.detect !== 'function') continue;
    let hit = false;
    try {
      hit = !!(await def.detect(path, peek));
    } catch (e) {
      console.error(`[works] kindForPath: detect for "${kind}" threw on ${path}:`, e);
      continue;
    }
    if (hit) return kind;
  }

  return null;
}

async function _decompressEl(el) {
  const bytes = Uint8Array.from(
    atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// Decompress every embedded shared-library payload into a source string.
// Run once at shell boot, BEFORE decompressSurfaces() — surfaces inline
// these sources at the bare-import sites (the disk dedup of §15.2 without
// the cross-blob-URL imports it would also want, which Chromium blocks on
// blob:null/* origins from file://).
export async function decompressLibs() {
  for (const el of document.querySelectorAll('script[type="text/plain"][id^="lib-"]')) {
    const name = el.id.slice('lib-'.length);
    _libSources.set(name, await _decompressEl(el));
  }
  // works-all only: atra libraries under a separate prefix.
  for (const el of document.querySelectorAll('script[type="text/plain"][id^="atralib-"]')) {
    const name = el.id.slice('atralib-'.length);
    _atraLibSources.set(name, await _decompressEl(el));
  }
  // Shared theme tokens + boot script for extension surfaces. Built-in
  // surfaces have these substituted at build time and won't contain the
  // placeholder — extension surfaces from .gcupkg packages get them
  // substituted at spawn time (EXTENSION_SPEC §3.8.6).
  const cssEl  = document.getElementById('theme-css');
  const initEl = document.getElementById('theme-init');
  if (cssEl)  _themeAssets.css  = await _decompressEl(cssEl);
  if (initEl) _themeAssets.init = await _decompressEl(initEl);
}

// Write each shared library into the workspace's /usr/lib as a module
// directory — the same layout the notebook's hydrateModulesFromVfs reads
// from /lib (pkg-spec §3.1: sub-namespaced by source). A notebook can
// `load("@gcu/<name>")` natively. /usr/lib is a volatile MemoryBackend
// (workspace.js): the shell repopulates it on every boot, builtins never
// leak into workspace exports, and a user install of the same alias into
// /lib shadows the builtin (Unix-style).
export async function installSharedLibsToVfs(vfs) {
  if (!vfs) return;
  await vfs.mkdir('/usr/lib/@gcu', { recursive: true }).catch(() => {});
  for (const [name, src] of _libSources) {
    const alias = '@gcu/' + name;
    const dir = '/usr/lib/@gcu/' + name;
    await vfs.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.writeFile(dir + '/source', src);
    await vfs.writeFile(dir + '/meta.json',
      JSON.stringify({ alias, builtin: true, kind: 'gcu-lib' }));
  }
  // works-all atra libs at /usr/lib/@atra/<name>/. The notebook runtime's
  // hydrateModulesFromVfs picks up @atra/* the same way it picks up
  // @gcu/* (keyToLibPath already handles arbitrary @scope/name).
  if (_atraLibSources.size > 0) {
    await vfs.mkdir('/usr/lib/@atra', { recursive: true }).catch(() => {});
    for (const [name, src] of _atraLibSources) {
      const alias = '@atra/' + name;
      const dir = '/usr/lib/@atra/' + name;
      await vfs.mkdir(dir, { recursive: true }).catch(() => {});
      await vfs.writeFile(dir + '/source', src);
      await vfs.writeFile(dir + '/meta.json',
        JSON.stringify({ alias, builtin: true, kind: 'atra-lib' }));
    }
  }
}

// Rewrite an ESM bundle's trailing `export { ... }` to top-level
// `const X = Y;` aliases so the inlined code's exported names land as
// locals in the surface module. Necessary for terser-mangled bundles
// (xterm: `export{mn as FitAddon}`); concat bundles whose exports are
// already top-level (geas/vfs/abus) produce harmless no-op `;`.
function _rewriteExportToConsts(src) {
  return src.replace(/export\s*\{([^}]+)\};?\s*$/, (_, body) => {
    const aliases = body.split(',').map((s) => s.trim()).filter(Boolean)
      .map((decl) => {
        const m = decl.match(/^(\S+)\s+as\s+(\S+)$/);
        return m ? `const ${m[2]} = ${m[1]};` : ';';
      }).join('\n');
    return '\n' + aliases + '\n';
  });
}

// Substitute @theme-tokens / @theme-init placeholders with the decompressed
// shared assets. Built-in surfaces don't carry the placeholder (build-time
// injectSharedTheme already replaced it), so this is a no-op for them.
// Extension surfaces opt in by leaving the placeholder in their HTML, and
// the host runs this at spawn time per EXTENSION_SPEC §3.8.6.
//
// We test the placeholder against a regex that requires CSS-comment
// boundaries with NO surrounding code (i.e. the placeholder must be the
// only thing on its line, optionally indented). Otherwise a literal
// `/* @theme-init */` mentioned inside an inlined comment would match and
// trigger a runaway second substitution. Build-time substitution does the
// same shape, so the two stay in sync.
const _THEME_TOKEN_RE = /^[ \t]*\/\* @theme-tokens \*\/[ \t]*$/m;
const _THEME_INIT_RE  = /^[ \t]*\/\* @theme-init \*\/[ \t]*$/m;

function _substituteThemePlaceholders(text) {
  if (_themeAssets.css && _THEME_TOKEN_RE.test(text)) {
    text = text.replace(_THEME_TOKEN_RE, () => _themeAssets.css);
  }
  if (_themeAssets.init && _THEME_INIT_RE.test(text)) {
    text = text.replace(_THEME_INIT_RE, () => _themeAssets.init);
  }
  return text;
}

// Internal helper used by decompressSurfaces (built-in path) and by
// works/js/extension-surfaces.js (extension path) — same lib-inlining +
// theme-substitution pipeline applied to both. Exported as
// processSurfaceHtml for external callers; the `kind` arg is unused
// today but kept for future per-kind hooks (specialized inlining etc).
export function processSurfaceHtml(text, kind) {
  return _inlineLibsIntoSurface(text, kind);
}

function _inlineLibsIntoSurface(text, kind) {
  // Theme tokens first — the substituted CSS may legitimately contain
  // patterns the lib regex matches against (`import` mentions in comments),
  // so the order matters less than landing both before iframe creation.
  text = _substituteThemePlaceholders(text);
  // The import map is decorative once we're inlining.
  text = text.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
  // CM6 is IIFE-shaped (sets `var CM6 = …` at module scope) — surfaces
  // place a unique marker token where the IIFE source goes and we splice
  // it in here. No ESM-import sugar; the surface destructures from `CM6`
  // directly. Closer to inlining a pre-built bundle than to importing a
  // module.
  //
  // The marker is deliberately ugly (__GCU_CM6_INLINE__ wrapped in /*…*/)
  // so it can't accidentally appear in source comments / docs / strings.
  // An earlier iteration used `/* @cm6-inline */` and matched the first
  // mention in a doc comment instead of the real placeholder — wedged the
  // IIFE inside an HTML comment block where it never executes.
  const CM6_MARKER = '/*__GCU_CM6_INLINE__*/';
  if (text.includes(CM6_MARKER) && _libSources.has('cm6')) {
    const cm6Src = _libSources.get('cm6').replace(/<\/script>/g, '<\\/script>');
    text = text.replace(CM6_MARKER,
      () => `/* @gcu/cm6 — inlined IIFE from the works lib store */\n${cm6Src}\n`);
  }

  // For each lib imported by bare specifier in this surface, inline the
  // bundle (with its exports rewritten to locals).
  let inlinedGeas = false;
  for (const [name, src] of _libSources) {
    // Anchor to start of line (with multiline flag) so the regex only
    // matches real top-level import statements. Bundles often have
    // example imports embedded in JSDoc comments — `// import { Foo }
    // from '@gcu/term'` — which would otherwise match the substring,
    // recursively pulling in libs the surface never asked for and
    // colliding on shared identifiers (e.g. xterm + term both export
    // `Terminal`).
    const re = new RegExp(
      `^\\s*import\\s*\\{([^}]*)\\}\\s*from\\s*['"]@gcu/${name}['"];?`, 'm');
    if (!re.test(text)) continue;
    if (name === 'geas') inlinedGeas = true;
    // Inlined source lives inside the surface's <script type="module">
    // tag; any literal `</script>` in the source (even inside a JS //
    // comment) would terminate the surrounding script tag early and
    // dump the rest as HTML text. Escape it. (markdown.js has a
    // `<script>foo</script>` reference inside a comment that hit this.)
    const inlined = _rewriteExportToConsts(src)
      .replace(/<\/script>/g, '<\\/script>');
    text = text.replace(re,
      () => `\n/* @gcu/${name} — inlined from the works lib store */\n${inlined}\n`);
  }
  // The terminal builds its worker source from the geas TEXT (not its
  // symbols). After inlining, the bundle text is no longer directly
  // accessible from the surface — provide it as a hidden script tag.
  if (inlinedGeas) {
    const geasSrc = _libSources.get('geas');
    // FUNCTION replacement (not a string template) — String.prototype.replace
    // interprets $&, $', $`, etc. in a *string* replacement as backref
    // tokens, and the geas source contains literal `$'` (a `'$'` regex char
    // class in a string literal). Function replacements use their return
    // value verbatim.
    const tag = `<script type="text/plain" id="inlined-lib-geas">\n${
      geasSrc.replace(/<\/script>/g, '<\\/script>')
    }\n</script>\n</body>`;
    text = text.replace('</body>', () => tag);
  }
  return text;
}

// Decompress every embedded surface payload to a blob URL. Run once at shell
// boot, AFTER decompressLibs(). Eager rather than lazy-per-spawn (spec §15.1
// says "lazy") because the blob URL must be ready *synchronously* when a
// surface iframe is created — a src-less iframe loads about:blank first,
// which double-fires the welcome and neuters the transferred port, and an
// about:blank guard is not robust from file://. The payloads decompress in
// ~tens of ms total, so boot stays light.
export async function decompressSurfaces() {
  for (const kind of KINDS.keys()) {
    const el = document.getElementById('surface-' + kind);
    if (!el) { console.warn('[works] no embedded payload for surface:', kind); continue; }
    let text = await _decompressEl(el);
    text = _inlineLibsIntoSurface(text, kind);
    _surfaceBlobs.set(kind, URL.createObjectURL(new Blob([text], { type: 'text/html' })));
  }
}

// The blob URL for a surface kind — synchronous; decompressSurfaces() must
// have run (at boot). A blob URL is same-origin with the shell, so the
// surface iframe loads even when works.html is opened from file://.
export function surfaceUrl(kind) {
  const url = _surfaceBlobs.get(kind);
  if (!url) throw new Error('surface payload not available: ' + kind);
  return url;
}

// ── Built-in kinds ───────────────────────────────────────────────────

// The Auditable notebook — a project directory (project.json kind:'notebook'
// + notebook.txt + data siblings). The same auditable.html that runs
// standalone; it detects the Works iframe and boots as a surface.
registerKind('notebook', { label: 'Notebook', icon: '▦', extensions: [] });

registerKind('stub', { label: 'Stub project', icon: '◈', extensions: [] });

// A geas terminal — multi-instance, path-less, spawned from Tools → Terminal
// or right-click-folder → Open terminal here. Each tab is its own Web Worker
// running a geas shell with the workspace VFS proxied in.
registerKind('terminal', { label: 'Terminal', icon: '▶', extensions: [] });

// The doc editor — markdown source + live HTML preview + {{path | filter}}
// template directives via @gcu/template. Wins for `.md` / `.markdown` so a
// double-click on those drops the user into editor+preview rather than
// preview-only. Preview still owns CSV/JSON/images/PDFs/archives below.
registerKind('doc', {
  label:      'Document',
  icon:       '▥',
  extensions: ['.md', '.markdown'],
});

// The data-preview surface — read-only viewer for structured file types
// (CSV table, JSON tree, image, PDF). Registered BEFORE text so it wins
// for the rich extensions; text still claims the rest. kindForExtension
// returns the first match, so order matters.
registerKind('preview', {
  label:      'Preview',
  icon:       '◳',
  extensions: ['.csv', '.tsv', '.json', '.geojson',
               '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
               '.ico', '.avif', '.pdf',
               // Archives — the preview surface knows how to render a
               // collapsible entry tree and click-through to inline file
               // rendering (see works/surfaces/preview.html's renderArchive).
               '.zip', '.tar', '.tar.gz', '.tgz', '.tar.zst', '.tzst',
               '.tar.xz', '.txz', '.tar.bz2', '.tbz2', '.gz', '.zst'],
});

// The text editor — the loose-file surface. Opens any plain-text file.
// extensionlessNames covers the conventional no-extension names that ship
// alongside source trees (LICENSE, README, …); dispatched via
// kindForExtension's basename fallback.
registerKind('text', {
  label:      'Text file',
  icon:       '▤',
  extensions: ['.txt', '.json', '.js', '.css', '.html',
               '.csv', '.log', '.xml', '.yaml', '.yml'],
  extensionlessNames: ['LICENSE', 'README', 'COPYING', 'NOTICE',
                       'AUTHORS', 'CONTRIBUTORS', 'CHANGELOG', 'CHANGES',
                       'MAKEFILE', 'DOCKERFILE'],
});

// Patchbay — a Eurorack-style reactive dataflow rack. A loose-file surface: one
// `.patchbay` JSON document = one rack. Opens from the tree by extension, or via
// Tools → New rack. (The schema is container-agnostic so a future project-dir
// form is a drop-in; see ext/patchbay/src/store.js.)
registerKind('patchbay', { label: 'Patchbay', icon: '⊞', extensions: ['.patchbay'] });

// The A-Bus inspector — a diagnostic surface, spawned from the Debug menu
// (not tied to a VFS path).
registerKind('inspector', { label: 'A-Bus Inspector', icon: '◉', extensions: [] });

// Workspace settings — appearance, mounts, storage home. Single-instance
// (the spawner re-uses the open tab if one exists). Tools → Settings…
registerKind('settings', { label: 'Settings', icon: '⚙', extensions: [] });

// Documentation reader — reads from /usr/share/doc/ (populated by
// docs-loader at boot from the build-embedded payload). Single-instance.
// Help → Documentation, or F1.
registerKind('docs', { label: 'Documentation', icon: '?', extensions: [] });
