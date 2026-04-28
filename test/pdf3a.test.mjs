// Unit tests for @gcu/pdf3a pure helpers.
// Tests the XMP string builder, date formatter, and relationship constants.
// pdf-lib-touching paths (output intent, attachments table, trailer ID)
// require an actual pdf-lib instance and are exercised by consumer
// integration tests against generated PDFs (see ../cert/engine/tests/pdf_test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildXmpMetadata, pdfDate, srgbProfile, VALID_RELATIONSHIPS }
  from '../ext/pdf3a/src/pdf3a.js';

// ── pdfDate ─────────────────────────────────────────────────────────────

test('pdfDate emits D:YYYYMMDDHHmmSS+00\'00\' format', () => {
  const d = new Date(Date.UTC(2026, 3, 28, 14, 7, 9));   // April 28, 14:07:09 UTC
  assert.equal(pdfDate(d), `D:20260428140709+00'00'`);
});

test('pdfDate zero-pads single-digit components', () => {
  const d = new Date(Date.UTC(2025, 0, 1, 1, 2, 3));     // 2025-01-01 01:02:03
  assert.equal(pdfDate(d), `D:20250101010203+00'00'`);
});

test('pdfDate uses UTC fields, not local', () => {
  // Same instant in two TZ-equivalent ways — the output must be identical.
  const utc = new Date(Date.UTC(2026, 5, 15, 12, 30, 0));
  const fromIso = new Date('2026-06-15T12:30:00Z');
  assert.equal(pdfDate(utc), pdfDate(fromIso));
});

// ── srgbProfile (bundled ICC) ───────────────────────────────────────────

test('srgbProfile returns a Uint8Array of the expected size', () => {
  const bytes = srgbProfile();
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 3008);                  // sRGB IEC61966-2.1 v2
});

test('srgbProfile bytes have the ICC profile signature ("acsp" at offset 36)', () => {
  const bytes = srgbProfile();
  // ICC v4 spec §7.2.5: profile signature is 4 bytes at offset 36, "acsp".
  const signature = String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39]);
  assert.equal(signature, 'acsp');
});

test('srgbProfile size header (uint32 BE at offset 0) matches actual length', () => {
  const bytes = srgbProfile();
  // ICC v4 spec §7.2.2: bytes 0-3 are profile size as uint32 big-endian.
  const declaredSize = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  assert.equal(declaredSize, bytes.length);
});

test('srgbProfile returns independent Uint8Array instances on each call', () => {
  // Underlying ArrayBuffer is shared (cached) but each call gets a fresh
  // view, so consumers can mutate or transfer without affecting others.
  const a = srgbProfile();
  const b = srgbProfile();
  assert.notEqual(a, b);                              // different views
  assert.equal(a.length, b.length);
  // Same byte content.
  for (let i = 0; i < 16; i++) assert.equal(a[i], b[i]);
});

// ── VALID_RELATIONSHIPS ─────────────────────────────────────────────────

test('VALID_RELATIONSHIPS exports all five PDF/A-3 spec values', () => {
  assert.deepEqual([...VALID_RELATIONSHIPS].sort(), [
    'Alternative', 'Data', 'Source', 'Supplement', 'Unspecified',
  ]);
});

// ── buildXmpMetadata: structural ────────────────────────────────────────

test('buildXmpMetadata declares pdfaid:part=3 and pdfaid:conformance=B', () => {
  const xmp = buildXmpMetadata({ title: 'Test', creator: 'Test' });
  assert.match(xmp, /<pdfaid:part>3<\/pdfaid:part>/);
  assert.match(xmp, /<pdfaid:conformance>B<\/pdfaid:conformance>/);
});

test('buildXmpMetadata wraps content in xmpmeta + RDF + xpacket markers', () => {
  const xmp = buildXmpMetadata({ title: 'Test' });
  assert.match(xmp, /<\?xpacket begin="\uFEFF"/);
  assert.match(xmp, /<\?xpacket end="w"\?>$/);
  assert.match(xmp, /<x:xmpmeta /);
  assert.match(xmp, /<rdf:RDF /);
});

test('buildXmpMetadata embeds title, subject, creator from input', () => {
  const xmp = buildXmpMetadata({
    title:   'Block model — South pit',
    subject: 'Q2 2026 grade-control update',
    creator: 'Geosciences team',
  });
  assert.match(xmp, /Block model — South pit/);
  assert.match(xmp, /Q2 2026 grade-control update/);
  assert.match(xmp, /Geosciences team/);
});

