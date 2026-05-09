// @gcu/air — Textual IR pretty-printer + parser (v0.3 §3.4 + §3.10)
//
// Round-trippable text format for AIR modules. Pretty for humans;
// validator messages and debug logs use it instead of JSON dumps. The
// parser (parseText) is the inverse of prettyPrint — together they
// enable golden-file IR tests, on-disk IR snapshots, and offline tooling
// that can't import the JS lowerer.
//
// Format overview:
//
//   module {
//     defines: [grid, n]
//     imports: [ui, std]
//
//     %0 = const 60
//     store n, %0
//     for_region {
//       init: [
//         %1 = const 0
//         store i, %1
//       ]
//       test: [
//         %2 = lt load(i), load(n)
//       ]
//       test_val: %2
//       update: [
//         %3 = const 1
//         %4 = add load(i), %3
//         store i, %4
//       ]
//       body: [
//         array_set load(grid), load(i), load(i)
//       ]
//     }
//   }

import { OP_SCHEMA, forEachRegion } from './schema.js';

const INDENT = '  ';

/**
 * Pretty-print an AIR module to a string.
 */
function prettyPrint(module) {
  const out = [];
  out.push('module {');
  if (module.defines && [...module.defines].length) {
    out.push(`${INDENT}defines: [${[...module.defines].sort().join(', ')}]`);
  }
  if (module.imports && [...module.imports].length) {
    out.push(`${INDENT}imports: [${[...module.imports].sort().join(', ')}]`);
  }
  out.push('');
  for (const op of module.ops) {
    _printOp(op, INDENT, out);
  }
  out.push('}');
  return out.join('\n');
}

function _printOp(op, prefix, out) {
  const schema = OP_SCHEMA[op.op];
  const head = op.id ? `${op.id} = ` : '';

  // Region ops: print the multi-line block form
  if (schema && (schema.regions || op.cases || op.members)) {
    out.push(`${prefix}${head}${op.op}${_renderArgsInline(op, schema)} {`);
    _printRegionsAndExtras(op, schema, prefix + INDENT, out);
    out.push(`${prefix}}`);
    return;
  }

  // Single-line form: `<id> = <op> <args>`
  out.push(`${prefix}${head}${op.op}${_renderArgsInline(op, schema)}${_renderExtrasInline(op, schema)}`);
}

function _renderArgsInline(op, schema) {
  if (!schema || !op.args) return '';
  if (op.args.length === 0) return '';

  if (schema.arity === 'fixed') {
    const parts = [];
    for (let i = 0; i < op.args.length; i++) {
      parts.push(_renderArg(op.args[i], schema.args[i]));
    }
    return ' ' + parts.join(', ');
  }

  switch (schema.args) {
    case 'ssa_list':
      return ' ' + op.args.map(a => String(a)).join(', ');
    case 'pair_list':
      return ' ' + op.args.map(p => {
        if (!p) return 'null';
        if (p.spread) return `...${p.id}`;
        return `${JSON.stringify(p.key)}: ${p.id}`;
      }).join(', ');
    case 'method_call':
      // [obj, method, ...args]
      if (op.args.length < 2) return ' ' + op.args.map(_lit).join(', ');
      return ` ${op.args[0]}.${op.args[1]}(${op.args.slice(2).join(', ')})`;
    case 'ta_new_args':
      if (op.args.length < 1) return '';
      return ` <${op.args[0]}>(${op.args.slice(1).join(', ')})`;
    case 'label_optional':
      return op.args.length ? ' ' + JSON.stringify(op.args[0]) : '';
    case 'ssa_optional':
      return op.args.length ? ' ' + op.args[0] : '';
    default:
      return ' ' + op.args.map(_lit).join(', ');
  }
}

function _renderArg(v, kind) {
  if (kind === 'ssa') return String(v);
  if (kind === 'name' || kind === 'key' || kind === 'label' ||
      kind === 'meta_name' || kind === 'meta_prop' ||
      kind === 'func_name' || kind === 'class_name' || kind === 'source')
    return JSON.stringify(v);
  if (kind === 'literal') return _lit(v);
  return _lit(v);
}

function _lit(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof RegExp) return v.toString();
  try { return JSON.stringify(v); } catch { return String(v); }
}

