// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/adder/src/  Build: node ext/adder/build.js
// @gcu/adder — Pure JS Python interpreter for Auditable
// Python cells, adder/mpy tagged template, tree-walking evaluator.

// -- parse.js --

// adder v2 — tokenizer + recursive-descent parser
// Produces an AST from Python source code. No external dependencies.

// ── escape sequences ──

function _processEscapes(raw) {
  let out = '', i = 0;
  while (i < raw.length) {
    if (raw[i] !== '\\' || i + 1 >= raw.length) { out += raw[i++]; continue; }
    const c = raw[++i];
    switch (c) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case '0': out += '\0'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case 'x': out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16)); i += 4; break;
      case 'U': out += String.fromCodePoint(parseInt(raw.slice(i + 1, i + 9), 16)); i += 8; break;
      default:
        if (c >= '0' && c <= '7') {
          let oct = c;
          if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') { oct += raw[++i]; }
          if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') { oct += raw[++i]; }
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          out += '\\' + c; // unknown escape — keep as-is
        }
    }
    i++;
  }
  return out;
}

// ── tokenizer ──

const _TWO_OP = new Set(['**', '//', '<<', '>>', '<=', '>=', '==', '!=', '->', ':=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=']);
const _THREE_OP = new Set(['**=', '//=', '<<=', '>>=']);

function adderTokenize(code) {
  const tokens = [];
  const indentStack = [0];
  let pos = 0, line = 1, col = 0;
  let bracketDepth = 0, atBol = true;
  const len = code.length;

  function tok(type, value) { return { type, value, line, col }; }

  while (pos < len) {
    // ── beginning of line: indentation ──
    if (atBol && bracketDepth === 0) {
      let indent = 0;
      while (pos < len && (code[pos] === ' ' || code[pos] === '\t')) {
        indent += code[pos] === '\t' ? (4 - indent % 4) : 1;
        pos++; col++;
      }
      // skip blank / comment-only lines
      if (pos >= len || code[pos] === '\n' || code[pos] === '\r') {
        if (pos < len) { if (code[pos] === '\r' && code[pos + 1] === '\n') pos++; pos++; line++; col = 0; }
        continue;
      }
      if (code[pos] === '#') {
        while (pos < len && code[pos] !== '\n') { pos++; col++; }
        continue;
      }
      // emit INDENT / DEDENT
      const top = indentStack[indentStack.length - 1];
      if (indent > top) {
        indentStack.push(indent);
        tokens.push(tok('INDENT', ''));
      } else {
        while (indentStack[indentStack.length - 1] > indent) {
          indentStack.pop();
          tokens.push(tok('DEDENT', ''));
        }
      }
      atBol = false;
    }

    const ch = code[pos];

    // ── whitespace (non-BOL) ──
    if (ch === ' ' || ch === '\t') { pos++; col++; continue; }

    // ── newline ──
    if (ch === '\n' || ch === '\r') {
      if (bracketDepth === 0) { tokens.push(tok('NEWLINE', '')); atBol = true; }
      if (ch === '\r' && pos + 1 < len && code[pos + 1] === '\n') pos++;
      pos++; line++; col = 0;
      continue;
    }

    // ── line continuation ──
    if (ch === '\\' && pos + 1 < len && (code[pos + 1] === '\n' || code[pos + 1] === '\r')) {
      pos++;
      if (code[pos] === '\r' && pos + 1 < len && code[pos + 1] === '\n') pos++;
      pos++; line++; col = 0;
      continue;
    }

    // ── comment ──
    if (ch === '#') { while (pos < len && code[pos] !== '\n' && code[pos] !== '\r') { pos++; col++; } continue; }

    // ── strings ──
    let prefix = '';
    if (/[fFrRbBuU]/.test(ch)) {
      let j = pos;
      while (j < len && /[fFrRbBuU]/.test(code[j])) j++;
      if (j < len && (code[j] === '"' || code[j] === "'")) {
        prefix = code.slice(pos, j);
        pos = j; col += prefix.length;
      }
    }
    if ((prefix || ch === '"' || ch === "'") && pos < len && (code[pos] === '"' || code[pos] === "'")) {
      const isRaw = /[rR]/.test(prefix);
      const isFstring = /[fF]/.test(prefix);
      const qch = code[pos];
      let triple = false;
      if (pos + 2 < len && code[pos + 1] === qch && code[pos + 2] === qch) {
        triple = true; pos += 3; col += 3;
      } else {
        pos++; col++;
      }

      if (isFstring) {
        // f-string: extract parts
        const parts = [];
        let textBuf = '';
        const endQuote = triple ? qch + qch + qch : qch;
        while (pos < len) {
          if (triple ? (code[pos] === qch && code[pos + 1] === qch && code[pos + 2] === qch) : code[pos] === qch) {
            pos += triple ? 3 : 1; col += triple ? 3 : 1;
            break;
          }
          if (code[pos] === '\n') { if (!triple) break; textBuf += '\n'; pos++; line++; col = 0; continue; }
          if (code[pos] === '{') {
            if (code[pos + 1] === '{') { textBuf += '{'; pos += 2; col += 2; continue; }
            if (textBuf) { parts.push(textBuf); textBuf = ''; }
            pos++; col++; // skip {
            let depth = 1, expr = '', spec = null, conv = null;
            while (pos < len && depth > 0) {
              if (code[pos] === '{') { depth++; expr += code[pos]; }
              else if (code[pos] === '}') { depth--; if (depth > 0) expr += code[pos]; }
              else if (code[pos] === '!' && depth === 1 && 'sra'.includes(code[pos + 1]) && (code[pos + 2] === ':' || code[pos + 2] === '}')) {
                conv = code[pos + 1]; pos += 2; col += 2; continue;
              }
              else if (code[pos] === ':' && depth === 1 && spec === null) {
                spec = ''; pos++; col++;
                while (pos < len && !(code[pos] === '}' && depth === 1)) {
                  if (code[pos] === '{') depth++;
                  if (code[pos] === '}') { depth--; if (depth === 0) break; }
                  spec += code[pos]; pos++; col++;
                }
                continue;
              }
              else { expr += code[pos]; }
              pos++; col++;
            }
            if (code[pos - 1] !== '}' && depth === 0) { /* closing } already consumed */ }
            parts.push({ expr: expr.trim(), spec, conv });
            continue;
          }
          if (code[pos] === '}') {
            if (code[pos + 1] === '}') { textBuf += '}'; pos += 2; col += 2; continue; }
          }
          if (code[pos] === '\\' && !isRaw) {
            textBuf += code[pos] + (code[pos + 1] || '');
            pos += 2; col += 2;
          } else {
            textBuf += code[pos]; pos++; col++;
          }
        }
        if (textBuf) parts.push(textBuf);
        // process escape sequences in text parts
        const processedParts = parts.map(p => typeof p === 'string' ? (isRaw ? p : _processEscapes(p)) : p);
        tokens.push(tok('FSTRING', processedParts));
      } else {
        // regular string
        let raw = '';
        while (pos < len) {
          if (triple ? (code[pos] === qch && code[pos + 1] === qch && code[pos + 2] === qch) : code[pos] === qch) {
            pos += triple ? 3 : 1; col += triple ? 3 : 1;
            break;
          }
          if (code[pos] === '\n') { if (!triple) break; raw += '\n'; pos++; line++; col = 0; continue; }
          if (code[pos] === '\\' && !isRaw) {
            raw += code[pos] + (code[pos + 1] || '');
            pos += 2; col += 2;
          } else {
            raw += code[pos]; pos++; col++;
          }
        }
        tokens.push(tok('STRING', isRaw ? raw : _processEscapes(raw)));
      }
      continue;
    }
    // if prefix consumed but no quote follows, reset — it's an identifier
    if (prefix) { pos -= prefix.length; col -= prefix.length; prefix = ''; }

    // ── numbers ──
    if ((ch >= '0' && ch <= '9') || (ch === '.' && pos + 1 < len && code[pos + 1] >= '0' && code[pos + 1] <= '9')) {
      const start = pos;
      if (ch === '0' && pos + 1 < len) {
        const nx = code[pos + 1];
        if (nx === 'x' || nx === 'X') { pos += 2; while (pos < len && (/[0-9a-fA-F_]/.test(code[pos]))) pos++; }
        else if (nx === 'o' || nx === 'O') { pos += 2; while (pos < len && (/[0-7_]/.test(code[pos]))) pos++; }
        else if (nx === 'b' || nx === 'B') { pos += 2; while (pos < len && (code[pos] === '0' || code[pos] === '1' || code[pos] === '_')) pos++; }
        else { while (pos < len && /[0-9_]/.test(code[pos])) pos++; }
      } else {
        while (pos < len && /[0-9_]/.test(code[pos])) pos++;
      }
      let isFloat = false;
      if (pos < len && code[pos] === '.' && !(code[pos + 1] === '.' && code[pos + 2] === '.')) {
        isFloat = true; pos++;
        while (pos < len && /[0-9_]/.test(code[pos])) pos++;
      }
      if (pos < len && (code[pos] === 'e' || code[pos] === 'E')) {
        isFloat = true; pos++;
        if (pos < len && (code[pos] === '+' || code[pos] === '-')) pos++;
        while (pos < len && /[0-9_]/.test(code[pos])) pos++;
      }
      if (pos < len && (code[pos] === 'j' || code[pos] === 'J')) pos++; // complex — treat as float
      const raw = code.slice(start, pos).replace(/_/g, '');
      const value = isFloat ? parseFloat(raw)
        : (raw.startsWith('0x') || raw.startsWith('0X')) ? parseInt(raw.slice(2), 16)
        : (raw.startsWith('0o') || raw.startsWith('0O')) ? parseInt(raw.slice(2), 8)
        : (raw.startsWith('0b') || raw.startsWith('0B')) ? parseInt(raw.slice(2), 2)
        : parseInt(raw, 10);
      col += pos - start;
      tokens.push(tok('NUMBER', value));
      continue;
    }

    // ── identifiers ──
    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos;
      while (pos < len && /[a-zA-Z0-9_]/.test(code[pos])) pos++;
      col += pos - start;
      tokens.push(tok('NAME', code.slice(start, pos)));
      continue;
    }

    // ── operators / punctuation ──
    // ellipsis
    if (ch === '.' && pos + 2 < len && code[pos + 1] === '.' && code[pos + 2] === '.') {
      tokens.push(tok('OP', '...')); pos += 3; col += 3; continue;
    }
    // 3-char ops
    if (pos + 2 < len) {
      const t3 = code.slice(pos, pos + 3);
      if (_THREE_OP.has(t3)) { tokens.push(tok('OP', t3)); pos += 3; col += 3; continue; }
    }
    // 2-char ops
    if (pos + 1 < len) {
      const t2 = code.slice(pos, pos + 2);
      if (_TWO_OP.has(t2)) { tokens.push(tok('OP', t2)); pos += 2; col += 2; continue; }
    }
    // brackets — track depth
    if (ch === '(' || ch === '[' || ch === '{') bracketDepth++;
    if (ch === ')' || ch === ']' || ch === '}') bracketDepth = Math.max(0, bracketDepth - 1);
    tokens.push(tok('OP', ch)); pos++; col++;
  }

  // ── end of file ──
  if (tokens.length && tokens[tokens.length - 1].type !== 'NEWLINE') {
    tokens.push(tok('NEWLINE', ''));
  }
  while (indentStack.length > 1) { indentStack.pop(); tokens.push(tok('DEDENT', '')); }
  tokens.push(tok('EOF', ''));
  return tokens;
}

// ── parser ──

function adderParse(code) {
  return new _Parser(adderTokenize(code)).parseModule();
}

function _adderParseExpr(code) {
  return new _Parser(adderTokenize(code + '\n')).parseExpr();
}

const _AUGASSIGN = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '@=']);

