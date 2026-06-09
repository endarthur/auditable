// profiles/resolve — distribution-profile resolution (extends, merge, edition mapping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import resolve from '../profiles/resolve.js';
const { resolveProfile, resolveToEdition } = resolve;

const realProfiles = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');

// ── against the shipped profiles ──
test('auditable-py resolves packages + settings + starter', () => {
  const r = resolveProfile('auditable-py', { profilesDir: realProfiles });
  assert.deepEqual(r.packages, ['@gcu/adder', '@gcu/plot', '@gcu/sadpan']);
  assert.equal(r.settings.preferredCodeType, 'adder');
  assert.equal(r.base, 'auditable');
  assert.equal(r.starter.length, 2);
});

test('auditable-geo extends auditable-py: packages union, settings inherited, starter overridden', () => {
  const r = resolveProfile('auditable-geo', { profilesDir: realProfiles });
  assert.deepEqual(r.packages, ['@gcu/adder', '@gcu/plot', '@gcu/sadpan', '@atra/gslib']);
  assert.equal(r.settings.preferredCodeType, 'adder');      // inherited from py (geo has no settings)
  assert.ok(r.starter.some((c) => /gslib/.test(c.code)));   // geo's own starter (override)
});

test('resolveToEdition maps packages → exts (with adderExports from the index)', () => {
  const e = resolveToEdition('auditable-geo', { profilesDir: realProfiles });
  assert.deepEqual(e.exts.find((x) => x[0] === '@atra/gslib'), ['@atra/gslib', 'ext/atra/lib/gslib.js', ['gslib']]);
  assert.deepEqual(e.exts.find((x) => x[0] === '@gcu/adder'), ['@gcu/adder', 'ext/adder/index.js']);
  assert.equal(e.cells.length, 2);
});

// ── fixtures for the merge/edge rules ──
function fixtures(profiles, pkgs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  for (const [name, body] of Object.entries(profiles)) {
    fs.writeFileSync(path.join(dir, name + '.gcuprofile'), JSON.stringify(body));
  }
  fs.writeFileSync(path.join(dir, 'packages.json'), JSON.stringify(pkgs));
  return dir;
}

test('extends: settings merge (child overrides), packages dedup in order', () => {
  const dir = fixtures({
    base: { packages: ['a', 'b'], settings: { x: 1, y: 1 } },
    child: { extends: ['base'], packages: ['b', 'c'], settings: { y: 2 } },
  });
  const r = resolveProfile('child', { profilesDir: dir });
  assert.deepEqual(r.packages, ['a', 'b', 'c']);
  assert.deepEqual(r.settings, { x: 1, y: 2 });
});

test('starter: child replaces parent when present, inherits when absent', () => {
  const dir = fixtures({
    base: { starter: [{ type: 'md', code: 'parent' }] },
    over: { extends: ['base'], starter: [{ type: 'md', code: 'child' }] },
    inherit: { extends: ['base'] },
  });
  assert.equal(resolveProfile('over', { profilesDir: dir }).starter[0].code, 'child');
  assert.equal(resolveProfile('inherit', { profilesDir: dir }).starter[0].code, 'parent');
});

test('diamond inheritance is NOT a false cycle', () => {
  const dir = fixtures({
    d: { packages: ['d'] },
    b: { extends: ['d'], packages: ['b'] },
    c: { extends: ['d'], packages: ['c'] },
    top: { extends: ['b', 'c'], packages: ['top'] },
  });
  const r = resolveProfile('top', { profilesDir: dir });
  assert.deepEqual(r.packages, ['d', 'b', 'c', 'top']);  // d deduped despite two paths
});

test('real cycle is detected', () => {
  const dir = fixtures({ a: { extends: ['b'] }, b: { extends: ['a'] } });
  assert.throws(() => resolveProfile('a', { profilesDir: dir }), /cycle/);
});

test('unknown package → resolveToEdition throws', () => {
  const dir = fixtures({ p: { packages: ['nope'] } }, { other: { path: 'x' } });
  assert.throws(() => resolveToEdition('p', { profilesDir: dir }), /package index/);
});

test('missing profile throws', () => {
  assert.throws(() => resolveProfile('nope', { profilesDir: realProfiles }), /not found/);
});
