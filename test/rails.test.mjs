// Unit tests for @gcu/rails state operations.
// Pure functions only; render/interaction tests need a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findTab,
  findStack,
  findRail,
  findFloat,
  removeTabFromStack,
  cleanup,
  patchTab,
  liveTabIds,
  validateState,
  emptyState,
  makeId,
  freshId,
  serializeState,
} from '../ext/rails/src/state.js';

function makeState() {
  return {
    rails: [
      { id: 'r1', flex: 1, stacks: [
        { id: 's1', flex: 1, active: 'a', tabs: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' }
        ] }
      ] },
      { id: 'r2', flex: 1, stacks: [
        { id: 's2', flex: 1, active: 'c', tabs: [
          { id: 'c', title: 'C' }
        ] }
      ] }
    ],
    floats: []
  };
}

test('findTab locates a tab and returns rail/stack/idx', () => {
  const s = makeState();
  const hit = findTab(s, 'b');
  assert.equal(hit.tab.id, 'b');
  assert.equal(hit.stack.id, 's1');
  assert.equal(hit.rail.id, 'r1');
  assert.equal(hit.idx, 1);
});

test('findTab returns null for missing id', () => {
  assert.equal(findTab(makeState(), 'nope'), null);
});

test('findStack locates a stack and parent rail', () => {
  const s = makeState();
  const hit = findStack(s, 's2');
  assert.equal(hit.stack.id, 's2');
  assert.equal(hit.rail.id, 'r2');
});

test('findRail returns the rail by id', () => {
  const s = makeState();
  assert.equal(findRail(s, 'r1').id, 'r1');
  assert.equal(findRail(s, 'missing'), null);
});

test('removeTabFromStack removes tab and reassigns active', () => {
  const s = makeState();
  const removed = removeTabFromStack(s, 'a');
  assert.equal(removed.id, 'a');
  assert.equal(s.rails[0].stacks[0].tabs.length, 1);
  // a was active; fallback to the remaining tab (b).
  assert.equal(s.rails[0].stacks[0].active, 'b');
});

test('removeTabFromStack preserves active when removing inactive tab', () => {
  const s = makeState();
  removeTabFromStack(s, 'b');
  // a was active, still should be.
  assert.equal(s.rails[0].stacks[0].active, 'a');
});

test('removeTabFromStack returns null when tab missing', () => {
  assert.equal(removeTabFromStack(makeState(), 'nope'), null);
});

test('cleanup drops empty stacks', () => {
  const s = makeState();
  // Empty s2 by removing its only tab.
  s.rails[1].stacks[0].tabs = [];
  cleanup(s);
  // r2 should now be dropped entirely (its only stack was empty).
  assert.equal(s.rails.length, 1);
  assert.equal(s.rails[0].id, 'r1');
});

test('cleanup drops empty rails', () => {
  const s = makeState();
  s.rails[1].stacks = [];
  cleanup(s);
  assert.equal(s.rails.length, 1);
  assert.equal(s.rails[0].id, 'r1');
});

test('cleanup reselects active if it points to a missing tab', () => {
  const s = makeState();
  s.rails[0].stacks[0].active = 'ghost';
  cleanup(s);
  // Should reselect the first remaining tab.
  assert.equal(s.rails[0].stacks[0].active, 'a');
});

test('cleanup on already-empty workspace is a no-op (empty legal)', () => {
  const s = emptyState();
  cleanup(s);
  assert.deepEqual(s, { rails: [], floats: [] });
});

test('liveTabIds collects all tab ids in state', () => {
  const s = makeState();
  const ids = liveTabIds(s);
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c']);
});

test('patchTab updates fields and flags chrome-visibility', () => {
  const s = makeState();
  const r1 = patchTab(s, 'a', { title: 'A!' });
  assert.equal(r1.changed, true);
  assert.equal(r1.chromeVisible, true);
  assert.equal(findTab(s, 'a').tab.title, 'A!');

  const r2 = patchTab(s, 'a', { doc: { kind: 'payload' } });
  assert.equal(r2.changed, true);
  assert.equal(r2.chromeVisible, false);
  assert.deepEqual(findTab(s, 'a').tab.doc, { kind: 'payload' });
});

test('patchTab no-op for unchanged values', () => {
  const s = makeState();
  const r = patchTab(s, 'a', { title: 'A' });
  assert.equal(r.changed, false);
});

test('patchTab ignores id mutation attempts', () => {
  const s = makeState();
  patchTab(s, 'a', { id: 'zzz' });
  assert.equal(findTab(s, 'a').tab.id, 'a');
  assert.equal(findTab(s, 'zzz'), null);
});

test('patchTab on missing tab returns unchanged', () => {
  const s = makeState();
  const r = patchTab(s, 'nope', { title: 'x' });
  assert.equal(r.changed, false);
});

