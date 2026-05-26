// @gcu/abus — D-Bus-shaped coordination bus for Auditable Works
// Auto-generated from ext/abus/src/ — do not edit directly

// -- protocol.js --

// @gcu/abus — wire protocol constants, validation, shared helpers.
//
// Pure module: zero imports, safe in any JS environment (browser, worker,
// Node). Both the broker and the client build on this.

const PROTOCOL_VERSION = '1.0';

// The broker's reserved well-known name. Calls addressed here are executed
// by the broker itself rather than forwarded.
const BUS_NAME = 'bus';

// Standard error codes (spec §13). Peer-specific codes use a peer-prefixed
// namespace (e.g. "dee.Error.SceneNotFound") — a convention, not enforced.
const ERR = {
  NameHasNoOwner:      'Error.NameHasNoOwner',
  NameInUse:           'Error.NameInUse',
  OwnerDisappeared:    'Error.OwnerDisappeared',
  UnknownInterface:    'Error.UnknownInterface',
  UnknownMember:       'Error.UnknownMember',
  InvalidArgs:         'Error.InvalidArgs',
  AccessDenied:        'Error.AccessDenied',
  Internal:            'Error.Internal',
  Timeout:             'Error.Timeout',
  UnsupportedProtocol: 'Error.UnsupportedProtocol',
};

// A well-known name a peer may claim: lowercase, starts with a letter, no
// dots. NAME_RE already excludes ':'- and '_'-prefixed names (reserved); the
// explicit BUS_NAME check rejects the one syntactically-valid reserved name.
const NAME_RE = /^[a-z][a-z0-9_-]*$/;

// An object path: '/'-rooted, segments of [A-Za-z0-9_-]. '/' alone is valid.
const PATH_RE = /^\/([A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*)?$/;

// True if `name` is a well-known name a peer is allowed to claim.
function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && name !== BUS_NAME;
}

// True if `path` is a well-formed object path.
function isValidPath(path) {
  return typeof path === 'string' && PATH_RE.test(path);
}

// An Error carrying a structured A-Bus error `.code` (one of ERR.*, or a
// peer-specific code) plus optional `.data`. Thrown by the client when a
// call fails; the broker and exposed methods produce the matching wire form.
class AbusError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.name = 'AbusError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// Does signal message `msg` satisfy subscription `filter`? Every filter
// field is optional — an omitted field is a wildcard, and an empty filter
// `{}` matches every signal (spec §5.3).
function matchesFilter(filter, msg) {
  if (!filter) return true;
  if (filter.from != null && filter.from !== msg.from) return false;
  if (filter.path != null && filter.path !== msg.path) return false;
  if (filter.interface != null && filter.interface !== msg.interface) return false;
  if (filter.member != null && filter.member !== msg.member) return false;
  return true;
}

// A monotonic id generator, starting at 1. `id` is sender-local (spec §5.5):
// each connection has its own sequence, correlation is by (from, id).
function makeIdGen() {
  let n = 0;
  return () => ++n;
}

// -- broker.js --

// @gcu/abus — the broker.
//
// The broker owns the name registry and routes every message. It is a pure
// synchronous router: it forwards calls/returns/errors/signals in receive
// order, holds no signal state, and never buffers, defers, or coalesces
// (spec §6). Coalescing is a consumer concern — see bus.subscribeLatest.
//
// The broker is the *only* party that resolves signal filters, because it
// is the only party that knows current name ownership: a filter's `from`
// may be a well-known name ("dee") while a signal's `from` is the emitter's
// unique name (":7"). The broker matches across that, and tags each
// delivered signal with the recipient's matching subscription ids (`subIds`)
// so the client can dispatch without re-matching.
//
// In Auditable Works the broker is the shell. Standalone, createBroker()
// returns a host-agnostic broker; the host wires peer ports via connect().


