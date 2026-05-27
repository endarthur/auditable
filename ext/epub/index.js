// @gcu/epub — EPUB 3 writer + reader (with EPUB 2 NCX fallback).
// Auto-generated from ext/epub/src/ — do not edit directly.

// -- xhtml.js --

// HTML → XHTML normalizer. EPUB requires strict XHTML 1.1 / EPUB3
// content documents, but a caller naturally produces HTML5
// (`<br>`, `<img>`, `<hr>`, unquoted attrs, etc.). This module
// makes the bridge.
//
// Specifically:
//   - Void elements get self-closing slashes (`<br>` → `<br/>`)
//   - Bare attribute values are double-quoted
//   - Ampersands not part of an entity are escaped (`&` → `&amp;`)
//   - <body> + <html> wrapping with the epub:type namespace declared
//     so EPUB3 readers can attach semantic roles
//
// The normalizer is permissive — it doesn't fully parse HTML. EPUB
// readers are themselves permissive about minor non-conformance, so
// the small risk of an edge-case mis-normalization is preferable to
// dragging in a full parser. If a doc breaks epubcheck for a real
// reason, we tighten here.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Self-close void elements that aren't already self-closed.
function _selfCloseVoid(html) {
  return html.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b([^>]*?)(\s*\/?)>/gi,
    (_match, tag, attrs, trailing) => {
      const t = tag.toLowerCase();
      if (!VOID_ELEMENTS.has(t)) return _match;
      // Already self-closing? Leave alone.
      if (/\/\s*$/.test(trailing)) return `<${t}${attrs}/>`;
      return `<${t}${attrs}/>`;
    },
  );
}

// Quote unquoted attribute values. Conservative — only matches the
// common `key=value` shape with no spaces in `value`. Quoted values
// pass through untouched.
function _quoteAttrs(html) {
  return html.replace(
    /(\s[a-zA-Z_:][\w.-]*\s*=\s*)(['"]?)([^\s"'>]*)\2/g,
    (_m, lhs, q, v) => q ? `${lhs}${q}${v}${q}` : `${lhs}"${v}"`,
  );
}

