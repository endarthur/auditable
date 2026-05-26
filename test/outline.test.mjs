import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOutline } from '../src/js/outline.js';

test('docTitle becomes level-0 title entry', () => {
  const { entries } = extractOutline([], 'My Notebook');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    kind: 'title', cellId: null, headerIdx: null, level: 0, text: 'My Notebook',
  });
});

test('no title produces no title entry', () => {
  const { entries } = extractOutline([], '');
  assert.equal(entries.length, 0);
});

test('markdown headers contribute per-header entries', () => {
  const cells = [
    { id: 'c-1', type: 'md', code: '# Section A\n\nsome text\n\n## Subsection' },
    { id: 'c-2', type: 'md', code: '### Deep\n\n# Section B' },
  ];
  const { entries } = extractOutline(cells, '');
  assert.deepEqual(entries, [
    { kind: 'header', cellId: 'c-1', headerIdx: 0, level: 1, text: 'Section A' },
    { kind: 'header', cellId: 'c-1', headerIdx: 1, level: 2, text: 'Subsection' },
    { kind: 'header', cellId: 'c-2', headerIdx: 0, level: 3, text: 'Deep' },
    { kind: 'header', cellId: 'c-2', headerIdx: 1, level: 1, text: 'Section B' },
  ]);
});

test('%cellName nests under last open header', () => {
  const cells = [
    { id: 'c-1', type: 'md',   code: '# Section A' },
    { id: 'c-2', type: 'code', code: '// %cellName loadData\nconst x = 1;' },
    { id: 'c-3', type: 'md',   code: '## Sub' },
    { id: 'c-4', type: 'code', code: '// %cellName transform\n' },
  ];
  const { entries } = extractOutline(cells, '');
  assert.deepEqual(entries.map((e) => ({ kind: e.kind, level: e.level, text: e.text })), [
    { kind: 'header',   level: 1, text: 'Section A' },
    { kind: 'cellname', level: 2, text: 'loadData' },
    { kind: 'header',   level: 2, text: 'Sub' },
    { kind: 'cellname', level: 3, text: 'transform' },
  ]);
});

test('%cellName before any header is level 1', () => {
  const cells = [
    { id: 'c-1', type: 'code', code: '// %cellName earlyWork\n' },
  ];
  const { entries } = extractOutline(cells, '');
  assert.deepEqual(entries, [
    { kind: 'cellname', cellId: 'c-1', headerIdx: null, level: 1, text: 'earlyWork' },
  ]);
});

test('fenced code blocks do not contribute header lines', () => {
  const cells = [
    { id: 'c-1', type: 'md', code: '# Real header\n\n```python\n# this is python\n## not a header\n```\n\n## After fence' },
  ];
  const { entries } = extractOutline(cells, '');
  assert.deepEqual(entries.map((e) => e.text), ['Real header', 'After fence']);
});

test('title + headers + cellnames combine in document order', () => {
  const cells = [
    { id: 'c-1', type: 'md',   code: '# Pipeline' },
    { id: 'c-2', type: 'code', code: '// %cellName setup' },
    { id: 'c-3', type: 'md',   code: '## Block model\n\nstuff' },
  ];
  const { entries } = extractOutline(cells, 'My Project');
  assert.deepEqual(entries.map((e) => ({ kind: e.kind, level: e.level, text: e.text })), [
    { kind: 'title',    level: 0, text: 'My Project' },
    { kind: 'header',   level: 1, text: 'Pipeline' },
    { kind: 'cellname', level: 2, text: 'setup' },
    { kind: 'header',   level: 2, text: 'Block model' },
  ]);
});

test('trailing closing #s in ATX headers are stripped', () => {
  const cells = [
    { id: 'c-1', type: 'md', code: '## Section ##\n# Other #' },
  ];
  const { entries } = extractOutline(cells, '');
  assert.deepEqual(entries.map((e) => e.text), ['Section', 'Other']);
});