// Create a broker. Returns { connect, disconnect, stats }.
function createBroker() {
  let nextUnique = 1;          // counter for ':N' unique names
  let brokerMsgId = 0;         // the broker's own monotonic message id
  let nextSubId = 0;           // counter for subscription ids

  const ports = new Map();     // uniqueName -> Port
  const owners = new Map();    // wellKnownName -> uniqueName
  const clientIds = new Map(); // uniqueName -> clientId string
  const subs = [];             // { subscriber, filter, subId }
  const pendingCalls = new Map(); // `${callerUnique}|${callId}` -> targetUnique

  function post(uniqueName, msg) {
    const port = ports.get(uniqueName);
    if (!port) return;
    try { port.postMessage(msg); }
    catch { /* port already torn down — drop */ }
  }

  // Every broker-originated message carries from: 'bus' (spec §5.1).
  function replyOk(call, toUnique, args) {
    post(toUnique, {
      type: 'return', id: ++brokerMsgId, from: BUS_NAME,
      to: toUnique, replyTo: call.id, args: args || [],
    });
  }
  function replyErr(call, toUnique, code, message, data) {
    post(toUnique, {
      type: 'error', id: ++brokerMsgId, from: BUS_NAME,
      to: toUnique, replyTo: call.id,
      error: { code, message: message || code, ...(data !== undefined ? { data } : {}) },
    });
  }

  // Does a signal `msg` match subscription `filter`? Ownership-aware: a
  // filter `from` may be a well-known name, while `msg.from` is always a
  // unique name. The other fields are exact (omitted → wildcard).
  function signalMatches(filter, msg) {
    if (!filter) return true;
    if (filter.from != null
      && filter.from !== msg.from
      && owners.get(filter.from) !== msg.from) return false;
    if (filter.path != null && filter.path !== msg.path) return false;
    if (filter.interface != null && filter.interface !== msg.interface) return false;
    if (filter.member != null && filter.member !== msg.member) return false;
    return true;
  }

  // Fan a signal out: at most one copy per subscriber peer, tagged with the
  // list of that peer's matching subscription ids. `skip` is the emitter's
  // unique name (no self-delivery); omit it for broker-originated signals.
  function fanout(msg, skip) {
    const byPeer = new Map();   // subscriber -> [subId, ...]
    for (const sub of subs) {
      if (sub.subscriber === skip) continue;
      if (!signalMatches(sub.filter, msg)) continue;
      let ids = byPeer.get(sub.subscriber);
      if (!ids) { ids = []; byPeer.set(sub.subscriber, ids); }
      ids.push(sub.subId);
    }
    for (const [peer, subIds] of byPeer) post(peer, { ...msg, subIds });
  }

  // Emit a Bus signal (NameOwnerChanged) from the broker itself.
  function emitBusSignal(member, args) {
    fanout({
      type: 'signal', id: ++brokerMsgId, from: BUS_NAME,
      path: '/', interface: 'Bus', member, args,
    });
  }

  // ── monitor (diagnostic stream) ──────────────────────────────────────
  //
  // The broker emits a Monitor.Traffic signal for every transit message
  // (calls between peers, replies, signals fanned out) — letting an
  // inspector surface render a tail-style log without polling. PeerJoined
  // and PeerLeft cover connection lifecycle. Emission is lazy: we keep a
  // counter of how many subscriptions match Monitor.Traffic and skip
  // emitting when no one's listening (the common case). Subscribe and
  // Unsubscribe handlers update the counter.
  //
  // Loop guard: when the signal we'd emit IS Monitor.Traffic itself, we
  // skip. Otherwise the broker would trace its own trace events forever.
  let _monitorTrafficSubs = 0;
  const _callStart = new Map();     // `${caller}|${callId}` -> Date.now()

  function emitMonitorSignal(member, args) {
    fanout({
      type: 'signal', id: ++brokerMsgId, from: BUS_NAME,
      path: '/', interface: 'Monitor', member, args,
    });
  }
  function emitTraffic(event) {
    if (_monitorTrafficSubs === 0) return;
    if (event.interface === 'Monitor' && event.member === 'Traffic') return;
    emitMonitorSignal('Traffic', [{ ts: Date.now(), ...event }]);
  }

  // ── routing ──────────────────────────────────────────────────────────

  function route(fromUnique, msg) {
    if (!msg || typeof msg !== 'object') return;
    msg.from = fromUnique;     // stamp authoritatively (spec §5.1)

    switch (msg.type) {
      case 'call': {
        if (msg.to === BUS_NAME) {
          emitTraffic({ kind: 'call', from: fromUnique, to: BUS_NAME,
            path: msg.path, interface: msg.interface, member: msg.member, msgId: msg.id });
          handleBusCall(fromUnique, msg);
          return;
        }
        // `to` is either a unique name (':N', addressed directly) or a
        // well-known name (resolved through the owner table).
        const target = (typeof msg.to === 'string' && msg.to[0] === ':')
          ? (ports.has(msg.to) ? msg.to : null)
          : owners.get(msg.to);
        if (!target) {
          replyErr(msg, fromUnique, ERR.NameHasNoOwner, `no peer for '${msg.to}'`);
          return;
        }
        pendingCalls.set(`${fromUnique}|${msg.id}`, target);
        _callStart.set(`${fromUnique}|${msg.id}`, Date.now());
        emitTraffic({ kind: 'call', from: fromUnique, to: msg.to,
          path: msg.path, interface: msg.interface, member: msg.member, msgId: msg.id });
        post(target, msg);
        return;
      }
      case 'return':
      case 'error': {
        // This reply answers the call (msg.to, msg.replyTo) — clear its
        // pending-call bookkeeping, then forward to the original caller.
        const key = `${msg.to}|${msg.replyTo}`;
        const startedAt = _callStart.get(key);
        _callStart.delete(key);
        pendingCalls.delete(key);
        emitTraffic({
          kind: msg.type === 'return' ? 'return' : 'error',
          from: fromUnique, to: msg.to,
          msgId: msg.id, replyTo: msg.replyTo,
          latencyMs: startedAt ? Date.now() - startedAt : null,
          error: msg.type === 'error' ? (msg.error && msg.error.code) || 'unknown' : null,
        });
        post(msg.to, msg);
        return;
      }
      case 'signal':
        emitTraffic({ kind: 'signal', from: fromUnique, to: null,
          path: msg.path, interface: msg.interface, member: msg.member, msgId: msg.id });
        fanout(msg, fromUnique);
        return;
      default:
        return;   // unknown wire type — ignore
    }
  }

  // Calls addressed to `bus` are executed here, never forwarded (spec §6.1).
  function handleBusCall(fromUnique, msg) {
    switch (`${msg.interface}.${msg.member}`) {
      case 'Bus.Hello': {
        const info = (msg.args && msg.args[0]) || {};
        // Take the client tag (Hello carries it as `client`; the spec also
        // permits explicit `clientId` for back-compat with older callers).
        const clientId = typeof info.clientId === 'string' ? info.clientId
                       : typeof info.client === 'string'   ? info.client
                       : '';
        clientIds.set(fromUnique, clientId);
        replyOk(msg, fromUnique, [{
          uniqueName: fromUnique,
          protocol: PROTOCOL_VERSION,
          clientId,
        }]);
        // Announce the new peer with its clientId now that we know it —
        // PeerJoined at connect time would have an empty client tag.
        emitMonitorSignal('PeerJoined', [fromUnique, clientId]);
        return;
      }
      case 'Bus.RequestName': {
        const name = msg.args && msg.args[0];
        if (!isValidName(name)) {
          replyErr(msg, fromUnique, ERR.InvalidArgs, `invalid or reserved name '${name}'`);
          return;
        }
        if (owners.has(name)) {
          replyErr(msg, fromUnique, ERR.NameInUse, `name '${name}' already owned`);
          return;
        }
        owners.set(name, fromUnique);
        replyOk(msg, fromUnique, []);
        emitBusSignal('NameOwnerChanged', [name, '', fromUnique, clientIds.get(fromUnique) || '']);
        return;
      }
      case 'Bus.ReleaseName': {
        const name = msg.args && msg.args[0];
        if (owners.get(name) === fromUnique) {
          owners.delete(name);
          replyOk(msg, fromUnique, []);
          emitBusSignal('NameOwnerChanged', [name, fromUnique, '', clientIds.get(fromUnique) || '']);
        } else {
          // Releasing a name you don't own is a no-op, not an error.
          replyOk(msg, fromUnique, []);
        }
        return;
      }
      case 'Bus.ListNames':
        replyOk(msg, fromUnique, [[...owners.keys()]]);
        return;
      case 'Bus.GetNameOwner':
        replyOk(msg, fromUnique, [owners.get(msg.args && msg.args[0]) || '']);
        return;
      case 'Bus.Subscribe': {
        const subId = `s${++nextSubId}`;
        const filter = (msg.args && msg.args[0]) || {};
        subs.push({ subscriber: fromUnique, filter, subId });
        if (filter.interface === 'Monitor' && filter.member === 'Traffic') _monitorTrafficSubs++;
        replyOk(msg, fromUnique, [subId]);
        return;
      }
      case 'Bus.Unsubscribe': {
        const subId = msg.args && msg.args[0];
        const i = subs.findIndex(s => s.subId === subId && s.subscriber === fromUnique);
        if (i >= 0) {
          const f = subs[i].filter;
          if (f.interface === 'Monitor' && f.member === 'Traffic') _monitorTrafficSubs--;
          subs.splice(i, 1);
        }
        replyOk(msg, fromUnique, [null]);
        return;
      }
      case 'Introspectable.Describe':
        replyOk(msg, fromUnique, [brokerDescribe()]);
        return;
      case 'Peer.Ping':
        replyOk(msg, fromUnique, []);
        return;
      default:
        replyErr(msg, fromUnique, ERR.UnknownMember, `bus has no member ${msg.interface}.${msg.member}`);
        return;
    }
  }

  function brokerDescribe() {
    return {
      abus: PROTOCOL_VERSION,
      peer: BUS_NAME,
      service: BUS_NAME,
      objects: [{ path: '/', interfaces: ['Introspectable', 'Peer', 'Bus', 'Monitor'] }],
      interfaces: {
        Bus: {
          methods: {
            Hello:         { args: [{ name: 'info', type: 'object' }], return: { type: 'object' } },
            RequestName:   { args: [{ name: 'name', type: 'string' }], return: { type: 'void' } },
            ReleaseName:   { args: [{ name: 'name', type: 'string' }], return: { type: 'void' } },
            ListNames:     { args: [], return: { type: 'array' } },
            GetNameOwner:  { args: [{ name: 'name', type: 'string' }], return: { type: 'string' } },
            Subscribe:     { args: [{ name: 'filter', type: 'object' }], return: { type: 'string' } },
            Unsubscribe:   { args: [{ name: 'subId', type: 'string' }], return: { type: 'void' } },
          },
          signals: {
            NameOwnerChanged: { args: [
              { name: 'name', type: 'string' },
              { name: 'oldOwner', type: 'string' },
              { name: 'newOwner', type: 'string' },
              { name: 'clientId', type: 'string' },
            ] },
          },
        },
        Introspectable: { methods: { Describe: { args: [], return: { type: 'object' } } }, signals: {} },
        Peer: { methods: { Ping: { args: [], return: { type: 'void' } } }, signals: {} },
        Monitor: {
          methods: {},
          signals: {
            Traffic: { args: [{ name: 'event', type: 'object' }] },
            PeerJoined: { args: [{ name: 'uniqueName', type: 'string' }, { name: 'clientId', type: 'string' }] },
            PeerLeft: { args: [{ name: 'uniqueName', type: 'string' }, { name: 'clientId', type: 'string' }] },
          },
        },
      },
    };
  }

  // ── connection lifecycle ─────────────────────────────────────────────

  // Attach a peer's port to the bus. Returns the assigned unique name.
  function connect(port) {
    const unique = `:${nextUnique++}`;
    ports.set(unique, port);
    port.onmessage = (ev) => route(unique, ev && 'data' in ev ? ev.data : ev);
    if (typeof port.start === 'function') port.start();
    // Node MessagePorts emit 'close'; browser ports don't — there the host
    // calls disconnect() explicitly when it tears an iframe/worker down.
    if (typeof port.on === 'function') {
      port.on('close', () => disconnect(unique));
    }
    return unique;
  }

  // Remove a peer: release its names, cancel its subscriptions, reject any
  // calls in flight to it, drop its port (spec §7.4).
  function disconnect(unique) {
    if (!ports.has(unique)) return;
    const clientId = clientIds.get(unique) || '';

    // Cancel its subscriptions first, so it does not receive the
    // NameOwnerChanged signals fired for its own released names.
    for (let i = subs.length - 1; i >= 0; i--) {
      if (subs[i].subscriber === unique) subs.splice(i, 1);
    }
    // Release every well-known name it owned.
    for (const [name, owner] of [...owners]) {
      if (owner === unique) {
        owners.delete(name);
        emitBusSignal('NameOwnerChanged', [name, unique, '', clientId]);
      }
    }
    // Reject calls in flight to it.
    for (const [key, target] of [...pendingCalls]) {
      if (target !== unique) continue;
      pendingCalls.delete(key);
      const sep = key.lastIndexOf('|');
      const callerUnique = key.slice(0, sep);
      const callId = Number(key.slice(sep + 1));
      replyErr({ id: callId }, callerUnique, ERR.OwnerDisappeared,
        `owner of name disappeared before replying`);
    }
    ports.delete(unique);
    clientIds.delete(unique);
    emitMonitorSignal('PeerLeft', [unique, clientId]);
  }

  function stats() {
    return { peers: ports.size, names: owners.size, subscriptions: subs.length };
  }

  // Read-only snapshot of broker state — for an inspector and debug tools.
  // Host-facing only; not exposed on the wire (a host chooses whether to).
  function inspect() {
    const namesByPeer = new Map();
    for (const [name, owner] of owners) {
      const list = namesByPeer.get(owner) || [];
      list.push(name);
      namesByPeer.set(owner, list);
    }
    return {
      peers: [...ports.keys()].map((u) => ({
        uniqueName: u,
        clientId: clientIds.get(u) || '',
        names: namesByPeer.get(u) || [],
      })),
      subscriptions: subs.map((s) => ({
        subscriber: s.subscriber, subId: s.subId, filter: s.filter,
      })),
    };
  }

  return { connect, disconnect, stats, inspect };
}

