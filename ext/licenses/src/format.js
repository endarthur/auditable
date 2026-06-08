// Formatters for license aggregation output.
//
// Input shape (the table — as produced by aggregateLicenses, not yet shipped):
//   [
//     { pkg, version, source, path, spdx, classification, confidence?, verified?,
//       copyright?, text?, fetchedFrom? },
//     ...
//   ]
//
// 'pkg' is the bare name (lodash); 'version' is optional (vendored deps may
// just be '6.x'); 'source' is one of:
//   'install'    — runtime install() in a notebook
//   'pkg/npm', 'pkg/jsr', 'pkg/gh', 'pkg/local' — workspace pkg manager
//   'vendored'   — build-time-baked dep from /sys/licenses/
//
// Three output modes:
//   text     — geas stdout / log lines
//   html     — settings UI table rows
//   spdx-bom — SPDX SBOM 2.3 JSON (compliance tooling)
//
// formatNoticesFile produces a single plaintext blob suitable for a
// THIRD-PARTY-NOTICES.txt sidecar.

const STATUS_TEXT = {
  permissive:        'ok',
  'weak-copyleft':   'weak copyleft',
  'strong-copyleft': 'strong copyleft',
  unknown:           'no license',
};

const STATUS_HTML_CLASS = {
  permissive:        'lic-ok',
  'weak-copyleft':   'lic-warn',
  'strong-copyleft': 'lic-danger',
  unknown:           'lic-unknown',
};

function pkgLabel(entry) {
  return entry.version ? `${entry.pkg}@${entry.version}` : entry.pkg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Text ─────────────────────────────────────────────────────────────────

function formatText(table) {
  const rows = table.map((e) => ({
    pkg:    pkgLabel(e),
    spdx:   e.spdx || 'UNKNOWN',
    source: e.source || '-',
    status: STATUS_TEXT[e.classification] || 'unknown',
  }));

  const headers = { pkg: 'Package', spdx: 'SPDX', source: 'Source', status: 'Status' };
  const widths = {};
  for (const k of Object.keys(headers)) {
    widths[k] = headers[k].length;
    for (const r of rows) widths[k] = Math.max(widths[k], r[k].length);
  }

  const pad = (s, w) => s + ' '.repeat(w - s.length);
  const line = (r) =>
    `${pad(r.pkg, widths.pkg)}  ${pad(r.spdx, widths.spdx)}  ${pad(r.source, widths.source)}  ${r.status}`;

  const out = [line(headers)];
  out.push('-'.repeat(out[0].length));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

// ── HTML ─────────────────────────────────────────────────────────────────

function formatHtml(table) {
  const out = ['<table class="lic-table">'];
  out.push('<thead><tr>',
    '<th>Package</th>',
    '<th>SPDX</th>',
    '<th>Source</th>',
    '<th>Status</th>',
    '</tr></thead><tbody>');
  for (const e of table) {
    const cls = STATUS_HTML_CLASS[e.classification] || 'lic-unknown';
    out.push(
      `<tr class="${cls}">`,
      `<td>${escapeHtml(pkgLabel(e))}</td>`,
      `<td>${escapeHtml(e.spdx || 'UNKNOWN')}</td>`,
      `<td>${escapeHtml(e.source || '-')}</td>`,
      `<td>${escapeHtml(STATUS_TEXT[e.classification] || 'unknown')}</td>`,
      '</tr>'
    );
  }
  out.push('</tbody></table>');
  return out.join('');
}

// ── SPDX SBOM 2.3 ────────────────────────────────────────────────────────
//
// Minimal-but-conformant SBOM document. Real compliance tooling (e.g.
// spdx-tools, FOSSology) accepts this shape. We don't compute file-level
// SPDX info — package granularity only.

function spdxRef(entry, idx) {
  // SPDXID must match: ^SPDXRef-[A-Za-z0-9.\-]+$
  const safe = String(pkgLabel(entry)).replace(/[^A-Za-z0-9.\-]/g, '-');
  return `SPDXRef-Package-${safe}-${idx}`;
}

function formatSpdxBom(table, opts = {}) {
  const now = (opts.now || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const docName = opts.documentName || 'auditable-workspace';
  const namespace = opts.documentNamespace
    || `https://gentropic.org/auditable/sbom/${docName}-${Date.now()}`;

  const packages = table.map((e, idx) => {
    const declared = e.spdx && e.spdx !== 'UNKNOWN' ? e.spdx : 'NOASSERTION';
    return {
      SPDXID: spdxRef(e, idx),
      name: e.pkg,
      versionInfo: e.version || 'NOASSERTION',
      downloadLocation: e.fetchedFrom || 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: declared,
      licenseDeclared: declared,
      copyrightText: e.copyright || 'NOASSERTION',
    };
  });

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: namespace,
    creationInfo: {
      created: now,
      creators: ['Tool: @gcu/licenses-0.1.0'],
    },
    packages,
    relationships: packages.map((p) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relatedSpdxElement: p.SPDXID,
      relationshipType: 'DESCRIBES',
    })),
  };
}

// ── Public ───────────────────────────────────────────────────────────────

export function formatTable(table, opts = {}) {
  if (!Array.isArray(table)) throw new TypeError('formatTable: table must be an array');
  const format = opts.format || 'text';
  switch (format) {
    case 'text':     return formatText(table);
    case 'html':     return formatHtml(table);
    case 'spdx-bom': return formatSpdxBom(table, opts);
    default: throw new Error(`formatTable: unknown format '${format}'`);
  }
}

// formatNoticesFile — single plaintext blob for a THIRD-PARTY-NOTICES.txt
// sidecar. Each entry: header + copyright + LICENSE text + separator.
export function formatNoticesFile(table, opts = {}) {
  if (!Array.isArray(table)) throw new TypeError('formatNoticesFile: table must be an array');
  const intro = opts.intro
    || `Third-party notices\n` +
       `===================\n\n` +
       `This artifact includes the following third-party components.\n` +
       `Each component is reproduced under its own license; see the per-entry\n` +
       `license text below for terms.\n`;
  const SEP = '\n' + '='.repeat(72) + '\n\n';

  const parts = [intro];
  for (const e of table) {
    const lines = [];
    lines.push(SEP);
    lines.push(`${pkgLabel(e)}`);
    lines.push(`License: ${e.spdx || 'UNKNOWN'}`);
    if (e.source)      lines.push(`Source: ${e.source}`);
    if (e.fetchedFrom) lines.push(`Origin: ${e.fetchedFrom}`);
    if (e.copyright)   lines.push(`\n${e.copyright}`);
    lines.push('');
    if (e.text) {
      lines.push(e.text.trim());
    } else {
      lines.push('(No license text captured.)');
    }
    lines.push('');
    parts.push(lines.join('\n'));
  }
  return parts.join('');
}