test('buildXmpMetadata sets default producer and creatorTool when not supplied', () => {
  const xmp = buildXmpMetadata({ title: 'X' });
  assert.match(xmp, /<pdf:Producer>pdf-lib<\/pdf:Producer>/);
  assert.match(xmp, /<xmp:CreatorTool>@gcu\/pdf3a<\/xmp:CreatorTool>/);
});

test('buildXmpMetadata respects custom producer and creatorTool', () => {
  const xmp = buildXmpMetadata({
    title: 'X',
    producer: 'my-engine',
    creatorTool: 'my-tool 1.0',
  });
  assert.match(xmp, /<pdf:Producer>my-engine<\/pdf:Producer>/);
  assert.match(xmp, /<xmp:CreatorTool>my-tool 1\.0<\/xmp:CreatorTool>/);
});

test('buildXmpMetadata uses createDate for all three xmp date fields', () => {
  const d = new Date('2026-04-28T14:07:09Z');
  const xmp = buildXmpMetadata({ title: 'X', createDate: d });
  assert.match(xmp, /<xmp:CreateDate>2026-04-28T14:07:09Z<\/xmp:CreateDate>/);
  assert.match(xmp, /<xmp:ModifyDate>2026-04-28T14:07:09Z<\/xmp:ModifyDate>/);
  assert.match(xmp, /<xmp:MetadataDate>2026-04-28T14:07:09Z<\/xmp:MetadataDate>/);
});

test('buildXmpMetadata strips milliseconds from dates (PDF convention)', () => {
  // Some validators reject ISO dates with .NNN — drop them to match the
  // PDF date format conventions.
  const d = new Date('2026-04-28T14:07:09.123Z');
  const xmp = buildXmpMetadata({ title: 'X', createDate: d });
  assert.match(xmp, /<xmp:CreateDate>2026-04-28T14:07:09Z<\/xmp:CreateDate>/);
  assert.doesNotMatch(xmp, /\.123Z/);
});

// ── XML escaping ────────────────────────────────────────────────────────

test('buildXmpMetadata escapes < > & " in title and creator', () => {
  const xmp = buildXmpMetadata({
    title:   'A & B <c> "d"',
    creator: 'Acme & Co. <Geo>',
  });
  assert.match(xmp, /A &amp; B &lt;c&gt; &quot;d&quot;/);
  assert.match(xmp, /Acme &amp; Co\. &lt;Geo&gt;/);
  // None of the raw special characters should leak into XML content.
  assert.doesNotMatch(xmp, /A & B <c> "d"/);
});

// ── customSchema ────────────────────────────────────────────────────────

test('buildXmpMetadata without customSchema omits the extension block', () => {
  const xmp = buildXmpMetadata({ title: 'X' });
  assert.doesNotMatch(xmp, /pdfaExtension:schemas/);
  assert.doesNotMatch(xmp, /pdfaSchema:namespaceURI/);
});

test('buildXmpMetadata with customSchema declares the extension block', () => {
  const xmp = buildXmpMetadata({
    title: 'Cert',
    customSchema: {
      namespace:  'https://example.org/ns/foo/1.0/',
      prefix:     'foo',
      schemaName: 'Foo metadata',
      properties: [
        { name: 'fooId', description: 'Foo identifier' },
      ],
      values: { fooId: 'abc-123' },
    },
  });
  assert.match(xmp, /<pdfaExtension:schemas>/);
  assert.match(xmp, /<pdfaSchema:namespaceURI>https:\/\/example\.org\/ns\/foo\/1\.0\/<\/pdfaSchema:namespaceURI>/);
  assert.match(xmp, /<pdfaSchema:prefix>foo<\/pdfaSchema:prefix>/);
  assert.match(xmp, /<pdfaSchema:schema>Foo metadata<\/pdfaSchema:schema>/);
  assert.match(xmp, /<pdfaProperty:name>fooId<\/pdfaProperty:name>/);
  assert.match(xmp, /<pdfaProperty:description>Foo identifier<\/pdfaProperty:description>/);
  // And the value ends up in the main rdf:Description.
  assert.match(xmp, /<foo:fooId>abc-123<\/foo:fooId>/);
});

