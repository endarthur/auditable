// @gcu/abus — broker + client test suite.
//
// Each test stands up a real broker and connects peers over Node
// MessageChannels — the same MessagePort shape the browser uses — so the
// handshake, routing, and wire format are all exercised end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';

import { createBroker } from '../ext/abus/src/broker.js';
import { connect } from '../ext/abus/src/client.js';
import { ERR, AbusError, isValidName } from '../ext/abus/src/protocol.js';

// Let queued MessagePort tasks drain.
const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// A one-shot latch: `.p` resolves the first time `.fire(v)` is called.
function latch() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { p, fire: (v) => resolve(v) };
}

// A broker plus a join() that connects fresh peers; teardown() closes ports.
function harness() {
  const broker = createBroker();
  const records = [];
  async function join(opts = {}) {
    const chan = new MessageChannel();
    const brokerUnique = broker.connect(chan.port1);
    const bus = await connect(chan.port2, opts);
    records.push({ bus, p1: chan.port1, p2: chan.port2 });
    return { bus, brokerUnique };
  }
  function teardown() {
    for (const r of records) {
      try { r.bus.close(); } catch { /* */ }
      try { r.p1.close(); } catch { /* */ }
      try { r.p2.close(); } catch { /* */ }
    }
  }
  return { broker, join, teardown };
}

// ── protocol helpers ───────────────────────────────────────────────────

test('isValidName accepts plain names, rejects reserved/malformed', () => {
  assert.ok(isValidName('dee'));
  assert.ok(isValidName('arborist'));
  assert.ok(isValidName('panel-0'));
  assert.ok(!isValidName('bus'));        // reserved
  assert.ok(!isValidName(':7'));         // unique-name namespace
  assert.ok(!isValidName('_ext'));       // reserved prefix
  assert.ok(!isValidName('Dee'));        // must be lowercase
  assert.ok(!isValidName('a.b'));        // no dots
  assert.ok(!isValidName(''));
});

// ── handshake ──────────────────────────────────────────────────────────

test('handshake assigns a unique name', async () => {
  const h = harness();
  try {
    const { bus } = await h.join({ client: 'dee' });
    assert.match(bus.uniqueName, /^:\d+$/);
  } finally { h.teardown(); }
});

test('handshake echoes a supplied clientId', async () => {
  const h = harness();
  try {
    const { bus } = await h.join({ client: 'dee', clientId: 'abc-123' });
    assert.equal(bus.clientId, 'abc-123');
  } finally { h.teardown(); }
});

// ── name ownership ─────────────────────────────────────────────────────

test('RequestName claims a name; a second claim fails with NameInUse', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');
    assert.deepEqual(await a.listNames(), ['alpha']);
    assert.equal(await b.getNameOwner('alpha'), a.uniqueName);

    await assert.rejects(b.claim('alpha'), (e) => {
      assert.ok(e instanceof AbusError);
      assert.equal(e.code, ERR.NameInUse);
      return true;
    });
  } finally { h.teardown(); }
});

test('RequestName rejects a reserved or malformed name', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    await assert.rejects(a.claim('bus'), (e) => e.code === ERR.InvalidArgs);
    await assert.rejects(a.claim('Bad Name'), (e) => e.code === ERR.InvalidArgs);
  } finally { h.teardown(); }
});

test('ReleaseName frees a name for another peer', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');
    await a.releaseName('alpha');
    await b.claim('alpha');                       // now free
    assert.equal(await b.getNameOwner('alpha'), b.uniqueName);
  } finally { h.teardown(); }
});

// ── calls ──────────────────────────────────────────────────────────────

test('a call reaches an exposed method and returns its value', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/calc', { Calc: { methods: { Add: (x, y) => x + y } } });
    await a.claim('alpha');

    const sum = await b.call(
      { to: 'alpha', path: '/calc', interface: 'Calc', member: 'Add' }, [2, 3]);
    assert.equal(sum, 5);
  } finally { h.teardown(); }
});

