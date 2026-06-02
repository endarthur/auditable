// EPUB ingest — convert a dropped/picked .epub into a reader book.
//
// The book reader reads exactly one content model: a book.json directory of
// md/html chapters (see works/surfaces/reader.html). EPUB import is the
// conversion step — @gcu/epub parses the .epub, and we write the result as a
// book.json + html chapters under /home/library/books/<slug>/, then open it.
// Images referenced by chapters are inlined as data: URLs so the rendered
// HTML is self-contained (the reader renders chapter HTML via innerHTML in a
// sandboxed iframe, which can't reach VFS-relative image paths).

import { WKS, setStatus } from './state.js';
import * as archive from '#archive';
import { readEpub } from '#epub';
import { openPath } from './surfaces.js';
import { bookDir } from './paths.js';

function slugify(s) {
  return String(s || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'book';
}

// Uint8Array → base64, chunked to stay under the apply() arg cap.
function bytesToBase64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

// Ingest .epub bytes → a /home/library/books/<slug>/ book dir. Returns the
// dir path (to openPath), or null on failure (status bar reports the reason).
export async function importEpubBytes(bytes, filename) {
  const vfs = WKS.vfs;
  let parsed;
  try { parsed = await readEpub(bytes, { archive }); }
  catch (e) { setStatus('EPUB import failed: ' + (e.message || e)); return null; }

  const meta = parsed.metadata || {};
  const baseSlug = slugify(meta.title || String(filename || 'book').replace(/\.epub$/i, ''));
  let slug = baseSlug, dir = bookDir(slug), n = 2;
  while (await vfs.exists(dir)) { slug = baseSlug + '-' + n; dir = bookDir(slug); n++; }
  await vfs.mkdir(dir + '/chapters', { recursive: true });

  // image basename → data: URL (referenced images become self-contained).
  const imgMap = new Map();
  for (const r of (parsed.resources || [])) {
    if (r && r.bytes && /^image\//.test(r.mime || '')) {
      const base = String(r.path || '').split('/').pop();
      if (base) imgMap.set(base, 'data:' + r.mime + ';base64,' + bytesToBase64(r.bytes));
    }
  }

  const chapters = [];
  let i = 0;
  for (const ch of (parsed.chapters || [])) {
    i++;
    let html = ch.body || '';
    html = html.replace(/(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi, (m, a, src, c) => {
      const base = src.split(/[?#]/)[0].split('/').pop();
      const data = imgMap.get(base);
      return data ? a + data + c : m;
    });
    const file = 'chapters/' + String(i).padStart(3, '0') + '.html';
    await vfs.writeFile(dir + '/' + file, html);
    chapters.push({ id: ch.id || ('ch' + i), title: ch.title || ('Chapter ' + i), file, format: 'html' });
  }
  if (!chapters.length) { setStatus('EPUB import: no chapters found in ' + (filename || 'file')); return null; }

  const bookJson = {
    title: meta.title || slug,
    author: meta.author || '',
    lang: meta.lang || 'en',
    slug,
    source: filename || '',
    license: meta.rights || meta.license || '',
    chapters,
  };
  await vfs.writeFile(dir + '/book.json', JSON.stringify(bookJson, null, 2));
  return dir;
}

// File → Import book… — OS file picker for a .epub, then ingest + open.
export async function importEpubViaPicker() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.epub,application/epub+zip';
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const dir = await importEpubBytes(buf, file.name);
      if (dir) { setStatus('Imported ' + file.name); await openPath(dir); }
    } catch (e) {
      setStatus('EPUB import failed: ' + (e.message || e));
    }
  });
  inp.click();
}