test('validateState passes on well-formed state', () => {
  validateState(makeState());
});

test('validateState rejects empty stack', () => {
  const s = makeState();
  s.rails[0].stacks[0].tabs = [];
  assert.throws(() => validateState(s), /at least one tab/);
});

test('validateState rejects empty rail', () => {
  const s = makeState();
  s.rails[0].stacks = [];
  assert.throws(() => validateState(s), /at least one stack/);
});

test('validateState rejects duplicate tab ids', () => {
  const s = makeState();
  s.rails[1].stacks[0].tabs.push({ id: 'a', title: 'dup' });
  s.rails[1].stacks[0].active = 'a';
  assert.throws(() => validateState(s), /duplicate tab id/);
});

test('validateState rejects active pointing to missing tab', () => {
  const s = makeState();
  s.rails[0].stacks[0].active = 'ghost';
  assert.throws(() => validateState(s), /active references missing/);
});

test('emptyState returns valid empty workspace', () => {
  const e = emptyState();
  assert.deepEqual(e, { rails: [], floats: [] });
});

test('makeId produces unique ids', () => {
  const a = makeId('t'); const b = makeId('t');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('t'));
});

test('freshId never returns an id already in state', () => {
  const s = makeState();
  // Seed uses s1, s2, r1, r2, a, b, c. freshId must skip collisions.
  for (let i = 0; i < 50; i++) {
    const sid = freshId(s, 's');
    assert.equal(s.rails.some(r => r.stacks.some(st => st.id === sid)), false,
      `stack id ${sid} collided`);
    // Simulate adding the new stack to state so next iteration must avoid it too.
    s.rails[0].stacks.push({ id: sid, tabs: [{ id: 'dummy-' + i }], active: 'dummy-' + i });
  }
});

test('freshId works against ids from explicit user seed (the POC demo bug)', () => {
  // Seed deliberately uses the same pattern makeId would naively produce.
  const s = {
    rails: [
      { id: 'r1', flex: 1, stacks: [
        { id: 's1', flex: 1, active: 't1', tabs: [{ id: 't1' }] },
      ] },
      { id: 'r2', flex: 1, stacks: [
        { id: 's2', flex: 1, active: 't2', tabs: [{ id: 't2' }] },
        { id: 's3', flex: 1, active: 't3', tabs: [{ id: 't3' }] },
      ] },
    ],
    floats: []
  };
  const newS = freshId(s, 's');
  const newR = freshId(s, 'r');
  // Neither can collide with seed values.
  assert.ok(!['s1', 's2', 's3'].includes(newS), `got colliding ${newS}`);
  assert.ok(!['r1', 'r2'].includes(newR), `got colliding ${newR}`);
});

test('serializeState round-trips through JSON.parse', () => {
  const s = makeState();
  const text = serializeState(s);
  const back = JSON.parse(text);
  assert.deepEqual(back.rails[0].stacks[0].tabs.map(t => t.id), ['a', 'b']);
  assert.equal(back.rails[1].stacks[0].active, 'c');
});

test('serializeState with replacer filters consumer fields', () => {
  const s = makeState();
  s.rails[0].stacks[0].tabs[0].doc = { big: 'value' };
  const text = serializeState(s, (key, value) => {
    if (key === 'doc') return { $ref: 'filtered' };
    return value;
  });
  const back = JSON.parse(text);
  assert.deepEqual(back.rails[0].stacks[0].tabs[0].doc, { $ref: 'filtered' });
});

// ── float-specific tests ────────────────────────────────────────────────

function makeStateWithFloat() {
  return {
    rails: [
      { id: 'r1', flex: 1, stacks: [
        { id: 's1', flex: 1, active: 'a', tabs: [{ id: 'a', title: 'A' }] }
      ] }
    ],
    floats: [
      { id: 'f1', x: 100, y: 100, w: 400, h: 300, z: 1,
        stack: { id: 'fs1', flex: 1, active: 'ft1', tabs: [
          { id: 'ft1', title: 'Float Tab 1' },
          { id: 'ft2', title: 'Float Tab 2' }
        ] }
      }
    ]
  };
}

test('findTab locates tabs inside floats', () => {
  const s = makeStateWithFloat();
  const hit = findTab(s, 'ft1');
  assert.equal(hit.container, 'float');
  assert.equal(hit.float.id, 'f1');
  assert.equal(hit.tab.id, 'ft1');
});

test('findTab distinguishes rail vs float tabs via container', () => {
  const s = makeStateWithFloat();
  assert.equal(findTab(s, 'a').container, 'rail');
  assert.equal(findTab(s, 'ft1').container, 'float');
});

test('findFloat returns the float by id', () => {
  const s = makeStateWithFloat();
  assert.equal(findFloat(s, 'f1').id, 'f1');
  assert.equal(findFloat(s, 'missing'), null);
});