test('an async exposed method is awaited', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/calc', {
      Calc: { methods: { SlowAdd: async (x, y) => { await settle(5); return x + y; } } },
    });
    await a.claim('alpha');
    assert.equal(
      await b.call({ to: 'alpha', path: '/calc', interface: 'Calc', member: 'SlowAdd' }, [10, 1]),
      11);
  } finally { h.teardown(); }
});

test('call to an unowned name rejects with NameHasNoOwner', async () => {
  const h = harness();
  try {
    const { bus: b } = await h.join();
    await assert.rejects(
      b.call({ to: 'nobody', path: '/', interface: 'X', member: 'Y' }),
      (e) => e.code === ERR.NameHasNoOwner);
  } finally { h.teardown(); }
});

// ── cold→hot service activation (declareService) ───────────────────────

test('declareService: a cold service activates on first call, only once', async () => {
  const h = harness();
  try {
    let activations = 0;
    h.broker.declareService('lazy', {
      activator: async () => {
        activations++;
        const { bus } = await h.join({ client: 'lazy-impl' });
        bus.expose('/', { Demo: { methods: { Ping: () => 'pong', Echo: (x) => x } } });
        await bus.claim('lazy');
      },
    });
    assert.equal(activations, 0, 'declaration is inert — no code runs until first call');

    const { bus: caller } = await h.join({ client: 'caller' });
    const r1 = await caller.call({ to: 'lazy', path: '/', interface: 'Demo', member: 'Ping' }, []);
    assert.equal(r1, 'pong');
    assert.equal(activations, 1, 'first call activated it');

    const r2 = await caller.call({ to: 'lazy', path: '/', interface: 'Demo', member: 'Echo' }, ['hi']);
    assert.equal(r2, 'hi');
    assert.equal(activations, 1, 'already hot — no re-activation');
  } finally { h.teardown(); }
});

test('declareService: concurrent first-calls coalesce onto one activation', async () => {
  const h = harness();
  try {
    let activations = 0;
    h.broker.declareService('lazy2', {
      activator: async () => {
        activations++;
        await settle(10);   // simulate async module load
        const { bus } = await h.join({ client: 'lazy2-impl' });
        bus.expose('/', { Demo: { methods: { Ping: () => 'pong' } } });
        await bus.claim('lazy2');
      },
    });
    const { bus: caller } = await h.join({ client: 'caller2' });
    const results = await Promise.all([
      caller.call({ to: 'lazy2', path: '/', interface: 'Demo', member: 'Ping' }, []),
      caller.call({ to: 'lazy2', path: '/', interface: 'Demo', member: 'Ping' }, []),
      caller.call({ to: 'lazy2', path: '/', interface: 'Demo', member: 'Ping' }, []),
    ]);
    assert.deepEqual(results, ['pong', 'pong', 'pong']);
    assert.equal(activations, 1, 'three concurrent first-calls coalesced onto one activation');
  } finally { h.teardown(); }
});

test('declareService: a failed activation rejects the call but allows retry', async () => {
  const h = harness();
  try {
    let attempts = 0;
    h.broker.declareService('flaky', {
      activator: async () => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
        const { bus } = await h.join({ client: 'flaky-impl' });
        bus.expose('/', { Demo: { methods: { Ping: () => 'ok' } } });
        await bus.claim('flaky');
      },
    });
    const { bus: caller } = await h.join({ client: 'caller-flaky' });
    await assert.rejects(
      caller.call({ to: 'flaky', path: '/', interface: 'Demo', member: 'Ping' }, []),
      (e) => e.code === ERR.NameHasNoOwner);
    // Second call retries activation and succeeds.
    const r = await caller.call({ to: 'flaky', path: '/', interface: 'Demo', member: 'Ping' }, []);
    assert.equal(r, 'ok');
    assert.equal(attempts, 2);
  } finally { h.teardown(); }
});

