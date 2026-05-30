// @gcu/capsule conformance — round-trips + fragment-safety vectors, ported from
// ep's suite (the reference implementation). CompressionStream is global in
// Node 18+, so the full encode/decode path runs in-process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInlineI, encodeInlineQ, resolveCapsule,
  fragmentEncode, fragmentDecode,
} from '../ext/capsule/index.js';

test('capsule: encodeInlineI → resolveCapsule round-trips', async () => {
  const text = 'hello world\n@input\nx = 5\n';
  const ptr = await encodeInlineI(text);
  assert.ok(ptr.startsWith('i:d'), 'i: compact-form prefix');
  assert.equal(await resolveCapsule(ptr), text);
});

test('capsule: encodeInlineQ → resolveCapsule round-trips', async () => {
  const text = 'hello world\n@input\nx = 5\n';
  const ptr = await encodeInlineQ(text);
  assert.ok(ptr.startsWith('q:d'), 'q: QR-form prefix');
  assert.equal(await resolveCapsule(ptr), text);
});

test('capsule: long-form inline:deflate accepted', async () => {
  const text = 'small thing';
  const compact = await encodeInlineI(text);
  const longForm = 'inline:deflate:' + compact.slice('i:d'.length);
  assert.equal(await resolveCapsule(longForm), text);
});

test('capsule: leading # is stripped', async () => {
  const text = 'x = 1';
  const ptr = await encodeInlineI(text);
  assert.equal(await resolveCapsule('#' + ptr), text);
});

test('capsule: unknown scheme returns EUNKNOWN', async () => {
  await assert.rejects(() => resolveCapsule('gh:user/repo:file.txt'), /EUNKNOWN/);
});

test('capsule: no colon returns ENOSCHEME', async () => {
  await assert.rejects(() => resolveCapsule('garbage-no-colon'), /ENOSCHEME/);
});

test('capsule: i and q forms decode to identical text', async () => {
  const text = '@input\ncore = NQ_core\nmass = sample_mass(core, 5 m, 2.7 g/cm3)\n';
  const di = await resolveCapsule(await encodeInlineI(text));
  const dq = await resolveCapsule(await encodeInlineQ(text));
  assert.equal(di, text); assert.equal(dq, text); assert.equal(di, dq);
});

test('capsule: brotli codec returns EUNSUPPORTEDCODEC', async () => {
  await assert.rejects(() => resolveCapsule('i:bAAAA'), /EUNSUPPORTEDCODEC/);
});

test('fragmentEncode/Decode: round-trip the unsafe chars', () => {
  for (const raw of ['', 'plain', 'a b c', 'a%b', '100%', '%20', '% 20%', 'x%25y',
                     'q:d8N9C7%S7 RKUU8', 'q:r+8D VD82EK4F.KE5TC']) {
    assert.equal(fragmentDecode(fragmentEncode(raw)), raw, JSON.stringify(raw));
  }
});

test('fragmentEncode: leaves base64url untouched', () => {
  const s = 'i:dK8lIVSgszUzOVkgqyi_PU0jLr1DIKs0tKFbIL0stUigBSuckVlUqpOSn6wEA';
  assert.equal(fragmentEncode(s), s);
});

test('capsule: q: round-trips through a fragment-encoded URL hash', async () => {
  let hit = null;
  for (let i = 0; i < 80 && !hit; i++) {
    const text = `@input\ngrade row ${i} = ${i} g/t\nyield = grade row ${i} * 1.5\n`;
    const q = await encodeInlineQ(text);
    if (q.includes(' ') || q.includes('%')) hit = { text, q };
  }
  assert.ok(hit, 'expected a space/%-bearing q: payload in the sample set');
  const inUrlHash = fragmentEncode(hit.q);
  assert.ok(!inUrlHash.includes(' '), 'no raw space survives into the fragment');
  const backToCapsule = fragmentDecode(inUrlHash);
  assert.equal(backToCapsule, hit.q);
  assert.equal(await resolveCapsule(backToCapsule), hit.text);
});
