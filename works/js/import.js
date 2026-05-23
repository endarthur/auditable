// Import a notebook file as a project — auditable-works-spec §12.4.
//
// Three forms are accepted:
//   .txt  — the `///` source form (an exportAsTxt() file, or a project's
//           own notebook.txt). It *is* notebook.txt — dropped in verbatim.
//   .html, AUDITABLE-VFS block — a current standalone notebook. The block
//           is a { path → entry } dump over /projects/self + /lib; the
//           project half is rebased onto a fresh project directory, /lib
//           stays shared.
//   .html, legacy AUDITABLE-DATA/MODULES/SETTINGS blocks — an older
//           standalone notebook (every examples/ file is one of these).
//           Cells+settings → notebook.txt, modules → the /lib store,
//           notebook.fs files → data siblings.
//
// Encrypted / packed notebooks are refused — they must be opened in
// auditable and re-saved first.
//
// Import is shell-side and document-aware on purpose: it is a notebook
// operation. It reuses the notebook's own pure serializer (#serialize) and
// persist.js's hydrateWorkspace — the AUDITABLE-VFS dump shape is identical
// to the WORKS-VFS dump shape.

import { WKS, setStatus } from './state.js';
import { hydrateWorkspace } from './persist.js';
import { openPath } from './surfaces.js';
import { parseNotebookHtml, serializeNotebookTxt } from '#serialize';

const SELF = '/projects/self';
const rid = () => Math.random().toString(36).slice(2, 10);
const sanitize = (s) => String(s).trim().replace(/[/\\]+/g, '-') || 'notebook';

// A free /projects/<name> path — appends -2, -3, … on collision.
async function uniqueProjectPath(name) {
  const base = '/projects/' + sanitize(name);
  if (!(await WKS.vfs.exists(base))) return base;
  for (let n = 2; ; n++) {
    const p = base + '-' + n;
    if (!(await WKS.vfs.exists(p))) return p;
  }
}

// Write the project.json marker. Import always mints a fresh id — an
// imported notebook is a new project, with its own identity.
async function writeMarker(projPath, title) {
  await WKS.vfs.mkdir(projPath, { recursive: true });
  await WKS.vfs.writeFile(projPath + '/project.json',
    JSON.stringify({ kind: 'notebook', id: 'p-' + rid(), title }, null, 2));
}

// The real notebook title from <title>, dropping the "Auditable — " prefix.
function htmlTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  if (!m) return '';
  const t = m[1].replace(/^Auditable\s*—\s*/, '').trim();
  return (t && t !== 'untitled' && t !== 'Encrypted') ? t : '';
}

// Write installed modules into the shared /lib store — the layout
// hydrateModulesFromVfs reads (mirrors persist.js's syncModulesToVfs).
async function writeModulesToLib(modules) {
  if (!modules) return;
  for (const [url, entry] of Object.entries(modules)) {
    const dir = '/lib/' + encodeURIComponent(url);
    await WKS.vfs.mkdir(dir, { recursive: true });
    if (typeof entry === 'string') {
      await WKS.vfs.writeFile(dir + '/source', entry);
      await WKS.vfs.writeFile(dir + '/meta.json', JSON.stringify({ legacy: true }));
    } else if (entry && typeof entry === 'object') {
      const { source, ...meta } = entry;
      await WKS.vfs.writeFile(dir + '/meta.json', JSON.stringify(meta));
      if (typeof source === 'string') await WKS.vfs.writeFile(dir + '/source', source);
    }
  }
}

// .txt — the source form is notebook.txt. Title from the `/// title:` line.
async function importTxt(content, fallbackName) {
  const tm = content.match(/^\/\/\/ title:\s*(.+)$/m);
  const title = (tm && tm[1].trim()) || fallbackName;
  const projPath = await uniqueProjectPath(title);
  await writeMarker(projPath, title);
  await WKS.vfs.writeFile(projPath + '/notebook.txt', content);
  return projPath;
}

// .html with an AUDITABLE-VFS block — rebase the dump's /projects/self half
// onto the new project; /lib stays shared.
async function importVfsHtml(html, fallbackName) {
  const m = html.match(/<!--AUDITABLE-VFS\n([\s\S]*?)\nAUDITABLE-VFS-->/);
  let dump;
  try { dump = JSON.parse(m[1]); }
  catch { throw new Error('the notebook data block is corrupt'); }
  const title = htmlTitle(html) || fallbackName;
  const projPath = await uniqueProjectPath(title);
  const rebased = {};
  for (const [p, entry] of Object.entries(dump)) {
    if (p === SELF + '/' || p.startsWith(SELF + '/'))
      rebased[projPath + p.slice(SELF.length)] = entry;
    else if (p === '/lib/' || p.startsWith('/lib/'))
      rebased[p] = entry;
    // anything else in the dump is unexpected — drop it silently.
  }
  await hydrateWorkspace(WKS.vfs, rebased);
  await writeMarker(projPath, title);   // the dump carries no project.json
  return projPath;
}

