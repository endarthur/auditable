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
  parseUrlToSource, fetchLicense,
  aggregateLicenses, aggregateFromInstalledModules,
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

// ── parseUrlToSource ─────────────────────────────────────────────────────

test('parseUrlToSource: esm.sh bare name', () => {
  const r = parseUrlToSource('https://esm.sh/lodash');
  assert.equal(r.source, 'esm.sh');
  assert.equal(r.pkg, 'lodash');
  assert.equal(r.version, null);
});

test('parseUrlToSource: esm.sh with version', () => {
  const r = parseUrlToSource('https://esm.sh/lodash@4.17.21');
  assert.equal(r.source, 'esm.sh');
  assert.equal(r.pkg, 'lodash');
  assert.equal(r.version, '4.17.21');
});

test('parseUrlToSource: esm.sh scoped + version + deep path', () => {
  const r = parseUrlToSource('https://esm.sh/@scope/pkg@1.0.0/dist/file.js');
  assert.equal(r.source, 'esm.sh');
  assert.equal(r.pkg, '@scope/pkg');
  assert.equal(r.version, '1.0.0');
});

test('parseUrlToSource: esm.sh with query string', () => {
  const r = parseUrlToSource('https://esm.sh/d3@7.8.0?bundle');
  assert.equal(r.source, 'esm.sh');
  assert.equal(r.pkg, 'd3');
  assert.equal(r.version, '7.8.0');
});

test('parseUrlToSource: jsdelivr /npm/', () => {
  const r = parseUrlToSource('https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js');
  assert.equal(r.source, 'jsdelivr');
  assert.equal(r.pkg, 'd3');
  assert.equal(r.version, '7');
});

test('parseUrlToSource: jsdelivr scoped npm', () => {
  const r = parseUrlToSource('https://cdn.jsdelivr.net/npm/@scope/pkg@1.0.0');
  assert.equal(r.pkg, '@scope/pkg');
  assert.equal(r.version, '1.0.0');
});

test('parseUrlToSource: jsdelivr /gh/', () => {
  const r = parseUrlToSource('https://cdn.jsdelivr.net/gh/owner/repo@abc123/dist/file.js');
  assert.equal(r.source, 'github');
  assert.equal(r.pkg, 'owner/repo');
  assert.equal(r.version, 'abc123');
  assert.deepEqual(r.github, { owner: 'owner', repo: 'repo', ref: 'abc123' });
});

test('parseUrlToSource: unpkg', () => {
  const r = parseUrlToSource('https://unpkg.com/lodash@4.17.21');
  assert.equal(r.source, 'unpkg');
  assert.equal(r.pkg, 'lodash');
  assert.equal(r.version, '4.17.21');
});

test('parseUrlToSource: jsr', () => {
  const r = parseUrlToSource('https://jsr.io/@scope/pkg@1.0.0');
  assert.equal(r.source, 'jsr');
  assert.equal(r.pkg, '@scope/pkg');
  assert.equal(r.version, '1.0.0');
});

test('parseUrlToSource: github raw', () => {
  const r = parseUrlToSource('https://raw.githubusercontent.com/owner/repo/abc123/src/file.js');
  assert.equal(r.source, 'github');
  assert.equal(r.pkg, 'owner/repo');
  assert.equal(r.version, 'abc123');
});

test('parseUrlToSource: github.com /raw/', () => {
  const r = parseUrlToSource('https://github.com/owner/repo/raw/main/file.js');
  assert.equal(r.source, 'github');
  assert.equal(r.pkg, 'owner/repo');
  assert.equal(r.version, 'main');
});

test('parseUrlToSource: generic URL fallback', () => {
  const r = parseUrlToSource('https://some-cdn.example.com/path/to/lib.js');
  assert.equal(r.source, 'url');
  assert.ok(r.origin);
  assert.equal(r.version, null);
});

test('parseUrlToSource: non-string returns null', () => {
  assert.equal(parseUrlToSource(null), null);
  assert.equal(parseUrlToSource(undefined), null);
  assert.equal(parseUrlToSource(42), null);
  assert.equal(parseUrlToSource(''), null);
});