function _renderExtrasInline(op, schema) {
  if (!schema || !schema.extras) return '';
  const parts = [];
  for (const [key, spec] of Object.entries(schema.extras)) {
    const val = op[key];
    if (val === undefined || val === null) continue;
    // Skip 'phi_list?', 'param_list', 'member_list', 'case_list' — these
    // are heavy and printed inside region blocks; if we're here, the op
    // has none of those (no region map), so they shouldn't be present.
    if (spec === 'phi_list?' || spec === 'param_list' || spec === 'member_list' ||
        spec === 'case_list') continue;
    parts.push(`${key}=${_renderExtraValue(val, spec)}`);
  }
  return parts.length ? `  // ${parts.join(', ')}` : '';
}

function _renderExtraValue(val, spec) {
  if (spec === 'ssa' || spec === 'ssa?') return String(val);
  if (spec === 'string' || spec === 'string?') return JSON.stringify(val);
  if (spec === 'bool' || spec === 'bool?') return String(val);
  if (spec === 'type' || spec === 'type?') {
    return val && val.kind ? val.kind : '?';
  }
  return _lit(val);
}

function _printRegionsAndExtras(op, schema, prefix, out) {
  // Print extras first (inline scalars), then regions.
  if (schema && schema.extras) {
    for (const [key, spec] of Object.entries(schema.extras)) {
      const val = op[key];
      if (val === undefined || val === null) continue;
      if (spec === 'phi_list?' || spec === 'phi_list') {
        if (Array.isArray(val) && val.length) {
          out.push(`${prefix}${key}: [`);
          for (const phi of val) {
            const cnt = phi.var
              ? `${phi.var}: then=${phi.then_val ?? '_'} else=${phi.else_val ?? '_'}`
              : JSON.stringify(phi);
            out.push(`${prefix}${INDENT}${cnt}`);
          }
          out.push(`${prefix}]`);
        }
        continue;
      }
      if (spec === 'param_list') {
        out.push(`${prefix}${key}: ${_renderParamList(val)}`);
        continue;
      }
      if (spec === 'member_list') {
        // members printed via forEachRegion's synthetic regions; skip here.
        continue;
      }
      if (spec === 'case_list') {
        // cases printed via forEachRegion below
        continue;
      }
      // Scalar extra
      out.push(`${prefix}${key}: ${_renderExtraValue(val, spec)}`);
    }
  }

  // Regions
  forEachRegion(op, (rname, rops) => {
    if (rops.length === 0) {
      out.push(`${prefix}${rname}: []`);
      return;
    }
    out.push(`${prefix}${rname}: [`);
    for (const child of rops) {
      _printOp(child, prefix + INDENT, out);
    }
    out.push(`${prefix}]`);
  });
}

function _renderParamList(params) {
  if (!Array.isArray(params)) return '?';
  const parts = params.map(p => {
    if (typeof p === 'string') return p;
    if (p && p.name) {
      let s = p.name;
      if (p.type && p.type.kind && p.type.kind !== 'dynamic') s += `: ${p.type.kind}`;
      if (p.default !== undefined) s += ' = …';
      return s;
    }
    return _lit(p);
  });
  return `(${parts.join(', ')})`;
}

// =============================================================================
// Parser — textual IR → AIR module
// =============================================================================
//
// Recursive descent over a small token stream. Handles every shape that
// prettyPrint emits for the in-tree op set: header lines, fixed-arity ssa
// args, ssa_list, pair_list (object_new), method_call (call_method),
// ta_new_args (ta_new), label/ssa optional args, and the region ops
// (if_region, for_region, for_of_region, for_in_region, loop_region,
// switch_region, try_region, labeled, func_region, class_region).
//
// Out of scope for this iteration:
//   - func_region / class_region: prettyPrint emits human-readable shorthand
//     for params (`params: (x)`) and types (`ret_type: dynamic`) that drops
//     structural detail (param type annotations, default-value markers). A
//     strict round-trip would need either a richer text form or accepting
//     the lossy shorthand and reconstructing best-effort. Deferred.
//   - switch_region member bodies and class member bodies use synthetic
//     region names (`cases[0].body`, `members[0].body`) that prettyPrint
//     renders inline; the parser currently doesn't recognize the indexed
//     name form.
// parseText raises AirParseError on these. prettyPrint still renders them
// (validator messages stay informative); round-trip is best-effort for
// modules that contain only the simpler op shapes — sufficient for
// golden-file testing of the common cases.

