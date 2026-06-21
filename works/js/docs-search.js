// Shell-side documentation search — so an agent (and future in-shell consumers)
// can FIND the right doc, not just read one it already knows the path of. The
// docs are embedded as VFS files at /usr/share/doc (works + works-all, not
// works-core); this builds a @gcu/librarian index over them, reusing the same
// librarian + @gcu/docview section-splitter the docs surface uses — loaded from
// /usr/lib via ensureLibSource (no shell-bundle weight; naturally build-aware:
// works-core has neither the libs nor the docs, so the index never builds and
// Search reports unavailable). Read-only. Lazy: the index builds on first search.

import { WKS } from './state.js';
import { ensureLibSource } from './surface-registry.js';

let _index = null;       // built librarian index
let _Librarian = null;   // the librarian module (for search/suggest)
let _state = 'idle';     // 'idle' | 'ready' | 'unavailable'
let _building = null;    // in-flight build promise (dedupes concurrent first calls)

function _blobImport(src) {
  return import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}

// Minimal anchor slugify — markdown's is fancier, but an approximate anchor is
// fine for agent search (the agent reads the file by path; the anchor is a hint).
function _slugify(s) {
  return String(s).toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
}

async function _build() {
  if (!WKS.vfs) return false;
  let manifest;
  try { manifest = JSON.parse(await WKS.vfs.readFile('/usr/share/doc/manifest.json', 'utf8')); }
  catch { return false; }   // no docs in this build (works-core)
  const libSrc = await ensureLibSource('librarian', WKS.vfs);
  const dvSrc = await ensureLibSource('docview', WKS.vfs);
  if (!libSrc || !dvSrc) return false;   // libs not carried (works-core)
  const { Librarian } = await _blobImport(libSrc);
  const { buildSearchIndex } = await _blobImport(dvSrc);

  const read = async (rel) => {
    try { return await WKS.vfs.readFile('/usr/share/doc/' + rel, 'utf8'); } catch { return ''; }
  };
  // Collect nav docs + extension SPEC/README entries — mirrors docs.html's
  // buildDocsIndex (one source of truth for the doc corpus shape).
  const navFiles = [];
  (function walk(list) {
    for (const it of (list || [])) { if (it.file) navFiles.push('docs/' + it.file); if (it.children) walk(it.children); }
  })(manifest.nav);
  const navLabel = (file) => {
    let label = null;
    (function w(list) {
      for (const it of (list || [])) {
        if (it.file && 'docs/' + it.file === file) { label = it.label; return; }
        if (it.children) w(it.children);
      }
    })(manifest.nav);
    return label || file.split('/').pop().replace(/\.md$/, '');
  };
  const collected = [];
  for (const f of navFiles) { const md = await read(f); if (md) collected.push({ path: f, title: navLabel(f), md }); }
  for (const ext of (manifest.extensions || [])) {
    const md = await read(ext.file);
    if (md) collected.push({ path: ext.file, title: '@gcu/' + ext.pkg + ' ' + ext.kind, md });
  }

  _index = buildSearchIndex(Librarian, collected, _slugify, {
    synonyms: { vfs: ['filesystem'], dag: ['reactivity', 'reactive'], cell: ['block', 'cells'], mcp: ['agent', 'model-context'] },
  });
  _Librarian = Librarian;
  return true;
}

async function ensureIndex() {
  if (_state === 'ready') return true;
  if (_state === 'unavailable') return false;
  if (!_building) {
    _building = _build()
      .then((ok) => { _state = ok ? 'ready' : 'unavailable'; return ok; })
      .catch((e) => { console.warn('[works] docs index build failed:', e); _state = 'unavailable'; return false; });
  }
  return _building;
}

// Search the embedded docs. Returns { available, hits[] } — hits carry the full
// VFS path (so the agent can worksReadFile it directly), the doc + section title,
// an anchor hint, score, and a snippet when the index has one.
export async function searchDocs(query, limit = 12) {
  if (!(await ensureIndex())) return { available: false, hits: [] };
  let hits = [];
  try { hits = _Librarian.search(_index, String(query || ''), { fuzzy: 1, limit }) || []; }
  catch { hits = []; }
  return {
    available: true,
    hits: hits.map((h) => {
      const d = h.doc || {};
      return {
        path: d.file ? '/usr/share/doc/' + d.file : null,
        title: d.fileTitle || d.title || '',
        section: d.title || '',
        anchor: d.anchor || null,
        score: h.score,
        snippet: h.snippet || d.snippet || '',
      };
    }).filter((h) => h.path),
  };
}

export async function suggestDocs(query) {
  if (!(await ensureIndex())) return [];
  try { return _Librarian.suggest(_index, String(query || '')) || []; } catch { return []; }
}

// Browse the embedded examples (works-all only) — flattened from the manifest's
// per-category lists. Each carries its full VFS path so the agent can openPath it.
export async function listExamples() {
  if (!WKS.vfs) return { available: false, examples: [] };
  let manifest;
  try { manifest = JSON.parse(await WKS.vfs.readFile('/usr/share/examples/manifest.json', 'utf8')); }
  catch { return { available: false, examples: [] }; }
  const cats = (manifest && manifest.categories) || {};
  const examples = [];
  for (const [category, entries] of Object.entries(cats)) {
    for (const e of (entries || [])) {
      examples.push({
        category,
        title: e.title || e.file,
        description: e.description || '',
        path: '/usr/share/examples/' + e.file,
      });
    }
  }
  return { available: true, examples };
}
