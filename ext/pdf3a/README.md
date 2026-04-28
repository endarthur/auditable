# @gcu/pdf3a

PDF/A-3B enrichment for `pdf-lib` documents. Adds the four pieces ISO
19005-3 level B requires — sRGB output intent, XMP metadata (with
optional consumer namespace), `/AF` Associated Files table, trailer
`/ID` — to a `pdf-lib` `PDFDocument` you've already drawn.

PDF/A-3 is the variant that **allows arbitrary file attachments** with
typed relationships (`Source`, `Data`, `Alternative`, `Supplement`,
`Unspecified`). Use it when you want a long-term-archival PDF that
also carries the data behind it.

```js
import { applyPdfA3 } from '@gcu/pdf3a';
import * as pdfLib from 'pdf-lib';

const pdf = await pdfLib.PDFDocument.create();
// ... draw your pages with pdf-lib ...

await applyPdfA3(pdfLib, pdf, {
  // iccProfile defaults to the bundled sRGB IEC61966-2.1 profile (3 KB).
  // Override only if you need a different output intent.
  xmp: {
    title:   'Block-model report',
    creator: 'Geosciences team',
    customSchema: {                    // optional — declare your own namespace
      namespace:  'https://example.org/ns/grade/1.0/',
      prefix:     'grade',
      schemaName: 'Grade-control metadata',
      properties: [
        { name: 'pitId', description: 'Pit identifier' },
      ],
      values: { pitId: 'south-pit-2026q2' },
    },
  },
  attachments: [
    { name: 'assays.csv', bytes: csvBytes, mimeType: 'text/csv',
      description: 'Underlying assays', relationship: 'Source' },
  ],
});

// useObjectStreams: false is REQUIRED — pdf-lib's default reshuffles
// trailer entries and drops /ID, which veraPDF flags.
const bytes = await pdf.save({ useObjectStreams: false });
```

## API

| Function | Returns | Use |
|---|---|---|
| `applyPdfA3(pdfLib, pdf, input)` | `Promise<void>` | Mutate a pdf-lib document with the four PDF/A-3 enrichments |
| `buildXmpMetadata(input)` | `string` | Get the XMP block that would be embedded — useful for tests |
| `pdfDate(date)` | `string` | Format a JS `Date` as PDF date `D:YYYYMMDDHHmmSS+00'00'` |
| `srgbProfile()` | `Uint8Array` | Get the bundled sRGB IEC61966-2.1 ICC profile (3008 bytes) |
| `VALID_RELATIONSHIPS` | `string[]` | The five legal `AFRelationship` values |

## pdf-lib is a peer dependency

The library does not bundle pdf-lib (~300 KB). Pass the whole pdf-lib
module as the first argument; we destructure the constructors we need
(`PDFArray`, `PDFDict`, `PDFRawStream`, `PDFString`, `PDFName`,
`PDFHexString`).

For browser use via Auditable's module system:

```js
const pdfLib = await install('pdf-lib');     // or load() if already installed
const pdf3a  = await install('@gcu/pdf3a');
await pdf3a.applyPdfA3(pdfLib, pdf, input);
```

## AFRelationship — pick the right one

| Value | When to use |
|---|---|
| `Source` | The PDF was *derived from* this attachment (notebook, raw CSV, source spreadsheet) |
| `Data` | Machine-readable data the PDF visualises (variogram fit, task graph) |
| `Alternative` | Alternative representation of the same content (CSV mirror of a table) |
| `Supplement` | Supplementary context (audit log, inclusion proof, endorsement) |
| `Unspecified` | None of the above honestly fits. Avoid. |

## Files

- `src/pdf3a.js` — the entire library: XMP, output intent, attachments, trailer ID
- `src/index.js` — re-exports
- `index.js` — bundled build output (`node build.js`)
- `SPEC.md` — full design spec with examples
- `package.json` — lists pdf-lib as `peerDependencies`

## See also

- ISO 19005-3 — PDF/A-3 specification
- pdf-lib — https://pdf-lib.js.org/
- veraPDF — open-source PDF/A validator (recommended for CI)
- The cert engine (`cert/engine/src/pdfa.ts`) — original TS source this
  library was translated from