// Escape bare ampersands. A `&` followed by a known-entity shape
// (`&amp;`, `&#39;`, `&#x27;`, …) is left alone; everything else gets
// `&amp;`-ed. This catches the common `<p>a & b</p>` case without
// double-escaping already-encoded entities.
function _escapeBareAmp(html) {
  return html.replace(/&(?!(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

// Public: normalize a chunk of HTML to be valid XHTML body content.
// Does NOT add a wrapping <html>/<body> — that's the chapter
// envelope's job. Returns the cleaned HTML string.
function normalizeXhtml(html) {
  if (typeof html !== 'string') html = String(html || '');
  let out = html;
  out = _escapeBareAmp(out);
  out = _quoteAttrs(out);
  out = _selfCloseVoid(out);
  return out;
}

// Wrap a body fragment in the strict XHTML envelope an EPUB chapter
// expects. `title` lands in <head><title>; `body` is the normalized
// HTML content; `cssHref` is the relative path to the styles.css
// embedded alongside the chapter (typically "styles.css").
function chapterDoc({ title, body, cssHref, lang }) {
  const titleEsc = escAttr(title || '');
  const langAttr = lang ? ` xml:lang="${escAttr(lang)}" lang="${escAttr(lang)}"` : '';
  const css = cssHref
    ? `\n  <link rel="stylesheet" type="text/css" href="${escAttr(cssHref)}"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${langAttr}>
<head>
  <meta charset="utf-8"/>
  <title>${titleEsc}</title>${css}
</head>
<body>${body}</body>
</html>
`;
}

// Tiny attr/text escaper used by the manifest emitters too. Conservative
// — escapes the 5 XML-significant chars only.
function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// -- toc.js --

// Heading extraction → nested TOC structure.
//
// Walk each chapter's HTML body for <h1>..<h6> elements, build a flat
// list of { level, id, text, chapterId, chapterTitle }, then nest them
// into a tree following the level hierarchy. The tree is consumed by
// the nav.xhtml + toc.ncx emitters in manifest.js.

const HEADING_RE = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
const ID_ATTR_RE = /\bid\s*=\s*"([^"]*)"/i;

// Strip inline HTML tags from heading text to get a plain-text label
// for the TOC. The actual chapter body keeps full markup; the TOC
// just needs words.
function _stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Slugify a heading's text into an id usable as a fragment. Lowercase,
// non-word → '-', collapse runs of '-', trim. Empty inputs become 'h'.
function _slugify(s) {
  const base = s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-{2,}/g, '-');
  return base || 'h';
}

// Walk a single chapter's body, return [{ level, id, text, href }].
// `href` is the path-with-fragment that the TOC will link to —
// 'chapter1.xhtml#section-x'. Headings without explicit ids get one
// synthesized (and we'd rewrite the chapter body to inject them in a
// later pass; for v1 the TOC just points at the chapter file without
// the fragment if id is synthesized).
//
// Returns the headings AND a body with synthesized ids inlined so
// the same chapter render is reachable by fragment from the nav.
function extractHeadings(body, chapterHref) {
  const headings = [];
  const seenIds = new Set();

  // Two-pass: collect, synthesize ids for any missing, rewrite.
  const rewritten = body.replace(HEADING_RE, (full, lvlStr, attrsRaw, inner) => {
    const level = Number(lvlStr);
    const attrs = attrsRaw || '';
    const text = _stripTags(inner);
    const idMatch = ID_ATTR_RE.exec(attrs);
    let id = idMatch ? idMatch[1] : null;
    if (!id) {
      // Synthesize an id; ensure uniqueness within the chapter.
      let candidate = _slugify(text);
      let i = 1;
      while (seenIds.has(candidate)) {
        i++;
        candidate = _slugify(text) + '-' + i;
      }
      id = candidate;
    }
    seenIds.add(id);
    headings.push({
      level, id, text,
      href: chapterHref + '#' + id,
    });
    // Re-emit the heading with the (possibly synthesized) id.
    const newAttrs = idMatch
      ? attrs   // already had id, keep verbatim
      : attrs + ` id="${id}"`;
    return `<h${level}${newAttrs}>${inner}</h${level}>`;
  });

  return { headings, body: rewritten };
}

// Take a list of heading entries (flat, in document order across
// chapters) plus chapter metadata, and nest them by level. Each
// chapter starts a new top-level entry — even if its first heading
// isn't an h1, the chapter is a TOC root. Sub-headings within a
// chapter nest under their nearest-shallower parent.
function buildTocTree(chapters) {
  // Each chapter contributes one root entry (the chapter title +
  // chapter-level href, no fragment), then a nested list of its
  // headings under children.
  const roots = [];
  for (const ch of chapters) {
    const root = {
      title: ch.title || ch.id,
      href: ch.href,
      children: [],
    };
    // Stack of { level, node } for current parents
    const stack = [{ level: 0, node: root }];
    for (const h of ch.headings || []) {
      // Skip a chapter's first heading if its text matches the
      // chapter title — already in the root.
      if (h.level === 1 && root.children.length === 0
          && h.text.trim() === root.title.trim()) {
        // Promote the heading's anchor onto the root and skip
        root.href = h.href;
        continue;
      }
      while (stack[stack.length - 1].level >= h.level) stack.pop();
      const parent = stack[stack.length - 1].node;
      const node = { title: h.text, href: h.href, children: [] };
      parent.children.push(node);
      stack.push({ level: h.level, node });
    }
    roots.push(root);
  }
  return roots;
}

// -- manifest.js --

// XML emitters for the EPUB control files. Five outputs:
//
//   container.xml    META-INF/container.xml — points the reader at the OPF
//   content.opf      OEBPS/content.opf — package: metadata + manifest + spine
//   toc.ncx          OEBPS/toc.ncx — EPUB 2 legacy navigation (Kindle-compat)
//   nav.xhtml        OEBPS/nav.xhtml — EPUB 3 navigation document
//   chapter.xhtml    OEBPS/chapter*.xhtml — per-chapter content (via xhtml.chapterDoc)
//
// All XML escapes go through escAttr in xhtml.js — the 5
// XML-significant chars (& < > " ').
//
// We always emit BOTH NCX (epub2) and nav.xhtml (epub3) — costs ~1 KB
// and maximizes reader compatibility.


// ── container.xml ────────────────────────────────────────────────
//
// The exact path is `META-INF/container.xml`. Tells the reader where
// the OPF is. Always the same shape; we only need it once per book.
function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

// ── content.opf ──────────────────────────────────────────────────
//
// The package document. Dublin Core metadata at the top, manifest of
// every file in the EPUB in the middle, spine (read order) at the
// bottom. EPUB 3 uses version="3.0"; the older `nav` property on the
// nav.xhtml item tells readers which file is the navigation.
//
// Inputs:
//   metadata: { identifier, title, author, lang, date, description, publisher, modified }
//   manifestItems: [{ id, href, mediaType, properties? }]
//   spineIds: [chapterId, ...] in read order
//   ncxId: id of the NCX item (legacy, referenced as spine toc=)
function contentOpf({ metadata, manifestItems, spineIds, ncxId }) {
  const m = metadata || {};
  const id = m.identifier || ('urn:uuid:' + _uuid());
  const lang = m.lang || 'en';
  const title = m.title || 'Untitled';
  const author = m.author || '';
  const date = m.date || '';
  const desc = m.description || '';
  const pub = m.publisher || '';
  const modified = m.modified || _iso();

  const metaLines = [
    `<dc:identifier id="bookid">${escAttr(id)}</dc:identifier>`,
    `<dc:title>${escAttr(title)}</dc:title>`,
    `<dc:language>${escAttr(lang)}</dc:language>`,
    `<meta property="dcterms:modified">${escAttr(modified)}</meta>`,
  ];
  if (author) metaLines.push(`<dc:creator>${escAttr(author)}</dc:creator>`);
  if (date)   metaLines.push(`<dc:date>${escAttr(date)}</dc:date>`);
  if (desc)   metaLines.push(`<dc:description>${escAttr(desc)}</dc:description>`);
  if (pub)    metaLines.push(`<dc:publisher>${escAttr(pub)}</dc:publisher>`);

  const manifest = manifestItems.map((it) => {
    const props = it.properties ? ` properties="${escAttr(it.properties)}"` : '';
    return `    <item id="${escAttr(it.id)}" href="${escAttr(it.href)}" media-type="${escAttr(it.mediaType)}"${props}/>`;
  }).join('\n');

  const spine = spineIds.map((id) => `    <itemref idref="${escAttr(id)}"/>`).join('\n');
  const spineAttrs = ncxId ? ` toc="${escAttr(ncxId)}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metaLines.join('\n    ')}
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine${spineAttrs}>
${spine}
  </spine>
</package>
`;
}

// ── toc.ncx ──────────────────────────────────────────────────────
//
// EPUB 2's navigation control file. Older readers (and Kindle) want
// this. Tree of <navPoint> entries, each with a label + content
// (href). Depth is the deepest nesting level.
function tocNcx({ identifier, title, tree }) {
  const id = identifier || ('urn:uuid:' + _uuid());
  let counter = 0;
  let maxDepth = 1;
  function emit(nodes, depth) {
    if (depth > maxDepth) maxDepth = depth;
    return nodes.map((n) => {
      counter++;
      const navId = 'n' + counter;
      const children = n.children && n.children.length
        ? '\n' + emit(n.children, depth + 1)
        : '';
      return `    <navPoint id="${navId}" playOrder="${counter}">
      <navLabel><text>${escAttr(n.title)}</text></navLabel>
      <content src="${escAttr(n.href)}"/>${children}
    </navPoint>`;
    }).join('\n');
  }
  const navMap = emit(tree, 1);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escAttr(id)}"/>
    <meta name="dtb:depth" content="${maxDepth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escAttr(title)}</text></docTitle>
  <navMap>
${navMap}
  </navMap>
</ncx>
`;
}

// ── nav.xhtml ────────────────────────────────────────────────────
//
// EPUB 3's navigation document. An XHTML page with a <nav epub:type="toc">
// containing a nested <ol>. Some readers also pick up a `landmarks` nav
// for cover/start/toc — we emit one for nicety.
function navXhtml({ title, tree }) {
  function emit(nodes) {
    return '<ol>\n' + nodes.map((n) => {
      const children = n.children && n.children.length
        ? '\n      ' + emit(n.children)
        : '';
      return `      <li><a href="${escAttr(n.href)}">${escAttr(n.title)}</a>${children}</li>`;
    }).join('\n') + '\n    </ol>';
  }
  const list = emit(tree);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="utf-8"/>
  <title>${escAttr(title)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escAttr(title)}</h1>
    ${list}
  </nav>
</body>
</html>
`;
}

