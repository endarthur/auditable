// The `works` A-Bus service — the shell's own bus peer. It exposes the
// workspace VFS and shell operations to every surface and claims the
// well-known name `works`, so a surface just calls `to: 'works'`.

import { connect } from '#abus';
import { WKS } from './state.js';
import { openPath } from './surfaces.js';
import { mountFolder, unmountAt } from './mount.js';
import { applyWorkspaceSettings, readSettings, writeSettings } from './settings-store.js';
import { evaluateWorksScript } from './extension-loader.js';
import { showAbout } from './about.js';
import { aggregateFromBuildLicenses } from '#licenses';
import { archive } from '#archive';
import { Dialog } from '#dialog';
import { metaGet, metaSet } from './meta.js';
import { getSources, addSourceSilent, removeSource, fetchRegistry, installByName, entryStatuses, checkUpdates } from './registry.js';
import { bookDir, dataDir } from './paths.js';

// Build-time-injected vendored license manifest (see build.js's
// injectBuildLicenses). Source-level empty so dev/test runs work; build
// rewrites this single line to the real manifest. Shape:
//   { <name>: { spdx, version, homepage, description, text } }
const __BUILD_LICENSES__ = {};

// Install the build-time vendored license inventory at /sys/licenses/. Mirrors
// installSharedLibsToVfs's pattern (memory mount, written at boot). Geas's
// `licenses` builtin and `cat /sys/licenses/<name>/LICENSE` both read from
// here; aggregateLicenses(vfs) also picks it up. Per-name dir + LICENSE text;
// index.json at root for quick metadata lookup.
export async function installLicensesToVfs(vfs) {
  const base = '/sys/licenses';
  try { await vfs.mkdir(base, { recursive: true }); } catch {}
  const index = {};
  for (const [name, entry] of Object.entries(__BUILD_LICENSES__ || {})) {
    if (!entry || typeof entry !== 'object') continue;
    index[name] = {
      spdx: entry.spdx || 'UNKNOWN',
      version: entry.version || null,
      homepage: entry.homepage || null,
      description: entry.description || null,
    };
    const dir = `${base}/${name}`;
    try { await vfs.mkdir(dir, { recursive: true }); } catch {}
    if (typeof entry.text === 'string' && entry.text.length > 0) {
      try { await vfs.writeFile(`${dir}/LICENSE`, entry.text); } catch {}
    }
  }
  try { await vfs.writeFile(`${base}/index.json`, JSON.stringify(index, null, 2)); } catch {}
}

