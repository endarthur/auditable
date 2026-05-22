// ── SERIALIZE — pure data serialization (no DOM dependencies) ──
//
// Extracted from save.js to enable headless notebook processing.
// save.js re-exports these for backward compatibility.

// ── CELL SERIALIZATION ──

export function serializeCells(cells) {
  return cells.map(c => ({
    type: c.type,
    code: c.code,
    collapsed: c.collapsed || undefined,
  }));
}

// ── MODULES ENCODING ──
// base64-encode modules JSON to avoid HTML comment / String.replace issues
// (source code can contain --, $', etc.)

export function encodeModules(obj) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

export function decodeModules(raw) {
  const b64 = raw.replace(/\s/g, '');
  // detect legacy format: starts with { means raw JSON (not base64)
  if (b64.startsWith('{') || b64.startsWith('%7B')) return JSON.parse(raw);
  return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

// ── HTML ENTITY ESCAPING ──

export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── NOTEBOOK HTML PARSING ──
// Extract cells, settings, modules, fs, and title from notebook HTML source.

export function parseNotebookHtml(html) {
  const result = { cells: null, settings: null, modules: null, fs: null, title: 'untitled' };

  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  if (titleMatch) {
    result.title = titleMatch[1].replace(/^Auditable\s*\u2014\s*/, '');
  }

  const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  if (dataMatch) {
    try { result.cells = JSON.parse(dataMatch[1]); } catch {}
  }

  const settingsMatch = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  if (settingsMatch) {
    try { result.settings = JSON.parse(settingsMatch[1]); } catch {}
  }

  const modulesMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  if (modulesMatch) {
    try { result.modules = decodeModules(modulesMatch[1]); } catch {}
  }

  const fsMatch = html.match(/<!--AUDITABLE-FS\n([\s\S]*?)\nAUDITABLE-FS-->/);
  if (fsMatch) {
    try { result.fs = decodeModules(fsMatch[1]); } catch {}
  }

  return result;
}

// ── TXT EXPORT ──
// Build /// formatted text from notebook data.
// Format spec: examples/defs/FORMAT.md.

export function buildTxtExport({ title, cells, settings, moduleUrls }) {
  return serializeNotebookTxt({
    title,
    settings,
    cells,
    modules: (moduleUrls || []).map(url => ({ url })),
  });
}

/**
 * Canonical notebook → /// txt serializer (used by persistence and txt export).
 * Same shape as parseNotebookTxt's output. Modules carry just the URL by default;
 * the second whitespace-separated token (`/// module: <url> <ref>`) is left for
 * gen_examples.js / Works to fill in with content-hash refs.
 */
export function serializeNotebookTxt({ title, settings, cells, modules }) {
  const lines = ['/// auditable'];
  if (title && title !== 'untitled') lines.push('/// title: ' + title);

  const defaultSettings = { theme: 'dark', fontSize: 13, width: '860' };
  if (settings && JSON.stringify(settings) !== JSON.stringify(defaultSettings)) {
    lines.push('/// settings: ' + JSON.stringify(settings));
  }
  if (modules) {
    for (const m of modules) {
      const decl = typeof m === 'string' ? m : (m.url + (m.ref ? ' ' + m.ref : ''));
      lines.push('/// module: ' + decl);
    }
  }
  for (const cell of cells || []) {
    lines.push('');
    const flags = cell.collapsed ? ' collapsed' : '';
    lines.push('/// ' + cell.type + flags);
    lines.push(cell.code || '');
  }
  return lines.join('\n') + '\n';
}

/**
 * /// txt → { title, settings, cells, modules } notebook structure.
 * Used by persistence at hydrate time and by split.js's editor view.
 */
export function parseNotebookTxt(content) {
  const lines = (content || '').split('\n');
  let title = 'untitled';
  let settings = null;
  const cells = [];
  const modules = [];
  let currentCell = null;

  for (const raw of lines) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (l.startsWith('/// ')) {
      if (currentCell) {
        currentCell.code = _trimCell(currentCell.code);
        cells.push(currentCell);
        currentCell = null;
      }
      const directive = l.slice(4);
      if (directive === 'auditable') continue;
      else if (directive.startsWith('title: ')) title = directive.slice(7);
      else if (directive.startsWith('settings: ')) {
        try { settings = JSON.parse(directive.slice(10)); } catch {}
      }
      else if (directive.startsWith('module: ')) {
        const decl = directive.slice(8).trim();
        const sp = decl.indexOf(' ');
        if (sp < 0) modules.push({ url: decl });
        else modules.push({ url: decl.slice(0, sp), ref: decl.slice(sp + 1).trim() });
      }
      else {
        const parts = directive.split(' ');
        const type = parts[0];
        const collapsed = parts.includes('collapsed');
        currentCell = { type, code: '' };
        if (collapsed) currentCell.collapsed = true;
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + l;
    }
  }
  if (currentCell) {
    currentCell.code = _trimCell(currentCell.code);
    cells.push(currentCell);
  }
  return { title, settings, cells, modules };
}

function _trimCell(s) {
  return (s || '').replace(/^\n+/, '').replace(/\n+$/, '');
}

// ── VFS WALKERS ──
// Pure VFS → JSON dump and back. Used by persist.js for save/load.
// Spec: spec_inbox/shipped/auditable-persistence-spec.md.

const _DEFAULT_PERSISTENT_MOUNTS = ['/projects/self', '/lib'];

function _bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function _base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function _walkMount(vfs, mountPath, dump) {
  let entries;
  try { entries = await vfs.readdir(mountPath, { stat: true }); }
  catch { return; }
  for (const entry of entries) {
    const fullPath = mountPath === '/' ? '/' + entry.name : mountPath + '/' + entry.name;
    if (entry.type === 'directory') {
      await _walkMount(vfs, fullPath, dump);
      const sub = await vfs.readdir(fullPath).catch(() => []);
      if (sub.length === 0) dump[fullPath + '/'] = { type: 'directory' };
      continue;
    }
    try {
      // Always read bytes first, then try strict UTF-8 decode. If the bytes
      // round-trip as UTF-8, store as text; otherwise base64. Strict text-first
      // would corrupt binary content (the lossy decoder replaces invalid bytes
      // with U+FFFD silently).
      const bytes = await vfs.readFile(fullPath, 'bytes');
      let content, kind;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        kind = 'text';
      } catch {
        content = _bytesToBase64(bytes);
        kind = 'binary';
      }
      dump[fullPath] = { type: 'file', kind, content, size: entry.size };
    } catch (e) {
      if (typeof console !== 'undefined') console.warn(`[serialize] skip ${fullPath}: ${e.message}`);
    }
  }
}

