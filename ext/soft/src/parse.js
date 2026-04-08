// soft — recursive descent parser
// Produces an AST from a token stream. No external dependencies.

import { softTokenize, T } from './tokenize.js';

// ── AST node constructors ──

let _curLine = 1;
const N = (type, props) => ({ type, line: _curLine, ...props });

// ── parser ──

export function softParse(code) {
  const tokens = softTokenize(code);
  let pos = 0;

  // -- token access --
  function cur() { const t = tokens[pos] || { type: T.EOF, value: '', line: _curLine }; _curLine = t.line || _curLine; return t; }
  function at(type, value) {
    const t = cur();
    if (value !== undefined) return t.type === type && t.value === value;
    return t.type === type;
  }
  function kw(value) { return at(T.KW, value); }
  function eat(type, value) {
    if (at(type, value)) { pos++; return true; }
    return false;
  }
  function eatKw(value) { return eat(T.KW, value); }
  function expect(type, value) {
    if (!eat(type, value)) {
      const t = cur();
      throw new Error(`Expected ${value || type} but got ${t.value || t.type} at line ${t.line}`);
    }
  }
  function expectKw(value) { expect(T.KW, value); }
  function skipNL() { while (at(T.NL)) pos++; }
  function expectNL() {
    if (!at(T.NL) && !at(T.EOF)) {
      const t = cur();
      throw new Error(`Expected newline but got ${t.value || t.type} at line ${t.line}`);
    }
    skipNL();
  }

  // -- name: accepts both ID and KW (for imported names that collide with keywords) --
  function expectName() {
    const t = cur();
    if (t.type === T.ID || t.type === T.KW) { pos++; return t.value; }
    throw new Error(`Expected name but got ${t.value || t.type} at line ${t.line}`);
  }

  // ── pre-scan for function signatures ──
  const signatures = new Map();

  const BLOCK_OPENERS = new Set(['define', 'if', 'unless', 'repeat', 'while', 'until', 'for', 'suppose', 'try', 'on']);
  function prescan() {
    let i = 0;
    let depth = 0; // track block nesting: only register top-level defines/uses
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === T.KW && t.value === 'end') { if (depth > 0) depth--; i++; continue; }
      if (t.type === T.KW && BLOCK_OPENERS.has(t.value) && t.value !== 'define') { depth++; i++; continue; }
      if (t.type === T.KW && (t.value === 'define' || t.value === 'use')) {
        const isNested = depth > 0;
        if (t.value === 'define') depth++;
        if (isNested) { i++; continue; } // skip nested defines
        i++;
        // skip to function name
        if (t.value === 'use') {
          // use <dotpath> [as <name>] [signature]
          if (i < tokens.length && tokens[i].type === T.ID) {
            const dotpath = tokens[i].value; i++;
            let name = dotpath;
            if (i < tokens.length && tokens[i].type === T.KW && tokens[i].value === 'as') {
              i++;
              if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
                name = tokens[i].value; i++;
              }
            }
            const sig = prescanSig(i);
            signatures.set(name, sig.params);
            i = sig.end;
          }
        } else {
          // define <name> [takes|with] <signature>
          if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
            const name = tokens[i].value; i++;
            const sig = prescanSig(i);
            signatures.set(name, sig.params);
            i = sig.end;
          }
        }
      } else {
        i++;
      }
    }
  }

  function prescanSig(start) {
    let i = start;
    const params = [];
    // skip noise words: takes, with (only before first param)
    while (i < tokens.length && tokens[i].type === T.KW &&
      (tokens[i].value === 'takes' || tokens[i].value === 'with')) { i++; }
    while (i < tokens.length && tokens[i].type !== T.NL && tokens[i].type !== T.EOF) {
      const t = tokens[i];
      // variadic
      if (t.type === T.KW && (t.value === 'many' || t.value === 'all')) {
        i++;
        if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
          params.push({ param: tokens[i].value, variadic: true }); i++;
        }
        break;
      }
      // separator keyword (before a param or variadic)
      if (t.type === T.KW && !isExpressionStart(t.value) &&
        i + 1 < tokens.length && (tokens[i + 1].type === T.ID || tokens[i + 1].type === T.KW)) {
        if (t.value === 'and') { i++; continue; } // skip 'and' between params
        const sep = t.value; i++;
        // check for variadic after separator: "of many numbers"
        if (tokens[i].type === T.KW && (tokens[i].value === 'many' || tokens[i].value === 'all')) {
          i++;
          if (i < tokens.length && (tokens[i].type === T.ID || tokens[i].type === T.KW)) {
            params.push({ sep, param: tokens[i].value, variadic: true }); i++;
          }
          break;
        }
        const pname = tokens[i].value; i++;
        // check for default: param is <value>
        let dflt;
        if (i < tokens.length && tokens[i].type === T.KW && tokens[i].value === 'is') {
          i++;
          if (i < tokens.length) { dflt = tokens[i].value; i++; }
        }
        params.push({ sep, param: pname, default: dflt });
        continue;
      }
      // bare param
      if (t.type === T.ID || (t.type === T.KW && isParamName(t.value))) {
        const pname = t.value; i++;
        // check for default: param is <value>
        let dflt;
        if (i < tokens.length && tokens[i].type === T.KW && tokens[i].value === 'is') {
          i++;
          if (i < tokens.length) { dflt = tokens[i].value; i++; }
        }
        params.push({ param: pname, default: dflt });
        continue;
      }
      break;
    }
    return { params, end: i };
  }

  function isExpressionStart(kw) {
    return ['set', 'say', 'show', 'put', 'if', 'unless', 'repeat', 'while', 'until',
      'for', 'define', 'return', 'take', 'from', 'keep', 'drop', 'only', 'where',
      'pick', 'get', 'sort', 'first', 'last', 'top', 'count', 'average', 'total',
      'smallest', 'largest', 'mean', 'sum', 'min', 'max', 'group', 'round',
      'load', 'save', 'ask', 'add', 'remove', 'on', 'use', 'explain', 'assume',
      'suppose', 'try', 'stop', 'skip', 'end', 'otherwise', 'else', 'open',
      'close', 'write', 'read', 'wait', 'append', 'make'].includes(kw);
  }

  function isParamName(kw) {
    // keywords that can serve as parameter names in signatures
    return !isExpressionStart(kw);
  }

  // ── expression parsing (precedence climbing) ──

  // level 11: and/or (logic)
  function expression() {
    return inlineConditional();
  }

  function inlineConditional() {
    let left = concat();
    if (kw('if')) {
      pos++;
      const cond = condition();
      expectKw('otherwise');
      const right = concat();
      return N('Ternary', { ifTrue: left, cond, ifFalse: right });
    }
    return left;
  }

  // level 9: & (string concat)
  function concat() {
    let left = logic();
    while (eat(T.CONCAT)) {
      left = N('BinOp', { op: '&', left, right: logic() });
    }
    return left;
  }

  // level 11: and/or (logic) — only in expression context, not condition
  function logic() {
    let left = comparison();
    while (kw('and') || kw('or')) {
      // peek: "and then" is a pipe, not logic
      if (kw('and') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'then') break;
      const op = cur().value; pos++;
      left = N('Logic', { op, left, right: comparison() });
    }
    return left;
  }

  // level 10: comparisons
  function comparison() {
    let left = bitwise();
    // is a / is not a → type check
    if (kw('is')) {
      const saved = pos; pos++;
      const negated = !!eatKw('not');
      if (kw('a') || kw('an')) {
        pos++;
        const typeName = expectName();
        const node = N('TypeCheck', { expr: left, typeName });
        return negated ? N('Unary', { op: 'not', expr: node }) : node;
      }
      pos = saved; // backtrack
    }
    // between
    if (kw('between')) {
      pos++;
      const lo = arithmetic();
      expectKw('and');
      const hi = arithmetic();
      return N('Between', { value: left, lo, hi });
    }
    // contains
    if (kw('contains')) { pos++; return N('Compare', { op: 'contains', left, right: bitwise() }); }
    // matches
    if (kw('matches')) { pos++; return N('Compare', { op: 'matches', left, right: bitwise() }); }
    // regular comparison operators
    const cop = comparisonOp();
    if (cop) {
      const right = bitwise();
      return N('Compare', { op: cop, left, right });
    }
    return left;
  }

  function isComparisonNext() {
    const t = cur();
    if (t.type === T.CMP) return true;
    if (t.type === T.KW) {
      return ['above', 'below', 'is', 'equals', 'greater', 'less', 'more', 'under', 'at', 'does'].includes(t.value);
    }
    return false;
  }

  function comparisonOp() {
    // skip noise words before comparison (allows "se x for ao menos 5" in Portuguese)
    const savedNoise = pos;
    while (kw('the') || kw('a') || kw('an')) pos++;
    if (pos > savedNoise && !at(T.CMP) && !kw('above') && !kw('below') && !kw('is') && !kw('at') &&
      !kw('equals') && !kw('greater') && !kw('less') && !kw('more') && !kw('under') && !kw('does') && !kw('not')) {
      pos = savedNoise; // backtrack — no comparison follows
    }
    if (eat(T.CMP, '>')) return '>';
    if (eat(T.CMP, '<')) return '<';
    if (eat(T.CMP, '==')) return '==';
    if (eat(T.CMP, '!=')) return '!=';
    if (eat(T.CMP, '>=')) return '>=';
    if (eat(T.CMP, '<=')) return '<=';
    if (kw('above')) { pos++; eatKw('of'); return '>'; }
    if (kw('below')) { pos++; eatKw('of'); return '<'; }
    if (kw('is')) {
      const saved = pos; pos++;
      if (kw('not')) {
        pos++;
        if (kw('a') || kw('an')) { pos = saved; return null; } // is not a → type check, not comparison
        return '!=';
      }
      if (kw('a') || kw('an')) { pos = saved; return null; } // is a → type check, not comparison
      if (kw('above')) { pos++; eatKw('of'); return '>'; }
      if (kw('below')) { pos++; eatKw('of'); return '<'; }
      if (kw('equal')) { pos++; eatKw('to'); return '=='; } // "is equal to"
      if (kw('greater')) { pos++; eatKw('than'); return '>'; } // "is greater than"
      if (kw('less')) { pos++; eatKw('than'); return '<'; } // "is less than"
      // "is at least" / "is at most"
      if (kw('at') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'least') { pos += 2; return '>='; }
      if (kw('at') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'most') { pos += 2; return '<='; }
      return '==';
    }
    if (kw('at')) {
      if (tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'least') {
        pos += 2; return '>=';
      }
      if (tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'most') {
        pos += 2; return '<=';
      }
    }
    if (kw('equals')) { pos++; return '=='; }
    if (kw('greater')) { pos++; eatKw('than'); return '>'; }
    if (kw('less')) { pos++; eatKw('than'); return '<'; }
    if (kw('more')) { pos++; eatKw('than'); return '>'; }
    if (kw('under')) { pos++; return '<'; }
    // "not is" / "não é" → != (Portuguese word order: não before é)
    if (kw('not')) {
      const saved = pos; pos++;
      if (kw('is')) { pos++; return '!='; }
      pos = saved;
    }
    // "does not equal" → !=
    if (kw('does')) {
      const saved = pos; pos++;
      if (kw('not')) { pos++; if (eatKw('equal')) return '!='; }
      pos = saved;
    }
    return null;
  }

  // level 8: bitwise
  function bitwise() {
    let left = shift();
    while (true) {
      if (kw('bitwise') || kw('bit')) {
        const saved = pos; pos++;
        if (kw('and')) { pos++; left = N('BinOp', { op: 'bitand', left, right: shift() }); continue; }
        if (kw('or')) { pos++; left = N('BinOp', { op: 'bitor', left, right: shift() }); continue; }
        if (kw('xor')) { pos++; left = N('BinOp', { op: 'bitxor', left, right: shift() }); continue; }
        pos = saved; break;
      }
      if (kw('xor')) { pos++; left = N('BinOp', { op: 'bitxor', left, right: shift() }); continue; }
      break;
    }
    return left;
  }

  // level 7: shift
  function shift() {
    let left = arithmetic();
    while (true) {
      if (eat(T.BITOP, '<<')) { left = N('BinOp', { op: '<<', left, right: arithmetic() }); continue; }
      if (eat(T.BITOP, '>>')) { left = N('BinOp', { op: '>>', left, right: arithmetic() }); continue; }
      if (kw('shift')) {
        pos++;
        if (kw('left')) { pos++; left = N('BinOp', { op: '<<', left, right: arithmetic() }); continue; }
        if (kw('right')) { pos++; left = N('BinOp', { op: '>>', left, right: arithmetic() }); continue; }
      }
      break;
    }
    return left;
  }

  // level 6: +, -
  function arithmetic() {
    let left = term();
    while (true) {
      if (eat(T.OP, '+') || eatKw('plus')) { left = N('BinOp', { op: '+', left, right: term() }); continue; }
      if (eat(T.OP, '-') || eatKw('minus')) { left = N('BinOp', { op: '-', left, right: term() }); continue; }
      break;
    }
    return left;
  }

  // level 5: *, /, %
  function term() {
    let left = exponent();
    while (true) {
      if (eat(T.OP, '*') || eatKw('times')) { left = N('BinOp', { op: '*', left, right: exponent() }); continue; }
      if (eat(T.OP, '/') || eatKw('over')) { left = N('BinOp', { op: '/', left, right: exponent() }); continue; }
      if (eat(T.OP, '%') || eatKw('mod')) { left = N('BinOp', { op: '%', left, right: exponent() }); continue; }
      break;
    }
    return left;
  }

  // level 4: ** (right-associative)
  function exponent() {
    let left = unary();
    if (eat(T.OP, '**') || (eatKw('raised') && expectKw('to') || true)) {
      // right-associative: recurse into exponent
      if (tokens[pos - 1]?.value === '**' || tokens[pos - 1]?.value === 'to') {
        return N('BinOp', { op: '**', left, right: exponent() });
      }
    }
    return left;
  }

  // level 3: unary prefix
  function unary() {
    if (kw('not') || eat(T.BANG)) {
      if (kw('not')) pos++;
      return N('Unary', { op: 'not', expr: unary() });
    }
    // explicit invocation: call/run/result of — with optional args
    if (kw('call') || kw('run')) {
      pos++;
      const fn = atom(); // the function reference
      const args = [];
      while (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('then') && !kw('as') &&
        !kw('into') && !kw('called') && !at(T.RPAREN) && !isComparisonNext() &&
        !kw('and') && !kw('or') && !kw('if') && !kw('unless') && !at(T.CONCAT)) {
        args.push(arithmetic());
        if (!eat(T.COMMA)) break;
      }
      return N('Invoke', { expr: fn, args });
    }
    if (kw('result')) {
      const saved = pos; pos++;
      if (kw('of')) {
        pos++;
        const fn = atom();
        const args = [];
        while (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('then') && !kw('as') &&
          !kw('into') && !kw('called') && !at(T.RPAREN) && !isComparisonNext() &&
          !kw('and') && !kw('or') && !kw('if') && !kw('unless') && !at(T.CONCAT)) {
          args.push(arithmetic());
          if (!eat(T.COMMA)) break;
        }
        return N('Invoke', { expr: fn, args });
      }
      pos = saved;
    }
    if (kw('negative')) { pos++; return N('Unary', { op: 'neg', expr: unary() }); }
    if (eat(T.OP, '-')) { return N('Unary', { op: 'neg', expr: unary() }); }
    if (eat(T.BITOP, '~')) { return N('Unary', { op: 'bitnot', expr: unary() }); }
    if (kw('bit') || kw('bitwise')) {
      const saved = pos; pos++;
      if (kw('not')) { pos++; return N('Unary', { op: 'bitnot', expr: unary() }); }
      pos = saved;
    }
    if (kw('length')) {
      const saved = pos; pos++;
      if (kw('of')) { pos++; return N('LengthOf', { expr: atom() }); }
      pos = saved;
      // fall through — 'length' as a bare field name in row context
    }
    // round <expr> to <n> as an expression
    if (kw('round')) {
      const saved = pos; pos++;
      if (!kw('to') && !at(T.NL) && !at(T.EOF)) {
        const value = atom();
        if (kw('to') && tokens[pos + 1]?.type === T.NUM) {
          pos++;
          const places = parseNumber(cur().value); pos++;
          return N('RoundExpr', { value, places });
        }
      }
      pos = saved;
      // fall through — 'round' as pipeline statement handled elsewhere
    }
    // "number of words/characters/lines/items in X" — counting
    if (kw('number')) {
      const saved = pos; pos++;
      if (kw('of')) {
        pos++;
        if (kw('characters') || kw('words') || kw('lines') || kw('items')) {
          const kind = cur().value; pos++;
          expectKw('in');
          return N('CountChunks', { kind, expr: atom() });
        }
        pos = saved + 1; // backtrack past 'number' but before 'of'
      }
      pos = saved;
      // fall through — 'number' as a bare name or builtin
    }
    // chunk expressions: character/word/line/item N of X
    if (kw('character') || kw('word') || kw('line') || kw('item')) {
      const saved = pos;
      const kind = cur().value; pos++;
      // peek: if followed by a number/expr then 'of', it's a chunk read
      if (!kw('of') && !at(T.NL) && !at(T.EOF)) {
        const index = atom();
        if (kw('of')) {
          pos++;
          const target = unary(); // recurse to allow nesting: word 1 of line 0 of doc
          return N('Chunk', { kind, index, target });
        }
      }
      pos = saved;
      // fall through — bare field name
    }
    // chunk ranges: characters/words/lines N to M of X
    if (kw('characters') || kw('words') || kw('lines') || kw('items')) {
      const saved = pos;
      const kind = cur().value; pos++;
      if (!at(T.NL) && !at(T.EOF)) {
        const from = atom();
        if (kw('to')) {
          pos++;
          const to = atom();
          if (kw('of')) {
            pos++;
            return N('ChunkRange', { kind, from, to, target: unary() });
          }
        }
      }
      pos = saved;
      // fall through
    }
    return postfix();
  }

  // level 2: of chains
  function postfix() {
    let left = atom();
    while (kw('of')) {
      pos++;
      const right = atom();
      left = N('Of', { prop: left, obj: right });
    }
    return left;
  }

  // level 1: atoms
  function atom() {
    // skip noise words
    if (kw('the') || kw('a') || kw('an') || kw('that') || kw('this')) {
      pos++;
      return atom();
    }

    // number
    if (at(T.NUM)) {
      const v = cur().value; pos++;
      return N('Num', { value: parseNumber(v) });
    }

    // string
    if (at(T.STR)) {
      const v = cur().value; pos++;
      return N('Str', { value: v });
    }

    // regex literal
    if (at(T.REGEX)) {
      const v = cur().value; pos++;
      return N('Regex', { value: v });
    }

    // boolean
    if (kw('true') || kw('yes')) { pos++; return N('Bool', { value: true }); }
    if (kw('false') || kw('no')) { pos++; return N('Bool', { value: false }); }

    // null
    if (kw('nothing') || kw('empty')) { pos++; return N('Nothing'); }

    // it / that / result
    if (kw('it') || kw('that')) { pos++; return N('Ref', { name: 'it' }); }
    // 'result' as bare alias for 'it' (when not followed by 'of' — that's handled in unary)
    if (kw('result') && !(tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'of')) {
      pos++; return N('Ref', { name: 'it' });
    }

    // parenthesized
    if (eat(T.LPAREN)) {
      const expr = expression();
      expect(T.RPAREN);
      return N('Group', { expr });
    }

    // list literal — comma at end of line continues to next line
    // "list\n  item1,\n  item2" works (newline after list starts multi-line mode)
    if (kw('list')) {
      pos++;
      const multiline = at(T.NL);
      if (multiline) skipNL();
      const items = [];
      while (!at(T.EOF) && !kw('end') && !at(T.RPAREN)) {
        if (!multiline && at(T.NL)) break;
        items.push(arithmetic());
        if (eat(T.COMMA)) { skipNL(); continue; }
        break;
      }
      return N('List', { items });
    }

    // record literal
    if (kw('record')) {
      pos++;
      if (kw('with')) {
        // record with x, y, z shorthand
        pos++;
        const fields = [];
        while (!at(T.NL) && !at(T.EOF) && !kw('record') && !at(T.RPAREN)) {
          const name = expectName();
          if (kw('is')) { pos++; fields.push({ name, value: arithmetic() }); }
          else { fields.push({ name, ref: true }); }
          if (eat(T.COMMA)) { skipNL(); continue; }
          break;
        }
        return N('RecordWith', { fields });
      }
      const fields = [];
      while (!at(T.NL) && !at(T.EOF) && !kw('record') && !at(T.RPAREN) && !at(T.COMMA)) {
        // stop if the next token is not a valid field name
        if (!at(T.ID) && !(at(T.KW) && isParamName(cur().value))) break;
        const name = expectName();
        const value = arithmetic();
        fields.push({ name, value });
      }
      return N('Record', { fields });
    }

    // identifier — could be a variable ref, function call, or dot-path call
    if (at(T.ID)) {
      // builtin coercion: text <value>
      if (cur().value === 'text') {
        const saved = pos; pos++;
        if (!at(T.NL) && !at(T.EOF) && !kw('of') && !isComparisonNext()) {
          const arg = atom();
          return N('Call', { name: 'text', args: [arg] });
        }
        pos = saved;
      }
      const name = cur().value; pos++;
      // dot-path: consume comma-separated args
      if (name.includes('.')) {
        const args = [];
        while (!at(T.NL) && !at(T.EOF) && !kw('then') && !kw('as') && !kw('into') &&
          !kw('and') && !kw('or') && !at(T.RPAREN) && !isComparisonNext() &&
          !kw('if') && !kw('unless') && !kw('called')) {
          args.push(arithmetic());
          if (!eat(T.COMMA)) break;
        }
        if (args.length > 0) return N('Call', { name, args });
        return N('Ref', { name });
      }
      // registered function: always produce a Call node
      if (signatures.has(name)) {
        const sig = signatures.get(name);
        // if sig is empty or no args available, still produce Call with 0 args (auto-invoke)
        if (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('otherwise') && !kw('else') &&
          !kw('then') && !kw('as') && !kw('into') && !kw('called') && !at(T.RPAREN) &&
          !isComparisonNext() && !kw('and') && !kw('or') && !kw('if') && !kw('unless') &&
          !at(T.CONCAT)) {
          const args = parseCallArgs(name);
          return N('Call', { name, args });
        }
        return N('Call', { name, args: [] });
      }
      return N('Ref', { name });
    }

    // keyword used as a name (registered function)
    if (at(T.KW) && signatures.has(cur().value)) {
      const name = cur().value; pos++;
      // try to consume args (only if followed by a value, not a statement boundary)
      if (!at(T.NL) && !at(T.EOF) && !kw('end') && !kw('otherwise') && !kw('else') &&
        !kw('then') && !kw('as') && !kw('into') && !kw('called') && !at(T.RPAREN) &&
        !isComparisonNext() && !kw('and') && !kw('or') && !kw('if') && !kw('unless')) {
        const args = parseCallArgs(name);
        if (args.length > 0) return N('Call', { name, args });
      }
      return N('Ref', { name });
    }

    // builtin coercion calls: number (keyword) or text (ID) that take 1 arg
    if (kw('number') || (at(T.ID) && cur().value === 'text')) {
      const saved = pos;
      const name = cur().value; pos++;
      // only if followed by a value (not 'of', not comparison, not end of line)
      if (!at(T.NL) && !at(T.EOF) && !kw('of') && !isComparisonNext()) {
        const arg = atom();
        return N('Call', { name, args: [arg] });
      }
      pos = saved;
    }

    // fallback: treat unrecognized keywords as identifiers (field names in row context)
    if (at(T.KW)) {
      const name = cur().value; pos++;
      return N('Ref', { name });
    }

    const t = cur();
    throw new Error(`Unexpected token: ${t.value || t.type} at line ${t.line}`);
  }

  // ── repeat count expression (stops before times/time keyword) ──
  // Uses arithmetic but 'times' is NOT consumed as multiplication
  function repeatCountExpr() {
    let left = repeatTerm();
    while (true) {
      if (eat(T.OP, '+') || eatKw('plus')) { left = N('BinOp', { op: '+', left, right: repeatTerm() }); continue; }
      if (eat(T.OP, '-') || eatKw('minus')) { left = N('BinOp', { op: '-', left, right: repeatTerm() }); continue; }
      break;
    }
    return left;
  }
  function repeatTerm() {
    let left = exponent();
    while (true) {
      // times/time here means the loop terminator, not multiplication — stop
      if (kw('times') || kw('time')) break;
      if (eat(T.OP, '*')) { left = N('BinOp', { op: '*', left, right: exponent() }); continue; }
      if (eat(T.OP, '/') || eatKw('over')) { left = N('BinOp', { op: '/', left, right: exponent() }); continue; }
      if (eat(T.OP, '%') || eatKw('mod')) { left = N('BinOp', { op: '%', left, right: exponent() }); continue; }
      break;
    }
    return left;
  }

  // ── condition parsing (used by if/keep/while/etc.) ──

  function condition() {
    let left = singleCondition();
    while (kw('and') || kw('or')) {
      // "and then" is a pipe, not logic
      if (kw('and') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'then') break;
      const op = cur().value; pos++;
      left = N('Logic', { op, left, right: singleCondition() });
    }
    return left;
  }

  function singleCondition() {
    // there is a / there is no
    if (kw('there')) {
      pos++; expectKw('is');
      if (kw('no')) { pos++; const name = expectName(); return N('ThereIsNo', { name }); }
      eatKw('a'); eatKw('an');
      const name = expectName();
      return N('ThereIs', { name });
    }
    if (kw('not') || at(T.BANG)) {
      if (kw('not')) pos++; else pos++;
      return N('Unary', { op: 'not', expr: singleCondition() });
    }
    let left = concat();
    // between
    if (kw('between')) {
      pos++;
      const lo = arithmetic();
      expectKw('and');
      const hi = arithmetic();
      return N('Between', { value: left, lo, hi });
    }
    // contains
    if (kw('contains')) { pos++; return N('Compare', { op: 'contains', left, right: concat() }); }
    // matches
    if (kw('matches')) { pos++; return N('Compare', { op: 'matches', left, right: concat() }); }
    // is a / is not a type check
    if (kw('is')) {
      const saved = pos; pos++;
      const negated = !!eatKw('not');
      if (kw('a') || kw('an')) {
        pos++;
        const typeName = expectName();
        const node = N('TypeCheck', { expr: left, typeName });
        return negated ? N('Unary', { op: 'not', expr: node }) : node;
      }
      pos = saved;
    }
    // comparison
    const cop = comparisonOp();
    if (cop) {
      return N('Compare', { op: cop, left, right: concat() });
    }
    // bare truthy
    return left;
  }

  // ── statement parsing ──

  function program() {
    prescan();
    const body = [];
    skipNL();
    while (!at(T.EOF)) {
      body.push(statement());
      skipNL();
    }
    return N('Program', { body });
  }

  function block() {
    const body = [];
    skipNL();
    while (!at(T.EOF) && !kw('end') && !kw('otherwise') && !kw('else') && !kwIs('if', 'it')) {
      body.push(statement());
      skipNL();
    }
    return body;
  }

  // peek for "if it fails" (try/catch)
  function kwIs(a, b) {
    return kw(a) && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === b;
  }

  function statement() {
    const t = cur();

    // -- set --
    if (kw('set')) return setStmt();
    // -- put --
    if (kw('put')) return putStmt();
    // -- say / show --
    if (kw('say') || kw('show')) return sayStmt();
    // -- if --
    if (kw('if')) return ifStmt();
    // -- unless --
    if (kw('unless')) return unlessStmt();
    // -- repeat / while / until / for --
    if (kw('repeat') || kw('while') || kw('until') || kw('for')) return repeatStmt();
    // -- define --
    if (kw('define')) return defineStmt();
    // -- return --
    if (kw('return')) return returnStmt();
    // -- use --
    if (kw('use')) return useStmt();
    // -- stop (with optional suffix conditional) --
    if (kw('stop')) { pos++; return suffixConditional(N('Stop')); }
    // -- skip (with optional suffix conditional) --
    if (kw('skip')) { pos++; return suffixConditional(N('Skip')); }
    // -- add --
    if (kw('add')) return addStmt();
    // -- remove --
    if (kw('remove')) return removeStmt();
    // -- try --
    if (kw('try')) return tryStmt();
    // -- assume --
    if (kw('assume')) return assumeStmt();
    // -- suppose --
    if (kw('suppose')) return supposeStmt();
    // -- explain --
    if (kw('explain')) return explainStmt();
    // -- on (event) --
    if (kw('on')) return onStmt();

    // -- pipeline result capture (standalone into/as on its own line) --
    if (kw('into') || (kw('as') && tokens[pos + 1]?.type === T.ID)) {
      pos++; // eat 'into'/'as'
      const name = expectName();
      return N('Capture', { expr: N('Ref', { name: 'it' }), name });
    }

    // -- pipeline transforms --
    if (kw('take') || kw('from')) return takeStmt();
    if (kw('keep') || kw('drop') || kw('only') || kw('where')) return filterStmt();
    if (kw('sort')) return sortStmt();
    if (kw('average') || kw('total') || kw('smallest') || kw('largest') ||
      kw('mean') || kw('sum') || kw('min') || kw('max')) return aggStmt();
    if (kw('count')) return countStmt();
    if (kw('first') || kw('last') || kw('top')) return limitStmt();
    if (kw('group')) return groupStmt();
    if (kw('pick') || kw('get')) return pickStmt();
    if (kw('round')) return roundStmt();
    if (kw('with')) return withStmt();

    // -- load / save / make --
    if (kw('load')) return loadStmt();
    if (kw('save')) return saveStmt();
    if (kw('make')) return makeStmt();

    // -- statement-level function call (registered name) --
    if ((at(T.ID) || at(T.KW)) && signatures.has(cur().value)) {
      return identStmt();
    }

    // -- expression statement (possibly with suffix conditional or result capture) --
    return exprStmt();
  }

  function setStmt() {
    pos++; // eat 'set'
    // skip noise words: set THE cutoff to 50
    while (kw('the') || kw('a') || kw('an') || kw('that') || kw('this')) pos++;

    // check for chunk write: set word 2 of text to "big"
    if (kw('character') || kw('word') || kw('line') || kw('item')) {
      const kind = cur().value; pos++;
      const index = atom();
      expectKw('of');
      const target = expectName();
      expectKw('to');
      const value = expression();
      return N('SetChunk', { kind, index, target, value });
    }

    const name = expectName();

    // check for of-path write: set grade of row to 60
    if (kw('of')) {
      const path = [name];
      while (eatKw('of')) path.push(expectName());
      expectKw('to');
      const value = expression();
      return N('SetOf', { path, value });
    }

    expectKw('to');
    const value = expression();
    return N('Set', { name, value });
  }

  function putStmt() {
    pos++; // eat 'put'
    const value = expression();
    expectKw('into');
    // skip noise words
    while (kw('the') || kw('a') || kw('an') || kw('that') || kw('this')) pos++;

    // check for chunk target
    if (kw('character') || kw('word') || kw('line') || kw('item')) {
      const kind = cur().value; pos++;
      const index = atom();
      expectKw('of');
      const target = expectName();
      return N('SetChunk', { kind, index, target, value });
    }

    const name = expectName();
    // check for of-path
    if (kw('of')) {
      const path = [name];
      while (eatKw('of')) path.push(expectName());
      return N('SetOf', { path, value });
    }
    return N('Set', { name, value });
  }

  function sayStmt() {
    pos++; // eat 'say'/'show'
    const parts = [expression()];
    // juxtaposition: auto-concat when followed by a value token
    // STR/NUM/LPAREN are unambiguous. IDs are allowed too (common pattern: "text" variable "text")
    while (!at(T.NL) && !at(T.EOF) && (at(T.STR) || at(T.NUM) || at(T.LPAREN) || at(T.ID) ||
      (at(T.KW) && !isComparisonNext() && !kw('if') && !kw('unless') && !kw('and') && !kw('or') &&
       !kw('then') && !kw('as') && !kw('into') && !kw('called') && !kw('end')))) {
      parts.push(expression());
    }
    if (parts.length === 1) return N('Say', { value: parts[0] });
    return N('Say', { value: N('Juxtapose', { parts }) });
  }

  function ifStmt() {
    pos++; // eat 'if'
    const cond = condition();
    eatKw('do');
    expectNL();
    const body = block();
    let elseBody = null;
    if (kw('otherwise') || kw('else')) {
      pos++;
      expectNL();
      elseBody = block();
    }
    expectKw('end');
    return N('If', { cond, body, elseBody });
  }

  function unlessStmt() {
    pos++; // eat 'unless'
    const cond = condition();
    eatKw('do');
    expectNL();
    const body = block();
    expectKw('end');
    return N('If', { cond: N('Unary', { op: 'not', expr: cond }), body, elseBody: null });
  }

  function repeatStmt() {
    const word = cur().value; pos++;

    // while/until at statement start
    if (word === 'while') {
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond, body });
    }
    if (word === 'until') {
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond: N('Unary', { op: 'not', expr: cond }), body });
    }
    if (word === 'for') {
      eatKw('each');
      const varName = expectName();
      expectKw('in');
      const iter = expression();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('ForEach', { varName, iter, body });
    }

    // repeat ...
    // repeat each
    if (eatKw('for')) { /* optional filler */ }
    if (kw('each')) {
      pos++;
      const varName = expectName();
      expectKw('in');
      const iter = expression();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('ForEach', { varName, iter, body });
    }
    // repeat while
    if (kw('while')) {
      pos++;
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond, body });
    }
    // repeat until
    if (kw('until')) {
      pos++;
      const cond = condition();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('While', { cond: N('Unary', { op: 'not', expr: cond }), body });
    }
    // repeat from X to Y [by Z] as I
    if (kw('from')) {
      pos++;
      const from = arithmetic();
      expectKw('to');
      const to = arithmetic();
      let step = null;
      if (eatKw('by')) step = arithmetic();
      if (eatKw('as') || eatKw('into')) { /* consume */ }
      const varName = expectName();
      eatKw('do'); expectNL();
      const body = block();
      expectKw('end');
      return N('RangeLoop', { varName, from, to, step, body });
    }
    // repeat N times — parse count as a simple expression, stop before times/time
    const count = repeatCountExpr();
    if (!eatKw('times')) eatKw('time');
    eatKw('do'); expectNL();
    const body = block();
    expectKw('end');
    return N('Repeat', { count, body });
  }

  function defineStmt() {
    pos++; // eat 'define'
    const name = expectName();
    const sig = parseSignature();
    expectNL();
    const body = block();
    expectKw('end');
    return N('Define', { name, sig, body });
  }
  // note: nested defines are NOT registered in signatures — sibling inner functions
  // call each other via `call`/`run`/`result of`. this avoids the return-auto-call
  // problem where `return inner_func` would invoke instead of returning the value.

  function parseSignature() {
    const params = [];
    // skip noise: takes, with
    while (kw('takes') || kw('with')) pos++;
    while (!at(T.NL) && !at(T.EOF)) {
      // variadic
      if (kw('many') || kw('all')) {
        pos++;
        const pname = expectName();
        params.push({ param: pname, variadic: true });
        break;
      }
      // skip 'and' between params
      if (kw('and')) { pos++; continue; }
      // separator keyword + param (or variadic)
      if (at(T.KW) && !isExpressionStart(cur().value)) {
        const nextTok = tokens[pos + 1];
        if (nextTok && (nextTok.type === T.ID || (nextTok.type === T.KW && isParamName(nextTok.value)))) {
          const sep = cur().value; pos++;
          // check for variadic after separator: "of many numbers"
          if (kw('many') || kw('all')) {
            pos++;
            const pname = expectName();
            params.push({ sep, param: pname, variadic: true });
            break;
          }
          const pname = expectName();
          let dflt;
          if (eatKw('is')) dflt = expression();
          params.push({ sep, param: pname, default: dflt });
          continue;
        }
      }
      // bare param
      if (at(T.ID) || (at(T.KW) && isParamName(cur().value))) {
        const pname = expectName();
        let dflt;
        if (eatKw('is')) dflt = expression();
        params.push({ param: pname, default: dflt });
        continue;
      }
      break;
    }
    return params;
  }

  function returnStmt() {
    pos++; // eat 'return'
    if (at(T.NL) || at(T.EOF)) return N('Return', { value: null });
    return N('Return', { value: expression() });
  }

  function makeStmt() {
    pos++; // eat 'make'
    const tag = expression();
    let parent = null;
    if (eatKw('in')) parent = expression();
    let name = null;
    if (eatKw('as') || eatKw('into')) name = expectName();
    return N('Make', { tag, parent, name });
  }

  function loadStmt() {
    pos++; // eat 'load'
    const path = expression();
    let name = null;
    if (eatKw('into') || eatKw('as')) name = expectName();
    return N('Load', { path, name });
  }

  function saveStmt() {
    pos++; // eat 'save'
    const value = expression();
    expectKw('to');
    const path = expression();
    return N('Save', { value, path });
  }

  function useStmt() {
    pos++; // eat 'use'
    const t = cur();
    if (t.type !== T.ID) throw new Error(`Expected dot-path after 'use' at line ${t.line}`);
    const path = t.value; pos++;
    let alias = null;
    if (eatKw('as')) alias = expectName();
    // optional signature (skip for now — pre-scan already captured it)
    return N('Use', { path, alias });
  }

  function addStmt() {
    pos++; // eat 'add'
    const value = expression();
    expectKw('to');
    const target = expectName();
    return N('Add', { value, target });
  }

  function removeStmt() {
    pos++; // eat 'remove'
    const value = expression();
    expectKw('from');
    const target = expectName();
    return N('Remove', { value, target });
  }

  function tryStmt() {
    pos++; // eat 'try'
    expectNL();
    const body = block();
    expectKw('if'); expectKw('it'); expectKw('fails');
    expectNL();
    const handler = block();
    expectKw('end');
    return N('Try', { body, handler });
  }

  function assumeStmt() {
    pos++; // eat 'assume'
    const cond = condition();
    let message = null;
    if (eatKw('otherwise')) message = expression();
    return N('Assume', { cond, message });
  }

  function supposeStmt() {
    pos++; // eat 'suppose'
    const name = expectName();
    expectKw('is');
    const value = expression();
    expectNL();
    const body = block();
    expectKw('end');
    return N('Suppose', { name, value, body });
  }

  function explainStmt() {
    pos++; // eat 'explain'
    // for now, just parse the rest as an expression
    const expr = expression();
    return N('Explain', { expr });
  }

  function onStmt() {
    pos++; // eat 'on'
    const event = expectName();
    let target = null;
    // optional target and params
    if (at(T.ID) || at(T.KW)) {
      if (!at(T.NL)) target = expectName();
    }
    expectNL();
    const body = block();
    expectKw('end');
    return N('On', { event, target, body });
  }

  // ── pipeline transforms ──

  function pipelineCapture(node) {
    // check for "called <name>" mid-pipeline naming
    if (eatKw('called')) {
      const capName = expectName();
      node = N('PipeCalled', { step: node, name: capName });
    }
    // check for "then" / "and then" chaining
    return maybeThen(node);
  }

  function maybeThen(node) {
    const steps = [node];
    while (true) {
      // "and then" or bare "then"
      if (kw('and') && tokens[pos + 1]?.type === T.KW && tokens[pos + 1]?.value === 'then') {
        pos += 2;
      } else if (eatKw('then')) {
        // consumed
      } else {
        break;
      }
      steps.push(parsePipelineStep());
    }
    if (steps.length === 1) {
      // check for terminal capture after the whole chain
      if (eatKw('as') || eatKw('into')) {
        const name = expectName();
        return N('Capture', { expr: steps[0], name });
      }
      return steps[0];
    }
    let result = N('Pipeline', { steps });
    // terminal capture
    if (eatKw('as') || eatKw('into')) {
      const name = expectName();
      return N('Capture', { expr: result, name });
    }
    return result;
  }

  // parse a single pipeline step (after 'then') — raw, no pipelineCapture wrapping
  function parsePipelineStep() {
    let node;
    if (kw('keep') || kw('drop') || kw('only') || kw('where')) node = filterRaw();
    else if (kw('sort')) node = sortRaw();
    else if (kw('average') || kw('total') || kw('smallest') || kw('largest') ||
      kw('mean') || kw('sum') || kw('min') || kw('max')) node = aggRaw();
    else if (kw('count')) node = countRaw();
    else if (kw('first') || kw('last') || kw('top')) node = limitRaw();
    else if (kw('group')) node = groupRaw();
    else if (kw('pick') || kw('get')) node = pickRaw();
    else if (kw('round')) node = roundRaw();
    else if (kw('with')) node = withRaw();
    else {
      // function piping: piped value becomes first arg
      const expr = expression();
      return N('PipeCall', { expr });
    }
    // handle called (but NOT then — that's handled by the outer maybeThen)
    if (eatKw('called')) {
      const capName = expectName();
      node = N('PipeCalled', { step: node, name: capName });
    }
    return node;
  }

  // ── raw pipeline parsers (no capture/then wrapping) ──

  function filterRaw() {
    const op = cur().value; pos++;
    const cond = condition();
    return N('Filter', { op: (op === 'drop') ? 'drop' : 'keep', cond });
  }
  function sortRaw() {
    pos++; eatKw('by');
    const field = expectName();
    let order = 'ascending';
    if (eatKw('descending')) order = 'descending';
    else eatKw('ascending');
    return N('Sort', { field, order });
  }
  function aggRaw() {
    const op = cur().value; pos++;
    eatKw('of');
    const field = expectName();
    const canon = { average: 'average', mean: 'average', total: 'total', sum: 'total',
      smallest: 'smallest', min: 'smallest', largest: 'largest', max: 'largest' }[op] || op;
    return N('Aggregate', { op: canon, field });
  }
  function countRaw() { pos++; eatKw('rows'); return N('Count'); }
  function limitRaw() {
    const op = cur().value; pos++;
    let n = null;
    if (at(T.NUM)) { n = N('Num', { value: parseNumber(cur().value) }); pos++; }
    return N('Limit', { op: (op === 'top') ? 'first' : op, n });
  }
  function groupRaw() { pos++; expectKw('by'); return N('Group', { field: expectName() }); }
  function pickRaw() {
    pos++;
    const fields = [expectName()];
    while (eatKw('and')) fields.push(expectName());
    return N('Pick', { fields });
  }
  function roundRaw() {
    pos++;
    // round <expr> to <n> (explicit value) or round to <n> (pipeline, uses it)
    let value = null;
    if (!kw('to')) {
      value = arithmetic();
    }
    expectKw('to');
    const t = cur();
    if (t.type !== T.NUM) throw new Error(`Expected number after 'round to' at line ${t.line}`);
    const places = parseNumber(t.value); pos++;
    return N('Round', { places, value });
  }
  function withRaw() {
    pos++;
    const field = expectName();
    if (!eatKw('is') && !eatKw('being') && !eatKw('as'))
      throw new Error(`Expected 'is', 'being', or 'as' after field name in 'with' at line ${cur().line}`);
    return N('With', { field, expr: expression() });
  }

  // ── statement-level pipeline parsers (with capture/then) ──

  function takeStmt() { pos++; return pipelineCapture(N('Take', { name: expectName() })); }
  function filterStmt() { return pipelineCapture(filterRaw()); }
  function sortStmt() { return pipelineCapture(sortRaw()); }
  function aggStmt() { return pipelineCapture(aggRaw()); }
  function countStmt() { return pipelineCapture(countRaw()); }
  function limitStmt() { return pipelineCapture(limitRaw()); }
  function groupStmt() { return pipelineCapture(groupRaw()); }
  function pickStmt() { return pipelineCapture(pickRaw()); }
  function roundStmt() { return pipelineCapture(roundRaw()); }
  function withStmt() { return pipelineCapture(withRaw()); }

  function identStmt() {
    const name = cur().value; pos++;
    const args = parseCallArgs(name);
    const call = N('Call', { name, args });
    // result capture
    if (eatKw('as') || eatKw('into')) {
      const capName = expectName();
      return suffixConditional(N('Capture', { expr: call, name: capName }));
    }
    return suffixConditional(N('ExprStmt', { expr: call }));
  }

  function parseCallArgs(name) {
    const sig = signatures.get(name);
    const args = [];
    if (!sig || sig.length === 0) {
      // no declared sig: consume values until NL/EOF/statement keywords
      while (!at(T.NL) && !at(T.EOF) && !kw('as') && !kw('into') && !kw('if') && !kw('unless') && !kw('called')) {
        args.push(arithmetic());
        if (!eat(T.COMMA)) break;
      }
      return args;
    }
    // sig-aware parsing
    for (let i = 0; i < sig.length; i++) {
      const p = sig[i];
      // skip 'and' between params (§5.1)
      eatKw('and');
      // consume separator keyword if present
      if (p.sep) {
        if (kw(p.sep)) pos++;
        else if (i > 0) break; // optional trailing params
      }
      // variadic: collect remaining
      if (p.variadic) {
        while (!at(T.NL) && !at(T.EOF) && !kw('as') && !kw('into') && !kw('if') && !kw('unless') && !kw('called')) {
          eatKw('and'); // skip 'and' separators in variadic
          args.push(arithmetic());
          eat(T.COMMA);
        }
        break;
      }
      // regular param
      if (at(T.NL) || at(T.EOF)) {
        // no more args — use default if available
        break;
      }
      args.push(arithmetic());
    }
    return args;
  }

  function suffixConditional(stmt) {
    if (kw('if')) {
      pos++;
      const cond = condition();
      return N('If', { cond, body: [stmt], elseBody: null });
    }
    if (kw('unless')) {
      pos++;
      const cond = condition();
      return N('If', { cond: N('Unary', { op: 'not', expr: cond }), body: [stmt], elseBody: null });
    }
    return stmt;
  }

  function exprStmt() {
    const expr = expression();
    let node = N('ExprStmt', { expr });
    // check for then-chaining (allows "value" then func then func)
    node = maybeThen(node);
    // suffix conditional
    return suffixConditional(node);
  }

  // ── helpers ──

  function parseNumber(s) {
    if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
    if (s.startsWith('0b') || s.startsWith('0B')) return parseInt(s.slice(2), 2);
    if (s.startsWith('0o') || s.startsWith('0O')) return parseInt(s.slice(2), 8);
    return parseFloat(s);
  }

  return program();
}
