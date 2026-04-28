// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/pdf3a/src/  Build: node ext/pdf3a/build.js
// @gcu/pdf3a — PDF/A-3B enrichment for pdf-lib documents
// applyPdfA3, buildXmpMetadata. pdf-lib is a peer dependency.

// -- srgb-profile.js --

// @gcu/pdf3a — bundled sRGB IEC61966-2.1 ICC profile (v2)
// Source: ICC standard sRGB v2 profile, public-domain redistributable.
// Original file: 3008 bytes; base64-encoded inline below.
// Provides a default for applyPdfA3's iccProfile parameter so consumers
// who just want PDF/A-3 conformance with sRGB don't have to fetch their
// own profile.

const SRGB_BASE64 = [
  "AAALwExpbm8CEAAAbW50clJHQiBYWVogB84AAgAJAAYAMQAAYWNzcE1TRlQAAAAASUVDIHNSR0IA",
  "AAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1IUCAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAARY3BydAAAAVAAAAAzZGVzYwAAAYQAAAA7d3RwdAAAAcAAAAAUYmtw",
  "dAAAAdQAAAAUclhZWgAAAegAAAAUZ1hZWgAAAfwAAAAUYlhZWgAAAhAAAAAUZG1uZAAAAiQAAABD",
  "ZG1kZAAAAmgAAABzdnVlZAAAAtwAAABvdmlldwAAA0wAAAAkbHVtaQAAA3AAAAAUbWVhcwAAA4QA",
  "AAAkdGVjaAAAA6gAAAAMclRSQwAAA7QAAAgMZ1RSQwAAA7QAAAgMYlRSQwAAA7QAAAgMdGV4dAAA",
  "AABDb3B5cmlnaHQgKGMpIDE5OTggSGV3bGV0dC1QYWNrYXJkIENvbXBhbnkAAGRlc2MAAAAAAAAA",
  "EnNSR0IgSUVDNjE5NjYtMi4xAAAAAAAAAAAAAAASc1JHQiBJRUM2MTk2Ni0yLjEAAFhZWiAAAAAA",
  "AADzUQABAAAAARbMWFlaIAAAAAAAAAAAAAAAAAAAAABYWVogAAAAAAAAb6IAADj1AAADkFhZWiAA",
  "AAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9kZXNjAAAAAAAAABZJRUMgaHR0cDov",
  "L3d3dy5pZWMuY2gAAAAAAAAAAAAAABZJRUMgaHR0cDovL3d3dy5pZWMuY2gAAGRlc2MAAAAAAAAA",
  "LklFQyA2MTk2Ni0yLjEgRGVmYXVsdCBSR0IgY29sb3VyIHNwYWNlIC0gc1JHQgAAAAAAAAAAAAAA",
  "LklFQyA2MTk2Ni0yLjEgRGVmYXVsdCBSR0IgY29sb3VyIHNwYWNlIC0gc1JHQgAAZGVzYwAAAAAA",
  "AAAsUmVmZXJlbmNlIFZpZXdpbmcgQ29uZGl0aW9uIGluIElFQzYxOTY2LTIuMQAAAAAAAAAAAAAA",
  "LFJlZmVyZW5jZSBWaWV3aW5nIENvbmRpdGlvbiBpbiBJRUM2MTk2Ni0yLjEAAHZpZXcAAAAAABOk",
  "/gAUXy4AEM8UAAPtzAAEEwsAA1yeAAAAAVhZWiAAAAAAAEwJVgBQAAAAVx/nbWVhcwAAAAAAAAAB",
  "AAAAAAAAAAAAAAAAAAAAAAAAAo8AAAACc2lnIAAAAABDUlQgY3VydgAAAAAAAAQAAAAABQAKAA8A",
  "FAAZAB4AIwAoAC0AMgA3ADsAQABFAEoATwBUAFkAXgBjAGgAbQByAHcAfACBAIYAiwCQAJUAmgCf",
  "AKQAqQCuALIAtwC8AMEAxgDLANAA1QDbAOAA5QDrAPAA9gD7AQEBBwENARMBGQEfASUBKwEyATgB",
  "PgFFAUwBUgFZAWABZwFuAXUBfAGDAYsBkgGaAaEBqQGxAbkBwQHJAdEB2QHhAekB8gH6AgMCDAIU",
  "Ah0CJgIvAjgCQQJLAlQCXQJnAnECegKEAo4CmAKiAqwCtgLBAssC1QLgAusC9QMAAwsDFgMhAy0D",
  "OANDA08DWgNmA3IDfgOKA5YDogOuA7oDxwPTA+AD7AP5BAYEEwQgBC0EOwRIBFUEYwRxBH4EjASa",
  "BKgEtgTEBNME4QTwBP4FDQUcBSsFOgVJBVgFZwV3BYYFlgWmBbUFxQXVBeUF9gYGBhYGJwY3BkgG",
  "WQZqBnsGjAadBq8GwAbRBuMG9QcHBxkHKwc9B08HYQd0B4YHmQesB78H0gflB/gICwgfCDIIRgha",
  "CG4IggiWCKoIvgjSCOcI+wkQCSUJOglPCWQJeQmPCaQJugnPCeUJ+woRCicKPQpUCmoKgQqYCq4K",
  "xQrcCvMLCwsiCzkLUQtpC4ALmAuwC8gL4Qv5DBIMKgxDDFwMdQyODKcMwAzZDPMNDQ0mDUANWg10",
  "DY4NqQ3DDd4N+A4TDi4OSQ5kDn8Omw62DtIO7g8JDyUPQQ9eD3oPlg+zD88P7BAJECYQQxBhEH4Q",
  "mxC5ENcQ9RETETERTxFtEYwRqhHJEegSBxImEkUSZBKEEqMSwxLjEwMTIxNDE2MTgxOkE8UT5RQG",
  "FCcUSRRqFIsUrRTOFPAVEhU0FVYVeBWbFb0V4BYDFiYWSRZsFo8WshbWFvoXHRdBF2UXiReuF9IX",
  "9xgbGEAYZRiKGK8Y1Rj6GSAZRRlrGZEZtxndGgQaKhpRGncanhrFGuwbFBs7G2MbihuyG9ocAhwq",
  "HFIcexyjHMwc9R0eHUcdcB2ZHcMd7B4WHkAeah6UHr4e6R8THz4faR+UH78f6iAVIEEgbCCYIMQg",
  "8CEcIUghdSGhIc4h+yInIlUigiKvIt0jCiM4I2YjlCPCI/AkHyRNJHwkqyTaJQklOCVoJZclxyX3",
  "JicmVyaHJrcm6CcYJ0kneierJ9woDSg/KHEooijUKQYpOClrKZ0p0CoCKjUqaCqbKs8rAis2K2kr",
  "nSvRLAUsOSxuLKIs1y0MLUEtdi2rLeEuFi5MLoIuty7uLyQvWi+RL8cv/jA1MGwwpDDbMRIxSjGC",
  "Mbox8jIqMmMymzLUMw0zRjN/M7gz8TQrNGU0njTYNRM1TTWHNcI1/TY3NnI2rjbpNyQ3YDecN9c4",
  "FDhQOIw4yDkFOUI5fzm8Ofk6Njp0OrI67zstO2s7qjvoPCc8ZTykPOM9Ij1hPaE94D4gPmA+oD7g",
  "PyE/YT+iP+JAI0BkQKZA50EpQWpBrEHuQjBCckK1QvdDOkN9Q8BEA0RHRIpEzkUSRVVFmkXeRiJG",
  "Z0arRvBHNUd7R8BIBUhLSJFI10kdSWNJqUnwSjdKfUrESwxLU0uaS+JMKkxyTLpNAk1KTZNN3E4l",
  "Tm5Ot08AT0lPk0/dUCdQcVC7UQZRUFGbUeZSMVJ8UsdTE1NfU6pT9lRCVI9U21UoVXVVwlYPVlxW",
  "qVb3V0RXklfgWC9YfVjLWRpZaVm4WgdaVlqmWvVbRVuVW+VcNVyGXNZdJ114XcleGl5sXr1fD19h",
  "X7NgBWBXYKpg/GFPYaJh9WJJYpxi8GNDY5dj62RAZJRk6WU9ZZJl52Y9ZpJm6Gc9Z5Nn6Wg/aJZo",
  "7GlDaZpp8WpIap9q92tPa6dr/2xXbK9tCG1gbbluEm5rbsRvHm94b9FwK3CGcOBxOnGVcfByS3Km",
  "cwFzXXO4dBR0cHTMdSh1hXXhdj52m3b4d1Z3s3gReG54zHkqeYl553pGeqV7BHtje8J8IXyBfOF9",
  "QX2hfgF+Yn7CfyN/hH/lgEeAqIEKgWuBzYIwgpKC9INXg7qEHYSAhOOFR4Wrhg6GcobXhzuHn4gE",
  "iGmIzokziZmJ/opkisqLMIuWi/yMY4zKjTGNmI3/jmaOzo82j56QBpBukNaRP5GokhGSepLjk02T",
  "tpQglIqU9JVflcmWNJaflwqXdZfgmEyYuJkkmZCZ/JpomtWbQpuvnByciZz3nWSd0p5Anq6fHZ+L",
  "n/qgaaDYoUehtqImopajBqN2o+akVqTHpTilqaYapoum/adup+CoUqjEqTepqaocqo+rAqt1q+ms",
  "XKzQrUStuK4trqGvFq+LsACwdbDqsWCx1rJLssKzOLOutCW0nLUTtYq2AbZ5tvC3aLfguFm40blK",
  "ucK6O7q1uy67p7whvJu9Fb2Pvgq+hL7/v3q/9cBwwOzBZ8Hjwl/C28NYw9TEUcTOxUvFyMZGxsPH",
  "Qce/yD3IvMk6ybnKOMq3yzbLtsw1zLXNNc21zjbOts83z7jQOdC60TzRvtI/0sHTRNPG1EnUy9VO",
  "1dHWVdbY11zX4Nhk2OjZbNnx2nba+9uA3AXcit0Q3ZbeHN6i3ynfr+A24L3hROHM4lPi2+Nj4+vk",
  "c+T85YTmDeaW5x/nqegy6LzpRunQ6lvq5etw6/vshu0R7ZzuKO6070DvzPBY8OXxcvH/8ozzGfOn",
  "9DT0wvVQ9d72bfb794r4Gfio+Tj5x/pX+uf7d/wH/Jj9Kf26/kv+3P9t//8="
].join('');