class _Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos] || { type: 'EOF', value: '', line: 0, col: 0 }; }
  advance() { return this.tokens[this.pos++]; }
  at(type, value) { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
  eat(type, value) { return this.at(type, value) ? this.advance() : null; }
  expect(type, value) {
    const t = this.eat(type, value);
    if (!t) { const p = this.peek(); throw new SyntaxError(`Expected ${value || type}, got '${p.value}' [${p.type}] (line ${p.line})`); }
    return t;
  }

  // ── module / block / statement list ──

  parseModule() {
    const body = [];
    while (!this.at('EOF')) {
      if (this.eat('NEWLINE')) continue;
      body.push(...this.parseStmt());
    }
    return { type: 'Module', body };
  }

  parseBlock() {
    if (this.at('NEWLINE')) {
      this.advance();
      this.expect('INDENT');
      const stmts = [];
      while (!this.at('DEDENT') && !this.at('EOF')) {
        if (this.eat('NEWLINE')) continue;
        stmts.push(...this.parseStmt());
      }
      this.eat('DEDENT');
      return stmts;
    }
    return this.parseSimpleList();
  }

  parseStmt() {
    const t = this.peek();
    // decorators
    if (t.type === 'OP' && t.value === '@') {
      const decorators = [];
      while (this.at('OP', '@')) {
        this.advance();
        decorators.push(this.parseExpr());
        this.expect('NEWLINE');
      }
      if (this.at('NAME', 'def') || this.at('NAME', 'async')) {
        const s = this.at('NAME', 'async') ? (this.advance(), this.parseDef(true, decorators)) : this.parseDef(false, decorators);
        return [s];
      }
      if (this.at('NAME', 'class')) return [this.parseClass(decorators)];
      throw new SyntaxError(`Expected def or class after decorator (line ${this.peek().line})`);
    }
    // async
    if (t.type === 'NAME' && t.value === 'async') {
      this.advance();
      if (this.at('NAME', 'def')) return [this.parseDef(true)];
      if (this.at('NAME', 'for')) return [this.parseFor(true)];
      if (this.at('NAME', 'with')) return [this.parseWith(true)];
      throw new SyntaxError(`Expected def, for, or with after async (line ${t.line})`);
    }
    // compound statements
    if (t.type === 'NAME') {
      if (t.value === 'if') return [this.parseIf()];
      if (t.value === 'for') return [this.parseFor()];
      if (t.value === 'while') return [this.parseWhile()];
      if (t.value === 'def') return [this.parseDef()];
      if (t.value === 'class') return [this.parseClass()];
      if (t.value === 'try') return [this.parseTry()];
      if (t.value === 'with') return [this.parseWith()];
    }
    return this.parseSimpleList();
  }

  parseSimpleList() {
    const stmts = [this.parseSimple()];
    while (this.eat('OP', ';')) {
      if (this.at('NEWLINE') || this.at('EOF')) break;
      stmts.push(this.parseSimple());
    }
    this.eat('NEWLINE');
    return stmts;
  }

  parseSimple() {
    const t = this.peek();
    if (t.type === 'NAME') {
      switch (t.value) {
        case 'return': return this.parseReturn();
        case 'raise': return this.parseRaise();
        case 'assert': return this.parseAssert();
        case 'import': return this.parseImport();
        case 'from': return this.parseFromImport();
        case 'global': return this.parseGlobalNonlocal('Global');
        case 'nonlocal': return this.parseGlobalNonlocal('Nonlocal');
        case 'del': return this.parseDel();
        case 'pass': this.advance(); return { type: 'Pass', line: t.line, col: t.col };
        case 'break': this.advance(); return { type: 'Break', line: t.line, col: t.col };
        case 'continue': this.advance(); return { type: 'Continue', line: t.line, col: t.col };
        case 'yield': return this.parseYield();
      }
    }
    return this.parseAssignOrExpr();
  }

  // ── simple statements ──

  parseReturn() {
    const t = this.advance();
    let value = null;
    if (!this.at('NEWLINE') && !this.at('OP', ';') && !this.at('EOF')) value = this.parseExprOrStars();
    return { type: 'Return', value, line: t.line, col: t.col };
  }

  parseYield() {
    const t = this.advance(); // 'yield'
    if (this.eat('NAME', 'from')) {
      return { type: 'Expr', value: { type: 'YieldFrom', value: this.parseExpr(), line: t.line, col: t.col }, line: t.line, col: t.col };
    }
    let value = null;
    if (!this.at('NEWLINE') && !this.at('OP', ';') && !this.at('EOF') && !this.at('OP', ')') && !this.at('OP', ']')) {
      value = this.parseExprOrStars();
    }
    return { type: 'Expr', value: { type: 'Yield', value, line: t.line, col: t.col }, line: t.line, col: t.col };
  }

  parseRaise() {
    const t = this.advance();
    let exc = null;
    if (!this.at('NEWLINE') && !this.at('OP', ';') && !this.at('EOF')) exc = this.parseExpr();
    return { type: 'Raise', exc, line: t.line, col: t.col };
  }

  parseAssert() {
    const t = this.advance();
    const test = this.parseExpr();
    let msg = null;
    if (this.eat('OP', ',')) msg = this.parseExpr();
    return { type: 'Assert', test, msg, line: t.line, col: t.col };
  }

  parseImport() {
    const t = this.advance();
    const names = [];
    do {
      let module = this.expect('NAME').value;
      while (this.eat('OP', '.')) module += '.' + this.expect('NAME').value;
      const alias = this.eat('NAME', 'as') ? this.expect('NAME').value : null;
      names.push({ module, alias });
    } while (this.eat('OP', ','));
    return { type: 'Import', names, line: t.line, col: t.col };
  }

  parseFromImport() {
    const t = this.advance(); // 'from'
    let module = '';
    while (this.at('OP', '.') || this.at('OP', '...')) {
      module += this.advance().value;
    }
    if (this.at('NAME') && this.peek().value !== 'import') {
      module += this.advance().value;
      while (this.eat('OP', '.')) module += '.' + this.expect('NAME').value;
    }
    this.expect('NAME', 'import');
    if (this.eat('OP', '*')) return { type: 'ImportFrom', module, names: [{ name: '*', alias: null }], line: t.line, col: t.col };
    const names = [];
    const paren = this.eat('OP', '(');
    do {
      const name = this.expect('NAME').value;
      const alias = this.eat('NAME', 'as') ? this.expect('NAME').value : null;
      names.push({ name, alias });
    } while (this.eat('OP', ','));
    if (paren) this.expect('OP', ')');
    return { type: 'ImportFrom', module, names, line: t.line, col: t.col };
  }

  parseGlobalNonlocal(nodeType) {
    const t = this.advance();
    const names = [this.expect('NAME').value];
    while (this.eat('OP', ',')) names.push(this.expect('NAME').value);
    return { type: nodeType, names, line: t.line, col: t.col };
  }

  parseDel() {
    const t = this.advance();
    const targets = [this.parseExpr()];
    while (this.eat('OP', ',')) targets.push(this.parseExpr());
    return { type: 'Delete', targets, line: t.line, col: t.col };
  }

  parseAssignOrExpr() {
    const expr = this.parseExprOrStars();
    // augmented assignment
    if (this.at('OP') && _AUGASSIGN.has(this.peek().value)) {
      const op = this.advance().value.slice(0, -1);
      return { type: 'AugAssign', target: this._asTarget(expr), op, value: this.parseExprOrStars(), line: expr.line, col: expr.col };
    }
    // annotation
    if (this.eat('OP', ':')) {
      const annotation = this.parseExpr();
      const value = this.eat('OP', '=') ? this.parseExprOrStars() : null;
      return { type: 'AnnAssign', target: this._asTarget(expr), annotation, value, line: expr.line, col: expr.col };
    }
    // assignment (possibly chained: a = b = val)
    if (this.eat('OP', '=')) {
      const targets = [this._asTarget(expr)];
      let value = this.parseExprOrStars();
      while (this.eat('OP', '=')) {
        targets.push(this._asTarget(value));
        value = this.parseExprOrStars();
      }
      return { type: 'Assign', targets, value, line: expr.line, col: expr.col };
    }
    return { type: 'Expr', value: expr, line: expr.line, col: expr.col };
  }

  _parseForTarget() {
    // parse target for 'for' statement — stops before 'in'
    const first = this._parseTargetAtom();
    if (!this.at('OP', ',')) return first;
    const elts = [first];
    while (this.eat('OP', ',')) {
      if (this.at('NAME', 'in')) break;
      elts.push(this._parseTargetAtom());
    }
    return { type: 'Tuple', elts, line: first.line, col: first.col };
  }

  _parseTargetAtom() {
    if (this.at('OP', '*')) {
      const t = this.advance();
      return { type: 'Starred', value: this._parseTargetAtom(), line: t.line, col: t.col };
    }
    let expr = this.parseAtom();
    // allow postfix: .attr, [sub]
    while (true) {
      if (this.eat('OP', '.')) { expr = { type: 'Attribute', value: expr, attr: this.expect('NAME').value, line: expr.line, col: expr.col }; }
      else if (this.eat('OP', '[')) { const s = this._parseSlice(); this.expect('OP', ']'); expr = { type: 'Subscript', value: expr, slice: s, line: expr.line, col: expr.col }; }
      else break;
    }
    return expr;
  }

  _asTarget(node) {
    switch (node.type) {
      case 'Name': case 'Subscript': case 'Attribute': case 'Starred': return node;
      case 'Tuple': case 'List': return { ...node, elts: node.elts.map(e => this._asTarget(e)) };
      default: throw new SyntaxError(`Invalid assignment target: ${node.type} (line ${node.line})`);
    }
  }

  // ── compound statements ──

  parseIf() {
    const t = this.advance(); // 'if' or 'elif'
    const test = this.parseExpr();
    this.expect('OP', ':');
    const body = this.parseBlock();
    let orelse = [];
    if (this.at('NAME', 'elif')) orelse = [this.parseIf()];
    else if (this.eat('NAME', 'else')) { this.expect('OP', ':'); orelse = this.parseBlock(); }
    return { type: 'If', test, body, orelse, line: t.line, col: t.col };
  }

  parseFor(isAsync = false) {
    const t = this.advance(); // 'for'
    const target = this._asTarget(this._parseForTarget());
    this.expect('NAME', 'in');
    const iter = this.parseExprOrStars();
    this.expect('OP', ':');
    const body = this.parseBlock();
    let orelse = [];
    if (this.eat('NAME', 'else')) { this.expect('OP', ':'); orelse = this.parseBlock(); }
    return { type: 'For', target, iter, body, orelse, isAsync, line: t.line, col: t.col };
  }

  parseWhile() {
    const t = this.advance();
    const test = this.parseExpr();
    this.expect('OP', ':');
    const body = this.parseBlock();
    let orelse = [];
    if (this.eat('NAME', 'else')) { this.expect('OP', ':'); orelse = this.parseBlock(); }
    return { type: 'While', test, body, orelse, line: t.line, col: t.col };
  }

  parseDef(isAsync = false, decorators = []) {
    const t = this.advance(); // 'def'
    const name = this.expect('NAME').value;
    this.expect('OP', '(');
    const params = this._parseFuncParams();
    this.expect('OP', ')');
    let returns = null;
    if (this.eat('OP', '->')) returns = this.parseExpr();
    this.expect('OP', ':');
    const body = this.parseBlock();
    return { type: isAsync ? 'AsyncFunctionDef' : 'FunctionDef', name, ...params, body, decorators, returns, line: t.line, col: t.col };
  }

  _parseFuncParams() {
    const params = [], kwonly = [];
    let vararg = null, kwarg = null, seenStar = false;
    while (!this.at('OP', ')')) {
      if (this.eat('OP', '**')) { kwarg = this.expect('NAME').value; break; }
      if (this.eat('OP', '*')) {
        seenStar = true;
        if (this.at('NAME')) vararg = this.advance().value;
        this.eat('OP', ',');
        continue;
      }
      const pName = this.expect('NAME').value;
      let annotation = null;
      if (this.eat('OP', ':')) annotation = this.parseExpr();
      let def = null;
      if (this.eat('OP', '=')) def = this.parseExpr();
      (seenStar ? kwonly : params).push({ name: pName, default: def, annotation });
      if (!this.eat('OP', ',')) break;
    }
    return { params, vararg, kwonly, kwarg };
  }

  parseClass(decorators = []) {
    const t = this.advance(); // 'class'
    const name = this.expect('NAME').value;
    let bases = [];
    if (this.eat('OP', '(')) {
      while (!this.at('OP', ')')) {
        bases.push(this.parseExpr());
        this.eat('OP', ',');
      }
      this.expect('OP', ')');
    }
    this.expect('OP', ':');
    const body = this.parseBlock();
    return { type: 'ClassDef', name, bases, body, decorators, line: t.line, col: t.col };
  }

  parseTry() {
    const t = this.advance();
    this.expect('OP', ':');
    const body = this.parseBlock();
    const handlers = [];
    while (this.at('NAME', 'except')) {
      this.advance();
      let excType = null, excName = null;
      if (!this.at('OP', ':')) {
        excType = this.parseExpr();
        if (this.eat('NAME', 'as')) excName = this.expect('NAME').value;
      }
      this.expect('OP', ':');
      handlers.push({ type: 'ExceptHandler', excType, name: excName, body: this.parseBlock(), line: t.line });
    }
    let orelse = [];
    if (this.eat('NAME', 'else')) { this.expect('OP', ':'); orelse = this.parseBlock(); }
    let finalbody = [];
    if (this.eat('NAME', 'finally')) { this.expect('OP', ':'); finalbody = this.parseBlock(); }
    return { type: 'Try', body, handlers, orelse, finalbody, line: t.line, col: t.col };
  }

  parseWith(isAsync = false) {
    const t = this.advance();
    const items = [];
    do {
      const contextExpr = this.parseExpr();
      const optionalVar = this.eat('NAME', 'as') ? this._asTarget(this.parseExpr()) : null;
      items.push({ contextExpr, optionalVar });
    } while (this.eat('OP', ','));
    this.expect('OP', ':');
    return { type: 'With', items, body: this.parseBlock(), isAsync, line: t.line, col: t.col };
  }

  // ── expressions ──

  parseExprOrStars() {
    const first = this.parseStarExpr();
    if (!this.at('OP', ',') || this.at('OP', ')') || this.at('OP', ']') || this.at('OP', '}')) return first;
    // check if comma is part of tuple (not a function call separator)
    // in contexts like assignment RHS, commas make tuples
    const elts = [first];
    while (this.eat('OP', ',')) {
      if (this.at('NEWLINE') || this.at('EOF') || this.at('OP', ')') || this.at('OP', ']') ||
          this.at('OP', '}') || this.at('OP', ';') || this.at('OP', '=') || this.at('OP', ':')) break;
      elts.push(this.parseStarExpr());
    }
    if (elts.length === 1) return first;
    return { type: 'Tuple', elts, line: first.line, col: first.col };
  }

  parseStarExpr() {
    if (this.at('OP', '*') && !this._isBinContext()) {
      const t = this.advance();
      return { type: 'Starred', value: this.parseExpr(), line: t.line, col: t.col };
    }
    return this.parseExpr();
  }

  _isBinContext() {
    // star is binary if preceded by a value token
    if (this.pos === 0) return false;
    const prev = this.tokens[this.pos - 1];
    return prev && (prev.type === 'NAME' || prev.type === 'NUMBER' || prev.type === 'STRING' ||
      prev.value === ')' || prev.value === ']' || prev.value === '}');
  }

  parseExpr() {
    if (this.at('NAME', 'lambda')) return this.parseLambda();
    // walrus operator: name := expr
    if (this.peek().type === 'NAME' && this.tokens[this.pos + 1]?.type === 'OP' && this.tokens[this.pos + 1]?.value === ':=') {
      const name = this.advance();
      this.advance(); // :=
      return { type: 'NamedExpr', target: { type: 'Name', id: name.value, line: name.line, col: name.col }, value: this.parseExpr(), line: name.line, col: name.col };
    }
    return this.parseTernary();
  }

  parseTernary() {
    const expr = this.parseOr();
    if (this.eat('NAME', 'if')) {
      const test = this.parseOr();
      this.expect('NAME', 'else');
      const orelse = this.parseExpr();
      return { type: 'IfExp', test, body: expr, orelse, line: expr.line, col: expr.col };
    }
    return expr;
  }

  parseOr() {
    let first = this.parseAnd();
    if (!this.at('NAME', 'or')) return first;
    const values = [first];
    while (this.eat('NAME', 'or')) values.push(this.parseAnd());
    return { type: 'BoolOp', op: 'or', values, line: first.line, col: first.col };
  }

  parseAnd() {
    let first = this.parseNot();
    if (!this.at('NAME', 'and')) return first;
    const values = [first];
    while (this.eat('NAME', 'and')) values.push(this.parseNot());
    return { type: 'BoolOp', op: 'and', values, line: first.line, col: first.col };
  }

  parseNot() {
    if (this.at('NAME', 'not') && !(this.tokens[this.pos + 1]?.value === 'in')) {
      const t = this.advance();
      return { type: 'UnaryOp', op: 'not', operand: this.parseNot(), line: t.line, col: t.col };
    }
    return this.parseCompare();
  }

  parseCompare() {
    let left = this.parseBitOr();
    const ops = [], comparators = [];
    while (this._isCompOp()) {
      ops.push(this._readCompOp());
      comparators.push(this.parseBitOr());
    }
    if (!ops.length) return left;
    return { type: 'Compare', left, ops, comparators, line: left.line, col: left.col };
  }

  _isCompOp() {
    const v = this.peek().value;
    if (['<', '>', '<=', '>=', '==', '!='].includes(v)) return true;
    if (v === 'in' || v === 'is') return true;
    if (v === 'not' && this.tokens[this.pos + 1]?.value === 'in') return true;
    return false;
  }

  _readCompOp() {
    if (this.at('NAME', 'not')) { this.advance(); this.expect('NAME', 'in'); return 'not in'; }
    if (this.at('NAME', 'is')) { this.advance(); if (this.eat('NAME', 'not')) return 'is not'; return 'is'; }
    if (this.at('NAME', 'in')) { this.advance(); return 'in'; }
    return this.advance().value;
  }

  _binLeft(sub, ...ops) {
    let left = sub.call(this);
    while (this.at('OP') && ops.includes(this.peek().value)) {
      const op = this.advance().value;
      left = { type: 'BinOp', left, op, right: sub.call(this), line: left.line, col: left.col };
    }
    return left;
  }

  parseBitOr() { return this._binLeft(this.parseBitXor, '|'); }
  parseBitXor() { return this._binLeft(this.parseBitAnd, '^'); }
  parseBitAnd() { return this._binLeft(this.parseShift, '&'); }
  parseShift() { return this._binLeft(this.parseArith, '<<', '>>'); }
  parseArith() { return this._binLeft(this.parseTerm, '+', '-'); }
  parseTerm() { return this._binLeft(this.parseUnary, '*', '/', '//', '%', '@'); }

  parseUnary() {
    if (this.at('OP', '-') || this.at('OP', '+') || this.at('OP', '~')) {
      const t = this.advance();
      return { type: 'UnaryOp', op: t.value, operand: this.parseUnary(), line: t.line, col: t.col };
    }
    return this.parsePower();
  }

  parsePower() {
    const left = this.parseAwait();
    if (this.eat('OP', '**')) {
      return { type: 'BinOp', left, op: '**', right: this.parseUnary(), line: left.line, col: left.col };
    }
    return left;
  }

  parseAwait() {
    if (this.at('NAME', 'await')) {
      const t = this.advance();
      return { type: 'Await', value: this.parseUnary(), line: t.line, col: t.col };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expr = this.parseAtom();
    while (true) {
      if (this.eat('OP', '.')) {
        const attr = this.expect('NAME').value;
        expr = { type: 'Attribute', value: expr, attr, line: expr.line, col: expr.col };
      } else if (this.eat('OP', '(')) {
        const { args, keywords } = this._parseCallArgs();
        this.expect('OP', ')');
        expr = { type: 'Call', func: expr, args, keywords, line: expr.line, col: expr.col };
      } else if (this.eat('OP', '[')) {
        const slice = this._parseSlice();
        this.expect('OP', ']');
        expr = { type: 'Subscript', value: expr, slice, line: expr.line, col: expr.col };
      } else break;
    }
    return expr;
  }

  _parseCallArgs() {
    const args = [], keywords = [];
    while (!this.at('OP', ')')) {
      if (this.at('OP', '**')) {
        this.advance();
        keywords.push({ name: null, value: this.parseExpr() });
      } else if (this.at('OP', '*')) {
        this.advance();
        args.push({ type: 'Starred', value: this.parseExpr(), line: this.peek().line, col: this.peek().col });
      } else if (this.peek().type === 'NAME' && this.tokens[this.pos + 1]?.value === '=' && this.tokens[this.pos + 1]?.type === 'OP') {
        // keyword argument — but check it's not ==
        if (this.tokens[this.pos + 1]?.value === '=' && this.tokens[this.pos + 2]?.value !== '=') {
          const name = this.advance().value;
          this.advance(); // =
          keywords.push({ name, value: this.parseExpr() });
        } else {
          args.push(this.parseExpr());
        }
      } else {
        const expr = this.parseExpr();
        // generator expression: sum(x for x in items)
        if (this.at('NAME', 'for')) {
          const generators = this._parseCompIter();
          args.push({ type: 'GeneratorExp', elt: expr, generators, line: expr.line, col: expr.col });
        } else {
          args.push(expr);
        }
      }
      this.eat('OP', ',');
    }
    return { args, keywords };
  }

  _parseSlice() {
    let lower = null, isSlice = false;
    if (!this.at('OP', ':') && !this.at('OP', ']')) lower = this.parseExpr();
    if (this.eat('OP', ':')) {
      isSlice = true;
      let upper = null, step = null;
      if (!this.at('OP', ':') && !this.at('OP', ']') && !this.at('OP', ',')) upper = this.parseExpr();
      if (this.eat('OP', ':')) {
        if (!this.at('OP', ']') && !this.at('OP', ',')) step = this.parseExpr();
      }
      return { type: 'Slice', lower, upper, step, line: (lower || this.peek()).line, col: 0 };
    }
    return lower;
  }

  parseAtom() {
    const t = this.peek();

    // keywords
    if (t.type === 'NAME') {
      if (t.value === 'True') { this.advance(); return { type: 'Constant', value: true, line: t.line, col: t.col }; }
      if (t.value === 'False') { this.advance(); return { type: 'Constant', value: false, line: t.line, col: t.col }; }
      if (t.value === 'None') { this.advance(); return { type: 'Constant', value: null, line: t.line, col: t.col }; }
      if (t.value === 'not') {
        // `not` as a unary — but we shouldn't get here normally (parseNot handles it)
        // handle it as a fallback
        this.advance();
        return { type: 'UnaryOp', op: 'not', operand: this.parseNot(), line: t.line, col: t.col };
      }
      this.advance();
      return { type: 'Name', id: t.value, line: t.line, col: t.col };
    }

    // number
    if (t.type === 'NUMBER') { this.advance(); return { type: 'Constant', value: t.value, line: t.line, col: t.col }; }

    // string (with concatenation of adjacent strings)
    if (t.type === 'STRING') {
      this.advance();
      let value = t.value;
      while (this.peek().type === 'STRING') value += this.advance().value;
      return { type: 'Constant', value, line: t.line, col: t.col };
    }

    // f-string
    if (t.type === 'FSTRING') { this.advance(); return this._parseFstring(t); }

    // ellipsis
    if (t.type === 'OP' && t.value === '...') { this.advance(); return { type: 'Constant', value: null, line: t.line, col: t.col }; }

    // parenthesized / tuple / generator
    if (t.type === 'OP' && t.value === '(') {
      this.advance();
      if (this.eat('OP', ')')) return { type: 'Tuple', elts: [], line: t.line, col: t.col };
      const first = this.parseStarExpr();
      if (this.at('NAME', 'for')) {
        const generators = this._parseCompIter();
        this.expect('OP', ')');
        return { type: 'GeneratorExp', elt: first, generators, line: t.line, col: t.col };
      }
      if (this.eat('OP', ',')) {
        const elts = [first];
        while (!this.at('OP', ')')) {
          elts.push(this.parseStarExpr());
          if (!this.eat('OP', ',')) break;
        }
        this.expect('OP', ')');
        return { type: 'Tuple', elts, line: t.line, col: t.col };
      }
      this.expect('OP', ')');
      return first;
    }

    // list / list comprehension
    if (t.type === 'OP' && t.value === '[') {
      this.advance();
      if (this.eat('OP', ']')) return { type: 'List', elts: [], line: t.line, col: t.col };
      const first = this.parseStarExpr();
      if (this.at('NAME', 'for')) {
        const generators = this._parseCompIter();
        this.expect('OP', ']');
        return { type: 'ListComp', elt: first, generators, line: t.line, col: t.col };
      }
      const elts = [first];
      while (this.eat('OP', ',')) {
        if (this.at('OP', ']')) break;
        elts.push(this.parseStarExpr());
      }
      this.expect('OP', ']');
      return { type: 'List', elts, line: t.line, col: t.col };
    }

    // dict / set / comprehension
    if (t.type === 'OP' && t.value === '{') {
      this.advance();
      if (this.eat('OP', '}')) return { type: 'Dict', keys: [], values: [], line: t.line, col: t.col };
      // dict unpacking
      if (this.at('OP', '**')) {
        return this._parseDictBody(t, [], []);
      }
      const first = this.parseExpr();
      if (this.eat('OP', ':')) {
        // dict
        const firstVal = this.parseExpr();
        if (this.at('NAME', 'for')) {
          const generators = this._parseCompIter();
          this.expect('OP', '}');
          return { type: 'DictComp', key: first, value: firstVal, generators, line: t.line, col: t.col };
        }
        return this._parseDictBody(t, [first], [firstVal]);
      }
      // set
      if (this.at('NAME', 'for')) {
        const generators = this._parseCompIter();
        this.expect('OP', '}');
        return { type: 'SetComp', elt: first, generators, line: t.line, col: t.col };
      }
      const elts = [first];
      while (this.eat('OP', ',')) {
        if (this.at('OP', '}')) break;
        elts.push(this.parseExpr());
      }
      this.expect('OP', '}');
      return { type: 'Set', elts, line: t.line, col: t.col };
    }

    throw new SyntaxError(`Unexpected token: ${t.type} '${t.value}' (line ${t.line})`);
  }

  _parseDictBody(startTok, keys, values) {
    while (this.eat('OP', ',')) {
      if (this.at('OP', '}')) break;
      if (this.eat('OP', '**')) {
        keys.push(null);
        values.push(this.parseExpr());
      } else {
        keys.push(this.parseExpr());
        this.expect('OP', ':');
        values.push(this.parseExpr());
      }
    }
    this.expect('OP', '}');
    return { type: 'Dict', keys, values, line: startTok.line, col: startTok.col };
  }

  _parseCompIter() {
    const generators = [];
    while (this.at('NAME', 'for') || this.at('NAME', 'async')) {
      const isAsync = !!this.eat('NAME', 'async');
      this.expect('NAME', 'for');
      const target = this._asTarget(this._parseForTarget());
      this.expect('NAME', 'in');
      const iter = this.parseOr();
      const ifs = [];
      while (this.at('NAME', 'if')) { this.advance(); ifs.push(this.parseOr()); }
      generators.push({ target, iter, ifs, isAsync });
    }
    return generators;
  }

  _parseFstring(tok) {
    const values = [];
    for (const part of tok.value) {
      if (typeof part === 'string') {
        if (part) values.push({ type: 'Constant', value: part, line: tok.line, col: tok.col });
      } else {
        const exprNode = _adderParseExpr(part.expr);
        values.push({
          type: 'FormattedValue', value: exprNode,
          conversion: part.conv || null,
          formatSpec: part.spec || null,
          line: tok.line, col: tok.col,
        });
      }
    }
    return { type: 'JoinedStr', values, line: tok.line, col: tok.col };
  }

  parseLambda() {
    const t = this.advance(); // 'lambda'
    const params = [];
    let vararg = null, kwarg = null;
    while (!this.at('OP', ':')) {
      if (this.eat('OP', '*')) { if (this.at('NAME')) vararg = this.advance().value; this.eat('OP', ','); continue; }
      if (this.eat('OP', '**')) { kwarg = this.expect('NAME').value; break; }
      const name = this.expect('NAME').value;
      const def = this.eat('OP', '=') ? this.parseExpr() : null;
      params.push({ name, default: def });
      this.eat('OP', ',');
    }
    this.expect('OP', ':');
    return { type: 'Lambda', params, vararg, kwarg, body: this.parseExpr(), line: t.line, col: t.col };
  }
}

// -- builtins.js --

// adder v2 — builtins, modules, format specs
// Python built-in functions, method dispatch, and standard modules.
// All functions are sync unless they need to call user-provided callables
// (which are async since the evaluator is async).

// ── PyRange — lazy range ──

class AdderRange {
  constructor(start, stop, step) {
    if (stop === undefined) { this.start = 0; this.stop = start; this.step = 1; }
    else { this.start = start; this.stop = stop; this.step = step || 1; }
    if (this.step === 0) throw new AdderError('ValueError', 'range() arg 3 must not be zero');
    this.length = Math.max(0, Math.ceil((this.stop - this.start) / this.step));
  }
  [Symbol.iterator]() {
    let i = this.start;
    const stop = this.stop, step = this.step;
    return { next() {
      if (step > 0 ? i < stop : i > stop) { const v = i; i += step; return { value: v, done: false }; }
      return { done: true };
    }};
  }
  includes(v) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return false;
    if (this.step > 0) { if (v < this.start || v >= this.stop) return false; }
    else { if (v > this.start || v <= this.stop) return false; }
    return (v - this.start) % this.step === 0;
  }
}

// ── AdderError ──

class AdderError extends Error {
  constructor(pyType, message, adderLine) {
    super(`${pyType}: ${message}${adderLine ? ` (line ${adderLine})` : ''}`);
    this.pyType = pyType;
    this.pyMessage = message;
    this.adderLine = adderLine;
  }
}

// ── type helpers ──

function pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'dict';
  if (v instanceof Set) return 'set';
  if (v instanceof AdderRange) return 'range';
  if (v instanceof Uint8Array) return 'bytes';
  if (typeof v === 'function') return 'function';
  if (v?.__adderClass__) return v.__adderClass__;
  return 'object';
}

