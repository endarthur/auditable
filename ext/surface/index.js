// @gcu/surface — the Auditable Works surface contract (boot + Works host)
// Auto-generated from ext/surface/src/ — do not edit directly

// -- boot.js --

// @gcu/surface — bootSurface: the welcome→connect→claim→expose→Ready handshake
// every Auditable Works surface performs (works/SURFACES.md §2.5 boot template).
// It was ~30 near-identical lines per surface and a known footgun (emit Ready
// before exposing the contract → the shell calls methods that don't exist yet).
// Extracted once strata + plate both needed it — the two-examples discipline.
//
// Zero-dep: `connect` (@gcu/abus) is INJECTED, not imported, so @gcu/surface
// stays a self-contained leaf bundle (the surface already imports connect and
// passes it — same pattern as plate's injected evaluatePredicate).
//
//   bootSurface({
//     connect,                       // @gcu/abus connect(port, opts) → Promise<bus>
//     client,                        // surface name, e.g. 'strata' | 'plate'
//     makeHost(bus, tab) → host,     // usually createWorksHost(bus, tab, caps)
//     mount({ bus, tab, host }),     // read the bound file, build the UI, wire host.onFlush
//     onConnect?(bus),               // optional, post-connect (e.g. installThemeSubscription)
//   })
//
// Order is load-bearing: makeHost → expose the §5.2 Surface contract → mount
// (mounting may emit TitleChanged) → Ready LAST. The shell treats Ready as
// "you can call my methods now", so the contract must already be exposed.

function bootSurface({ connect, client, makeHost, mount, onConnect }) {
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window.parent) return;                 // §7.1 — only our parent
    if (!ev.data || ev.data.type !== 'abus:welcome') return;
    const { port, tab } = ev.data;

    let bus;
    try { bus = await connect(port, { client }); }
    catch (e) { console.error(client + ': A-Bus connect failed', e); return; }

    if (onConnect) { try { onConnect(bus); } catch (e) { console.warn(client + ': onConnect failed', e); } }
    try { await bus.claim(client + '-' + (tab.id || '?')); } catch { /* claim is best-effort */ }

    const host = makeHost(bus, tab);

    // Expose the §5.2 Surface contract BEFORE any signal / mounting.
    bus.expose('/', {
      Surface: {
        methods: {
          Flush:     () => (host.flush ? host.flush() : undefined),
          CanClose:  () => (host.canClose ? host.canClose() : true),
          Relocated: (p) => { if (host.relocate) host.relocate(p); },
        },
        signals: ['DirtyChanged', 'TitleChanged', 'Ready'],
      },
    });

    try { await mount({ bus, tab, host }); }
    catch (e) { console.error(client + ': mount failed', e); }

    bus.signal({ path: '/', interface: 'Surface', member: 'Ready' }, []);
  });
}

// -- works-host.js --

// @gcu/surface — createWorksHost: the Auditable Works host adapter implementing
// the (proto-)surface host interface (tools/strata/HOST.md) over A-Bus. It backs
// the §5.2 Surface lifecycle (dirty / flush / title) and the cross-surface
// selection/linking channel. Extracted once strata + plate both used it — they
// had a byte-identical selection channel and a near-identical lifecycle; the only
// real difference is read-mostly (plate consumes selections + owns no document)
// vs document-editing (strata writes its bound path + self-flushes on edit).
//
// Capabilities (`caps`):
//   readMostly   — true: save is inert, setDirty is a no-op, no self-flush
//                  (plate). false (default): save writes the bound path via the
//                  works VFS, setDirty arms a self-flush (strata).
//   selfFlushMs  — debounce for the edit→flush cadence (default 1500).
//
// The host fills the selection descriptor's dataset (= the bound file path = the
// identity space), origin (this surface's A-Bus name), and epoch; the app
// supplies kind/rows/cols/predicate. Subscribers echo-suppress (ignore their own
// origin) and dataset-scope (same path only).

function createWorksHost(bus, tab, caps = {}) {
  const path = tab.path;
  const readMostly = !!caps.readMostly;
  const selfFlushMs = caps.selfFlushMs ?? 1500;
  let dirty = false, flushCb = null, flushTimer = null, flushP = null, selEpoch = 0;
  const sig = (member, args) => bus.signal({ path: '/', interface: 'Surface', member }, args);

  function doFlush() {
    if (flushP) return flushP;
    clearTimeout(flushTimer); flushTimer = null;
    flushP = (async () => { try { if (flushCb) await flushCb(); } finally { flushP = null; } })();
    return flushP;
  }

  return {
    canOpenFiles: false,                 // files open via the tree, not from inside
    get dirty() { return dirty; },
    async open() { return null; },

    async save(_name, bytes) {
      if (readMostly) return 'ok';        // a read-mostly surface owns no document
      await bus.call({ to: 'works', path: '/', interface: 'VFS', member: 'Write' }, [path, bytes]);
      if (dirty) { dirty = false; sig('DirtyChanged', [false]); }
      return 'saved';
    },
    async saveAs(name, bytes) { return this.save(name, bytes); },  // v1 writes the bound path

    setDirty(b) {
      if (readMostly) return;
      if (b !== dirty) { dirty = b; sig('DirtyChanged', [b]); }
      if (b) { clearTimeout(flushTimer); flushTimer = setTimeout(doFlush, selfFlushMs); }  // §7 self-flush
    },
    setTitle(name) { sig('TitleChanged', [name]); },
    onFlush(cb) { flushCb = cb; },
    flush: doFlush,
    canClose: () => true,

    selection: {
      publish(payload) {
        bus.signal({ path: '/', interface: 'Selection', member: 'Changed' },
          [{ dataset: path, origin: bus.uniqueName, epoch: ++selEpoch, ...payload }]);
      },
      subscribe(cb) {
        return bus.subscribe({ interface: 'Selection', member: 'Changed' }, (msg) => {
          const d = msg && msg.args && msg.args[0];
          if (!d || d.origin === bus.uniqueName) return;   // echo
          if (d.dataset !== path) return;                  // dataset scope
          cb(d);
        });
      },
    },
  };
}

export {
  bootSurface,
  createWorksHost,
};