// ── helpers ──────────────────────────────────────────────────────

// RFC 4122 v4 UUID — used as the EPUB book identifier when none is
// provided. crypto.randomUUID exists in modern Node + browsers; fall
// back to a Math.random shape if not.
function _uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Current time in EPUB's required modified-timestamp format
// (YYYY-MM-DDTHH:MM:SSZ — RFC 3339 / ISO 8601 with second precision).
function _iso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// Tiny CSS reset shipped as styles.css by default. Readers' default
// styles vary wildly; a small reset keeps Kindle/Apple Books/Calibre
// looking roughly the same. Caller can override via opts.styles.
const DEFAULT_STYLES = `body { font-family: serif; line-height: 1.55; }
h1, h2, h3, h4, h5, h6 { font-family: sans-serif; font-weight: bold; line-height: 1.2; }
h1 { font-size: 1.6em; margin-top: 1em; }
h2 { font-size: 1.35em; margin-top: 1.5em; }
h3 { font-size: 1.15em; margin-top: 1.3em; }
p  { margin: 0.6em 0; }
pre { background: #f4f4f4; padding: 0.5em; overflow: auto; font-family: monospace; font-size: 0.9em; }
code { background: #f4f4f4; padding: 0 0.2em; font-family: monospace; }
blockquote { margin: 0.6em 0 0.6em 1em; padding-left: 0.8em; border-left: 3px solid #ccc; color: #555; }
table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
th, td { padding: 4px 8px; border-bottom: 1px solid #ddd; text-align: left; }
th { background: #f4f4f4; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
`;

