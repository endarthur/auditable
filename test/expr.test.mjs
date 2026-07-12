// @gcu/expr — the package's executable spec. Runs the fixture vectors through the
// tree-walk reference path, then the CORRECTNESS ORACLE: every vector compiled to
// positional closures must agree with the tree-walk (de-risks the one genuinely-new
// component — the closure compiler). Plus totality, deps, validate, and the GCU
// additions (geo / casts / tests / bracket / case-insensitivity).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, evaluate, evalBool, constraintValid, compile, compileBool, compileChunk, compileChunkBool, deps, validate, canMatch, quoteIdent, tokenize, complete } from '../ext/expr/src/main.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/expr.json', import.meta.url), 'utf8'));

test('expr fixture vectors — tree-walk reference path', () => {
  for (const v of fx.vectors) {
    if (v.verb === 'constrain') assert.equal(constraintValid(v.expr, v.values, v.target), v.expectedConstraintValid, v.expr);
    else if (v.verb === 'calculate') assert.equal(evaluate(v.expr, v.values), v.expected, v.expr);
    else assert.equal(evalBool(v.expr, v.values), v.expected, v.expr);   // bool / relevant
  }
});

test('ORACLE — compiled positional closures ≡ tree-walk, every vector', () => {
  for (const v of fx.vectors) {
    if (v.verb === 'constrain') continue;                    // constraintValid is tree-walk-only
    const columns = Object.keys(v.values);                   // name → index binding
    const fields = columns.map((c) => v.values[c]);          // the positional row the cursor would hand us
    const ast = parse(v.expr);
    const tree = evaluate(ast, v.values);
    const comp = compile(ast, columns)(fields);
    assert.deepEqual(comp, tree, `compiled≠treewalk for: ${v.expr}`);
    // boolean face agrees too
    assert.equal(compileBool(ast, columns)(fields), tree === true, `compileBool≠ for: ${v.expr}`);
  }
});

test('totality — bad syntax throws at parse; eval never throws', () => {
  assert.throws(() => parse('fe_pct >'), /parse error/);
  assert.throws(() => parse('fe_pct between 0 100'), /expected 'and'/);
  assert.throws(() => parse('a and and b'), /parse error/);
  assert.throws(() => parse('round()'), /round\(\) expects/);
  // eval is total — blank, never a throw
  assert.equal(evaluate('1 / 0', {}), null);
  assert.equal(evaluate('missing + 1', {}), null);
  assert.equal(evalBool('missing > 5', {}), false);
  assert.equal(evaluate('sqrt(x)', { x: -4 }), null);
  // a malformed regex in matches → false, not a throw
  assert.equal(evalBool('s matches "("', { s: 'x' }), false);
  // the compiled path is equally total
  assert.equal(compile('a / b', ['a', 'b'])([5, 0]), null);
  assert.equal(compileBool('a > b', ['a', 'b'])([null, 1]), false);
});

test('deps — free column references', () => {
  assert.deepEqual(deps('fe_pct between 0 and 100').sort(), ['fe_pct']);
  assert.deepEqual(deps('fe_pct > 60 and lithology = "itabirite"').sort(), ['fe_pct', 'lithology']);
  assert.deepEqual(deps('(a + b) * 2').sort(), ['a', 'b']);
  assert.deepEqual(deps('clamp(grade, lo, hi)').sort(), ['grade', 'hi', 'lo']);
  assert.deepEqual(deps('["Cu (ppm)"] > 30').sort(), ['Cu (ppm)']);
  assert.deepEqual(deps('if(g > 1, a, b)').sort(), ['a', 'b', 'g']);
});

test('validate — parse + unknown-column check', () => {
  assert.equal(validate('a > 1', ['a', 'b']).ok, true);
  const bad = validate('a > 1 and zzz < 5', ['a', 'b']);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].kind, 'column');
  assert.equal(bad.errors[0].name, 'zzz');
  const pe = validate('a >', ['a']);
  assert.equal(pe.ok, false);
  assert.equal(pe.errors[0].kind, 'parse');
  // case-insensitive column resolution
  assert.equal(validate('AU > 0.5', ['au']).ok, true);
  assert.equal(validate('au > 0.5', ['AU']).ok, true);
  // no columns supplied → parse-only (no column errors)
  assert.equal(validate('anything > here').ok, true);
});

