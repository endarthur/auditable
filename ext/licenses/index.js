// @gcu/licenses — third-party license attribution for the GCU stack
// Auto-generated from ext/licenses/src/ — do not edit directly

// -- spdx.js --

// SPDX 3.0 license expression parser + bundled corpus.
//
// The corpus covers ~30 most-common SPDX ids — enough for >99% of real-world
// npm packages plus the academic/research adjacent stuff GCU users encounter.
// Anything outside the corpus parses fine (the parser is grammar-driven, not
// corpus-bound) but classify() returns 'unknown' for unrecognized ids.
//
// Grammar (SPDX 3.0):
//   compound  ::= or-expr
//   or-expr   ::= and-expr ("OR"  and-expr)*
//   and-expr  ::= with-expr ("AND" with-expr)*
//   with-expr ::= simple ("WITH" exception-id)?
//   simple    ::= id "+"? | "(" or-expr ")"
//   id        ::= [A-Za-z0-9][A-Za-z0-9.+-]*
//
// Precedence (high → low): "+", WITH, AND, OR. Operators are left-associative.

// ── Corpus ───────────────────────────────────────────────────────────────
// kind: 'permissive' | 'weak-copyleft' | 'strong-copyleft'
// fsfLibre / osiApproved fields omitted from v0.1 — add if a UI surfaces them.

const SPDX_KINDS = Object.freeze({
  PERMISSIVE: 'permissive',
  WEAK_COPYLEFT: 'weak-copyleft',
  STRONG_COPYLEFT: 'strong-copyleft',
  UNKNOWN: 'unknown',
});