test('a call can address a peer by its unique name', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/calc', { Calc: { methods: { Add: (x, y) => x + y } } });
    // `a` claims no well-known name — it is reachable only by unique name.
    const sum = await b.call(
      { to: a.uniqueName, path: '/calc', interface: 'Calc', member: 'Add' }, [6, 4]);
    assert.equal(sum, 10);
  } finally { h.teardown(); }
});

test('call to an unconnected unique name rejects with NameHasNoOwner', async () => {
  const h = harness();
  try {
    const { bus: b } = await h.join();
    await assert.rejects(
      b.call({ to: ':9999', path: '/', interface: 'X', member: 'Y' }),
      (e) => e.code === ERR.NameHasNoOwner);
  } finally { h.teardown(); }
});

test('broker.inspect() snapshots peers and subscriptions', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join({ clientId: 'cid-a' });
    const { bus: b } = await h.join();
    await a.claim('alpha');
    const unsub = b.subscribe({ interface: 'Selectable' }, () => {});
    await unsub.ready;

    const snap = h.broker.inspect();
    assert.ok(snap.peers.length >= 2);
    const pa = snap.peers.find((p) => p.uniqueName === a.uniqueName);
    assert.ok(pa, 'peer a present');
    assert.equal(pa.clientId, 'cid-a');
    assert.ok(pa.names.includes('alpha'));
    assert.ok(snap.subscriptions.some(
      (s) => s.subscriber === b.uniqueName && s.filter.interface === 'Selectable'));
  } finally { h.teardown(); }
});

test('call to an unknown interface/member rejects accordingly', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/calc', { Calc: { methods: { Add: (x, y) => x + y } } });
    await a.claim('alpha');

    await assert.rejects(
      b.call({ to: 'alpha', path: '/calc', interface: 'Nope', member: 'Add' }),
      (e) => e.code === ERR.UnknownInterface);
    await assert.rejects(
      b.call({ to: 'alpha', path: '/calc', interface: 'Calc', member: 'Nope' }),
      (e) => e.code === ERR.UnknownMember);
  } finally { h.teardown(); }
});

test('a method that throws an AbusError propagates code + message', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/x', {
      X: { methods: { Boom: () => { throw new AbusError('x.Error.Boom', 'kaboom'); } } },
    });
    await a.claim('alpha');
    await assert.rejects(
      b.call({ to: 'alpha', path: '/x', interface: 'X', member: 'Boom' }),
      (e) => e.code === 'x.Error.Boom' && /kaboom/.test(e.message));
  } finally { h.teardown(); }
});

test('a call times out when no reply arrives', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/x', { X: { methods: { Hang: () => new Promise(() => {}) } } });
    await a.claim('alpha');
    await assert.rejects(
      b.call({ to: 'alpha', path: '/x', interface: 'X', member: 'Hang' }, [], { timeout: 40 }),
      (e) => e.code === ERR.Timeout);
  } finally { h.teardown(); }
});

// ── signals ────────────────────────────────────────────────────────────

test('a subscriber receives a matching signal', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');

    const got = latch();
    const unsub = b.subscribe(
      { from: 'alpha', interface: 'Evt', member: 'Tick' },
      (msg) => got.fire(msg.args));
    await unsub.ready;

    a.signal({ path: '/clock', interface: 'Evt', member: 'Tick' }, [42]);
    assert.deepEqual(await got.p, [42]);
  } finally { h.teardown(); }
});