// Decoded sRGB profile bytes. Shared singleton — the underlying ArrayBuffer
// is reused across calls but the Uint8Array view is fresh each time so
// consumers can transfer it without affecting other callers.
let _cached = null;

function srgbProfile() {
  if (_cached) return new Uint8Array(_cached);
  const bin = atob(SRGB_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  _cached = out.buffer;
  return new Uint8Array(_cached);
}

// -- pdf3a.js --

// @gcu/pdf3a — PDF/A-3B enrichment for pdf-lib documents.
//
// Adds the four pieces required by ISO 19005-3 level B:
//
//   1. sRGB output intent (embedded ICC profile).
//   2. XMP metadata block declaring pdfaid:part=3, pdfaid:conformance=B,
//      plus an optional consumer-defined namespace via customSchema.
//   3. /AF (Associated Files) table with per-attachment AFRelationship tag,
//      plus /Names /EmbeddedFiles for legacy viewer compatibility.
//   4. Trailer /ID entry.
//
// The library does not bundle pdf-lib — the consumer creates a PDFDocument
// (using whatever pdf-lib version they want) and passes both the pdf-lib
// module and the document into applyPdfA3.
//
// Translated from the cert engine's TypeScript original (cert/engine/src/
// pdfa.ts). Generalised: cert's hard-coded gcu:credentialCode / issuerId /
// credentialHash schema is now a configurable customSchema parameter so
// any consumer can declare its own XMP namespace and properties.

// ── XMP metadata ────────────────────────────────────────────────────────

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmpDate(d) {
  // XMP date: ISO 8601 with timezone. Drop milliseconds to match PDF
  // conventions (the milliseconds suffix breaks some validators).
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

// Build the pdfaExtension:schemas block declaring a consumer namespace.
// PDF/A requires this for any non-standard XMP namespace, otherwise
// veraPDF rejects the file.
function buildExtensionSchemaBlock(custom) {
  if (!custom) return '';
  const props = (custom.properties || []).map(p => `                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>${escapeXml(p.name)}</pdfaProperty:name>
                  <pdfaProperty:valueType>${escapeXml(p.valueType || 'Text')}</pdfaProperty:valueType>
                  <pdfaProperty:category>${escapeXml(p.category || 'external')}</pdfaProperty:category>
                  <pdfaProperty:description>${escapeXml(p.description || '')}</pdfaProperty:description>
                </rdf:li>`).join('\n');
  return `      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:namespaceURI>${escapeXml(custom.namespace)}</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>${escapeXml(custom.prefix)}</pdfaSchema:prefix>
            <pdfaSchema:schema>${escapeXml(custom.schemaName || '')}</pdfaSchema:schema>
            <pdfaSchema:property>
              <rdf:Seq>
${props}
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>`;
}

// Build the consumer-namespace property values block. Each property listed
// in customSchema.properties is emitted as <prefix:name>value</prefix:name>
// inside the main rdf:Description.
function buildCustomValuesBlock(custom) {
  if (!custom || !custom.values) return '';
  const lines = [];
  for (const prop of (custom.properties || [])) {
    const v = custom.values[prop.name];
    if (v == null) continue;
    lines.push(`      <${custom.prefix}:${prop.name}>${escapeXml(String(v))}</${custom.prefix}:${prop.name}>`);
  }
  return lines.join('\n');
}

// Public: build a complete XMP metadata document for embedding via /Metadata.
// Exposed so consumers can sanity-check the output without writing a PDF.
//
// input: {
//   title:        string,
//   subject?:     string,           — appears as dc:description
//   creator?:     string,
//   createDate?:  Date,             — defaults to now
//   producer?:    string,           — defaults to "pdf-lib"
//   creatorTool?: string,           — defaults to "@gcu/pdf3a"
//   customSchema?: {
//     namespace:  string,            — e.g. "https://gentropic.org/cert/ns/gcu/1.0/"
//     prefix:     string,            — e.g. "gcu"
//     schemaName: string,            — human-readable
//     properties: [{ name, valueType?, category?, description? }],
//     values:     { [name]: string },
//   },
// }
function buildXmpMetadata(input) {
  const created = input.createDate || new Date();
  const iso = xmpDate(created);
  const custom = input.customSchema;
  const customNsAttr = custom ? `\n        xmlns:${custom.prefix}="${escapeXml(custom.namespace)}"` : '';
  const customValues = buildCustomValuesBlock(custom);
  const customValuesBlock = customValues ? `\n${customValues}` : '';
  const extensionBlock = buildExtensionSchemaBlock(custom);
  const extensionWithSep = extensionBlock ? `\n${extensionBlock}` : '';

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"${customNsAttr}>
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(input.title || '')}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${escapeXml(input.creator || '')}</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(input.subject || '')}</rdf:li></rdf:Alt></dc:description>
      <xmp:CreateDate>${iso}</xmp:CreateDate>
      <xmp:ModifyDate>${iso}</xmp:ModifyDate>
      <xmp:MetadataDate>${iso}</xmp:MetadataDate>
      <xmp:CreatorTool>${escapeXml(input.creatorTool || '@gcu/pdf3a')}</xmp:CreatorTool>
      <pdf:Producer>${escapeXml(input.producer || 'pdf-lib')}</pdf:Producer>${customValuesBlock}${extensionWithSep}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ── PDF date format ─────────────────────────────────────────────────────

function pdfDate(d) {
  // PDF date format: D:YYYYMMDDHHmmSS+00'00'
  const pad = n => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${
    pad(d.getUTCHours())
  }${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}+00'00'`;
}

// Exposed for tests and consumer debugging.

// ── output intent (sRGB ICC profile) ────────────────────────────────────

function addOutputIntent(pdfLib, pdf, iccProfile) {
  const { PDFArray, PDFName, PDFRawStream, PDFString } = pdfLib;
  const iccStream = PDFRawStream.of(
    pdf.context.obj({ N: 3, Length: iccProfile.length }),
    iccProfile,
  );
  const iccRef = pdf.context.register(iccStream);

  const intent = pdf.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    DestOutputProfile: iccRef,
  });

  const intents = PDFArray.withContext(pdf.context);
  intents.push(intent);
  pdf.catalog.set(PDFName.of('OutputIntents'), intents);
}

// ── XMP metadata stream ─────────────────────────────────────────────────

function addMetadataStream(pdfLib, pdf, xmp) {
  const { PDFName, PDFRawStream } = pdfLib;
  const xmpBytes = new TextEncoder().encode(xmp);
  const metaStream = PDFRawStream.of(
    pdf.context.obj({
      Type: 'Metadata',
      Subtype: 'XML',
      Length: xmpBytes.length,
    }),
    xmpBytes,
  );
  const metaRef = pdf.context.register(metaStream);
  pdf.catalog.set(PDFName.of('Metadata'), metaRef);
}

// ── Associated Files (/AF) + /Names /EmbeddedFiles ──────────────────────

const VALID_RELATIONSHIPS = ['Source', 'Data', 'Alternative', 'Supplement', 'Unspecified'];

function addAttachmentsAf(pdfLib, pdf, attachments) {
  if (!attachments || attachments.length === 0) return;
  const { PDFArray, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFString } = pdfLib;

  const afArray = PDFArray.withContext(pdf.context);
  // Also build /Names /EmbeddedFiles for viewer compatibility — some viewers
  // (older Preview, evince) only enumerate attachments via /Names, not /AF.
  const namesArray = PDFArray.withContext(pdf.context);

  for (const att of attachments) {
    if (!VALID_RELATIONSHIPS.includes(att.relationship)) {
      throw new Error(`@gcu/pdf3a: invalid AFRelationship "${att.relationship}" for attachment "${att.name}"`);
    }
    const created = att.creationDate || new Date();
    const efStream = PDFRawStream.of(
      pdf.context.obj({
        Type: 'EmbeddedFile',
        Subtype: att.mimeType,
        Length: att.bytes.length,
        Params: {
          Size: att.bytes.length,
          CreationDate: PDFString.of(pdfDate(created)),
          ModDate: PDFString.of(pdfDate(created)),
        },
      }),
      att.bytes,
    );
    const efRef = pdf.context.register(efStream);

    const fileSpec = pdf.context.obj({
      Type: 'Filespec',
      F: PDFString.of(att.name),
      UF: PDFHexString.fromText(att.name),
      Desc: PDFHexString.fromText(att.description || ''),
      AFRelationship: PDFName.of(att.relationship),
      EF: { F: efRef, UF: efRef },
    });
    const fileSpecRef = pdf.context.register(fileSpec);

    afArray.push(fileSpecRef);
    namesArray.push(PDFHexString.fromText(att.name));
    namesArray.push(fileSpecRef);
  }

  pdf.catalog.set(PDFName.of('AF'), afArray);

  // /Names /EmbeddedFiles for legacy PDF viewers (independent of /AF). Reuse
  // any existing /Names dict (e.g. if the consumer added /Dests for links).
  let namesDict = pdf.catalog.get(PDFName.of('Names'));
  if (!namesDict || !(namesDict instanceof PDFDict)) {
    namesDict = PDFDict.withContext(pdf.context);
    pdf.catalog.set(PDFName.of('Names'), namesDict);
  }
  const embedded = pdf.context.obj({ Names: namesArray });
  namesDict.set(PDFName.of('EmbeddedFiles'), embedded);
}

// ── Trailer /ID ─────────────────────────────────────────────────────────

function setTrailerId(pdfLib, pdf) {
  // PDF/A requires a trailer /ID entry (File Identifier). pdf-lib doesn't set
  // one by default when saving without object streams. Deriving from the
  // document's content would be ideal for determinism; a v4 UUID is an
  // acceptable fallback per PDF 32000-1 §14.4 (any two random byte strings
  // satisfy veraPDF). We use the same value for both slots on first-save.
  const { PDFArray, PDFHexString } = pdfLib;
  const idHex = (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : fallbackUuidHex()
  ).replace(/-/g, '').toUpperCase();
  const id = PDFHexString.of(idHex);
  const idArr = PDFArray.withContext(pdf.context);
  idArr.push(id);
  idArr.push(id);
  pdf.context.trailerInfo.ID = idArr;
}

function fallbackUuidHex() {
  // Used only when crypto.randomUUID isn't available (very old runtimes).
  // Not cryptographically strong; the file ID isn't a security primitive.
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ── public entry ────────────────────────────────────────────────────────

// applyPdfA3(pdfLib, pdf, input) — apply the four PDF/A-3B enrichments to
// a PDFDocument before saving.
//
// Required:
//   pdfLib:           the imported pdf-lib module (we destructure the
//                     PDFArray / PDFDict / PDFRawStream / etc. constructors)
//   pdf:              a PDFDocument the consumer already populated
//   input.xmp:        XMP metadata input — see buildXmpMetadata for shape
//
// Optional:
//   input.iccProfile:  Uint8Array of an ICC profile. Defaults to the bundled
//                      sRGB IEC61966-2.1 v2 profile (3 KB) — fine for any
//                      consumer that doesn't have specific colour-management
//                      requirements. Override only if you need a different
//                      output intent (e.g. CMYK for print proofs).
//   input.attachments: array of PdfAttachment objects (name, bytes, mimeType,
//                      description, relationship, creationDate?). Each is
//                      embedded with a /Filespec carrying /AFRelationship.
//   input.lang:        document language tag, defaults to "en-US"
//
// After this call, save with `pdf.save({ useObjectStreams: false })` so the
// trailer /ID survives. Object streams reshuffle indirect references and
// strip the trailer dictionary's ID entry, which veraPDF flags.
async function applyPdfA3(pdfLib, pdf, input) {
  if (!pdfLib || !pdfLib.PDFArray) {
    throw new Error('@gcu/pdf3a: pdfLib must be the imported pdf-lib module');
  }
  if (!pdf || !pdf.catalog) {
    throw new Error('@gcu/pdf3a: pdf must be a pdf-lib PDFDocument');
  }
  if (!input || !input.xmp) {
    throw new Error('@gcu/pdf3a: input.xmp is required');
  }

  const { PDFName, PDFString } = pdfLib;
  const iccProfile = input.iccProfile || srgbProfile();

  // 1. Document language (catalog /Lang).
  pdf.catalog.set(PDFName.of('Lang'), PDFString.of(input.lang || 'en-US'));
  // 2. Output intent with sRGB ICC (bundled default unless consumer overrides).
  addOutputIntent(pdfLib, pdf, iccProfile);
  // 3. XMP metadata (with optional pdfaExtension schema for custom namespace).
  addMetadataStream(pdfLib, pdf, buildXmpMetadata(input.xmp));
  // 4. Associated Files table with per-attachment AFRelationship.
  addAttachmentsAf(pdfLib, pdf, input.attachments || []);
  // 5. Trailer /ID.
  setTrailerId(pdfLib, pdf);

  // Returned promise allows future async steps (e.g. ICC validation) without
  // breaking callers.
  return Promise.resolve();
}

// Surfaces for consumer introspection / testing.

// -- main.js --

// @gcu/pdf3a — import manifest (build concat order). The build script reads
// these import statements to determine the order in which files are
// concatenated into ext/pdf3a/index.js.

export { applyPdfA3, buildXmpMetadata, pdfDate, srgbProfile, VALID_RELATIONSHIPS };
