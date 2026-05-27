import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as archive from '../ext/archive/index.js';
import {
  writeEpub, readEpub, EpubError,
  normalizeXhtml,
  extractHeadings, buildTocTree,
} from '../ext/epub/index.js';

// ── xhtml normalization ───────────────────────────────────────────

test('normalizeXhtml: self-closes void elements', () => {
  assert.equal(normalizeXhtml('<br>'),  '<br/>');
  assert.equal(normalizeXhtml('<img src="x.png">'), '<img src="x.png"/>');
  assert.equal(normalizeXhtml('<hr>'),  '<hr/>');
  // Already self-closing pass through
  assert.equal(normalizeXhtml('<br/>'), '<br/>');
});

test('normalizeXhtml: leaves non-void elements alone', () => {
  assert.equal(normalizeXhtml('<p>hi</p>'), '<p>hi</p>');
  assert.equal(normalizeXhtml('<div>x</div>'), '<div>x</div>');
});

test('normalizeXhtml: escapes bare ampersands but not entities', () => {
  assert.equal(normalizeXhtml('a & b'), 'a &amp; b');
  assert.equal(normalizeXhtml('&amp;'), '&amp;');
  assert.equal(normalizeXhtml('&#39;'), '&#39;');
  assert.equal(normalizeXhtml('a & b &amp; c'), 'a &amp; b &amp; c');
});

// ── heading extraction ────────────────────────────────────────────

test('extractHeadings: pulls level + id + text', () => {
  const body = '<h1>Title</h1><p>x</p><h2 id="sub">Sub</h2>';
  const { headings, body: rewritten } = extractHeadings(body, 'ch1.xhtml');
  assert.equal(headings.length, 2);
  assert.deepEqual(headings.map((h) => ({ level: h.level, id: h.id, text: h.text, href: h.href })), [
    { level: 1, id: 'title', text: 'Title', href: 'ch1.xhtml#title' },
    { level: 2, id: 'sub',   text: 'Sub',   href: 'ch1.xhtml#sub' },
  ]);
  // Title got a synthesized id; sub kept its explicit one
  assert.match(rewritten, /<h1 id="title">Title<\/h1>/);
  assert.match(rewritten, /<h2 id="sub">Sub<\/h2>/);
});

test('extractHeadings: synthesizes unique ids on collision', () => {
  const body = '<h1>Hi</h1><h2>Hi</h2><h3>Hi</h3>';
  const { headings } = extractHeadings(body, 'ch1.xhtml');
  assert.deepEqual(headings.map((h) => h.id), ['hi', 'hi-2', 'hi-3']);
});

// ── round-trip ───────────────────────────────────────────────────

test('round-trip: minimal book', async () => {
  const bytes = await writeEpub({
    archive,
    metadata: { title: 'Hello' },
    chapters: [{ id: 'ch1', title: 'Chapter 1', body: '<h1>Chapter 1</h1><p>hello</p>' }],
  });
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0);

  const out = await readEpub(bytes, { archive });
  assert.equal(out.metadata.title, 'Hello');
  assert.equal(out.chapters.length, 1);
  assert.equal(out.chapters[0].id, 'ch1');
  assert.equal(out.chapters[0].title, 'Chapter 1');
  assert.match(out.chapters[0].body, /<h1\b[^>]*>Chapter 1<\/h1>/);
  assert.match(out.chapters[0].body, /<p>hello<\/p>/);
});

test('round-trip: metadata fields survive', async () => {
  const meta = {
    title:       'Q4 grade tonnage estimate',
    author:      'Arthur Endlein',
    lang:        'en-US',
    date:        '2026-05-27',
    identifier:  'urn:uuid:abcd-efgh',
    description: 'A test book',
    publisher:   'GCU',
  };
  const bytes = await writeEpub({
    archive,
    metadata: meta,
    chapters: [{ id: 'ch1', title: 'Intro', body: '<p>x</p>' }],
  });
  const out = await readEpub(bytes, { archive });
  for (const k of Object.keys(meta)) {
    assert.equal(out.metadata[k], meta[k], `metadata.${k}`);
  }
});

test('round-trip: multi-chapter spine preserves order', async () => {
  const chapters = [
    { id: 'ch1', title: 'One',   body: '<h1>One</h1>'   },
    { id: 'ch2', title: 'Two',   body: '<h1>Two</h1>'   },
    { id: 'ch3', title: 'Three', body: '<h1>Three</h1>' },
  ];
  const bytes = await writeEpub({
    archive,
    metadata: { title: 'Book' },
    chapters,
  });
  const out = await readEpub(bytes, { archive });
  assert.deepEqual(out.chapters.map((c) => c.id), ['ch1', 'ch2', 'ch3']);
  assert.deepEqual(out.chapters.map((c) => c.title), ['One', 'Two', 'Three']);
});