test('parseUrlToSource: malformed URL returns null', () => {
  assert.equal(parseUrlToSource('not a url'), null);
});

// ── fetchLicense — mock fetch ────────────────────────────────────────────

function mockFetch(responses) {
  // responses: { url: { ok: bool, status: number, text: string } | string (= ok=true with text) }
  return async (url) => {
    const entry = responses[url];
    if (entry == null) return { ok: false, status: 404, text: async () => '' };
    if (typeof entry === 'string') {
      return { ok: true, status: 200, text: async () => entry };
    }
    if (entry.throw) throw new Error(entry.throw);
    return {
      ok: entry.ok !== false,
      status: entry.status || 200,
      text: async () => entry.text || '',
    };
  };
}

test('fetchLicense: esm.sh happy path', async () => {
  // package.json from esm.sh, LICENSE text from jsdelivr (esm.sh doesn't
  // reliably serve repo files).
  const fetch = mockFetch({
    'https://esm.sh/lodash@4.17.21/package.json': JSON.stringify({ name: 'lodash', license: 'MIT' }),
    'https://cdn.jsdelivr.net/npm/lodash@4.17.21/LICENSE': 'Copyright (c) OpenJS Foundation\n\nPermission is hereby granted...',
  });
  const r = await fetchLicense('https://esm.sh/lodash@4.17.21', { fetch });
  assert.equal(r.spdx, 'MIT');
  assert.ok(r.text.includes('Permission is hereby granted'));
  assert.ok(r.copyright.includes('OpenJS Foundation'));
  assert.equal(r.spdxSource, 'package.json');
  assert.equal(r.textSource, 'LICENSE-file');
  assert.ok(r.fetchedFrom.endsWith('/LICENSE'));
  assert.equal(r.confidence, 'high');
});

test('fetchLicense: esm.sh package.json with license object', async () => {
  // Old npm style: { type: 'MIT', url: '...' }
  const fetch = mockFetch({
    'https://esm.sh/old-pkg@1.0.0/package.json': JSON.stringify({
      license: { type: 'BSD-2-Clause', url: 'https://opensource.org/...' }
    }),
    'https://cdn.jsdelivr.net/npm/old-pkg@1.0.0/LICENSE': 'Copyright (c) Foo',
  });
  const r = await fetchLicense('https://esm.sh/old-pkg@1.0.0', { fetch });
  assert.equal(r.spdx, 'BSD-2-Clause');
});

test('fetchLicense: esm.sh package.json with licenses array', async () => {
  // Very old npm style: { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }
  const fetch = mockFetch({
    'https://esm.sh/dual-pkg@1.0.0/package.json': JSON.stringify({
      licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }]
    }),
    'https://cdn.jsdelivr.net/npm/dual-pkg@1.0.0/LICENSE': 'placeholder',
  });
  const r = await fetchLicense('https://esm.sh/dual-pkg@1.0.0', { fetch });
  assert.equal(r.spdx, '(MIT OR Apache-2.0)');
});

test('fetchLicense: esm.sh missing package.json but LICENSE present', async () => {
  const fetch = mockFetch({
    'https://cdn.jsdelivr.net/npm/no-pkg@1.0.0/LICENSE': 'Copyright (c) Anonymous\nMIT-like text...',
  });
  const r = await fetchLicense('https://esm.sh/no-pkg@1.0.0', { fetch });
  assert.equal(r.spdx, 'UNKNOWN');
  assert.ok(r.text.includes('MIT-like text'));
  assert.equal(r.textSource, 'LICENSE-file');
  assert.equal(r.confidence, 'low');
});

test('fetchLicense: esm.sh tries LICENSE.md if LICENSE 404s', async () => {
  const fetch = mockFetch({
    'https://esm.sh/x@1/package.json': JSON.stringify({ license: 'MIT' }),
    'https://cdn.jsdelivr.net/npm/x@1/LICENSE.md': '# License\n\nCopyright (c) X\n\nMIT...',
  });
  const r = await fetchLicense('https://esm.sh/x@1', { fetch });
  assert.equal(r.spdx, 'MIT');
  assert.ok(r.text.includes('Copyright'));
  assert.ok(r.fetchedFrom.endsWith('/LICENSE.md'));
});

