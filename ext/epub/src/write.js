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

import { normalizeXhtml, chapterDoc, escAttr } from './xhtml.js';
import { extractHeadings, buildTocTree } from './toc.js';
import {
  containerXml, contentOpf, tocNcx, navXhtml, DEFAULT_STYLES,
} from './manifest.js';

export class EpubError extends Error {
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
export function _resolveCreateWriter(archive) {
  if (typeof archive?.createWriter === 'function') return archive.createWriter;
  if (typeof archive?.archive?.createWriter === 'function') return archive.archive.createWriter;
  return null;
}

export async function writeEpub(spec) {
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
