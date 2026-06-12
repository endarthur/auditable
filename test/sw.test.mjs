// @gcu/sw — engine tests. The generated sw.js runs in a vm sandbox with mocked
// SW globals (caches/clients/registration/location); events are dispatched by
// hand. Node 18+ provides Request/Response/URL/MessageChannel natively.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeSw } from '../ext/sw/make.mjs';
import { registerGcuSw } from '../ext/sw/register.js';

const ORIGIN = 'https://app.test';
const settle = () => new Promise((r) => setTimeout(r, 25));

// ── mock cache storage ────────────────────────────────────────────────
class MockCache {
  constructor() { this.map = new Map(); }
  _key(req) {
    const url = typeof req === 'string' ? req : req.url;
    return new URL(url, ORIGIN + '/').toString().split('?')[0];
  }
  async match(req) { const hit = this.map.get(this._key(req)); return hit ? hit.clone() : undefined; }
  async put(req, resp) { this.map.set(this._key(req), resp.clone()); }
  async addAll(reqs) { for (const r of reqs) { const resp = await this.ctx.fetch(r); if (resp.status !== 200) throw new Error('addAll ' + r.url); await this.put(r, resp); } }
  async keys() { return [...this.map.keys()].map((u) => new Request(u)); }
  async delete(req) { return this.map.delete(this._key(req)); }
}