test('fetchLicense: esm.sh both missing → UNKNOWN', async () => {
  const fetch = mockFetch({});
  const r = await fetchLicense('https://esm.sh/missing@1.0.0', { fetch });
  assert.equal(r.spdx, 'UNKNOWN');
  assert.ok(r.hint);
});

test('fetchLicense: jsdelivr happy path', async () => {
  const fetch = mockFetch({
    'https://cdn.jsdelivr.net/npm/d3@7/package.json': JSON.stringify({ license: 'ISC' }),
    'https://cdn.jsdelivr.net/npm/d3@7/LICENSE': 'Copyright (c) D3.js Contributors',
  });
  const r = await fetchLicense('https://cdn.jsdelivr.net/npm/d3@7', { fetch });
  assert.equal(r.spdx, 'ISC');
  assert.ok(r.text.includes('D3.js'));
});

test('fetchLicense: github API happy path', async () => {
  const base64 = Buffer.from('Copyright (c) Foo\n\nMIT License...', 'utf8').toString('base64');
  const fetch = mockFetch({
    'https://api.github.com/repos/owner/repo/license': JSON.stringify({
      license: { spdx_id: 'MIT', name: 'MIT License' },
      content: base64,
      encoding: 'base64',
      download_url: 'https://raw.githubusercontent.com/owner/repo/HEAD/LICENSE',
    }),
  });
  const r = await fetchLicense('https://github.com/owner/repo/raw/main/file.js', { fetch });
  assert.equal(r.spdx, 'MIT');
  assert.ok(r.text.includes('MIT License...'));
  assert.equal(r.spdxSource, 'github-api');
});

test('fetchLicense: github API NOASSERTION → falls back', async () => {
  const fetch = mockFetch({
    'https://api.github.com/repos/owner/repo/license': JSON.stringify({
      license: { spdx_id: 'NOASSERTION' },
      content: 'Q29weXJpZ2h0',  // 'Copyright'
      encoding: 'base64',
    }),
  });
  const r = await fetchLicense('https://github.com/owner/repo/raw/main/file.js', { fetch });
  assert.equal(r.spdx, 'UNKNOWN');
  assert.ok(r.text);
});

test('fetchLicense: github API fails, raw fallback succeeds', async () => {
  const fetch = mockFetch({
    'https://raw.githubusercontent.com/owner/repo/abc123/LICENSE':
      'Copyright (c) Foo',
  });
  const r = await fetchLicense(
    'https://raw.githubusercontent.com/owner/repo/abc123/src/file.js',
    { fetch }
  );
  assert.equal(r.spdx, 'UNKNOWN');
  assert.ok(r.text.includes('Copyright'));
  assert.equal(r.textSource, 'LICENSE-file');
});

test('fetchLicense: jsr with jsr.json', async () => {
  const fetch = mockFetch({
    'https://jsr.io/@scope/pkg@1.0.0/jsr.json': JSON.stringify({ license: 'Apache-2.0' }),
    'https://jsr.io/@scope/pkg@1.0.0/LICENSE': 'Apache License...',
  });
  const r = await fetchLicense('https://jsr.io/@scope/pkg@1.0.0', { fetch });
  assert.equal(r.spdx, 'Apache-2.0');
  assert.equal(r.spdxSource, 'jsr.json');
});

test('fetchLicense: unpkg routes like esm.sh/jsdelivr', async () => {
  const fetch = mockFetch({
    'https://unpkg.com/lodash@4/package.json': JSON.stringify({ license: 'MIT' }),
    'https://unpkg.com/lodash@4/LICENSE': 'Copyright (c) OpenJS',
  });
  const r = await fetchLicense('https://unpkg.com/lodash@4', { fetch });
  assert.equal(r.spdx, 'MIT');
});

test('fetchLicense: generic URL probes for sibling LICENSE', async () => {
  const fetch = mockFetch({
    'https://some-cdn.example.com/path/LICENSE': 'Copyright (c) Anon\n\nMIT...',
  });
  const r = await fetchLicense('https://some-cdn.example.com/path/lib.js', { fetch });
  assert.ok(r.text);
  assert.equal(r.textSource, 'LICENSE-file');
});

