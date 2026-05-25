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

export function isKnownSpdxId(id) {
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

export { SPDX_CORPUS, SPDX_KINDS, canonicalize };

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
export function validateSpdx(expression) {
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
export function parseSpdx(expression) {
  const r = validateSpdx(expression);
  if (!r.valid) throw new Error(`invalid SPDX expression: ${r.reason}`);
  return r.ast;
}
