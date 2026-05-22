// ── THE HOST SEAM ──
// The Host isolates the one difference between a standalone notebook and a
// notebook running as an Auditable Works surface, so the notebook core —
// cells, DAG, execution, notebook.fs — never branches on environment. Per
// the Auditable Works spec §13, a Host has two methods:
//
//   provideVFS()  — build + install the notebook's VFS
//   persist()     — save the notebook
//
// Standalone: a self-contained VFS (workspace-of-one) and a save that
// downloads a single .html. Works (Chunk 4c): a VFS whose /projects/self
// backend is an A-Bus proxy onto the shared workspace, and a save that
// flushes through to that workspace. This module ships the standalone Host;
// the Works Host lands with the surface adapter in 4c.

import { VFS, CommentBackend, MemoryBackend, path } from './vfs.js';
import * as hooks from './hooks.js';

let _host = null;

/** Install the active Host. Called once, early in init(). */
export function setHost(h) { _host = h; }

/** The active Host. */
export function getHost() { return _host; }

// Download an HTML string to disk as <title>.html.
function _downloadHtml(html, title) {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.html';
  a.click();
  URL.revokeObjectURL(url);
  return a.download;
}

/**
 * The standalone Host. The notebook is a workspace-of-one: its project lives
 * at the CommentBackend mounted on /projects/self, and a save serialises the
 * whole thing to one downloadable .html.
 *
 * @param {object} deps
 * @param {() => Promise<string>} deps.buildHtml - serialises the notebook to
 *   a self-contained HTML string (save.js buildNotebookHtml). Injected to
 *   keep host.js free of a save.js import cycle.
 */
export function createStandaloneHost({ buildHtml }) {
  return {
    // Self-contained VFS. /projects/self holds the notebook's own project
    // (project.json + notebook.txt + readable data siblings) on a
    // CommentBackend — its root == the project root, so backend keys stay
    // notebook-relative, which fs.js's window._notebookFS access relies on.
    // /lib holds installed modules; /tmp + /usr/lib/python are volatile.
    // Synchronous: nothing here awaits, so window._notebookVFS is ready the
    // instant the call returns.
    provideVFS() {
      const vfs = new VFS();
      const commentBackend = new CommentBackend({});
      // Always read from the current _notebookFS Map (survives reassignment
      // in init/crypto).
      Object.defineProperty(commentBackend, '_map', {
        get: () => {
          if (!window._notebookFS) window._notebookFS = new Map();
          return window._notebookFS;
        },
        configurable: true,
      });
      commentBackend._syncComment = () => {
        hooks.emit('notebook:dirty');
        hooks.emit('fs:changed');
      };
      vfs._mounts.set('/projects/self', commentBackend);
      vfs._mounts.set('/lib', new MemoryBackend());
      vfs._mounts.set('/tmp', new MemoryBackend());
      vfs._mounts.set('/usr/lib/python', new MemoryBackend());
      // VFS native events → fs:changed bus emission; subscribers debounce.
      vfs.on('write', () => hooks.emit('fs:changed'));
      vfs.on('delete', () => hooks.emit('fs:changed'));
      vfs.on('rename', () => hooks.emit('fs:changed'));
      window._notebookVFS = vfs;
      window._vfsPath = path;
      return vfs;
    },

    // Standalone save: serialise to one .html and download it.
    async persist() {
      const html = await buildHtml();
      const title = document.getElementById('docTitle')?.value || 'untitled';
      return 'saved ' + _downloadHtml(html, title);
    },
  };
}