test('buildXmpMetadata declares custom namespace as xmlns on the description', () => {
  const xmp = buildXmpMetadata({
    title: 'X',
    customSchema: {
      namespace: 'https://example.org/ns/grade/1.0/',
      prefix:    'grade',
      schemaName: 'Grade',
      properties: [],
      values: {},
    },
  });
  assert.match(xmp, /xmlns:grade="https:\/\/example\.org\/ns\/grade\/1\.0\/"/);
});

test('buildXmpMetadata defaults valueType to "Text" and category to "external"', () => {
  const xmp = buildXmpMetadata({
    title: 'X',
    customSchema: {
      namespace: 'https://example.org/',
      prefix: 'ex',
      schemaName: 'Ex',
      properties: [{ name: 'k', description: 'd' }],   // no valueType / category
      values: { k: 'v' },
    },
  });
  assert.match(xmp, /<pdfaProperty:valueType>Text<\/pdfaProperty:valueType>/);
  assert.match(xmp, /<pdfaProperty:category>external<\/pdfaProperty:category>/);
});

test('buildXmpMetadata skips properties whose values are missing or null', () => {
  const xmp = buildXmpMetadata({
    title: 'X',
    customSchema: {
      namespace: 'https://example.org/',
      prefix: 'ex',
      schemaName: 'Ex',
      properties: [
        { name: 'present', description: 'p' },
        { name: 'absent',  description: 'a' },
        { name: 'nulled',  description: 'n' },
      ],
      values: {
        present: 'yes',
        // absent: missing
        nulled:  null,
      },
    },
  });
  // Schema declarations stay for all three.
  assert.match(xmp, /<pdfaProperty:name>present<\/pdfaProperty:name>/);
  assert.match(xmp, /<pdfaProperty:name>absent<\/pdfaProperty:name>/);
  assert.match(xmp, /<pdfaProperty:name>nulled<\/pdfaProperty:name>/);
  // But only the "present" value emits a value element.
  assert.match(xmp, /<ex:present>yes<\/ex:present>/);
  assert.doesNotMatch(xmp, /<ex:absent>/);
  assert.doesNotMatch(xmp, /<ex:nulled>/);
});

test('buildXmpMetadata escapes XML in customSchema values', () => {
  const xmp = buildXmpMetadata({
    title: 'X',
    customSchema: {
      namespace: 'https://example.org/',
      prefix: 'ex',
      schemaName: 'Ex',
      properties: [{ name: 'tricky', description: 'a & b' }],
      values: { tricky: 'a < b > c & d' },
    },
  });
  assert.match(xmp, /<ex:tricky>a &lt; b &gt; c &amp; d<\/ex:tricky>/);
  assert.match(xmp, /<pdfaProperty:description>a &amp; b<\/pdfaProperty:description>/);
});

test('buildXmpMetadata preserves the cert-engine schema shape (regression)', () => {
  // The original cert engine's hard-coded schema, expressed as a customSchema.
  // Verifies the generalised path produces the same key markers the cert
  // tests look for.
  const xmp = buildXmpMetadata({
    title:   'Certificate — Test',
    subject: 'WORKSHOP-ABC123 — Test User',
    creator: 'Test Issuer',
    customSchema: {
      namespace: 'https://gentropic.org/cert/ns/gcu/1.0/',
      prefix:    'gcu',
      schemaName: 'GCU credential metadata',
      properties: [
        { name: 'credentialCode', description: 'Deterministic credential code (WORKSHOP-XXXXXX)' },
        { name: 'issuerId',       description: 'Issuer identifier, typically a did:web URI' },
        { name: 'credentialHash', description: 'SHA-256 hex of the embedded credential.json' },
      ],
      values: {
        credentialCode: 'WORKSHOP-ABC123',
        issuerId:       'did:web:test.example',
        credentialHash: 'deadbeef',
      },
    },
  });
  // These four assertions mirror the cert engine's existing pdf_test.ts.
  assert.match(xmp, /pdfaid:part/);
  assert.match(xmp, /pdfaid:conformance/);
  assert.match(xmp, /pdfaExtension:schemas/);
  assert.match(xmp, /<gcu:credentialCode>WORKSHOP-ABC123<\/gcu:credentialCode>/);
});
