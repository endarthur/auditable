// Pack a /projects/<name> directory into a standalone auditable .html —
// the inverse of works/js/import.js (which unpacks one into a project).
// The exported file is a working standalone notebook: the notebook surface
// runtime + an AUDITABLE-VFS dump of the project (+ /lib for its modules).
//
// The runtime comes from the notebook surface payload embedded in
// works.html — decompressed to a blob URL by surface-registry, fetched here
// and patched with the dump block + the project's title.

import { WKS, setStatus } from './state.js';
import { serializeVfs, esc, parseNotebookTxt } from '#serialize';
import { exportNotebook as exportIpynb } from '#ipynb';
import { surfaceUrl } from './surface-registry.js';

const SELF = '/projects/self';

const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const safeFilename = (s) => String(s).replace(/[^a-zA-Z0-9_\- ]+/g, '_').trim() || 'notebook';

async function _readProjectTitle(projPath) {
  try {
    const meta = JSON.parse(await WKS.vfs.readFile(projPath + '/project.json', 'utf8'));
    if (meta.title) return meta.title;
  } catch { /* no marker — fall through */ }
  return basename(projPath);
}

// Re-key the project half of a VFS dump (/projects/<name>/* → /projects/self/*)
// so the standalone runtime can rehydrate it like its own self-save.
function _rebaseOntoSelf(dump, projPath) {
  const out = {};
  for (const [k, v] of Object.entries(dump)) {
    if (k === projPath + '/' || k.startsWith(projPath + '/'))
      out[SELF + k.slice(projPath.length)] = v;
    else
      out[k] = v;
  }
  return out;
}

/**
 * Build the standalone .html for a project. Pure-ish: no download side
 * effect — returns the HTML string so it can also be unit-tested + round-
 * tripped through importNotebook.
 */
export async function buildProjectExportHtml(projPath) {
  const title = await _readProjectTitle(projPath);

  // Dump the project + shared /lib (modules). /lib is workspace-wide; the
  // exported notebook only sees the modules it actually uses lazily, but
  // including all of /lib mirrors a normal standalone save's behaviour.
  const raw = await serializeVfs(WKS.vfs, [projPath, '/lib']);
  const dump = _rebaseOntoSelf(raw, projPath);

  // Fetch the embedded notebook runtime (decompressed at boot to a blob URL).
  const runtime = await fetch(surfaceUrl('notebook')).then((r) => r.text());

  const block = '<!-- auditable notebook data: VFS dump (persistent mounts only) -->\n'
    + '<!--AUDITABLE-VFS\n' + JSON.stringify(dump) + '\nAUDITABLE-VFS-->';

  // Patch <title>, the docTitle input value, and inject the data block.
  return runtime
    .replace('<title>Auditable</title>', '<title>Auditable — ' + esc(title) + '</title>')
    .replace('id="docTitle" value="untitled"',
             'id="docTitle" value="' + esc(title) + '"')
    .replace('<script>', block + '\n<script>');
}

/** Right-click → Export as notebook…: build + trigger a download. */
export async function exportProject(projPath) {
  try {
    const html = await buildProjectExportHtml(projPath);
    const title = await _readProjectTitle(projPath);
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeFilename(title) + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('exported ' + a.download);
  } catch (e) {
    console.error('[works] export failed:', e);
    setStatus('export failed: ' + (e.message || e));
  }
}

/** Right-click → Export as .ipynb: project's notebook.txt → Jupyter file.
 *  @gcu/ipynb runs the inverse substitution (natra → numpy, sadpan →
 *  pandas, etc.) so the .ipynb opens cleanly in Jupyter. */
export async function exportProjectAsIpynb(projPath) {
  try {
    const title = await _readProjectTitle(projPath);
    let txt;
    try { txt = await WKS.vfs.readFile(projPath + '/notebook.txt', 'utf8'); }
    catch { throw new Error('this project has no notebook.txt'); }
    const parsed = parseNotebookTxt(txt);
    const ipynbJson = exportIpynb(parsed.cells || []);
    const blob = new Blob([ipynbJson], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeFilename(title) + '.ipynb';
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('exported ' + a.download);
  } catch (e) {
    console.error('[works] ipynb export failed:', e);
    setStatus('ipynb export failed: ' + (e.message || e));
  }
}