function pyBool(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '' || v !== v) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v instanceof AdderRange) return v.length > 0;
  // check __bool__ dunder
  if (typeof v === 'object' && typeof v.__bool__ === 'function') return !!v.__bool__();
  if (typeof v === 'object' && typeof v.__len__ === 'function') return v.__len__() !== 0;
  return true;
}

function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (v instanceof Map) {
    const items = [...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`);
    return `{${items.join(', ')}}`;
  }
  if (v instanceof Set) return `{${[...v].map(pyRepr).join(', ')}}` || 'set()';
  if (v instanceof AdderRange) {
    if (v.step === 1) return `range(${v.start}, ${v.stop})`;
    return `range(${v.start}, ${v.stop}, ${v.step})`;
  }
  if (typeof v === 'function') return `<function ${v._pyName || v.name || '<lambda>'}>`;
  if (typeof v === 'object' && typeof v.__repr__ === 'function') return v.__repr__();
  if (typeof v === 'object' && typeof v.__str__ === 'function') return v.__str__();
  try { return JSON.stringify(v); } catch { return String(v); }
}

function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.__str__ === 'function') return v.__str__();
  return pyRepr(v);
}

// ── iteration helper ──

export function* pyIter(obj) {
  if (obj === null || obj === undefined) throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not iterable`);
  if (Array.isArray(obj) || typeof obj === 'string' || obj instanceof Uint8Array) { for (let i = 0; i < obj.length; i++) yield obj[i]; return; }
  if (obj instanceof Map) { for (const k of obj.keys()) yield k; return; }
  if (obj instanceof Set || obj instanceof AdderRange) { yield* obj; return; }
  if (typeof obj[Symbol.iterator] === 'function') { yield* obj; return; }
  if (typeof obj === 'object' && typeof obj.length === 'number') { for (let i = 0; i < obj.length; i++) yield obj[i]; return; }
  // plain object — iterate keys
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) yield k; return; }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not iterable`);
}

// Collect iterable (sync or async) to array
async function pyCollect(obj) {
  if (obj && typeof obj[Symbol.asyncIterator] === 'function') {
    const arr = [];
    for await (const v of obj) arr.push(v);
    return arr;
  }
  return [...pyIter(obj)];
}

// ── format spec ──

function pyFormatValue(value, spec) {
  if (!spec) return pyStr(value);
  // parse spec: [[fill]align][sign][z][#][0][width][grouping_option][.precision][type]
  let fill = ' ', align = '', sign = '', width = 0, precision = -1, ftype = '', grouping = '';
  let i = 0;
  // fill + align
  if (i + 1 < spec.length && '<>^='.includes(spec[i + 1])) { fill = spec[i]; align = spec[i + 1]; i += 2; }
  else if (i < spec.length && '<>^='.includes(spec[i])) { align = spec[i]; i++; }
  // sign
  if (i < spec.length && '+-'.includes(spec[i])) { sign = spec[i]; i++; }
  // zero pad
  if (i < spec.length && spec[i] === '0') { if (!align) { fill = '0'; align = '='; } i++; }
  // width
  while (i < spec.length && spec[i] >= '0' && spec[i] <= '9') { width = width * 10 + (+spec[i]); i++; }
  // grouping
  if (i < spec.length && (spec[i] === ',' || spec[i] === '_')) { grouping = spec[i]; i++; }
  // precision
  if (i < spec.length && spec[i] === '.') { i++; precision = 0; while (i < spec.length && spec[i] >= '0' && spec[i] <= '9') { precision = precision * 10 + (+spec[i]); i++; } }
  // type
  if (i < spec.length) ftype = spec[i];

  let result;
  if (ftype === 'd') {
    result = Math.trunc(Number(value)).toString();
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'f' || ftype === 'F') {
    result = Number(value).toFixed(precision >= 0 ? precision : 6);
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'e' || ftype === 'E') {
    result = Number(value).toExponential(precision >= 0 ? precision : 6);
    if (ftype === 'E') result = result.toUpperCase();
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'g' || ftype === 'G') {
    const p = precision >= 0 ? precision : 6;
    result = Number(value).toPrecision(p || 1);
    if (result.includes('e')) { /* keep */ } else { result = parseFloat(result).toString(); }
    if (ftype === 'G') result = result.toUpperCase();
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === '%') {
    result = (Number(value) * 100).toFixed(precision >= 0 ? precision : 6) + '%';
    if (sign === '+' && !result.startsWith('-')) result = '+' + result;
  } else if (ftype === 'b') {
    result = Math.trunc(Number(value)).toString(2);
  } else if (ftype === 'o') {
    result = Math.trunc(Number(value)).toString(8);
  } else if (ftype === 'x' || ftype === 'X') {
    result = Math.trunc(Math.abs(Number(value))).toString(16);
    if (ftype === 'X') result = result.toUpperCase();
    if (Number(value) < 0) result = '-' + result;
  } else if (ftype === 'c') {
    result = String.fromCodePoint(Number(value));
  } else if (ftype === 's' || ftype === '') {
    result = typeof value === 'string' ? value : pyStr(value);
    if (precision >= 0) result = result.slice(0, precision);
  } else if (ftype === 'n') {
    result = Number(value).toLocaleString();
  } else {
    // auto: number vs string
    if (typeof value === 'number') {
      result = precision >= 0 ? value.toFixed(precision) : String(value);
      if (sign === '+' && !result.startsWith('-')) result = '+' + result;
    } else {
      result = pyStr(value);
      if (precision >= 0) result = result.slice(0, precision);
    }
  }

  // grouping
  if (grouping && (ftype === 'd' || ftype === 'f' || ftype === 'F' || ftype === '' || !ftype)) {
    const neg = result.startsWith('-');
    let num = neg ? result.slice(1) : result;
    const dot = num.indexOf('.');
    const intPart = dot >= 0 ? num.slice(0, dot) : num;
    const rest = dot >= 0 ? num.slice(dot) : '';
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, grouping);
    result = (neg ? '-' : '') + grouped + rest;
  }

  // alignment
  if (!align) align = typeof value === 'string' ? '<' : '>';
  if (width > result.length) {
    const pad = width - result.length;
    if (align === '<') result = result + fill.repeat(pad);
    else if (align === '>') result = fill.repeat(pad) + result;
    else if (align === '^') { const left = Math.floor(pad / 2); result = fill.repeat(left) + result + fill.repeat(pad - left); }
    else if (align === '=') {
      // pad after sign
      const signIdx = (result[0] === '-' || result[0] === '+') ? 1 : 0;
      result = result.slice(0, signIdx) + fill.repeat(pad) + result.slice(signIdx);
    }
  }
  return result;
}

// ── method dispatch ──

function _isNativeClass(fn) {
  try { return /^class[\s{]/.test(Function.prototype.toString.call(fn)); } catch { return false; }
}

function adderGetAttr(obj, attr) {
  // string methods
  if (typeof obj === 'string') return _strMethod(obj, attr);
  // list methods
  if (Array.isArray(obj)) return _listMethod(obj, attr);
  // dict (Map) methods
  if (obj instanceof Map) return _mapMethod(obj, attr);
  // set methods
  if (obj instanceof Set) return _setMethod(obj, attr);
  // range
  if (obj instanceof AdderRange) {
    if (attr === 'start') return obj.start;
    if (attr === 'stop') return obj.stop;
    if (attr === 'step') return obj.step;
  }
  // plain object (dict with string keys)
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Array) && !(obj instanceof Map) && !(obj instanceof Set)) {
    // check for adder class method on prototype
    if (typeof obj[attr] === 'function') {
      if (_isNativeClass(obj[attr])) return obj[attr];
      // adder functions expect self as first arg — inject it (skip for modules)
      if (obj[attr]._pyFunc && !obj.__adderModule__) {
        const originalFn = obj[attr];
        const fn = (...args) => originalFn(obj, ...args);
        fn._pyFunc = true;
        fn._pyName = `${attr}`;
        return fn;
      }
      const fn = obj[attr].bind(obj);
      fn._pyName = attr;
      return fn;
    }
    // dict-like attribute access — keys, values, items, get, etc.
    if (_objDictMethods[attr]) return _objDictMethods[attr](obj);
    // regular property access
    if (attr in obj) return obj[attr];
    // __getattr__ dunder
    if (typeof obj.__getattr__ === 'function') return obj.__getattr__(attr);
    throw new AdderError('AttributeError', `'${pyTypeName(obj)}' object has no attribute '${attr}'`);
  }
  // generic
  if (obj !== null && obj !== undefined && attr in obj) {
    const val = obj[attr];
    if (typeof val === 'function') {
      if (_isNativeClass(val)) return val;
      if (val._pyFunc) { const fn = (...args) => val(obj, ...args); fn._pyFunc = true; fn._pyName = attr; return fn; }
      return val.bind(obj);
    }
    return val;
  }
  throw new AdderError('AttributeError', `'${pyTypeName(obj)}' object has no attribute '${attr}'`);
}

function _strMethod(s, attr) {
  const m = {
    upper: () => s.toUpperCase(),
    lower: () => s.toLowerCase(),
    strip: (chars) => chars ? _stripChars(s, chars) : s.trim(),
    lstrip: (chars) => chars ? _lstripChars(s, chars) : s.trimStart(),
    rstrip: (chars) => chars ? _rstripChars(s, chars) : s.trimEnd(),
    split: (sep, maxsplit) => {
      if (sep === undefined || sep === null) return s.trim().split(/\s+/);
      if (maxsplit !== undefined) { const parts = []; let rest = s; for (let i = 0; i < maxsplit; i++) { const idx = rest.indexOf(sep); if (idx < 0) break; parts.push(rest.slice(0, idx)); rest = rest.slice(idx + sep.length); } parts.push(rest); return parts; }
      return s.split(sep);
    },
    rsplit: (sep, maxsplit) => {
      if (sep === undefined || sep === null) return s.trim().split(/\s+/);
      if (maxsplit !== undefined) { const parts = []; let rest = s; for (let i = 0; i < maxsplit; i++) { const idx = rest.lastIndexOf(sep); if (idx < 0) break; parts.unshift(rest.slice(idx + sep.length)); rest = rest.slice(0, idx); } parts.unshift(rest); return parts; }
      return s.split(sep);
    },
    join: (iterable) => [...pyIter(iterable)].join(s),
    replace: (old, nw, count) => {
      if (count === undefined) return s.split(old).join(nw);
      let result = s, n = 0;
      while (n < count) { const idx = result.indexOf(old); if (idx < 0) break; result = result.slice(0, idx) + nw + result.slice(idx + old.length); n++; }
      return result;
    },
    find: (sub, start, end) => { const sl = s.slice(start || 0, end); const i = sl.indexOf(sub); return i < 0 ? -1 : i + (start || 0); },
    rfind: (sub, start, end) => { const sl = s.slice(start || 0, end); const i = sl.lastIndexOf(sub); return i < 0 ? -1 : i + (start || 0); },
    index: (sub, start, end) => { const i = m.find(sub, start, end); if (i < 0) throw new AdderError('ValueError', 'substring not found'); return i; },
    rindex: (sub, start, end) => { const i = m.rfind(sub, start, end); if (i < 0) throw new AdderError('ValueError', 'substring not found'); return i; },
    count: (sub) => { let n = 0, i = 0; while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length || 1; } return n; },
    startswith: (prefix, start, end) => s.slice(start || 0, end).startsWith(prefix),
    endswith: (suffix, start, end) => s.slice(start || 0, end).endsWith(suffix),
    format: (...args) => _strFormat(s, args),
    encode: (encoding) => new TextEncoder().encode(s),
    capitalize: () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
    title: () => s.replace(/\b\w/g, c => c.toUpperCase()),
    swapcase: () => [...s].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(''),
    isdigit: () => s.length > 0 && /^\d+$/.test(s),
    isalpha: () => s.length > 0 && /^[a-zA-Z]+$/.test(s),
    isalnum: () => s.length > 0 && /^[a-zA-Z0-9]+$/.test(s),
    isspace: () => s.length > 0 && /^\s+$/.test(s),
    isupper: () => s.length > 0 && s === s.toUpperCase() && s !== s.toLowerCase(),
    islower: () => s.length > 0 && s === s.toLowerCase() && s !== s.toUpperCase(),
    zfill: (width) => { const neg = s.startsWith('-'); const base = neg ? s.slice(1) : s; const padded = base.padStart(width - (neg ? 1 : 0), '0'); return neg ? '-' + padded : padded; },
    ljust: (width, fill) => s.padEnd(width, fill || ' '),
    rjust: (width, fill) => s.padStart(width, fill || ' '),
    center: (width, fill) => { const f = fill || ' '; const total = width - s.length; if (total <= 0) return s; const left = Math.floor(total / 2); return f.repeat(left) + s + f.repeat(total - left); },
    expandtabs: (tabsize) => s.replace(/\t/g, ' '.repeat(tabsize || 8)),
    partition: (sep) => { const i = s.indexOf(sep); return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]; },
    rpartition: (sep) => { const i = s.lastIndexOf(sep); return i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)]; },
    removeprefix: (prefix) => s.startsWith(prefix) ? s.slice(prefix.length) : s,
    removesuffix: (suffix) => s.endsWith(suffix) ? s.slice(0, -suffix.length || s.length) : s,
    splitlines: (keepends) => s.split(/\r?\n|\r/).map((l, i, a) => keepends && i < a.length - 1 ? l + '\n' : l),
    maketrans: () => { throw new AdderError('NotImplementedError', 'str.maketrans is not supported'); },
    translate: () => { throw new AdderError('NotImplementedError', 'str.translate is not supported'); },
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `str.${attr}`; return fn; }
  throw new AdderError('AttributeError', `'str' object has no attribute '${attr}'`);
}

function _stripChars(s, chars) { const cs = new Set(chars); let l = 0, r = s.length; while (l < r && cs.has(s[l])) l++; while (r > l && cs.has(s[r - 1])) r--; return s.slice(l, r); }
function _lstripChars(s, chars) { const cs = new Set(chars); let l = 0; while (l < s.length && cs.has(s[l])) l++; return s.slice(l); }
function _rstripChars(s, chars) { const cs = new Set(chars); let r = s.length; while (r > 0 && cs.has(s[r - 1])) r--; return s.slice(0, r); }

function _strFormat(s, args) {
  let ai = 0;
  return s.replace(/\{([^}]*)\}/g, (_, spec) => {
    let key, fmt;
    const ci = spec.indexOf(':');
    if (ci >= 0) { key = spec.slice(0, ci); fmt = spec.slice(ci + 1); }
    else { key = spec; fmt = ''; }
    let val;
    if (key === '' || key === undefined) val = args[ai++];
    else if (/^\d+$/.test(key)) val = args[parseInt(key)];
    else val = args[0]?.[key];
    return fmt ? pyFormatValue(val, fmt) : pyStr(val);
  });
}

function _listMethod(arr, attr) {
  const m = {
    append: (v) => { arr.push(v); return null; },
    extend: (iterable) => { for (const v of pyIter(iterable)) arr.push(v); return null; },
    insert: (i, v) => { arr.splice(i < 0 ? Math.max(0, arr.length + i) : i, 0, v); return null; },
    remove: (v) => { const i = arr.indexOf(v); if (i < 0) throw new AdderError('ValueError', 'list.remove(x): x not in list'); arr.splice(i, 1); return null; },
    pop: (i) => { if (arr.length === 0) throw new AdderError('IndexError', 'pop from empty list'); return i === undefined ? arr.pop() : arr.splice(i < 0 ? arr.length + i : i, 1)[0]; },
    clear: () => { arr.length = 0; return null; },
    index: (v, start, end) => { const i = arr.indexOf(v, start || 0); if (i < 0 || (end !== undefined && i >= end)) throw new AdderError('ValueError', `${pyRepr(v)} is not in list`); return i; },
    count: (v) => arr.filter(x => x === v).length,
    sort: (key, reverse) => { if (key) { const keyed = arr.map((v, i) => [key(v), i, v]); keyed.sort((a, b) => _pyCompare(a[0], b[0])); const sorted = keyed.map(x => x[2]); arr.length = 0; arr.push(...(reverse ? sorted.reverse() : sorted)); } else { arr.sort((a, b) => _pyCompare(a, b)); if (reverse) arr.reverse(); } return null; },
    reverse: () => { arr.reverse(); return null; },
    copy: () => [...arr],
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `list.${attr}`; return fn; }
  throw new AdderError('AttributeError', `'list' object has no attribute '${attr}'`);
}

function _mapMethod(map, attr) {
  const m = {
    keys: () => [...map.keys()],
    values: () => [...map.values()],
    items: () => [...map.entries()],
    get: (k, def) => map.has(k) ? map.get(k) : (def !== undefined ? def : null),
    pop: (k, def) => { if (map.has(k)) { const v = map.get(k); map.delete(k); return v; } if (def !== undefined) return def; throw new AdderError('KeyError', pyRepr(k)); },
    setdefault: (k, def) => { if (map.has(k)) return map.get(k); const v = def !== undefined ? def : null; map.set(k, v); return v; },
    update: (other) => { if (other instanceof Map) { for (const [k, v] of other) map.set(k, v); } else if (typeof other === 'object') { for (const k of Object.keys(other)) map.set(k, other[k]); } return null; },
    clear: () => { map.clear(); return null; },
    copy: () => new Map(map),
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `dict.${attr}`; return fn; }
  if (attr === 'size') return map.size;
  throw new AdderError('AttributeError', `'dict' object has no attribute '${attr}'`);
}

const _objDictMethods = {
  keys: (obj) => { const fn = () => Object.keys(obj); fn._pyName = 'dict.keys'; return fn; },
  values: (obj) => { const fn = () => Object.values(obj); fn._pyName = 'dict.values'; return fn; },
  items: (obj) => { const fn = () => Object.entries(obj); fn._pyName = 'dict.items'; return fn; },
  get: (obj) => { const fn = (k, def) => k in obj ? obj[k] : (def !== undefined ? def : null); fn._pyName = 'dict.get'; return fn; },
  pop: (obj) => { const fn = (k, def) => { if (k in obj) { const v = obj[k]; delete obj[k]; return v; } if (def !== undefined) return def; throw new AdderError('KeyError', pyRepr(k)); }; fn._pyName = 'dict.pop'; return fn; },
  setdefault: (obj) => { const fn = (k, def) => { if (k in obj) return obj[k]; obj[k] = def !== undefined ? def : null; return obj[k]; }; fn._pyName = 'dict.setdefault'; return fn; },
  update: (obj) => { const fn = (other) => { if (other instanceof Map) { for (const [k, v] of other) obj[k] = v; } else if (typeof other === 'object') Object.assign(obj, other); return null; }; fn._pyName = 'dict.update'; return fn; },
  clear: (obj) => { const fn = () => { for (const k of Object.keys(obj)) delete obj[k]; return null; }; fn._pyName = 'dict.clear'; return fn; },
  copy: (obj) => { const fn = () => ({ ...obj }); fn._pyName = 'dict.copy'; return fn; },
};

function _setMethod(set, attr) {
  const m = {
    add: (v) => { set.add(v); return null; },
    remove: (v) => { if (!set.has(v)) throw new AdderError('KeyError', pyRepr(v)); set.delete(v); return null; },
    discard: (v) => { set.delete(v); return null; },
    pop: () => { if (set.size === 0) throw new AdderError('KeyError', 'pop from an empty set'); const v = set.values().next().value; set.delete(v); return v; },
    clear: () => { set.clear(); return null; },
    union: (...others) => { const r = new Set(set); for (const o of others) for (const v of pyIter(o)) r.add(v); return r; },
    intersection: (...others) => { const r = new Set(); for (const v of set) { if (others.every(o => { const s = o instanceof Set ? o : new Set(pyIter(o)); return s.has(v); })) r.add(v); } return r; },
    difference: (...others) => { const r = new Set(set); for (const o of others) for (const v of pyIter(o)) r.delete(v); return r; },
    symmetric_difference: (other) => { const r = new Set(set); for (const v of pyIter(other)) { if (r.has(v)) r.delete(v); else r.add(v); } return r; },
    update: (...others) => { for (const o of others) for (const v of pyIter(o)) set.add(v); return null; },
    issubset: (other) => { const o = other instanceof Set ? other : new Set(pyIter(other)); for (const v of set) if (!o.has(v)) return false; return true; },
    issuperset: (other) => { for (const v of pyIter(other)) if (!set.has(v)) return false; return true; },
    copy: () => new Set(set),
  };
  if (attr in m) { const fn = m[attr]; fn._pyName = `set.${attr}`; return fn; }
  throw new AdderError('AttributeError', `'set' object has no attribute '${attr}'`);
}

function _pyCompare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ── modules ──

const _mathModule = {
  pi: Math.PI, e: Math.E, tau: Math.PI * 2, inf: Infinity, nan: NaN,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
  pow: Math.pow, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc,
  fabs: Math.abs, copysign: (x, y) => Math.sign(y) * Math.abs(x),
  isnan: Number.isNaN, isinf: (x) => !isFinite(x) && !isNaN(x), isfinite: Number.isFinite,
  radians: (d) => d * Math.PI / 180, degrees: (r) => r * 180 / Math.PI,
  factorial: (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
  gcd: (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; },
  comb: (n, k) => { if (k < 0 || k > n) return 0; if (k === 0 || k === n) return 1; let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); },
  perm: (n, k) => { if (k === undefined) k = n; let r = 1; for (let i = 0; i < k; i++) r *= (n - i); return r; },
  hypot: Math.hypot,
  fsum: (iterable) => { let s = 0; for (const v of pyIter(iterable)) s += v; return s; },
  prod: (iterable, start) => { let r = start !== undefined ? start : 1; for (const v of pyIter(iterable)) r *= v; return r; },
  fmod: (x, y) => x % y,
  remainder: (x, y) => x - Math.round(x / y) * y,
  ldexp: (x, i) => x * Math.pow(2, i),
  frexp: (x) => { if (x === 0) return [0, 0]; const e = Math.ceil(Math.log2(Math.abs(x))); return [x / Math.pow(2, e), e]; },
  modf: (x) => { const i = Math.trunc(x); return [x - i, i]; },
};

const _jsonModule = {
  dumps: (obj, indent) => {
    const replacer = (k, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      return v;
    };
    return JSON.stringify(obj, replacer, indent);
  },
  loads: (s) => JSON.parse(s),
};

const _jsModule = new Proxy({}, {
  get(_, prop) { return typeof globalThis !== 'undefined' ? globalThis[prop] : undefined; },
  has(_, prop) { return typeof globalThis !== 'undefined' && prop in globalThis; },
});

const _randomState = { s: [1, 2, 3, 4] };
function _xoshiro128() {
  const s = _randomState.s;
  const result = (s[0] + s[3]) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
  s[2] ^= t; s[3] = (s[3] << 11) | (s[3] >>> 21);
  return result / 4294967296;
}

const _randomModule = {
  random: () => _xoshiro128(),
  seed: (n) => { n = n >>> 0; _randomState.s = [n, n ^ 0x12345678, n ^ 0x9ABCDEF0, n ^ 0xFEDCBA98]; },
  randint: (a, b) => a + Math.floor(_xoshiro128() * (b - a + 1)),
  uniform: (a, b) => a + _xoshiro128() * (b - a),
  choice: (seq) => { const arr = Array.isArray(seq) ? seq : [...pyIter(seq)]; return arr[Math.floor(_xoshiro128() * arr.length)]; },
  shuffle: (lst) => { for (let i = lst.length - 1; i > 0; i--) { const j = Math.floor(_xoshiro128() * (i + 1)); [lst[i], lst[j]] = [lst[j], lst[i]]; } return null; },
  gauss: (mu, sigma) => {
    let u, v, s;
    do { u = 2 * _xoshiro128() - 1; v = 2 * _xoshiro128() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    return mu + sigma * u * Math.sqrt(-2 * Math.log(s) / s);
  },
  sample: (population, k) => {
    const arr = Array.isArray(population) ? [...population] : [...pyIter(population)];
    const result = [];
    for (let i = 0; i < k; i++) { const j = Math.floor(_xoshiro128() * arr.length); result.push(arr.splice(j, 1)[0]); }
    return result;
  },
};

// ── itertools ──

const _itertoolsModule = {
  chain: (...iterables) => {
    const result = [];
    for (const it of iterables) for (const v of pyIter(it)) result.push(v);
    return result;
  },
  product: (...iterables) => {
    const arrs = iterables.map(it => [...pyIter(it)]);
    if (arrs.length === 0) return [[]];
    const result = [];
    const indices = arrs.map(() => 0);
    while (true) {
      result.push(indices.map((idx, i) => arrs[i][idx]));
      let i = arrs.length - 1;
      while (i >= 0) { indices[i]++; if (indices[i] < arrs[i].length) break; indices[i] = 0; i--; }
      if (i < 0) break;
    }
    return result;
  },
  combinations: (iterable, r) => {
    const pool = [...pyIter(iterable)];
    const n = pool.length;
    if (r > n) return [];
    const result = [];
    const indices = Array.from({ length: r }, (_, i) => i);
    result.push(indices.map(i => pool[i]));
    while (true) {
      let i = r - 1;
      while (i >= 0 && indices[i] === i + n - r) i--;
      if (i < 0) break;
      indices[i]++;
      for (let j = i + 1; j < r; j++) indices[j] = indices[j - 1] + 1;
      result.push(indices.map(i => pool[i]));
    }
    return result;
  },
  permutations: (iterable, r) => {
    const pool = [...pyIter(iterable)];
    const n = pool.length;
    r = r !== undefined ? r : n;
    if (r > n) return [];
    const result = [];
    const indices = Array.from({ length: n }, (_, i) => i);
    const cycles = Array.from({ length: r }, (_, i) => n - i);
    result.push(indices.slice(0, r).map(i => pool[i]));
    while (true) {
      let found = false;
      for (let i = r - 1; i >= 0; i--) {
        cycles[i]--;
        if (cycles[i] === 0) {
          indices.push(indices.splice(i, 1)[0]);
          cycles[i] = n - i;
        } else {
          const j = indices.length - cycles[i];
          [indices[i], indices[j]] = [indices[j], indices[i]];
          result.push(indices.slice(0, r).map(i => pool[i]));
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return result;
  },
  repeat: (value, times) => {
    if (times === undefined) { const a = []; for (let i = 0; i < 1000; i++) a.push(value); return a; } // capped
    const result = []; for (let i = 0; i < times; i++) result.push(value); return result;
  },
  accumulate: (iterable, func) => {
    const arr = [...pyIter(iterable)];
    if (arr.length === 0) return [];
    const result = [arr[0]];
    for (let i = 1; i < arr.length; i++) result.push(func ? func(result[i - 1], arr[i]) : result[i - 1] + arr[i]);
    return result;
  },
  starmap: (func, iterable) => [...pyIter(iterable)].map(args => func(...args)),
  islice: (iterable, ...args) => {
    let start = 0, stop, step = 1;
    if (args.length === 1) { stop = args[0]; }
    else if (args.length === 2) { start = args[0]; stop = args[1]; }
    else { start = args[0]; stop = args[1]; step = args[2] || 1; }
    const result = [];
    let i = 0;
    for (const v of pyIter(iterable)) {
      if (i >= stop) break;
      if (i >= start && (i - start) % step === 0) result.push(v);
      i++;
    }
    return result;
  },
  zip_longest: (...args) => {
    let fillvalue = null;
    if (args.length > 0 && args[args.length - 1]?._kw) { fillvalue = args.pop().fillvalue ?? null; }
    const arrs = args.map(it => [...pyIter(it)]);
    const maxLen = Math.max(...arrs.map(a => a.length));
    const result = [];
    for (let i = 0; i < maxLen; i++) result.push(arrs.map(a => i < a.length ? a[i] : fillvalue));
    return result;
  },
  groupby: (iterable, key) => {
    const arr = [...pyIter(iterable)];
    const result = [];
    let currentKey = undefined, currentGroup = [];
    for (const item of arr) {
      const k = key ? key(item) : item;
      if (result.length === 0 || k !== currentKey) {
        if (currentGroup.length > 0) result.push([currentKey, currentGroup]);
        currentKey = k; currentGroup = [item];
      } else { currentGroup.push(item); }
    }
    if (currentGroup.length > 0) result.push([currentKey, currentGroup]);
    return result;
  },
};

// ── functools ──

const _functoolsModule = {
  reduce: (func, iterable, initial) => {
    const arr = [...pyIter(iterable)];
    if (initial !== undefined) return arr.reduce((a, b) => func(a, b), initial);
    if (arr.length === 0) throw new AdderError('TypeError', 'reduce() of empty iterable with no initial value');
    return arr.reduce((a, b) => func(a, b));
  },
  partial: (func, ...partialArgs) => {
    const wrapped = (...args) => func(...partialArgs, ...args);
    wrapped._pyName = `partial(${func._pyName || func.name || '?'})`;
    return wrapped;
  },
  lru_cache: (fn) => {
    const cache = new Map();
    const wrapped = (...args) => {
      const key = JSON.stringify(args);
      if (cache.has(key)) return cache.get(key);
      const result = fn(...args);
      cache.set(key, result);
      return result;
    };
    wrapped.cache_clear = () => cache.clear();
    wrapped._pyName = fn._pyName || fn.name;
    return wrapped;
  },
};

// ── collections ──

const _collectionsModule = {
  OrderedDict: (items) => {
    // JS Map preserves insertion order
    if (!items) return new Map();
    return new Map(Array.isArray(items) ? items : Object.entries(items));
  },
  defaultdict: (factory, items) => {
    const map = new Map();
    if (items) { for (const [k, v] of (Array.isArray(items) ? items : Object.entries(items))) map.set(k, v); }
    return new Proxy(map, {
      get(target, prop) {
        if (prop === 'get' || prop === 'has' || prop === 'set' || prop === 'delete' || prop === 'size' || prop === 'keys' || prop === 'values' || prop === 'items' || prop === 'clear' || prop === 'entries' || typeof prop === 'symbol') return Reflect.get(target, prop);
        if (!target.has(prop)) target.set(prop, factory());
        return target.get(prop);
      },
    });
  },
  Counter: (iterable) => {
    const counts = {};
    if (iterable) { for (const v of pyIter(iterable)) counts[v] = (counts[v] || 0) + 1; }
    counts.most_common = (n) => {
      const entries = Object.entries(counts).filter(([k]) => k !== 'most_common' && k !== 'elements' && k !== 'update');
      entries.sort((a, b) => b[1] - a[1]);
      return n !== undefined ? entries.slice(0, n) : entries;
    };
    counts.update = (iterable) => { for (const v of pyIter(iterable)) counts[v] = (counts[v] || 0) + 1; };
    return counts;
  },
  namedtuple: (name, fields) => {
    const fieldNames = typeof fields === 'string' ? fields.split(/[\s,]+/).filter(Boolean) : [...fields];
    return (...args) => {
      const obj = {};
      for (let i = 0; i < fieldNames.length; i++) obj[fieldNames[i]] = args[i];
      obj.__adderClass__ = name;
      obj.__repr__ = () => `${name}(${fieldNames.map(f => `${f}=${pyRepr(obj[f])}`).join(', ')})`;
      return obj;
    };
  },
};

// ── re (regex) ──

const _reModule = {
  match: (pattern, string) => { const m = string.match(new RegExp(pattern)); return m ? _reMatch(m) : null; },
  search: (pattern, string) => { const m = string.match(new RegExp(pattern)); return m ? _reMatch(m) : null; },
  findall: (pattern, string) => { const re = new RegExp(pattern, 'g'); const r = []; let m; while ((m = re.exec(string))) r.push(m[1] !== undefined ? m[1] : m[0]); return r; },
  sub: (pattern, repl, string, count) => {
    if (count !== undefined && count > 0) {
      let n = 0;
      return string.replace(new RegExp(pattern, 'g'), (m) => n++ < count ? (typeof repl === 'function' ? repl(_reMatch([m])) : repl) : m);
    }
    return string.replace(new RegExp(pattern, 'g'), typeof repl === 'function' ? (m) => repl(_reMatch([m])) : repl);
  },
  split: (pattern, string, maxsplit) => {
    if (maxsplit !== undefined) {
      const parts = []; let rest = string;
      for (let i = 0; i < maxsplit; i++) {
        const m = rest.match(new RegExp(pattern));
        if (!m) break;
        parts.push(rest.slice(0, m.index));
        rest = rest.slice(m.index + m[0].length);
      }
      parts.push(rest);
      return parts;
    }
    return string.split(new RegExp(pattern));
  },
  compile: (pattern) => {
    const re = new RegExp(pattern, 'g');
    return {
      match: (s) => { re.lastIndex = 0; const m = re.exec(s); return m && m.index === 0 ? _reMatch(m) : null; },
      search: (s) => { re.lastIndex = 0; const m = re.exec(s); return m ? _reMatch(m) : null; },
      findall: (s) => { re.lastIndex = 0; const r = []; let m; while ((m = re.exec(s))) r.push(m[1] !== undefined ? m[1] : m[0]); return r; },
      sub: (repl, s) => s.replace(new RegExp(pattern, 'g'), repl),
      split: (s) => s.split(new RegExp(pattern)),
    };
  },
  escape: (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  IGNORECASE: 'i', I: 'i',
  MULTILINE: 'm', M: 'm',
  DOTALL: 's', S: 's',
};

function _reMatch(m) {
  return {
    group: (n) => n === undefined ? m[0] : m[n],
    groups: () => m.slice(1),
    start: () => m.index,
    end: () => m.index + m[0].length,
    span: () => [m.index, m.index + m[0].length],
    string: m.input,
    0: m[0],
  };
}

// ── string module ──

const _stringModule = {
  ascii_lowercase: 'abcdefghijklmnopqrstuvwxyz',
  ascii_uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ascii_letters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  hexdigits: '0123456789abcdefABCDEF',
  octdigits: '01234567',
  punctuation: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  whitespace: ' \t\n\r\x0b\x0c',
};

// ── this ──

const _thisModule = {
  s: `The Zen of Python, by Tim Peters

