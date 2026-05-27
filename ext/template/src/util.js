// Tiny shared helpers — kept separate so filters.js and render.js can both
// pull them in without a circular dependency.

export function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Decode bytes as UTF-8 text. Used when a binary read needs to be treated as
// text by a filter. Falls back to a best-effort string conversion if the
// runtime has no TextDecoder (it always does in modern browsers + Node 11+,
// but the defensive path is cheap).
export function textForBytes(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Uint8Array) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(input); }
    catch { /* fall through */ }
    let s = '';
    for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i]);
    return s;
  }
  return String(input);
}

// Split a path's extension. Returns '' for files with no extension. The
// extension keeps its leading dot so it matches the filter registry keys
// (.csv, .png) directly.
export function extOf(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return '';
  const slash = path.lastIndexOf('/');
  if (i < slash) return '';   // dot is in a directory name, not the file
  return path.slice(i).toLowerCase();
}

// Decide whether a path needs binary or text bytes. Binary extensions get
// Uint8Array; everything else is read as utf-8 text. Caller can override
// via filter behaviour (e.g. .csv filters call textForBytes themselves so
// they accept either form).
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.wasm',
]);
export function isBinaryExt(ext) {
  return BINARY_EXTS.has(ext);
}
