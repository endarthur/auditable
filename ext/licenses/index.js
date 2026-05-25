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

// -- fetch.js --

// fetchLicense — fetch + interpret SPDX + LICENSE info for a remote module.
//
// parseUrlToSource(url) → { source, pkg, version, origin } normalizes a
// remote URL into a registry descriptor; fetchLicense(desc) then dispatches
// to the appropriate per-registry handler.
//
// Per-registry handlers (esm.sh, jsdelivr, unpkg, github, jsr, generic url)
// each do up to ~3 small HTTP requests: typically package metadata +
// LICENSE-file probe. Failures degrade gracefully — the function never
// throws on registry quirks; it returns `{ spdx: 'UNKNOWN', spdxSource: ..., hint }`
// instead so the caller's install path stays unaffected.
//
// Network is injected via opts.fetch (defaults to globalThis.fetch). Tests
// pass a mock; production passes the real thing.

// ── parseUrlToSource ─────────────────────────────────────────────────────
//
// URL shapes handled:
//   https://esm.sh/<pkg>@<ver>[/<deep>][?<qs>]            → esm.sh
//   https://esm.sh/<pkg>                                   → esm.sh (no version)
//   https://esm.sh/@<scope>/<pkg>@<ver>                    → esm.sh (scoped)
//   https://cdn.jsdelivr.net/npm/<pkg>@<ver>[/<deep>]      → jsdelivr (npm)
//   https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>[...]  → github (via jsdelivr)
//   https://unpkg.com/<pkg>@<ver>[/<deep>]                 → unpkg
//   https://jsr.io/<pkg>@<ver>[/<deep>]                    → jsr (pkg is @scope/name)
//   https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<file>  → github
//   https://github.com/<owner>/<repo>/raw/<sha>/<file>             → github
//   anything else                                          → 'url' (generic)

const PKG_VERSION_RE = /^(?:(@[^/]+)\/)?([^@/]+)(?:@([^/?#]+))?(.*)$/;
//                      ^scope?           ^name    ^version       ^rest

function splitPkgVersion(slug) {
  // slug here is the path-after-prefix, no leading slash. Returns { pkg, version }
  // or null if not parseable. Handles scoped packages.
  const m = PKG_VERSION_RE.exec(slug);
  if (!m) return null;
  const scope = m[1] || '';
  const name = m[2];
  const version = m[3] || null;
  if (!name) return null;
  return { pkg: scope ? `${scope}/${name}` : name, version };
}

function parseUrlToSource(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }

  // esm.sh
  if (u.hostname === 'esm.sh' || u.hostname.endsWith('.esm.sh')) {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'esm.sh', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // jsdelivr (two prefixes: /npm/ and /gh/)
  if (u.hostname === 'cdn.jsdelivr.net') {
    if (u.pathname.startsWith('/npm/')) {
      const slug = u.pathname.slice(5);
      const pv = splitPkgVersion(slug);
      if (!pv) return null;
      return { source: 'jsdelivr', pkg: pv.pkg, version: pv.version, origin: url };
    }
    if (u.pathname.startsWith('/gh/')) {
      // /gh/<owner>/<repo>@<ref>[/...]
      const slug = u.pathname.slice(4);
      const m = /^([^/]+)\/([^/@]+)(?:@([^/]+))?(?:\/|$)/.exec(slug);
      if (!m) return null;
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3] || null,
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] || null },
      };
    }
  }

  // unpkg
  if (u.hostname === 'unpkg.com') {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'unpkg', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // jsr
  if (u.hostname === 'jsr.io') {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'jsr', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // GitHub raw
  if (u.hostname === 'raw.githubusercontent.com') {
    const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3],
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] },
      };
    }
  }
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3],
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] },
      };
    }
  }

  // Generic fallback — use hostname+path as pkg name, no version.
  return {
    source: 'url',
    pkg: u.hostname + u.pathname.replace(/\/[^/]*$/, ''),
    version: null,
    origin: url,
  };
}

// ── License field interpretation ─────────────────────────────────────────