Beautiful is better than ugly.
Explicit is better than implicit.
Simple is better than complex.
Complex is better than complicated.
Flat is better than nested.
Sparse is better than dense.
Readability counts.
Special cases aren't special enough to break the rules.
Although practicality beats purity.
Errors should never pass silently.
Unless explicitly silenced.
In the face of ambiguity, refuse the temptation to guess.
There should be one-- and preferably only one --obvious way to do it.
Although that way may not be obvious at first unless you're Dutch.
Now is better than never.
Although never is often better than *right* now.
If the implementation is hard to explain, it's a bad idea.
If the implementation is easy to explain, it may be a good idea.
Namespaces are one honking great idea -- let's do more of those!`,
};
_thisModule.print = () => _thisModule.s;
_thisModule.gcu = `We set sail on this new stack because there is new knowledge to be gained, and new tools to be built, and they must be built and shared for the progress of all practitioners. For computational science, like geostatistics and all technology, has no conscience of its own. Whether it will become a force for good or ill depends on us, and only if we occupy a position of independence can we help decide whether this new ocean will be a sea of openness or a new terrifying theater of languages that forgot what they were for.

I do not say that we should or will go without the tools that others have built, any more than we go without the knowledge that others have shared, but I do say that geostatistics can be explored and mastered without feeding the fires of flamewar, without repeating the mistakes that man has made in extending his writ around this globe of ours.

There is no strife, no prejudice, no conflict of interest in a file that contains its own source. Its hazards are hostile to us all. Its conquest deserves the best of all practitioners, and its opportunity for open cooperation may never come again.

But why, some say, JavaScript? Why choose this as our language? And they may well ask, why climb the highest mountain? Why, thirty-four years after Deutsch and Journel, rewrite the FORTRAN? Why does Rice play Texas?

We choose to write JavaScript. We choose to write JavaScript... We choose to write JavaScript in this decade and do the other things, not because it is good, but because it is bad; because that goal will serve to organize and measure the best of our energies and skills, because that challenge is one that we are willing to accept, one we are unwilling to postpone, and one we intend to ship, and the others, too.`;

// ── shared cwd + path resolution ──

const _cwd = { value: '/home/nb' };
const _HOME = '/home/nb';

// Expand ~ and resolve relative paths against cwd. Used by open(), Path(), os._resolve().
function _resolvePath(p, pth) {
  if (!p || p === '.') return _cwd.value;
  // ~ expansion
  if (p === '~') return _HOME;
  if (p.startsWith('~/')) p = _HOME + p.slice(1);
  if (pth && !pth.isAbsolute(p)) return pth.join(_cwd.value, p);
  if (pth) return pth.normalize(p);
  // fallback without path utils: just basic join
  if (p.startsWith('/')) return p;
  return _cwd.value + ((_cwd.value === '/') ? '' : '/') + p;
}

// ── sys module ──

const _sysModule = {
  version: '3.12.0 (adder)',
  version_info: [3, 12, 0, 'adder', 0],
  platform: 'auditable',
  maxsize: Number.MAX_SAFE_INTEGER,
  path: ['.', 'lib', '/usr/lib/python'],
  modules: {},
  argv: [''],
  exit: (code) => { throw new AdderError('SystemExit', String(code ?? 0)); },
  stdout: { write(s) { return String(s).length; }, flush() {}, encoding: 'utf-8' },
  stderr: { write(s) { return String(s).length; }, flush() {}, encoding: 'utf-8' },
  getsizeof: () => 0,
  getrecursionlimit: () => 1000,
  setrecursionlimit: () => null,
  executable: '',
  prefix: '/usr',
  exec_prefix: '/usr',
  get home() { return _HOME; },
};

const adderModules = {
  math: _mathModule, json: _jsonModule, js: _jsModule, random: _randomModule,
  itertools: _itertoolsModule, functools: _functoolsModule,
  collections: _collectionsModule, re: _reModule, string: _stringModule,
  this: _thisModule, sys: _sysModule,
};

// ── filesystem exception hierarchy ──

const _excParents = {
  FileNotFoundError: 'OSError', FileExistsError: 'OSError',
  IsADirectoryError: 'OSError', NotADirectoryError: 'OSError',
  PermissionError: 'OSError', IOError: 'OSError',
};

function _mapVFSError(e) {
  const map = { ENOENT: 'FileNotFoundError', EEXIST: 'FileExistsError',
    EISDIR: 'IsADirectoryError', ENOTDIR: 'NotADirectoryError', EACCES: 'PermissionError' };
  return new AdderError(map[e?.code] || 'OSError', e?.message || String(e));
}

// ── file object ──

async function _createAdderFile(vfs, filePath, mode) {
  const isBinary = mode.includes('b');
  const isRead = mode[0] === 'r';
  const isAppend = mode[0] === 'a';

  let _content = null, _buffer = isBinary ? [] : '', _pos = 0, _closed = false;

  if (isRead || isAppend) {
    try {
      _content = await vfs.readFile(filePath, isBinary ? 'bytes' : undefined);
      if (isAppend) _buffer = isBinary ? [_content] : _content;
    } catch (e) {
      if (isRead) throw _mapVFSError(e);
      _content = isBinary ? new Uint8Array(0) : '';
    }
  }

  const f = {
    _path: filePath, _mode: mode,
    __adderClass__: isBinary ? 'BufferedIOBase' : 'TextIOWrapper',

    read(size) {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (!isRead) throw new AdderError('IOError', 'not readable');
      if (size != null) { const chunk = _content.slice(_pos, _pos + size); _pos += size; return chunk; }
      const rest = _content.slice(_pos);
      _pos = typeof _content === 'string' ? _content.length : _content.byteLength;
      return rest;
    },

    readline() {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (!isRead) throw new AdderError('IOError', 'not readable');
      if (typeof _content !== 'string') throw new AdderError('IOError', 'readline on binary file');
      const nl = _content.indexOf('\n', _pos);
      if (nl === -1) { const line = _content.slice(_pos); _pos = _content.length; return line; }
      const line = _content.slice(_pos, nl + 1);
      _pos = nl + 1;
      return line;
    },

    readlines() {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (!isRead) throw new AdderError('IOError', 'not readable');
      const lines = [];
      const len = typeof _content === 'string' ? _content.length : _content.byteLength;
      while (_pos < len) lines.push(f.readline());
      return lines;
    },

    write(data) {
      if (_closed) throw new AdderError('ValueError', 'I/O operation on closed file');
      if (isRead) throw new AdderError('IOError', 'not writable');
      if (isBinary) {
        const chunk = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
        _buffer.push(chunk);
        return chunk.byteLength;
      }
      const s = String(data);
      _buffer += s;
      return s.length;
    },

    writelines(lines) { for (const line of pyIter(lines)) f.write(line); return null; },

    async close() {
      if (_closed) return;
      _closed = true;
      if (!isRead) {
        try {
          if (isBinary) {
            const total = _buffer.reduce((s, b) => s + b.byteLength, 0);
            const result = new Uint8Array(total);
            let off = 0;
            for (const b of _buffer) { result.set(b, off); off += b.byteLength; }
            await vfs.writeFile(filePath, result);
          } else {
            await vfs.writeFile(filePath, _buffer);
          }
        } catch (e) { throw _mapVFSError(e); }
      }
    },

    __enter__() { return f; },
    async __exit__() { await f.close(); return false; },
    __repr__() { return `<_io.${isBinary ? 'BufferedWriter' : 'TextIOWrapper'} name='${filePath}' mode='${mode}'>`; },
    __str__() { return f.__repr__(); },
    __bool__() { return true; },

    [Symbol.iterator]() {
      if (!isRead) throw new AdderError('IOError', 'not readable');
      let iterPos = _pos;
      const content = _content;
      return {
        next() {
          const len = typeof content === 'string' ? content.length : content.byteLength;
          if (iterPos >= len) return { done: true };
          if (typeof content !== 'string') {
            const rest = content.slice(iterPos);
            iterPos = content.byteLength;
            return { value: rest, done: false };
          }
          const nl = content.indexOf('\n', iterPos);
          if (nl === -1) {
            const line = content.slice(iterPos);
            iterPos = content.length;
            return line ? { value: line, done: false } : { done: true };
          }
          const line = content.slice(iterPos, nl + 1);
          iterPos = nl + 1;
          return { value: line, done: false };
        }
      };
    },

    get name() { return filePath; },
    get closed() { return _closed; },
  };

  return f;
}

