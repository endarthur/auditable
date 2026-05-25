// @gcu/licenses — foundation tests (spdx parser + classify + format).
//
// Covers: SPDX 3.0 expression grammar, classification composition rules,
// formatter output shapes (text/html/spdx-bom/notices). No network, no VFS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSpdx, parseSpdx, isKnownSpdxId, SPDX_CORPUS, SPDX_KINDS,
  classify, classifyExpression,
  formatTable, formatNoticesFile,
} from '../ext/licenses/src/main.js';

// ── SPDX parser ──────────────────────────────────────────────────────────

test('spdx: bare id parses to id node', () => {
  const r = validateSpdx('MIT');
  assert.equal(r.valid, true);
  assert.deepEqual(r.ast, { kind: 'id', id: 'MIT' });
});

test('spdx: trims whitespace', () => {
  assert.equal(validateSpdx('  MIT  ').valid, true);
});

test('spdx: long ids with dots and dashes', () => {
  assert.equal(validateSpdx('GPL-3.0-or-later').valid, true);
  assert.equal(validateSpdx('BSD-3-Clause-Clear').valid, true);
});

test('spdx: OR expression', () => {
  const r = parseSpdx('MIT OR Apache-2.0');
  assert.equal(r.kind, 'or');
  assert.equal(r.terms.length, 2);
  assert.deepEqual(r.terms[0], { kind: 'id', id: 'MIT' });
  assert.deepEqual(r.terms[1], { kind: 'id', id: 'Apache-2.0' });
});

test('spdx: OR flattens left-associatively', () => {
  const r = parseSpdx('MIT OR Apache-2.0 OR BSD-3-Clause');
  assert.equal(r.kind, 'or');
  assert.equal(r.terms.length, 3);
});

test('spdx: AND expression', () => {
  const r = parseSpdx('MIT AND BSD-3-Clause');
  assert.equal(r.kind, 'and');
  assert.equal(r.terms.length, 2);
});

test('spdx: AND binds tighter than OR', () => {
  // "A OR B AND C" should parse as "A OR (B AND C)"
  const r = parseSpdx('MIT OR Apache-2.0 AND BSD-3-Clause');
  assert.equal(r.kind, 'or');
  assert.equal(r.terms.length, 2);
  assert.deepEqual(r.terms[0], { kind: 'id', id: 'MIT' });
  assert.equal(r.terms[1].kind, 'and');
});

test('spdx: parentheses override precedence', () => {
  const r = parseSpdx('(MIT OR Apache-2.0) AND BSD-3-Clause');
  assert.equal(r.kind, 'and');
  assert.equal(r.terms.length, 2);
  assert.equal(r.terms[0].kind, 'or');
});

test('spdx: WITH exception', () => {
  const r = parseSpdx('GPL-3.0-or-later WITH Classpath-exception-2.0');
  assert.equal(r.kind, 'with');
  assert.equal(r.exception, 'Classpath-exception-2.0');
  assert.deepEqual(r.term, { kind: 'id', id: 'GPL-3.0-or-later' });
});

test('spdx: plus suffix (deprecated or-later marker)', () => {
  const r = parseSpdx('GPL-2.0+');
  assert.equal(r.kind, 'plus');
  assert.deepEqual(r.term, { kind: 'id', id: 'GPL-2.0' });
});

test('spdx: WITH binds tighter than AND', () => {
  // "A AND B WITH X" should parse as "A AND (B WITH X)"
  const r = parseSpdx('MIT AND GPL-3.0-or-later WITH Classpath-exception-2.0');
  assert.equal(r.kind, 'and');
  assert.equal(r.terms[1].kind, 'with');
});

test('spdx: rejects garbage', () => {
  assert.equal(validateSpdx('').valid, false);
  assert.equal(validateSpdx('()').valid, false);
  assert.equal(validateSpdx('AND').valid, false);
  assert.equal(validateSpdx('MIT AND').valid, false);
  assert.equal(validateSpdx('MIT OR ()').valid, false);
  assert.equal(validateSpdx('MIT WITH').valid, false);
});

test('spdx: rejects npm anti-patterns', () => {
  assert.equal(validateSpdx('SEE LICENSE IN LICENSE.txt').valid, false);
  assert.equal(validateSpdx('UNLICENSED').valid, false);
  // case-insensitive on these markers
  assert.equal(validateSpdx('see license in COPYING').valid, false);
});

test('spdx: rejects non-string / null', () => {
  assert.equal(validateSpdx(null).valid, false);
  assert.equal(validateSpdx(undefined).valid, false);
  assert.equal(validateSpdx(42).valid, false);
});

test('spdx: parseSpdx throws on invalid', () => {
  assert.throws(() => parseSpdx('not a real expression !@#'));
});

test('spdx: corpus contains canonical ids', () => {
  assert.ok(SPDX_CORPUS['MIT']);
  assert.ok(SPDX_CORPUS['Apache-2.0']);
  assert.ok(SPDX_CORPUS['GPL-3.0-or-later']);
  assert.equal(SPDX_CORPUS['MIT'].kind, 'permissive');
  assert.equal(SPDX_CORPUS['GPL-3.0-or-later'].kind, 'strong-copyleft');
  assert.equal(SPDX_CORPUS['LGPL-3.0-only'].kind, 'weak-copyleft');
});