/**
 * Walk persistent VFS mounts and serialize their contents into a flat
 * { path → entry } dump for persistence.
 *
 * @param {VFS} vfs - VFS instance
 * @param {string[]} [mounts] - persistent mount paths (defaults to ['/projects/self', '/lib'])
 */
export async function serializeVfs(vfs, mounts) {
  const dump = {};
  for (const mount of (mounts || _DEFAULT_PERSISTENT_MOUNTS)) {
    await _walkMount(vfs, mount, dump);
  }
  return dump;
}

/**
 * Hydrate a VFS from a dump produced by serializeVfs.
 */
export async function hydrateVfs(vfs, dump) {
  if (!dump || typeof dump !== 'object') return;
  for (const [path, entry] of Object.entries(dump)) {
    if (entry.type === 'directory') {
      await vfs.mkdir(path.replace(/\/$/, ''), { recursive: true }).catch(() => {});
      continue;
    }
    if (entry.type !== 'file') continue;
    const parent = path.split('/').slice(0, -1).join('/') || '/';
    if (parent !== '/') await vfs.mkdir(parent, { recursive: true }).catch(() => {});
    if (entry.kind === 'binary') await vfs.writeFile(path, _base64ToBytes(entry.content));
    else await vfs.writeFile(path, entry.content);
  }
}

export const PERSISTENT_MOUNTS = _DEFAULT_PERSISTENT_MOUNTS;