// ── os module ──

function _createOsModule(getVfs, pth) {
  const _resolve = (p) => _resolvePath(p, pth);

  const osPath = {
    join: (...parts) => pth.join(...parts),
    dirname: (p) => pth.dirname(p),
    basename: (p) => pth.basename(p),
    splitext: (p) => { const ext = pth.extname(p); return ext ? [p.slice(0, -ext.length), ext] : [p, '']; },
    normpath: (p) => pth.normalize(p),
    relpath: (p, start) => pth.relative(start || _cwd.value, p),
    isabs: (p) => pth.isAbsolute(p),
    exists: async (p) => { try { await getVfs().stat(_resolve(p)); return true; } catch { return false; } },
    isfile: async (p) => { try { return (await getVfs().stat(_resolve(p))).type === 'file'; } catch { return false; } },
    isdir: async (p) => { try { return (await getVfs().stat(_resolve(p))).type === 'directory'; } catch { return false; } },
    getsize: async (p) => { try { return (await getVfs().stat(_resolve(p))).size; } catch (e) { throw _mapVFSError(e); } },
    sep: '/',
  };

  const os = {
    sep: '/', linesep: '\n', name: 'posix',
    path: osPath,

    listdir: async (p) => {
      try { return await getVfs().readdir(_resolve(p || '.')); }
      catch (e) { throw _mapVFSError(e); }
    },
    mkdir: async (p) => {
      try { await getVfs().mkdir(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    makedirs: async (p, exist_ok) => {
      if (exist_ok != null && typeof exist_ok === 'object' && exist_ok._kw) exist_ok = exist_ok.exist_ok;
      const resolved = _resolve(p);
      const vfs = getVfs();
      let exists = false;
      try { await vfs.stat(resolved); exists = true; } catch {}
      if (exists && !exist_ok) throw new AdderError('FileExistsError', resolved);
      if (!exists) {
        try { await vfs.mkdir(resolved, { recursive: true }); }
        catch (e) { throw _mapVFSError(e); }
      }
    },
    remove: async (p) => {
      try { await getVfs().unlink(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    unlink: async (p) => {
      try { await getVfs().unlink(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    rmdir: async (p) => {
      try { await getVfs().rmdir(_resolve(p)); }
      catch (e) { throw _mapVFSError(e); }
    },
    rename: async (src, dst) => {
      try { await getVfs().rename(_resolve(src), _resolve(dst)); }
      catch (e) { throw _mapVFSError(e); }
    },
    stat: async (p) => {
      try {
        const info = await getVfs().stat(_resolve(p));
        return { st_size: info.size, st_mtime: info.modified?.getTime() / 1000 || 0,
                 st_mode: info.mode || 0, st_type: info.type };
      } catch (e) { throw _mapVFSError(e); }
    },
    getcwd: () => _cwd.value,
    chdir: (p) => { _cwd.value = _resolve(p); },

    walk: (top) => {
      const resolved = _resolve(top || '.');
      const vfs = getVfs();
      async function* gen(dir) {
        let entries;
        try { entries = await vfs.readdir(dir); } catch { return; }
        const dirs = [], files = [];
        for (const name of entries) {
          const full = dir === '/' ? '/' + name : dir + '/' + name;
          try {
            const info = await vfs.stat(full);
            if (info.type === 'directory') dirs.push(name);
            else files.push(name);
          } catch { files.push(name); }
        }
        yield [dir, dirs, files];
        for (const d of dirs) {
          yield* gen(dir === '/' ? '/' + d : dir + '/' + d);
        }
      }
      return { [Symbol.asyncIterator]() { return gen(resolved); } };
    },
  };

  return os;
}

// ── pathlib module ──

function _createPathClass(getVfs, pth) {
  function _Path(p) {
    if (typeof p === 'object' && p?._path) return p;
    let raw = String(p || '.');
    // expand ~ but don't resolve relative paths (pathlib keeps them relative)
    if (raw === '~') raw = _HOME;
    else if (raw.startsWith('~/')) raw = _HOME + raw.slice(1);
    const _p = pth.normalize(raw);
    // resolve for I/O — relative paths against cwd
    const _abs = () => pth.isAbsolute(_p) ? _p : pth.join(_cwd.value, _p);
    return {
      _path: _p,
      __adderClass__: 'PosixPath',
      get name() { return pth.basename(_p); },
      get stem() { const b = pth.basename(_p); const ext = pth.extname(_p); return ext ? b.slice(0, -ext.length) : b; },
      get suffix() { return pth.extname(_p); },
      get parent() { return _Path(pth.dirname(_p)); },
      get parts() { return _p === '/' ? ['/'] : ['/', ..._p.split('/').filter(Boolean)]; },

      __truediv__(other) { return _Path(pth.join(_p, String(other?._path || other))); },
      __str__() { return _p; },
      __repr__() { return `PosixPath('${_p}')`; },
      __eq__(other) { return _p === (other?._path || String(other)); },
      __hash__() { let h = 0; for (let i = 0; i < _p.length; i++) h = (h * 31 + _p.charCodeAt(i)) | 0; return h; },

      joinpath(...parts) { return _Path(pth.join(_p, ...parts.map(x => x?._path || String(x)))); },
      with_suffix(s) { const ext = pth.extname(_p); const base = ext ? _p.slice(0, -ext.length) : _p; return _Path(base + s); },
      with_name(n) { return _Path(pth.join(pth.dirname(_p), n)); },

      async read_text() { try { return await getVfs().readFile(_abs()); } catch (e) { throw _mapVFSError(e); } },
      async read_bytes() { try { return await getVfs().readFile(_abs(), 'bytes'); } catch (e) { throw _mapVFSError(e); } },
      async write_text(data) { try { await getVfs().writeFile(_abs(), String(data)); } catch (e) { throw _mapVFSError(e); } },
      async write_bytes(data) { try { await getVfs().writeFile(_abs(), data); } catch (e) { throw _mapVFSError(e); } },
      async exists() { return getVfs().exists(_abs()); },
      async is_file() { try { return (await getVfs().stat(_abs())).type === 'file'; } catch { return false; } },
      async is_dir() { try { return (await getVfs().stat(_abs())).type === 'directory'; } catch { return false; } },
      async mkdir(parents, exist_ok) {
        if (parents != null && typeof parents === 'object' && parents._kw) { exist_ok = parents.exist_ok; parents = parents.parents; }
        try { await getVfs().mkdir(_abs(), { recursive: !!parents }); }
        catch (e) { if (exist_ok && e?.code === 'EEXIST') return; throw _mapVFSError(e); }
      },
      async unlink() { try { await getVfs().unlink(_abs()); } catch (e) { throw _mapVFSError(e); } },
      async rename(target) { const t = target?._path || String(target); const ta = pth.isAbsolute(t) ? t : pth.join(_cwd.value, t); try { await getVfs().rename(_abs(), ta); return _Path(t); } catch (e) { throw _mapVFSError(e); } },
      async iterdir() {
        try {
          const entries = await getVfs().readdir(_abs());
          return entries.map(name => _Path(pth.join(_p, name)));
        } catch (e) { throw _mapVFSError(e); }
      },
      async glob(pattern) {
        try { return await getVfs().glob(pth.join(_abs(), pattern)); }
        catch (e) { throw _mapVFSError(e); }
      },
      async touch() { try { await getVfs().touch(_abs()); } catch (e) { throw _mapVFSError(e); } },
      async stat() {
        try {
          const info = await getVfs().stat(_abs());
          return { st_size: info.size, st_mtime: info.modified?.getTime() / 1000 || 0, st_mode: info.mode || 0, st_type: info.type };
        } catch (e) { throw _mapVFSError(e); }
      },
    };
  }
  return _Path;
}

// ── shutil module ──

function _createShutilModule(getVfs) {
  return {
    copy: async (src, dst) => { try { await getVfs().cp(src, dst); } catch (e) { throw _mapVFSError(e); } },
    copy2: async (src, dst) => { try { await getVfs().cp(src, dst); } catch (e) { throw _mapVFSError(e); } },
    copytree: async (src, dst) => { try { await getVfs().cp(src, dst, { recursive: true }); } catch (e) { throw _mapVFSError(e); } },
    rmtree: async (p) => { try { await getVfs().rm(p, { recursive: true }); } catch (e) { throw _mapVFSError(e); } },
    move: async (src, dst) => { try { await getVfs().rename(src, dst); } catch (e) { throw _mapVFSError(e); } },
  };
}

// ── glob module ──

function _createGlobModule(getVfs) {
  return {
    glob: async (pattern) => { try { return await getVfs().glob(pattern); } catch (e) { throw _mapVFSError(e); } },
  };
}

// ── fs module registration ──

let _adderVFS = null;
let _vfsPath = null;

function getAdderVFS() { return _adderVFS; }
function _getVfsPath() { return _vfsPath; }

function setAdderVFS(vfsInstance, pathUtils) {
  _adderVFS = vfsInstance;
  if (pathUtils) _vfsPath = pathUtils;
  // reset cwd and module cache for the new VFS
  _cwd.value = _HOME;
  for (const k of Object.keys(_sysModule.modules)) delete _sysModule.modules[k];
  // re-register modules if path available (allows calling setAdderVFS after initial load)
  if (_vfsPath) {
    delete adderModules.os;
    _ensureFsModules();
  }
}

function _ensureFsModules(pathUtils) {
  if (adderModules.os) return;
  if (pathUtils) _vfsPath = pathUtils;
  if (!_vfsPath) {
    try { if (typeof path !== 'undefined' && path.join) _vfsPath = path; } catch {}
  }
  if (!_vfsPath) return;

  const pth = _vfsPath;
  const getVfs = () => {
    if (!_adderVFS) throw new AdderError('RuntimeError', 'filesystem not available — call adder.setVFS(vfsInstance, pathUtils) first');
    return _adderVFS;
  };

  adderModules.os = _createOsModule(getVfs, pth);
  adderModules['os.path'] = adderModules.os.path;
  adderModules.pathlib = { Path: _createPathClass(getVfs, pth) };
  adderModules.shutil = _createShutilModule(getVfs);
  adderModules.glob = _createGlobModule(getVfs);
}

// ── builtins ──

function adderBuiltins(printFn) {
  const builtins = {
    print: (...args) => {
      let sep = ' ', end = '\n';
      // handle keyword args passed as last object with _kw marker
      if (args.length > 0 && args[args.length - 1]?._kw) {
        const kw = args.pop();
        if (kw.sep !== undefined) sep = kw.sep;
        if (kw.end !== undefined) end = kw.end;
      }
      printFn(args.map(pyStr).join(sep) + end);
      return null;
    },
    len: (obj) => {
      if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) return obj.length;
      if (obj instanceof Map || obj instanceof Set) return obj.size;
      if (obj instanceof AdderRange) return obj.length;
      if (typeof obj === 'object' && obj !== null) {
        if (typeof obj.__len__ === 'function') return obj.__len__();
        if (typeof obj.length === 'number') return obj.length;
        return Object.keys(obj).length;
      }
      throw new AdderError('TypeError', `object of type '${pyTypeName(obj)}' has no len()`);
    },
    range: (a, b, c) => new AdderRange(a, b, c),
    int: (x, base) => { if (x === undefined) return 0; if (base !== undefined) { const n = parseInt(String(x), base); if (isNaN(n)) throw new AdderError('ValueError', `invalid literal for int() with base ${base}: ${pyRepr(String(x))}`); return n; } if (typeof x === 'string') { const n = parseInt(x); if (isNaN(n)) throw new AdderError('ValueError', `invalid literal for int() with base 10: ${pyRepr(x)}`); return n; } return Math.trunc(Number(x)); },
    float: (x) => { if (x === undefined) return 0.0; if (typeof x === 'string') { const s = x.trim().toLowerCase(); if (s === 'inf' || s === '+inf' || s === 'infinity') return Infinity; if (s === '-inf' || s === '-infinity') return -Infinity; if (s === 'nan') return NaN; if (s === '') throw new AdderError('ValueError', `could not convert string to float: ${pyRepr(x)}`); const n = Number(x); if (isNaN(n)) throw new AdderError('ValueError', `could not convert string to float: ${pyRepr(x)}`); return n; } return Number(x); },
    str: (x) => x === undefined ? '' : pyStr(x),
    bool: (x) => x === undefined ? false : pyBool(x),
    list: async (x) => x === undefined ? [] : await pyCollect(x),
    tuple: async (x) => x === undefined ? [] : await pyCollect(x),
    dict: async (x) => {
      if (x === undefined) return {};
      if (x instanceof Map) return Object.fromEntries(x);
      const arr = Array.isArray(x) ? x : await pyCollect(x);
      if (arr.length && Array.isArray(arr[0])) { const o = {}; for (const [k, v] of arr) o[k] = v; return o; }
      if (typeof x === 'object') return { ...x };
      throw new AdderError('TypeError', `cannot convert '${pyTypeName(x)}' to dict`);
    },
    set: async (x) => x === undefined ? new Set() : new Set(await pyCollect(x)),
    abs: (x) => (typeof x === 'object' && x !== null && typeof x.__abs__ === 'function') ? x.__abs__() : Math.abs(x),
    round: (x, n) => {
      if (n === undefined || n === 0) return Math.round(x);
      const f = Math.pow(10, n);
      return Math.round(x * f) / f;
    },
    max: async (...args) => {
      let key = null;
      if (args.length > 0 && args[args.length - 1]?._kw) { const kw = args.pop(); key = kw.key; }
      const items = args.length === 1 ? await pyCollect(args[0]) : args;
      if (items.length === 0) throw new AdderError('ValueError', 'max() arg is an empty sequence');
      return items.reduce((a, b) => (key ? key(b) > key(a) : b > a) ? b : a);
    },
    min: async (...args) => {
      let key = null;
      if (args.length > 0 && args[args.length - 1]?._kw) { const kw = args.pop(); key = kw.key; }
      const items = args.length === 1 ? await pyCollect(args[0]) : args;
      if (items.length === 0) throw new AdderError('ValueError', 'min() arg is an empty sequence');
      return items.reduce((a, b) => (key ? key(b) < key(a) : b < a) ? b : a);
    },
    sum: async (iterable, start) => { let s = start !== undefined ? start : 0; for (const v of await pyCollect(iterable)) s += v; return s; },
    sorted: async (iterable, key, reverse) => {
      if (key?._kw) { reverse = key.reverse; key = key.key; }
      const arr = await pyCollect(iterable);
      if (key) {
        const keyed = [];
        for (let i = 0; i < arr.length; i++) keyed.push([await key(arr[i]), i, arr[i]]);
        keyed.sort((a, b) => _pyCompare(a[0], b[0]));
        const result = keyed.map(x => x[2]);
        if (reverse) result.reverse();
        return result;
      }
      arr.sort(_pyCompare);
      if (reverse) arr.reverse();
      return arr;
    },
    reversed: async (iterable) => { const arr = await pyCollect(iterable); arr.reverse(); return arr; },
    enumerate: async (iterable, start) => {
      const result = [];
      let i = start || 0;
      for (const v of await pyCollect(iterable)) result.push([i++, v]);
      return result;
    },
    zip: async (...iterables) => {
      if (iterables.length === 0) return [];
      const arrs = []; for (const it of iterables) arrs.push(await pyCollect(it));
      const minLen = Math.min(...arrs.map(a => a.length));
      const result = [];
      for (let i = 0; i < minLen; i++) result.push(arrs.map(a => a[i]));
      return result;
    },
    map: async (fn, ...iterables) => {
      const arr0 = await pyCollect(iterables[0]);
      if (iterables.length === 1) { const r = []; for (const v of arr0) r.push(await fn(v)); return r; }
      const arrs = [arr0]; for (let i = 1; i < iterables.length; i++) arrs.push(await pyCollect(iterables[i]));
      const minLen = Math.min(...arrs.map(a => a.length));
      const result = [];
      for (let i = 0; i < minLen; i++) result.push(await fn(...arrs.map(a => a[i])));
      return result;
    },
    filter: async (fn, iterable) => {
      const result = [];
      for (const v of await pyCollect(iterable)) { if (fn ? pyBool(await fn(v)) : pyBool(v)) result.push(v); }
      return result;
    },
    any: async (iterable) => { for (const v of await pyCollect(iterable)) if (pyBool(v)) return true; return false; },
    all: async (iterable) => { for (const v of await pyCollect(iterable)) if (!pyBool(v)) return false; return true; },
    isinstance: (obj, typeOrTuple) => _pyIsInstance(obj, typeOrTuple),
    type: (obj) => pyTypeName(obj),
    hasattr: (obj, name) => { try { adderGetAttr(obj, name); return true; } catch { return false; } },
    getattr: (obj, name, def) => { try { return adderGetAttr(obj, name); } catch { if (def !== undefined) return def; throw new AdderError('AttributeError', `'${pyTypeName(obj)}' object has no attribute '${name}'`); } },
    setattr: (obj, name, value) => { obj[name] = value; return null; },
    delattr: (obj, name) => { delete obj[name]; return null; },
    property: (fget) => ({ __property__: true, fget }),
    callable: (obj) => typeof obj === 'function',
    chr: (n) => String.fromCodePoint(n),
    ord: (c) => { if (typeof c !== 'string' || c.length !== 1) throw new AdderError('TypeError', 'ord() expected a character'); return c.codePointAt(0); },
    hex: (n) => { const v = Math.trunc(n); return v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16); },
    oct: (n) => { const v = Math.trunc(n); return v < 0 ? '-0o' + (-v).toString(8) : '0o' + v.toString(8); },
    bin: (n) => { const v = Math.trunc(n); return v < 0 ? '-0b' + (-v).toString(2) : '0b' + v.toString(2); },
    repr: pyRepr,
    format: (value, spec) => pyFormatValue(value, spec || ''),
    pow: (x, y, mod) => mod !== undefined ? _modPow(x, y, mod) : Math.pow(x, y),
    divmod: (a, b) => [Math.floor(a / b), ((a % b) + b) % b],
    id: (obj) => { if (typeof obj === 'object' && obj !== null) { if (!obj.__id__) obj.__id__ = ++_idCounter; return obj.__id__; } return 0; },
    hash: (obj) => { if (typeof obj === 'number') return obj; if (typeof obj === 'string') { let h = 0; for (let i = 0; i < obj.length; i++) h = (h * 31 + obj.charCodeAt(i)) | 0; return h; } return 0; },
    iter: (obj) => pyIter(obj),
    next: (iter, def) => { const r = iter.next(); if (r.done) { if (def !== undefined) return def; throw new AdderError('StopIteration', ''); } return r.value; },
    input: () => { throw new AdderError('NotImplementedError', 'input() is not supported in the browser'); },
    issubclass: () => false,
    vars: (obj) => obj ? { ...obj } : {},
    dir: (obj) => obj ? Object.keys(obj).sort() : [],
    object: () => ({}),
    super: () => { throw new AdderError('RuntimeError', 'super() is handled by the evaluator'); },
    ValueError: (msg) => new AdderError('ValueError', msg),
    TypeError: (msg) => new AdderError('TypeError', msg),
    KeyError: (msg) => new AdderError('KeyError', msg),
    IndexError: (msg) => new AdderError('IndexError', msg),
    AttributeError: (msg) => new AdderError('AttributeError', msg),
    RuntimeError: (msg) => new AdderError('RuntimeError', msg),
    StopIteration: (msg) => new AdderError('StopIteration', msg || ''),
    ZeroDivisionError: (msg) => new AdderError('ZeroDivisionError', msg),
    NotImplementedError: (msg) => new AdderError('NotImplementedError', msg),
    AssertionError: (msg) => new AdderError('AssertionError', msg),
    Exception: (msg) => new AdderError('Exception', msg),
    FileNotFoundError: (msg) => new AdderError('FileNotFoundError', msg),
    FileExistsError: (msg) => new AdderError('FileExistsError', msg),
    IsADirectoryError: (msg) => new AdderError('IsADirectoryError', msg),
    NotADirectoryError: (msg) => new AdderError('NotADirectoryError', msg),
    PermissionError: (msg) => new AdderError('PermissionError', msg),
    OSError: (msg) => new AdderError('OSError', msg),
    IOError: (msg) => new AdderError('IOError', msg),
    open: async (pathOrObj, mode) => {
      if (!_adderVFS) throw new AdderError('RuntimeError', 'filesystem not available — call adder.setVFS(vfsInstance, pathUtils) first');
      const raw = pathOrObj?._path ? pathOrObj._path : String(pathOrObj);
      const p = _resolvePath(raw, _vfsPath);
      return _createAdderFile(_adderVFS, p, mode || 'r');
    },
  };
  return builtins;
}

function _pyIsInstance(obj, typeOrTuple) {
  const types = Array.isArray(typeOrTuple) ? typeOrTuple : [typeOrTuple];
  const name = pyTypeName(obj);
  for (const t of types) {
    if (typeof t === 'string') { if (name === t) return true; }
    else if (typeof t === 'function') { if (obj instanceof t) return true; }
    else if (t === null) { if (obj === null) return true; }
  }
  return false;
}

function _modPow(base, exp, mod) {
  let result = 1;
  base = ((base % mod) + mod) % mod;
  while (exp > 0) {
    if (exp % 2 === 1) result = (result * base) % mod;
    exp = Math.floor(exp / 2);
    base = (base * base) % mod;
  }
  return result;
}

let _idCounter = 0;

// -- eval.js --

// adder v2 — tree-walking evaluator
// Evaluates AST nodes produced by the parser. All values are native JS values.



// ── scope ──

class AdderScope {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
    this.globals = new Set();
    this.nonlocals = new Set();
  }
  get(name) {
    if (this.globals.has(name)) return this._getGlobal(name);
    if (this.nonlocals.has(name)) return this._getEnclosing(name);
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
  set(name, value) {
    if (this.globals.has(name)) { this._setGlobal(name, value); return; }
    if (this.nonlocals.has(name)) { this._setEnclosing(name, value); return; }
    this.vars.set(name, value);
  }
  has(name) {
    if (this.vars.has(name)) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }
  delete(name) { this.vars.delete(name); }
  _getGlobal(name) {
    let s = this; while (s.parent) s = s.parent;
    if (s.vars.has(name)) return s.vars.get(name);
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
  _setGlobal(name, value) { let s = this; while (s.parent) s = s.parent; s.vars.set(name, value); }
  _getEnclosing(name) {
    let s = this.parent;
    while (s) { if (s.vars.has(name)) return s.vars.get(name); s = s.parent; }
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
  _setEnclosing(name, value) {
    let s = this.parent;
    while (s) { if (s.vars.has(name)) { s.vars.set(name, value); return; } s = s.parent; }
    throw new AdderError('NameError', `name '${name}' is not defined`);
  }
}

// ── control flow signals ──

class _BreakSignal { }
class _ContinueSignal { }
class _ReturnSignal { constructor(value) { this.value = value; } }

// ── evaluator ──

async function adderEval(node, scope) {
  if (!node) return null;
  switch (node.type) {
    case 'Module': return _evalModule(node, scope);
    case 'Expr': return adderEval(node.value, scope);
    case 'Constant': return node.value;
    case 'Name': return scope.get(node.id);
    case 'Pass': return null;
    case 'Break': throw new _BreakSignal();
    case 'Continue': throw new _ContinueSignal();
    case 'Return': throw new _ReturnSignal(node.value ? await adderEval(node.value, scope) : null);

    // ── assignments ──
    case 'Assign': {
      const value = await adderEval(node.value, scope);
      for (const target of node.targets) await _assignTarget(target, value, scope);
      return null;
    }
    case 'AugAssign': {
      const current = await _evalTarget(node.target, scope);
      const value = await adderEval(node.value, scope);
      const result = _binOp(node.op, current, value, node.line);
      await _assignTarget(node.target, result, scope);
      return null;
    }
    case 'AnnAssign': {
      if (node.value) {
        const value = await adderEval(node.value, scope);
        await _assignTarget(node.target, value, scope);
      }
      return null;
    }

    // ── control flow ──
    case 'If': {
      const test = await adderEval(node.test, scope);
      if (pyBool(test)) { for (const s of node.body) await adderEval(s, scope); }
      else { for (const s of node.orelse) await adderEval(s, scope); }
      return null;
    }
    case 'For': return _evalFor(node, scope);
    case 'While': return _evalWhile(node, scope);
    case 'With': return _evalWith(node, scope);

    // ── functions / classes ──
    case 'FunctionDef': case 'AsyncFunctionDef': {
      let fn = _makeFunction(node, scope);
      for (let i = node.decorators.length - 1; i >= 0; i--) {
        const dec = await adderEval(node.decorators[i], scope);
        fn = await _callValue(dec, [fn], [], node.line);
      }
      fn._pyName = node.name;
      scope.set(node.name, fn);
      return null;
    }
    case 'ClassDef': return _evalClass(node, scope);
    case 'Lambda': return _makeLambda(node, scope);

    // ── exceptions ──
    case 'Try': return _evalTry(node, scope);
    case 'Raise': {
      const exc = node.exc ? await adderEval(node.exc, scope) : null;
      if (exc instanceof AdderError) throw exc;
      if (exc instanceof Error) throw exc;
      if (typeof exc === 'function') throw await _callValue(exc, [], [], node.line);
      throw new AdderError('RuntimeError', exc ? pyStr(exc) : 're-raise outside except', node.line);
    }
    case 'Assert': {
      const test = await adderEval(node.test, scope);
      if (!pyBool(test)) {
        const msg = node.msg ? await adderEval(node.msg, scope) : 'assertion failed';
        throw new AdderError('AssertionError', pyStr(msg), node.line);
      }
      return null;
    }

    // ── scope declarations ──
    case 'Global': { for (const n of node.names) scope.globals.add(n); return null; }
    case 'Nonlocal': { for (const n of node.names) scope.nonlocals.add(n); return null; }
    case 'Delete': { for (const t of node.targets) await _deleteTarget(t, scope); return null; }

    // ── imports ──
    case 'Import': return _evalImport(node, scope);
    case 'ImportFrom': return _evalImportFrom(node, scope);

    // ── expressions ──
    case 'BinOp': {
      const left = await adderEval(node.left, scope);
      const right = await adderEval(node.right, scope);
      return _binOp(node.op, left, right, node.line);
    }
    case 'UnaryOp': {
      const operand = await adderEval(node.operand, scope);
      if (node.op === '-') return typeof operand === 'number' ? -operand : (typeof operand?.__neg__ === 'function' ? operand.__neg__() : -operand);
      if (node.op === '+') return +operand;
      if (node.op === '~') return typeof operand?.__invert__ === 'function' ? operand.__invert__() : ~operand;
      if (node.op === 'not') return !pyBool(operand);
      throw new AdderError('TypeError', `unsupported unary op: ${node.op}`, node.line);
    }
    case 'BoolOp': {
      if (node.op === 'or') {
        let result;
        for (const v of node.values) { result = await adderEval(v, scope); if (pyBool(result)) return result; }
        return result;
      }
      let result;
      for (const v of node.values) { result = await adderEval(v, scope); if (!pyBool(result)) return result; }
      return result;
    }
    case 'Compare': {
      let left = await adderEval(node.left, scope);
      // single comparison: return dunder result directly (e.g. BooleanMask from Series.__gt__)
      if (node.ops.length === 1) {
        const right = await adderEval(node.comparators[0], scope);
        return _compareOp(node.ops[0], left, right);
      }
      // chained comparisons: coerce to boolean (a < b < c → a < b and b < c)
      for (let i = 0; i < node.ops.length; i++) {
        const right = await adderEval(node.comparators[i], scope);
        if (!_compareOp(node.ops[i], left, right)) return false;
        left = right;
      }
      return true;
    }
    case 'IfExp': {
      const test = await adderEval(node.test, scope);
      return pyBool(test) ? adderEval(node.body, scope) : adderEval(node.orelse, scope);
    }

    // ── calls ──
    case 'Call': return _evalCall(node, scope);

    // ── attribute / subscript ──
    case 'Attribute': {
      const obj = await adderEval(node.value, scope);
      return adderGetAttr(obj, node.attr);
    }
    case 'Subscript': return _evalSubscript(node, scope);

    // ── collections ──
    case 'List': { const elts = []; for (const e of node.elts) { if (e.type === 'Starred') { for (const v of pyIter(await adderEval(e.value, scope))) elts.push(v); } else elts.push(await adderEval(e, scope)); } return elts; }
    case 'Tuple': { const elts = []; for (const e of node.elts) { if (e.type === 'Starred') { for (const v of pyIter(await adderEval(e.value, scope))) elts.push(v); } else elts.push(await adderEval(e, scope)); } return elts; }
    case 'Dict': {
      const allStringKeys = node.keys.every(k => k && (k.type === 'Constant' && typeof k.value === 'string') || k === null);
      if (allStringKeys) {
        const obj = {};
        for (let i = 0; i < node.keys.length; i++) {
          if (node.keys[i] === null) { // **unpack
            const src = await adderEval(node.values[i], scope);
            if (src instanceof Map) { for (const [k, v] of src) obj[k] = v; }
            else { Object.assign(obj, src); }
          } else {
            obj[await adderEval(node.keys[i], scope)] = await adderEval(node.values[i], scope);
          }
        }
        return obj;
      }
      const map = new Map();
      for (let i = 0; i < node.keys.length; i++) {
        if (node.keys[i] === null) {
          const src = await adderEval(node.values[i], scope);
          if (src instanceof Map) { for (const [k, v] of src) map.set(k, v); }
          else { for (const k of Object.keys(src)) map.set(k, src[k]); }
        } else {
          map.set(await adderEval(node.keys[i], scope), await adderEval(node.values[i], scope));
        }
      }
      return map;
    }
    case 'Set': {
      const s = new Set();
      for (const e of node.elts) s.add(await adderEval(e, scope));
      return s;
    }

    // ── comprehensions ──
    case 'ListComp': return _evalComp(node, scope, 'list');
    case 'SetComp': return _evalComp(node, scope, 'set');
    case 'DictComp': return _evalComp(node, scope, 'dict');
    case 'GeneratorExp': return _evalGenExpr(node, scope);

    // ── f-strings ──
    case 'JoinedStr': {
      let result = '';
      for (const v of node.values) result += await adderEval(v, scope);
      return result;
    }
    case 'FormattedValue': {
      let val = await adderEval(node.value, scope);
      if (node.conversion === 'r') val = pyRepr(val);
      else if (node.conversion === 's') val = pyStr(val);
      return node.formatSpec ? pyFormatValue(val, node.formatSpec) : pyStr(val);
    }

    // ── await ──
    case 'Await': return await (await adderEval(node.value, scope));
    case 'Yield': throw new AdderError('SyntaxError', 'yield outside function', node.line);
    case 'YieldFrom': throw new AdderError('SyntaxError', 'yield outside function', node.line);
    case 'NamedExpr': { const value = await adderEval(node.value, scope); scope.set(node.target.id, value); return value; }

    // ── starred (in expression context) ──
    case 'Starred': return await adderEval(node.value, scope);

    // ── slice (standalone) ──
    case 'Slice': return { _slice: true, lower: node.lower ? await adderEval(node.lower, scope) : null, upper: node.upper ? await adderEval(node.upper, scope) : null, step: node.step ? await adderEval(node.step, scope) : null };

    default:
      throw new AdderError('RuntimeError', `Unknown AST node type: ${node.type}`, node.line);
  }
}

// ── module execution ──

async function _evalModule(node, scope) {
  let lastExpr = undefined;
  for (let i = 0; i < node.body.length; i++) {
    const stmt = node.body[i];
    if (i === node.body.length - 1 && stmt.type === 'Expr') {
      lastExpr = await adderEval(stmt.value, scope);
    } else {
      await adderEval(stmt, scope);
    }
  }
  return lastExpr;
}

// ── assignment / target helpers ──

async function _assignTarget(target, value, scope) {
  switch (target.type) {
    case 'Name': scope.set(target.id, value); break;
    case 'Attribute': {
      const obj = await adderEval(target.value, scope);
      obj[target.attr] = value;
      break;
    }
    case 'Subscript': {
      const obj = await adderEval(target.value, scope);
      const key = target.slice.type === 'Slice' ? await adderEval(target.slice, scope) : await adderEval(target.slice, scope);
      if (obj instanceof Map) obj.set(key, value);
      else if (typeof obj?.__setitem__ === 'function') obj.__setitem__(key, value);
      else obj[key] = value;
      break;
    }
    case 'Tuple': case 'List': {
      const items = [...pyIter(value)];
      const starIdx = target.elts.findIndex(e => e.type === 'Starred');
      if (starIdx >= 0) {
        // starred unpacking
        const before = target.elts.slice(0, starIdx);
        const after = target.elts.slice(starIdx + 1);
        for (let i = 0; i < before.length; i++) await _assignTarget(before[i], items[i], scope);
        const starItems = items.slice(before.length, items.length - after.length);
        await _assignTarget(target.elts[starIdx].value, starItems, scope);
        for (let i = 0; i < after.length; i++) await _assignTarget(after[i], items[items.length - after.length + i], scope);
      } else {
        for (let i = 0; i < target.elts.length; i++) await _assignTarget(target.elts[i], items[i], scope);
      }
      break;
    }
    case 'Starred': await _assignTarget(target.value, value, scope); break;
    default: throw new AdderError('RuntimeError', `Cannot assign to ${target.type}`);
  }
}

async function _evalTarget(target, scope) {
  if (target.type === 'Name') return scope.get(target.id);
  if (target.type === 'Attribute') { const obj = await adderEval(target.value, scope); return obj[target.attr]; }
  if (target.type === 'Subscript') { return _evalSubscript(target, scope); }
  throw new AdderError('RuntimeError', `Cannot read target ${target.type}`);
}

async function _deleteTarget(target, scope) {
  if (target.type === 'Name') { scope.delete(target.id); return; }
  if (target.type === 'Attribute') { const obj = await adderEval(target.value, scope); delete obj[target.attr]; return; }
  if (target.type === 'Subscript') {
    const obj = await adderEval(target.value, scope);
    const key = await adderEval(target.slice, scope);
    if (obj instanceof Map) obj.delete(key);
    else if (Array.isArray(obj)) obj.splice(key, 1);
    else delete obj[key];
    return;
  }
}

// ── binary operations ──

function _binOp(op, left, right, line) {
  // check dunder methods (left operand first, then reflected on right)
  if (left !== null && typeof left === 'object') {
    const dunder = _dunders[op];
    if (dunder && typeof left[dunder] === 'function') return left[dunder](right);
  }
  if (right !== null && typeof right === 'object') {
    const rdunder = _rdunders[op];
    if (rdunder && typeof right[rdunder] === 'function') return right[rdunder](left);
  }
  switch (op) {
    case '+':
      if (typeof left === 'number' && typeof right === 'number') return left + right;
      if (typeof left === 'string' && typeof right === 'string') return left + right;
      if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
      throw new AdderError('TypeError', `unsupported operand type(s) for +: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '-':
      if (typeof left === 'number' && typeof right === 'number') return left - right;
      throw new AdderError('TypeError', `unsupported operand type(s) for -: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '*':
      if (typeof left === 'number' && typeof right === 'number') return left * right;
      if (typeof left === 'string' && typeof right === 'number') return left.repeat(right);
      if (typeof left === 'number' && typeof right === 'string') return right.repeat(left);
      if (Array.isArray(left) && typeof right === 'number') { const r = []; for (let i = 0; i < right; i++) r.push(...left); return r; }
      throw new AdderError('TypeError', `unsupported operand type(s) for *: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '/':
      if (right === 0) throw new AdderError('ZeroDivisionError', 'division by zero', line);
      if (typeof left === 'number' && typeof right === 'number') return left / right;
      throw new AdderError('TypeError', `unsupported operand type(s) for /: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '//':
      if (right === 0) throw new AdderError('ZeroDivisionError', 'integer division or modulo by zero', line);
      if (typeof left === 'number' && typeof right === 'number') return Math.floor(left / right);
      throw new AdderError('TypeError', `unsupported operand type(s) for //: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '%': if (right === 0) throw new AdderError('ZeroDivisionError', 'integer division or modulo by zero', line);
      if (typeof left === 'string') return _strPercentFormat(left, Array.isArray(right) ? right : [right]);
      if (typeof left === 'number' && typeof right === 'number') return ((left % right) + right) % right;
      throw new AdderError('TypeError', `unsupported operand type(s) for %: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '**':
      if (typeof left === 'number' && typeof right === 'number') return Math.pow(left, right);
      throw new AdderError('TypeError', `unsupported operand type(s) for **: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    case '&': return left & right;
    case '|': return left | right;
    case '^': return left ^ right;
    case '<<': return left << right;
    case '>>': return left >> right;
    case '@': throw new AdderError('TypeError', `unsupported operand type(s) for @: '${pyTypeName(left)}' and '${pyTypeName(right)}'`, line);
    default: throw new AdderError('TypeError', `unsupported operator: ${op}`, line);
  }
}

function _strPercentFormat(fmt, args) {
  // Python % formatting: "%s %d" % (arg1, arg2)
  let i = 0;
  return fmt.replace(/%([sd%fegx])/g, (_, code) => {
    if (code === '%') return '%';
    return pyStr(args[i++]);
  });
}

const _dunders = {
  '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__truediv__',
  '//': '__floordiv__', '%': '__mod__', '**': '__pow__',
  '&': '__and__', '|': '__or__', '^': '__xor__',
  '<<': '__lshift__', '>>': '__rshift__', '@': '__matmul__',
};

const _rdunders = {
  '+': '__radd__', '-': '__rsub__', '*': '__rmul__', '/': '__rtruediv__',
  '//': '__rfloordiv__', '%': '__rmod__', '**': '__rpow__', '@': '__rmatmul__',
};

// ── comparison ──

function _compareOp(op, left, right) {
  switch (op) {
    case '==': return _pyEq(left, right);
    case '!=': return typeof left?.__ne__ === 'function' ? left.__ne__(right) : !_pyEq(left, right);
    case '<': return typeof left?.__lt__ === 'function' ? left.__lt__(right) : left < right;
    case '<=': return typeof left?.__le__ === 'function' ? left.__le__(right) : left <= right;
    case '>': return typeof left?.__gt__ === 'function' ? left.__gt__(right) : left > right;
    case '>=': return typeof left?.__ge__ === 'function' ? left.__ge__(right) : left >= right;
    case 'in': return _pyIn(right, left);
    case 'not in': return !_pyIn(right, left);
    case 'is': return left === right;
    case 'is not': return left !== right;
    default: throw new AdderError('TypeError', `unsupported comparison: ${op}`);
  }
}

function _pyEq(a, b) {
  if (a === b) return true;
  if (typeof a?.__eq__ === 'function') return a.__eq__(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_pyEq(a[i], b[i])) return false;
    return true;
  }
  return false;
}

function _pyIn(container, value) {
  if (typeof container === 'string') return container.includes(String(value));
  if (Array.isArray(container)) return container.some(v => _pyEq(v, value));
  if (container instanceof Map) return container.has(value);
  if (container instanceof Set) return container.has(value);
  if (container instanceof AdderRange) return container.includes(value);
  if (typeof container === 'object' && container !== null) {
    if (typeof container.__contains__ === 'function') return container.__contains__(value);
    return value in container;
  }
  throw new AdderError('TypeError', `argument of type '${pyTypeName(container)}' is not iterable`);
}

// ── subscript ──

async function _evalSubscript(node, scope) {
  const obj = await adderEval(node.value, scope);
  if (node.slice.type === 'Slice') {
    const lower = node.slice.lower ? await adderEval(node.slice.lower, scope) : null;
    const upper = node.slice.upper ? await adderEval(node.slice.upper, scope) : null;
    const step = node.slice.step ? await adderEval(node.slice.step, scope) : null;
    if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array)
      return _applySlice(obj, lower, upper, step);
    if (typeof obj?.__getitem__ === 'function')
      return obj.__getitem__({ _slice: true, lower, upper, step });
    return _applySlice(obj, lower, upper, step);
  }
  const key = await adderEval(node.slice, scope);
  if (obj instanceof Map) {
    if (!obj.has(key)) throw new AdderError('KeyError', pyRepr(key), node.line);
    return obj.get(key);
  }
  if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) {
    const idx = key < 0 ? obj.length + key : key;
    if (idx < 0 || idx >= obj.length) throw new AdderError('IndexError', `${pyTypeName(obj)} index out of range`, node.line);
    return obj[idx];
  }
  if (typeof obj === 'object' && obj !== null) {
    if (typeof obj.__getitem__ === 'function') return obj.__getitem__(key);
    if (key in obj) return obj[key];
    throw new AdderError('KeyError', pyRepr(key), node.line);
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object is not subscriptable`, node.line);
}

function _applySlice(obj, lower, upper, step) {
  if (typeof obj === 'string' || Array.isArray(obj) || obj instanceof Uint8Array) {
    const len = obj.length;
    step = step ?? 1;
    if (step === 0) throw new AdderError('ValueError', 'slice step cannot be zero');
    if (step === 1) {
      const l = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
      const u = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
      return typeof obj === 'string' ? obj.slice(l, u) : obj.slice(l, u);
    }
    // general step
    let start, stop;
    if (step > 0) {
      start = lower == null ? 0 : lower < 0 ? Math.max(0, len + lower) : Math.min(lower, len);
      stop = upper == null ? len : upper < 0 ? Math.max(0, len + upper) : Math.min(upper, len);
    } else {
      start = lower == null ? len - 1 : lower < 0 ? Math.max(-1, len + lower) : Math.min(lower, len - 1);
      stop = upper == null ? -1 : upper < 0 ? Math.max(-1, len + upper) : upper;
    }
    const result = [];
    if (step > 0) { for (let i = start; i < stop; i += step) result.push(obj[i]); }
    else { for (let i = start; i > stop; i += step) result.push(obj[i]); }
    return typeof obj === 'string' ? result.join('') : result;
  }
  throw new AdderError('TypeError', `'${pyTypeName(obj)}' object does not support slicing`);
}

// ── function call ──

async function _evalCall(node, scope) {
  const func = await adderEval(node.func, scope);
  const args = [];
  for (const a of node.args) {
    if (a.type === 'Starred') { for (const v of pyIter(await adderEval(a.value, scope))) args.push(v); }
    else args.push(await adderEval(a, scope));
  }
  const kwArgs = [];
  for (const kw of node.keywords) {
    if (kw.name === null) {
      // **kwargs unpacking
      const obj = await adderEval(kw.value, scope);
      if (obj instanceof Map) { for (const [k, v] of obj) kwArgs.push([k, v]); }
      else { for (const k of Object.keys(obj)) kwArgs.push([k, obj[k]]); }
    } else {
      kwArgs.push([kw.name, await adderEval(kw.value, scope)]);
    }
  }
  return _callValue(func, args, kwArgs, node.line);
}

async function _callValue(func, args, kwArgs, line) {
  if (typeof func !== 'function') {
    // check for __call__ dunder
    if (typeof func === 'object' && func !== null && typeof func.__call__ === 'function') {
      return _callValue(func.__call__.bind(func), args, kwArgs, line);
    }
    throw new AdderError('TypeError', `'${pyTypeName(func)}' object is not callable`, line);
  }
  // pack keyword args
  if (kwArgs.length > 0) {
    if (func._pyFunc) {
      // adder function — pass kwargs through the calling convention
      return func(...args, ...kwArgs.map(([_, v]) => v), { _kw: true, ...Object.fromEntries(kwArgs) });
    }
    // builtins and native JS — try to inject kwargs
    // for print, max, min, sorted — they check for _kw marker
    const kw = { _kw: true };
    for (const [k, v] of kwArgs) kw[k] = v;
    try {
      return func(...args, kw);
    } catch (e) {
      if (e instanceof TypeError && /\bnew\b/.test(e.message)) return new func(...args, kw);
      if (e instanceof AdderError || e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
      throw new AdderError('RuntimeError', e.message || String(e), line);
    }
  }
  try {
    return await func(...args);
  } catch (e) {
    // ES6 class constructors require `new` — retry if that's the error
    // (also handles bound class constructors where toString() detection fails)
    if (e instanceof TypeError && /\bnew\b/.test(e.message)) return new func(...args);
    if (e instanceof AdderError || e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
    throw new AdderError('RuntimeError', e.message || String(e), line);
  }
}

// ── function creation ──

function _hasYield(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Yield' || node.type === 'YieldFrom') return true;
  // don't descend into nested function/class defs
  if (node.type === 'FunctionDef' || node.type === 'AsyncFunctionDef' || node.type === 'ClassDef' || node.type === 'Lambda') return false;
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) { for (const item of val) { if (_hasYield(item)) return true; } }
    else if (val && typeof val === 'object' && val.type) { if (_hasYield(val)) return true; }
  }
  return false;
}

function _makeFunction(node, scope) {
  const isAsync = node.type === 'AsyncFunctionDef';
  const isGenerator = node.body.some(s => _hasYield(s));

  if (isGenerator) return _makeGeneratorFunction(node, scope);

  const fn = async function (...callArgs) {
    const localScope = new AdderScope(scope);
    // bind parameters
    await _bindParams(node, callArgs, localScope);
    // execute body
    try {
      for (let i = 0; i < node.body.length; i++) {
        const stmt = node.body[i];
        // docstring — skip first string expression
        if (i === 0 && stmt.type === 'Expr' && stmt.value.type === 'Constant' && typeof stmt.value.value === 'string') {
          fn.__doc__ = stmt.value.value;
          continue;
        }
        await adderEval(stmt, localScope);
      }
      return null;
    } catch (e) {
      if (e instanceof _ReturnSignal) return e.value;
      throw e;
    }
  };
  fn._pyFunc = true;
  fn._pyName = node.name;
  return fn;
}

function _makeGeneratorFunction(node, scope) {
  // Generator functions use a _YieldSignal to communicate yield values
  // back to the async-generator wrapper.
  const fn = function (...callArgs) {
    // Return an object that implements both sync and async iteration.
    // We use an async generator internally, exposed via Symbol.asyncIterator.
    // For sync consumers (for..of), we also provide Symbol.iterator
    // that collects eagerly — but the primary path is for-await.
    const genObj = {
      [Symbol.asyncIterator]() {
        return _runGenerator(node, scope, callArgs);
      },
      // sync iterator: collect all values eagerly (used by list(), sorted(), etc.)
      [Symbol.iterator]() {
        throw new AdderError('TypeError', 'Use "for await" or list() with generators');
      },
    };
    return genObj;
  };
  fn._pyFunc = true;
  fn._pyName = node.name;
  fn._isGenerator = true;
  return fn;
}

async function* _runGenerator(node, scope, callArgs) {
  const localScope = new AdderScope(scope);
  await _bindParams(node, callArgs, localScope);
  try {
    for (let i = 0; i < node.body.length; i++) {
      const stmt = node.body[i];
      if (i === 0 && stmt.type === 'Expr' && stmt.value.type === 'Constant' && typeof stmt.value.value === 'string') continue;
      yield* await _evalGenStmt(stmt, localScope);
    }
  } catch (e) {
    if (e instanceof _ReturnSignal) return;
    throw e;
  }
}

async function* _evalGenStmt(node, scope) {
  // Like adderEval but yields instead of throwing for Yield nodes
  switch (node.type) {
    case 'Expr':
      if (node.value.type === 'Yield') {
        yield node.value.value ? await adderEval(node.value.value, scope) : null;
        return;
      }
      if (node.value.type === 'YieldFrom') {
        const iterable = await adderEval(node.value.value, scope);
        if (iterable[Symbol.asyncIterator]) { for await (const v of iterable) yield v; }
        else { for (const v of pyIter(iterable)) yield v; }
        return;
      }
      await adderEval(node, scope);
      return;
    case 'For': {
      const iterable = await adderEval(node.iter, scope);
      let broke = false;
      const iter = iterable[Symbol.asyncIterator] ? iterable : pyIter(iterable);
      for await (const value of iter) {
        await _assignTarget(node.target, value, scope);
        try {
          for (const stmt of node.body) yield* await _evalGenStmt(stmt, scope);
        } catch (e) {
          if (e instanceof _BreakSignal) { broke = true; break; }
          if (e instanceof _ContinueSignal) continue;
          throw e;
        }
      }
      if (!broke) for (const stmt of node.orelse) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    case 'While': {
      let broke = false, iterations = 0;
      while (pyBool(await adderEval(node.test, scope))) {
        if (++iterations > 1000000) throw new AdderError('RuntimeError', 'maximum loop iterations exceeded');
        try {
          for (const stmt of node.body) yield* await _evalGenStmt(stmt, scope);
        } catch (e) {
          if (e instanceof _BreakSignal) { broke = true; break; }
          if (e instanceof _ContinueSignal) continue;
          throw e;
        }
      }
      if (!broke) for (const stmt of node.orelse) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    case 'If': {
      const test = await adderEval(node.test, scope);
      const branch = pyBool(test) ? node.body : node.orelse;
      for (const stmt of branch) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    case 'Try': {
      try {
        for (const stmt of node.body) yield* await _evalGenStmt(stmt, scope);
      } catch (e) {
        if (e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
        let handled = false;
        for (const handler of node.handlers) {
          let excTypeVal = null;
          if (handler.excType) try { excTypeVal = await adderEval(handler.excType, scope); } catch {}
          if (!handler.excType || _matchException(e, excTypeVal)) {
            if (handler.name) scope.set(handler.name, e);
            handled = true;
            for (const stmt of handler.body) yield* await _evalGenStmt(stmt, scope);
            break;
          }
        }
        if (!handled) { for (const stmt of node.finalbody) yield* await _evalGenStmt(stmt, scope); throw e; }
      }
      for (const stmt of node.finalbody) yield* await _evalGenStmt(stmt, scope);
      return;
    }
    default:
      // non-yielding statements — just eval normally
      await adderEval(node, scope);
  }
}

async function _bindParams(node, callArgs, localScope) {
  const { params, vararg, kwonly, kwarg } = node;
  let positionalIdx = 0;
  let kwObj = null;

  // check if last arg is keyword bag
  if (callArgs.length > 0 && callArgs[callArgs.length - 1]?._kw) {
    kwObj = callArgs.pop();
  }

  // bind positional params
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (positionalIdx < callArgs.length) {
      localScope.set(p.name, callArgs[positionalIdx++]);
    } else if (kwObj && p.name in kwObj) {
      localScope.set(p.name, kwObj[p.name]);
    } else if (p.default) {
      localScope.set(p.name, await adderEval(p.default, localScope));
    } else {
      throw new AdderError('TypeError', `${node.name}() missing required argument: '${p.name}'`);
    }
  }

  // vararg
  if (vararg) {
    localScope.set(vararg, callArgs.slice(positionalIdx));
    positionalIdx = callArgs.length;
  }

  // keyword-only params
  for (const p of kwonly) {
    if (kwObj && p.name in kwObj) {
      localScope.set(p.name, kwObj[p.name]);
    } else if (p.default) {
      localScope.set(p.name, await adderEval(p.default, localScope));
    } else {
      throw new AdderError('TypeError', `${node.name}() missing keyword argument: '${p.name}'`);
    }
  }

  // **kwargs
  if (kwarg) {
    const extra = {};
    if (kwObj) {
      const usedNames = new Set([...params.map(p => p.name), ...kwonly.map(p => p.name), '_kw']);
      for (const k of Object.keys(kwObj)) {
        if (!usedNames.has(k)) extra[k] = kwObj[k];
      }
    }
    localScope.set(kwarg, extra);
  }
}

function _makeLambda(node, scope) {
  const fn = async function (...callArgs) {
    const localScope = new AdderScope(scope);
    let positionalIdx = 0;
    let kwObj = null;
    if (callArgs.length > 0 && callArgs[callArgs.length - 1]?._kw) kwObj = callArgs.pop();
    for (let i = 0; i < node.params.length; i++) {
      const p = node.params[i];
      if (positionalIdx < callArgs.length) localScope.set(p.name, callArgs[positionalIdx++]);
      else if (kwObj && p.name in kwObj) localScope.set(p.name, kwObj[p.name]);
      else if (p.default) localScope.set(p.name, await adderEval(p.default, localScope));
    }
    if (node.vararg) localScope.set(node.vararg, callArgs.slice(positionalIdx));
    if (node.kwarg) {
      const extra = {};
      if (kwObj) { const used = new Set([...node.params.map(p => p.name), '_kw']); for (const k of Object.keys(kwObj)) if (!used.has(k)) extra[k] = kwObj[k]; }
      localScope.set(node.kwarg, extra);
    }
    return adderEval(node.body, localScope);
  };
  fn._pyFunc = true;
  fn._pyName = '<lambda>';
  return fn;
}

// ── class ──

async function _evalClass(node, scope) {
  const bases = [];
  for (const b of node.bases) bases.push(await adderEval(b, scope));

  // evaluate class body in a class scope
  const classScope = new AdderScope(scope);
  for (const stmt of node.body) await adderEval(stmt, classScope);

  // build class
  const classVars = Object.fromEntries(classScope.vars);

  // constructor function
  const cls = function (...args) {
    const instance = Object.create(cls.prototype);
    instance.__adderClass__ = node.name;
    // copy class variables (non-function)
    for (const [k, v] of Object.entries(classVars)) {
      if (typeof v !== 'function') instance[k] = v;
    }
    // call __init__ if present
    if (typeof cls.prototype.__init__ === 'function') {
      const result = cls.prototype.__init__.call(instance, ...args);
      if (result instanceof Promise) return result.then(() => instance);
    }
    return instance;
  };

  cls.prototype = {};
  cls._pyName = node.name;
  cls._pyClass = true;

  // inheritance
  if (bases.length > 0 && bases[0]?.prototype) {
    cls.prototype = Object.create(bases[0].prototype);
  }

  // assign methods and properties
  for (const [name, value] of Object.entries(classVars)) {
    if (value && value.__property__) {
      // @property decorator — define getter on prototype
      const fget = value.fget;
      Object.defineProperty(cls.prototype, name, {
        get() { return fget(this); },
        configurable: true,
      });
    } else if (typeof value === 'function') {
      if (name === '__init__' || name.startsWith('__')) {
        // bound method: inject `self` as first arg
        const originalFn = value;
        cls.prototype[name] = function (...args) { return originalFn(this, ...args); };
        cls.prototype[name]._pyName = `${node.name}.${name}`;
      } else {
        const originalFn = value;
        cls.prototype[name] = function (...args) { return originalFn(this, ...args); };
        cls.prototype[name]._pyName = `${node.name}.${name}`;
      }
    }
  }

  // handle decorators
  let result = cls;
  for (let i = node.decorators.length - 1; i >= 0; i--) {
    const dec = await adderEval(node.decorators[i], scope);
    result = await _callValue(dec, [result], [], node.line);
  }

  scope.set(node.name, result);
  return null;
}

// ── for loop ──

async function _evalFor(node, scope) {
  const iterable = await adderEval(node.iter, scope);
  let broke = false;
  // for-await handles both sync iterables and async generators
  const iter = iterable[Symbol.asyncIterator] ? iterable : pyIter(iterable);
  let _loopCount = 0;
  for await (const value of iter) {
    // yield to event loop periodically to prevent page lockup
    if (++_loopCount % 1000 === 0) await new Promise(r => setTimeout(r, 0));
    await _assignTarget(node.target, value, scope);
    try {
      for (const stmt of node.body) await adderEval(stmt, scope);
    } catch (e) {
      if (e instanceof _BreakSignal) { broke = true; break; }
      if (e instanceof _ContinueSignal) continue;
      throw e;
    }
  }
  if (!broke) {
    for (const stmt of node.orelse) await adderEval(stmt, scope);
  }
  return null;
}

// ── while loop ──

async function _evalWhile(node, scope) {
  let broke = false;
  let iterations = 0;
  while (pyBool(await adderEval(node.test, scope))) {
    if (++iterations > 1000000) throw new AdderError('RuntimeError', 'maximum loop iterations exceeded (1M)');
    if (iterations % 1000 === 0) await new Promise(r => setTimeout(r, 0));
    try {
      for (const stmt of node.body) await adderEval(stmt, scope);
    } catch (e) {
      if (e instanceof _BreakSignal) { broke = true; break; }
      if (e instanceof _ContinueSignal) continue;
      throw e;
    }
  }
  if (!broke) {
    for (const stmt of node.orelse) await adderEval(stmt, scope);
  }
  return null;
}

// ── with statement ──

async function _evalWith(node, scope) {
  const managers = [];
  for (const item of node.items) {
    const mgr = await adderEval(item.contextExpr, scope);
    const enter = mgr.__enter__ || mgr.enter;
    const exit = mgr.__exit__ || mgr.exit;
    if (typeof enter !== 'function' || typeof exit !== 'function') {
      throw new AdderError('AttributeError', `'${pyTypeName(mgr)}' does not support the context manager protocol`);
    }
    const value = await enter.call(mgr);
    if (item.optionalVar) await _assignTarget(item.optionalVar, value, scope);
    managers.push({ mgr, exit });
  }
  try {
    for (const stmt of node.body) await adderEval(stmt, scope);
    for (const { mgr, exit } of managers.reverse()) await exit.call(mgr, null, null, null);
  } catch (e) {
    for (const { mgr, exit } of managers.reverse()) {
      const suppress = await exit.call(mgr, e.pyType || 'Exception', e, null);
      if (!suppress) throw e;
    }
  }
  return null;
}

// ── try/except ──

async function _evalTry(node, scope) {
  let caught = false;
  try {
    for (const stmt of node.body) await adderEval(stmt, scope);
  } catch (e) {
    if (e instanceof _BreakSignal || e instanceof _ContinueSignal || e instanceof _ReturnSignal) throw e;
    caught = true;
    let handled = false;
    for (const handler of node.handlers) {
      let excTypeVal = null;
      if (handler.excType) try { excTypeVal = await adderEval(handler.excType, scope); } catch {}
      if (!handler.excType || _matchException(e, excTypeVal)) {
        if (handler.name) scope.set(handler.name, e);
        handled = true;
        try {
          for (const stmt of handler.body) await adderEval(stmt, scope);
        } catch (e2) {
          if (e2 instanceof _BreakSignal || e2 instanceof _ContinueSignal || e2 instanceof _ReturnSignal) throw e2;
          throw e2;
        }
        break;
      }
    }
    if (!handled) {
      // execute finally before re-throwing
      for (const stmt of node.finalbody) await adderEval(stmt, scope);
      throw e;
    }
  }
  if (!caught) {
    // else clause runs if no exception
    for (const stmt of node.orelse) await adderEval(stmt, scope);
  }
  // finally always runs
  for (const stmt of node.finalbody) await adderEval(stmt, scope);
  return null;
}

function _matchException(error, excTypeVal) {
  if (!excTypeVal) return true;
  // excTypeVal is an evaluated value — could be a function (exception constructor) or tuple of them
  if (Array.isArray(excTypeVal)) return excTypeVal.some(t => _matchException(error, t));
  if (error instanceof AdderError) {
    const targetName = typeof excTypeVal === 'function' ? (excTypeVal._pyName || excTypeVal.name) :
                       (typeof excTypeVal === 'string' ? excTypeVal : null);
    if (targetName) {
      if (error.pyType === targetName) return true;
      // Walk parent chain (e.g. FileNotFoundError → OSError)
      let pt = _excParents[error.pyType];
      while (pt) { if (pt === targetName) return true; pt = _excParents[pt]; }
    }
  }
  if (typeof excTypeVal === 'function') return error instanceof excTypeVal;
  return false;
}

// ── comprehensions ──

function _evalGenExpr(node, scope) {
  // Return an object with async iteration — lazy, not materialized
  return {
    [Symbol.asyncIterator]() {
      return _genExprIter(node, new AdderScope(scope), 0);
    },
  };
}

async function* _genExprIter(node, scope, genIdx) {
  const gen = node.generators[genIdx];
  const iterable = await adderEval(gen.iter, scope);
  const iter = iterable[Symbol.asyncIterator] ? iterable : pyIter(iterable);
  for await (const value of iter) {
    await _assignTarget(gen.target, value, scope);
    let pass = true;
    for (const ifNode of gen.ifs) {
      if (!pyBool(await adderEval(ifNode, scope))) { pass = false; break; }
    }
    if (!pass) continue;
    if (genIdx + 1 < node.generators.length) {
      yield* _genExprIter(node, scope, genIdx + 1);
    } else {
      yield await adderEval(node.elt, scope);
    }
  }
}

async function _evalComp(node, scope, kind) {
  const result = kind === 'list' ? [] : kind === 'set' ? new Set() : {};
  const compScope = new AdderScope(scope);
  await _evalCompIter(node, compScope, result, kind, 0);
  return result;
}

async function _evalCompIter(node, scope, result, kind, genIdx) {
  const gen = node.generators[genIdx];
  const iterable = await adderEval(gen.iter, scope);
  for (const value of pyIter(iterable)) {
    await _assignTarget(gen.target, value, scope);
    // check if filters
    let pass = true;
    for (const ifNode of gen.ifs) {
      if (!pyBool(await adderEval(ifNode, scope))) { pass = false; break; }
    }
    if (!pass) continue;
    if (genIdx + 1 < node.generators.length) {
      await _evalCompIter(node, scope, result, kind, genIdx + 1);
    } else {
      if (kind === 'list') {
        result.push(await adderEval(node.elt, scope));
      } else if (kind === 'set') {
        result.add(await adderEval(node.elt, scope));
      } else {
        const k = await adderEval(node.key, scope);
        const v = await adderEval(node.value, scope);
        result[k] = v;
      }
    }
  }
}

// ── imports ──

function _resolveModule(name) {
  if (adderModules[name]) return adderModules[name];
  if (typeof window !== 'undefined' && window._auditableExtensions?.[name]) return window._auditableExtensions[name];
  return null;
}

async function _loadVfsModule(name) {
  // check cache
  const cache = adderModules.sys.modules;
  if (cache[name]) return cache[name];

  const vfs = getAdderVFS();
  if (!vfs) return null;
  const pth = _getVfsPath();
  if (!pth) return null;

  // search sys.path for name.py or name/__init__.py
  let source = null, filePath = null;
  const cwd = adderModules.os?.getcwd?.() || '/';
  for (let dir of adderModules.sys.path) {
    // resolve relative entries (e.g. '.') against os.getcwd()
    if (!pth.isAbsolute(dir)) dir = pth.join(cwd, dir);
    const fp = pth.join(dir, name + '.py');
    try { source = await vfs.readFile(fp); filePath = fp; break; } catch {}
    const ip = pth.join(dir, name, '__init__.py');
    try { source = await vfs.readFile(ip); filePath = ip; break; } catch {}
  }
  if (source === null) return null;

  // parse and evaluate in a fresh scope
  const ast = adderParse(source);
  const modScope = new AdderScope();
  const builtins = adderBuiltins(() => {});
  const builtinNames = new Set(Object.keys(builtins));
  for (const [k, v] of Object.entries(builtins)) modScope.set(k, v);
  modScope.set('__name__', name);
  modScope.set('__file__', filePath);

  // placeholder in cache (handles circular imports)
  const mod = { __adderModule__: true };
  cache[name] = mod;

  await adderEval(ast, modScope);

  // extract module-level names (skip builtins and dunders we injected)
  for (const [k, v] of modScope.vars) {
    if (!builtinNames.has(k) && k !== '__name__' && k !== '__file__') mod[k] = v;
  }
  mod.__name__ = name;
  mod.__file__ = filePath;

  return mod;
}

async function _evalImport(node, scope) {
  for (const { module, alias } of node.names) {
    let mod = _resolveModule(module);
    if (mod) {
      scope.set(alias || module, mod);
      // import this — print the zen (side effect, like CPython)
      if (module === 'this' && mod.s) { const printFn = scope.has('print') ? scope.get('print') : null; if (printFn) await printFn(mod.s); }
      continue;
    }
    // try VFS import (searches sys.path for .py files)
    mod = await _loadVfsModule(module);
    if (mod) { scope.set(alias || module, mod); continue; }
    throw new AdderError('ModuleNotFoundError', `No module named '${module}'`, node.line);
  }
  return null;
}

async function _evalImportFrom(node, scope) {
  let mod = _resolveModule(node.module);
  if (!mod) mod = await _loadVfsModule(node.module);
  if (!mod) throw new AdderError('ModuleNotFoundError', `No module named '${node.module}'`, node.line);
  for (const { name, alias } of node.names) {
    if (name === '*') { for (const k of Object.keys(mod)) scope.set(k, mod[k]); }
    else {
      if (!(name in mod)) throw new AdderError('ImportError', `cannot import name '${name}' from '${node.module}'`, node.line);
      scope.set(alias || name, mod[name]);
    }
  }
  return null;
}

// re-export for cell.js

// -- highlight.js --

// Python syntax tokenizer + completions

const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
];

const PYTHON_BUILTINS = [
  'abs', 'all', 'any', 'bin', 'bool', 'bytes', 'callable', 'chr',
  'dict', 'dir', 'divmod', 'enumerate', 'filter', 'float', 'format',
  'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'hex', 'id',
  'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list',
  'locals', 'map', 'max', 'min', 'next', 'object', 'oct', 'open',
  'ord', 'pow', 'print', 'range', 'repr', 'reversed', 'round', 'set',
  'setattr', 'slice', 'sorted', 'str', 'sum', 'super', 'tuple', 'type',
  'vars', 'zip',
];

const _kwSet = new Set(PYTHON_KEYWORDS);
const _builtinSet = new Set(PYTHON_BUILTINS);

// string prefixes: f, r, b, u and combinations
const _strPrefixRe = /^[fFrRbBuU]{0,3}$/;

function tokenizePython(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code[i];

    // whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      const start = i;
      while (i < len && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n' || code[i] === '\r')) i++;
      tokens.push({ type: 'ws', text: code.slice(start, i) });
      continue;
    }

    // comment
    if (ch === '#') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }

    // decorator
    if (ch === '@' && (i === 0 || code[i - 1] === '\n')) {
      const start = i;
      i++;
      while (i < len && /[\w.]/.test(code[i])) i++;
      tokens.push({ type: 'dec', text: code.slice(start, i) });
      continue;
    }

    // strings — handle prefixes and triple/single quotes
    if (ch === '"' || ch === "'" || (_strPrefixRe.test(code.slice(Math.max(0, i - 3), i + 1).replace(/['"]/g, '')) && (code[i + 1] === '"' || code[i + 1] === "'"))) {
      // check for string prefix
      let prefixLen = 0;
      if (ch !== '"' && ch !== "'") {
        let j = i;
        while (j < len && /[fFrRbBuU]/.test(code[j])) j++;
        if (j < len && (code[j] === '"' || code[j] === "'")) {
          prefixLen = j - i;
        } else {
          // not a string, fall through to identifier
          prefixLen = 0;
        }
      }
      if (ch === '"' || ch === "'" || prefixLen > 0) {
        const start = i;
        i += prefixLen;
        if (i < len && (code[i] === '"' || code[i] === "'")) {
          const q = code[i];
          // triple quote?
          if (code[i + 1] === q && code[i + 2] === q) {
            i += 3;
            const end3 = q + q + q;
            while (i < len) {
              if (code[i] === '\\') { i += 2; continue; }
              if (code[i] === q && code[i + 1] === q && code[i + 2] === q) { i += 3; break; }
              i++;
            }
          } else {
            // single quote string
            i++;
            while (i < len && code[i] !== q && code[i] !== '\n') {
              if (code[i] === '\\') { i += 2; continue; }
              i++;
            }
            if (i < len && code[i] === q) i++;
          }
          tokens.push({ type: 'str', text: code.slice(start, i) });
          continue;
        }
      }
    }

    // numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      const start = i;
      if (ch === '0' && i + 1 < len && (code[i + 1] === 'x' || code[i + 1] === 'X' || code[i + 1] === 'o' || code[i + 1] === 'O' || code[i + 1] === 'b' || code[i + 1] === 'B')) {
        i += 2;
        while (i < len && /[\da-fA-F_]/.test(code[i])) i++;
      } else {
        while (i < len && /[\d_]/.test(code[i])) i++;
        if (i < len && code[i] === '.') { i++; while (i < len && /[\d_]/.test(code[i])) i++; }
        if (i < len && (code[i] === 'e' || code[i] === 'E')) { i++; if (i < len && (code[i] === '+' || code[i] === '-')) i++; while (i < len && /[\d_]/.test(code[i])) i++; }
      }
      if (i < len && (code[i] === 'j' || code[i] === 'J')) i++;
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }

    // identifiers / keywords / builtins
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < len && /[\w]/.test(code[i])) i++;
      const word = code.slice(start, i);

      // check if this is a string prefix followed by quote
      if (_strPrefixRe.test(word) && i < len && (code[i] === '"' || code[i] === "'")) {
        // rewind and let string handler deal with it
        i = start;
        // manually handle: prefix + string
        const strStart = i;
        i += word.length;
        const q = code[i];
        if (code[i + 1] === q && code[i + 2] === q) {
          i += 3;
          while (i < len) {
            if (code[i] === '\\') { i += 2; continue; }
            if (code[i] === q && code[i + 1] === q && code[i + 2] === q) { i += 3; break; }
            i++;
          }
        } else {
          i++;
          while (i < len && code[i] !== q && code[i] !== '\n') {
            if (code[i] === '\\') { i += 2; continue; }
            i++;
          }
          if (i < len && code[i] === q) i++;
        }
        tokens.push({ type: 'str', text: code.slice(strStart, i) });
        continue;
      }

      const type = _kwSet.has(word) ? 'kw' : _builtinSet.has(word) ? 'fn' : 'id';
      tokens.push({ type, text: code.slice(start, i) });
      continue;
    }

    // operators/punctuation
    const start = i;
    i++;
    tokens.push({ type: 'op', text: code.slice(start, i) });
  }

  return tokens;
}

function pythonCompletions(prefix) {
  const lc = prefix.toLowerCase();
  const results = [];
  for (const kw of PYTHON_KEYWORDS) {
    if (kw.toLowerCase().startsWith(lc)) results.push(kw);
  }
  for (const bi of PYTHON_BUILTINS) {
    if (bi.toLowerCase().startsWith(lc)) results.push(bi);
  }
  return results;
}

// -- cell.js --

// Python cell type handler: parseNames, findUses, execute
// adder v2 — pure JS interpreter, no WASM




// ── parseNames: extract module-scope defines from Python code ──
// Uses the AST to find assignments at module scope — descends into with/for/if/
// try/while (which don't create Python scopes) but NOT into def/class (which do).
// Falls back to regex for unparseable code.

function pythonParseNames(code) {
  try {
    const ast = adderParse(code);
    const defines = new Set();
    _collectDefines(ast.body, defines);
    return defines;
  } catch {
    // parse error — fall back to regex (column-0 only)
    return _parseNamesRegex(code);
  }
}

// Walk AST statements, collecting assignment targets.
// Descends into block statements (with/for/if/try/while) but stops at def/class.
function _collectDefines(stmts, defines) {
  for (const node of stmts) {
    switch (node.type) {
      case 'Assign':
        for (const t of node.targets) _collectTargetNames(t, defines);
        break;
      case 'AugAssign':
        _collectTargetNames(node.target, defines);
        break;
      case 'AnnAssign':
        if (node.value) _collectTargetNames(node.target, defines);
        break;
      case 'FunctionDef':
      case 'AsyncFunctionDef':
        defines.add(node.name);
        break; // don't descend — new scope
      case 'ClassDef':
        defines.add(node.name);
        break; // don't descend — new scope
      case 'Import':
        for (const alias of node.names) defines.add(alias.alias || alias.module);
        break;
      case 'ImportFrom':
        for (const alias of node.names) defines.add(alias.alias || alias.name);
        break;
      case 'For':
      case 'AsyncFor':
        _collectTargetNames(node.target, defines);
        _collectDefines(node.body, defines);
        if (node.orelse) _collectDefines(node.orelse, defines);
        break;
      case 'While':
        _collectDefines(node.body, defines);
        if (node.orelse) _collectDefines(node.orelse, defines);
        break;
      case 'If':
        _collectDefines(node.body, defines);
        if (node.orelse) _collectDefines(node.orelse, defines);
        break;
      case 'With':
      case 'AsyncWith':
        for (const item of node.items) {
          if (item.optionalVar) _collectTargetNames(item.optionalVar, defines);
        }
        _collectDefines(node.body, defines);
        break;
      case 'Try':
        _collectDefines(node.body, defines);
        if (node.handlers) {
          for (const h of node.handlers) {
            if (h.name) defines.add(h.name);
            if (h.body) _collectDefines(h.body, defines);
          }
        }
        if (node.orelse) _collectDefines(node.orelse, defines);
        if (node.finalbody) _collectDefines(node.finalbody, defines);
        break;
      default:
        break;
    }
  }
}

// Extract names from assignment targets (Name, Tuple, List, Starred)
function _collectTargetNames(target, defines) {
  if (!target) return;
  if (target.type === 'Name') { defines.add(target.id); return; }
  if (target.type === 'Tuple' || target.type === 'List') {
    for (const elt of target.elts) _collectTargetNames(elt, defines);
    return;
  }
  if (target.type === 'Starred' && target.value) {
    _collectTargetNames(target.value, defines);
  }
}

// Regex fallback for unparseable code (column-0 only, same as before)
function _parseNamesRegex(code) {
  const defines = new Set();
  const lines = code.split('\n');

  for (const line of lines) {
    if (line.length === 0 || line[0] === ' ' || line[0] === '\t') continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') continue;

    let m;
    m = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z_]\w*)/);
    if (m) { defines.add(m[1]); continue; }
    m = trimmed.match(/^class\s+([a-zA-Z_]\w*)/);
    if (m) { defines.add(m[1]); continue; }
    m = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
    if (m) {
      for (const part of m[1].split(',')) {
        const asMatch = part.trim().match(/(\w+)\s+as\s+(\w+)/);
        if (asMatch) defines.add(asMatch[2]);
        else { const name = part.trim().match(/^([a-zA-Z_]\w*)/); if (name) defines.add(name[1]); }
      }
      continue;
    }
    m = trimmed.match(/^import\s+(\w+)(?:\s+as\s+(\w+))?/);
    if (m) { defines.add(m[2] || m[1]); continue; }
    m = trimmed.match(/^(\*?[a-zA-Z_]\w*(?:\s*,\s*\*?[a-zA-Z_]\w*)+)\s*=/);
    if (m && !_isPyKeyword(m[1].split(',')[0].trim().replace(/^\*/, ''))) {
      for (const n of m[1].split(',')) {
        const name = n.trim().replace(/^\*/, '');
        if (name && /^[a-zA-Z_]\w*$/.test(name)) defines.add(name);
      }
      continue;
    }
    m = trimmed.match(/^([a-zA-Z_]\w*)\s*(?::[^=]+=|=)/);
    if (m && !_isPyKeyword(m[1])) { defines.add(m[1]); continue; }
  }
  return defines;
}

const _pyKeywords = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
]);

function _isPyKeyword(name) { return _pyKeywords.has(name); }

// ── findUses: walk the AST for Name nodes ──

function pythonFindUses(code, allDefined) {
  const selfDefines = pythonParseNames(code);
  const uses = new Set();
  try {
    const ast = adderParse(code);
    _collectNames(ast, allDefined, selfDefines, uses);
  } catch {
    // parse error — fall back to regex scan (better than no DAG wiring)
    for (const name of allDefined) {
      if (!selfDefines.has(name) && new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(code)) uses.add(name);
    }
  }
  return uses;
}

function _collectNames(node, allDefined, selfDefines, uses) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Name' && allDefined.has(node.id) && !selfDefines.has(node.id)) uses.add(node.id);
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (Array.isArray(val)) { for (const item of val) _collectNames(item, allDefined, selfDefines, uses); }
    else if (val && typeof val === 'object' && val.type) _collectNames(val, allDefined, selfDefines, uses);
  }
}

// ── execute: run Python cell code ──

async function pythonExecute(code, scopeIn, cell) {
  // capture print output
  const outputParts = [];
  const printFn = (text) => outputParts.push(text);

  // parse
  const ast = adderParse(code);

  // create scope with builtins + upstream variables + cell context
  const scope = new AdderScope();
  const builtins = adderBuiltins(printFn);
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  for (const [k, v] of Object.entries(scopeIn)) scope.set(k, v);

  // inject cell context (ui, std, load, display, etc.) if available
  // these are the same builtins JS code cells get, created by _createCellContext
  const hasCtx = !!cell._ctx;
  if (hasCtx) {
    const ctx = cell._ctx;
    // override print to render directly to the output DOM (not buffered)
    // so print output coexists with canvases and other DOM content
    scope.set('print', (...args) => {
      let sep = ' ', end = '\n';
      if (args.length > 0 && args[args.length - 1]?._kw) { const kw = args.pop(); if (kw.sep !== undefined) sep = kw.sep; if (kw.end !== undefined) end = kw.end; }
      const text = args.map(pyStr).join(sep) + end;
      ctx.display(text.endsWith('\n') ? text.slice(0, -1) : text);
      return null;
    });
    // expose key builtins — skip internal/DOM-only ones
    const expose = ['ui', 'std', 'load', 'install', 'installBinary', 'display', 'invalidation', 'worker', 'workerPool', 'notebook', 'vfs'];
    for (const name of expose) {
      if (ctx[name] !== undefined) scope.set(name, ctx[name]);
    }
  }

  // Wire VFS from auditable runtime (lazy, once)
  if (!getAdderVFS() && typeof window !== 'undefined' && window._notebookVFS) {
    setAdderVFS(window._notebookVFS, window._vfsPath);
  }
  _ensureFsModules();

  // run before-cell hooks
  const _hookStates = [];
  if (typeof window !== 'undefined' && window._adderCellHooks) {
    for (const h of window._adderCellHooks) _hookStates.push(h.before?.(scope, cell) ?? null);
  }

  // evaluate
  let lastExpr;
  try {
    lastExpr = await adderEval(ast, scope);
  } catch (e) {
    // run after-cell hooks even on error (for cleanup)
    if (typeof window !== 'undefined' && window._adderCellHooks) {
      for (let i = 0; i < window._adderCellHooks.length; i++) {
        try { window._adderCellHooks[i].after?.(_hookStates[i], {}, scope); } catch {}
      }
    }
    if (e instanceof AdderError) throw e;
    throw e;
  }

  // extract defines
  const defines = {};
  const cellDefines = pythonParseNames(code);
  for (const name of cellDefines) {
    if (scope.vars.has(name)) {
      defines[name] = scope.vars.get(name);
    }
  }

  // run after-cell hooks
  if (typeof window !== 'undefined' && window._adderCellHooks) {
    for (let i = 0; i < window._adderCellHooks.length; i++) {
      window._adderCellHooks[i].after?.(_hookStates[i], defines, scope);
    }
  }

  // build output
  if (hasCtx) {
    // output already rendered to DOM via display() — show last expression too
    if (lastExpr !== undefined && lastExpr !== null) {
      if (typeof lastExpr === 'object' && typeof lastExpr._repr_html_ === 'function') cell._ctx.display(lastExpr);
      else cell._ctx.display(pyRepr(lastExpr));
    }
    return { defines };
  }
  // no cell context (standalone/test mode) — return output as string
  const parts = [];
  const printOutput = outputParts.join('');
  if (printOutput) parts.push(printOutput.endsWith('\n') ? printOutput.slice(0, -1) : printOutput);
  if (lastExpr !== undefined && lastExpr !== null) {
    parts.push(pyRepr(lastExpr));
  }
  return { defines, output: parts.length ? parts.join('\n') : undefined };
}


function _jsonReplacer(key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

// -- tag.js --

// adder tagged template + mpy alias
// Pure JS evaluation — no WASM bridge




async function adderTag(strings, ...values) {
  // build code with _v0, _v1 placeholders
  let code = strings[0];
  for (let i = 0; i < values.length; i++) {
    code += '_v' + i + strings[i + 1];
  }

  // dedent: strip common leading whitespace
  const lines = code.split('\n');
  let start = 0;
  if (lines[start].trim() === '') start++;
  let minIndent = Infinity;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].match(/^ */)[0].length;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent > 0 && minIndent < Infinity) {
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim() !== '') lines[i] = lines[i].slice(minIndent);
    }
  }
  // trim leading blank line
  if (start > 0 && lines[0].trim() === '') lines.shift();
  // trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  code = lines.join('\n');

  // parse
  const ast = adderParse(code);

  // create scope with builtins + injected values
  const scope = new AdderScope();
  const builtins = adderBuiltins(() => {}); // discard print output in tag context
  for (const [k, v] of Object.entries(builtins)) scope.set(k, v);
  for (let i = 0; i < values.length; i++) scope.set('_v' + i, values[i]);

  // evaluate
  await adderEval(ast, scope);

  // extract non-underscore-prefixed names
  const result = {};
  for (const [k, v] of scope.vars) {
    if (!k.startsWith('_') && typeof v !== 'function' || (typeof v === 'function' && v._pyFunc)) {
      if (!k.startsWith('_')) result[k] = v;
    }
  }
  return result;
}

// back-compat alias
const mpy = adderTag;

// -- register.js --

// Registration: cell type, tagged language, plugin, extension





const handler = {
  label: 'adder',
  color: '#4B8BBE',
  shortcut: 'n',
  editDebounce: 500,
  parseNames: pythonParseNames,
  syntaxCheck: (code) => {
    try { adderParse(code); return true; }
    catch { return false; }
  },
  findUses: pythonFindUses,
  execute: pythonExecute,
  tokenize: tokenizePython,
  completions: (prefix) => pythonCompletions(prefix),
  createEditor: (cell, onChange) => {
    if (!window._ctCreateEditor) return null;
    const wrap = document.createElement('div');
    wrap.className = 'editor-wrap';
    const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'adder', onChange);
    return {
      el: wrap,
      getCode: () => editor.view.state.doc.toString(),
      setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
      focus: () => editor.focus(),
      destroy: () => editor.destroy(),
    };
  },
};

// guard: only register once (module may be re-imported from different blob URLs)
if (!window._cellTypes?.['adder']) {
  // register 'adder' cell type (shows in insert bar)
  if (window.registerCellType) {
    window.registerCellType('adder', handler, '@gcu/adder');
  } else if (window._cellTypes) {
    window._cellTypes['adder'] = handler;
  }

  // register tagged language for both adder`` and mpy`` syntax highlighting
  window._taggedLanguages = window._taggedLanguages || {};
  window._taggedLanguages['adder'] = {
    tokenize: tokenizePython,
    completions: pythonCompletions,
  };
  window._taggedLanguages['mpy'] = {
    tokenize: tokenizePython,
    completions: pythonCompletions,
  };

  // register as plugin
  if (window.registerPlugin) {
    window.registerPlugin('@gcu/adder', { description: 'JS-targeting Python dialect — adder cells and tagged template' });
  } else if (window._auditablePlugins) {
    window._auditablePlugins.set('@gcu/adder', { description: 'JS-targeting Python dialect — adder cells and tagged template' });
  }

  // global tags
  window.adder = adderTag;
  window.mpy = mpy;
}

const adder = {
  adderTag,
  mpy,
  handler,
  pythonParseNames,
  pythonFindUses,
  tokenizePython,
  pythonCompletions,
  setVFS: setAdderVFS,
};

export { adder };