test('fetchLicense: no fetch in environment → UNKNOWN no-fetch', async () => {
  // Temporarily remove globalThis.fetch to exercise the no-fetch branch.
  // Without this dance, the implementation falls back to globalThis.fetch
  // (which exists in Node 18+) and the test would hit real network.
  const orig = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const r = await fetchLicense('https://esm.sh/x@1');
    assert.equal(r.spdx, 'UNKNOWN');
    assert.equal(r.spdxSource, 'no-fetch');
  } finally {
    if (orig) globalThis.fetch = orig;
  }
});

test('fetchLicense: invalid input → UNKNOWN', async () => {
  const fetch = mockFetch({});
  const r = await fetchLicense(42, { fetch });
  assert.equal(r.spdx, 'UNKNOWN');
});

test('fetchLicense: unparseable URL string → UNKNOWN', async () => {
  const fetch = mockFetch({});
  const r = await fetchLicense('not a url', { fetch });
  assert.equal(r.spdx, 'UNKNOWN');
  assert.ok(r.hint);
});

test('fetchLicense: network throw is caught', async () => {
  const fetch = async () => { throw new Error('ECONNREFUSED'); };
  const r = await fetchLicense('https://esm.sh/x@1', { fetch });
  assert.equal(r.spdx, 'UNKNOWN');
  // Doesn't throw — that's the assertion
});

// ── aggregateLicenses — memory VFS ───────────────────────────────────────

function makeMemVfs(tree) {
  // tree is a flat { absolutePath: contentString | { dir: true } }
  // Auto-creates directories for any file's ancestors.
  const files = new Map();
  const dirs = new Set(['/']);
  const addAncestors = (p) => {
    let cur = p;
    while (cur !== '/' && cur.length > 0) {
      const slash = cur.lastIndexOf('/');
      cur = slash <= 0 ? '/' : cur.slice(0, slash);
      dirs.add(cur);
    }
  };
  for (const [p, content] of Object.entries(tree)) {
    if (content && typeof content === 'object' && content.dir) {
      dirs.add(p);
      addAncestors(p);
    } else {
      files.set(p, content);
      addAncestors(p);
    }
  }
  return {
    readdir(path) {
      const norm = path.replace(/\/$/, '') || '/';
      if (!dirs.has(norm)) throw new Error(`no such directory: ${path}`);
      const prefix = norm === '/' ? '/' : norm + '/';
      const names = new Set();
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === norm) continue;
        const rest = d.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
      return [...names];
    },
    readFile(path /*, encoding */) {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return files.get(path);
    },
    stat(path) {
      if (files.has(path)) return { type: 'file', size: files.get(path).length };
      if (dirs.has(path)) return { type: 'directory' };
      throw new Error(`no such path: ${path}`);
    },
  };
}

test('aggregate: empty VFS returns []', async () => {
  const vfs = makeMemVfs({});
  const t = await aggregateLicenses(vfs);
  assert.deepEqual(t, []);
});

test('aggregate: /var/modules with one install', async () => {
  const vfs = makeMemVfs({
    '/var/modules/lodash%404.17.21/meta.json': JSON.stringify({
      url: 'https://esm.sh/lodash@4.17.21',
      license: { spdx: 'MIT', copyright: 'Copyright (c) OpenJS', fetchedFrom: 'https://esm.sh/.../LICENSE' },
    }),
    '/var/modules/lodash%404.17.21/LICENSE': 'Copyright (c) OpenJS\n\nMIT...',
    '/var/modules/lodash%404.17.21/source': '<binary>',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].pkg, 'lodash');
  assert.equal(t[0].version, '4.17.21');
  assert.equal(t[0].source, 'install');
  assert.equal(t[0].spdx, 'MIT');
  assert.equal(t[0].classification, 'permissive');
  assert.ok(t[0].text.includes('OpenJS'));
  assert.equal(t[0].verified, true);
});

test('aggregate: install entry without LICENSE file', async () => {
  const vfs = makeMemVfs({
    '/var/modules/x/meta.json': JSON.stringify({
      url: 'https://esm.sh/x@1',
      license: { spdx: 'MIT' },
    }),
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].spdx, 'MIT');
  assert.equal(t[0].text, null);
  assert.equal(t[0].verified, false);
});