// -- helpers.js --

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
function extractDataUrlImages(html, opts = {}) {
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
function splitByHeading(html, level) {
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

// -- write.js --

// writeEpub — the assembly pipeline.
//
// Input: a spec describing the book. Output: Uint8Array containing
// a valid EPUB 3 file with EPUB 2 NCX fallback baked in.
//
// Spec shape (everything optional except `chapters` and `metadata.title`):
//
//   {
//     metadata: { title, author, lang, date, identifier, description, publisher },
//     chapters: [{ id, title, body }],   // body is HTML or XHTML; lib normalizes
//     styles:    '/* css string */',     // optional, replaces DEFAULT_STYLES
//     cover:     { mime, bytes },        // optional cover image
//     resources: [{ path, mime, bytes }], // optional; images/fonts/etc.
//     toc:       'auto' | [{ title, href, children }], // default 'auto' (heading-extract)
//     archive,                            // dep injection: @gcu/archive
//   }
//
// `archive` is required — the lib runs the ZIP writer through whatever
// archive impl the caller passes. (Same dep-injection pattern
// parseGcupkg uses.) `cover.bytes` and `resources[].bytes` must be
// Uint8Array; the library does NOT fetch URLs.




class EpubError extends Error {
  constructor(message) { super(message); this.name = 'EpubError'; }
}

function _mediaTypeForExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.png')  return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.gif')  return 'image/gif';
  if (e === '.webp') return 'image/webp';
  if (e === '.svg')  return 'image/svg+xml';
  if (e === '.css')  return 'text/css';
  if (e === '.js')   return 'application/javascript';
  if (e === '.xhtml')return 'application/xhtml+xml';
  if (e === '.html') return 'application/xhtml+xml';
  if (e === '.ttf')  return 'application/font-sfnt';
  if (e === '.otf')  return 'application/font-sfnt';
  if (e === '.woff') return 'application/font-woff';
  if (e === '.woff2')return 'font/woff2';
  return 'application/octet-stream';
}

