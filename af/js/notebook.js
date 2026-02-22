// ── LIGHTWEIGHT NOTEBOOK FORMAT ──
// Dehydrate: full HTML → compact JSON + content-addressed blob store
// Hydrate: compact JSON + blob store → full HTML for iframe loading

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

// ── Dehydrate: full HTML → lightweight JSON ──

async function dehydrate(html) {
  // guard: packed notebooks cannot be dehydrated
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

  // extract and process AUDITABLE-MODULES
  const modMatch = html.match(/<!--AUDITABLE-MODULES\n([\s\S]*?)\nAUDITABLE-MODULES-->/);
  let modules = null;
  if (modMatch) {
    try {
      const decoded = decodeModulesB64(modMatch[1]);
      modules = {};
      for (const [url, entry] of Object.entries(decoded)) {
        const source = entry.source;
        const hash = await sha256hex(source);
        await blobPut(hash, source);
        const ref = { ref: hash };
        if (entry.cellId != null) ref.cellId = entry.cellId;
        if (entry.binary) ref.binary = true;
        if (entry.compressed) ref.compressed = true;
        if (entry.type) ref.type = entry.type;
        modules[url] = ref;
      }
    } catch (e) {
      console.warn('dehydrate: failed to process modules', e);
    }
  }

  const notebook = {
    format: 'auditable-notebook',
    v: 1,
    title,
    cells,
    settings,
  };
  if (modules && Object.keys(modules).length > 0) {
    notebook.modules = modules;
  }

  return JSON.stringify(notebook);
}

// ── Hydrate: lightweight JSON → full HTML ──

async function hydrate(jsonStr) {
  const notebook = JSON.parse(jsonStr);

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
      const source = await blobGet(entry.ref);
      if (source === null) {
        console.warn('hydrate: missing blob for', url, 'hash:', entry.ref);
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