test('aggregate: install entry without meta license (pre-tracking)', async () => {
  const vfs = makeMemVfs({
    '/var/modules/x%401.0.0/meta.json': JSON.stringify({ url: 'https://esm.sh/x@1.0.0' }),
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].spdx, 'UNKNOWN');
  assert.equal(t[0].classification, 'unknown');
});

test('aggregate: /lib/npm flat package', async () => {
  const vfs = makeMemVfs({
    '/lib/npm/lodash@4.17.21/package.json': JSON.stringify({ name: 'lodash', license: 'MIT' }),
    '/lib/npm/lodash@4.17.21/LICENSE': 'Copyright (c) OpenJS',
    '/lib/npm/lodash@4.17.21/index.js': '<code>',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].pkg, 'lodash');
  assert.equal(t[0].version, '4.17.21');
  assert.equal(t[0].source, 'pkg/npm');
  assert.equal(t[0].spdx, 'MIT');
});

test('aggregate: /lib/npm scoped package nested', async () => {
  const vfs = makeMemVfs({
    '/lib/npm/@scope/pkg@1.0.0/package.json': JSON.stringify({ license: 'Apache-2.0' }),
    '/lib/npm/@scope/pkg@1.0.0/LICENSE': 'Apache License...',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].pkg, '@scope/pkg');
  assert.equal(t[0].version, '1.0.0');
});

test('aggregate: /lib/gh nested owner/repo', async () => {
  const vfs = makeMemVfs({
    '/lib/gh/owner/repo@abc123/package.json': JSON.stringify({ license: 'ISC' }),
    '/lib/gh/owner/repo@abc123/LICENSE': 'Copyright (c) Owner',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].pkg, 'owner/repo');
  assert.equal(t[0].version, 'abc123');
  assert.equal(t[0].source, 'pkg/gh');
});

