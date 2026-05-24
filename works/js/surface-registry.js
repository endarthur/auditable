// The surface registry — every surface kind Works can host
// (auditable-works-spec §6). A project's project.json `kind` names an entry
// directly; a loose file dispatches by extension.
//
// Surfaces are embedded in works.html as gzip+base64 payloads (§15.1, built
// by build.js); surfaceUrl() decompresses one to a blob URL on first spawn.

const KINDS = new Map();          // kind → { label, icon, extensions }
const _surfaceBlobs = new Map();  // kind → blob URL (decompressed once)
const _libSources = new Map();    // lib name → raw bundle source (string)

export function registerKind(kind, def) {
  KINDS.set(kind, {
    label:      def.label || kind,
    icon:       def.icon || '■',
    extensions: def.extensions || [],
  });
}

export function kindDef(kind) {
  return KINDS.get(kind) || null;
}

// The surface kind that handles a loose file, by extension — or null.
export function kindForExtension(filename) {
  const i = filename.lastIndexOf('.');
  const ext = i >= 0 ? filename.slice(i).toLowerCase() : '';
  if (!ext) return null;
  for (const [kind, def] of KINDS) {
    if (def.extensions.includes(ext)) return kind;
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

function _inlineLibsIntoSurface(text, kind) {
  // The import map is decorative once we're inlining.
  text = text.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
  // For each lib imported by bare specifier in this surface, inline the
  // bundle (with its exports rewritten to locals).
  let inlinedGeas = false;
  for (const [name, src] of _libSources) {
    const re = new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]@gcu/${name}['"];?`);
    if (!re.test(text)) continue;
    if (name === 'geas') inlinedGeas = true;
    const inlined = _rewriteExportToConsts(src);
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

// The data-preview surface — read-only viewer for structured file types
// (CSV table, JSON tree, rendered markdown, image, PDF). Registered
// BEFORE text so it wins for the rich extensions; text still claims the
// rest. kindForExtension returns the first match, so order matters.
registerKind('preview', {
  label:      'Preview',
  icon:       '◳',
  extensions: ['.csv', '.tsv', '.json', '.geojson', '.md', '.markdown',
               '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
               '.ico', '.avif', '.pdf'],
});

// The text editor — the loose-file surface. Opens any plain-text file.
registerKind('text', {
  label:      'Text file',
  icon:       '▤',
  extensions: ['.txt', '.md', '.json', '.js', '.css', '.html',
               '.csv', '.log', '.xml', '.yaml', '.yml'],
});

// The A-Bus inspector — a diagnostic surface, spawned from the Debug menu
// (not tied to a VFS path).
registerKind('inspector', { label: 'A-Bus Inspector', icon: '◉', extensions: [] });