class AirParseError extends Error {
  constructor(message, line, col) {
    super(`${message} at line ${line}:${col}`);
    this.name = 'AirParseError';
    this.line = line;
    this.col = col;
  }
}

// ── Tokenizer ────────────────────────────────────────────────────────

function tokenize(src) {
  const tokens = [];
  let line = 1, col = 1, i = 0;

  const advance = (n) => {
    for (let k = 0; k < n; k++) {
      if (src[i + k] === '\n') { line++; col = 1; } else { col++; }
    }
    i += n;
  };

  while (i < src.length) {
    const ch = src[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1);
      continue;
    }

    // Single-line comment (used for `// extras=…` annotations on inline ops)
    if (ch === '/' && src[i + 1] === '/') {
      // Stash as a token so the parser can pick up extras attached to an op
      const start = i;
      const startLine = line, startCol = col;
      while (i < src.length && src[i] !== '\n') { i++; col++; }
      tokens.push({ type: 'comment', value: src.slice(start + 2, i).trim(), line: startLine, col: startCol });
      continue;
    }

    // Spread `...` must come before single-`.` punct since punct is greedy.
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ type: 'spread', line, col });
      advance(3);
      continue;
    }

    // Punctuation. `.` and `<>` are punct so call_method's `%obj.method(args)`
    // and ta_new's `<kind>(args)` round-trip. Numbers consume their own
    // decimal point inside the number branch below before reaching here.
    if ('{}[](),:=.<>'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, line, col });
      advance(1);
      continue;
    }

    // String literal
    if (ch === '"') {
      const startLine = line, startCol = col;
      let val = '';
      i++; col++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[i + 1];
          if (e === 'n') val += '\n';
          else if (e === 't') val += '\t';
          else if (e === 'r') val += '\r';
          else if (e === '\\') val += '\\';
          else if (e === '"') val += '"';
          else if (e === '\'') val += '\'';
          else val += e;
          i += 2; col += 2;
        } else {
          if (src[i] === '\n') { line++; col = 1; } else col++;
          val += src[i++];
        }
      }
      if (src[i] !== '"') throw new AirParseError('unterminated string', startLine, startCol);
      i++; col++;
      tokens.push({ type: 'string', value: val, line: startLine, col: startCol });
      continue;
    }

    // SSA id: %N or %name
    if (ch === '%') {
      const startLine = line, startCol = col;
      let val = '%';
      advance(1);
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
        val += src[i++]; col++;
      }
      tokens.push({ type: 'ssa', value: val, line: startLine, col: startCol });
      continue;
    }

    // Number / bigint
    if ((ch >= '0' && ch <= '9') || (ch === '-' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const startLine = line, startCol = col;
      let val = '';
      if (ch === '-') { val += '-'; advance(1); }
      while (i < src.length && /[0-9.eE+\-]/.test(src[i])) { val += src[i++]; col++; }
      if (src[i] === 'n') {
        // BigInt literal
        i++; col++;
        tokens.push({ type: 'bigint', value: BigInt(val), line: startLine, col: startCol });
      } else {
        tokens.push({ type: 'number', value: Number(val), line: startLine, col: startCol });
      }
      continue;
    }

    // Identifier / keyword
    if (/[A-Za-z_]/.test(ch)) {
      const startLine = line, startCol = col;
      let val = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { val += src[i++]; col++; }
      // Special literals
      if (val === 'true' || val === 'false') {
        tokens.push({ type: 'bool', value: val === 'true', line: startLine, col: startCol });
      } else if (val === 'null') {
        tokens.push({ type: 'null', line: startLine, col: startCol });
      } else if (val === 'undefined') {
        tokens.push({ type: 'undefined', line: startLine, col: startCol });
      } else {
        tokens.push({ type: 'ident', value: val, line: startLine, col: startCol });
      }
      continue;
    }

    throw new AirParseError(`unexpected character '${ch}'`, line, col);
  }

  tokens.push({ type: 'eof', line, col });
  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }
  peek(offset = 0) { return this.toks[this.pos + offset]; }
  next() { return this.toks[this.pos++]; }
  check(type, value) {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  eat(type, value) {
    if (!this.check(type, value)) {
      const t = this.peek();
      throw new AirParseError(
        `expected ${type}${value !== undefined ? ` '${value}'` : ''}, got ${t.type}${t.value !== undefined ? ` '${t.value}'` : ''}`,
        t.line, t.col
      );
    }
    return this.next();
  }
  // Consume any number of trailing comment tokens (extras live in comments)
  skipComments() {
    while (this.check('comment')) this.next();
  }
  parseValue() {
    const t = this.peek();
    if (t.type === 'string') return this.next().value;
    if (t.type === 'number') return this.next().value;
    if (t.type === 'bigint') return this.next().value;
    if (t.type === 'bool') return this.next().value;
    if (t.type === 'null') { this.next(); return null; }
    if (t.type === 'undefined') { this.next(); return undefined; }
    if (t.type === 'ident') return this.next().value;
    if (t.type === 'ssa') return this.next().value;
    throw new AirParseError(`expected value, got ${t.type}`, t.line, t.col);
  }
}

