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
export function normalizeXhtml(html) {
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
export function chapterDoc({ title, body, cssHref, lang }) {
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
export function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}