// .html with the legacy AUDITABLE-DATA/MODULES/SETTINGS blocks — convert to
// a project directory. parseNotebookHtml owns the legacy parsing.
async function importLegacyHtml(html, fallbackName) {
  const { cells, settings, modules, fs, title } = parseNotebookHtml(html);
  const t = (title && title !== 'untitled' && title.trim()) || fallbackName;
  const projPath = await uniqueProjectPath(t);

  // Cells + settings → notebook.txt (the /// form). Module URLs are recorded
  // as declarations; their source goes to /lib below.
  const moduleDecls = Object.keys(modules || {}).map((url) => ({ url }));
  const txt = serializeNotebookTxt({
    title: t, settings: settings || null, cells: cells || [], modules: moduleDecls });
  await WKS.vfs.mkdir(projPath, { recursive: true });
  await WKS.vfs.writeFile(projPath + '/notebook.txt', txt);
  await writeMarker(projPath, t);
  await writeModulesToLib(modules);

  // Legacy notebook.fs files → data siblings. Rare — examples carry none,
  // and the current format folds files into the AUDITABLE-VFS dump — so
  // this is a best-effort pass on the value shape.
  if (fs && typeof fs === 'object') {
    for (const [relPath, value] of Object.entries(fs)) {
      const dest = projPath + '/' + String(relPath).replace(/^\/+/, '');
      const body = typeof value === 'string' ? value
        : (value && typeof value === 'object'
            ? (value.content != null ? value.content : value.data) : null);
      if (body == null) { console.warn('[works] import: skipped fs entry', relPath); continue; }
      const parent = dest.split('/').slice(0, -1).join('/');
      await WKS.vfs.mkdir(parent, { recursive: true }).catch(() => {});
      await WKS.vfs.writeFile(dest, body);
    }
  }
  return projPath;
}

// .html — route by the data block present.
async function importHtml(html, fallbackName) {
  if (/<!--AUDITABLE-VFS\n/.test(html)) return importVfsHtml(html, fallbackName);
  if (/<!--AUDITABLE-CRYPTO\n/.test(html))
    throw new Error('that notebook is encrypted — unlock and re-save it in auditable, then import');
  if (/name="auditable-packed"/.test(html))
    throw new Error('that notebook is a packed save — open it in auditable and re-save it unpacked, then import');
  if (/<!--AUDITABLE-DATA\n/.test(html)) return importLegacyHtml(html, fallbackName);
  throw new Error('no notebook data found — is this an auditable notebook?');
}

/**
 * Import notebook `content` as a new project under /projects/. `filename`
 * selects the format (.txt vs .html) and supplies a fallback title.
 * Returns the new project path. Throws on an unrecognised / unusable file.
 */
export async function importNotebook(content, filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  const fallbackName = (dot >= 0 ? filename.slice(0, dot) : filename) || 'notebook';
  if (ext === '.txt') return importTxt(content, fallbackName);
  if (ext === '.html' || ext === '.htm') return importHtml(content, fallbackName);
  throw new Error('unsupported file type "' + (ext || filename) + '" — expected .txt or .html');
}

/**
 * Right-click → Import as notebook: read an existing VFS file (e.g. an .html
 * in a mounted folder) and import it as a project, then open it.
 */
export async function importFileAsNotebook(path) {
  try {
    const last = path.split('/').filter(Boolean).pop() || 'notebook';
    const content = await WKS.vfs.readFile(path, 'utf8');
    const projPath = await importNotebook(content, last);
    setStatus('imported ' + last);
    await openPath(projPath);
    return projPath;
  } catch (e) {
    console.error('[works] import failed:', e);
    setStatus('import failed: ' + (e.message || e));
    return null;
  }
}

/** File → Import notebook… — pick a file, import it, open it as a surface. */
export function importNotebookViaPicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.html,.htm,text/plain,text/html';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const projPath = await importNotebook(await file.text(), file.name);
      setStatus('imported ' + file.name);
      await openPath(projPath);
    } catch (e) {
      console.error('[works] import failed:', e);
      setStatus('import failed: ' + (e.message || e));
    }
  };
  input.click();
}
