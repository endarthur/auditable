// Per-extension filter registry plus the default filters shipped with the
// engine. Filters are pure async (input, ...args) → output functions. The
// first filter in a chain receives the file's raw content (text for textual
// extensions, Uint8Array for binary). The last filter's return value is the
// rendered output — typically an HTML string; consumers can use a different
// final type, but HTML is the lingua franca for doc / deck / sheet surfaces.
//
// Extension dispatch:
//   - Filter lookup is per-extension: registerFilter('.csv', 'head', fn).
//   - Filters can also be registered under '*' to apply to any extension.
//   - A bareword `default` filter per extension picks the sensible rendering
//     when no filter is given (a `.csv` table, a `.png` <img>, a `.md` inline).
//
// Built-ins are intentionally small. Surfaces can register their own per-call
// via render({ filters: { ... } }), and apps can globally extend via the
// registerFilter API.

import { textForBytes, htmlEscape } from './util.js';

const _registry = new Map();   // ext -> Map<name, fn>
function _bucket(ext) {
  let m = _registry.get(ext);
  if (!m) { m = new Map(); _registry.set(ext, m); }
  return m;
}

export function registerFilter(ext, name, fn) {
  _bucket(ext).set(name, fn);
}

// Look up a filter for the given extension, falling back to the wildcard
// bucket if the per-extension table has no match. Returns null if neither.
export function lookupFilter(ext, name) {
  const e = _registry.get(ext);
  if (e && e.has(name)) return e.get(name);
  const w = _registry.get('*');
  if (w && w.has(name)) return w.get(name);
  return null;
}

// Run the default filter for an extension on the raw content. Falls back to
// '*'.default; if no default registered anywhere, returns the input as-is.
export async function applyDefault(ext, input) {
  const fn = lookupFilter(ext, 'default');
  if (!fn) return input;
  return fn(input);
}

// ── Built-in defaults ────────────────────────────────────────────────────
//
// Textual:
//   .md     default → render markdown (caller's renderMd hook, falls back to
//                     escaped inline if absent — keep the engine renderer-agnostic)
//   .csv    default → format as HTML table
//   .json   default → pretty-printed <pre> block
//   .txt    default → escaped <pre> block
//   .html   default → raw HTML (trusted; producer wrote the file)
// Binary:
//   .png/.jpg/.gif/.webp/.svg default → <img> tag with data URL
//
// Common filters:
//   head N   — first N lines (csv/txt) or first N items (json array)
//   tail N   — last N lines / items
//   raw      — return contents verbatim, no HTML wrapping
//   pretty   — JSON-pretty (also default for .json)
//   compact  — JSON-compact

function _attrEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── csv ──
registerFilter('.csv', 'head', async (input, n) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  const lines = text.split(/\r?\n/);
  const k = Math.max(0, Number(n) || 0);
  return lines.slice(0, k + 1).join('\n');   // +1 keeps header row
});
registerFilter('.csv', 'tail', async (input, n) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0];
  const body = lines.slice(1);
  const k = Math.max(0, Number(n) || 0);
  return [header, ...body.slice(-k)].join('\n');
});
registerFilter('.csv', 'format', async (input, mode) => {
  if (mode === 'inline' || mode === 'raw') return typeof input === 'string' ? input : textForBytes(input);
  // 'table' default — naive split-on-comma. No quoted-field handling here;
  // dedicated CSV cells should use std.csv in the notebook. This is the
  // "show me what's in the file" default for documents.
  const text = typeof input === 'string' ? input : textForBytes(input);
  const rows = text.split(/\r?\n/).filter(Boolean).map((r) => r.split(','));
  if (!rows.length) return '';
  const [head, ...body] = rows;
  const th = head.map((c) => `<th>${_attrEscape(c)}</th>`).join('');
  const trs = body.map((r) =>
    '<tr>' + r.map((c) => `<td>${_attrEscape(c)}</td>`).join('') + '</tr>').join('');
  return `<table class="tpl-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
});
registerFilter('.csv', 'default', async (input) => {
  return (await lookupFilter('.csv', 'format'))(input, 'table');
});

// ── json ──
registerFilter('.json', 'pretty', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
});
registerFilter('.json', 'compact', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  try { return JSON.stringify(JSON.parse(text)); }
  catch { return text; }
});
registerFilter('.json', 'pick', async (input, key) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  let obj;
  try { obj = JSON.parse(text); }
  catch { return text; }
  for (const part of String(key).split('.')) {
    if (obj == null) return '';
    obj = obj[part];
  }
  return typeof obj === 'string' ? obj : JSON.stringify(obj);
});
registerFilter('.json', 'default', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  try {
    const pretty = JSON.stringify(JSON.parse(text), null, 2);
    return `<pre class="tpl-json">${_attrEscape(pretty)}</pre>`;
  } catch {
    return `<pre class="tpl-json">${_attrEscape(text)}</pre>`;
  }
});

// ── markdown / text / html ──
registerFilter('.md', 'default', async (input) => {
  // Engine stays renderer-agnostic — the consumer (doc surface) overrides
  // this filter with its own markdown→HTML pipeline when it sets up render.
  // The fallback is a <pre> block so a bare engine still produces output.
  const text = typeof input === 'string' ? input : textForBytes(input);
  return `<div class="tpl-md">${_attrEscape(text)}</div>`;
});
registerFilter('.txt', 'default', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  return `<pre class="tpl-txt">${_attrEscape(text)}</pre>`;
});
registerFilter('.html', 'default', async (input) => {
  return typeof input === 'string' ? input : textForBytes(input);
});

// ── images ──
function _bytesToDataUrl(input, mime) {
  if (typeof input === 'string') {
    // Already a data URL or other ready-to-embed form
    return input;
  }
  let bin = '';
  for (let i = 0; i < input.length; i++) bin += String.fromCharCode(input[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}
function _imgFilter(mime) {
  return async (input, ...attrs) => {
    const url = _bytesToDataUrl(input, mime);
    // attrs are space-separated key=value pairs OR positional width
    const kv = [];
    for (const a of attrs) {
      if (a.includes('=')) {
        const [k, v] = a.split('=', 2);
        kv.push(`${_attrEscape(k)}="${_attrEscape(v)}"`);
      } else {
        kv.push(`width="${_attrEscape(a)}"`);
      }
    }
    return `<img src="${url}" ${kv.join(' ')}/>`;
  };
}
for (const [ext, mime] of [
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
]) {
  registerFilter(ext, 'default', _imgFilter(mime));
}

// ── wildcard ──
registerFilter('*', 'raw', async (input) => {
  return typeof input === 'string' ? input : textForBytes(input);
});
registerFilter('*', 'escape', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  return htmlEscape(text);
});
