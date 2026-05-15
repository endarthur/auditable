// Cross-parser invariant test (§3.2) against ruamel.yaml.
//
// Every tag-free positive fixture must parse to the same data structure under
// ruamel.yaml's safe-typed loader (YAML 1.2) as under @gcu/yaml's strict
// parser. Shells out to python; skips cleanly if python or ruamel.yaml is
// missing.
//
// We use ruamel.yaml rather than PyYAML because PyYAML 6's safe_load defaults
// to YAML 1.1 resolvers, which mis-parse 1.2 octal `0o755` and unsigned float
// exponents `1.5e10` (treats them as strings). ruamel targets 1.2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parse } from '../ext/yaml/src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSITIVE_DIR = path.join(__dirname, '..', 'ext', 'yaml', 'test', 'fixtures', 'positive');
const HELPER = path.join(__dirname, '..', 'ext', 'yaml', 'test', '_ruamel_load.py');

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

// Probe for python + ruamel.yaml availability once at module load.
const probe = spawnSync('python', ['-c', 'from ruamel.yaml import YAML'], { encoding: 'utf8' });
const pyAvailable = probe.status === 0;

if (!pyAvailable) {
  test('cross-parser/ruamel — skipped (python or ruamel.yaml not available)',
    { skip: true }, () => {});
} else {
  const files = fs.readdirSync(POSITIVE_DIR).filter(f => f.endsWith('.yaml')).sort();
  for (const f of files) {
    const yamlPath = path.join(POSITIVE_DIR, f);
    const name = f.replace(/\.yaml$/, '');
    test(`cross-parser/ruamel/${name} — strict ≡ ruamel.yaml safe`, () => {
      const res = spawnSync('python', [HELPER, yamlPath], { encoding: 'utf8' });
      if (res.status !== 0) {
        assert.fail(`python helper failed (status ${res.status}): ${res.stderr.trim()}`);
      }
      const ruamelValue = JSON.parse(res.stdout);
      const strictValue = astToValue(parse(fs.readFileSync(yamlPath, 'utf8')));
      assert.ok(deepEqualUnordered(strictValue, ruamelValue),
        `divergence:\n  strict: ${JSON.stringify(strictValue)}\n  ruamel: ${JSON.stringify(ruamelValue)}`);
    });
  }
}