// package.json#license can be: string, { type, url }, or absent.
// Older packages used a `licenses` array of { type, url } objects.
// Exported so aggregate.js can reuse the same logic on VFS-stored package.json
// files. At build time the `export` keyword is stripped and the function ends
// up as a single top-level declaration in the concatenated bundle.
function spdxFromPackageJson(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.license === 'string') return json.license;
  if (json.license && typeof json.license === 'object' && typeof json.license.type === 'string') {
    return json.license.type;
  }
  if (Array.isArray(json.licenses) && json.licenses.length > 0) {
    const types = json.licenses
      .map((l) => (l && typeof l === 'object' ? l.type : (typeof l === 'string' ? l : null)))
      .filter(Boolean);
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

// Extract a copyright notice line from LICENSE text. Best-effort, regex-y.
// Exported for aggregate.js's reuse — see spdxFromPackageJson note above.
function extractCopyright(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (/^Copyright\b/i.test(t) || /^\(c\)\s/i.test(t) || /^©\s/.test(t)) {
      if (t.length > 4 && t.length < 400) return t;
    }
  }
  return null;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function tryFetchText(fetch, url) {
  try {
    const res = await fetch(url);
    if (!res || !res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function tryFetchJson(fetch, url) {
  const text = await tryFetchText(fetch, url);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Probe a base directory for a LICENSE-like file. Returns { text, filename, url }
// on first hit, or null.
//
// Trimmed to the three canonical names — together they hit ~99% of real
// packages, and each miss costs an HTTP round-trip that the user can see in
// devtools as a noisy 404. The original long-tail (license.md, COPYING*,
// NOTICE) was nice-to-have but not worth the cost.
//
// Exported for aggregate.js's reuse — see spdxFromPackageJson note above.
const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
];

async function probeLicense(fetch, baseUrl) {
  for (const name of LICENSE_FILENAMES) {
    const url = baseUrl.replace(/\/$/, '') + '/' + name;
    const text = await tryFetchText(fetch, url);
    if (text) return { text, filename: name, url };
  }
  return null;
}

// ── Per-registry fetchers ────────────────────────────────────────────────

const STAMP = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function unknownResult({ origin, hint, fetchedFrom = null }) {
  return {
    spdx: 'UNKNOWN',
    text: null,
    copyright: null,
    spdxSource: 'unknown',
    textSource: null,
    fetchedFrom: fetchedFrom || origin || null,
    fetchedAt: STAMP(),
    confidence: 'low',
    hint: hint || null,
  };
}

function buildResult({ spdx, text, filename, baseUrl, spdxSource, textSource, origin }) {
  return {
    spdx: spdx || 'UNKNOWN',
    text: text || null,
    copyright: text ? extractCopyright(text) : null,
    spdxSource: spdx ? spdxSource : (text ? 'inferred-from-license-file' : 'unknown'),
    textSource: text ? textSource : null,
    fetchedFrom: text && filename ? `${baseUrl.replace(/\/$/, '')}/${filename}` : (origin || null),
    fetchedAt: STAMP(),
    confidence: spdx ? 'high' : (text ? 'low' : 'low'),
    hint: null,
  };
}

async function fetchFromCdnBase(fetch, desc, baseUrl) {
  // Both esm.sh and jsdelivr/npm expose package.json at <base>/package.json
  // and LICENSE files at <base>/<name>. unpkg too.
  const pkgJson = await tryFetchJson(fetch, baseUrl.replace(/\/$/, '') + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const probe = await probeLicense(fetch, baseUrl);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no package.json and no LICENSE file at base url' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl,
    spdxSource: 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

async function fetchEsmSh(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const esmBase = `https://esm.sh/${desc.pkg}${verSlug}`;
  // esm.sh serves package.json reliably but NOT arbitrary repo files
  // (LICENSE et al.). Use jsdelivr for the LICENSE-file probe — it mirrors
  // the npm tarball verbatim, so files like LICENSE that ship with the
  // tarball are served at predictable paths. Two CDNs, one HTTP request
  // each at the happy path (package.json from esm.sh, LICENSE from jsdelivr).
  const pkgJson = await tryFetchJson(fetch, esmBase + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const jsdBase = `https://cdn.jsdelivr.net/npm/${desc.pkg}${verSlug}`;
  const probe = await probeLicense(fetch, jsdBase);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no package.json on esm.sh and no LICENSE on jsdelivr' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl: jsdBase,
    spdxSource: 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

async function fetchJsdelivr(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://cdn.jsdelivr.net/npm/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchUnpkg(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://unpkg.com/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchJsr(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://jsr.io/${desc.pkg}${verSlug}`;
  // jsr exposes jsr.json (not package.json) — try both, prefer jsr.json
  const jsrJson = await tryFetchJson(fetch, base + '/jsr.json');
  const pkgJson = jsrJson || await tryFetchJson(fetch, base + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const probe = await probeLicense(fetch, base);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no jsr.json/package.json and no LICENSE on jsr.io' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl: base,
    spdxSource: jsrJson ? 'jsr.json' : 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

// GitHub License API returns { license: { spdx_id, name }, content: <base64>,
// encoding: 'base64', download_url, ... }. Rate-limited (60/hr unauthenticated).
async function fetchGithub(fetch, desc) {
  const owner = desc.github && desc.github.owner;
  const repo  = desc.github && desc.github.repo;
  if (!owner || !repo) {
    // Fall back to parsing from desc.pkg = "owner/repo"
    const parts = (desc.pkg || '').split('/');
    if (parts.length !== 2) return unknownResult({ origin: desc.origin, hint: 'cannot parse github owner/repo' });
  }
  const o = owner || desc.pkg.split('/')[0];
  const r = repo  || desc.pkg.split('/')[1];

  const api = `https://api.github.com/repos/${o}/${r}/license`;
  const json = await tryFetchJson(fetch, api);
  if (!json) {
    // Rate-limit or 404 — try raw fallback at <ref>/LICENSE
    const ref = (desc.github && desc.github.ref) || desc.version || 'HEAD';
    const rawBase = `https://raw.githubusercontent.com/${o}/${r}/${ref}`;
    const probe = await probeLicense(fetch, rawBase);
    if (!probe) {
      return unknownResult({ origin: desc.origin, hint: 'github API unreachable and no LICENSE in raw' });
    }
    return buildResult({
      spdx: null,
      text: probe.text,
      filename: probe.filename,
      baseUrl: rawBase,
      spdxSource: null,
      textSource: 'LICENSE-file',
      origin: desc.origin,
    });
  }

  const spdx = json.license && typeof json.license.spdx_id === 'string'
    ? (json.license.spdx_id === 'NOASSERTION' ? null : json.license.spdx_id)
    : null;
  let text = null;
  if (typeof json.content === 'string' && json.encoding === 'base64') {
    try {
      // Node + browser both have atob in modern envs; Node 16+ has globalThis.atob.
      const cleaned = json.content.replace(/\s+/g, '');
      text = typeof atob === 'function'
        ? atob(cleaned)
        : Buffer.from(cleaned, 'base64').toString('utf8');
    } catch { text = null; }
  }

  return {
    spdx: spdx || 'UNKNOWN',
    text,
    copyright: text ? extractCopyright(text) : null,
    spdxSource: spdx ? 'github-api' : (text ? 'inferred-from-license-file' : 'unknown'),
    textSource: text ? 'github-api' : null,
    fetchedFrom: json.download_url || api,
    fetchedAt: STAMP(),
    confidence: spdx ? 'high' : 'low',
    hint: null,
  };
}

// Generic-URL: best-effort. If the URL is a JS file at <host>/<path>/<file>.js,
// try a sibling LICENSE at <host>/<path>/LICENSE. If the URL is a directory,
// try LICENSE at root. Nothing else.
async function fetchGenericUrl(fetch, desc) {
  let u;
  try { u = new URL(desc.origin); } catch { return unknownResult({ origin: desc.origin, hint: 'unparseable url' }); }
  const dir = u.origin + u.pathname.replace(/\/[^/]*$/, '');
  const probe = await probeLicense(fetch, dir);
  if (!probe) return unknownResult({ origin: desc.origin, hint: 'no LICENSE near url' });
  return buildResult({
    spdx: null,
    text: probe.text,
    filename: probe.filename,
    baseUrl: dir,
    spdxSource: null,
    textSource: 'LICENSE-file',
    origin: desc.origin,
  });
}

// ── Public ───────────────────────────────────────────────────────────────

async function fetchLicense(input, opts = {}) {
  const fetch = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
  if (!fetch) {
    return { ...unknownResult({ origin: null, hint: 'no fetch available in environment' }), spdxSource: 'no-fetch' };
  }

  let desc;
  if (typeof input === 'string') desc = parseUrlToSource(input);
  else if (input && typeof input === 'object') desc = input;
  else return { ...unknownResult({ origin: null, hint: 'invalid input to fetchLicense' }), spdxSource: 'invalid-input' };

  if (!desc) return { ...unknownResult({ origin: typeof input === 'string' ? input : null, hint: 'could not parse url' }), spdxSource: 'unparseable-source' };

  switch (desc.source) {
    case 'esm.sh':   return fetchEsmSh(fetch, desc);
    case 'jsdelivr': return fetchJsdelivr(fetch, desc);
    case 'unpkg':    return fetchUnpkg(fetch, desc);
    case 'jsr':      return fetchJsr(fetch, desc);
    case 'github':   return fetchGithub(fetch, desc);
    case 'url':      return fetchGenericUrl(fetch, desc);
    default:
      return { ...unknownResult({ origin: desc.origin, hint: `no handler for source '${desc.source}'` }), spdxSource: 'no-handler' };
  }
}

// -- aggregate.js --

// aggregateLicenses(vfs) — pure view function over the workspace VFS.
//
// Walks three well-known roots and returns a flat table:
//   /var/modules/<key>/         — install()'d modules (meta.json + LICENSE)
//   /lib/<source>/<pkg>@<ver>/  — pkg-managed (package.json + LICENSE)
//   /sys/licenses/<name>/       — build-time-vendored (index.json + LICENSE)
//
// No caching, no aggregator file. The per-folder LICENSE is the canonical
// store; this function just walks + classifies. Tolerant of missing roots
// (returns the entries from whichever roots exist).
//
// VFS duck type — needs only:
//   readdir(path)            → array of names (string)
//   readFile(path, encoding) → string (encoding='utf8') or Uint8Array
//   stat(path)               → { type: 'file' | 'directory', ... }
//
// All three may throw on missing paths; we catch and treat as empty.



// ── VFS-safe helpers ─────────────────────────────────────────────────────

async function safeReaddir(vfs, path) {
  try {
    const r = vfs.readdir(path);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return []; }
}

async function safeReadFile(vfs, path, encoding) {
  try {
    const r = vfs.readFile(path, encoding);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return null; }
}

async function safeStat(vfs, path) {
  try {
    const r = vfs.stat(path);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return null; }
}

async function readJson(vfs, path) {
  const text = await safeReadFile(vfs, path, 'utf8');
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

// readLicenseFile reuses the LICENSE-filename list from fetch.js (probed against
// HTTP URLs there, VFS paths here). spdxFromPackageJson + extractCopyright are
// also shared — same heuristics whether we read package.json from a CDN or
// from a /lib/<pkg>/ directory.
async function readLicenseFile(vfs, dir) {
  for (const name of LICENSE_FILENAMES) {
    const text = await safeReadFile(vfs, `${dir}/${name}`, 'utf8');
    if (typeof text === 'string' && text.length > 0) {
      return { text, filename: name };
    }
  }
  return null;
}

// ── Per-root walkers ─────────────────────────────────────────────────────

// /var/modules/<url-encoded-key>/  → install()'d ESM modules
async function walkVarModules(vfs) {
  const out = [];
  const entries = await safeReaddir(vfs, '/var/modules');
  for (const key of entries) {
    const dir = `/var/modules/${key}`;
    const st = await safeStat(vfs, dir);
    if (!st || st.type !== 'directory') continue;

    const meta = await readJson(vfs, `${dir}/meta.json`) || {};
    const lic  = await readLicenseFile(vfs, dir);

    // Prefer meta.json.url for canonical pkg/version (round-trippable through
    // parseUrlToSource); fall back to decoded key.
    let pkg = null, version = null;
    if (typeof meta.url === 'string') {
      const desc = parseUrlToSource(meta.url);
      if (desc) { pkg = desc.pkg; version = desc.version; }
    }
    if (!pkg) {
      try {
        const decoded = decodeURIComponent(key);
        const desc = parseUrlToSource(decoded);
        if (desc) { pkg = desc.pkg; version = desc.version; }
      } catch { /* fall through */ }
    }
    if (!pkg) pkg = key;

    const spdx = (meta.license && typeof meta.license.spdx === 'string')
      ? meta.license.spdx
      : (lic ? null : 'UNKNOWN');

    out.push({
      pkg, version,
      source: 'install',
      path: dir,
      spdx: spdx || 'UNKNOWN',
      classification: classify(spdx),
      copyright: meta.license && meta.license.copyright || (lic ? extractCopyright(lic.text) : null),
      text: lic ? lic.text : null,
      fetchedFrom: meta.license && meta.license.fetchedFrom || null,
      verified: !!(meta.license && lic),  // meta says X, file present — verifiable
    });
  }
  return out;
}

// /lib/<source>/<pkg-dir>/  — pkg-managed packages
// Sources we recognize: npm, jsr, gh, @gcu/local
async function walkLib(vfs) {
  const out = [];
  const sources = await safeReaddir(vfs, '/lib');
  for (const srcName of sources) {
    const sourcePath = `/lib/${srcName}`;
    const st = await safeStat(vfs, sourcePath);
    if (!st || st.type !== 'directory') continue;

    // gh has nested owner/repo, others have flat pkg@ver.
    if (srcName === 'gh') {
      const owners = await safeReaddir(vfs, sourcePath);
      for (const owner of owners) {
        const repos = await safeReaddir(vfs, `${sourcePath}/${owner}`);
        for (const repoSlug of repos) {
          const dir = `${sourcePath}/${owner}/${repoSlug}`;
          const st2 = await safeStat(vfs, dir);
          if (!st2 || st2.type !== 'directory') continue;
          const m = /^([^@]+)(?:@(.+))?$/.exec(repoSlug);
          const repo = m ? m[1] : repoSlug;
          const ref  = m && m[2] ? m[2] : null;
          out.push(await collectLibEntry(vfs, dir, `${owner}/${repo}`, ref, 'pkg/gh'));
        }
      }
      continue;
    }

    const items = await safeReaddir(vfs, sourcePath);
    for (const item of items) {
      // Scoped npm packages are nested: /lib/npm/@scope/pkg@ver
      if (item.startsWith('@')) {
        const scoped = await safeReaddir(vfs, `${sourcePath}/${item}`);
        for (const sub of scoped) {
          const dir = `${sourcePath}/${item}/${sub}`;
          const st2 = await safeStat(vfs, dir);
          if (!st2 || st2.type !== 'directory') continue;
          const m = /^([^@]+)(?:@(.+))?$/.exec(sub);
          const name = m ? m[1] : sub;
          const ver  = m && m[2] ? m[2] : null;
          out.push(await collectLibEntry(vfs, dir, `${item}/${name}`, ver, `pkg/${srcName}`));
        }
        continue;
      }
      const dir = `${sourcePath}/${item}`;
      const st2 = await safeStat(vfs, dir);
      if (!st2 || st2.type !== 'directory') continue;
      const m = /^([^@]+)(?:@(.+))?$/.exec(item);
      const name = m ? m[1] : item;
      const ver  = m && m[2] ? m[2] : null;
      out.push(await collectLibEntry(vfs, dir, name, ver, `pkg/${srcName}`));
    }
  }
  return out;
}

async function collectLibEntry(vfs, dir, pkg, version, sourceTag) {
  const pkgJson = await readJson(vfs, `${dir}/package.json`)
              || await readJson(vfs, `${dir}/jsr.json`)
              || {};
  const lic = await readLicenseFile(vfs, dir);
  const spdx = spdxFromPackageJson(pkgJson) || (lic ? null : 'UNKNOWN');
  return {
    pkg, version,
    source: sourceTag,
    path: dir,
    spdx: spdx || 'UNKNOWN',
    classification: classify(spdx),
    copyright: lic ? extractCopyright(lic.text) : null,
    text: lic ? lic.text : null,
    fetchedFrom: null,
    verified: !!(spdx && lic),
  };
}

// /sys/licenses/<name>/  — build-time-vendored deps
async function walkSysLicenses(vfs) {
  const out = [];
  const index = await readJson(vfs, '/sys/licenses/index.json') || {};
  const names = await safeReaddir(vfs, '/sys/licenses');
  for (const name of names) {
    if (name === 'index.json') continue;
    const dir = `/sys/licenses/${name}`;
    const st = await safeStat(vfs, dir);
    if (!st || st.type !== 'directory') continue;

    const entry = index[name] || {};
    const lic = await readLicenseFile(vfs, dir);
    const spdx = (typeof entry.spdx === 'string' ? entry.spdx : null)
              || (lic ? null : 'UNKNOWN');

    out.push({
      pkg: name,
      version: entry.version || null,
      source: 'vendored',
      path: dir,
      spdx: spdx || 'UNKNOWN',
      classification: classify(spdx),
      copyright: lic ? extractCopyright(lic.text) : null,
      text: lic ? lic.text : null,
      fetchedFrom: entry.homepage || null,
      verified: !!(spdx && lic),
    });
  }
  return out;
}

// aggregateFromBuildLicenses — turn the build-time-injected manifest (see
// build.js's __BUILD_LICENSES__ injection, sourced from vendor-licenses.json)
// into the standard table shape. Used by the settings Licenses tab and the
// About dialog to surface what the binary itself was built from.
//
// Expected manifest shape:
//   { <name>: { spdx, version, homepage, description, text? } }
//
// Tolerant of missing fields — entries without `spdx` come through as UNKNOWN.
function aggregateFromBuildLicenses(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const out = [];
  for (const [name, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry !== 'object') continue;
    const spdx = (typeof entry.spdx === 'string') ? entry.spdx : 'UNKNOWN';
    out.push({
      pkg: name,
      version: entry.version || null,
      source: 'vendored',
      path: entry.homepage || name,
      spdx,
      classification: classify(spdx),
      copyright: typeof entry.text === 'string' ? extractCopyright(entry.text) : null,
      text: typeof entry.text === 'string' ? entry.text : null,
      fetchedFrom: entry.homepage || null,
      description: entry.description || null,
      verified: !!entry.text,
    });
  }
  return out;
}

// aggregateFromInstalledModules — in-memory variant for auditable's current
// runtime layout, where install()'d ESM modules live in a flat JS object
// (window._installedModules) rather than per-module VFS folders. Same entry
// shape as aggregateLicenses so the formatters and UI don't care which path
// produced the table.
//
// Expected entry shape (the runtime cache used by cell-builtins/modules.js):
//   _installedModules[url] = {
//     source, compressed, cellId, url, alias, integrity, kind,
//     installedAt, size,
//     license?:    { spdx, copyright, fetchedFrom, source, fetchedAt, ... },
//     licenseText?: string,   // raw or gzip-base64; treated as opaque text
//   }
//
// Pre-tracking entries (no `license` field) come through as classification:
// 'unknown' with `verified: false` — surfaces in the UI as a grey badge.
function aggregateFromInstalledModules(installedModules) {
  if (!installedModules || typeof installedModules !== 'object') return [];
  const out = [];
  for (const [key, entry] of Object.entries(installedModules)) {
    if (!entry || typeof entry !== 'object') continue;
    // binary assets aren't really "modules with licenses" — skip them. Their
    // upstream license, if any, is captured via the URL they came from in
    // the source-side install (handled separately by installBinary).
    if (entry.binary) continue;

    const url = entry.url || key;
    let pkg = null, version = null;
    const desc = parseUrlToSource(url);
    if (desc) { pkg = desc.pkg; version = desc.version; }
    if (!pkg) pkg = entry.alias || key;

    const lic = entry.license || null;
    const spdx = (lic && typeof lic.spdx === 'string') ? lic.spdx : 'UNKNOWN';
    out.push({
      pkg, version,
      source: 'install',
      path: key,                                         // the runtime cache key (URL)
      spdx,
      classification: classify(spdx),
      copyright: lic ? (lic.copyright || null) : null,
      text: typeof entry.licenseText === 'string' ? entry.licenseText : null,
      fetchedFrom: lic ? (lic.fetchedFrom || null) : null,
      verified: !!(lic && entry.licenseText),
    });
  }
  return out;
}

// ── Public ───────────────────────────────────────────────────────────────

async function aggregateLicenses(vfs) {
  if (!vfs || typeof vfs.readdir !== 'function' || typeof vfs.readFile !== 'function') {
    throw new TypeError('aggregateLicenses: vfs must implement readdir() and readFile()');
  }
  const [installs, lib, sys] = await Promise.all([
    walkVarModules(vfs),
    walkLib(vfs),
    walkSysLicenses(vfs),
  ]);
  // Stable order: vendored first (the binary's own deps), then pkg, then install.
  return [...sys, ...lib, ...installs];
}

// -- api.js --

// Public surface for @gcu/licenses.
//
// Shipped:
//   - validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId  (from spdx.js)
//   - classify, classifyExpression                         (from classify.js)
//   - formatTable, formatNoticesFile                       (from format.js)
//   - parseUrlToSource, fetchLicense                       (from fetch.js)
//   - aggregateLicenses                                    (from aggregate.js)
//
// Follow-up commits will add:
//   - inferLicense (fingerprint fallback for license-text → SPDX id)
export {
  validateSpdx, parseSpdx, SPDX_CORPUS, isKnownSpdxId, SPDX_KINDS,
  classify, classifyExpression,
  formatTable, formatNoticesFile,
  parseUrlToSource, fetchLicense,
  aggregateLicenses, aggregateFromInstalledModules, aggregateFromBuildLicenses,
};
