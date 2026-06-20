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

import { PROTOCOL_VERSION, ERR, BUS_NAME, isValidName } from './protocol.js';

// Create a broker. Returns { connect, disconnect, stats }.
export function createBroker() {
  let nextUnique = 1;          // counter for ':N' unique names
  let brokerMsgId = 0;         // the broker's own monotonic message id
  let nextSubId = 0;           // counter for subscription ids

  const ports = new Map();     // uniqueName -> Port
  const owners = new Map();    // wellKnownName -> uniqueName
  const clientIds = new Map(); // uniqueName -> clientId string
  const subs = [];             // { subscriber, filter, subId }
  const pendingCalls = new Map(); // `${callerUnique}|${callId}` -> targetUnique
  // Cold-service declarations (works-contribution-registry-spec): wellKnownName ->
  // { activator, permission, activating }. A call to a declared-but-unowned name runs
  // the activator (which connects a peer + claims the name), then re-routes — so a
  // shell-realm service runs no code until first use. `activating` caches the in-flight
  // activation so concurrent first-calls coalesce onto one run.
  const declared = new Map();

  // ── capability authorization (works-capability-security-spec §4) ─────
  // A "gated" well-known name is default-deny: a call to it is forwarded only
  // if the caller holds a matching grant. Grants live HERE in the broker —
  // peers cannot read, forge, or enumerate them; only the HOST (the shell,
  // after user consent) issues them via grant()/gate(), which are returned
  // from createBroker but never exposed on the wire. Ungated names pass
  // unchanged (staged rollout — services migrate behind capabilities one at a
  // time, converging toward the spec's default-deny end state).
  const gatedNames = new Map();   // wellKnownName -> policy ({} reserved; presence = gated)
  const grants = [];              // { id, grantee, to, interface, member, scope }
  let nextGrantId = 0;

  function scopeOk(scope, msg) {
    if (!scope) return true;
    // Seed scope predicate: a path prefix matched against the first string arg.
    // Real per-service scope predicates arrive with the migrating services.
    if (scope.pathPrefix != null) {
      const a0 = msg.args && msg.args[0];
      if (typeof a0 !== 'string' || !a0.startsWith(scope.pathPrefix)) return false;
    }
    return true;
  }
  // Does a gate policy cover this interface? No `interfaces` list = the whole
  // name is gated; a list = only those interfaces (so e.g. 'works'.Inspect can
  // be gated while VFS/Shell stay open — interface-granular gating).
  function policyGates(policy, iface) {
    if (!policy || !policy.interfaces) return true;
    return policy.interfaces.includes(iface);
  }
  // The gated service this call hits: msg.to as a gated well-known name, or a
  // gated name owned by the resolved target unique (closes the direct-':N'
  // bypass — a caller can't dodge gating by addressing the owner's unique name).
  // Honors per-interface policy, so an ungated interface of a gated name passes.
  function gatedNameFor(msg, targetUnique) {
    if (gatedNames.has(msg.to) && policyGates(gatedNames.get(msg.to), msg.interface)) return msg.to;
    if (targetUnique) {
      for (const [name, pol] of gatedNames) {
        if (owners.get(name) === targetUnique && policyGates(pol, msg.interface)) return name;
      }
    }
    return null;
  }
  // True if `fromUnique` may make call `msg` (resolved to `targetUnique`).
  function authorize(fromUnique, msg, targetUnique) {
    const g = gatedNameFor(msg, targetUnique);
    if (!g) return true;                         // ungated → pass
    const clientId = clientIds.get(fromUnique) || '';
    return grants.some((gr) =>
      (gr.grantee === fromUnique || (clientId && gr.grantee === clientId)) &&
      gr.to === g &&
      (gr.interface === '*' || gr.interface === msg.interface) &&
      (gr.member === '*' || gr.member === msg.member) &&
      scopeOk(gr.scope, msg));
  }

  // Host API (not on the wire). Mark a well-known name capability-gated.
  // policy.interfaces (optional) = gate only those interfaces of the name;
  // omitted = gate the whole name. e.g. gate('works', { interfaces: ['Inspect'] }).
  function gate(name, policy) { gatedNames.set(name, policy || {}); }
  // Issue a grant to a peer (by unique name ':N' for a session grant, or by
  // clientId for a grant that survives reconnects). cap = { to, interface?,
  // member?, scope? }; interface/member default to '*'. Returns a grant id.
  function grant(grantee, cap) {
    if (!grantee || !cap || !cap.to) throw new Error('grant: grantee and cap.to are required');
    const id = `g${++nextGrantId}`;
    grants.push({
      id, grantee, to: cap.to,
      interface: cap.interface || '*',
      member: cap.member || '*',
      scope: cap.scope || null,
    });
    return id;
  }
  function revoke(id) {
    const i = grants.findIndex((g) => g.id === id);
    if (i < 0) return false;
    grants.splice(i, 1);
    return true;
  }
  function revokeAll(grantee) {
    let n = 0;
    for (let i = grants.length - 1; i >= 0; i--) if (grants[i].grantee === grantee) { grants.splice(i, 1); n++; }
    return n;
  }

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
        // Capability check (default-deny for gated names). Runs BEFORE cold→hot
        // activation, so an unauthorized caller never even activates a gated
        // service. authorize() handles target===null via the well-known name.
        if (!authorize(fromUnique, msg, target)) {
          emitTraffic({ kind: 'denied', from: fromUnique, to: msg.to,
            path: msg.path, interface: msg.interface, member: msg.member, msgId: msg.id });
          replyErr(msg, fromUnique, ERR.AccessDenied,
            `not authorized to call ${msg.to}.${msg.interface}.${msg.member}`);
          return;
        }
        if (!target) {
          // Cold→hot: a declared-but-not-yet-live service activates on first call.
          if (typeof msg.to === 'string' && declared.has(msg.to)) {
            _activateThenRoute(fromUnique, msg);
            return;
          }
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
    // Drop its session grants (those keyed by this unique name). Grants keyed
    // by clientId persist — they're for stable principals across reconnects.
    revokeAll(unique);
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
      gated: [...gatedNames.keys()],
      grants: grants.map((g) => ({ ...g })),
    };
  }

  // Declare a cold service: a well-known name that activates lazily on first call.
  // `activator()` must, when awaited, connect a peer that claims `name` + exposes its
  // interface. `permission` is recorded for the install-time gate (enforced shell-side;
  // see works-contribution-registry-spec). No code runs until the name is first called.
  function declareService(name, opts) {
    if (typeof name !== 'string' || !name) throw new Error('declareService: name required');
    const activator = opts && opts.activator;
    if (typeof activator !== 'function') throw new Error('declareService: opts.activator must be a function');
    declared.set(name, { activator, permission: opts && opts.permission, activating: null });
  }

  async function _activateThenRoute(fromUnique, msg) {
    const d = declared.get(msg.to);
    try {
      if (!d.activating) d.activating = Promise.resolve().then(() => d.activator());
      await d.activating;
    } catch (e) {
      d.activating = null;   // failed — allow a later call to retry activation
      replyErr(msg, fromUnique, ERR.NameHasNoOwner,
        `service '${msg.to}' failed to activate: ${(e && e.message) || e}`);
      return;
    }
    // The activator must have claimed the name; if it didn't, it misbehaved.
    if (!owners.get(msg.to)) {
      replyErr(msg, fromUnique, ERR.NameHasNoOwner,
        `service '${msg.to}' did not claim its name on activation`);
      return;
    }
    route(fromUnique, msg);   // now resolves through the owner table
  }

  return { connect, disconnect, stats, inspect, declareService, gate, grant, revoke, revokeAll };
}
