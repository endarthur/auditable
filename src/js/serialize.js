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

export function buildTxtExport({ title, cells, settings, moduleUrls }) {
  const lines = ['/// auditable'];
  if (title && title !== 'untitled') {
    lines.push('/// title: ' + title);
  }
  const defaultSettings = { theme: 'dark', fontSize: 13, width: '860' };
  if (settings && JSON.stringify(settings) !== JSON.stringify(defaultSettings)) {
    lines.push('/// settings: ' + JSON.stringify(settings));
  }
  if (moduleUrls) {
    for (const url of moduleUrls) {
      lines.push('/// module: ' + url);
    }
  }
  for (const cell of cells) {
    lines.push('');
    const flags = cell.collapsed ? ' collapsed' : '';
    lines.push('/// ' + cell.type + flags);
    lines.push(cell.code || '');
  }
  return lines.join('\n') + '\n';
}