export async function setupWorksService() {
  const ch = new MessageChannel();
  WKS.broker.connect(ch.port1);
  const bus = await connect(ch.port2, { client: 'works-shell' });
  WKS.worksBus = bus;

  const vfs = WKS.vfs;
  await installLicensesToVfs(vfs);

  // ── Notebook ↔ A-Bus access (spec_inbox/notebook-abus-access-spec.md) ──
  // Hygiene, not a sandbox: a notebook cell can already touch the VFS via
  // notebook.fs, so this is about making bus capability *visible and
  // deliberate*, mirroring the %mcp model — not containing a hostile notebook.

  // Tier 2: interfaces a surface has declared notebook-scriptable. A notebook's
  // `notebook.call` is allowed against these without any prompt; everything
  // else needs the raw, consented bus (tier 3). well-known name → Set<iface>.
  const _notebookPublic = new Map();

  // Tier 3: raw-bus consent. "Allow once" lives only in this session set;
  // "always this notebook" persists by project path in shell meta IDB;
  // "always this workspace" persists as abusWorkspace in /etc/works.json.
  const _busSession = new Set();

  async function busAccessGranted(id) {
    if (_busSession.has(id)) return true;
    try { const g = await metaGet('abus.grants'); if (g && g[id] === true) return true; } catch {}
    try { const s = await readSettings(vfs); if (s && s.abusWorkspace === true) return true; } catch {}
    return false;
  }

  function busConsentDialog(title, declared) {
    return new Dialog({
      title: 'Workspace A-Bus access',
      width: 460,
      render: (body, ctx) => {
        const p = document.createElement('p');
        p.style.cssText = 'margin:0 0 12px;line-height:1.55;font-size:13px';
        const strong = document.createElement('strong');
        strong.textContent = title || 'This notebook';
        p.appendChild(strong);
        p.appendChild(document.createTextNode(
          ' wants direct workspace-bus access — it could call any surface or ' +
          'service (including the workspace filesystem) and publish or subscribe ' +
          'to any topic.'));
        body.appendChild(p);
        if (declared) {
          const d = document.createElement('p');
          d.style.cssText = 'margin:0 0 12px;font-size:12px;opacity:.7';
          d.textContent = 'The notebook declares this with a // %abus directive.';
          body.appendChild(d);
        }
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:6px';
        const mk = (label, val, primary) => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = label;
          b.style.cssText =
            'padding:6px 12px;border-radius:6px;border:1px solid var(--sw-line,#3a3a3a);' +
            'background:' + (primary ? 'var(--au-action,#d2691e)' : 'transparent') + ';' +
            'color:' + (primary ? '#fff' : 'inherit') + ';cursor:pointer;font:inherit;font-size:12px';
          b.onclick = () => ctx.close(val);
          row.appendChild(b);
        };
        mk('Deny', 'deny');
        mk('Allow once', 'once');
        mk('Always this notebook', 'notebook');
        mk('Always this workspace', 'workspace', true);
        body.appendChild(row);
      },
    }).show();
  }

  async function requestBusAccess(title, id, declared) {
    id = id || title || 'unknown-notebook';
    if (await busAccessGranted(id)) return true;
    const choice = await busConsentDialog(title || 'This notebook', !!declared);
    if (choice === 'once') { _busSession.add(id); return true; }
    if (choice === 'notebook') {
      _busSession.add(id);
      try { const g = (await metaGet('abus.grants')) || {}; g[id] = true; await metaSet('abus.grants', g); } catch {}
      return true;
    }
    if (choice === 'workspace') {
      try { const s = await readSettings(vfs); await writeSettings(vfs, { ...s, abusWorkspace: true }); } catch {}
      return true;
    }
    return false;   // deny / dismissed
  }

  async function revokeBusAccess(id) {
    if (id) {
      _busSession.delete(id);
      try { const g = (await metaGet('abus.grants')) || {}; delete g[id]; await metaSet('abus.grants', g); } catch {}
      return true;
    }
    _busSession.clear();
    try { await metaSet('abus.grants', {}); } catch {}
    try { const s = await readSettings(vfs); await writeSettings(vfs, { ...s, abusWorkspace: false }); } catch {}
    return true;
  }

  async function listBusGrants() {
    let grants = {}; try { grants = (await metaGet('abus.grants')) || {}; } catch {}
    let workspace = false; try { const s = await readSettings(vfs); workspace = s.abusWorkspace === true; } catch {}
    return {
      workspace,
      notebooks: Object.keys(grants).filter((k) => grants[k] === true),
      session: [..._busSession],
    };
  }

  bus.expose('/', {
    // The workspace filesystem (auditable-works-spec §9).
    VFS: {
      methods: {
        Read:   (p, encoding) => vfs.readFile(p, encoding),
        Write:  (p, content) => vfs.writeFile(p, content),
        // opts is optional; `{ stat: true }` makes the result an array
        // of { name, type, size, ... } instead of bare strings. Used
        // by the doc surface's {{path}} autocomplete to distinguish
        // directories (append `/`) from files at completion time.
        List:   (p, opts) => vfs.readdir(p, opts || {}),
        Stat:   (p) => vfs.stat(p),
        MkDir:  (p) => vfs.mkdir(p, { recursive: true }),
        Exists: (p) => vfs.exists(p),
        Move:   (from, to) => vfs.rename(from, to),
        Delete: (p) => vfs.rm(p, { recursive: true }),
      },
      signals: ['Changed'],
    },
    // Desktop operations a surface may request.
    Shell: {
      methods: {
        OpenPath: (p) => { openPath(p); },
        Reveal:   () => {},    // Chunk 3 — the file tree
        PickFile: () => null,  // Chunk 3+
        Download: () => {},    // Chunk 3+
        // Workspace mount table — the full list of (path, type) pairs from
        // the shell's VFS. A surface diffs this against its own descriptor
        // set and proxies anything missing through this same service. Paired
        // with the MountChanged signal for live updates.
        ListMounts: () => [...vfs._mounts.entries()].map(([path, backend]) => ({
          path,
          type: backend?.constructor?.type || 'custom',
        })),
        // Trigger the disk-folder picker on the shell side (must be
        // called from a user-gesture context — A-Bus relays the click
        // through so the picker opens in the shell's own page). Used
        // by the settings surface's "Mount folder…" button.
        MountFolder: () => mountFolder(),
        UnmountAt:   (path) => unmountAt(path),
        OpenAbout:   () => { showAbout(); },

        // ── Content registry (Library surface drives these over A-Bus) ──
        RegistrySources:      () => getSources(),
        RegistryAddSource:    (url, name) => addSourceSilent(url, name),
        RegistryRemoveSource: (url) => removeSource(url),
        RegistryFetch:        (sourceUrl) => fetchRegistry(sourceUrl),   // → { base, registry }
        RegistryInstall:      (sourceUrl, name) => installByName(sourceUrl, name),  // → dest path (install/update/reinstall — overwrites)
        RegistryInstalled:    async (name) => (await vfs.exists(bookDir(name)).catch(() => false))
                                            || (await vfs.exists(dataDir(name)).catch(() => false)),
        RegistryStatuses:     (entries) => entryStatuses(entries),   // → { name: 'install'|'installed'|'update' }
        RegistryCheckUpdates: () => checkUpdates(),                  // → [{name,title,from,to,source}]

        // ── Notebook A-Bus access (notebook-abus-access-spec.md) ──
        // Tier 3: a notebook asks for the raw bus; this prompts (unless a grant
        // already covers it) and persists per the user's choice. Returns bool.
        RequestBusAccess: (title, id, declared) => requestBusAccess(title, id, declared),
        // Revoke: no id → clear every grant (workspace + all notebooks +
        // session); with an id → just that notebook. For the Settings UI.
        RevokeBusAccess:  (id) => revokeBusAccess(id),
        ListBusGrants:    () => listBusGrants(),
        // Tier 2: a surface declares which of its interfaces are notebook-
        // scriptable (callable without a prompt). Idempotent; signals so a
        // notebook's cached public-set refreshes live.
        DeclareNotebookPublic: (name, ifaces) => {
          if (!name || !Array.isArray(ifaces)) return false;
          _notebookPublic.set(name, new Set(ifaces.map(String)));
          bus.signal({ path: '/', interface: 'Shell', member: 'NotebookPublicChanged' }, []);
          return true;
        },
        UndeclareNotebookPublic: (name) => {
          const had = _notebookPublic.delete(name);
          if (had) bus.signal({ path: '/', interface: 'Shell', member: 'NotebookPublicChanged' }, []);
          return had;
        },
        NotebookPublicSet: () => {
          const o = {};
          for (const [n, s] of _notebookPublic) o[n] = [...s];
          return o;
        },
      },
      signals: ['MountChanged', 'SettingsChanged', 'NotebookPublicChanged'],
    },
    // Workspace-level settings (theme, font, …) stored at /etc/works.json.
    // The settings surface owns the UI; any other surface (notebook in
    // particular) subscribes to SettingsChanged to react.
    Settings: {
      methods: {
        Get: async () => await readSettings(vfs),
        Set: async (next) => {
          await writeSettings(vfs, next);
          applyWorkspaceSettings(next);
          bus.signal({ path: '/', interface: 'Shell', member: 'SettingsChanged' }, [next]);
          return next;
        },
      },
    },
    // Extension-shell evaluation — the cell-side install path runs in the
    // notebook iframe and can't directly evaluate /lib/<pkg>/works.js in
    // the shell context. It calls this method after the gcupkg files are
    // on disk, and the shell evaluates works.js to register surfaces +
    // contextMenu immediately. The drag-drop install path doesn't need
    // this — it runs in the shell already and calls evaluateWorksScript
    // directly (works/js/file-ops.js).
    Extension: {
      methods: {
        EvaluateWorks: async (name) => {
          if (typeof name !== 'string' || !name) return false;
          try { return await evaluateWorksScript(name); }
          catch (e) {
            console.error('[works] Extension.EvaluateWorks for', name, ':', e);
            return false;
          }
        },
      },
    },
    // Broker introspection, for the A-Bus inspector surface.
    Inspect: {
      methods: {
        Snapshot: () => WKS.broker.inspect(),
      },
    },
    // Build-time vendored license inventory — used by the workspace settings
    // surface (and future tools like `geas licenses`). Returns the standard
    // table shape; static for now, will grow when pkg integration lands and
    // /lib/* licenses become aggregatable too.
    Licenses: {
      methods: {
        Get: () => aggregateFromBuildLicenses(__BUILD_LICENSES__),
      },
    },
    // Archive operations against the workspace VFS — used by the preview
    // surface (to render a .zip's contents inline) and by any future surface
    // that needs to extract / compress without bundling @gcu/archive itself.
    // Tree.js calls archive directly (it's already shell-side) and bypasses
    // this — A-Bus is for IFRAME-sandboxed surfaces.
    Archive: {
      methods: {
        List:     (srcPath)                  => archive.list({ vfs, path: srcPath }),
        Read:     (srcPath, innerPath)       => archive.read({ vfs, path: srcPath }, innerPath),
        Detect:   (srcPath)                  => archive.detect({ vfs, path: srcPath }),
        Extract:  (srcPath, destPath, opts)  => archive.extract({ vfs, path: srcPath }, { vfs, path: destPath }, opts || {}),
        Compress: (srcPath, destPath, opts)  => archive.compress({ vfs, path: srcPath }, { vfs, path: destPath }, opts || {}),
      },
    },
  });

  await bus.claim('works');

  // Workspace VFS changes → the VFS.Changed signal (spec §7.4 / §9).
  const emit = (kind) => (ev) =>
    bus.signal({ path: '/', interface: 'VFS', member: 'Changed' }, [ev && ev.path, kind]);
  vfs.on('write',  emit('modify'));
  vfs.on('delete', emit('delete'));
  vfs.on('rename', emit('move'));

  // Mount-table changes → Shell.MountChanged. Lets surfaces mirror new
  // /mnt/<name> mounts as A-Bus proxy backends in their own surface VFS
  // (a surface that was spawned before the mount existed wouldn't otherwise
  // see it through a delegated direct-I/O root mount).
  vfs.on('mount',   (ev) => bus.signal(
    { path: '/', interface: 'Shell', member: 'MountChanged' },
    [ev.path, 'mount', ev.type || 'custom']));
  vfs.on('unmount', (ev) => bus.signal(
    { path: '/', interface: 'Shell', member: 'MountChanged' },
    [ev.path, 'unmount']));
}
