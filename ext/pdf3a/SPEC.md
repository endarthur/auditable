# @gcu/pdf3a — Specification

**Status:** 0.1.0 (translated from cert/engine/src/pdfa.ts; generalised)
**Scope:** PDF/A-3B enrichment for pdf-lib documents
**Standard:** ISO 19005-3 (PDF/A-3) level B (visual conformance, not pure
text extraction)

---

## 1. Purpose

PDF/A-3 is the variant of PDF/A that **allows arbitrary file attachments**
inside a long-term-archival PDF. Each attachment carries an `AFRelationship`
tag that names its role: `Source`, `Data`, `Alternative`, `Supplement`, or
`Unspecified`. Every attachment is enumerated in the document catalog's
`/AF` table and (for legacy viewer compatibility) the `/Names
/EmbeddedFiles` name tree.

The combination is exactly the "single artefact + provenance" shape the
GCU stack already cares about: a printable PDF that *contains* the data
that produced it. A geological report PDF can carry the assay CSVs and
variogram fits used to make it; an Auditable export can carry its source
notebook; a Plan export can carry the schedule's task graph.

`@gcu/pdf3a` is the thin layer that takes a `pdf-lib` `PDFDocument` and
adds the four pieces required for ISO 19005-3 conformance:

1. sRGB output intent (with embedded ICC profile)
2. XMP metadata (with optional consumer-defined namespace)
3. `/AF` Associated Files table with per-attachment relationship tags
4. Trailer `/ID` entry

The library does *not* draw the PDF. The consumer creates the document
with `pdf-lib` (drawing pages, embedding fonts, adding images) and calls
`applyPdfA3(pdfLib, pdf, input)` immediately before saving.

## 2. Non-goals

- **Drawing primitives.** The consumer uses pdf-lib directly (or any
  pdf-lib wrapper) to build pages. We don't wrap pdf-lib's API.
- **PDF/A-1 or PDF/A-2.** Those variants forbid attachments, which is the
  entire point of going to PDF/A-3. If you don't need attachments, use a
  different library or just generate plain PDF.
- **PDF/A-3 levels A or U.** Level A requires structural tagging (logical
  reading order, accessibility tree) — far more invasive. Level U requires
  Unicode-mappable text. Level B (visual conformance) covers the typical
  archival use case. Levels A/U could be future work.
- **veraPDF integration.** The cert engine has CI that runs veraPDF
  against generated certificates as a regression check. `@gcu/pdf3a`
  doesn't ship a validator — consumers can run veraPDF externally if
  they want strict conformance verification.
- **Bundling pdf-lib.** It's a 300 KB dependency and not every consumer
  wants it. It's a peer dependency — the consumer imports/installs the
  pdf-lib version they prefer and passes the module in.

## 3. API

```js
import { applyPdfA3, buildXmpMetadata } from '@gcu/pdf3a';
import * as pdfLib from 'pdf-lib';

const pdf = await pdfLib.PDFDocument.create();
// ... draw your pages, embed fonts, etc.

await applyPdfA3(pdfLib, pdf, {
  iccProfile,                                  // Uint8Array — sRGB ICC bytes
  xmp: {
    title: 'Block-model report — South pit',
    subject: 'Q2 2026 grade-control update',
    creator: 'Geosciences team',
    customSchema: {                            // optional consumer namespace
      namespace: 'https://example.org/ns/grade/1.0/',
      prefix: 'grade',
      schemaName: 'Grade-control metadata',
      properties: [
        { name: 'pitId',        valueType: 'Text', category: 'external', description: 'Pit identifier' },
        { name: 'compositeRev', valueType: 'Text', category: 'external', description: 'Composite database revision' },
      ],
      values: { pitId: 'south-pit-2026q2', compositeRev: '0.4.0' },
    },
  },
  attachments: [
    { name: 'assays.csv',     bytes: csvBytes,   mimeType: 'text/csv',         description: 'Underlying assay table',          relationship: 'Source' },
    { name: 'variogram.json', bytes: varioBytes, mimeType: 'application/json', description: 'Fitted variogram model',          relationship: 'Data'   },
    { name: 'notebook.html',  bytes: nbBytes,    mimeType: 'text/html',        description: 'Auditable notebook used to build', relationship: 'Source' },
  ],
  lang: 'en-US',                               // optional, default "en-US"
});

const bytes = await pdf.save({ useObjectStreams: false });
```

`pdf.save({ useObjectStreams: false })` is required — pdf-lib's default
`useObjectStreams: true` reshuffles indirect references and drops the
trailer `/ID` entry, which veraPDF flags as a conformance failure.

### 3.1 Public functions

