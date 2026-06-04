// @gcu/surface — createWorksHost pure tests (a fake A-Bus). The capability logic:
// readMostly (plate) vs document-editing (strata) save/dirty, the selection
// channel's descriptor shape + echo-suppress + dataset-scope, flush wiring. The
// boot handshake (bootSurface) needs a real iframe + postMessage and is covered
// by the strata/plate works smokes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorksHost } from '../ext/surface/src/works-host.js';

function fakeBus() {
  const signals = [];
  const calls = [];
  let subCb = null;
  return {
    uniqueName: 'origin-me',
    signal: (env, args) => signals.push({ member: env.member, interface: env.interface, args }),
    call: async (env, args) => { calls.push({ member: env.member, args }); return 'written'; },
    subscribe: (_filter, cb) => { subCb = cb; return () => { subCb = null; }; },
    _emit: (d) => subCb && subCb({ args: [d] }),
    signals, calls,
  };
}
const TAB = { path: '/projects/x.strata', id: 't1' };

test('document-editing host (default): save writes the bound path via VFS', async () => {
  const bus = fakeBus();
  const host = createWorksHost(bus, TAB);
  assert.equal(host.canOpenFiles, false);
  assert.equal(host.dirty, false);
  const msg = await host.save('x.strata', new Uint8Array([1, 2, 3]));
  assert.equal(msg, 'saved');
  assert.equal(bus.calls.length, 1);
  assert.equal(bus.calls[0].member, 'Write');
  assert.equal(bus.calls[0].args[0], '/projects/x.strata');
});

test('document-editing host: setDirty(true) emits DirtyChanged', () => {
  const bus = fakeBus();
  const host = createWorksHost(bus, TAB, { selfFlushMs: 999999 });  // don't fire the timer
  host.setDirty(true);
  assert.equal(host.dirty, true);
  const dc = bus.signals.find((s) => s.member === 'DirtyChanged');
  assert.ok(dc && dc.args[0] === true);
});

test('read-mostly host (plate): save is inert, setDirty is a no-op', async () => {
  const bus = fakeBus();
  const host = createWorksHost(bus, TAB, { readMostly: true });
  const msg = await host.save('x', new Uint8Array([1]));
  assert.equal(msg, 'ok');
  assert.equal(bus.calls.length, 0);             // no VFS write
  host.setDirty(true);
  assert.equal(host.dirty, false);
  assert.equal(bus.signals.filter((s) => s.member === 'DirtyChanged').length, 0);
});

test('selection.publish stamps dataset / origin / monotonic epoch', () => {
  const bus = fakeBus();
  const host = createWorksHost(bus, TAB, { readMostly: true });
  host.selection.publish({ kind: 'rows', key: '#row', rows: ['0', '1'] });
  host.selection.publish({ kind: 'none', key: '#row' });
  const sel = bus.signals.filter((s) => s.interface === 'Selection');
  assert.equal(sel.length, 2);
  const d0 = sel[0].args[0];
  assert.equal(d0.dataset, '/projects/x.strata');
  assert.equal(d0.origin, 'origin-me');
  assert.equal(d0.epoch, 1);
  assert.equal(d0.kind, 'rows');
  assert.deepEqual(d0.rows, ['0', '1']);
  assert.equal(sel[1].args[0].epoch, 2);          // monotonic
});

test('selection.subscribe echo-suppresses own origin + scopes to dataset', () => {
  const bus = fakeBus();
  const host = createWorksHost(bus, TAB, { readMostly: true });
  const got = [];
  host.selection.subscribe((d) => got.push(d));
  bus._emit({ origin: 'origin-me', dataset: TAB.path, kind: 'rows', rows: ['9'] });      // own echo → ignored
  bus._emit({ origin: 'other', dataset: '/projects/other.strata', kind: 'rows' });        // other dataset → ignored
  bus._emit({ origin: 'other', dataset: TAB.path, kind: 'rows', rows: ['3'] });            // accepted
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].rows, ['3']);
});

test('flush invokes the registered onFlush handler; canClose defaults true', async () => {
  const bus = fakeBus();
  const host = createWorksHost(bus, TAB);
  let flushed = 0;
  host.onFlush(async () => { flushed++; });
  await host.flush();
  assert.equal(flushed, 1);
  assert.equal(host.canClose(), true);
});
