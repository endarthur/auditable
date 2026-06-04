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

export function bootSurface({ connect, client, makeHost, mount, onConnect }) {
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
