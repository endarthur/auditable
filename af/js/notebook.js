// ── LIGHTWEIGHT NOTEBOOK FORMAT ──
// Dehydrate: full HTML → compact JSON + content-addressed blob store
// Hydrate: compact JSON + blob store → full HTML for iframe loading
// Txt: plain-text /// format for human/LLM-friendly notebook files

import { blobPut, blobGet } from './fs.js';

// ── Helpers ──

async function sha256hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeModulesB64(obj) {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/.{1,76}/g, '$&\n').trimEnd();
}

function decodeModulesB64(raw) {
  const b64 = raw.replace(/\s/g, '');
  // detect legacy format: starts with { means raw JSON (not base64)
  if (b64.startsWith('{') || b64.startsWith('%7B')) return JSON.parse(raw);
  return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

// ── Format detection ──

function isLightweight(content) {
  if (typeof content !== 'string') return false;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    return obj.format === 'auditable-notebook';
  } catch {
    return false;
  }
}

function isAuditableTxt(content) {
  if (typeof content !== 'string') return false;
  return content.startsWith('/// auditable\n') || content.startsWith('/// auditable\r\n');
}

// ── Extract notebook from HTML (pure, no blob-store side effects) ──

function extractNotebook(html) {
  // guard: packed notebooks cannot be extracted
  if (/<meta\s+name="auditable-packed"/i.test(html)) return null;

  // extract title from docTitle input
  const titleMatch = html.match(/id="docTitle"\s+value="([^"]*)"/);
  const title = titleMatch ? titleMatch[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : 'untitled';

  // extract AUDITABLE-DATA
  const dataMatch = html.match(/<!--AUDITABLE-DATA\n([\s\S]*?)\nAUDITABLE-DATA-->/);
  let cells = [];
  if (dataMatch) {
    try { cells = JSON.parse(dataMatch[1]); } catch {}
  }

  // extract AUDITABLE-SETTINGS
  const setMatch = html.match(/<!--AUDITABLE-SETTINGS\n([\s\S]*?)\nAUDITABLE-SETTINGS-->/);
  let settings = {};
  if (setMatch) {
    try { settings = JSON.parse(setMatch[1]); } catch {}
  }

  // extract AUDITABLE-MODULES (with full source)
  const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  let modules = null;
  if (modMatch) {
    try {
      const decoded = decodeModulesB64(modMatch[1]);
      modules = {};
      for (const [url, entry] of Object.entries(decoded)) {
        modules[url] = { ...entry };
      }
    } catch (e) {
      console.warn('extractNotebook: failed to process modules', e);
    }
  }

  const notebook = { title, cells, settings };
  if (modules && Object.keys(modules).length > 0) {
    notebook.modules = modules;
  }
  return notebook;
}

// ── Store module blobs (hash source, blobPut, replace with refs) ──

async function storeModuleBlobs(notebook) {
  if (!notebook.modules) return;
  for (const [url, entry] of Object.entries(notebook.modules)) {
    if (entry.ref && !entry.source) continue; // already a ref
    const source = entry.source;
    if (!source) continue;
    const hash = await sha256hex(source);
    await blobPut(hash, source);
    const ref = { ref: hash };
    if (entry.cellId != null) ref.cellId = entry.cellId;
    if (entry.binary) ref.binary = true;
    if (entry.compressed) ref.compressed = true;
    if (entry.type) ref.type = entry.type;
    notebook.modules[url] = ref;
  }
}

// ── Dehydrate: full HTML → lightweight JSON ──

async function dehydrate(html) {
  const notebook = extractNotebook(html);
  if (!notebook) return null;

  await storeModuleBlobs(notebook);

  const lightweight = {
    format: 'auditable-notebook',
    v: 1,
    title: notebook.title,
    cells: notebook.cells,
    settings: notebook.settings,
  };
  if (notebook.modules && Object.keys(notebook.modules).length > 0) {
    lightweight.modules = notebook.modules;
  }

  return JSON.stringify(lightweight);
}

// ── Hydrate: notebook object → full HTML ──