test('compile — case-insensitive field binding + zero per-row allocation shape', () => {
  const f = compileBool('AU > 0.5 and `OK-Indic` = 1', ['au', 'ok-indic']);   // v0.2: hyphenated name takes backticks (bare `-` is subtraction)
  assert.equal(f([0.9, 1]), true);
  assert.equal(f([0.2, 1]), false);
  assert.equal(f([0.9, 0]), false);
  // unknown column compiles to blank (validate is where you'd catch it)
  assert.equal(compile('ghost + 1', ['a'])([5]), null);
});

test('lamina-dialect operators — && || == ~ !~ in (superset of parseFilter)', () => {
  const cols = ['grade', 'lito', 'code'];
  const row = { grade: 2, lito: 'OXIDE', code: 'DDH0042' };
  const f = (s) => compileBool(s, cols)([row.grade, row.lito, row.code]);
  // && / || / == aliases
  assert.equal(f('grade > 1 && lito == "OXIDE"'), true);
  assert.equal(f('grade > 5 || lito == "OXIDE"'), true);
  assert.equal(f('grade == 2'), true);
  // ~ / !~ contains
  assert.equal(f('code ~ "DDH"'), true);
  assert.equal(f('code !~ "RC"'), true);
  // in set membership (members quoted, as lamina's stats panel emits)
  assert.equal(f('lito in "OXIDE", "SULF"'), true);
  assert.equal(f('lito in "SULF", "TRANS"'), false);
  // tree-walk agrees
  assert.equal(evalBool('grade > 1 && lito in "OXIDE", "SULF"', row), true);
  // deps sees `in` members + column
  assert.deepEqual(deps('lito in "a", "b"'), ['lito']);
});

test('SQL-canonical surface — is not blank / not in / not contains / like / <> / scientific / single-quote', () => {
  // is not blank / is not filled
  assert.equal(evalBool('grade is not blank', { grade: 1 }), true);
  assert.equal(evalBool('grade is not blank', {}), false);
  assert.equal(evalBool('grade is not filled', {}), true);
  // not in / not contains / not like (postfix)
  assert.equal(evalBool('lito not in ("SULF", "TRANS")', { lito: 'OXIDE' }), true);
  assert.equal(evalBool('code not contains "RC"', { code: 'DDH1' }), true);
  assert.equal(evalBool('code not like "RC%"', { code: 'DDH1' }), true);
  // in with parens (canonical) and without (tolerated) agree
  assert.equal(evalBool('lito in ("OXIDE", "SULF")', { lito: 'OXIDE' }), true);
  assert.equal(evalBool('lito in "OXIDE", "SULF"', { lito: 'OXIDE' }), true);
  // like: % = any run, _ = one char, anchored
  assert.equal(evalBool('code like "DDH%"', { code: 'DDH0042' }), true);
  assert.equal(evalBool('code like "DD_0042"', { code: 'DDH0042' }), true);
  assert.equal(evalBool('code like "RC%"', { code: 'DDH0042' }), false);
  // <> not-equal + single-quoted string (both tolerated)
  assert.equal(evalBool("lito <> 'WASTE'", { lito: 'OXIDE' }), true);
  // scientific + leading-dot numbers
  assert.equal(evaluate('au * 1e4', { au: 0.0005 }), 5);
  assert.equal(evaluate('grade > .5', { grade: 0.7 }), true);
  assert.equal(evaluate('1.5e-3 * 1000', {}), 1.5);
});

test('tokenize — classified, positioned tokens for highlighting (tolerant)', () => {
  const toks = tokenize('grade between 1.2 and 3.8 and lito = "OXIDE"');
  const byKind = (k) => toks.filter((t) => t.kind === k).map((t) => t.value);
  assert.deepEqual(byKind('column'), ['grade', 'lito']);
  assert.deepEqual(byKind('keyword'), ['between', 'and', 'and']);
  assert.deepEqual(byKind('number'), ['1.2', '3.8']);
  assert.deepEqual(byKind('string'), ['"OXIDE"']);
  assert.deepEqual(byKind('operator'), ['=']);
  // positions are usable for an overlay
  const g = toks.find((t) => t.value === 'grade');
  assert.equal(g.start, 0); assert.equal(g.end, 5);
  // function vs column, and tolerant on a half-typed expression
  assert.deepEqual(tokenize('round(au,').filter((t) => t.kind === 'function').map((t) => t.value), ['round']);
  assert.ok(tokenize('grade > @@@').some((t) => t.kind === 'error'));
});

