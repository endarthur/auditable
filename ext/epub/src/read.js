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

import { EpubError } from './write.js';

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

export async function readEpub(bytes, opts = {}) {
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
