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
// downloads a single .html. Works: a VFS whose own project is a local
// working copy and the rest is an A-Bus proxy onto the shared workspace,
// and a save that flushes the copy back to that workspace.

import { VFS, CommentBackend, MemoryBackend, AbusBackend, FSAABackend, IDBBackend, path } from './vfs.js';
import * as hooks from './hooks.js';

let _host = null;

/** Install the active Host. Called once, early in init(). */
export function setHost(h) { _host = h; }

/** The active Host. */
export function getHost() { return _host; }

// A CommentBackend for the notebook's own project. Its _map is the live
// window._notebookFS (so fs.js's direct Map access works) and writes pulse
// the hook bus. Shared by both Hosts as the /projects/self backend — its
// root == the project root keeps backend keys notebook-relative.
function _makeProjectBackend() {
  const backend = new CommentBackend({});
  // Always read from the current _notebookFS Map (survives reassignment in
  // init/crypto).
  Object.defineProperty(backend, '_map', {
    get: () => {
      if (!window._notebookFS) window._notebookFS = new Map();
      return window._notebookFS;
    },
    configurable: true,
  });
  backend._syncComment = () => {
    hooks.emit('notebook:dirty');
    hooks.emit('fs:changed');
  };
  return backend;
}

// VFS native events → fs:changed bus emission; subscribers debounce.
function _wireVfsEvents(vfs) {
  vfs.on('write', () => hooks.emit('fs:changed'));
  vfs.on('delete', () => hooks.emit('fs:changed'));
  vfs.on('rename', () => hooks.emit('fs:changed'));
}

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
    // Self-contained VFS. /projects/self is the notebook's own project,
    // /lib holds installed modules, /tmp + /usr/lib/python are volatile.
    // Synchronous: nothing here awaits, so window._notebookVFS is ready the
    // instant the call returns.
    provideVFS() {
      const vfs = new VFS();
      vfs._mounts.set('/projects/self', _makeProjectBackend());
      vfs._mounts.set('/lib', new MemoryBackend());
      vfs._mounts.set('/tmp', new MemoryBackend());
      vfs._mounts.set('/usr/lib/python', new MemoryBackend());
      _wireVfsEvents(vfs);
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

/**
 * The Works Host. The notebook runs as a Works surface: its own project is a
 * local working copy (so notebook.fs stays synchronous), boot-loaded from the
 * shared workspace and flushed back; everything else is reached live through
 * an A-Bus proxy onto that workspace.
 *
 * @param {object} deps
 * @param {object} deps.bus         - the connected A-Bus client (has .call()).
 * @param {string} deps.projectPath - this notebook's project path in the
 *   shared workspace (the surface's tab.path).
 * @param {() => Promise<void>} deps.syncToVfs - writes current notebook state
 *   (cells, settings, modules) into the VFS. Injected to keep host.js free of
 *   a persist.js/state.js import web.
 * @param {object} [deps.home] - the workspace storage-home descriptor; a
 *   delegatable home (fsaa/idb) is mounted directly, else / is the relay proxy.
 */
export function createWorksHost({ bus, projectPath, syncToVfs, home }) {
  // The `/` mount: a direct backend when the workspace home is delegatable —
  // a disk folder, or an IndexedDB store a same-origin surface can open
  // itself — else the A-Bus relay proxy.
  function rootDescriptor() {
    if (home && home.kind === 'fsaa') return { kind: 'handle', mount: '/', handle: home.handle };
    if (home && home.kind === 'idb')  return { kind: 'idb',    mount: '/', name: home.name };
    return { kind: 'proxy', mount: '/', root: '' };
  }

  // The surface VFS mount descriptors. /projects/self is always the local
  // working copy (so notebook.fs stays synchronous); the / mount is direct
  // or relayed per the home.
  function descriptors() {
    return [
      { kind: 'local-copy', mount: '/projects/self', source: projectPath },
      rootDescriptor(),
      { kind: 'memory', mount: '/tmp' },
      { kind: 'memory', mount: '/usr/lib/python' },
    ];
  }

  // Delegated direct-I/O backends can fail to open in the surface even when
  // the same backend works in the shell — most commonly, Chrome blocks
  // IndexedDB inside a blob:file:// iframe even though file:// itself can use
  // it, so a file://-opened works.html with an IDB home cannot delegate to
  // the notebook surface. Fall back to the A-Bus relay proxy on any
  // init failure; correctness wins over the delegation speed-up.
  function _proxyFallback() {
    return new AbusBackend({ bus, service: 'works', root: '' });
  }

  async function backendFor(d) {
    switch (d.kind) {
      case 'local-copy': return _makeProjectBackend();
      case 'proxy':      return new AbusBackend({ bus, service: 'works', root: d.root || '' });
      case 'memory':     return new MemoryBackend();
      case 'handle': {   // a delegated FSAA disk folder — direct I/O, no relay
        try {
          const b = new FSAABackend({ handle: d.handle });
          await b.init();
          return b;
        } catch (e) {
          console.warn('[host] FSAA delegation failed; routing via A-Bus proxy:', e.message);
          return _proxyFallback();
        }
      }
      case 'idb': {      // a delegated IndexedDB store — direct I/O, no relay
        try {
          const b = new IDBBackend({ name: d.name });
          await b.init();
          return b;
        } catch (e) {
          console.warn('[host] IDB delegation failed; routing via A-Bus proxy:', e.message);
          return _proxyFallback();
        }
      }
      default: throw new Error('Works Host: unimplemented mount kind "' + d.kind + '"');
    }
  }

  // Boot-load / write-back copy between the /projects/self local copy and the
  // workspace project (reached via the / mount) — going through the surface
  // VFS, so they are transparent to whether / is a relay proxy or a direct
  // delegated mount. Write-back is write-all; orphan pruning is a follow-up.
  async function bootLoad(vfs, remoteBase, localBase) {
    let names;
    try { names = await vfs.readdir(remoteBase); }
    catch { return; }   // not created yet — a fresh project
    for (const name of names) {
      const r = remoteBase + '/' + name;
      const l = localBase + '/' + name;
      const st = await vfs.stat(r);
      if (st && st.type === 'directory') {
        await vfs.mkdir(l, { recursive: true }).catch(() => {});
        await bootLoad(vfs, r, l);
      } else {
        await vfs.writeFile(l, await vfs.readFile(r, 'bytes'));
      }
    }
  }

  async function writeBack(vfs, localBase, remoteBase) {
    await vfs.mkdir(remoteBase, { recursive: true }).catch(() => {});
    const entries = await vfs.readdir(localBase, { stat: true });
    for (const e of entries) {
      const l = localBase + '/' + e.name;
      const r = remoteBase + '/' + e.name;
      if (e.type === 'directory') {
        await writeBack(vfs, l, r);
      } else {
        await vfs.writeFile(r, await vfs.readFile(l, 'bytes'));
      }
    }
  }

  return {
    // Build the surface VFS from the mount descriptors, then boot-load every
    // local-copy mount from the workspace. Async — the boot-load awaits the
    // A-Bus reads — so callers await provideVFS() before reading the VFS.
    async provideVFS() {
      const vfs = new VFS();
      const ds = descriptors();
      for (const d of ds) vfs._mounts.set(d.mount, await backendFor(d));
      _wireVfsEvents(vfs);
      window._notebookVFS = vfs;
      window._vfsPath = path;
      for (const d of ds) {
        if (d.kind === 'local-copy') await bootLoad(vfs, d.source, d.mount);
      }
      return vfs;
    },

    // Works save: flush notebook state into the local copy, then write that
    // copy back to the shared workspace. Also serves Surface.Flush() and the
    // self-flush cadence.
    async persist() {
      await syncToVfs();
      await writeBack(window._notebookVFS, '/projects/self', projectPath);
      return 'saved';
    },

    // The shell moved/renamed this project (Surface.Relocated) — future
    // write-backs target the new path.
    relocate(newPath) { projectPath = newPath; },
  };
}