test('complete — context-aware suggestions (columns / functions / values / operators)', () => {
  const ctx = { columns: [{ name: 'grade', type: 'number' }, { name: 'lito', type: 'string' }, { name: 'Cu (ppm)', type: 'number' }], values: { lito: ['OXIDE', 'SULF', 'TRANS'] } };
  const vals = (s, p) => complete(s, p == null ? s.length : p, ctx).options.map((o) => o.value);

  // operand position (start) → columns + functions; awkward name backticked (v0.2)
  const start = complete('', 0, ctx).options;
  assert.ok(start.some((o) => o.value === 'grade' && o.kind === 'column'));
  assert.ok(start.some((o) => o.value === '`Cu (ppm)`'));
  assert.ok(start.some((o) => o.value === 'sqrt(' && o.kind === 'function'));

  // prefix filters columns
  assert.deepEqual(vals('gr'), ['grade']);

  // VALUE position after `lito = ` → the column's values, quoted (footgun closed)
  assert.deepEqual(vals('lito = '), ['"OXIDE"', '"SULF"', '"TRANS"']);
  assert.deepEqual(vals('lito = "OX'), ['"OXIDE"']);                 // partial value, prefix
  assert.deepEqual(vals('lito in ('), ['"OXIDE"', '"SULF"', '"TRANS"']);   // in-list value position

  // operator position (operand just ended) → comparisons + keywords
  const afterCol = complete('grade ', 6, ctx).options.map((o) => o.value);
  assert.ok(afterCol.includes('between') && afterCol.includes('>') && afterCol.includes('is blank'));

  // numeric column has no value list → falls through (offers columns, not a crash)
  assert.doesNotThrow(() => complete('grade = ', 8, ctx));
});

test('decimal-comma locale — comma-decimal field strings read numerically', () => {
  // a BR/EU CSV: the field arrives as the string "3,5"
  assert.equal(evaluate('grade * 2', { grade: '3,5' }, { decimal: ',' }), 7);
  assert.equal(compileBool('grade > 3', ['grade'], { decimal: ',' })(['3,5']), true);
  // default (dot) leaves "3,5" non-numeric → blank, never a throw
  assert.equal(evaluate('grade * 2', { grade: '3,5' }), null);
  // a real number value is untouched by comma mode (3.5 never becomes 35)
  assert.equal(evaluate('grade * 2', { grade: 3.5 }, { decimal: ',' }), 7);
  // string columns aren't coerced lazily — only where a number is needed
  assert.equal(evalBool('lito == "OXIDE"', { lito: 'OXIDE' }, { decimal: ',' }), true);
});

test('blank-propagation invariant — a missing grade never becomes 0', () => {
  // the load-bearing safety rule: arithmetic on a blank stays blank
  assert.equal(evaluate('grade * tonnes', { tonnes: 100 }), null);
  assert.equal(compile('grade * tonnes', ['grade', 'tonnes'])([null, 100]), null);
  // …unless explicitly cast
  assert.equal(evaluate('ifnum(grade, 0) * tonnes', { tonnes: 100 }), 0);
});

// ── v0.2 additions ────────────────────────────────────────────────────────────

