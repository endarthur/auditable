# @gcu/abus

**A D-Bus-shaped coordination bus for browser apps.** Method calls, signals, name registration, introspection — over MessagePorts.

A-Bus is the IPC layer of [Auditable Works](https://github.com/endarthur/auditable): the shell hosts the broker, every surface (notebook, terminal, docs, file inspector) is a peer, and they coordinate through a single asynchronous bus instead of an ad-hoc tangle of `postMessage` handlers. Shaped after D-Bus because D-Bus's vocabulary (well-known names, object paths, interfaces, methods, signals, subscriptions, introspection) is well-worn and battle-tested for exactly this problem.

Works over any `MessagePort`-shaped transport: `MessageChannel` (browser, Node), iframe → parent `window.postMessage` bridges, `Worker` ports.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/abus
```

## Quick start

Stand up a broker, connect two peers, call between them:

```js
import { createBroker } from '@gcu/abus/broker';
import { connect } from '@gcu/abus/client';

// 1. The broker lives wherever you want the central coordinator (the
//    shell process, the parent window, a SharedWorker).
const broker = createBroker();

// 2. Each peer gets one half of a MessageChannel, the broker gets the
//    other. (In a real app, the broker side might come from window.parent
//    or a SharedWorker port.)
const chan1 = new MessageChannel();
broker.connect(chan1.port1);
const peerA = await connect(chan1.port2, { client: 'peer-a' });

const chan2 = new MessageChannel();
broker.connect(chan2.port1);
const peerB = await connect(chan2.port2, { client: 'peer-b' });

// 3. Peer B claims a well-known name and exposes an interface at /.
await peerB.claim('echo');
peerB.expose('/', {
  Echo: {
    methods: {
      Say: (args) => [args[0]],   // echoes the first arg back
    },
    signals: ['Said'],            // declared, not yet emitted
  },
});

// 4. Peer A calls peer B by name.
const [reply] = await peerA.call(
  { to: 'echo', path: '/', interface: 'Echo', member: 'Say' },
  ['hello'],
);
console.log(reply);   // 'hello'

// 5. B emits a signal; A subscribes.
peerA.subscribe(
  { from: 'echo', interface: 'Echo', member: 'Said' },
  (msg) => console.log('signal:', msg.args[0]),
);
peerB.signal({ path: '/', interface: 'Echo', member: 'Said' }, ['world']);
```

## Core concepts

| Term | Meaning |
|---|---|
| **Broker** | The central router. Owns the name registry, dispatches calls and signals. One per bus. |
| **Peer** | Any client connected to the broker. Each peer gets a **unique name** like `:7` at handshake; can claim **well-known names** (`echo`, `dee`, `notebook`) for service-style addressing. |
| **Object path** | A `/`-rooted slash-separated path identifying a target object on a peer (`/`, `/scenes/cathedral`, `/tabs/0`). Multiple objects per peer, multiple interfaces per object. |
| **Interface** | A named group of methods + signals (`Surface`, `Echo`, `org.freedesktop.DBus.Introspectable`). Mirrors D-Bus interface conventions. |
| **Method call** | `peer.call({ to, path, interface, member }, args)` — request/reply, returns a Promise of the reply args. |
| **Signal** | `peer.signal({ path, interface, member }, args)` — fire-and-forget broadcast. Subscribers match by `from` / `path` / `interface` / `member` filters. |

## API

### Broker side

```js
import { createBroker } from '@gcu/abus/broker';

const broker = createBroker();
const peerUniqueName = broker.connect(messagePort);   // attach a peer
broker.disconnect(messagePort);                       // detach a peer
broker.stats();                                       // { peers, names, subscriptions }
```

### Peer side

```js
import { connect } from '@gcu/abus/client';

const bus = await connect(port, opts);
// opts: { client, version, clientId, handshakeTimeout, timeout }
```

Returns a bus object with:

| Method | Purpose |
|---|---|
| `bus.uniqueName` | The `:N` name the broker assigned (read-only) |
| `bus.call(addr, args, opts?)` | RPC; returns Promise of reply args |
| `bus.signal(addr, args)` | Fire-and-forget broadcast |
| `bus.subscribe(filter, handler)` | Listen to signals matching `filter`; returns `{ unsubscribe }` |
| `bus.subscribeLatest(filter, handler)` | Like `subscribe`, but invokes handler with the broker's last-known value if any |
| `bus.subscribeWithPrimer(filter, handler)` | Subscribe + immediately ask the emitter for current state via a primer call |
| `bus.expose(path, interfaces)` | Mount methods + signals at an object path |
| `bus.claim(name)` | Claim a well-known name; throws `NameInUse` if taken |
| `bus.releaseName(name)` | Drop a claim |
| `bus.listNames()` | List all currently-claimed well-known names |
| `bus.getNameOwner(name)` | Look up the unique name behind a well-known name |
| `bus.describe(name, path)` | Introspect a peer's interfaces + methods at a path |
| `bus.proxy(addr)` | Sugar: returns a stub object whose methods become calls |
| `bus.ping(name)` | Liveness probe |
| `bus.watchAlive(name, handler)` | Notify when a peer drops |
| `bus.openStream(addr, args, handlers)` | Long-running broker-mediated stream (data/end/error) |
| `bus.close()` | Tear down the client; reject pending calls; drop subscriptions |

### Standard interfaces

Every peer automatically implements:

- `Peer.Ping()` — replies with no args. Used for liveness checks.
- `Introspectable.Describe()` — replies with `{ paths: { '<path>': { interfaces: { … } } } }` reflecting what the peer has exposed.

The broker itself exposes `Bus` at `/`:

- `Bus.Hello(intro)` — handshake (called automatically by `connect`)
- `Bus.RequestName(name)`, `Bus.ReleaseName(name)`, `Bus.ListNames()`, `Bus.GetNameOwner(name)`
- `Bus.AddMatch(filter)`, `Bus.RemoveMatch(subId)`
- `Bus.NameOwnerChanged` (signal) — fired when ownership changes

See `SPEC.md` for the full surface.

## Errors

Standardized error codes (every peer should use these where appropriate):

| Code | When |
|---|---|
| `Error.NameHasNoOwner` | Calling a well-known name nobody owns |
| `Error.NameInUse` | Claiming a name another peer already owns |
| `Error.OwnerDisappeared` | The target peer dropped mid-call |
| `Error.UnknownInterface` / `Error.UnknownMember` | Routing failed at the peer |
| `Error.InvalidArgs` | Caller's args didn't match the method signature |
| `Error.AccessDenied` | Peer policy rejected the call |
| `Error.Timeout` | Per-call timeout elapsed |
| `Error.UnsupportedProtocol` | Handshake mismatch |
| `Error.Internal` | Unhandled exception inside the peer's method |

Method handlers can throw `new AbusError(code, message, data?)` to surface a specific code.

## Architecture

```
ext/abus/
  src/
    protocol.js   — wire constants, name/path validation, AbusError
    broker.js     — createBroker(): registry + synchronous router
    client.js     — connect(): peer-facing bus
    main.js       — re-exports
  build.js        — concatenates src/ into index.js
  index.js        — BUILD OUTPUT
  smoke.html      — in-browser smoke test
  smoke-iframe.html, smoke-worker.js — multi-realm smokes
```

Broker is pure and synchronous; only the client's `connect` is async (for the handshake). All async behavior is bounded by the peer's MessagePort delivery cadence — the broker itself does no setTimeout / microtask juggling.

## Files

- 25 tests in `test/abus.test.mjs` covering handshake, name ownership, routing, signal fanout, subscriptions, introspection, primers, error mapping.
- An additional `test/abus-browser-smoke.mjs` Playwright smoke that exercises the multi-realm case (iframe + parent + worker all sharing a broker).

## What's not supported

- **Method signatures** — D-Bus has a type system (`s`, `ai`, `a{sv}`, etc.); A-Bus doesn't. Args are arbitrary structured-clonable JS values.
- **Object manager** — D-Bus's `ObjectManager` for dynamic object discovery isn't implemented; consumers introspect via `Describe()` instead.
- **Activation** — no on-demand peer launching. All peers connect upfront.
- **Multi-broker / federation** — a single broker per bus. Cross-bus would be a `proxy peer` that forwards.

## Status

Pre-1.0. Shipped 2026-04; powers Auditable Works coordination since 2026-05.

## License

MIT.
