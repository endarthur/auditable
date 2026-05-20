// Surface spawning + tracking. A surface is an iframe that is an A-Bus peer
// implementing the §5.2 Surface contract. The shell keeps one A-Bus channel
// per surface and addresses each by its unique name.

import { WKS } from './state.js';

// Minimal surface registry — kind → app URL. Chunk 3 replaces this with
// project.json kind detection driven by the file tree.
const REGISTRY = {
  stub: 'works/surfaces/stub.html',
};

let _seq = 0;
const _byUnique = new Map();   // A-Bus unique name → tab id

// Spawn a surface of `kind` into a new rails tab. Returns the tab id.
export function spawnSurface(kind, opts = {}) {
  const url = REGISTRY[kind];
  if (!url) throw new Error('unknown surface kind: ' + kind);

  const tabId = 't' + (++_seq);
  const iframe = document.createElement('iframe');
  iframe.className = 'works-surface-frame';
  iframe.src = url;

  // One A-Bus channel per surface: the shell keeps port1 (broker side),
  // the surface receives port2 in its welcome.
  const ch = new MessageChannel();
  const uniqueName = WKS.broker.connect(ch.port1);
  _byUnique.set(uniqueName, tabId);

  const rec = {
    tabId, kind, uniqueName, iframe,
    path: opts.path || '/', title: opts.title || kind,
    ready: false, dirty: false,
  };
  WKS.surfaces.set(tabId, rec);

  // Hand the surface its port + bootstrap once its document has loaded
  // (so its message listener is already registered).
  iframe.addEventListener('load', () => {
    iframe.contentWindow.postMessage(
      {
        type: 'abus:welcome',
        port: ch.port2,
        tab: { id: tabId, path: rec.path, kind },
      },
      '*', [ch.port2]);
  });

  WKS.rails.addTab({ id: tabId, title: rec.title, kind: 'surface' });
  WKS.rails.activateTab(tabId);
  return tabId;
}

// Open a VFS path in a surface. Chunk 2 spawns a stub; Chunk 3 resolves the
// path's kind via the surface registry.
export function openPath(path) {
  return spawnSurface('stub', { path, title: path });
}

// Reflect a surface's Surface-interface signals onto its tab + record.
export function setupSurfaces() {
  WKS.worksBus.subscribe({ interface: 'Surface' }, (msg) => {
    const tabId = _byUnique.get(msg.from);
    if (!tabId) return;
    const rec = WKS.surfaces.get(tabId);
    if (!rec) return;
    const arg = (msg.args || [])[0];
    if (msg.member === 'Ready') {
      rec.ready = true;
    } else if (msg.member === 'TitleChanged') {
      rec.title = arg;
      WKS.rails.updateTab(tabId, { title: arg });
    } else if (msg.member === 'DirtyChanged') {
      rec.dirty = !!arg;
    }
  });
}
