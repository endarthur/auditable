// The `works` A-Bus service — the shell's own bus peer. It exposes the
// workspace VFS and shell operations to every surface and claims the
// well-known name `works`, so a surface just calls `to: 'works'`.

import { connect } from '#abus';
import { WKS } from './state.js';
import { openPath } from './surfaces.js';
import { mountFolder, unmountAt } from './mount.js';
import { applyWorkspaceSettings, readSettings, writeSettings } from './settings-store.js';
import { registerExtensionSurfaces, unregisterExtensionSurfaces } from './extension-surfaces.js';
import { registerExtensionContextMenu, unregisterExtensionContextMenu } from './context-menu-registry.js';
import { showAbout } from './about.js';
import { aggregateFromBuildLicenses } from '#licenses';
import { archive } from '#archive';

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

  bus.expose('/', {
    // The workspace filesystem (auditable-works-spec §9).
    VFS: {
      methods: {
        Read:   (p, encoding) => vfs.readFile(p, encoding),
        Write:  (p, content) => vfs.writeFile(p, content),
        List:   (p) => vfs.readdir(p),
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
      },
      signals: ['MountChanged', 'SettingsChanged'],
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
    // Extension registry — EXTENSION_SPEC §3.8. The notebook iframe's
    // window.auditable.registerExtension fires inside the iframe context,
    // but Surfaces + contextMenu contributions must reach the SHELL's
    // registries (KINDS, _items). The notebook's host-detection logic
    // detects we're in Works and calls Extension.Register over A-Bus
    // with a JSON-safe slice of the manifest. The methods are idempotent
    // — re-registering the same manifest replaces the previous entries.
    Extension: {
      methods: {
        Register: async (manifest) => {
          if (!manifest || !manifest.name) return false;
          // Skip the JS-only fields — they don't survive A-Bus's structured
          // clone (functions can't cross the boundary). The iframe's caller
          // is expected to keep its live registration locally; the shell
          // gets the declarative slice. detect callbacks won't work without
          // the live JS in the shell; that's an accepted §3.8.9 limit.
          try {
            if (Array.isArray(manifest.surfaces) && manifest.surfaces.length > 0) {
              await registerExtensionSurfaces(manifest);
            }
            if (Array.isArray(manifest.contextMenu) && manifest.contextMenu.length > 0) {
              registerExtensionContextMenu(manifest);
            }
            return true;
          } catch (e) {
            console.error('[works] Extension.Register for', manifest.name, ':', e);
            return false;
          }
        },
        Unregister: (manifest) => {
          if (!manifest || !manifest.name) return false;
          try {
            unregisterExtensionSurfaces(manifest);
            unregisterExtensionContextMenu(manifest);
            return true;
          } catch (e) {
            console.error('[works] Extension.Unregister for', manifest.name, ':', e);
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
