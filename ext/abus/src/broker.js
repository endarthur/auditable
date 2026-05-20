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

  // ── routing ──────────────────────────────────────────────────────────

  function route(fromUnique, msg) {
    if (!msg || typeof msg !== 'object') return;
    msg.from = fromUnique;     // stamp authoritatively (spec §5.1)

    switch (msg.type) {
      case 'call': {
        if (msg.to === BUS_NAME) { handleBusCall(fromUnique, msg); return; }
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
        post(target, msg);
        return;
      }
      case 'return':
      case 'error': {
        // This reply answers the call (msg.to, msg.replyTo) — clear its
        // pending-call bookkeeping, then forward to the original caller.
        pendingCalls.delete(`${msg.to}|${msg.replyTo}`);
        post(msg.to, msg);
        return;
      }
      case 'signal':
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
        clientIds.set(fromUnique, typeof info.clientId === 'string' ? info.clientId : '');
        replyOk(msg, fromUnique, [{
          uniqueName: fromUnique,
          protocol: PROTOCOL_VERSION,
          clientId: clientIds.get(fromUnique),
        }]);
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
        subs.push({ subscriber: fromUnique, filter: (msg.args && msg.args[0]) || {}, subId });
        replyOk(msg, fromUnique, [subId]);
        return;
      }
      case 'Bus.Unsubscribe': {
        const subId = msg.args && msg.args[0];
        const i = subs.findIndex(s => s.subId === subId && s.subscriber === fromUnique);
        if (i >= 0) subs.splice(i, 1);
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
      objects: [{ path: '/', interfaces: ['Introspectable', 'Peer', 'Bus'] }],
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
  }

  function stats() {
    return { peers: ports.size, names: owners.size, subscriptions: subs.length };
  }

  return { connect, disconnect, stats };
}