// -- client.js --

// @gcu/abus — the client.
//
// connect(port, opts) performs the §7 handshake and returns a ready-to-use
// bus: calls, signals, subscriptions, service exposure, proxies, liveness
// watching, and the streaming convention. The wire contract is the spec;
// this is the canonical client shape that ships alongside the broker.
//
// Signal dispatch is by subscription id: the broker tags each delivered
// signal with the recipient's matching `subIds` (it is the only party that
// can resolve well-known-name filters against ownership), so the client
// simply routes each id to its handler — no client-side re-matching.


const DEFAULT_TIMEOUT = 30000;
const HANDSHAKE_TIMEOUT = 10000;

// Default cadence for subscribeLatest: one animation frame where rAF is
// available, otherwise a short timer (workers, Node).
const defaultSchedule =
  (typeof requestAnimationFrame === 'function')
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => { const t = setTimeout(cb, 16); if (t && t.unref) t.unref(); };

// Connect a peer to the bus over `port` (a MessagePort-shaped transport).
// Resolves to the bus client once the handshake completes.
async function connect(port, opts = {}) {
  const nextId = makeIdGen();
  const pending = new Map();   // call id -> { resolve, reject, timer }
  const subsById = new Map();  // broker subId -> { subId, handler, active }
  const exposed = new Map();   // path -> { [interface]: {methods,signals,primers} }
  let uniqueName = null;
  let closed = false;

  port.onmessage = (ev) => onMessage(ev && 'data' in ev ? ev.data : ev);
  if (typeof port.start === 'function') port.start();

  // ── inbound ──────────────────────────────────────────────────────────

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'return': {
        const p = pending.get(msg.replyTo);
        if (!p) return;
        pending.delete(msg.replyTo);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(msg.args || []);
        return;
      }
      case 'error': {
        const p = pending.get(msg.replyTo);
        if (!p) return;
        pending.delete(msg.replyTo);
        if (p.timer) clearTimeout(p.timer);
        const e = msg.error || {};
        p.reject(new AbusError(e.code || ERR.Internal, e.message, e.data));
        return;
      }
      case 'call':
        handleIncomingCall(msg);
        return;
      case 'signal': {
        // The broker tagged this with the subscription ids that matched.
        for (const id of (msg.subIds || [])) {
          const entry = subsById.get(id);
          if (entry && entry.active) {
            try { entry.handler(msg); } catch { /* handler's problem */ }
          }
        }
        return;
      }
      default:
        return;
    }
  }

  async function handleIncomingCall(msg) {
    const { path, interface: iface, member, from, id } = msg;
    const ok = (args) => { if (!closed) port.postMessage({ type: 'return', id: nextId(), to: from, replyTo: id, args: args || [] }); };
    const err = (code, message, data) => { if (!closed) port.postMessage({ type: 'error', id: nextId(), to: from, replyTo: id, error: { code, message: message || code, ...(data !== undefined ? { data } : {}) } }); };

    // Standard interfaces every peer implements (spec §8).
    if (iface === 'Peer' && member === 'Ping') { ok([]); return; }
    if (iface === 'Introspectable' && member === 'Describe') { ok([buildDescribe()]); return; }

    const obj = exposed.get(path);
    if (!obj || !obj[iface]) {
      err(ERR.UnknownInterface, `no interface ${iface} at ${path}`);
      return;
    }
    const fn = obj[iface].methods && obj[iface].methods[member];
    if (typeof fn !== 'function') {
      err(ERR.UnknownMember, `${iface} has no method ${member}`);
      return;
    }
    try {
      const result = await fn(...(msg.args || []));
      ok(result === undefined ? [] : [result]);
    } catch (e) {
      if (e instanceof AbusError) err(e.code, e.message, e.data);
      else err(ERR.Internal, (e && e.message) || String(e));
    }
  }

  // ── calls ────────────────────────────────────────────────────────────

  // Call a method. `addr` = { to, path, interface, member }. Resolves to the
  // method's return value; rejects with an AbusError on failure or timeout.
  function call(addr, args = [], options = {}) {
    if (closed) return Promise.reject(new AbusError(ERR.Internal, 'bus is closed'));
    const id = nextId();
    const timeout = options.timeout != null ? options.timeout : DEFAULT_TIMEOUT;
    const msg = {
      type: 'call', id, to: addr.to, path: addr.path,
      interface: addr.interface, member: addr.member, args,
    };
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new AbusError(ERR.Timeout,
            `call ${addr.interface}.${addr.member} on '${addr.to}' timed out after ${timeout}ms`));
        }, timeout);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      // Resolve with the first return value — methods conceptually return one.
      pending.set(id, { resolve: (a) => resolve(a[0]), reject, timer });
      try {
        port.postMessage(msg);
      } catch (e) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new AbusError(ERR.Internal, (e && e.message) || String(e)));
      }
    });
  }

  // ── signals ──────────────────────────────────────────────────────────

  // Emit a fire-and-forget signal. `addr` = { path, interface, member }.
  function signal(addr, args = []) {
    if (closed) return;
    port.postMessage({
      type: 'signal', id: nextId(), path: addr.path,
      interface: addr.interface, member: addr.member, args,
    });
  }

  // Subscribe to signals matching `filter`. Returns an unsubscribe function
  // synchronously; `unsub.ready` resolves once the broker has registered the
  // subscription (await it when an ordering guarantee is needed before
  // priming or before a stream's opening call).
  function subscribe(filter, handler) {
    const entry = { subId: null, handler, active: true };
    const ready = call({ to: BUS_NAME, path: '/', interface: 'Bus', member: 'Subscribe' }, [filter || {}])
      .then((subId) => {
        entry.subId = subId;
        if (entry.active) subsById.set(subId, entry);
        return subId;
      })
      .catch(() => null);
    const unsub = () => {
      if (!entry.active) return;
      entry.active = false;
      if (entry.subId != null) subsById.delete(entry.subId);
      ready.then((subId) => {
        if (subId != null) {
          call({ to: BUS_NAME, path: '/', interface: 'Bus', member: 'Unsubscribe' }, [subId]).catch(() => {});
        }
      });
    };
    unsub.ready = ready;
    return unsub;
  }

  // Latest-only subscription: keeps the most recent signal per key and
  // delivers it on the consumer's cadence (default: one animation frame).
  // The consumer-side answer to backpressure (spec §6.4).
  function subscribeLatest(filter, handler, options = {}) {
    const keyOf = options.key
      || ((m) => `${m.from}|${m.path}|${m.interface}|${m.member}`);
    const schedule = options.schedule || defaultSchedule;
    const latest = new Map();   // key -> latest msg
    let flushScheduled = false;

    function flush() {
      flushScheduled = false;
      const batch = [...latest.values()];
      latest.clear();
      for (const m of batch) {
        try { handler(m); } catch { /* handler's problem */ }
      }
    }

    const inner = subscribe(filter, (msg) => {
      latest.set(keyOf(msg), msg);
      if (!flushScheduled) { flushScheduled = true; schedule(flush); }
    });
    const unsub = () => { inner(); latest.clear(); };
    unsub.ready = inner.ready;
    return unsub;
  }

  // Subscribe + bootstrap current state atomically (the primer convention,
  // spec §14.4). Subscribe-first, primer-second so no signal slips the gap.
  async function subscribeWithPrimer({ filter, primer }, handler) {
    const unsubscribe = subscribe(filter, handler);
    await unsubscribe.ready;
    const current = await call(
      { to: primer.to, path: primer.path, interface: primer.interface, member: primer.member },
      primer.args || [],
    );
    return { current, unsubscribe };
  }

  // ── exposing services ────────────────────────────────────────────────

  // Record an interface declaration at `path`. `declaration` maps interface
  // name -> { methods: {...}, signals: [...], primers: { method: signal } }.
  function expose(path, declaration) {
    let obj = exposed.get(path);
    if (!obj) { obj = {}; exposed.set(path, obj); }
    for (const [iface, def] of Object.entries(declaration)) {
      obj[iface] = {
        methods: def.methods || {},
        signals: def.signals || [],
        primers: def.primers || {},
      };
    }
  }

  // Auto-derive the introspection document from expose() declarations.
  function buildDescribe() {
    const objects = [];
    const interfaces = {};
    const rootIfaces = new Set(['Introspectable', 'Peer']);

    for (const [path, obj] of exposed) {
      const ifaceNames = Object.keys(obj);
      if (path === '/') ifaceNames.forEach((i) => rootIfaces.add(i));
      else objects.push({ path, interfaces: ifaceNames });

      for (const [iface, def] of Object.entries(obj)) {
        if (interfaces[iface]) continue;
        const methods = {};
        for (const m of Object.keys(def.methods || {})) {
          methods[m] = { args: [], return: { type: 'dynamic' } };
        }
        for (const [primerMethod, signalName] of Object.entries(def.primers || {})) {
          if (methods[primerMethod]) methods[primerMethod].primerFor = signalName;
        }
        const signals = {};
        for (const s of (def.signals || [])) signals[s] = { args: [] };
        interfaces[iface] = { methods, signals };
      }
    }
    objects.unshift({ path: '/', interfaces: [...rootIfaces] });
    if (!interfaces.Introspectable) {
      interfaces.Introspectable = { methods: { Describe: { args: [], return: { type: 'object' } } }, signals: {} };
    }
    if (!interfaces.Peer) {
      interfaces.Peer = { methods: { Ping: { args: [], return: { type: 'void' } } }, signals: {} };
    }
    return {
      abus: PROTOCOL_VERSION, peer: uniqueName,
      service: opts.client || '', objects, interfaces,
    };
  }

  // ── bus methods, discovery, liveness ─────────────────────────────────

  const claim         = (name) => call({ to: BUS_NAME, path: '/', interface: 'Bus', member: 'RequestName' }, [name]);
  const releaseName   = (name) => call({ to: BUS_NAME, path: '/', interface: 'Bus', member: 'ReleaseName' }, [name]);
  const listNames     = ()     => call({ to: BUS_NAME, path: '/', interface: 'Bus', member: 'ListNames' }, []);
  const getNameOwner  = (name) => call({ to: BUS_NAME, path: '/', interface: 'Bus', member: 'GetNameOwner' }, [name]);
  const describe      = (name) => call({ to: name, path: '/', interface: 'Introspectable', member: 'Describe' }, []);
  const ping          = (name) => call({ to: name, path: '/', interface: 'Peer', member: 'Ping' }, []);

  // Build a typed proxy from a peer's introspection: proxy[path][iface][member](...).
  async function proxy(name) {
    const doc = await describe(name);
    const out = {};
    for (const obj of doc.objects || []) {
      const byIface = {};
      for (const iface of obj.interfaces) {
        const def = (doc.interfaces || {})[iface] || { methods: {} };
        const members = {};
        for (const member of Object.keys(def.methods || {})) {
          members[member] = (...args) =>
            call({ to: name, path: obj.path, interface: iface, member }, args);
        }
        byIface[iface] = members;
      }
      out[obj.path] = byIface;
    }
    return out;
  }

  // Poll Peer.Ping; fire `onChange(alive)` when liveness transitions.
  function watchAlive(name, options = {}, onChange) {
    const interval = options.interval || 5000;
    const timeout = options.timeout || 2000;
    let alive = null;
    let stopped = false;
    let timer = null;

    async function probe() {
      if (stopped) return;
      let up = true;
      try { await call({ to: name, path: '/', interface: 'Peer', member: 'Ping' }, [], { timeout }); }
      catch { up = false; }
      if (stopped) return;
      if (up !== alive) { alive = up; try { onChange(up); } catch { /* caller's problem */ } }
      timer = setTimeout(probe, interval);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    probe();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  // Open a stream (the §14.8 convention). `addr` = { to, path, interface,
  // member } where member is the stream's base name; `addr.args` are extra
  // opening-call arguments. The streamId is consumer-assigned: subscribe to
  // the three signals, then issue the opening call passing the id.
  async function openStream(addr, handlers = {}) {
    const streamId = `${uniqueName}/stream-${nextId()}`;
    const base = addr.member;
    let done = false;
    let unsubData = null, unsubEnd = null, unsubErr = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (unsubData) unsubData();
      if (unsubEnd) unsubEnd();
      if (unsubErr) unsubErr();
    };

    unsubData = subscribe(
      { from: addr.to, interface: addr.interface, member: base + 'Data' },
      (msg) => {
        if (done) return;
        const a = msg.args || [];
        if (a[0] === streamId && handlers.onData) handlers.onData(a[1]);
      });
    unsubEnd = subscribe(
      { from: addr.to, interface: addr.interface, member: base + 'End' },
      (msg) => {
        if (done) return;
        const a = msg.args || [];
        if (a[0] !== streamId) return;
        finish();
        if (handlers.onEnd) handlers.onEnd(a[1]);
      });
    unsubErr = subscribe(
      { from: addr.to, interface: addr.interface, member: base + 'Error' },
      (msg) => {
        if (done) return;
        const a = msg.args || [];
        if (a[0] !== streamId) return;
        finish();
        if (handlers.onError) handlers.onError(a[1]);
      });

    await Promise.all([unsubData.ready, unsubEnd.ready, unsubErr.ready]);
    await call(
      { to: addr.to, path: addr.path, interface: addr.interface, member: base },
      [streamId, ...(addr.args || [])],
    );

    return {
      streamId,
      cancel: () => {
        finish();
        call({ to: addr.to, path: addr.path, interface: addr.interface, member: 'Cancel' + base }, [streamId])
          .catch(() => {});
      },
    };
  }

  // Tear down the client: reject pending calls, drop subscriptions, close
  // the port.
  function close() {
    if (closed) return;
    closed = true;
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new AbusError(ERR.Internal, 'bus is closed'));
    }
    pending.clear();
    subsById.clear();
    try { if (typeof port.close === 'function') port.close(); } catch { /* ignore */ }
  }

  // ── handshake ────────────────────────────────────────────────────────

  const welcome = await call(
    { to: BUS_NAME, path: '/', interface: 'Bus', member: 'Hello' },
    [{
      client: opts.client || '',
      version: opts.version || '',
      protocol: PROTOCOL_VERSION,
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    }],
    { timeout: opts.handshakeTimeout || HANDSHAKE_TIMEOUT },
  );
  if (welcome.protocol !== PROTOCOL_VERSION) {
    close();
    throw new AbusError(ERR.UnsupportedProtocol,
      `broker speaks ${welcome.protocol}, client speaks ${PROTOCOL_VERSION}`);
  }
  uniqueName = welcome.uniqueName;

  return {
    uniqueName,
    clientId: welcome.clientId,
    call, signal,
    subscribe, subscribeLatest, subscribeWithPrimer,
    expose, claim, releaseName,
    listNames, getNameOwner, describe, proxy, ping,
    watchAlive, openStream, close,
  };
}
export {
  connect,
  createBroker,
  AbusError,
  ERR,
  BUS_NAME,
  PROTOCOL_VERSION,
  matchesFilter,
  isValidName,
  isValidPath,
  makeIdGen,
};