const SPDX_CORPUS = Object.freeze({
  // Permissive — the long tail of "just attribute me".
  'MIT':              { kind: 'permissive', name: 'MIT License' },
  'MIT-0':            { kind: 'permissive', name: 'MIT No Attribution' },
  'Apache-2.0':       { kind: 'permissive', name: 'Apache License 2.0' },
  'BSD-2-Clause':     { kind: 'permissive', name: 'BSD 2-Clause "Simplified" License' },
  'BSD-3-Clause':     { kind: 'permissive', name: 'BSD 3-Clause "New" or "Revised" License' },
  'BSD-3-Clause-Clear': { kind: 'permissive', name: 'BSD 3-Clause Clear License' },
  'ISC':              { kind: 'permissive', name: 'ISC License' },
  '0BSD':             { kind: 'permissive', name: 'BSD Zero Clause License' },
  'Unlicense':        { kind: 'permissive', name: 'The Unlicense' },
  'WTFPL':            { kind: 'permissive', name: 'Do What The F*ck You Want To Public License' },
  'BlueOak-1.0.0':    { kind: 'permissive', name: 'Blue Oak Model License 1.0.0' },
  'CC0-1.0':          { kind: 'permissive', name: 'Creative Commons Zero v1.0 Universal' },
  'CC-BY-4.0':        { kind: 'permissive', name: 'Creative Commons Attribution 4.0 International' },
  'Python-2.0':       { kind: 'permissive', name: 'Python License 2.0' },
  'PSF-2.0':          { kind: 'permissive', name: 'Python Software Foundation License 2.0' },
  'Zlib':             { kind: 'permissive', name: 'zlib License' },
  'MS-PL':            { kind: 'permissive', name: 'Microsoft Public License' },
  'AFL-3.0':          { kind: 'permissive', name: 'Academic Free License v3.0' },
  'OFL-1.1':          { kind: 'permissive', name: 'SIL Open Font License 1.1' },
  'X11':              { kind: 'permissive', name: 'X11 License' },
  'Artistic-2.0':     { kind: 'permissive', name: 'Artistic License 2.0' },

  // Weak copyleft — file/library-level reciprocity.
  'LGPL-2.1-only':     { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v2.1 only' },
  'LGPL-2.1-or-later': { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v2.1 or later' },
  'LGPL-3.0-only':     { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v3.0 only' },
  'LGPL-3.0-or-later': { kind: 'weak-copyleft', name: 'GNU Lesser General Public License v3.0 or later' },
  'MPL-2.0':           { kind: 'weak-copyleft', name: 'Mozilla Public License 2.0' },
  'MPL-1.1':           { kind: 'weak-copyleft', name: 'Mozilla Public License 1.1' },
  'EPL-1.0':           { kind: 'weak-copyleft', name: 'Eclipse Public License 1.0' },
  'EPL-2.0':           { kind: 'weak-copyleft', name: 'Eclipse Public License 2.0' },
  'CDDL-1.0':          { kind: 'weak-copyleft', name: 'Common Development and Distribution License 1.0' },
  'CDDL-1.1':          { kind: 'weak-copyleft', name: 'Common Development and Distribution License 1.1' },
  'CC-BY-SA-4.0':      { kind: 'weak-copyleft', name: 'Creative Commons Attribution Share Alike 4.0 International' },

  // Strong copyleft — viral.
  'GPL-2.0-only':      { kind: 'strong-copyleft', name: 'GNU General Public License v2.0 only' },
  'GPL-2.0-or-later':  { kind: 'strong-copyleft', name: 'GNU General Public License v2.0 or later' },
  'GPL-3.0-only':      { kind: 'strong-copyleft', name: 'GNU General Public License v3.0 only' },
  'GPL-3.0-or-later':  { kind: 'strong-copyleft', name: 'GNU General Public License v3.0 or later' },
  'AGPL-3.0-only':     { kind: 'strong-copyleft', name: 'GNU Affero General Public License v3.0 only' },
  'AGPL-3.0-or-later': { kind: 'strong-copyleft', name: 'GNU Affero General Public License v3.0 or later' },
});

// Legacy / deprecated ids that still appear in old package.json files.
// Per SPDX convention, bare "GPL-3.0" maps to "GPL-3.0-or-later" (npm history).
const SPDX_ALIASES = Object.freeze({
  'GPL-2.0':  'GPL-2.0-or-later',
  'GPL-3.0':  'GPL-3.0-or-later',
  'LGPL-2.1': 'LGPL-2.1-or-later',
  'LGPL-3.0': 'LGPL-3.0-or-later',
  'AGPL-3.0': 'AGPL-3.0-or-later',
  'BSD':      'BSD-3-Clause',
  'Apache':   'Apache-2.0',
});

function isKnownSpdxId(id) {
  if (typeof id !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(SPDX_CORPUS, id)
      || Object.prototype.hasOwnProperty.call(SPDX_ALIASES, id);
}

// Resolve aliases + strip "-or-later" / "+" suffix for corpus lookup.
// Returns canonical id present in SPDX_CORPUS, or null if no resolution.
function canonicalize(id) {
  if (Object.prototype.hasOwnProperty.call(SPDX_CORPUS, id)) return id;
  if (Object.prototype.hasOwnProperty.call(SPDX_ALIASES, id)) return SPDX_ALIASES[id];
  return null;
}


// ── Lexer ────────────────────────────────────────────────────────────────

const TOKEN = {
  ID: 'id', LPAREN: '(', RPAREN: ')', PLUS: '+', AND: 'AND', OR: 'OR', WITH: 'WITH',
};

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { tokens.push({ kind: TOKEN.LPAREN }); i++; continue; }
    if (c === ')') { tokens.push({ kind: TOKEN.RPAREN }); i++; continue; }
    if (c === '+') { tokens.push({ kind: TOKEN.PLUS }); i++; continue; }
    if (/[A-Za-z0-9]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9.\-]/.test(input[j])) j++;
      const word = input.slice(i, j);
      i = j;
      if (word === 'AND')  { tokens.push({ kind: TOKEN.AND }); continue; }
      if (word === 'OR')   { tokens.push({ kind: TOKEN.OR }); continue; }
      if (word === 'WITH') { tokens.push({ kind: TOKEN.WITH }); continue; }
      tokens.push({ kind: TOKEN.ID, value: word });
      continue;
    }
    return { error: `unexpected character '${c}' at position ${i}` };
  }
  return { tokens };
}

