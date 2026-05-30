// Builtin books — generated at boot, zero added payload.
//
// The GCU-stack documentation, presented as a single readable book. It's
// assembled from the docs already installed at /usr/share/doc/ (by
// docs-loader) — the book.json's chapters point at those files by absolute
// path (the reader's resolveInBook passes absolute paths straight through),
// so nothing is duplicated. Lives at /usr/share/books/gcu-docs/ (volatile
// /usr, repopulated each boot like the docs).
//
// This is the "prove the bundled-book pipeline" builtin. Heavy prepared books
// (ODS, MDN, textbooks) live in a separate content repo, distributed as
// content-packs — they don't belong in the auditable repo.

import { WKS } from './state.js';
import { getDocsManifest } from './docs-loader.js';

export async function installBuiltinBooks(vfs) {
  if (!vfs) return;
  const m = getDocsManifest();
  if (!m) return;

  const chapters = [];
  let n = 0;
  // mkdocs nav → /usr/share/doc/docs/<file> (same path the docs surface reads).
  const walkNav = (list) => {
    for (const item of list) {
      if (item.file) {
        n++;
        chapters.push({ id: 'd' + n, title: item.label || item.file, file: '/usr/share/doc/docs/' + item.file, format: 'md' });
      }
      if (item.children) walkNav(item.children);
    }
  };
  walkNav(m.nav || []);
  // Extension SPEC/README docs → /usr/share/doc/<ext.file>.
  for (const ext of (m.extensions || [])) {
    n++;
    chapters.push({ id: 'e' + n, title: '@gcu/' + ext.pkg + ' · ' + ext.kind, file: '/usr/share/doc/' + ext.file, format: 'md' });
  }
  if (!chapters.length) return;

  const book = {
    title: 'GCU Stack — Documentation',
    author: 'Geoscientific Chaos Union',
    slug: 'gcu-docs',
    source: '/usr/share/doc',
    chapters,
  };
  await vfs.mkdir('/usr/share/books/gcu-docs', { recursive: true }).catch(() => {});
  await vfs.writeFile('/usr/share/books/gcu-docs/book.json', JSON.stringify(book, null, 2));
}