function parseText(src) {
  const tokens = tokenize(src);
  const p = new Parser(tokens);

  p.eat('ident', 'module');
  p.eat('punct', '{');

  const module = {
    ops: [],
    defines: new Set(),
    imports: new Set(),
  };

  // Optional header lines
  while (true) {
    p.skipComments();
    if (p.check('ident', 'defines')) {
      p.next(); p.eat('punct', ':'); p.eat('punct', '[');
      while (!p.check('punct', ']')) {
        const name = p.eat('ident').value;
        module.defines.add(name);
        if (p.check('punct', ',')) p.next();
      }
      p.eat('punct', ']');
    } else if (p.check('ident', 'imports')) {
      p.next(); p.eat('punct', ':'); p.eat('punct', '[');
      while (!p.check('punct', ']')) {
        const name = p.eat('ident').value;
        module.imports.add(name);
        if (p.check('punct', ',')) p.next();
      }
      p.eat('punct', ']');
    } else {
      break;
    }
  }

  // Top-level ops
  while (!p.check('punct', '}')) {
    p.skipComments();
    if (p.check('punct', '}')) break;
    const op = parseOp(p);
    if (op) module.ops.push(op);
  }
  p.eat('punct', '}');

  return module;
}

function parseOp(p) {
  // Optional ssa-id assignment
  let id = null;
  if (p.check('ssa') && p.peek(1)?.type === 'punct' && p.peek(1).value === '=') {
    id = p.next().value;
    p.eat('punct', '=');
  }

  const name = p.eat('ident').value;
  const schema = OP_SCHEMA[name];
  if (!schema) {
    throw new AirParseError(`unknown op '${name}'`, p.peek().line, p.peek().col);
  }

  const op = { op: name, args: [], id };
  // Region ops use `name { ... }` shape with regions/extras inside the braces
  const isRegionOp = !!(schema.regions || schema.extras?.cases || schema.extras?.members);

  if (isRegionOp) {
    parseRegionArgsInline(p, op, schema);
    p.eat('punct', '{');
    parseRegionBody(p, op, schema);
    p.eat('punct', '}');
  } else {
    parseInlineArgs(p, op, schema);
    p.skipComments();  // extras printed as `// key=value`
  }

  // Apply schema-default extras
  if (schema.extras) {
    for (const [k, spec] of Object.entries(schema.extras)) {
      if (op[k] === undefined && spec === 'phi_list?') op[k] = [];
    }
  }

  return op;
}