| Function | Purpose |
|---|---|
| `applyPdfA3(pdfLib, pdf, input)` | The orchestrator. Mutates `pdf` in place; returns `Promise<void>`. Idempotent within a single document — calling it twice is undefined behaviour but the second call's data wins. |
| `buildXmpMetadata(input)` | Returns the XMP string that would be embedded. Useful for testing the metadata you're about to ship without writing a PDF. |
| `pdfDate(date)` | Format a JS `Date` as the PDF date string `D:YYYYMMDDHHmmSS+00'00'`. Exported for consumer code that needs to write PDF dates outside this library. |
| `VALID_RELATIONSHIPS` | The five legal `AFRelationship` values as a frozen array. |

### 3.2 `applyPdfA3` argument shape

```ts
type ApplyPdfA3Input = {
  iccProfile:  Uint8Array;             // sRGB IEC61966-2.1 bytes (required)
  xmp:         XmpInput;               // see below (required)
  attachments?: PdfAttachment[];       // default [] — no attachments still produces a valid PDF/A-3
  lang?:       string;                 // default "en-US"
};

type XmpInput = {
  title:        string;
  subject?:     string;                // becomes dc:description
  creator?:     string;
  createDate?:  Date;                  // default: now
  producer?:    string;                // default "pdf-lib"
  creatorTool?: string;                // default "@gcu/pdf3a"
  customSchema?: CustomSchema;         // see §4
};

type PdfAttachment = {
  name:         string;                // filename, e.g. "assays.csv"
  bytes:        Uint8Array;
  mimeType:     string;                // e.g. "text/csv"
  description:  string;                // human-readable; shown in viewer attachment panes
  relationship: AfRelationship;        // see §5
  creationDate?: Date;                 // default: now
};

type AfRelationship = "Source" | "Data" | "Alternative" | "Supplement" | "Unspecified";
```

## 4. Custom XMP schema

Any non-standard XMP namespace requires a `pdfaExtension:schemas` block
declaring its prefix, namespace URI, and the properties used. PDF/A
validators (veraPDF) reject documents whose XMP references undeclared
namespaces. `@gcu/pdf3a` builds this block automatically from
`customSchema`.

```ts
type CustomSchema = {
  namespace:   string;                 // e.g. "https://gentropic.org/cert/ns/gcu/1.0/"
  prefix:      string;                 // e.g. "gcu"
  schemaName:  string;                 // human-readable
  properties: Array<{
    name:        string;               // e.g. "credentialCode"
    valueType?:  string;               // default "Text"; XMP type vocabulary
    category?:   string;               // default "external"; "internal" | "external"
    description?: string;
  }>;
  values: { [propertyName: string]: string };
};
```

The `properties` array declares the schema; the `values` object provides
actual values to embed in the XMP. Properties with no value (or `null` /
`undefined` value) are skipped — the schema declaration stays, but no
empty element is emitted.

For the cert engine's original use, `customSchema` looks like:

```js
{
  namespace:  'https://gentropic.org/cert/ns/gcu/1.0/',
  prefix:     'gcu',
  schemaName: 'GCU credential metadata',
  properties: [
    { name: 'credentialCode', description: 'Deterministic credential code (WORKSHOP-XXXXXX)' },
    { name: 'issuerId',       description: 'Issuer identifier, typically a did:web URI' },
    { name: 'credentialHash', description: 'SHA-256 hex of the embedded credential.json' },
  ],
  values: { credentialCode, issuerId, credentialHash },
}
```

## 5. AFRelationship guidance

Choosing the right relationship matters because PDF/A-3-aware tools
display attachments differently based on it. Quick guide:

- **`Source`** — the attachment is the *original source* the PDF was
  derived from. Use for: the auditable notebook that produced a report,
  the .calque spreadsheet behind a calque-rendered PDF, the assay CSV
  behind a grade-control summary. Most common.
- **`Data`** — machine-readable data the PDF visualises. Use for:
  variogram fits, schedule task graphs, drillhole geometries. Distinct
  from Source in that the PDF is the primary deliverable; the data is
  supplementary numerical detail.
- **`Alternative`** — an alternative representation of the *same content*.
  Use for: a CSV mirror of a table, a JSON-LD mirror of credential data
  also rendered as a certificate. Reader/viewer choice.
- **`Supplement`** — additional context not strictly required. Use for:
  Rekor inclusion proofs, audit logs, supplementary endorsements.
- **`Unspecified`** — only when none of the above honestly fit. Avoid.

The cert engine uses Source for `credential.json`, Supplement for
`endorsement.json` and `credential.rekor.bundle`. Convention not law.

## 6. Implementation notes

### 6.1 pdf-lib peer dependency

