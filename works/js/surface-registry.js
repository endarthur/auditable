// The surface registry — every surface kind Works can host
// (auditable-works-spec §6). A project's project.json `kind` names an entry
// directly; a loose file dispatches by extension.
//
// Surfaces are embedded in works.html as gzip+base64 payloads (§15.1, built
// by build.js); surfaceUrl() decompresses one to a blob URL on first spawn.

const KINDS = new Map();          // kind → { label, icon, extensions }
const _surfaceBlobs = new Map();  // kind → blob URL (decompressed once)

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

// Decompress every embedded surface payload to a blob URL. Run once at shell
// boot. Eager rather than lazy-per-spawn (spec §15.1 says "lazy") because the
// blob URL must be ready *synchronously* when a surface iframe is created — a
// src-less iframe loads about:blank first, which double-fires the welcome and
// neuters the transferred port, and an about:blank guard is not robust from
// file://. The payloads decompress in ~tens of ms total, so boot stays light.
export async function decompressSurfaces() {
  for (const kind of KINDS.keys()) {
    const el = document.getElementById('surface-' + kind);
    if (!el) { console.warn('[works] no embedded payload for surface:', kind); continue; }
    const bytes = Uint8Array.from(
      atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
    const html = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    _surfaceBlobs.set(kind, URL.createObjectURL(new Blob([html], { type: 'text/html' })));
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