function _extOf(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

// Resolve the createWriter function from either the @gcu/archive
// top-level namespace OR a passed-in adapter with a createWriter
// property. `import * as archive from '@gcu/archive'` gives us
// archive.createWriter (top-level export) AND archive.archive
// (the namespaced object holding list/read/extract); accept either.
function _resolveCreateWriter(archive) {
  if (typeof archive?.createWriter === 'function') return archive.createWriter;
  if (typeof archive?.archive?.createWriter === 'function') return archive.archive.createWriter;
  return null;
}

async function writeEpub(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new EpubError('writeEpub: spec object required');
  }
  const createWriter = _resolveCreateWriter(spec.archive);
  if (!createWriter) {
    throw new EpubError('writeEpub: spec.archive (@gcu/archive) required');
  }
  if (!Array.isArray(spec.chapters) || spec.chapters.length === 0) {
    throw new EpubError('writeEpub: at least one chapter required');
  }
  const meta = spec.metadata || {};
  if (!meta.title) {
    throw new EpubError('writeEpub: metadata.title required');
  }

  // ── Pass 1: per-chapter normalize + heading extraction ────────────
  const chapterRecords = [];
  for (let i = 0; i < spec.chapters.length; i++) {
    const ch = spec.chapters[i];
    if (!ch.id) throw new EpubError(`chapter[${i}]: id required`);
    if (!ch.title) throw new EpubError(`chapter[${i}]: title required`);
    const normalized = normalizeXhtml(ch.body || '');
    const href = ch.id + '.xhtml';
    const { headings, body } = extractHeadings(normalized, href);
    chapterRecords.push({
      id:      ch.id,
      title:   ch.title,
      href,
      body,                                    // post-id-injection
      headings,
      xhtml:   chapterDoc({
        title:   ch.title,
        body,
        cssHref: 'styles.css',
        lang:    meta.lang,
      }),
    });
  }

  // ── Pass 2: TOC tree (either auto or caller-provided) ─────────────
  const tocTree = (spec.toc === undefined || spec.toc === 'auto')
    ? buildTocTree(chapterRecords)
    : spec.toc;

  // ── Pass 3: manifest items ────────────────────────────────────────
  const manifestItems = [
    { id: 'nav',    href: 'nav.xhtml',  mediaType: 'application/xhtml+xml', properties: 'nav' },
    { id: 'ncx',    href: 'toc.ncx',    mediaType: 'application/x-dtbncx+xml' },
    { id: 'styles', href: 'styles.css', mediaType: 'text/css' },
  ];
  for (const ch of chapterRecords) {
    manifestItems.push({
      id:        ch.id,
      href:      ch.href,
      mediaType: 'application/xhtml+xml',
    });
  }

  // Cover, optional. Tagged with properties="cover-image" so EPUB 3
  // readers display it as the cover; ALSO referenced via a legacy
  // <meta name="cover"> in the OPF for EPUB 2 readers (we splice
  // that into contentOpf below).
  let coverItem = null;
  if (spec.cover && spec.cover.bytes) {
    const ext = (spec.cover.path && _extOf(spec.cover.path))
      || (spec.cover.mime === 'image/png' ? '.png'
        : spec.cover.mime === 'image/jpeg' ? '.jpg'
        : '.png');
    coverItem = {
      id:        'cover-image',
      href:      'cover' + ext,
      mediaType: spec.cover.mime || _mediaTypeForExt(ext),
      properties:'cover-image',
      bytes:     spec.cover.bytes,
    };
    manifestItems.push({
      id:         coverItem.id,
      href:       coverItem.href,
      mediaType:  coverItem.mediaType,
      properties: coverItem.properties,
    });
  }

  // Resources — typically images referenced by chapter bodies.
  const resources = Array.isArray(spec.resources) ? spec.resources : [];
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    if (!r.path) throw new EpubError(`resources[${i}]: path required`);
    if (!r.bytes) throw new EpubError(`resources[${i}]: bytes required`);
    manifestItems.push({
      id:        'res-' + i,
      href:      r.path,
      mediaType: r.mime || _mediaTypeForExt(_extOf(r.path)),
    });
  }

  // ── Pass 4: assemble XMLs ─────────────────────────────────────────
  const spineIds = chapterRecords.map((c) => c.id);
  const opf = contentOpf({
    metadata: meta,
    manifestItems,
    spineIds,
    ncxId: 'ncx',
  });
  const ncx = tocNcx({
    identifier: meta.identifier,
    title:      meta.title,
    tree:       tocTree,
  });
  const nav = navXhtml({ title: meta.title, tree: tocTree });

  // ── Pass 5: zip everything ────────────────────────────────────────
  //
  // sink='memory' tells @gcu/archive to accumulate chunks and return
  // the assembled bytes from .close(). Cleaner than wiring a custom
  // sink; same path the in-memory tests already exercise.
  const w = createWriter('memory', { format: 'zip', level: 6 });

  // mimetype MUST be first, MUST be stored (uncompressed).
  await w.addFile('mimetype', 'application/epub+zip', { level: 0 });
  await w.addFile('META-INF/container.xml', containerXml());
  await w.addFile('OEBPS/content.opf', opf);
  await w.addFile('OEBPS/toc.ncx', ncx);
  await w.addFile('OEBPS/nav.xhtml', nav);
  await w.addFile('OEBPS/styles.css', spec.styles || DEFAULT_STYLES);
  for (const ch of chapterRecords) {
    await w.addFile('OEBPS/' + ch.href, ch.xhtml);
  }
  if (coverItem) {
    await w.addFile('OEBPS/' + coverItem.href, coverItem.bytes);
  }
  for (let i = 0; i < resources.length; i++) {
    await w.addFile('OEBPS/' + resources[i].path, resources[i].bytes);
  }
  return w.close();
}

// -- read.js --

// readEpub — parse an EPUB back into the spec shape writeEpub takes.
//
// Round-trip property: writeEpub(spec) → bytes; readEpub(bytes) → spec
// matches on metadata, chapter ids/titles/bodies (modulo XHTML envelope
// stripping), cover, resources, toc.
//
// Approach: use @gcu/archive to list + read entries from the EPUB ZIP,
// then small regex-based extractors over the OPF / NCX / nav.xhtml.
// We DON'T pull in a full XML parser — EPUB control files are
// machine-emitted and well-formed; targeted regexes are simpler and
// faster.


const _DECODER = new TextDecoder('utf-8');