// ── Parser ───────────────────────────────────────────────────────────────
//
// AST nodes:
//   { kind: 'id',   id: 'MIT' }
//   { kind: 'plus', term: <id-node> }                  // GPL-2.0+
//   { kind: 'with', term: <node>, exception: 'name' }  // GPL-3.0+ WITH ...
//   { kind: 'and',  terms: [<node>, <node>, ...] }     // n-ary, flattened
//   { kind: 'or',   terms: [<node>, <node>, ...] }     // n-ary, flattened

function parser(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const eat  = (k) => {
    if (!tokens[i] || tokens[i].kind !== k) {
      throw new Error(`expected ${k}, got ${tokens[i] ? tokens[i].kind : 'EOF'}`);
    }
    return tokens[i++];
  };

  function parseOr() {
    const terms = [parseAnd()];
    while (peek() && peek().kind === TOKEN.OR) { eat(TOKEN.OR); terms.push(parseAnd()); }
    return terms.length === 1 ? terms[0] : { kind: 'or', terms };
  }

  function parseAnd() {
    const terms = [parseWith()];
    while (peek() && peek().kind === TOKEN.AND) { eat(TOKEN.AND); terms.push(parseWith()); }
    return terms.length === 1 ? terms[0] : { kind: 'and', terms };
  }

  function parseWith() {
    const term = parseSimple();
    if (peek() && peek().kind === TOKEN.WITH) {
      eat(TOKEN.WITH);
      if (!peek() || peek().kind !== TOKEN.ID) throw new Error('expected exception id after WITH');
      const exc = eat(TOKEN.ID);
      return { kind: 'with', term, exception: exc.value };
    }
    return term;
  }

  function parseSimple() {
    if (!peek()) throw new Error('unexpected end of expression');
    if (peek().kind === TOKEN.LPAREN) {
      eat(TOKEN.LPAREN);
      const inner = parseOr();
      eat(TOKEN.RPAREN);
      return inner;
    }
    if (peek().kind !== TOKEN.ID) throw new Error(`expected license id, got ${peek().kind}`);
    const id = eat(TOKEN.ID);
    let node = { kind: 'id', id: id.value };
    if (peek() && peek().kind === TOKEN.PLUS) { eat(TOKEN.PLUS); node = { kind: 'plus', term: node }; }
    return node;
  }

  const ast = parseOr();
  if (i < tokens.length) throw new Error(`unexpected token ${tokens[i].kind} after expression`);
  return ast;
}

// ── Public ───────────────────────────────────────────────────────────────

