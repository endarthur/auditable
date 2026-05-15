// Cross-parser invariant test (§3.2): every tag-free positive fixture must
// parse to the same data structure under js-yaml's default loader as under
// @gcu/yaml's strict parser.
//
// This is the load-bearing test for the spec's tag-free fragment. A divergence
// here means either the spec is wrong, our parser is wrong, or our fixture is
// not actually a conforming tag-free document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { parse } from '../ext/yaml/src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIVE_DIR = path.join(__dirname, '..', 'ext', 'yaml', 'test', 'fixtures', 'positive');

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
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
  }
  return false;
}

if (!fs.existsSync(POSITIVE_DIR)) {
  test('cross-parser — positive fixtures present', () => {
    assert.fail(`fixture dir ${POSITIVE_DIR} not found`);
  });
} else {
  const files = fs.readdirSync(POSITIVE_DIR).filter(f => f.endsWith('.yaml')).sort();
  for (const f of files) {
    const yamlPath = path.join(POSITIVE_DIR, f);
    const name = f.replace(/\.yaml$/, '');
    test(`cross-parser/${name} — strict ≡ js-yaml`, () => {
      const src = fs.readFileSync(yamlPath, 'utf8');
      const strictValue = astToValue(parse(src));
      const jsValue = yaml.load(src);
      assert.ok(deepEqualUnordered(strictValue, jsValue),
        `divergence:\n  strict: ${JSON.stringify(strictValue)}\n  js-yaml: ${JSON.stringify(jsValue)}`);
    });
  }
}
