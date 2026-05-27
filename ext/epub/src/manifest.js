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

import { escAttr } from './xhtml.js';

// ── container.xml ────────────────────────────────────────────────
//
// The exact path is `META-INF/container.xml`. Tells the reader where
// the OPF is. Always the same shape; we only need it once per book.
export function containerXml() {
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
export function contentOpf({ metadata, manifestItems, spineIds, ncxId }) {
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
export function tocNcx({ identifier, title, tree }) {
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
export function navXhtml({ title, tree }) {
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
export const DEFAULT_STYLES = `body { font-family: serif; line-height: 1.55; }
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
