# A-Bus

**A D-Bus-shaped coordination protocol for browser apps.**

A-Bus is the IPC backbone of [Auditable Works](https://github.com/gentropic/auditable) and any other GCU surface that needs structured cross-realm coordination — iframe panels, web workers, SharedWorker shells, multi-tab notebooks. The shape mirrors D-Bus (well-known names + object paths + interfaces + signals + introspection); the transport is MessagePort.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 1.0 (protocol); 0.1 (implementation)           |
| Status     | Shipped 2026-04; stable wire format            |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | D-Bus (freedesktop.org); MessagePort transport |

---

## Lineage

D-Bus is the Linux desktop's IPC bus, designed in 2002 for "let app A call a method on app B, get the result, also let A subscribe to events B emits." A-Bus is the same thing in a browser realm. The vocabulary is borrowed wholesale — well-known names, unique names, object paths, interfaces, methods, signals, match rules, introspection — because that vocabulary has been refined for two decades and there's no point inventing new words.

We didn't reach for `BroadcastChannel` because it doesn't have request/reply, name registration, or introspection — only fire-and-forget broadcast. We didn't reach for `postMessage` directly because that puts the addressing and reply-correlation burden on every consumer. We didn't reach for a more elaborate framework (Comlink, gRPC-web) because the goal here is "the small piece that turns a tangle of postMessage handlers into something coordinated," not "expose remote objects with full type marshalling."

## Premise

Three commitments drive the design:

1. **Single broker, many peers.** One process owns the broker (in Works, that's the shell; in a worker pool, it'd be the main thread). Every other realm is a peer that joins the broker over a MessagePort. The broker is the only thing that knows the topology; peers know only their own state and the messages they send/receive.
2. **Names + paths + interfaces.** Addressing has three layers: a peer (by well-known or unique name), an object on that peer (by path), and an interface on that object (by name). This separation lets one peer host multiple objects, each implementing multiple interfaces, without addressing collisions.
3. **Synchronous broker, asynchronous transport.** The broker's router is a synchronous switch — no microtasks, no event-loop hops in the dispatch path. The transport (MessagePort) is naturally async; that's where all the latency lives. Makes the broker easy to reason about and to test deterministically.

## Concepts

### Peers and names

A **peer** is anyone who has `connect()`'d to the broker. Every peer gets a **unique name** assigned by the broker at handshake — `:1`, `:2`, `:3`, … The unique name is the peer's stable identity for the duration of the connection. When the peer disconnects, its unique name is retired (not reused).

A peer may **claim** zero or more **well-known names** (`echo`, `dee`, `notebook`). Claiming `dee` means "I am the canonical dee peer on this bus." A well-known name is claim-once: a second peer requesting the same name gets `Error.NameInUse`. When the owning peer releases the name (explicitly or by disconnecting), the broker emits a `Bus.NameOwnerChanged` signal so subscribers can react.

Well-known name conventions (not enforced; just convention):

- Lowercase ASCII, starts with a letter, no dots: `dee`, `arborist`, `panel-0`.
- The literal name `bus` is reserved for the broker itself.
- Names starting with `:` are the unique-name namespace (peer can't claim one).
- Names starting with `_` are reserved.

Calling a well-known name routes to whoever owns it; calling a unique name routes to that specific peer. Use well-known names for "the dee surface" (where there's always one), unique names for "this specific tab" (where there are many).

### Object paths

Within a peer, objects are addressed by **path**: `/`-rooted, slash-separated, segments matching `[A-Za-z0-9_-]`. The root path `/` is fine and common (a peer with one object). Multi-object peers use paths like `/scenes/cathedral`, `/tabs/0`, `/projects/foo/bar`.

A peer can expose multiple objects at multiple paths. The same interface can be implemented at different paths (each is a separate object). Paths are arbitrary strings the peer chooses; the broker doesn't interpret them.

### Interfaces

An **interface** is a named group of methods and signals: `Surface`, `Echo`, `Introspectable`, `org.freedesktop.DBus.Properties`. Interface names by convention use dot-separated reverse-domain or single-word lowercase: `Bus`, `Peer`, `Surface`, `dee.Scene`.

A peer declares which interfaces an object implements via `bus.expose(path, interfaces)`:

```js
bus.expose('/scenes/cathedral', {
  'dee.Scene': {
    methods: {
      Add: (args) => [<scene-id>],
      Remove: (args) => [],
      Snapshot: (args) => [<png-bytes>],
    },
    signals: ['Updated', 'Cleared'],
  },
});
```

Methods are functions; signals are declared by name (the actual emission happens via `bus.signal()`).

### Method calls

`bus.call(addr, args, opts?)` sends a `call` message; the broker routes it to the target peer; the target peer's handler runs; the result comes back as a `return` (or `error`) message. The Promise resolves with the return args (always an array, can be empty).

```js
const [count] = await bus.call(
  { to: 'dee', path: '/', interface: 'Bus', member: 'CountListeners' },
);
```

Calls carry an `id`; the broker uses that to correlate the reply. Timeouts are per-call (default 5 s).

### Signals

`bus.signal(addr, args)` broadcasts a `signal` message: the broker fans out one copy to each subscriber whose filter matches. Subscriptions are by `(from, path, interface, member)` filter, any of which can be omitted (omitted = wildcard).

```js
bus.subscribe(
  { from: 'dee', interface: 'dee.Scene', member: 'Updated' },
  (msg) => { /* … */ },
);
```

The handler receives the original signal message; `msg.args` is the emitter's payload. Self-delivery is suppressed (a peer doesn't receive its own signals).

### Subscription primers

Three subscription variants:

- `bus.subscribe(filter, handler)` — vanilla. Handler fires on subsequent matching signals.
- `bus.subscribeLatest(filter, handler)` — handler also fires immediately with the broker's last-cached value for that filter, if any.
- `bus.subscribeWithPrimer(filter, handler)` — handler fires on signals AND the broker asks the emitter for the current state via a primer call (`<member>Current` by convention). For state synchronization on subscribe.

### Introspection

Every peer implements `Introspectable.Describe()` automatically. Calling it returns a tree of `{ paths: { <path>: { interfaces: { <name>: { methods: [...], signals: [...] } } } } }` reflecting what the peer has `expose`'d.

Combined with `Bus.ListNames()` and `Bus.GetNameOwner(name)`, a debugger can walk the entire bus and enumerate every reachable method.

## Wire protocol

All messages are JS objects (structured-clonable). Five message types:

```ts
{ type: 'call', id, from, to, path, interface, member, args }
{ type: 'return', id, from, to, replyTo, args }
{ type: 'error',  id, from, to, replyTo, error: { code, message, data? } }
{ type: 'signal', id, from, path, interface, member, args, subIds? }
{ type: 'cancel', id, from, replyTo }
```

### Field reference

- `id` — monotonic per-sender. Used to correlate replies.
- `from` — the sender's unique name. Stamped authoritatively by the broker (peers' claimed `from` is overwritten on routing).
- `to` — the recipient's name (unique or well-known) for calls/returns/errors. Signals don't have `to`; they go to everyone whose filter matches.
- `replyTo` — the `id` of the originating call (returns + errors).
- `path` — the target object path on the recipient.
- `interface` — the target interface name.
- `member` — the method or signal name within that interface.
- `args` — payload as an array. Always an array, even if empty.
- `error` — for errors: `{ code, message, data? }`. `code` is the canonical error code (see below); `message` is human-readable; `data` is optional structured detail.
- `subIds` — for signals: the list of subscription ids matching this delivery. Each peer demultiplexes against its own subscription table using these ids.

### Error codes

```
Error.NameHasNoOwner       — calling a name nobody claims
Error.NameInUse            — claiming a name another peer owns
Error.OwnerDisappeared     — target peer dropped mid-call
Error.UnknownInterface     — peer doesn't implement that interface
Error.UnknownMember        — peer doesn't have that method/signal
Error.InvalidArgs          — peer rejected the args
Error.AccessDenied         — peer-side policy rejected the call
Error.Timeout              — per-call timeout elapsed
Error.UnsupportedProtocol  — handshake protocol mismatch
Error.Internal             — unhandled exception in peer handler
```

Peer-specific codes use a peer-prefixed namespace by convention (e.g. `dee.Error.SceneNotFound`) — convention only, not enforced.

## Handshake

On `connect(port, opts)`:

1. Client posts `call` to `bus.Hello({ client, version, protocol, clientId? })`.
2. Broker assigns a unique name (`:N`).
3. Broker replies `return [{ protocol, uniqueName, clientId? }]`.
4. Client verifies protocol match; aborts with `Error.UnsupportedProtocol` if not.
5. Client is now ready; `connect()` resolves.

Handshake timeout defaults to 5 s (overridable via `opts.handshakeTimeout`). If a `clientId` is supplied, the broker echoes it back unchanged — useful for peers that survive page reloads (a SharedWorker peer can recognize the same logical client across reconnects).

## Broker-implemented `Bus` interface

The broker itself is addressable at `to: 'bus', path: '/', interface: 'Bus'`. Methods:

| Member | Args | Returns |
|---|---|---|
| `Hello(intro)` | introduction blob | `[{ protocol, uniqueName, clientId }]` |
| `RequestName(name)` | `[name]` | `[]`; throws `NameInUse` |
| `ReleaseName(name)` | `[name]` | `[]` |
| `ListNames()` | none | `[[<wellKnownName>, …]]` |
| `GetNameOwner(name)` | `[name]` | `[<uniqueName>]`; throws `NameHasNoOwner` |
| `AddMatch(filter)` | `[filter]` | `[subId]` |
| `RemoveMatch(subId)` | `[subId]` | `[]` |

Signal emitted by the broker:

- `Bus.NameOwnerChanged` — args `[name, oldOwner, newOwner]`. `''` means "no owner." Fired on every claim/release/disconnect.

## Routing rules

When a peer posts a `call` message, the broker:

1. Stamps `msg.from = <senderUniqueName>` (authoritatively; overwriting any spoofed value).
2. If `msg.to === 'bus'`, handles the call internally.
3. Else, resolves `msg.to` (well-known → unique name via the ownership map; unique name → port directly).
4. If no port found → reply `error` `Error.NameHasNoOwner` back to the caller.
5. Else, forwards the call to the target port; records `(senderUnique, callId) → targetUnique` in a pending-calls map.

When the target peer replies (`return` or `error`):

1. Broker stamps `msg.from = <targetUnique>`.
2. Looks up the original caller via pending-calls.
3. Forwards the reply to the caller's port.
4. Removes the pending-call entry.

If the target peer disconnects with calls outstanding, the broker synthesizes `Error.OwnerDisappeared` replies for each.

Signals:

1. Broker stamps `msg.from = <senderUnique>`.
2. Walks the subscription table; for each subscription whose filter matches, records the (subscriber, subId) pair.
3. Groups matches by subscriber. Each subscriber gets one signal message tagged with the list of its matching subIds.
4. Self-delivery is suppressed (the emitter doesn't receive its own signal).

## Subscription filters

A filter is a partial `(from, path, interface, member)` tuple. Any omitted field is a wildcard. Filters match against the broker-stamped signal message.

`filter.from` may be either a unique name or a well-known name. The broker resolves well-known names through the current ownership map at delivery time — if `dee` is owned by `:5`, then `filter.from === 'dee'` matches signals with `msg.from === ':5'`.

Exact match on the other fields. No regex, no wildcards, no nested patterns. Keeps the matcher cheap (one Map / Set lookup per field).

## Streams

For long-running broker-mediated streams, `bus.openStream(addr, args, handlers)`:

1. Generates a stream id.
2. Subscribes the caller to `<member>Data`, `<member>End`, `<member>Error` signals from the target, filtered by stream id.
3. Calls the method with `[streamId, ...args]`.
4. Calls handlers (`onData`, `onEnd`, `onError`) as signals arrive.
5. Returns `{ streamId, cancel() }`.

The convention: a stream-producing method `Foo(streamId, ...args)` emits `FooData(streamId, chunk)` signals until done, then `FooEnd(streamId, summary)` or `FooError(streamId, err)`. The caller cancels via `Cancel<Method>(streamId)`.

## Threat model

A-Bus runs **inside the same trust boundary** as its peers. Peers are not mutually distrusting: a malicious peer can call any other peer's exposed methods, subscribe to any signals, and impersonate well-known names if it gets there first. This is the same trust model as D-Bus's session bus.

A-Bus is NOT:

- A capability-system. Method calls are open to anyone; access control is each peer's responsibility (the peer's handler can throw `Error.AccessDenied`).
- A sandbox. Use the browser's existing sandboxes (iframe `sandbox=""`, COOP/COEP) at the realm boundary. A-Bus assumes the broker connects only peers you trust.
- An authentication layer. The broker stamps `from` authoritatively (peers can't spoof it within the bus), but the broker can't verify that a connecting peer is "really" peer X — only that the MessagePort came from somewhere.

## Architecture

```
ext/abus/src/
  protocol.js   — wire constants, name/path validation, AbusError, helpers; ~110 LOC
  broker.js    — createBroker(): registry + synchronous router; ~360 LOC
  client.js    — connect(): peer-facing API; ~530 LOC
  main.js      — re-exports
```

`protocol.js` is the shared truth (used by both broker and client; importable standalone if you want just the validation helpers). `broker.js` is pure — no DOM, no async. `client.js` has the only `await` in the package (the handshake).

Both the broker and the client are framework-agnostic: any object with `{ onmessage, postMessage, close? }` works as a "port." That includes `MessagePort` (browser, Node), but also `Worker`, `SharedWorker.port`, and any custom shim wrapping `window.postMessage` between an iframe and its parent.

## Testing

25 tests in `test/abus.test.mjs` covering:

- Name validation (`isValidName`)
- Handshake (unique name assignment, clientId echo, protocol version match)
- Name ownership (request, release, in-use rejection, GetNameOwner, ListNames)
- Method calls (well-known + unique addressing, args + return, error propagation, timeout)
- Signals (fanout, self-delivery suppression, filter matching by from/path/iface/member)
- Subscriptions (subscribe/unsubscribe, latest, primers)
- Introspection (Describe returns correct shape)
- Owner disappearance (pending-call rejection)

Plus `test/abus-browser-smoke.mjs`: a Playwright smoke that stands up a broker in the main window with peers in an iframe and a worker, exercising the cross-realm path that Node's `MessageChannel` doesn't cover.

## Open questions

- **Multicast group names** — D-Bus doesn't have these; some larger systems do. A "group" any peer can join, with signals fanning out to all members. Not yet needed in Works, but the broker structure could support it.
- **Persisted subscription replay** — if a peer reconnects (same clientId), should the broker replay missed signals from the last N seconds? Currently no; subscriptions reset on disconnect.
- **Backpressure** — currently the broker is a synchronous router; if a peer's port is slow to drain, we keep posting. For long signal storms (rare in practice), some flow control might help.
- **A worker-based broker variant** — running the broker inside a SharedWorker would let multiple tabs share one bus. Possible; not yet implemented.

## What A-Bus is NOT

- **A general-purpose RPC framework.** No type system, no IDL, no code generation. Args are arbitrary structured-clonable JS values; signatures are documentation.
- **A streaming protocol.** `openStream` is a convention layered on top of signals; for serious streaming (video, audio, high-rate sensor data), use a dedicated MessagePort.
- **A pub/sub broker for large fanout.** Fine for a few hundred subscribers; not designed for thousands.
- **A federated bus.** One broker per bus. Cross-bus would be a proxy peer.

## Versioning

The wire protocol is at version `1.0`. The implementation is pre-1.0 (we may add APIs, refine error codes, etc., but the wire format is stable). A peer with a different protocol version aborts the handshake.
