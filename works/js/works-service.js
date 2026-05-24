// The `works` A-Bus service — the shell's own bus peer. It exposes the
// workspace VFS and shell operations to every surface and claims the
// well-known name `works`, so a surface just calls `to: 'works'`.

import { connect } from '#abus';
import { WKS } from './state.js';
import { openPath } from './surfaces.js';
import { mountFolder, unmountAt } from './mount.js';
import { applyWorkspaceSettings, readSettings, writeSettings } from './settings-store.js';
import { showAbout } from './about.js';

export async function setupWorksService() {
  const ch = new MessageChannel();
  WKS.broker.connect(ch.port1);
  const bus = await connect(ch.port2, { client: 'works-shell' });
  WKS.worksBus = bus;

  const vfs = WKS.vfs;

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
    // Broker introspection, for the A-Bus inspector surface.
    Inspect: {
      methods: {
        Snapshot: () => WKS.broker.inspect(),
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