function parseInlineArgs(p, op, schema) {
  if (schema.arity === 'fixed') {
    const expected = schema.args.length;
    if (expected === 0) return;
    for (let i = 0; i < expected; i++) {
      const kind = schema.args[i];
      op.args.push(parseTypedArg(p, kind));
      if (i < expected - 1) p.eat('punct', ',');
    }
    return;
  }

  switch (schema.args) {
    case 'ssa_list':
      // Bare ssa followed by `=` is the NEXT op's assignment header, not
      // an arg of this one. Without this peek, `%0 = array_new` would
      // greedy-consume `%1` from the following line.
      while (p.check('ssa')) {
        const next = p.peek(1);
        if (next && next.type === 'punct' && next.value === '=') break;
        op.args.push(p.next().value);
        if (p.check('punct', ',')) p.next();
        else break;
      }
      break;
    case 'pair_list':
      // `"key": %ssa, ...%spread`
      while (p.check('string') || p.check('spread')) {
        if (p.check('spread')) {
          p.next();
          const id = p.eat('ssa').value;
          op.args.push({ spread: true, id });
        } else {
          const key = p.next().value;
          p.eat('punct', ':');
          const id = p.eat('ssa').value;
          op.args.push({ key, id });
        }
        if (p.check('punct', ',')) p.next();
        else break;
      }
      break;
    case 'method_call':
      // Pretty form: `%obj.method(%a, %b)`. Comma form also accepted.
      op.args.push(p.eat('ssa').value);
      if (p.check('punct', '.')) {
        p.next();
        // Method name: ident or string
        if (p.check('string')) op.args.push(p.next().value);
        else op.args.push(p.eat('ident').value);
        p.eat('punct', '(');
        while (!p.check('punct', ')')) {
          op.args.push(p.eat('ssa').value);
          if (p.check('punct', ',')) p.next();
        }
        p.eat('punct', ')');
      } else if (p.check('punct', ',')) {
        // Comma form: %obj, "method", %a, %b
        p.next();
        op.args.push(p.eat('string').value);
        while (p.check('punct', ',')) {
          p.next();
          op.args.push(p.eat('ssa').value);
        }
      }
      break;
    case 'ta_new_args':
      // Pretty form: `<kind>(%1, %2)`. Comma form: `"kind", %1, %2`.
      if (p.check('punct', '<')) {
        p.next();
        // kind is an ident (like f64, i32) inside angles
        const kind = p.check('string') ? p.next().value : p.eat('ident').value;
        op.args.push(kind);
        p.eat('punct', '>');
        p.eat('punct', '(');
        while (!p.check('punct', ')')) {
          op.args.push(p.eat('ssa').value);
          if (p.check('punct', ',')) p.next();
        }
        p.eat('punct', ')');
      } else {
        op.args.push(parseTypedArg(p, 'kind'));
        while (p.check('punct', ',')) {
          p.next();
          if (p.check('ssa')) op.args.push(p.next().value);
        }
      }
      break;
    case 'label_optional':
      if (p.check('string')) op.args.push(p.next().value);
      break;
    case 'ssa_optional':
      if (p.check('ssa')) op.args.push(p.next().value);
      break;
  }
}

function parseTypedArg(p, kind) {
  if (kind === 'ssa') return p.eat('ssa').value;
  if (kind === 'name' || kind === 'key' || kind === 'label' ||
      kind === 'meta_name' || kind === 'meta_prop' ||
      kind === 'func_name' || kind === 'class_name' || kind === 'source' ||
      kind === 'kind') {
    return p.eat('string').value;
  }
  if (kind === 'literal') return p.parseValue();
  return p.parseValue();
}

function parseRegionArgsInline(p, op, schema) {
  // Some region ops have leading inline args (e.g. if_region's condition,
  // for_of_region's iterable, labeled's name). Parse them like fixed args
  // before the brace.
  if (schema.arity === 'fixed' && schema.args.length > 0) {
    for (let i = 0; i < schema.args.length; i++) {
      op.args.push(parseTypedArg(p, schema.args[i]));
      if (i < schema.args.length - 1) p.eat('punct', ',');
    }
  }
}

function parseRegionBody(p, op, schema) {
  // Inside the braces: extras (key: value) and regions (name: [ops])
  while (!p.check('punct', '}')) {
    p.skipComments();
    if (p.check('punct', '}')) break;

    // Lookahead: ident ':'
    if (!p.check('ident')) {
      throw new AirParseError(`expected key in region body`, p.peek().line, p.peek().col);
    }
    const keyTok = p.next();
    p.eat('punct', ':');

    // Region (`key: [ ... ]`) or scalar extra (`key: <value>`)
    if (p.check('punct', '[')) {
      p.next();
      const ops = [];
      while (!p.check('punct', ']')) {
        p.skipComments();
        if (p.check('punct', ']')) break;
        ops.push(parseOp(p));
      }
      p.eat('punct', ']');
      op[keyTok.value] = ops;
    } else {
      // Scalar extra
      op[keyTok.value] = p.parseValue();
    }
  }
}

export { prettyPrint, parseText, AirParseError };