// ── XML helpers — small, intentionally permissive ─────────────────
//
// Each takes a string and pulls structured data out. Designed for the
// well-formed XML EPUB control files produce. They are NOT a general-
// purpose XML parser; pathological inputs may yield wrong but
// deterministic results. EPUB inputs in the wild are constrained
// enough that this is fine.

function _decode(s) {
  // Reverse the 5 XML escapes + common entities. Same set xhtml.js
  // emits, plus a few extras for robustness.
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Pull the first occurrence of <tag>...</tag>. Returns null if absent.
// Namespace-aware in the sense that `tag` can include a prefix
// ('dc:title') and the regex matches it literally.
function _tag(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = re.exec(xml);
  return m ? _decode(m[1]).trim() : null;
}

// All occurrences of <tag ...attrs.../> or <tag ...attrs>body</tag>.
// Returns an array of { attrs: {key: val}, body }. Body is null for
// self-closing tags.
function _tags(xml, tag) {
  const out = [];
  const re = new RegExp(
    '<' + tag + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</' + tag + '>)',
    'gi',
  );
  let m;
  while ((m = re.exec(xml))) {
    const attrs = _attrs(m[1]);
    const body = m[2] != null ? _decode(m[2]) : null;
    out.push({ attrs, body });
  }
  return out;
}

function _attrs(attrStr) {
  const out = {};
  if (!attrStr) return out;
  const re = /([a-zA-Z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrStr))) {
    out[m[1]] = _decode(m[2] != null ? m[2] : m[3]);
  }
  return out;
}

// Strip the EPUB chapter envelope (<?xml ?>, <!DOCTYPE>, <html>, <head>,
// <body>) and return just the body content. Round-trip use: if the
// caller passed `<p>hi</p>` to writeEpub, readEpub returns `<p>hi</p>`,
// not the wrapper.
function _stripChapterEnvelope(xml) {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xml);
  if (!m) return xml;   // no body tag — return verbatim
  return m[1].trim();
}

// ── Reader pipeline ──────────────────────────────────────────────

