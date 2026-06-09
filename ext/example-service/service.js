// @example/service — a reference SERVICE contribution (EXTENSION_SPEC §3.9).
//
// A service is contributed as DATA: this package's package.json declares it under
// `gcu.services`, and the Works shell's boot scan (works/js/extension-services.js)
// declares it COLD on the A-Bus broker. There is NO works.js and NO boot-time
// code — this file's setupService runs only on the FIRST call to the service
// (cold→hot). That data-not-code shape is the whole point: trusting a package to
// NAME a service is weaker than trusting it to RUN code at boot.
//
// Contrast @example/quip, a SURFACE + contextMenu contribution, which DOES ship a
// works.js because surfaces need code to register. Services don't.
//
// This module imports NOTHING. Its dependencies arrive via ctx (dependency
// injection), so it runs identically whether it's shell-bundled or blob-imported
// from /lib by the activator — and needs no post-boot import map.

// The cold→hot activator entry. The broker calls it once, on the first call to
// this service's name, with the injected ctx:
//
//   ctx = {
//     broker,        // the A-Bus broker (broker.connect(port))
//     connect,       // @gcu/abus connect()
//     vfs,           // the workspace VFS
//     libDir,        // this package's /lib path, e.g. '/lib/@example/service'
//     getLibSource,  // (name) → a baked/installed lib's source (sync)
//     deps,          // the resolved `requires` libs, as module namespaces
//   }
export async function setupService(ctx) {
  const { broker, connect, deps } = ctx;

  // Connect a broker peer over a fresh channel. This peer claims the service
  // name and exposes the service's interface.
  const ch = new MessageChannel();
  broker.connect(ch.port1);
  const bus = await connect(ch.port2, { client: 'example-service' });

  let calls = 0;

  bus.expose('/', {
    Echo: {
      methods: {
        // Minimal "what a method looks like" — pure, no dependencies.
        Ping:    () => { calls++; return 'pong'; },
        Reverse: (s) => { calls++; return String(s).split('').reverse().join(''); },
        // Proof of dependency injection: report the libs the activator resolved
        // from this package's `requires` (package.json gcu.services) and handed
        // in via ctx.deps — { <libName>: <#exports> }. In a lean shell these come
        // from /lib (provisioned); in a baked build, from the embedded payloads.
        Deps:    () => Object.fromEntries(
                   Object.entries(deps).map(([k, mod]) => [k, Object.keys(mod).length])),
        Calls:   () => calls,
      },
    },
  });

  // The activator MUST claim the declared name before returning; the broker
  // re-routes the triggering call to this peer once the claim lands.
  await bus.claim('example-echo');
  return bus;
}
