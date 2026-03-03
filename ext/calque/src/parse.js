// Parser — recursive descent + Pratt precedence
//
// Calque grammar:
//   program = (sheetBlock | funcDef | binding | import)*
//   sheetBlock = ID '{' (binding | funcDef)* '}'
//   binding = ID '=' expr
//   funcDef = ID '(' params ')' '=' expr
//   expr = Pratt-parsed expression

import { TOK } from './lex.js';

// ── Operator binding powers ──

const PREFIX_BP = { '-': 20, 'not': 20 };

const INFIX_BP = {
  'or':  [2, 3],
  'and': [4, 5],
  '==':  [8, 9], '/=': [8, 9], '!=': [8, 9],
  '<':   [8, 9], '>':  [8, 9], '<=': [8, 9], '>=': [8, 9],
  '&':   [10, 11],
  '+':   [14, 15], '-': [14, 15],
  '*':   [16, 17], '/': [16, 17],
  '^':   [19, 18], // right-assoc
};

const RANGE_BP = 12; // ..

// ── Parser state ──

export function parse(tokens) {
  let pos = 0;

  function cur() { return tokens[pos]; }
  function at(type, value) {
    const t = tokens[pos];
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  function eat(type, value) {
    if (!at(type, value)) {
      const t = cur();
      const exp = value !== undefined ? `${type} '${value}'` : type;
      throw new SyntaxError(`Expected ${exp}, got ${t.type} '${t.value}' at ${t.line}:${t.col}`);
    }
    return tokens[pos++];
  }
  function tryEat(type, value) {
    if (at(type, value)) return tokens[pos++];
    return null;
  }
  function skipNL() { while (at(TOK.NL)) pos++; }

  // ── Top-level ──

  function parseProgram() {
    const body = [];
    skipNL();
    while (!at(TOK.EOF)) {
      body.push(parseTopLevel());
      skipNL();
    }
    return { type: 'Program', body };
  }

  function parseTopLevel() {
    // import binding: name = import "path"
    // sheet block: Name { ... }
    // funcDef: name(params) = expr
    // binding: name = expr

    if (!at(TOK.ID)) {
      throw new SyntaxError(`Expected identifier at top level, got ${cur().type} '${cur().value}' at ${cur().line}:${cur().col}`);
    }

    const name = cur().value;
    const nameTok = cur();

    // Look ahead to determine what this is
    const saved = pos;

    // Sheet block: ID { ... }
    pos++;
    skipNL();
    if (at(TOK.PUNC, '{')) {
      return parseSheetBlock(name);
    }

    // FuncDef: name(params) = expr
    if (at(TOK.PUNC, '(')) {
      const result = tryParseFuncDef(name, nameTok);
      if (result) return result;
    }

    // Binding: name = expr
    pos = saved + 1;
    skipNL();
    eat(TOK.OP, '=');
    skipNL();
    const expr = parseExpr(0);
    const exported = !name.startsWith('_');
    return { type: 'Binding', name, expr, exported, line: nameTok.line, col: nameTok.col };
  }

  function parseSheetBlock(name) {
    eat(TOK.PUNC, '{');
    skipNL();
    const body = [];
    while (!at(TOK.PUNC, '}') && !at(TOK.EOF)) {
      if (!at(TOK.ID)) {
        throw new SyntaxError(`Expected identifier in sheet block, got ${cur().type} '${cur().value}' at ${cur().line}:${cur().col}`);
      }
      const bindName = cur().value;
      const bindTok = cur();
      pos++;
      skipNL();

      // funcDef inside sheet block
      if (at(TOK.PUNC, '(')) {
        const result = tryParseFuncDef(bindName, bindTok);
        if (result) { body.push(result); skipNL(); continue; }
      }

      eat(TOK.OP, '=');
      skipNL();
      const expr = parseExpr(0);
      const exported = !bindName.startsWith('_');
      body.push({ type: 'Binding', name: bindName, expr, exported, line: bindTok.line, col: bindTok.col });
      skipNL();
    }
    eat(TOK.PUNC, '}');
    return { type: 'SheetBlock', name, body };
  }

  function tryParseFuncDef(name, nameTok) {
    // Try to parse name(params) = expr
    // Save position for backtracking
    const saved = pos;
    pos++; // skip (
    skipNL();

    // Try parsing parameter list: comma-separated IDs
    const params = [];
    if (!at(TOK.PUNC, ')')) {
      if (!at(TOK.ID)) { pos = saved; return null; }
      params.push(eat(TOK.ID).value);
      while (tryEat(TOK.PUNC, ',')) {
        skipNL();
        if (!at(TOK.ID)) { pos = saved; return null; }
        params.push(eat(TOK.ID).value);
      }
    }
    skipNL();
    if (!at(TOK.PUNC, ')')) { pos = saved; return null; }
    pos++; // skip )
    skipNL();
    if (!at(TOK.OP, '=')) { pos = saved; return null; }
    pos++; // skip =
    skipNL();
    const body = parseExpr(0);
    return { type: 'FuncDef', name, params, body, line: nameTok.line, col: nameTok.col };
  }

  // ── Expressions (Pratt) ──

  function parseExpr(minBP) {
    let left = parsePrefix();

    while (true) {
      skipNL();
      if (at(TOK.EOF) || at(TOK.NL)) break;

      // Range operator (..)
      if (at(TOK.RANGE)) {
        if (RANGE_BP < minBP) break;
        pos++;
        skipNL();
        const right = parseExpr(RANGE_BP + 1);
        left = { type: 'Range', start: left, end: right };
        continue;
      }

      // Infix operator (including keyword ops: and, or)
      const opVal = at(TOK.OP) ? cur().value :
                    (at(TOK.KW) && (cur().value === 'and' || cur().value === 'or')) ? cur().value : null;
      if (opVal && INFIX_BP[opVal]) {
        const [lbp, rbp] = INFIX_BP[opVal];
        if (lbp < minBP) break;
        pos++;
        skipNL();
        const right = parseExpr(rbp);
        left = { type: 'BinOp', op: opVal, left, right };
        continue;
      }

      // Postfix: member access (.field)
      if (at(TOK.PUNC, '.')) {
        pos++;
        const field = eat(TOK.ID).value;
        left = { type: 'MemberAccess', object: left, field };
        continue;
      }

      // Postfix: function call (expr(...))
      if (at(TOK.PUNC, '(') && left.type === 'Ident') {
        left = parseFuncCall(left.name);
        continue;
      }

      // Postfix: subscript (expr[...])
      if (at(TOK.PUNC, '[')) {
        pos++;
        skipNL();
        const index = parseExpr(0);
        skipNL();
        eat(TOK.PUNC, ']');
        left = { type: 'Subscript', object: left, index };
        continue;
      }

      break;
    }

    return left;
  }

  function parsePrefix() {
    // Unary minus
    if (at(TOK.OP, '-')) {
      pos++;
      skipNL();
      const operand = parseExpr(PREFIX_BP['-']);
      return { type: 'UnaryOp', op: '-', operand };
    }

    // Unary not
    if (at(TOK.KW, 'not')) {
      pos++;
      skipNL();
      const operand = parseExpr(PREFIX_BP['not']);
      return { type: 'UnaryOp', op: 'not', operand };
    }

    // Grouped expression or lambda: (expr) or (params) -> expr
    if (at(TOK.PUNC, '(')) {
      return parseParenOrLambda();
    }

    // Array literal
    if (at(TOK.PUNC, '[')) {
      return parseArrayLit();
    }

    // Table literal or block
    if (at(TOK.PUNC, '{')) {
      return parseTableLit();
    }

    // If expression
    if (at(TOK.KW, 'if')) {
      return parseIfExpr();
    }

    // Import expression
    if (at(TOK.KW, 'import')) {
      return parseImport();
    }

    // Number literal
    if (at(TOK.NUM)) {
      const t = eat(TOK.NUM);
      return { type: 'NumberLit', value: t.value };
    }

    // String literal
    if (at(TOK.STR)) {
      const t = eat(TOK.STR);
      return { type: 'StringLit', value: t.value };
    }

    // Template string
    if (at(TOK.TMPL)) {
      const t = eat(TOK.TMPL);
      return { type: 'TemplateStr', parts: t.value };
    }

    // Boolean literals
    if (at(TOK.KW, 'true')) { pos++; return { type: 'BoolLit', value: true }; }
    if (at(TOK.KW, 'false')) { pos++; return { type: 'BoolLit', value: false }; }

    // Null literal
    if (at(TOK.KW, 'null')) { pos++; return { type: 'NullLit' }; }

    // Identifier
    if (at(TOK.ID)) {
      const t = eat(TOK.ID);
      return { type: 'Ident', name: t.value };
    }

    throw new SyntaxError(`Unexpected token ${cur().type} '${cur().value}' at ${cur().line}:${cur().col}`);
  }

  function parseParenOrLambda() {
    // Try lambda: (params) -> expr
    const saved = pos;
    pos++; // skip (
    skipNL();

    // Empty parens: () -> expr
    if (at(TOK.PUNC, ')')) {
      pos++; // skip )
      skipNL();
      if (at(TOK.OP, '->')) {
        pos++;
        skipNL();
        const body = parseExpr(0);
        return { type: 'Lambda', params: [], body };
      }
      // empty parens not followed by -> is an error
      pos = saved;
    } else {
      // Try comma-separated IDs
      const params = [];
      let isLambda = true;

      if (at(TOK.ID)) {
        params.push(cur().value);
        pos++;
        while (at(TOK.PUNC, ',')) {
          pos++;
          skipNL();
          if (!at(TOK.ID)) { isLambda = false; break; }
          params.push(cur().value);
          pos++;
        }
        skipNL();
        if (isLambda && at(TOK.PUNC, ')')) {
          pos++;
          skipNL();
          if (at(TOK.OP, '->')) {
            pos++;
            skipNL();
            const body = parseExpr(0);
            return { type: 'Lambda', params, body };
          }
        }
      }

      // Backtrack — it's a grouped expression
      pos = saved;
    }

    // Grouped expression
    pos++; // skip (
    skipNL();
    const expr = parseExpr(0);
    skipNL();
    eat(TOK.PUNC, ')');
    return expr;
  }

  function parseArrayLit() {
    eat(TOK.PUNC, '[');
    skipNL();
    const elements = [];
    if (!at(TOK.PUNC, ']')) {
      elements.push(parseExpr(0));
      while (tryEat(TOK.PUNC, ',')) {
        skipNL();
        if (at(TOK.PUNC, ']')) break; // trailing comma
        elements.push(parseExpr(0));
      }
    }
    skipNL();
    eat(TOK.PUNC, ']');
    return { type: 'ArrayLit', elements };
  }

  function parseTableLit() {
    eat(TOK.PUNC, '{');
    skipNL();
    const columns = [];
    while (!at(TOK.PUNC, '}') && !at(TOK.EOF)) {
      const name = eat(TOK.ID).value;
      eat(TOK.PUNC, ':');
      skipNL();
      const values = parseExpr(0);
      columns.push({ name, values });
      skipNL();
      tryEat(TOK.PUNC, ',');
      skipNL();
    }
    eat(TOK.PUNC, '}');
    return { type: 'TableLit', columns };
  }

  function parseIfExpr() {
    eat(TOK.KW, 'if');
    skipNL();
    const cond = parseExpr(0);
    skipNL();
    eat(TOK.KW, 'then');
    skipNL();
    const then = parseExpr(0);
    skipNL();
    eat(TOK.KW, 'else');
    skipNL();
    const els = parseExpr(0);
    return { type: 'IfExpr', cond, then, else: els };
  }

  function parseImport() {
    eat(TOK.KW, 'import');
    skipNL();
    const path = eat(TOK.STR).value;
    let sheetName = null;
    skipNL();
    if (at(TOK.KW, 'sheet')) {
      pos++;
      skipNL();
      sheetName = eat(TOK.STR).value;
    }
    return { type: 'Import', path, sheetName };
  }

  function parseFuncCall(name) {
    eat(TOK.PUNC, '(');
    skipNL();
    const args = [];
    const kwargs = [];
    if (!at(TOK.PUNC, ')')) {
      parseArg(args, kwargs);
      while (tryEat(TOK.PUNC, ',')) {
        skipNL();
        if (at(TOK.PUNC, ')')) break; // trailing comma
        parseArg(args, kwargs);
      }
    }
    skipNL();
    eat(TOK.PUNC, ')');
    return { type: 'FuncCall', name, args, kwargs };
  }

  function parseArg(args, kwargs) {
    skipNL();
    // Try name: value (keyword argument)
    if (at(TOK.ID)) {
      const saved = pos;
      const name = cur().value;
      pos++;
      if (at(TOK.PUNC, ':')) {
        pos++;
        skipNL();
        const value = parseExpr(0);
        kwargs.push({ name, value });
        return;
      }
      pos = saved;
    }
    args.push(parseExpr(0));
  }

  return parseProgram();
}