// validateSpdx(expression) → { valid: true, ast } | { valid: false, reason }
function validateSpdx(expression) {
  if (typeof expression !== 'string') return { valid: false, reason: 'not a string' };
  const trimmed = expression.trim();
  if (!trimmed) return { valid: false, reason: 'empty expression' };
  // npm anti-patterns: "SEE LICENSE IN <file>", "UNLICENSED", "Custom"
  if (/^SEE LICENSE IN /i.test(trimmed)) return { valid: false, reason: 'see-license-in placeholder' };
  if (/^UNLICENSED$/i.test(trimmed))     return { valid: false, reason: 'unlicensed marker' };

  const lex = tokenize(trimmed);
  if (lex.error) return { valid: false, reason: lex.error };
  try {
    const ast = parser(lex.tokens);
    return { valid: true, ast };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

// parseSpdx(expression) → ast, or throws.
// Convenience for callers who'd rather try/catch.
function parseSpdx(expression) {
  const r = validateSpdx(expression);
  if (!r.valid) throw new Error(`invalid SPDX expression: ${r.reason}`);
  return r.ast;
}

// -- classify.js --

// classify(id|expression) → 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown'
//
// Composition rules:
//   AND — must comply with all → take the MOST RESTRICTIVE classification
//   OR  — caller picks one     → take the MOST PERMISSIVE classification
//   WITH — preserves the base classification (the exception is a carve-out
//          to the same license; it doesn't change the broad kind)
//   "+"  — preserves the base classification (or-later semantics)
//
// "Unknown" is treated as maximally restrictive: in AND it dominates (we can't
// reason about it), in OR it loses to any known permissive option (a rational
// caller picks the known-safe license).


// Severity ordering — higher = more restrictive / less attractive.
const SEVERITY = {
  permissive: 0,
  'weak-copyleft': 1,
  'strong-copyleft': 2,
  unknown: 3,
};

const FROM_SEVERITY = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

function kindOfId(id) {
  const canonical = canonicalize(id);
  if (!canonical) return SPDX_KINDS.UNKNOWN;
  return SPDX_CORPUS[canonical].kind;
}

// Walk an AST node (as produced by parseSpdx) and return the kind.
function classifyExpression(ast) {
  if (!ast || typeof ast !== 'object') return SPDX_KINDS.UNKNOWN;
  switch (ast.kind) {
    case 'id':
      return kindOfId(ast.id);
    case 'plus':
      return classifyExpression(ast.term);
    case 'with':
      // The exception carves out specific permissions; the base license kind
      // is what governs reciprocity expectations. Classpath exception on
      // GPL-3.0 is still strong-copyleft for our warning purposes.
      return classifyExpression(ast.term);
    case 'and': {
      // Most restrictive (max severity).
      let worst = -1;
      for (const t of ast.terms) {
        const sev = SEVERITY[classifyExpression(t)];
        if (sev > worst) worst = sev;
      }
      return worst < 0 ? SPDX_KINDS.UNKNOWN : FROM_SEVERITY[worst];
    }
    case 'or': {
      // Most permissive (min severity).
      let best = Infinity;
      for (const t of ast.terms) {
        const sev = SEVERITY[classifyExpression(t)];
        if (sev < best) best = sev;
      }
      return !isFinite(best) ? SPDX_KINDS.UNKNOWN : FROM_SEVERITY[best];
    }
    default:
      return SPDX_KINDS.UNKNOWN;
  }
}

// classify accepts either a bare SPDX id, an SPDX expression string, or null.
// Returns the same four-way verdict regardless of input shape.
function classify(input) {
  if (input == null) return SPDX_KINDS.UNKNOWN;
  if (typeof input !== 'string') return SPDX_KINDS.UNKNOWN;
  const trimmed = input.trim();
  if (!trimmed) return SPDX_KINDS.UNKNOWN;

  // Fast path — bare id with no operators.
  if (/^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(trimmed)) {
    return kindOfId(trimmed);
  }

  // Expression path — parse + walk.
  const parsed = validateSpdx(trimmed);
  if (!parsed.valid) return SPDX_KINDS.UNKNOWN;
  return classifyExpression(parsed.ast);
}

// -- format.js --

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
    || `https://endarthur.github.io/auditable/sbom/${docName}-${Date.now()}`;

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

function formatTable(table, opts = {}) {
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
function formatNoticesFile(table, opts = {}) {
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

// -- api.js --

// Public surface for @gcu/licenses.
//
// Foundation (this commit):
//   - validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId  (from spdx.js)
//   - classify, classifyExpression                         (from classify.js)
//   - formatTable, formatNoticesFile                       (from format.js)
//
// Follow-up commits will add:
//   - fetchLicense (per-registry fetchers)
//   - aggregateLicenses (VFS view function)
//   - inferLicense (fingerprint fallback)
export {
  validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId, SPDX_KINDS,
  classify, classifyExpression,
  formatTable, formatNoticesFile,
};