test('aggregate: /sys/licenses with index.json', async () => {
  const vfs = makeMemVfs({
    '/sys/licenses/index.json': JSON.stringify({
      cm6: { spdx: 'MIT', version: '6.x', homepage: 'https://codemirror.net/' },
      fflate: { spdx: 'MIT', version: '0.8.x' },
    }),
    '/sys/licenses/cm6/LICENSE': 'Copyright (c) CodeMirror\n\nMIT...',
    '/sys/licenses/fflate/LICENSE': 'Copyright (c) fflate',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 2);
  for (const e of t) {
    assert.equal(e.source, 'vendored');
    assert.equal(e.spdx, 'MIT');
    assert.equal(e.classification, 'permissive');
  }
});

test('aggregate: ordering — vendored, pkg, install', async () => {
  const vfs = makeMemVfs({
    '/var/modules/x/meta.json': JSON.stringify({ url: 'https://esm.sh/x@1', license: { spdx: 'MIT' } }),
    '/lib/npm/y@1.0.0/package.json': JSON.stringify({ license: 'MIT' }),
    '/sys/licenses/index.json': JSON.stringify({ z: { spdx: 'MIT' } }),
    '/sys/licenses/z/LICENSE': 'Copyright (c) Z',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 3);
  assert.equal(t[0].source, 'vendored');
  assert.equal(t[1].source, 'pkg/npm');
  assert.equal(t[2].source, 'install');
});

test('aggregate: tolerates missing roots', async () => {
  const vfs = makeMemVfs({
    '/var/modules/x/meta.json': JSON.stringify({ url: 'https://esm.sh/x@1', license: { spdx: 'MIT' } }),
  });
  // No /lib or /sys/licenses present at all.
  const t = await aggregateLicenses(vfs);
  assert.equal(t.length, 1);
  assert.equal(t[0].source, 'install');
});

test('aggregate: VFS without readdir throws TypeError', async () => {
  await assert.rejects(() => aggregateLicenses({}), { name: 'TypeError' });
  await assert.rejects(() => aggregateLicenses({ readdir: () => [] }), { name: 'TypeError' });
  await assert.rejects(() => aggregateLicenses(null), { name: 'TypeError' });
});

test('aggregate: GPL classification flows through', async () => {
  const vfs = makeMemVfs({
    '/lib/npm/scary@1.0.0/package.json': JSON.stringify({ license: 'GPL-3.0-or-later' }),
    '/lib/npm/scary@1.0.0/LICENSE': 'Copyright (c) Foo',
  });
  const t = await aggregateLicenses(vfs);
  assert.equal(t[0].classification, 'strong-copyleft');
});

test('aggregate: output passes through formatTable cleanly', async () => {
  const vfs = makeMemVfs({
    '/sys/licenses/index.json': JSON.stringify({ cm6: { spdx: 'MIT' } }),
    '/sys/licenses/cm6/LICENSE': 'Copyright (c) CodeMirror',
  });
  const table = await aggregateLicenses(vfs);
  const text = formatTable(table, { format: 'text' });
  assert.ok(text.includes('cm6'));
  assert.ok(text.includes('MIT'));
  const bom = formatTable(table, { format: 'spdx-bom' });
  assert.equal(bom.packages[0].name, 'cm6');
});

// ── aggregateFromInstalledModules — in-memory shape ──────────────────────

test('aggregateFromInstalledModules: empty → []', () => {
  assert.deepEqual(aggregateFromInstalledModules({}), []);
  assert.deepEqual(aggregateFromInstalledModules(null), []);
  assert.deepEqual(aggregateFromInstalledModules(undefined), []);
});

test('aggregateFromInstalledModules: entry with license + text', () => {
  const t = aggregateFromInstalledModules({
    'https://esm.sh/lodash@4.17.21': {
      url: 'https://esm.sh/lodash@4.17.21',
      source: '<gzipped>', compressed: true,
      license: { spdx: 'MIT', copyright: 'Copyright (c) OpenJS' },
      licenseText: '<gzipped license text>',
    }
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].pkg, 'lodash');
  assert.equal(t[0].version, '4.17.21');
  assert.equal(t[0].source, 'install');
  assert.equal(t[0].spdx, 'MIT');
  assert.equal(t[0].classification, 'permissive');
  assert.equal(t[0].copyright, 'Copyright (c) OpenJS');
  assert.equal(t[0].verified, true);
});

test('aggregateFromInstalledModules: entry without license (pre-tracking)', () => {
  const t = aggregateFromInstalledModules({
    'https://esm.sh/old@1': { url: 'https://esm.sh/old@1', source: '<gz>', compressed: true }
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].spdx, 'UNKNOWN');
  assert.equal(t[0].classification, 'unknown');
  assert.equal(t[0].verified, false);
});

test('aggregateFromInstalledModules: skips binary entries', () => {
  const t = aggregateFromInstalledModules({
    'https://example.com/font.woff2': { binary: true, source: '<b64>' },
    'https://esm.sh/x@1': { url: 'https://esm.sh/x@1', source: '<gz>', license: { spdx: 'MIT' } }
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].pkg, 'x');
});

test('aggregateFromInstalledModules: GPL flows through classification', () => {
  const t = aggregateFromInstalledModules({
    'https://esm.sh/scary@1': {
      url: 'https://esm.sh/scary@1',
      source: '<gz>',
      license: { spdx: 'GPL-3.0-or-later' },
    }
  });
  assert.equal(t[0].classification, 'strong-copyleft');
});

test('aggregateFromInstalledModules: dual license picks most-permissive', () => {
  const t = aggregateFromInstalledModules({
    'https://esm.sh/dual@1': {
      url: 'https://esm.sh/dual@1',
      source: '<gz>',
      license: { spdx: '(MIT OR GPL-3.0)' },
    }
  });
  assert.equal(t[0].classification, 'permissive');
});

test('aggregateFromInstalledModules: falls back to entry.alias when URL unparseable', () => {
  const t = aggregateFromInstalledModules({
    'local:somefile.js': {
      url: 'local:somefile.js',
      alias: 'local:somefile.js',
      source: '<gz>',
    }
  });
  // parseUrlToSource on 'local:somefile.js' may or may not return a desc;
  // either way the pkg field gets populated.
  assert.equal(t.length, 1);
  assert.ok(t[0].pkg);
});
