// @gcu/filterui — the pure half of the AST↔widget filter editor, tested
// against REAL @gcu/expr parse-with-spans ASTs (hand-built nodes would just
// encode our assumptions).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenExpr, fmtNum, SpanSet, chainOf, leafSpec } from '../ext/filterui/src/core.js';
import { parse, quoteIdent } from '../ext/expr/index.js';

describe('flattenExpr', () => {
  it('joins lines and strips comments', () => {
    assert.equal(flattenExpr('FE > 1  # iron\nand ZN < 2'), 'FE > 1 and ZN < 2');
  });
});

describe('fmtNum', () => {
  it('integers at step>=1, decimals sized to the step', () => {
    assert.equal(fmtNum(3.7, 1), '4');
    assert.equal(fmtNum(0.5004, 0.01), '0.5');
    assert.equal(fmtNum(0.123456, 0.001), '0.1235');
  });
});

describe('SpanSet.replaceIn', () => {
  it('replaces and shifts later spans', () => {
    const s = new SpanSet();
    const a = s.push({ start: 0, end: 2 });    // "FE"
    const b = s.push({ start: 5, end: 8 });    // "0.5"
    const t = s.replaceIn('FE > 0.5', a, 'ZINC');
    assert.equal(t, 'ZINC > 0.5');
    assert.deepEqual([b.start, b.end], [7, 10]);
    assert.deepEqual([a.start, a.end], [0, 4]);
  });

  it('stretches a containing extent', () => {
    const s = new SpanSet();
    const outer = s.push({ start: 0, end: 8 });    // the whole clause
    const inner = s.push({ start: 5, end: 8 });    // the literal
    const t = s.replaceIn('FE > 0.5', inner, '123.456');
    assert.equal(t, 'FE > 123.456');
    assert.deepEqual([outer.start, outer.end], [0, 12]);
  });

  it('leaves earlier spans alone', () => {
    const s = new SpanSet();
    const a = s.push({ start: 0, end: 2 });
    const b = s.push({ start: 5, end: 8 });
    s.replaceIn('FE > 0.5', b, '1');
    assert.deepEqual([a.start, a.end], [0, 2]);
  });
});

describe('chainOf', () => {
  it('flattens a same-op chain with joiner spans', () => {
    const ch = chainOf(parse('A > 1 and B > 2 and C > 3'));
    assert.equal(ch.op, 'and');
    assert.equal(ch.items.length, 3);
    assert.equal(ch.joiners.length, 2);
    assert.ok(ch.joiners.every((j) => j.start != null));
  });

  it('a parenthesized child stays nested even with the same op', () => {
    const ch = chainOf(parse('A > 1 and (B > 2 and C > 3)'));
    assert.equal(ch.items.length, 2);
    assert.ok(ch.items[1].gStart != null);
  });

  it('a non-chain node is a single item', () => {
    const ch = chainOf(parse('FE > 0.5'));
    assert.equal(ch.op, null);
    assert.equal(ch.items.length, 1);
  });
});

describe('leafSpec', () => {
  const spec = (src) => leafSpec(parse(src), quoteIdent);

  it('field-vs-number comparison → slider', () => {
    const s = spec('FE > 0.5');
    assert.equal(s.kind, 'slider'); assert.equal(s.col, 'FE'); assert.equal(s.op, '>'); assert.equal(s.v, 0.5);
    assert.ok(s.sp.start != null);
  });

  it('flipped comparison normalizes the operator', () => {
    const s = spec('0.5 < FE');
    assert.equal(s.kind, 'slider'); assert.equal(s.col, 'FE'); assert.equal(s.op, '>'); assert.ok(s.flipped);
  });

  it('between → dual range', () => {
    const s = spec('FE between 1 and 2');
    assert.equal(s.kind, 'range'); assert.equal(s.vlo, 1); assert.equal(s.vhi, 2);
  });

  it('string equality and in-lists → chips', () => {
    assert.equal(spec('LITO = "granite"').kind, 'chips');
    const si = spec('LITO in ("a", "b")');
    assert.equal(si.kind, 'chips'); assert.equal(si.op, 'in'); assert.equal(si.picks.length, 2);
  });

  it('is blank / is filled → flag', () => {
    assert.equal(spec('AU is blank').kind, 'flag');
    assert.equal(spec('AU is filled').kind, 'flag');
  });

  it('contains → text input', () => {
    const s = spec('HOLE contains "DD"');
    assert.equal(s.kind, 'text'); assert.equal(s.v, 'DD');
  });

  it('negation wraps the inner spec', () => {
    const s = spec('not FE > 0.5');
    assert.equal(s.kind, 'slider'); assert.ok(s.negated);
  });

  it('anything else is an honest expression row', () => {
    assert.equal(spec('FE + ZN > CU').kind, 'expr');
  });
});