async function readEpub(bytes, opts = {}) {
  if (!(bytes instanceof Uint8Array)) {
    if (bytes && bytes.buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    } else if (bytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytes);
    } else {
      throw new EpubError('readEpub: bytes must be Uint8Array');
    }
  }
  // Resolve list/read against either a namespace import OR the nested
  // `archive` object the bundle also exports. The reader only needs
  // those two functions; everything else lives on the writer side.
  const archive = (opts.archive && typeof opts.archive.list === 'function' && typeof opts.archive.read === 'function')
    ? opts.archive
    : (opts.archive && opts.archive.archive && typeof opts.archive.archive.list === 'function')
      ? opts.archive.archive
      : null;
  if (!archive) {
    throw new EpubError('readEpub: opts.archive with list+read (@gcu/archive) required');
  }

  // List entries + read them all upfront. EPUBs are small (KB–MB
  // range); streaming gains nothing here.
  const entries = await archive.list(bytes);
  const fileSet = new Set(entries.filter((e) => e.type === 'file').map((e) => e.path));
  async function read(path) {
    if (!fileSet.has(path)) return null;
    return archive.read(bytes, path);
  }
  async function readText(path) {
    const b = await read(path);
    return b ? _decode(_DECODER.decode(b)) : null;
  }

  // ── Sanity: mimetype ──
  const mimetypeBytes = await read('mimetype');
  if (mimetypeBytes) {
    const mime = _DECODER.decode(mimetypeBytes).trim();
    if (mime !== 'application/epub+zip') {
      throw new EpubError(`readEpub: unexpected mimetype "${mime}"`);
    }
  }

  // ── container.xml → OPF path ──
  const containerXml = await readText('META-INF/container.xml');
  if (!containerXml) {
    throw new EpubError('readEpub: missing META-INF/container.xml');
  }
  const rootfileMatch = /<rootfile\b([^>]*)\/?>/i.exec(containerXml);
  if (!rootfileMatch) {
    throw new EpubError('readEpub: container.xml has no <rootfile>');
  }
  const opfPath = _attrs(rootfileMatch[1])['full-path'];
  if (!opfPath) {
    throw new EpubError('readEpub: container.xml rootfile missing full-path');
  }

  // OPF lives at some prefix path; resolve manifest hrefs relative to it.
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // ── OPF: metadata, manifest, spine ──
  const opf = await readText(opfPath);
  if (!opf) throw new EpubError(`readEpub: missing OPF at ${opfPath}`);

  const metadata = {
    identifier:  _tag(opf, 'dc:identifier'),
    title:       _tag(opf, 'dc:title'),
    author:      _tag(opf, 'dc:creator'),
    lang:        _tag(opf, 'dc:language'),
    date:        _tag(opf, 'dc:date'),
    description: _tag(opf, 'dc:description'),
    publisher:   _tag(opf, 'dc:publisher'),
  };
  // Drop null fields so the round-tripped spec matches the input shape.
  for (const k of Object.keys(metadata)) {
    if (metadata[k] == null) delete metadata[k];
  }
  // dcterms:modified lives in a generic <meta property="...">
  const modMatch = /<meta\s+property\s*=\s*"dcterms:modified"[^>]*>([^<]*)<\/meta>/i.exec(opf);
  if (modMatch) metadata.modified = _decode(modMatch[1]).trim();

  // Legacy EPUB 2 cover hint: <meta name="cover" content="ID"/>
  let coverId = null;
  const cover2 = /<meta\s+name\s*=\s*"cover"\s+content\s*=\s*"([^"]+)"/i.exec(opf);
  if (cover2) coverId = cover2[1];

  // Manifest items
  const manifestRaw = _tags(opf, 'item');
  const items = manifestRaw.map((t) => ({
    id:         t.attrs.id,
    href:       t.attrs.href,
    mediaType:  t.attrs['media-type'],
    properties: t.attrs.properties || null,
  }));
  const itemsById = new Map(items.map((it) => [it.id, it]));

  // EPUB 3 cover: properties="cover-image"
  for (const it of items) {
    if (it.properties && /\bcover-image\b/.test(it.properties)) {
      coverId = it.id;
      break;
    }
  }

  // Spine
  const spineRaw = _tags(opf, 'itemref');
  const spineIds = spineRaw.map((t) => t.attrs.idref).filter(Boolean);

  // ── Chapters ──
  const chapters = [];
  for (const id of spineIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    const path = opfDir + item.href;
    const xhtml = await readText(path);
    if (!xhtml) continue;
    const title = _tag(xhtml, 'title') || id;
    const body = _stripChapterEnvelope(xhtml);
    chapters.push({ id, title, body });
  }

  // ── Cover ──
  let cover = null;
  if (coverId) {
    const item = itemsById.get(coverId);
    if (item) {
      const bytes = await read(opfDir + item.href);
      if (bytes) cover = { mime: item.mediaType, bytes };
    }
  }

  // ── Resources (everything in manifest that's not chapter / nav / ncx / styles / cover) ──
  const chapterIds = new Set(spineIds);
  const knownRoles = new Set(['nav', 'ncx', 'styles']);
  const resources = [];
  for (const it of items) {
    if (chapterIds.has(it.id)) continue;
    if (knownRoles.has(it.id)) continue;
    if (coverId && it.id === coverId) continue;
    const bytes = await read(opfDir + it.href);
    if (!bytes) continue;
    resources.push({
      path:  it.href,
      mime:  it.mediaType,
      bytes,
    });
  }

  // ── Styles (concat all linked CSS for fidelity) ──
  let styles = null;
  for (const it of items) {
    if (it.mediaType === 'text/css') {
      const text = await readText(opfDir + it.href);
      if (text) styles = (styles ? styles + '\n' : '') + text;
    }
  }

  // ── TOC: prefer nav.xhtml (EPUB 3), fall back to toc.ncx (EPUB 2) ──
  let toc = null;
  const navItem = items.find((it) => it.properties && /\bnav\b/.test(it.properties));
  if (navItem) {
    const navXml = await readText(opfDir + navItem.href);
    if (navXml) toc = _parseNavXhtml(navXml);
  }
  if (!toc) {
    const ncxItem = items.find((it) => it.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
      const ncxXml = await readText(opfDir + ncxItem.href);
      if (ncxXml) toc = _parseNcx(ncxXml);
    }
  }

  return {
    metadata,
    chapters,
    styles,
    cover,
    resources,
    toc,
  };
}

// ── TOC parsers ──

// nav.xhtml: <nav epub:type="toc"><ol><li><a href="...">Title</a><ol>...</ol></li>...</ol></nav>
function _parseNavXhtml(xml) {
  const navMatch = /<nav\b[^>]*epub:type\s*=\s*"[^"]*\btoc\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/i.exec(xml)
    || /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(xml);
  if (!navMatch) return null;
  return _parseOl(navMatch[1]);
}

function _parseOl(xml) {
  const olStart = xml.search(/<ol\b/i);
  if (olStart < 0) return [];
  const olBody = _matchPair(xml.slice(olStart), 'ol');
  if (olBody == null) return [];
  return _parseLiList(olBody);
}