test('a from-filter resolves the well-known name to the current owner', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();   // will own 'alpha'
    const { bus: c } = await h.join();   // owns nothing relevant
    const { bus: b } = await h.join();
    await a.claim('alpha');

    let hits = 0;
    const unsub = b.subscribe(
      { from: 'alpha', interface: 'Evt', member: 'Tick' },
      () => { hits++; });
    await unsub.ready;

    c.signal({ path: '/clock', interface: 'Evt', member: 'Tick' }, ['from-c']);
    a.signal({ path: '/clock', interface: 'Evt', member: 'Tick' }, ['from-a']);
    await settle();
    assert.equal(hits, 1);   // only alpha's signal matched
  } finally { h.teardown(); }
});

test('a peer does not receive its own signals', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    let hits = 0;
    const unsub = a.subscribe({ interface: 'Evt', member: 'Tick' }, () => { hits++; });
    await unsub.ready;
    a.signal({ path: '/clock', interface: 'Evt', member: 'Tick' }, [1]);
    await settle();
    assert.equal(hits, 0);
  } finally { h.teardown(); }
});

test('unsubscribe stops further delivery', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');
    let hits = 0;
    const unsub = b.subscribe({ from: 'alpha', interface: 'Evt', member: 'Tick' }, () => { hits++; });
    await unsub.ready;
    a.signal({ path: '/c', interface: 'Evt', member: 'Tick' }, [1]);
    await settle();
    unsub();
    await settle();
    a.signal({ path: '/c', interface: 'Evt', member: 'Tick' }, [2]);
    await settle();
    assert.equal(hits, 1);
  } finally { h.teardown(); }
});

test('two overlapping subscriptions on one peer both fire', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');
    let one = 0, two = 0;
    const u1 = b.subscribe({ from: 'alpha', interface: 'Evt' }, () => { one++; });
    const u2 = b.subscribe({ from: 'alpha', member: 'Tick' }, () => { two++; });
    await Promise.all([u1.ready, u2.ready]);
    a.signal({ path: '/c', interface: 'Evt', member: 'Tick' }, [1]);
    await settle();
    assert.equal(one, 1);
    assert.equal(two, 1);
  } finally { h.teardown(); }
});

test('subscribeWithPrimer bootstraps current state then tracks changes', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    let state = 'initial';
    a.expose('/s', {
      State: { methods: { Get: () => state }, signals: ['Changed'], primers: { Get: 'Changed' } },
    });
    await a.claim('alpha');

    const seen = [];
    const { current, unsubscribe } = await b.subscribeWithPrimer({
      filter: { from: 'alpha', interface: 'State', member: 'Changed' },
      primer: { to: 'alpha', path: '/s', interface: 'State', member: 'Get' },
    }, (msg) => seen.push(msg.args[0]));

    assert.equal(current, 'initial');
    state = 'updated';
    a.signal({ path: '/s', interface: 'State', member: 'Changed' }, ['updated']);
    await settle();
    assert.deepEqual(seen, ['updated']);
    unsubscribe();
  } finally { h.teardown(); }
});

test('subscribeLatest collapses a burst to the most recent signal', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');

    let flush = null;
    const seen = [];
    const unsub = b.subscribeLatest(
      { from: 'alpha', interface: 'Cam', member: 'Moved' },
      (msg) => seen.push(msg.args[0]),
      { key: () => 'camera', schedule: (cb) => { flush = cb; } });
    await unsub.ready;

    for (let i = 1; i <= 5; i++) {
      a.signal({ path: '/cam', interface: 'Cam', member: 'Moved' }, [i]);
    }
    await settle();              // all five delivered into the latest-map
    assert.equal(typeof flush, 'function');
    flush();                     // consumer's cadence fires
    assert.deepEqual(seen, [5]); // only the freshest survived
  } finally { h.teardown(); }
});

// ── introspection ──────────────────────────────────────────────────────

test('describe returns an auto-derived introspection document', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join({ client: 'alpha' });
    const { bus: b } = await h.join();
    a.expose('/calc', { Calc: { methods: { Add: (x, y) => x + y } } });
    await a.claim('alpha');

    const doc = await b.describe('alpha');
    assert.equal(doc.abus, '1.0');
    assert.ok(doc.interfaces.Calc);
    assert.ok(doc.interfaces.Calc.methods.Add);
    const calcObj = doc.objects.find((o) => o.path === '/calc');
    assert.ok(calcObj && calcObj.interfaces.includes('Calc'));
  } finally { h.teardown(); }
});