test('spdx: isKnownSpdxId accepts aliases', () => {
  assert.equal(isKnownSpdxId('MIT'), true);
  assert.equal(isKnownSpdxId('GPL-3.0'), true); // alias → GPL-3.0-or-later
  assert.equal(isKnownSpdxId('Apache'), true);
  assert.equal(isKnownSpdxId('NotARealLicense'), false);
});

// ── Classify ─────────────────────────────────────────────────────────────

test('classify: known permissive ids', () => {
  assert.equal(classify('MIT'), 'permissive');
  assert.equal(classify('Apache-2.0'), 'permissive');
  assert.equal(classify('BSD-3-Clause'), 'permissive');
  assert.equal(classify('ISC'), 'permissive');
});

test('classify: weak copyleft', () => {
  assert.equal(classify('LGPL-3.0-only'), 'weak-copyleft');
  assert.equal(classify('MPL-2.0'), 'weak-copyleft');
  assert.equal(classify('EPL-2.0'), 'weak-copyleft');
});

test('classify: strong copyleft', () => {
  assert.equal(classify('GPL-3.0-only'), 'strong-copyleft');
  assert.equal(classify('AGPL-3.0-or-later'), 'strong-copyleft');
});

test('classify: unknown / unrecognized', () => {
  assert.equal(classify('NotARealLicense-1.0'), 'unknown');
  assert.equal(classify(''), 'unknown');
  assert.equal(classify(null), 'unknown');
  assert.equal(classify(undefined), 'unknown');
  assert.equal(classify('SEE LICENSE IN LICENSE'), 'unknown');
});

test('classify: aliases resolve to canonical kind', () => {
  // GPL-3.0 → GPL-3.0-or-later (strong-copyleft)
  assert.equal(classify('GPL-3.0'), 'strong-copyleft');
  assert.equal(classify('LGPL-2.1'), 'weak-copyleft');
});

test('classify: OR takes most permissive', () => {
  assert.equal(classify('MIT OR GPL-3.0-or-later'), 'permissive');
  assert.equal(classify('LGPL-3.0-only OR GPL-3.0-or-later'), 'weak-copyleft');
  assert.equal(classify('GPL-3.0-or-later OR AGPL-3.0-or-later'), 'strong-copyleft');
});

test('classify: AND takes most restrictive', () => {
  assert.equal(classify('MIT AND GPL-3.0-or-later'), 'strong-copyleft');
  assert.equal(classify('MIT AND BSD-3-Clause'), 'permissive');
  assert.equal(classify('LGPL-3.0-only AND MPL-2.0'), 'weak-copyleft');
});

test('classify: OR with unknown picks the known permissive', () => {
  assert.equal(classify('MIT OR SomeUnknown-1.0'), 'permissive');
});

test('classify: AND with unknown is unknown', () => {
  assert.equal(classify('MIT AND SomeUnknown-1.0'), 'unknown');
});

test('classify: WITH preserves base kind', () => {
  assert.equal(
    classify('GPL-3.0-or-later WITH Classpath-exception-2.0'),
    'strong-copyleft'
  );
  assert.equal(
    classify('MIT WITH Some-Exception'),
    'permissive'
  );
});

test('classify: plus preserves base kind', () => {
  assert.equal(classify('GPL-2.0+'), 'strong-copyleft');
});

test('classify: precedence — A OR B AND C → A OR (B AND C)', () => {
  // (MIT) OR (GPL-3 AND AGPL-3) → max-of-(strong, strong) inside AND = strong
  //                              → min-of-(perm, strong) outside OR = permissive
  assert.equal(
    classify('MIT OR GPL-3.0-or-later AND AGPL-3.0-or-later'),
    'permissive'
  );
});

test('classify: nested parens', () => {
  assert.equal(
    classify('(MIT OR Apache-2.0) AND BSD-3-Clause'),
    'permissive'
  );
});

test('classifyExpression: works on pre-parsed AST', () => {
  const ast = parseSpdx('MIT OR GPL-3.0-or-later');
  assert.equal(classifyExpression(ast), 'permissive');
});

// ── Format: text ─────────────────────────────────────────────────────────

const SAMPLE_TABLE = [
  { pkg: 'lodash', version: '4.17.21', source: 'install',
    spdx: 'MIT', classification: 'permissive' },
  { pkg: 'some-pkg', version: '1.0.0', source: 'pkg/npm',
    spdx: 'LGPL-3.0-only', classification: 'weak-copyleft' },
  { pkg: 'ai-fork', version: '0.1.0', source: 'install',
    spdx: 'GPL-3.0-or-later', classification: 'strong-copyleft' },
  { pkg: 'scratch-mod', source: 'install',
    spdx: 'UNKNOWN', classification: 'unknown' },
];

