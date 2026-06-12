// @gcu/markdown — character classification + escaping. Code-point aware where
// it matters: the corpus check caught mathematical alphanumerics (𝑃, 𝑠 — outside
// the BMP, surrogate pairs in UTF-16) misclassifying under unit-at-a-time reads,
// so every neighbor probe goes through cpBefore/cpAt (SPEC §3.2.4).

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The code point (as a string, 1–2 UTF-16 units) ending at index i, or
// undefined at the start of input.
export function cpBefore(text, i) {
  if (i <= 0) return undefined;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

// The code point starting at index i, or undefined at the end of input.
export function cpAt(text, i) {
  if (i >= text.length) return undefined;
  const hi = text.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
    const lo = text.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return text.slice(i, i + 2);
  }
  return text[i];
}

const RE_SPACE = /\s/;
const RE_ALNUM = /[\p{L}\p{N}]/u;
const RE_PUNCT = /[\p{P}\p{S}]/u;

// Undefined (start/end of input) classifies as space — a delimiter at the edge
// of the text behaves as if bordered by whitespace, which is what flanking wants.
export const isSpaceCp = (cp) => cp === undefined || RE_SPACE.test(cp);
export const isAlnumCp = (cp) => cp !== undefined && RE_ALNUM.test(cp);
export const isPunctCp = (cp) => cp !== undefined && RE_PUNCT.test(cp);

// CommonMark's escapable set: ALL ASCII punctuation (the corpus caught `\,` in
// LaTeX — escapes are not limited to markdown's own marker characters).
export function isEscapable(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40)
    || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
}

// Heading auto-slugs — byte-compatible with src/js/markdown.js's slugify so
// existing TOC anchors don't move when renderMd becomes a re-export (SPEC §7).
// Operates on the heading's PLAIN TEXT (inline nodes flattened), so the
// code-placeholder and marker-stripping passes of the original are no-ops here
// but kept for output parity on pathological inputs.
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/`([^`]*)`/g, ' $1 ')
    .replace(/[*_]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// HTML entities — numeric forms plus a curated named set (the full HTML list
// is ~2200 names; wild markdown uses a handful). Decoding to TEXT is safe by
// construction: a decoded `<` is a text value, re-escaped at render. Unknown
// names stay literal.
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×',
  divide: '÷', middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', sigma: 'σ',
  mu: 'μ', pi: 'π', lambda: 'λ', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔',
};

// Decode one entity at src[i] (which is '&'). Returns { text, len } or null.
export function decodeEntity(src, i) {
  const m = src.slice(i, i + 36).match(/^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/);
  if (!m) return null;
  if (m[1] != null || m[2] != null) {
    let cp = m[1] != null ? parseInt(m[1], 10) : parseInt(m[2], 16);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  const named = ENTITIES[m[3]];
  return named ? { text: named, len: m[0].length } : null;
}

// Link-scheme probe — strip ASCII controls/space first so `java\tscript:`
// cannot slip past (cradle's reviewed posture, SPEC §5).
export function urlScheme(url) {
  const probe = String(url).replace(/[\x00-\x20]+/g, '');
  const m = probe.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}
export function strippedUrl(url) {
  return String(url).replace(/[\x00-\x20]+/g, '');
}