// ── sandbox boot ──────────────────────────────────────────────────────
function boot(config, fetchImpl) {
  const handlers = {};
  const cachesMap = new Map();
  const clients = [];
  const state = {
    skipWaited: false, claimed: false, unregistered: false,
    fetches: [],   // every URL fetched
    clients,
  };
  const ctx = {
    GCU_unused: null,
    Request, Response, URL, console,
    setTimeout, clearTimeout,
    fetch: async (req, init) => {
      const url = typeof req === 'string' ? req : req.url;
      state.fetches.push(url);
      return fetchImpl(url, init, req);
    },
    caches: {
      async open(name) {
        if (!cachesMap.has(name)) { const c = new MockCache(); c.ctx = ctx; cachesMap.set(name, c); }
        return cachesMap.get(name);
      },
      async keys() { return [...cachesMap.keys()]; },
      async delete(name) { return cachesMap.delete(name); },
    },
    self: null,
  };
  ctx.self = {
    location: { origin: ORIGIN, href: ORIGIN + '/sw.js' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { state.skipWaited = true; },
    clients: {
      matchAll: async () => clients,
      claim: async () => { state.claimed = true; },
    },
    registration: { unregister: async () => { state.unregistered = true; } },
  };
  vm.createContext(ctx);
  new vm.Script(makeSw(config)).runInContext(ctx);
  state.caches = cachesMap;
  return { handlers, state, ctx };
}

const respText = (body, headers) => new Response(body, { status: 200, headers });
const installEvt = () => {
  const e = { waited: [], waitUntil(p) { this.waited.push(p); } };
  return e;
};
const fetchEvt = (url, method = 'GET') => {
  let resolveResp; const responded = new Promise((r) => { resolveResp = r; });
  return {
    request: new Request(new URL(url, ORIGIN + '/').toString(), { method }),
    respondedWith: false,
    responded,
    respondWith(p) { this.respondedWith = true; Promise.resolve(p).then(resolveResp, resolveResp); },
    waitUntil() {},
  };
};
const msgEvt = (data) => {
  const ch = new MessageChannel();
  const replies = [];
  ch.port1.onmessage = (e) => replies.push(e.data);
  return {
    data, ports: [ch.port2], replies,
    waited: [], waitUntil(p) { this.waited.push(p); },
    close: () => { ch.port1.close(); ch.port2.close(); },
  };
};

const BASE = {
  app: 'testapp', cache: 'testapp-v1',
  precache: ['./', './index.html'],
  navFallback: './index.html',
  routes: [
    { prefix: '/packages/', strategy: 'network-first', timeout: 2000 },
    { pattern: '\\.bin$', strategy: 'cache-first', maxEntries: 2 },
    { prefix: '/external/', strategy: 'passthrough' },
  ],
};

async function bootInstalled(fetchImpl) {
  const b = boot(BASE, fetchImpl);
  const ie = installEvt();
  b.handlers.install(ie);
  await Promise.all(ie.waited);
  return b;
}

describe('makeSw', () => {
  it('emits valid JS and validates config', () => {
    assert.doesNotThrow(() => new vm.Script(makeSw(BASE)));
    assert.throws(() => makeSw({ cache: 'x', precache: ['./'] }), /app/);
    assert.throws(() => makeSw({ app: 'a', precache: ['./'] }), /cache/);
    assert.throws(() => makeSw({ app: 'a', cache: 'c' }), /precache/);
    assert.throws(() => makeSw({ ...BASE, routes: [{ prefix: '/x/', strategy: 'bogus' }] }), /strategy/);
    assert.throws(() => makeSw({ ...BASE, routes: [{ strategy: 'swr' }] }), /prefix or pattern/);
    assert.throws(() => makeSw({ ...BASE, routes: [{ pattern: '([', strategy: 'swr' }] }));
  });
});

describe('lifecycle', () => {
  it('install precaches with cache:reload and skips waiting', async () => {
    let sawReload = 0;
    const b = await bootInstalled(async (url, _init, req) => {
      if (req && req.cache === 'reload') sawReload++;
      return respText('shell:' + url);
    });
    assert.ok(b.state.skipWaited);
    assert.equal(sawReload, 2);
    const cache = b.state.caches.get('testapp-v1');
    assert.ok(await cache.match(ORIGIN + '/index.html'));
  });

  it('activate evicts other caches and claims', async () => {
    const b = await bootInstalled(async () => respText('x'));
    await b.ctx.caches.open('testapp-v0');   // a stale cache
    const ae = installEvt();
    b.handlers.activate(ae);
    await Promise.all(ae.waited);
    assert.ok(b.state.claimed);
    assert.deepEqual(await b.ctx.caches.keys(), ['testapp-v1']);
  });
});

describe('fetch routing', () => {
  it('ignores POST and cross-origin', async () => {
    const b = await bootInstalled(async () => respText('x'));
    const post = fetchEvt('/anything', 'POST');
    b.handlers.fetch(post);
    assert.equal(post.respondedWith, false);
    const xo = { request: new Request('https://other.test/x'), respondedWith: false, respondWith() { this.respondedWith = true; } };
    b.handlers.fetch(xo);
    assert.equal(xo.respondedWith, false);
  });

  it('passthrough routes stay untouched', async () => {
    const b = await bootInstalled(async () => respText('x'));
    const e = fetchEvt('/external/data.json');
    b.handlers.fetch(e);
    assert.equal(e.respondedWith, false);
  });

  it('swr serves cached instantly and broadcasts on byte change', async () => {
    let body = 'shell-v1';
    const b = await bootInstalled(async () => respText(body));
    const inbox = [];
    b.state.clients.push({ postMessage: (m) => inbox.push(m) });
    body = 'shell-v2';                       // a deploy happened
    const e = fetchEvt('/index.html');
    b.handlers.fetch(e);
    const resp = await e.responded;
    assert.equal(await resp.text(), 'shell-v1');   // stale served instantly
    await settle();
    assert.ok(inbox.some((m) => m.type === 'gcu-sw:update-available' && m.app === 'testapp'));
    const cached = await b.state.caches.get('testapp-v1').match(ORIGIN + '/index.html');
    assert.equal(await cached.text(), 'shell-v2'); // cache refreshed
  });

  it('swr with equal ETags short-circuits (no broadcast, no byte read)', async () => {
    const b = await bootInstalled(async () => respText('same', { etag: '"e1"' }));
    const inbox = [];
    b.state.clients.push({ postMessage: (m) => inbox.push(m) });
    const e = fetchEvt('/index.html');
    b.handlers.fetch(e);
    await e.responded;
    await settle();
    assert.equal(inbox.length, 0);
  });

  it('swr falls back to navFallback offline', async () => {
    const b = await bootInstalled(async (url) => {
      if (url.includes('uncached')) throw new Error('offline');
      return respText('shell');
    });
    const e = fetchEvt('/uncached-page');
    b.handlers.fetch(e);
    const resp = await e.responded;
    assert.equal(await resp.text(), 'shell');      // the cached index.html
  });

  it('network-first: fresh online, cached offline', async () => {
    let online = true;
    const b = await bootInstalled(async (url) => {
      if (!online) throw new Error('offline');
      return respText('pkg:' + url.split('/').pop());
    });
    const e1 = fetchEvt('/packages/registry.json');
    b.handlers.fetch(e1);
    assert.equal(await (await e1.responded).text(), 'pkg:registry.json');
    online = false;
    const e2 = fetchEvt('/packages/registry.json');
    b.handlers.fetch(e2);
    assert.equal(await (await e2.responded).text(), 'pkg:registry.json');   // cache fallback
  });

  it('cache-first caches on miss and trims to maxEntries', async () => {
    const b = await bootInstalled(async (url) => respText('blob:' + url));
    for (const n of ['a', 'b', 'c']) {
      const e = fetchEvt(`/assets/${n}.bin`);
      b.handlers.fetch(e);
      await e.responded;
      await settle();
    }
    const cache = b.state.caches.get('testapp-v1');
    const binKeys = (await cache.keys()).filter((k) => k.url.endsWith('.bin'));
    assert.equal(binKeys.length, 2);                          // trimmed to maxEntries
    assert.ok(!binKeys.some((k) => k.url.endsWith('a.bin'))); // oldest evicted
    const fetchCount = b.state.fetches.filter((u) => u.endsWith('c.bin')).length;
    const e2 = fetchEvt('/assets/c.bin');
    b.handlers.fetch(e2);
    await e2.responded;
    assert.equal(b.state.fetches.filter((u) => u.endsWith('c.bin')).length, fetchCount);  // served from cache
  });
});

describe('message protocol', () => {
  it('check-now revalidates the precache set and reports changed', async () => {
    let body = 'v1';
    const b = await bootInstalled(async () => respText(body));
    body = 'v2';
    const e = msgEvt({ type: 'gcu-sw:check-now' });
    b.handlers.message(e);
    await Promise.all(e.waited);
    await settle();
    assert.equal(e.replies.length, 1);
    assert.equal(e.replies[0].type, 'gcu-sw:check-complete');
    assert.equal(e.replies[0].changed, true);
    e.close();
  });

  it('set-auto-check false stops background revalidation', async () => {
    const b = await bootInstalled(async () => respText('x'));
    b.handlers.message({ data: { type: 'gcu-sw:set-auto-check', value: false }, ports: [] });
    const before = b.state.fetches.length;
    const e = fetchEvt('/index.html');
    b.handlers.fetch(e);
    await e.responded;
    await settle();
    assert.equal(b.state.fetches.length, before);   // no revalidate fetch
  });

  it('apply-update broadcasts a coordinated reload to all clients', async () => {
    const b = await bootInstalled(async () => respText('x'));
    const inbox1 = [], inbox2 = [];
    b.state.clients.push({ postMessage: (m) => inbox1.push(m) }, { postMessage: (m) => inbox2.push(m) });
    const e = msgEvt({ type: 'gcu-sw:apply-update' });
    b.handlers.message(e);
    await Promise.all(e.waited);
    assert.ok(inbox1.some((m) => m.type === 'gcu-sw:reload'));
    assert.ok(inbox2.some((m) => m.type === 'gcu-sw:reload'));
    e.close();
  });

  it('status replies with app/cache/autoCheck', async () => {
    const b = await bootInstalled(async () => respText('x'));
    const e = msgEvt({ type: 'gcu-sw:status' });
    b.handlers.message(e);
    await settle();
    assert.equal(e.replies[0].app, 'testapp');
    assert.equal(e.replies[0].cache, 'testapp-v1');
    assert.equal(e.replies[0].autoCheck, true);
    e.close();
  });

  it('nuke deletes caches and unregisters', async () => {
    const b = await bootInstalled(async () => respText('x'));
    const e = msgEvt({ type: 'gcu-sw:nuke' });
    b.handlers.message(e);
    await Promise.all(e.waited);
    await settle();
    assert.equal((await b.ctx.caches.keys()).length, 0);
    assert.ok(b.state.unregistered);
    assert.equal(e.replies[0].type, 'gcu-sw:nuked');
    e.close();
  });
});

describe('register.js (page companion)', () => {
  it('no-ops gracefully without a navigator', async () => {
    const client = registerGcuSw({ url: 'sw.js', persist: true });
    assert.equal(client.supported, false);
    assert.equal(await client.checkNow(), null);
    assert.equal(await client.status(), null);
    assert.doesNotThrow(() => client.setAutoCheck(false));
    assert.doesNotThrow(() => client.applyUpdate());
  });
});