test('findStack finds stacks in both rails and floats', () => {
  const s = makeStateWithFloat();
  assert.equal(findStack(s, 's1').container, 'rail');
  assert.equal(findStack(s, 'fs1').container, 'float');
});

test('cleanup removes floats whose stack becomes empty', () => {
  const s = makeStateWithFloat();
  s.floats[0].stack.tabs = [];
  cleanup(s);
  assert.equal(s.floats.length, 0);
});

test('cleanup preserves floats with remaining tabs', () => {
  const s = makeStateWithFloat();
  // Remove just one tab, leaving ft2.
  s.floats[0].stack.tabs.splice(0, 1);
  s.floats[0].stack.active = 'ft2';
  cleanup(s);
  assert.equal(s.floats.length, 1);
  assert.equal(s.floats[0].stack.tabs.length, 1);
});

test('cleanup reselects float active when it points to missing tab', () => {
  const s = makeStateWithFloat();
  s.floats[0].stack.active = 'ghost';
  cleanup(s);
  assert.equal(s.floats[0].stack.active, 'ft1');
});

test('liveTabIds includes float tab ids', () => {
  const s = makeStateWithFloat();
  const ids = liveTabIds(s);
  assert.equal(ids.has('a'), true);
  assert.equal(ids.has('ft1'), true);
  assert.equal(ids.has('ft2'), true);
});

test('validateState passes on state with valid floats', () => {
  validateState(makeStateWithFloat());
});

test('validateState rejects float missing x/y/w/h/z', () => {
  const s = makeStateWithFloat();
  delete s.floats[0].x;
  assert.throws(() => validateState(s), /float.*x.*finite/);
});

test('validateState rejects float missing stack', () => {
  const s = makeStateWithFloat();
  delete s.floats[0].stack;
  assert.throws(() => validateState(s), /float.*missing stack/);
});

test('validateState rejects duplicate float ids', () => {
  const s = makeStateWithFloat();
  s.floats.push({ ...s.floats[0], id: 'f1',
    stack: { id: 'fs-dup', active: 'ft-dup', tabs: [{ id: 'ft-dup' }] } });
  assert.throws(() => validateState(s), /duplicate float id/);
});

test('validateState rejects duplicate stack ids across rails and floats', () => {
  const s = makeStateWithFloat();
  s.floats[0].stack.id = 's1'; // collide with rail stack
  assert.throws(() => validateState(s), /duplicate stack id/);
});

test('validateState rejects duplicate tab ids across rails and floats', () => {
  const s = makeStateWithFloat();
  s.floats[0].stack.tabs[0].id = 'a'; // collide with rail tab
  s.floats[0].stack.active = 'a';
  assert.throws(() => validateState(s), /duplicate tab id/);
});

test('freshId does not collide with float ids', () => {
  const s = makeStateWithFloat();
  // floats use id 'f1' and stack id 'fs1' — freshId must avoid them.
  const newS = freshId(s, 'fs');
  const newF = freshId(s, 'f');
  assert.notEqual(newS, 'fs1');
  assert.notEqual(newF, 'f1');
});

test('Tab.badge is a chrome-visible field: patchTab flags chromeVisible=true when badge changes', () => {
  const s = makeState();
  const r1 = patchTab(s, 'a', { badge: 5 });
  assert.equal(r1.changed, true);
  assert.equal(r1.chromeVisible, true);
  const r2 = patchTab(s, 'a', { badge: 5 });
  assert.equal(r2.changed, false);
  const r3 = patchTab(s, 'a', { badge: null });
  assert.equal(r3.changed, true);
  assert.equal(r3.chromeVisible, true);
});

test('Rail.collapsed and Rail.collapsible pass through on state', () => {
  const s = {
    rails: [
      { id: 'r1', flex: 1, collapsible: true, collapsed: false,
        stacks: [{ id: 's1', flex: 1, active: 'a', tabs: [{ id: 'a' }] }] }
    ],
    floats: []
  };
  validateState(s);
  assert.equal(s.rails[0].collapsible, true);
  assert.equal(s.rails[0].collapsed, false);
  // Toggle is consumer responsibility; library just respects the flag.
  s.rails[0].collapsed = true;
  validateState(s);
});

test('preserveOnClose flag is a pass-through on tabs (library does not read it at the state level)', () => {
  const s = {
    rails: [{ id: 'r1', flex: 1, stacks: [{
      id: 's1', flex: 1, active: 'a',
      tabs: [{ id: 'a', title: 'A', preserveOnClose: true }]
    }] }],
    floats: []
  };
  validateState(s);
  const hit = findTab(s, 'a');
  assert.equal(hit.tab.preserveOnClose, true);
  // Patching the flag works like any other field.
  patchTab(s, 'a', { preserveOnClose: false });
  assert.equal(findTab(s, 'a').tab.preserveOnClose, false);
});
