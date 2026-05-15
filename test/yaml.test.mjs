// Fixture-driven test runner for @gcu/yaml.
// Tests dispatched by sidecar suffix:
//   *.expected.json       — tag-free positive: parse → compare to JSON expected
//   *.expected.yaml       — tagged positive: parse → emit → compare bytes
//   *.expected.error.json — negative: parse should throw matching error

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, emit, check } from '../ext/yaml/src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, '..', 'ext', 'yaml', 'test', 'fixtures');

// ---- Helpers -------------------------------------------------------------

// Convert AST to plain JS value (drops tags, comments, type hints).
function astToValue(node) {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'map') {
    const o = {};
    for (const e of node.entries) o[e.key.value] = astToValue(e.value);
    return o;
  }
  if (node.kind === 'seq') return node.items.map(astToValue);
  throw new Error('unknown kind: ' + node.kind);
}

// Unordered structural comparison (per §3.2).
function deepEqualUnordered(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualUnordered(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    if (typeof b !== 'object' || Array.isArray(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in b)) return false;
      if (!deepEqualUnordered(a[k], b[k])) return false;
    }
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    // Tolerate NaN comparisons defensively (shouldn't appear since the spec
    // forbids NaN scalars, but JSON could in principle).
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
  }
  return false;
}

function listFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.yaml') && !f.endsWith('.expected.yaml')) {
      out.push(path.join(dir, f));
    }
  }
  return out.sort();
}

// ---- Tag-free positive ---------------------------------------------------

const tagFreeDir = path.join(FIXTURE_ROOT, 'positive');
for (const yamlPath of listFixtures(tagFreeDir)) {
  const name = path.basename(yamlPath, '.yaml');
  const expPath = yamlPath.replace(/\.yaml$/, '.expected.json');
  if (!fs.existsSync(expPath)) continue;

  test(`positive/${name} — parse matches expected JSON`, () => {
    const src = fs.readFileSync(yamlPath, 'utf8');
    const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const ast = parse(src);
    const value = astToValue(ast);
    assert.ok(deepEqualUnordered(value, expected),
      `expected ${JSON.stringify(expected)} got ${JSON.stringify(value)}`);
  });

  test(`positive/${name} — round-trip is idempotent`, () => {
    const src = fs.readFileSync(yamlPath, 'utf8');
    const emit1 = emit(parse(src));
    const emit2 = emit(parse(emit1));
    assert.equal(emit2, emit1, 'second emit must match first emit byte-for-byte');
    const v1 = astToValue(parse(emit1));
    const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    assert.ok(deepEqualUnordered(v1, expected),
      'round-tripped value must still match expected JSON');
  });
}

// ---- Tagged positive -----------------------------------------------------

const taggedDir = path.join(FIXTURE_ROOT, 'tagged');
for (const yamlPath of listFixtures(taggedDir)) {
  const name = path.basename(yamlPath, '.yaml');
  const expPath = yamlPath.replace(/\.yaml$/, '.expected.yaml');
  if (!fs.existsSync(expPath)) continue;

  test(`tagged/${name} — parse + emit matches canonical YAML`, () => {
    const src = fs.readFileSync(yamlPath, 'utf8');
    const expected = fs.readFileSync(expPath, 'utf8');
    const out = emit(parse(src));
    assert.equal(out, expected);
  });

  test(`tagged/${name} — round-trip is idempotent`, () => {
    const src = fs.readFileSync(yamlPath, 'utf8');
    const emit1 = emit(parse(src));
    const emit2 = emit(parse(emit1));
    assert.equal(emit2, emit1);
  });
}

// ---- Negative ------------------------------------------------------------

const negativeDir = path.join(FIXTURE_ROOT, 'negative');
for (const yamlPath of listFixtures(negativeDir)) {
  const name = path.basename(yamlPath, '.yaml');
  const expPath = yamlPath.replace(/\.yaml$/, '.expected.error.json');
  if (!fs.existsSync(expPath)) continue;

  test(`negative/${name} — parse rejects with expected error`, () => {
    const src = fs.readFileSync(yamlPath, 'utf8');
    const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const err = check(src);
    assert.ok(err, `expected parse to fail, but it succeeded`);
    assert.equal(err.rule, expected.rule, `rule mismatch (expected ${expected.rule}, got ${err.rule})`);
    assert.equal(err.line, expected.line, `line mismatch`);
    assert.equal(err.column, expected.column, `column mismatch`);
  });
}