test('proxy builds callable stubs from introspection', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/calc', { Calc: { methods: { Add: (x, y) => x + y } } });
    await a.claim('alpha');

    const alpha = await b.proxy('alpha');
    assert.equal(await alpha['/calc'].Calc.Add(7, 8), 15);
  } finally { h.teardown(); }
});

// ── Bus signals + lifecycle ────────────────────────────────────────────

test('NameOwnerChanged fires when a name is claimed', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join({ clientId: 'cid-a' });
    const { bus: b } = await h.join();

    const got = latch();
    const unsub = b.subscribe(
      { from: 'bus', interface: 'Bus', member: 'NameOwnerChanged' },
      (msg) => got.fire(msg.args));
    await unsub.ready;

    await a.claim('alpha');
    const [name, oldOwner, newOwner, clientId] = await got.p;
    assert.equal(name, 'alpha');
    assert.equal(oldOwner, '');
    assert.equal(newOwner, a.uniqueName);
    assert.equal(clientId, 'cid-a');
  } finally { h.teardown(); }
});

test('disconnecting an owner rejects calls in flight with OwnerDisappeared', async () => {
  const h = harness();
  try {
    const { bus: a, brokerUnique: aUnique } = await h.join();
    const { bus: b } = await h.join();
    a.expose('/x', { X: { methods: { Hang: () => new Promise(() => {}) } } });
    await a.claim('alpha');

    const inflight = b.call({ to: 'alpha', path: '/x', interface: 'X', member: 'Hang' }, [], { timeout: 0 });
    await settle();                    // let the call reach the broker
    h.broker.disconnect(aUnique);

    await assert.rejects(inflight, (e) => e.code === ERR.OwnerDisappeared);
  } finally { h.teardown(); }
});

test('watchAlive reports a peer going down', async () => {
  const h = harness();
  try {
    const { bus: a, brokerUnique: aUnique } = await h.join();
    const { bus: b } = await h.join();
    await a.claim('alpha');

    const transitions = [];
    const stop = b.watchAlive('alpha', { interval: 20, timeout: 40 }, (up) => transitions.push(up));
    await settle(60);                  // first probe → alive
    h.broker.disconnect(aUnique);
    await settle(120);                 // next probe → no owner → down
    stop();
    assert.deepEqual(transitions, [true, false]);
  } finally { h.teardown(); }
});

// ── streaming convention ───────────────────────────────────────────────

test('openStream delivers data chunks then ends', async () => {
  const h = harness();
  try {
    const { bus: a } = await h.join();
    const { bus: b } = await h.join();

    a.expose('/term', {
      Terminal: {
        methods: {
          Output: (streamId) => {
            for (let i = 1; i <= 3; i++) {
              a.signal({ path: '/term', interface: 'Terminal', member: 'OutputData' },
                [streamId, `chunk${i}`]);
            }
            a.signal({ path: '/term', interface: 'Terminal', member: 'OutputEnd' },
              [streamId, 'done']);
          },
          CancelOutput: () => {},
        },
        signals: ['OutputData', 'OutputEnd', 'OutputError'],
      },
    });
    await a.claim('alpha');

    const chunks = [];
    const ended = latch();
    await b.openStream(
      { to: 'alpha', path: '/term', interface: 'Terminal', member: 'Output' },
      {
        onData: (c) => chunks.push(c),
        onEnd: (result) => ended.fire(result),
      });

    const result = await ended.p;
    assert.deepEqual(chunks, ['chunk1', 'chunk2', 'chunk3']);
    assert.equal(result, 'done');
  } finally { h.teardown(); }
});