async function hydrateNotebook(notebook) {
  // start with runtime template
  let html = __AUDITABLE_RUNTIME__;

  // set <title>
  html = html.replace(
    '<title>Auditable</title>',
    '<title>Auditable \u2014 ' + escAttr(notebook.title || 'untitled') + '</title>'
  );

  // set docTitle input value
  html = html.replace(
    'id="docTitle" value="untitled"',
    'id="docTitle" value="' + escAttr(notebook.title || 'untitled') + '"'
  );

  // build data comments
  const dataComment = '<!-- cell data: JSON array of {type, code, collapsed?} -->\n<!--AUDITABLE-DATA\n' + JSON.stringify(notebook.cells || []) + '\nAUDITABLE-DATA-->';

  // resolve modules from blob store
  let modulesComment = '';
  if (notebook.modules && Object.keys(notebook.modules).length > 0) {
    const resolved = {};
    for (const [url, entry] of Object.entries(notebook.modules)) {
      if (!entry.ref) {
        console.warn('hydrateNotebook: module without ref, skipping', url);
        continue;
      }
      const source = await blobGet(entry.ref);
      if (source === null) {
        console.warn('hydrateNotebook: missing blob for', url, 'hash:', entry.ref);
        continue;
      }
      const mod = { source };
      if (entry.cellId != null) mod.cellId = entry.cellId;
      if (entry.binary) mod.binary = true;
      if (entry.compressed) mod.compressed = true;
      if (entry.type) mod.type = entry.type;
      resolved[url] = mod;
    }
    if (Object.keys(resolved).length > 0) {
      modulesComment = '<!-- installed modules: base64-encoded JSON mapping URLs to {source, cellId} -->\n<!--AUDITABLE-MODULES\n' + encodeModulesB64(resolved) + '\nAUDITABLE-MODULES-->';
    }
  }

  const settingsComment = '<!-- notebook settings: JSON {theme, fontSize, width, ...} -->\n<!--AUDITABLE-SETTINGS\n' + JSON.stringify(notebook.settings || {}) + '\nAUDITABLE-SETTINGS-->';

  // inject before <script> tag (same pattern as make_example.js)
  const insertion = '\n' + dataComment + '\n' + (modulesComment ? modulesComment + '\n' : '') + settingsComment + '\n\n<script>';
  html = html.replace('\n<script>', () => insertion);

  return html;
}

// ── Hydrate: lightweight JSON string → full HTML (existing API) ──

async function hydrate(jsonStr) {
  return hydrateNotebook(JSON.parse(jsonStr));
}

// ── Txt format: parse /// delimited plain-text ──

function parseTxt(content) {
  const lines = content.split('\n');
  let title = 'untitled';
  let settings = { theme: 'dark', fontSize: 13, width: '860' };
  const modules = {};
  const cells = [];
  let currentCell = null;

  for (const line of lines) {
    // strip trailing \r for CRLF files
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (l.startsWith('/// ')) {
      // flush previous cell
      if (currentCell) {
        currentCell.code = trimCell(currentCell.code);
        cells.push(currentCell);
        currentCell = null;
      }

      const directive = l.slice(4);

      if (directive === 'auditable') {
        // magic first line, skip
        continue;
      } else if (directive.startsWith('title: ')) {
        title = directive.slice(7);
      } else if (directive.startsWith('settings: ')) {
        try { settings = JSON.parse(directive.slice(10)); } catch {}
      } else if (directive.startsWith('module: ')) {
        const parts = directive.slice(8).split(' ');
        const url = parts[0];
        const ref = parts.length > 1 ? parts.slice(1).join(' ') : null;
        modules[url] = { ref };
      } else {
        // cell type line: "code", "code collapsed", "md", "css", "html"
        const parts = directive.split(' ');
        const type = parts[0];
        const collapsed = parts.includes('collapsed');
        currentCell = { type };
        if (collapsed) currentCell.collapsed = true;
        currentCell.code = '';
      }
    } else if (currentCell) {
      currentCell.code += (currentCell.code ? '\n' : '') + l;
    }
    // lines before any cell directive are ignored
  }

  // flush last cell
  if (currentCell) {
    currentCell.code = trimCell(currentCell.code);
    cells.push(currentCell);
  }

  const notebook = { title, cells, settings };
  if (Object.keys(modules).length > 0) {
    notebook.modules = {};
    for (const [url, entry] of Object.entries(modules)) {
      notebook.modules[url] = { ref: entry.ref };
    }
  }
  return notebook;
}

function trimCell(code) {
  return code.replace(/^\n/, '').replace(/\n$/, '');
}

// ── Txt format: serialize notebook object → /// text ──

function toTxt(notebook) {
  const lines = ['/// auditable'];

  if (notebook.title && notebook.title !== 'untitled') {
    lines.push('/// title: ' + notebook.title);
  }

  const defaultSettings = { theme: 'dark', fontSize: 13, width: '860' };
  if (notebook.settings && JSON.stringify(notebook.settings) !== JSON.stringify(defaultSettings)) {
    lines.push('/// settings: ' + JSON.stringify(notebook.settings));
  }

  if (notebook.modules) {
    for (const [url, entry] of Object.entries(notebook.modules)) {
      if (entry.ref) {
        lines.push('/// module: ' + url + ' ' + entry.ref);
      } else {
        lines.push('/// module: ' + url);
      }
    }
  }

  for (const cell of (notebook.cells || [])) {
    lines.push('');
    const flags = cell.collapsed ? ' collapsed' : '';
    lines.push('/// ' + cell.type + flags);
    lines.push(cell.code || '');
  }

  return lines.join('\n') + '\n';
}