test('formatTable: text mode produces aligned columns', () => {
  const out = formatTable(SAMPLE_TABLE, { format: 'text' });
  const lines = out.split('\n');
  assert.ok(lines[0].includes('Package'));
  assert.ok(lines[0].includes('SPDX'));
  assert.ok(lines[0].includes('Source'));
  assert.ok(lines[0].includes('Status'));
  assert.ok(lines[1].startsWith('-'));
  // Each data line should be the same width as the header
  const w = lines[0].length;
  for (let i = 2; i < lines.length; i++) {
    assert.ok(lines[i].length >= 'lodash@4.17.21'.length, `line ${i} too short`);
  }
  assert.ok(out.includes('lodash@4.17.21'));
  assert.ok(out.includes('LGPL-3.0-only'));
  assert.ok(out.includes('strong copyleft'));
  assert.ok(out.includes('no license'));
});

test('formatTable: text mode handles bare-name (no version)', () => {
  const out = formatTable([{ pkg: 'scratch', source: 'install', spdx: 'MIT', classification: 'permissive' }], { format: 'text' });
  assert.ok(out.includes('scratch'));
  assert.ok(!out.includes('scratch@'));
});

// ── Format: html ─────────────────────────────────────────────────────────

test('formatTable: html mode produces escaped table', () => {
  const out = formatTable(SAMPLE_TABLE, { format: 'html' });
  assert.ok(out.startsWith('<table'));
  assert.ok(out.endsWith('</table>'));
  assert.ok(out.includes('<thead>'));
  assert.ok(out.includes('<tbody>'));
  assert.ok(out.includes('lic-ok'));
  assert.ok(out.includes('lic-warn'));
  assert.ok(out.includes('lic-danger'));
  assert.ok(out.includes('lic-unknown'));
});

test('formatTable: html escapes user content', () => {
  const out = formatTable([
    { pkg: '<script>', version: '1.0', source: 'install',
      spdx: '"MIT"', classification: 'permissive' }
  ], { format: 'html' });
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('&quot;MIT&quot;'));
});

// ── Format: spdx-bom ─────────────────────────────────────────────────────

test('formatTable: spdx-bom shape', () => {
  const doc = formatTable(SAMPLE_TABLE, { format: 'spdx-bom' });
  assert.equal(doc.spdxVersion, 'SPDX-2.3');
  assert.equal(doc.dataLicense, 'CC0-1.0');
  assert.equal(doc.SPDXID, 'SPDXRef-DOCUMENT');
  assert.ok(doc.documentNamespace);
  assert.ok(doc.creationInfo.created);
  assert.equal(doc.packages.length, SAMPLE_TABLE.length);
  for (const p of doc.packages) {
    assert.match(p.SPDXID, /^SPDXRef-Package-[A-Za-z0-9.\-]+$/);
    assert.ok(p.name);
    assert.ok(p.licenseDeclared);
    assert.equal(p.filesAnalyzed, false);
  }
  // Unknown spdx maps to NOASSERTION
  const unknownPkg = doc.packages.find((p) => p.name === 'scratch-mod');
  assert.equal(unknownPkg.licenseDeclared, 'NOASSERTION');
});

test('formatTable: spdx-bom relationships describe each package', () => {
  const doc = formatTable(SAMPLE_TABLE, { format: 'spdx-bom' });
  assert.equal(doc.relationships.length, SAMPLE_TABLE.length);
  for (const r of doc.relationships) {
    assert.equal(r.spdxElementId, 'SPDXRef-DOCUMENT');
    assert.equal(r.relationshipType, 'DESCRIBES');
  }
});

test('formatTable: rejects unknown format', () => {
  assert.throws(() => formatTable(SAMPLE_TABLE, { format: 'nope' }));
});

test('formatTable: rejects non-array input', () => {
  assert.throws(() => formatTable({ not: 'array' }));
});

// ── Format: notices file ─────────────────────────────────────────────────

test('formatNoticesFile: includes each entry + license text', () => {
  const table = [
    { pkg: 'lodash', version: '4.17.21', source: 'install',
      spdx: 'MIT', classification: 'permissive',
      text: 'Copyright (c) OpenJS Foundation\n\nPermission is hereby granted...',
      copyright: 'Copyright (c) OpenJS Foundation',
      fetchedFrom: 'https://esm.sh/lodash@4.17.21/LICENSE' },
  ];
  const out = formatNoticesFile(table);
  assert.ok(out.startsWith('Third-party notices'));
  assert.ok(out.includes('lodash@4.17.21'));
  assert.ok(out.includes('License: MIT'));
  assert.ok(out.includes('Origin: https://esm.sh/lodash@4.17.21/LICENSE'));
  assert.ok(out.includes('Permission is hereby granted'));
});

test('formatNoticesFile: missing license text falls back to placeholder', () => {
  const out = formatNoticesFile([
    { pkg: 'no-license-pkg', source: 'install', spdx: 'UNKNOWN', classification: 'unknown' }
  ]);
  assert.ok(out.includes('(No license text captured.)'));
});

test('formatNoticesFile: custom intro', () => {
  const out = formatNoticesFile([], { intro: 'CUSTOM INTRO HERE\n' });
  assert.equal(out, 'CUSTOM INTRO HERE\n');
});

test('formatNoticesFile: rejects non-array input', () => {
  assert.throws(() => formatNoticesFile(null));
});