test('canMatch — conservative chunk push-down over per-column stats', () => {
  const R = { au: { min: 0.1, max: 2.5 }, z: { min: 100, max: 200 } };
  // provably impossible → false (skip the chunk)
  assert.equal(canMatch('AU > 3', R), false);
  assert.equal(canMatch('AU >= 2.6', R), false);
  assert.equal(canMatch('AU < 0.1', R), false);
  assert.equal(canMatch('AU <= 0.05', R), false);
  assert.equal(canMatch('AU = 5', R), false);
  assert.equal(canMatch('AU between 3 and 4', R), false);
  assert.equal(canMatch('AU in (3, 4.5)', R), false);
  // possibly matching → true (scan)
  assert.equal(canMatch('AU > 1', R), true);
  assert.equal(canMatch('AU = 2.5', R), true);
  assert.equal(canMatch('AU between 2 and 3', R), true);
  assert.equal(canMatch('AU in (0.5, 9)', R), true);
  // flipped side: constant OP field
  assert.equal(canMatch('3 < AU', R), false);
  assert.equal(canMatch('1 < AU', R), true);
  // constant folding on the compare side
  assert.equal(canMatch('AU > 1.5 * 2', R), false);
  // and: either side impossible kills the conjunction; or needs both impossible
  assert.equal(canMatch('AU > 3 and Z > 150', R), false);
  assert.equal(canMatch('AU > 3 or Z > 150', R), true);
  assert.equal(canMatch('AU > 3 or Z > 300', R), false);
  // != soundness: blanks match != and stats say nothing about blanks
  const allFives = { au: { min: 5, max: 5 } };
  assert.equal(canMatch('AU != 5', allFives), true);                       // may hold blanks → must scan
  assert.equal(canMatch('AU != 5', { au: { min: 5, max: 5, hasBlank: false } }), false);   // provably all 5, no blanks
  assert.equal(canMatch('AU != 5', { au: { min: 4, max: 5, hasBlank: false } }), true);
  // unknowns stay conservative: missing stats, string compares, not, calls, parse errors
  assert.equal(canMatch('CU > 3', R), true);
  assert.equal(canMatch('LITO = "OX"', R), true);
  assert.equal(canMatch('not (AU > 3)', R), true);
  assert.equal(canMatch('sqrt(AU) > 9', R), true);
  assert.equal(canMatch('AU >', R), true);
  // case-insensitive stats lookup (the language is)
  assert.equal(canMatch('au > 3', { AU: { min: 0, max: 1 } }), false);
});

test('quoteIdent — plain names pass, everything else backticks', () => {
  assert.equal(quoteIdent('AU'), 'AU');
  assert.equal(quoteIdent('fe_pct'), 'fe_pct');
  assert.equal(quoteIdent('OK-Indic'), '`OK-Indic`');
  assert.equal(quoteIdent('Assay Au ppm'), '`Assay Au ppm`');
  assert.equal(quoteIdent('in'), '`in`');                                  // reserved word
  assert.equal(quoteIdent('IN'), '`IN`');                                  // reserved check is case-insensitive
  assert.equal(quoteIdent('we`ird'), '`we\\`ird`');                        // inner backtick escaped
  assert.equal(quoteIdent('a\\b'), '`a\\\\b`');                            // backslash escaped
  // and the quoted form round-trips through the parser
  for (const name of ['OK-Indic', 'Assay Au ppm', 'in', 'we`ird', 'a\\b']) {
    assert.equal(evaluate(quoteIdent(name), { [name]: 42 }), 42, name);
  }
});

test('validate — did-you-mean suggestions', () => {
  // typo → nearest known column
  const t = validate('gradee > 1', ['grade', 'lito']);
  assert.equal(t.ok, false);
  assert.equal(t.errors[0].suggestion, 'grade');
  assert.match(t.errors[0].message, /did you mean grade\?/);
  // the hyphen migration: OK-Indic typed bare parses as OK − Indic → both unknown,
  // and the known hyphenated column is suggested in backticks
  const h = validate('OK-Indic = 1', ['OK-Indic', 'AU']);
  assert.equal(h.ok, false);
  assert.ok(h.errors.some((e) => e.suggestion === '`OK-Indic`'), JSON.stringify(h.errors));
  // no candidate → no suggestion field
  const n = validate('zzzqqq > 1', ['grade']);
  assert.equal(n.errors[0].suggestion, undefined);
});