test('round-trip: cover image', async () => {
  const coverBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG magic
  const bytes = await writeEpub({
    archive,
    metadata: { title: 'Cover Test' },
    chapters: [{ id: 'ch1', title: 'x', body: '<p>x</p>' }],
    cover: { mime: 'image/png', bytes: coverBytes },
  });
  const out = await readEpub(bytes, { archive });
  assert.ok(out.cover, 'cover should round-trip');
  assert.equal(out.cover.mime, 'image/png');
  assert.deepEqual(Array.from(out.cover.bytes.slice(0, 8)), Array.from(coverBytes));
});

test('round-trip: resources', async () => {
  const png = new Uint8Array([1, 2, 3, 4]);
  const txt = new TextEncoder().encode('hello');
  const bytes = await writeEpub({
    archive,
    metadata: { title: 'Resources' },
    chapters: [{ id: 'ch1', title: 'x', body: '<p>see <img src="images/foo.png"/></p>' }],
    resources: [
      { path: 'images/foo.png', mime: 'image/png', bytes: png },
      { path: 'data/info.txt',  mime: 'text/plain', bytes: txt },
    ],
  });
  const out = await readEpub(bytes, { archive });
  assert.equal(out.resources.length, 2);
  const paths = out.resources.map((r) => r.path).sort();
  assert.deepEqual(paths, ['data/info.txt', 'images/foo.png']);
  const foo = out.resources.find((r) => r.path === 'images/foo.png');
  assert.deepEqual(Array.from(foo.bytes), [1, 2, 3, 4]);
});

test('round-trip: TOC tree via nav.xhtml', async () => {
  const bytes = await writeEpub({
    archive,
    metadata: { title: 'TOC' },
    chapters: [
      { id: 'ch1', title: 'Intro',  body: '<h1>Intro</h1><h2 id="motiv">Motivation</h2>' },
      { id: 'ch2', title: 'Method', body: '<h1>Method</h1><h2 id="m1">M1</h2><h2 id="m2">M2</h2>' },
    ],
  });
  const out = await readEpub(bytes, { archive });
  assert.ok(out.toc, 'toc should be present');
  assert.equal(out.toc.length, 2);
  assert.equal(out.toc[0].title, 'Intro');
  assert.equal(out.toc[1].title, 'Method');
  assert.equal(out.toc[1].children.length, 2);
  assert.equal(out.toc[1].children[0].title, 'M1');
});

test('mimetype is stored (uncompressed) and first', async () => {
  const bytes = await writeEpub({
    archive,
    metadata: { title: 'Mime' },
    chapters: [{ id: 'ch1', title: 'x', body: '<p>x</p>' }],
  });
  // ZIP local file header starts with PK\x03\x04. The first entry's
  // filename should be exactly "mimetype" and compression method == 0.
  // Bytes 4-5 of the local header are version; 6-7 are flags; 8-9 are
  // method.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, 'first 4 bytes = ZIP local header sig');
  const method = view.getUint16(8, true);
  assert.equal(method, 0, 'mimetype must be stored (method=0), not deflated');
  // Filename starts at offset 30; length is at offset 26.
  const nameLen = view.getUint16(26, true);
  const dec = new TextDecoder().decode(bytes.slice(30, 30 + nameLen));
  assert.equal(dec, 'mimetype', 'first entry filename = mimetype');
  // The body of the first entry equals "application/epub+zip" exactly.
  const extraLen = view.getUint16(28, true);
  const bodyStart = 30 + nameLen + extraLen;
  const body = new TextDecoder().decode(bytes.slice(bodyStart, bodyStart + 20));
  assert.equal(body, 'application/epub+zip', 'mimetype contents');
});

// ── error paths ──────────────────────────────────────────────────

test('writeEpub: rejects missing archive', async () => {
  await assert.rejects(() =>
    writeEpub({ metadata: { title: 'x' }, chapters: [{ id: 'a', title: 'a', body: '' }] }),
    EpubError,
  );
});

test('writeEpub: rejects empty chapters', async () => {
  await assert.rejects(() =>
    writeEpub({ archive, metadata: { title: 'x' }, chapters: [] }),
    EpubError,
  );
});

test('writeEpub: rejects missing title', async () => {
  await assert.rejects(() =>
    writeEpub({ archive, metadata: {}, chapters: [{ id: 'a', title: 'a', body: '' }] }),
    EpubError,
  );
});

test('readEpub: rejects non-EPUB bytes', async () => {
  await assert.rejects(() => readEpub(new Uint8Array([1, 2, 3]), { archive }));
});
