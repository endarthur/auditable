// Convenience helpers that consumers of @gcu/epub commonly need but
// don't strictly belong inside writeEpub / readEpub. Two functions:
//
//   extractDataUrlImages — walks an HTML body for `<img src="data:…">`
//   entries, decodes the base64 to bytes, emits a `resources` array
//   in EPUB-shape (path/mime/bytes), and returns rewritten HTML with
//   the src attributes pointing at the resources. Lets a caller pass
//   the unmodified rendered HTML into writeEpub and get a properly
//   resource-extracted EPUB with no data-URL embeds (Kindle and some
//   older readers don't handle data URLs).
//
//   splitByHeading — pandoc-shape multi-chapter split. Given a single
//   HTML body + a heading level (1..6), return an array of
//   { id, title, body } chapters split at each <hN>. Pre-heading
//   content (anything before the first hN) folds into chapter 1.
//   Returns null when no headings match — caller falls back to a
//   single-chapter book.

// ── Data URL extraction ─────────────────────────────────────────────

const _MIME_TO_EXT = {
  'image/png':     'png',
  'image/jpeg':    'jpg',
  'image/gif':     'gif',
  'image/webp':    'webp',
  'image/svg+xml': 'svg',
  'image/bmp':     'bmp',
  'image/avif':    'avif',
};

function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Extract every `<img src="data:image/…;base64,…">` in `html` into a
// resources array; rewrite src to point at the resource path. Other
// data URL forms (data:image/svg+xml,<raw>, data:image/png;base64,...
// inside a CSS url(), etc.) are NOT extracted here — only the literal
// HTML img-src form. Good enough for the markdown-rendered output the
// doc surface produces.
//
// opts.prefix — path prefix under OEBPS for generated resources.
//               Default 'images/'. Trailing slash optional; normalized.
// opts.startIndex — number to start counting from (for callers
//                   continuing a previous batch). Default 1.
//
// Returns { html, resources, nextIndex }.
export function extractDataUrlImages(html, opts = {}) {
  const prefix = (opts.prefix || 'images/').replace(/\/?$/, '/');
  let counter = opts.startIndex || 1;
  const resources = [];

  // /<img\s+...src=\s*"data:image/X;base64,Y"...\/?>/ — capture the
  // attribute boundaries so we can rewrite the src specifically.
  const re = /<img\b([^>]*?)\bsrc\s*=\s*(['"])(data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+))\2([^>]*)\/?>/gi;
  const newHtml = html.replace(re, (_full, preAttrs, _q, _full2, mime, b64, postAttrs) => {
    const cleanB64 = b64.replace(/\s+/g, '');
    let bytes;
    try { bytes = _b64ToBytes(cleanB64); }
    catch { return _full; }   // malformed — leave the original alone
    const ext = _MIME_TO_EXT[mime.toLowerCase()] || 'bin';
    const path = `${prefix}auto${counter++}.${ext}`;
    resources.push({ path, mime, bytes });
    // Strip a trailing self-closing slash from postAttrs (the regex
    // captured it as part of `[^>]*`); we re-add our own `/` for
    // strict XHTML compliance.
    const pa = postAttrs.replace(/\s*\/\s*$/, '');
    return `<img${preAttrs}src="${path}"${pa}/>`;
  });

  return { html: newHtml, resources, nextIndex: counter };
}

// ── Multi-chapter split ─────────────────────────────────────────────

// Prefixed names so the concat bundle doesn't collide with toc.js's
// internal helpers of the same name. (Module-scope identifiers in
// the source files become flat globals after the build concatenates
// — see feedback_concat_bundle_isolation.)
function _slugifyHelper(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-{2,}/g, '-');
}

function _stripTagsHelper(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Split an HTML body by <hN> boundaries (level = 1..6). Each chapter
// is { id, title, body } where body includes the heading tag itself
// at the top — so the chapter renders with its title visible.
//
// Pre-heading content (anything before the first hN) is prepended to
// chapter 1's body. If no hN exists at all, returns null.
//
// IDs are slugified from titles, made unique within the result. Empty
// titles fall back to "Chapter N".
export function splitByHeading(html, level) {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new Error('splitByHeading: level must be 1..6');
  }
  const re = new RegExp(`<h${level}\\b[^>]*>[\\s\\S]*?</h${level}>`, 'gi');
  const titleRe = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'i');

  const positions = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const titleMatch = titleRe.exec(m[0]);
    const titleText = titleMatch ? _stripTagsHelper(titleMatch[1]) : '';
    positions.push({
      start: m.index,
      title: titleText || `Chapter ${positions.length + 1}`,
    });
  }
  if (positions.length === 0) return null;

  const out = [];
  const usedIds = new Set();
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start : html.length;
    let body = html.slice(start, end).trim();
    if (i === 0 && start > 0) {
      // Prepend pre-heading content to the first chapter so it doesn't get lost.
      const pre = html.slice(0, start).trim();
      if (pre) body = pre + '\n' + body;
    }
    let id = _slugifyHelper(positions[i].title);
    if (!id) id = 'ch' + (i + 1);
    let candidate = id, n = 1;
    while (usedIds.has(candidate)) { n++; candidate = id + '-' + n; }
    usedIds.add(candidate);
    out.push({ id: candidate, title: positions[i].title, body });
  }
  return out;
}