test('v0.2 lexical — backticks tokenize as columns; ^ and ** as operators', () => {
  const tk = tokenize('`Assay Au` > 2^3');
  assert.equal(tk[0].kind, 'column');
  assert.equal(tk[0].value, '`Assay Au`');
  assert.ok(tk.some((t) => t.kind === 'operator' && t.value === '^'));
  const tk2 = tokenize('a ** 2');
  assert.ok(tk2.some((t) => t.kind === 'operator' && t.value === '**'));
  // comments tokenize as their own kind (the highlight overlay dims them)
  assert.ok(tokenize('AU > 1 # cutoff').some((tk) => tk.kind === 'comment' && tk.value === '# cutoff'));
  // blank literal is a keyword for highlighting
  assert.ok(tokenize('x = blank').some((t) => t.kind === 'keyword' && t.value === 'blank'));
  // complete() emits the backtick form for awkward names
  const c = complete('', 0, { columns: ['grade', 'Cu (ppm)'] });
  assert.ok(c.options.some((o) => o.value === '`Cu (ppm)`'));
});

test('CHUNK ORACLE — compileChunk ≡ tree-walk on every fixture vector (1-row chunks)', () => {
  for (const v of fx.vectors) {
    if (v.verb === 'constrain') continue;
    const columns = Object.keys(v.values);
    const cols = columns.map((c) => [v.values[c]]);        // 1-row chunk, JS-array columns
    const ast = parse(v.expr);
    const tree = evaluate(ast, v.values);
    const { t, buf } = compileChunk(ast, columns)(cols, 1);
    const got = t === 'num' ? (buf[0] !== buf[0] ? null : buf[0])
      : t === 'bool' ? (buf[0] === 2 ? null : buf[0] === 1)
      : (buf[0] === undefined ? null : buf[0]);
    assert.deepEqual(got, tree, `chunk≠treewalk for: ${v.expr}`);
    assert.equal(compileChunkBool(ast, columns)(cols, 1)[0] === 1, tree === true, `chunkBool≠ for: ${v.expr}`);
  }
});

test('CHUNK ORACLE — multi-row battery: typed + JS columns, blanks interleaved ≡ per-row compile', () => {
  const N2 = 257;                                          // odd size, exercises buffer reuse across two calls
  const auT = new Float64Array(N2), auJ = new Array(N2), lito = new Array(N2), depth = new Float64Array(N2);
  for (let i = 0; i < N2; i++) {
    const blank = i % 11 === 3;
    auT[i] = blank ? NaN : (i % 100) / 20;
    auJ[i] = blank ? null : String(auT[i]);                // CSV-shaped: numeric strings
    lito[i] = i % 7 === 2 ? null : ['OX', 'TR', 'SULF'][i % 3];
    depth[i] = i % 13 === 5 ? NaN : i * 1.5 - 50;
  }
  const columns = ['AU', 'LITO', 'DEPTH'];
  const exprs = [
    'AU > 2', 'AU > 2 and LITO = "OX"', 'not (AU > 2)', 'AU <= 2', 'AU != 2',
    'AU between 1 and 3 or DEPTH < 0', 'LITO in ("OX", "TR")', 'LITO not in ("OX")',
    'AU is blank', 'DEPTH is filled', '(AU > 2) is blank',
    'AU * 2 + DEPTH / 4', '-AU^2', 'coalesce(nullif(AU, 2), 0.5)',
    'if(LITO = "OX", AU * 1.1, AU)', 'log10(AU * 100)', 'mod(DEPTH, 10)',
    'upper(LITO)', 'concat(LITO, "-", AU)', 'clamp(AU, 1, 3) + min(AU, DEPTH)',
    'LITO contains "X"', 'AU > DEPTH', 'bin(DEPTH, 25)',
  ];
  for (const colsSet of [[auT, lito, depth], [auJ, lito, depth]]) {   // typed AND string-y AU
    for (const e of exprs) {
      const ast = parse(e);
      const rowFn = compile(ast, columns);
      const chunkFn = compileChunk(ast, columns);
      for (const n of [N2, 64]) {                          // second, smaller call reuses buffers
        const { t, buf } = chunkFn(colsSet, n);
        for (let i = 0; i < n; i++) {
          const row = [colsSet[0][i], colsSet[1][i], colsSet[2][i]];
          const want = rowFn(row);
          const got = t === 'num' ? (buf[i] !== buf[i] ? null : buf[i])
            : t === 'bool' ? (buf[i] === 2 ? null : buf[i] === 1)
            : (buf[i] === undefined ? null : buf[i]);
          assert.deepEqual(got, want, `row ${i} of "${e}" (typed=${colsSet[0] === auT}, n=${n})`);
        }
      }
    }
  }
});