// Walk a sequence of top-level <li>...</li>s. Recurses into nested
// <ol>s. Critical: use _matchPair's depth-aware match to compute how
// far each <li> extends so the cursor skips past the WHOLE <li>
// (including any nested ol+li) rather than landing on a nested </li>.
function _parseLiList(olBody) {
  const out = [];
  let cursor = 0;
  while (cursor < olBody.length) {
    const liOpen = olBody.indexOf('<li', cursor);
    if (liOpen < 0) break;
    const rest = olBody.slice(liOpen);
    const liBody = _matchPair(rest, 'li');
    if (liBody == null) break;
    // Total span of this <li>...</li> in the original olBody:
    //   <li...> (opening tag) + body + </li> (closing tag, 5 chars)
    const openTagEnd = rest.indexOf('>') + 1;
    const totalSpan = openTagEnd + liBody.length + '</li>'.length;
    cursor = liOpen + totalSpan;

    // Anchor inside this li
    const a = /<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(liBody);
    const href  = a ? _decode(a[1]) : '';
    const title = a ? _decode(a[2]).replace(/<[^>]+>/g, '').trim() : '';

    // Nested ol → children, recurse. Use _matchPair so the inner ol's
    // body is depth-aware too (handles ol > li > ol > li … chains).
    const innerOlAt = liBody.search(/<ol\b/i);
    let children = [];
    if (innerOlAt >= 0) {
      const innerBody = _matchPair(liBody.slice(innerOlAt), 'ol');
      if (innerBody != null) children = _parseLiList(innerBody);
    }
    out.push({ title, href, children });
  }
  return out;
}

// NCX: <navMap><navPoint><navLabel><text>Title</text></navLabel><content src="..."/>[nested navPoints]</navPoint></navMap>
function _parseNcx(xml) {
  const mapMatch = /<navMap\b[^>]*>([\s\S]*?)<\/navMap>/i.exec(xml);
  if (!mapMatch) return null;
  return _parseNavPoints(mapMatch[1]);
}

function _parseNavPoints(xml) {
  const out = [];
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf('<navPoint', i);
    if (open < 0) break;
    const inner = _matchPair(xml.slice(open), 'navPoint');
    if (inner == null) break;
    const titleMatch = /<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>\s*<\/navLabel>/i.exec(inner);
    const srcMatch = /<content\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(inner);
    const title = titleMatch ? _decode(titleMatch[1]).trim() : '';
    const href  = srcMatch ? _decode(srcMatch[1]) : '';
    // Recurse: strip the navLabel + content + recurse on any inner navPoints.
    const childrenStart = inner.search(/<navPoint\b/);
    const children = childrenStart >= 0
      ? _parseNavPoints(inner.slice(childrenStart))
      : [];
    out.push({ title, href, children });
    const closeIdx = xml.indexOf('</navPoint>', open);
    i = closeIdx >= 0 ? closeIdx + 11 : xml.length;
  }
  return out;
}

// Given xml starting with `<tag...>`, return everything between the
// opening tag and its MATCHING closing `</tag>`, accounting for nested
// occurrences. Returns null if unbalanced.
function _matchPair(xml, tag) {
  const openRe = new RegExp('<' + tag + '\\b[^>]*?(/?)>', 'gi');
  const closeRe = new RegExp('</' + tag + '\\s*>', 'gi');
  const first = openRe.exec(xml);
  if (!first) return null;
  // self-closing — empty body
  if (first[1] === '/') return '';
  let depth = 1;
  let i = openRe.lastIndex;
  while (depth > 0 && i < xml.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const nextOpen = openRe.exec(xml);
    const nextClose = closeRe.exec(xml);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      if (nextOpen[1] !== '/') depth++;
      i = openRe.lastIndex;
    } else {
      depth--;
      i = closeRe.lastIndex;
      if (depth === 0) {
        return xml.slice(first.index + first[0].length, nextClose.index);
      }
    }
  }
  return null;
}

// -- api.js --

// @gcu/epub — public API.
//
// Symmetric writer + reader for EPUB 3 (with EPUB 2 NCX fallback for
// Kindle / older readers). Pure JS, no DOM, runs in Node + browser.
// Depends on @gcu/archive for ZIP layer — passed by dep injection so
// the library stays decoupled and tree-shakable.
//
// Round-trip property: readEpub(writeEpub(spec, { archive }), { archive })
// returns a spec whose metadata, chapters, cover, resources, and toc
// match the input (modulo XHTML envelope stripping on chapter bodies).
export {
  writeEpub, readEpub, EpubError,
  extractDataUrlImages, splitByHeading,
  normalizeXhtml, chapterDoc,
  extractHeadings, buildTocTree,
  containerXml, contentOpf, tocNcx, navXhtml,
  DEFAULT_STYLES,
};