Consumers pass the entire pdf-lib module as `pdfLib` to `applyPdfA3`. The
library destructures the constructors it needs (`PDFArray`, `PDFDict`,
`PDFRawStream`, `PDFString`, `PDFName`, `PDFHexString`). This avoids
bundling pdf-lib (which is large) and lets consumers pin their own
pdf-lib version.

For browser use via Auditable's module system:

```js
const pdfLib = await load('pdf-lib');                       // or install()
const pdf3a  = await load('@gcu/pdf3a');
await pdf3a.applyPdfA3(pdfLib, pdf, { iccProfile, xmp, attachments });
```

### 6.2 ICC profile

The library bundles the standard sRGB IEC61966-2.1 v2 ICC profile (3008
bytes, base64-embedded in `src/srgb-profile.js`) as the default. The
profile is published by the International Color Consortium for free
redistribution and is the same one bundled in LibreOffice, Inkscape,
Ghostscript, and most other open-source PDF tooling.

Consumers can override `input.iccProfile` with their own bytes if they
need a different output intent (e.g. CMYK SWOP for print-proof PDFs).
The library does not parse or validate ICC content — passing malformed
bytes produces an invalid PDF/A; veraPDF would catch it.

The bundled profile is exposed via `srgbProfile()` for consumers who
want to use it explicitly (e.g. in tests, or to attach to multiple
documents in a batch with the same byte buffer):

```js
import { srgbProfile } from '@gcu/pdf3a';
const bytes = srgbProfile();   // Uint8Array, 3008 bytes
```

Each call returns a fresh `Uint8Array` view; the underlying buffer is
cached so the cost is the base64 decode (one-time per process).

### 6.3 Trailer /ID

PDF/A requires a trailer `/ID` entry — two byte strings identifying the
file. We use `crypto.randomUUID()` for both slots on first save. A
content-derived ID (e.g. SHA-256 of the document body) would be more
deterministic but requires a two-pass save. Random is acceptable per
PDF 32000-1 §14.4.

### 6.4 Save-time gotcha

`pdf.save()` defaults to `useObjectStreams: true`, which causes pdf-lib
to compress indirect references into object streams. This rewrites the
trailer dictionary in a way that drops the `/ID` entry we set. veraPDF
flags this as a conformance failure. Always call:

```js
const bytes = await pdf.save({ useObjectStreams: false });
```

This trade-off is documented in pdf-lib's own issues; not specific to
us. Output size grows ~5-15% without object streams; for archival
documents the trade-off is fine.

### 6.5 What we don't validate

- We don't verify that fonts embedded in the PDF are full subsets (PDF/A
  requires this). pdf-lib subsets fonts by default with `fontkit`; just
  use `fontkit` and don't pass `subset: false`.
- We don't verify that no transparency, no encryption, no JavaScript
  actions, no external content references are present (all forbidden by
  PDF/A). Use pdf-lib normally and you'll be fine. veraPDF can catch
  these in a CI step.

## 7. Testing

The pure parts (XMP string generation, date formatting, schema
declaration, value emission) are tested in `test/pdf3a.test.mjs`
without pdf-lib. The pdf-lib-touching parts (output intent, attachments
table, trailer ID) need an actual pdf-lib instance and a written PDF
file to verify; that's left to consumers' integration tests against
real PDFs.

The cert engine has a `tests/pdf_test.ts` with veraPDF-checked output
that doubles as the integration test for this library.

## 8. Roadmap

- **PDF/A-2B subset.** Some consumers want long-term archival but no
  attachments. Spinning out a `@gcu/pdf2a` (or a flag on this library
  that switches the conformance level) would serve them. Low priority.
- **Content-derived trailer /ID.** Two-pass save (first pass: write,
  hash; second pass: re-write with deterministic ID). Useful for
  reproducible builds.
- **Convenience presets.** A `presets.{auditable,calque,cert,plan}` map
  with the schema and AFRelationship choices each GCU tool uses, so
  consumers don't repeat that scaffolding. Add when more than two GCU
  consumers exist.
- **veraPDF wrapper.** Even just a "did this pass" boolean from a
  veraPDF Wasm build would be useful for CI. Significantly larger
  scope; defer.

## 9. Origin

Translated from `cert/engine/src/pdfa.ts` (TypeScript / Deno) on
2026-04-28. The cert version is GCU-specific (hard-coded `gcu:`
namespace and credential properties); this version generalises that into
the `customSchema` parameter. Behaviour is identical when given the
same inputs. The cert engine itself can migrate to this library by
replacing its local `pdfa.ts` with `@gcu/pdf3a` — same orchestrator
shape, the customSchema parameter takes the cert-specific schema as a
data argument.
