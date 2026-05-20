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

import { PROTOCOL_VERSION, ERR, BUS_NAME, AbusError, makeIdGen } from './protocol.js';

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
export async function connect(port, opts = {}) {
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
