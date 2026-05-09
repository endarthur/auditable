// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/soft/src/  Build: node ext/soft/build.js
// @gcu/soft — English keyword programming language for Auditable
// Soft cells, tagged template, data query pipeline.

// -- inlined: ../air/src/types.js (AIR type singletons) --

// @gcu/air — Type system
// Plain objects, no classes. See spec §2.

// --- Singleton type constructors ---

const I8    = Object.freeze({ kind: 'i8' });
const U8    = Object.freeze({ kind: 'u8' });
const I16   = Object.freeze({ kind: 'i16' });
const U16   = Object.freeze({ kind: 'u16' });
const I32   = Object.freeze({ kind: 'i32' });
const U32   = Object.freeze({ kind: 'u32' });
const I64   = Object.freeze({ kind: 'i64' });
const U64   = Object.freeze({ kind: 'u64' });
const F32   = Object.freeze({ kind: 'f32' });
const F64   = Object.freeze({ kind: 'f64' });
const BOOL  = Object.freeze({ kind: 'bool' });
const STRING = Object.freeze({ kind: 'string' });
const VOID  = Object.freeze({ kind: 'void' });
const DYNAMIC = Object.freeze({ kind: 'dynamic' });

function typedArray(element) {
  return Object.freeze({ kind: 'typed_array', element });
}

function array(element) {
  return Object.freeze({ kind: 'array', element });
}

function object(fields) {
  return Object.freeze({ kind: 'object', fields });
}

function func(params, ret) {
  return Object.freeze({ kind: 'function', params, ret });
}

// --- Type annotation mapping (spec §2.2) ---

const TS_TYPE_MAP = {
  // GCU numeric types
  'i8': I8, 'u8': U8, 'i16': I16, 'u16': U16,
  'i32': I32, 'u32': U32, 'i64': I64, 'u64': U64,
  'f32': F32, 'f64': F64, 'bool': BOOL,
  // Standard TS types
  'number': F64, 'boolean': BOOL, 'string': STRING, 'void': VOID,
  // Standard typed array constructors
  'Int8Array': typedArray('i8'), 'Uint8Array': typedArray('u8'),
  'Int16Array': typedArray('i16'), 'Uint16Array': typedArray('u16'),
  'Int32Array': typedArray('i32'), 'Uint32Array': typedArray('u32'),
  'Float32Array': typedArray('f32'), 'Float64Array': typedArray('f64'),
  'BigInt64Array': typedArray('i64'), 'BigUint64Array': typedArray('u64'),
  // GCU typed array aliases
  'i8array': typedArray('i8'), 'u8array': typedArray('u8'),
  'i16array': typedArray('i16'), 'u16array': typedArray('u16'),
  'i32array': typedArray('i32'), 'u32array': typedArray('u32'),
  'f32array': typedArray('f32'), 'f64array': typedArray('f64'),
  'i64array': typedArray('i64'), 'u64array': typedArray('u64'),
};

// Resolve a TS annotation AST node to an AIR type
function resolveAnnotation(node) {
  if (!node) return DYNAMIC;
  const ann = node.typeAnnotation || node;
  switch (ann.type) {
    case 'TSTypeAnnotation':
      return resolveAnnotation(ann.typeAnnotation);
    case 'TSTypeReference':
      return TS_TYPE_MAP[ann.typeName?.name] || DYNAMIC;
    case 'TSNumberKeyword': return F64;
    case 'TSBooleanKeyword': return BOOL;
    case 'TSStringKeyword': return STRING;
    case 'TSVoidKeyword': return VOID;
    case 'TSArrayType': {
      const el = resolveAnnotation(ann.elementType);
      return array(el);
    }
    default: return DYNAMIC;
  }
}

// --- Type predicates ---

function isNumeric(t) {
  const k = t.kind;
  return k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
         k === 'i32' || k === 'u32' || k === 'i64' || k === 'u64' ||
         k === 'f32' || k === 'f64';
}

function isInteger(t) {
  const k = t.kind;
  return k === 'i8' || k === 'u8' || k === 'i16' || k === 'u16' ||
         k === 'i32' || k === 'u32' || k === 'i64' || k === 'u64';
}

function isFloat(t) {
  return t.kind === 'f32' || t.kind === 'f64';
}

function isSigned(t) {
  const k = t.kind;
  return k === 'i8' || k === 'i16' || k === 'i32' || k === 'i64';
}

function isDynamic(t) {
  return t.kind === 'dynamic';
}

function isConcrete(t) {
  return t.kind !== 'dynamic';
}

// --- Type width (bits) for promotion ---

const TYPE_WIDTH = {
  'i8': 8, 'u8': 8, 'i16': 16, 'u16': 16,
  'i32': 32, 'u32': 32, 'i64': 64, 'u64': 64,
  'f32': 32, 'f64': 64,
};

// Promotion hierarchy lookup
const PROMOTE_RANK = {
  'i8': 0, 'u8': 0, 'i16': 1, 'u16': 1,
  'i32': 2, 'u32': 2, 'i64': 3, 'u64': 3,
  'f32': 4, 'f64': 5,
};

const RANK_TO_SIGNED   = { 0: I8, 1: I16, 2: I32, 3: I64 };
const RANK_TO_UNSIGNED = { 0: U8, 1: U16, 2: U32, 3: U64 };

// --- Arithmetic result type (spec §2.5) ---

function arithmeticResult(lhs, rhs) {
  if (isDynamic(lhs) || isDynamic(rhs)) return DYNAMIC;
  if (!isNumeric(lhs) || !isNumeric(rhs)) return DYNAMIC;

  const lr = PROMOTE_RANK[lhs.kind];
  const rr = PROMOTE_RANK[rhs.kind];

  // Both float
  if (isFloat(lhs) && isFloat(rhs)) {
    return lr >= rr ? lhs : rhs;
  }
  // One float, one integer → float wins
  if (isFloat(lhs)) return lhs;
  if (isFloat(rhs)) return rhs;

  // Both integer — promote narrower, signed wins on same width
  if (lr !== rr) {
    const maxRank = Math.max(lr, rr);
    // use signed if either is signed
    if (isSigned(lhs) || isSigned(rhs)) return RANK_TO_SIGNED[maxRank];
    return RANK_TO_UNSIGNED[maxRank];
  }
  // Same width — signed wins
  if (isSigned(lhs) || isSigned(rhs)) return RANK_TO_SIGNED[lr];
  return RANK_TO_UNSIGNED[lr];
}

// Comparison always → bool
function comparisonResult(lhs, rhs) {
  return BOOL;
}

// Bitwise ops always → i32
function bitwiseResult() {
  return I32;
}

// --- Type equality ---

function typeEq(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'typed_array') return a.element === b.element;
  if (a.kind === 'array') return typeEq(a.element, b.element);
  if (a.kind === 'function') {
    if (a.params.length !== b.params.length) return false;
    if (!typeEq(a.ret, b.ret)) return false;
    return a.params.every((p, i) => typeEq(p, b.params[i]));
  }
  if (a.kind === 'object') {
    const aKeys = [...a.fields.keys()].sort();
    const bKeys = [...b.fields.keys()].sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, i) => k === bKeys[i] && typeEq(a.fields.get(k), b.fields.get(k)));
  }
  return true;
}

// -- inlined: ../air/src/scope.js (AIR ScopeChain) --

// @gcu/air — ScopeChain (v0.3 §3.3)
//
// Single shared lexical-scope abstraction for everything in AIR that
// tracks names → values across nested scopes. Today three places do
// this independently:
//
//   1. lower/js.js findMutableCaptured — closure-detection scope walker
//      using a `scopes` array of Sets directly.
//   2. emit-js.js Scope — `let` declaration tracker (Set-of-names with
//      a parent pointer).
//   3. lower/js.js ctx.symbols — flat Map<name, ssaId>. Doesn't pop at
//      scope exit, leading to silent type-prop wrongness when an inner
//      scope shadows an outer name (the spec's §2.3 latent bug).
//
// This class is the abstraction the first two migrate to in v0.3. The
// ctx.symbols migration is its own session — adding push/pop semantics
// to a previously-flat lookup is a real behavior change, not a rename.
//
// Design: name → any value (ssa id, boolean, type, …). Each layer is a
// Map so a name can be set to falsy values (null, 0, false). `has`
// distinguishes "name exists with value undefined" from "name not bound".

class ScopeChain {
  /**
   * @param {ScopeChain | null} parent
   */
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  /**
   * Bind a name in THIS scope (does not propagate up).
   */
  set(name, value) {
    this.bindings.set(name, value);
    return this;
  }

  /**
   * Look up a name. Returns the binding from the innermost scope where
   * it exists, or undefined if unbound at every level.
   */
  get(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.get(name) : undefined;
  }

  /**
   * True if the name is bound at this scope or any enclosing scope.
   */
  has(name) {
    if (this.bindings.has(name)) return true;
    return this.parent ? this.parent.has(name) : false;
  }

  /**
   * True if the name is bound in any enclosing scope, but NOT in this
   * scope. Used by closure-detection: "is this name visible from outer
   * lexical context, such that an assignment captures it?"
   */
  hasInOuter(name) {
    return this.parent ? this.parent.has(name) : false;
  }

  /**
   * Remove a binding. Walks up the chain and deletes from the innermost
   * scope where the name is bound. Returns true if a binding was removed,
   * false if the name wasn't bound anywhere visible.
   *
   * Used by emit-js's `ctx.exprs` consume semantics — when a single-use
   * SSA value is inlined at its consumer, the entry is deleted from
   * whichever frame registered it.
   */
  delete(name) {
    if (this.bindings.has(name)) { this.bindings.delete(name); return true; }
    return this.parent ? this.parent.delete(name) : false;
  }

  /**
   * Return a new child scope with `this` as parent. Caller is responsible
   * for assigning the result somewhere — e.g. `chain = chain.push()`.
   */
  push() {
    return new ScopeChain(this);
  }

  /**
   * Return the parent scope, dropping `this`. Throws if at root.
   */
  pop() {
    if (!this.parent) {
      throw new Error('ScopeChain: cannot pop the root scope');
    }
    return this.parent;
  }

  /**
   * Snapshot every binding visible from this scope, with the innermost
   * value winning for shadowed names. Useful for debugging and for
   * code that needs a flat Map (legacy callers like lower/js.js's
   * `symbol_table: new Map(ctx.symbols)` snapshot).
   */
  flatten() {
    const out = new Map();
    // Walk from root → leaf so inner shadows the outer naturally
    const chain = [];
    for (let s = this; s; s = s.parent) chain.push(s);
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const [k, v] of chain[i].bindings) out.set(k, v);
    }
    return out;
  }

  /**
   * Iterate every binding visible from this scope (innermost wins).
   * Yields [name, value] pairs.
   */
  *entries() {
    yield* this.flatten();
  }

  /**
   * Depth from root. Root is 0, first child is 1, etc.
   */
  depth() {
    let d = 0;
    for (let s = this.parent; s; s = s.parent) d++;
    return d;
  }
}

// -- inlined: ../air/src/lower/base.js (AIR shared LowerCtx) --

// @gcu/air — Shared lowering scaffolding
//
// First step of the lowerer-frontend extraction (spec_inbox/lang/
// air-lowerer-frontend-spec.md). Three lowerers (JS / adder / soft)
// each had their own LowerCtx, mkOp, and id-counter — identical fields
// and methods, divergent only in language-specific extras (mutable-
// capture analysis for JS, sync-function detection for adder, etc.).
//
// This module hosts the common parts; each lowerer extends `BaseLowerCtx`
// with whatever it needs on top. Cross-package consumers (adder, soft)
// inline this file at build time the same way they already inline
// types.js — see their build.js scripts.
//
// Subsequent extraction sessions can lift more shared scaffolding here:
// BinOp dispatch tables (BINARY_OP_MAP), control-flow lowering helpers,
// class-lowering primitives. Today's scope is just the context object.



/**
 * Per-instance SSA-id generator. Each lowering invocation gets its own,
 * so cell A's ids don't collide with cell B's even when both lowerers
 * share this module.
 */
function makeIdGen() {
  let n = 0;
  return {
    next: () => '%' + (n++),
    reset: () => { n = 0; },
    peek: () => n,
  };
}

/**
 * Build an op record. Mirror of the per-language mkOp helpers each
 * lowerer used to keep — identical except for the type default. We
 * default to DYNAMIC across the board, matching adder/soft's prior
 * behavior; JS's lowerer used to leave type undefined for some ops,
 * but downstream `if (type) types.set(...)` checks make the difference
 * unobservable.
 */
function mkOp(id, op, args, type, loc, extra) {
  const o = { id, op, args, type: type || DYNAMIC, loc };
  if (extra) Object.assign(o, extra);
  return o;
}

/**
 * Shared lowering context. Each lowerer subclasses this to add
 * language-specific fields (mutable-capture set, sync-function set,
 * adder-specific declared tracker, etc.) and provides a per-language
 * `loc(node)` because AST shapes differ.
 *
 * Fields:
 *   ops      — flat list of ops emitted into the current region. Region
 *              lowering swaps ops to a sub-list, lowers the body, and
 *              restores ops to the parent list (regions hold their body
 *              in their own ops array).
 *   symbols  — ScopeChain<name, ssa_id>. Push at function/block
 *              boundaries to scope inner-fn shadows correctly (see F's
 *              ctx.symbols migration). Adder/soft have not yet added
 *              push/pop discipline; today they treat the chain as a
 *              flat root frame.
 *   types    — Map<ssa_id, Type> for value tracking inside the lowerer
 *              (passes do their own; this is the lowerer's local view).
 *   topLevel — true when emitting at the cell's root scope (so let/const
 *              declarations register as cell exports). Each region
 *              lowering toggles to false.
 *   defines  — set of names this cell exports.
 *   imports  — set of free names this cell references but doesn't define
 *              (cross-cell deps).
 *   source   — original source string, for the opaque escape hatch.
 */
class BaseLowerCtx {
  constructor() {
    this.ops = [];
    this.symbols = new ScopeChain();
    this.types = new Map();
    this.topLevel = true;
    this.defines = new Set();
    this.imports = new Set();
    this.source = null;
    this._idGen = makeIdGen();
  }

  emit(op, args, type, loc, extra) {
    const o = mkOp(this._idGen.next(), op, args, type, loc, extra);
    this.ops.push(o);
    if (type) this.types.set(o.id, type);
    return o;
  }

  // Subclasses override to provide language-specific node→{line, col}.
  loc(_node) { return null; }
}

// -- tokenize.js --

// soft — tokenizer
// Produces a flat token array from Soft source code.

// ── token types ──

const T = {
  NUM: 'NUM', STR: 'STR', ID: 'ID', KW: 'KW',
  OP: 'OP', CMP: 'CMP', CONCAT: 'CONCAT',
  BANG: 'BANG', LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  COMMA: 'COMMA', NL: 'NL', EOF: 'EOF',
  BITOP: 'BITOP', REGEX: 'REGEX',
};

// ── keywords ──

const KEYWORDS = new Set([
  // data query
  'take', 'from', 'keep', 'drop', 'only', 'where', 'pick', 'get',
  'average', 'total', 'count', 'smallest', 'largest', 'mean', 'sum',
  'min', 'max', 'group', 'by', 'each', 'in', 'sort', 'ascending',
  'descending', 'first', 'last', 'top', 'append', 'push',
  // general
  'set', 'to', 'of', 'the', 'a', 'an', 'that', 'this',
  'say', 'show', 'put', 'into', 'being', 'record',
  'load', 'save', 'open', 'close', 'write', 'read',
  'ask', 'wait', 'there', 'do', 'explain', 'assume', 'suppose',
  'try', 'fails', 'called', 'it', 'call', 'run', 'result',
  // control flow
  'if', 'unless', 'otherwise', 'else', 'end', 'repeat', 'times',
  'while', 'until', 'with', 'for', 'stop', 'skip', 'by',
  // functions/events
  'define', 'return', 'takes', 'use', 'as', 'many', 'all', 'on',
  // comparison/logic
  'above', 'below', 'is', 'not', 'and', 'or', 'between',
  'contains', 'matches', 'greater', 'less', 'more', 'under',
  'equals', 'equal', 'than', 'does', 'least', 'most',
  // arithmetic
  'plus', 'minus', 'over', 'mod', 'raised', 'negative',
  'bitwise', 'bit', 'shift', 'left', 'right', 'xor',
  // pipe
  'then',
  // other
  'round', 'rows', 'true', 'false', 'nothing', 'empty',
  'length', 'item', 'at', 'add', 'remove', 'list', 'yes', 'no',
  'character', 'characters', 'word', 'words', 'line', 'lines',
  'number', 'second', 'seconds', 'millisecond', 'milliseconds',
  'reading', 'writing', 'appending', 'boolean', 'time',
  'make',
]);

// ── string escape processing ──

function processEscapes(raw) {
  let out = '', i = 0;
  while (i < raw.length) {
    if (raw[i] !== '\\' || i + 1 >= raw.length) { out += raw[i++]; continue; }
    const c = raw[++i]; i++;
    switch (c) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      default: out += '\\' + c;
    }
  }
  return out;
}

// ── locale support ──

let _localeLookup = null; // word → canonical English keyword
let _localeNoise = null;  // set of noise words

function softSetLocale(locale) {
  if (!locale) { _localeLookup = null; _localeNoise = null; return; }
  _localeLookup = {};
  for (const [canonical, forms] of Object.entries(locale.keywords || {})) {
    for (const form of forms) _localeLookup[form.toLowerCase()] = canonical;
  }
  _localeNoise = locale.noise ? new Set(locale.noise.map(w => w.toLowerCase())) : null;
}

function softGetLocale() { return _localeLookup; }

// ── main tokenizer ──

function softTokenize(code) {
  const tokens = [];
  let pos = 0, line = 1, col = 0;
  const len = code.length;

  function ch(offset) { return pos + (offset || 0) < len ? code[pos + (offset || 0)] : ''; }
  function advance() { const c = code[pos++]; if (c === '\n') { line++; col = 0; } else { col++; } return c; }
  function peek() { return pos < len ? code[pos] : ''; }

  function emit(type, value, startLine, startCol) {
    tokens.push({ type, value, line: startLine, col: startCol });
  }

  function isIdStart(c) { return /[\p{L}_]/u.test(c); }
  function isIdCont(c) { return /[\p{L}\p{N}_]/u.test(c); }
  function isDigit(c) { return c >= '0' && c <= '9'; }

  while (pos < len) {
    const startLine = line, startCol = col;
    const c = peek();

    // ── whitespace (not newline) ──
    if (c === ' ' || c === '\t' || c === '\r') {
      advance();
      continue;
    }

    // ── newline ──
    if (c === '\n') {
      advance();
      // collapse consecutive newlines
      if (tokens.length === 0 || tokens[tokens.length - 1].type === T.NL) continue;
      emit(T.NL, '\n', startLine, startCol);
      continue;
    }

    // ── comment ──
    if (c === '#') {
      while (pos < len && peek() !== '\n') advance();
      continue;
    }

    // ── string ──
    if (c === '"') {
      advance(); // skip opening quote
      let raw = '';
      while (pos < len && peek() !== '"') {
        if (peek() === '\\' && pos + 1 < len) {
          raw += advance(); // backslash
          raw += advance(); // escaped char
        } else {
          raw += advance();
        }
      }
      if (pos < len) advance(); // skip closing quote
      emit(T.STR, processEscapes(raw), startLine, startCol);
      continue;
    }

    // ── number ──
    if (isDigit(c) || (c === '-' && isDigit(ch(1)) && shouldNegateBeUnary(tokens))) {
      let num = '';
      if (c === '-') num += advance();
      // hex, binary, octal
      if (peek() === '0' && pos + 1 < len && 'xXbBoO'.includes(ch(1))) {
        num += advance(); // 0
        num += advance(); // x/b/o
        while (pos < len && /[0-9a-fA-F]/.test(peek())) num += advance();
      } else {
        while (pos < len && isDigit(peek())) num += advance();
        if (pos < len && peek() === '.' && pos + 1 < len && isDigit(ch(1))) {
          num += advance(); // .
          while (pos < len && isDigit(peek())) num += advance();
        }
      }
      emit(T.NUM, num, startLine, startCol);
      continue;
    }

    // ── identifier / keyword ──
    if (isIdStart(c)) {
      let word = '';
      while (pos < len && (isIdCont(peek()) || peek() === '.')) word += advance();
      // locale: resolve to canonical English
      const lc = word.toLowerCase();
      if (_localeLookup && _localeLookup[lc]) {
        word = _localeLookup[lc];
      }
      // locale noise words → canonical noise
      if (_localeNoise && _localeNoise.has(lc)) {
        word = 'the'; // map to English noise word
      }
      // dot-path identifiers are always ID, never KW
      if (word.includes('.')) {
        emit(T.ID, word, startLine, startCol);
      } else if (KEYWORDS.has(word)) {
        emit(T.KW, word, startLine, startCol);
      } else {
        emit(T.ID, word, startLine, startCol);
      }
      continue;
    }

    // ── two-character operators ──
    const two = code.slice(pos, pos + 2);
    if (two === '**') { advance(); advance(); emit(T.OP, '**', startLine, startCol); continue; }
    if (two === '==') { advance(); advance(); emit(T.CMP, '==', startLine, startCol); continue; }
    if (two === '!=') { advance(); advance(); emit(T.CMP, '!=', startLine, startCol); continue; }
    if (two === '>=') { advance(); advance(); emit(T.CMP, '>=', startLine, startCol); continue; }
    if (two === '<=') { advance(); advance(); emit(T.CMP, '<=', startLine, startCol); continue; }
    if (two === '<<') { advance(); advance(); emit(T.BITOP, '<<', startLine, startCol); continue; }
    if (two === '>>') { advance(); advance(); emit(T.BITOP, '>>', startLine, startCol); continue; }

    // ── single-character operators ──
    if (c === '+') { advance(); emit(T.OP, '+', startLine, startCol); continue; }
    if (c === '-') { advance(); emit(T.OP, '-', startLine, startCol); continue; }
    if (c === '*') { advance(); emit(T.OP, '*', startLine, startCol); continue; }
    if (c === '/') {
      // regex literal: only after 'matches' keyword
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      if (prev && prev.type === T.KW && prev.value === 'matches') {
        advance(); // skip opening /
        let pattern = '';
        while (pos < len && peek() !== '/') {
          if (peek() === '\\' && pos + 1 < len) { pattern += advance(); pattern += advance(); }
          else { pattern += advance(); }
        }
        if (pos < len) advance(); // skip closing /
        let flags = '';
        while (pos < len && /[gimsuy]/.test(peek())) flags += advance();
        emit(T.REGEX, flags ? pattern + '/' + flags : pattern, startLine, startCol);
        continue;
      }
      advance(); emit(T.OP, '/', startLine, startCol); continue;
    }
    if (c === '%') { advance(); emit(T.OP, '%', startLine, startCol); continue; }
    if (c === '>') { advance(); emit(T.CMP, '>', startLine, startCol); continue; }
    if (c === '<') { advance(); emit(T.CMP, '<', startLine, startCol); continue; }
    if (c === '~') { advance(); emit(T.BITOP, '~', startLine, startCol); continue; }
    if (c === '&') { advance(); emit(T.CONCAT, '&', startLine, startCol); continue; }
    if (c === '!') { advance(); emit(T.BANG, '!', startLine, startCol); continue; }
    if (c === '(') { advance(); emit(T.LPAREN, '(', startLine, startCol); continue; }
    if (c === ')') { advance(); emit(T.RPAREN, ')', startLine, startCol); continue; }
    if (c === ',') { advance(); emit(T.COMMA, ',', startLine, startCol); continue; }

    // ── unknown — skip ──
    advance();
  }

  // ensure trailing NL
  if (tokens.length > 0 && tokens[tokens.length - 1].type !== T.NL) {
    emit(T.NL, '\n', line, col);
  }
  emit(T.EOF, '', line, col);
  return tokens;
}

// ── helper: should a `-` be treated as unary negation? ──
// True when `-` is at the start or follows an operator/keyword/NL/comma/lparen

function shouldNegateBeUnary(tokens) {
  if (tokens.length === 0) return true;
  const prev = tokens[tokens.length - 1];
  return prev.type === T.OP || prev.type === T.CMP || prev.type === T.CONCAT ||
    prev.type === T.BANG || prev.type === T.LPAREN || prev.type === T.COMMA ||
    prev.type === T.NL || prev.type === T.KW || prev.type === T.BITOP;
}

// -- parse.js --

// soft — recursive descent parser
// Produces an AST from a token stream. No external dependencies.


// ── AST node constructors ──

let _curLine = 1;
const N = (type, props) => ({ type, line: _curLine, ...props });

// ── parser ──

function softParse(code) {
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
    if (eatKw('for') || eatKw('to')) { /* optional filler: "repeat for each" / "repita para cada" */ }
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
    if (kw('from') || kw('of')) {
      pos++; // "repeat from X to Y" / "repita de X para Y"
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
    // optional filler: "keep if ...", "keep rows where ...", "keep lines where ..."
    if (!eatKw('if')) {
      const saved = pos;
      if ((eatKw('rows') || eatKw('lines')) && !eatKw('where')) pos = saved; // backtrack if no 'where'
    }
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

// -- eval.js --

// soft — tree-walking evaluator
// Executes a Soft AST. No external dependencies except the parser.


// ── scope (lexical, with prototype chain) ──

function createScope(parent) {
  const scope = Object.create(parent || null);
  scope._parent = parent || null;
  return scope;
}

function scopeSet(scope, name, value) {
  // walk up to find owning scope; if none, create in current
  let s = scope;
  while (s) {
    if (Object.prototype.hasOwnProperty.call(s, name) && name !== '_parent') {
      s[name] = value; return;
    }
    if (!s._parent) break;
    s = s._parent;
  }
  scope[name] = value;
}

// ── return/stop/skip signals ──

class ReturnSignal { constructor(value) { this.value = value; } }
class StopSignal {}
class SkipSignal {}

// ── stringify (§12) ──

function softString(value) {
  if (value === null || value === undefined) return 'nothing';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (typeof value[0] === 'object' && value[0] !== null) return formatTable(value);
    return value.map(softString).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => `${k}: ${softString(v)}`).join(', ');
  }
  return String(value);
}

function formatTable(rows) {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k => Math.max(k.length, ...rows.map(r => softString(r[k]).length)));
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map(w => '─'.repeat(w)).join('──');
  const body = rows.map(r => keys.map((k, i) => softString(r[k]).padEnd(widths[i])).join('  ')).join('\n');
  return header + '\n' + sep + '\n' + body;
}

// ── truthiness (§8) ──

function isTruthy(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

// ── builtins (§10) ──

const BUILTINS = {
  abs: (x) => Math.abs(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  sqrt: (x) => Math.sqrt(x),
  random: () => Math.random(),
  number: (x) => Number(x),
  text: (x) => softString(x),
};

// ── glob matching ──

function globMatch(str, pattern) {
  // convert glob to regex
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      let cls = '[';
      i++;
      if (i < pattern.length && pattern[i] === '!') { cls += '^'; i++; }
      while (i < pattern.length && pattern[i] !== ']') { cls += pattern[i]; i++; }
      cls += ']';
      re += cls;
    }
    else re += c.replace(/[.*+?^${}()|\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re, 'i').test(str);
}

// ── main evaluator ──

function softEval(code, options) {
  const ast = typeof code === 'string' ? softParse(code) : code;
  const output = [];
  const globals = (options && options.globals) || {};
  const scope = createScope(null);

  // inject builtins into scope
  for (const [name, fn] of Object.entries(BUILTINS)) scope[name] = fn;

  // default host globals
  const defaultGlobals = {
    Math: typeof Math !== 'undefined' ? Math : {},
    Text: {
      upper: (s) => String(s).toUpperCase(),
      lower: (s) => String(s).toLowerCase(),
      trim: (s) => String(s).trim(),
      split: (s, sep) => String(s).split(sep),
      replace: (s, a, b) => String(s).replaceAll(a, b),
      starts: (s, p) => String(s).startsWith(p),
      ends: (s, p) => String(s).endsWith(p),
      slice: (s, a, b) => String(s).slice(a, b),
    },
    List: {
      range: (a, b, step) => { const r = []; if (b === undefined) { b = a; a = 0; } step = step || 1; for (let i = a; step > 0 ? i < b : i > b; i += step) r.push(i); return r; },
      reverse: (arr) => [...arr].reverse(),
      flat: (arr) => arr.flat(),
      unique: (arr) => [...new Set(arr)],
      join: (arr, sep) => arr.join(sep ?? ', '),
    },
  };

  // inject defaults, then user-provided globals override
  for (const [name, val] of Object.entries(defaultGlobals)) scope[name] = val;
  for (const [name, val] of Object.entries(globals)) scope[name] = val;

  // inject upstream scope (from Auditable DAG)
  const scopeInit = (options && options.scopeInit) || {};
  for (const [name, val] of Object.entries(scopeInit)) scope[name] = val;

  // Optional callback fired for every `say` statement — streaming hook for
  // REPLs and CLI-style consumers that want output as it's produced rather
  // than waiting for the `output` array at end of evaluation.
  const onSay = (options && options.onSay) || null;

  // host functions (file I/O, DOM, events — injected by cell handler)
  const host = (options && options.host) || {};

  // it — implicit result variable
  scope.it = null;

  let steps = 0;
  const maxSteps = (options && options.maxSteps) || 50000;
  let callDepth = 0;
  const maxCallDepth = (options && options.maxCallDepth) || 1000;

  function step() {
    if (++steps > maxSteps) throw new Error('Step limit exceeded (possible infinite loop)');
  }

  // ── eval node ──

  function lineError(node, e) {
    if (e._softLine) throw e; // already tagged
    const msg = e.message || String(e);
    const err = new Error(node.line ? `${msg} (line ${node.line})` : msg);
    err._softLine = true;
    throw err;
  }

  function evalNode(node, sc) {
    step();
    switch (node.type) {
      case 'Program': return evalProgram(node, sc);
      case 'Say': return evalSay(node, sc);
      case 'Set': return evalSet(node, sc);
      case 'SetOf': return evalSetOf(node, sc);
      case 'SetChunk': return evalSetChunk(node, sc);
      case 'If': return evalIf(node, sc);
      case 'While': return evalWhile(node, sc);
      case 'Repeat': return evalRepeat(node, sc);
      case 'ForEach': return evalForEach(node, sc);
      case 'RangeLoop': return evalRangeLoop(node, sc);
      case 'Define': return evalDefine(node, sc);
      case 'Return': return evalReturn(node, sc);
      case 'ExprStmt': return evalExprStmt(node, sc);
      case 'Capture': return evalCapture(node, sc);
      case 'Stop': throw new StopSignal();
      case 'Skip': throw new SkipSignal();
      case 'Add': return evalAdd(node, sc);
      case 'Remove': return evalRemove(node, sc);
      case 'Try': return evalTry(node, sc);
      case 'Assume': return evalAssume(node, sc);
      case 'Suppose': return evalSuppose(node, sc);
      case 'Use': return evalUse(node, sc);
      case 'On': return evalOn(node, sc);
      case 'Load': return evalLoad(node, sc);
      case 'Save': return evalSave(node, sc);
      case 'Make': return evalMake(node, sc);
      case 'Explain': return null; // TODO
      // pipeline transforms
      case 'Take': return evalTake(node, sc);
      case 'Filter': return evalFilter(node, sc);
      case 'Sort': return evalSort(node, sc);
      case 'Aggregate': return evalAggregate(node, sc);
      case 'Count': return evalCount(node, sc);
      case 'Limit': return evalLimit(node, sc);
      case 'Group': return evalGroup(node, sc);
      case 'Pick': return evalPick(node, sc);
      case 'Round': return evalRound(node, sc);
      case 'With': return evalWith(node, sc);
      case 'PipeCalled': return evalPipeCalled(node, sc);
      case 'Pipeline': return evalPipeline(node, sc);
      case 'PipeCall': return evalPipeCall(node, sc);
      default: throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  function evalExpr(node, sc) {
    step();
    try { return evalExprInner(node, sc); } catch (e) {
      if (e instanceof ReturnSignal || e instanceof StopSignal || e instanceof SkipSignal) throw e;
      if (e._softLine) throw e;
      lineError(node, e);
    }
  }
  function evalExprInner(node, sc) {
    switch (node.type) {
      case 'Num': return node.value;
      case 'Str': return node.value;
      case 'Regex': {
        // value is "pattern" or "pattern/flags"
        const v = node.value;
        const slashIdx = v.lastIndexOf('/');
        if (slashIdx > 0) return new RegExp(v.slice(0, slashIdx), v.slice(slashIdx + 1));
        return new RegExp(v);
      }
      case 'Bool': return node.value;
      case 'Nothing': return null;
      case 'Ref': return evalRef(node, sc);
      case 'Group': return evalExpr(node.expr, sc);
      case 'BinOp': return evalBinOp(node, sc);
      case 'Unary': return evalUnary(node, sc);
      case 'Compare': return evalCompare(node, sc);
      case 'Logic': return evalLogic(node, sc);
      case 'Of': return evalOf(node, sc);
      case 'LengthOf': return evalLengthOf(node, sc);
      case 'Call': return evalCall(node, sc);
      case 'List': return node.items.map(i => evalExpr(i, sc));
      case 'Record': return evalRecord(node, sc);
      case 'RecordWith': return evalRecordWith(node, sc);
      case 'Ternary': return evalTernary(node, sc);
      case 'Between': return evalBetween(node, sc);
      case 'TypeCheck': return evalTypeCheck(node, sc);
      case 'Invoke': return evalInvoke(node, sc);
      case 'RoundExpr': {
        const val = evalExpr(node.value, sc);
        const f = Math.pow(10, node.places);
        return Math.round(val * f) / f;
      }
      case 'Juxtapose': return node.parts.map(p => softString(evalExpr(p, sc))).join('');
      case 'Chunk': return evalChunk(node, sc);
      case 'ChunkRange': return evalChunkRange(node, sc);
      case 'CountChunks': return evalCountChunks(node, sc);
      case 'ThereIs': return sc[node.name] !== undefined && sc[node.name] !== null;
      case 'ThereIsNo': return sc[node.name] === undefined || sc[node.name] === null;
      default: throw new Error(`Unknown expr type: ${node.type}`);
    }
  }

  // ── statement evaluators ──

  function evalProgram(node, sc) {
    let result = null;
    for (const stmt of node.body) {
      result = evalNode(stmt, sc);
      if (result instanceof ReturnSignal) return result.value;
    }
    return result;
  }

  function evalBlock(body, sc) {
    let result = null;
    for (const stmt of body) {
      result = evalNode(stmt, sc);
      if (result instanceof ReturnSignal) return result;
    }
    return result;
  }

  function evalSay(node, sc) {
    const val = evalExpr(node.value, sc);
    output.push(val); // push raw value — cell handler decides rendering
    if (onSay) onSay(val);
    return null;
  }

  function evalSet(node, sc) {
    const val = evalExpr(node.value, sc);
    scopeSet(sc, node.name, val);
    return null;
  }

  // set grade of row to 60 → path = ['grade', 'row'], value = 60
  // resolves right to left: row.grade = 60
  function evalSetOf(node, sc) {
    const val = evalExpr(node.value, sc);
    const path = node.path; // ['grade', 'row'] or ['name', 'author', 'book']
    // rightmost name is the root object
    const root = sc[path[path.length - 1]];
    if (root == null) throw new Error(`"${path[path.length - 1]}" is not defined`);
    if (path.length === 2) {
      root[path[0]] = val;
    } else {
      // walk from right to left: book.author.name = val
      let obj = root;
      for (let i = path.length - 2; i > 0; i--) obj = obj[path[i]];
      obj[path[0]] = val;
    }
    return null;
  }

  // set word 2 of text to "big"
  function evalSetChunk(node, sc) {
    const val = evalExpr(node.value, sc);
    const idx = evalExpr(node.index, sc);
    const str = String(sc[node.target]);
    let result;
    switch (node.kind) {
      case 'character': {
        const chars = [...str];
        chars[idx] = String(val);
        result = chars.join('');
        break;
      }
      case 'word': {
        const words = str.split(/(\s+)/); // preserve whitespace
        let wordIdx = 0;
        for (let i = 0; i < words.length; i++) {
          if (!/^\s+$/.test(words[i])) {
            if (wordIdx === idx) { words[i] = String(val); break; }
            wordIdx++;
          }
        }
        result = words.join('');
        break;
      }
      case 'line': {
        const lines = str.split('\n');
        lines[idx] = String(val);
        result = lines.join('\n');
        break;
      }
      case 'item': {
        const items = str.split(',').map(s => s.trim());
        items[idx] = String(val);
        result = items.join(', ');
        break;
      }
      default: throw new Error(`Unknown chunk kind: ${node.kind}`);
    }
    scopeSet(sc, node.target, result);
    return null;
  }

  function evalIf(node, sc) {
    const cond = evalExpr(node.cond, sc);
    if (isTruthy(cond)) {
      return evalBlock(node.body, sc);
    } else if (node.elseBody) {
      return evalBlock(node.elseBody, sc);
    }
    return null;
  }

  function evalWhile(node, sc) {
    while (isTruthy(evalExpr(node.cond, sc))) {
      try {
        const r = evalBlock(node.body, sc);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalRepeat(node, sc) {
    const n = evalExpr(node.count, sc);
    for (let i = 0; i < n; i++) {
      try {
        const r = evalBlock(node.body, sc);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalForEach(node, sc) {
    const iter = evalExpr(node.iter, sc);
    if (!Array.isArray(iter)) throw new Error(`Cannot iterate over ${typeof iter}`);
    const loopScope = createScope(sc);
    for (const item of iter) {
      loopScope[node.varName] = item;
      try {
        const r = evalBlock(node.body, loopScope);
        if (r instanceof ReturnSignal) return r;
      } catch (e) {
        if (e instanceof StopSignal) break;
        if (e instanceof SkipSignal) continue;
        throw e;
      }
    }
    return null;
  }

  function evalRangeLoop(node, sc) {
    const from = evalExpr(node.from, sc);
    const to = evalExpr(node.to, sc);
    let stepVal = node.step ? evalExpr(node.step, sc) : (from <= to ? 1 : -1);
    const loopScope = createScope(sc);
    if (stepVal > 0) {
      for (let i = from; i <= to; i += stepVal) {
        loopScope[node.varName] = i;
        try {
          const r = evalBlock(node.body, loopScope);
          if (r instanceof ReturnSignal) return r;
        } catch (e) {
          if (e instanceof StopSignal) break;
          if (e instanceof SkipSignal) continue;
          throw e;
        }
      }
    } else {
      for (let i = from; i >= to; i += stepVal) {
        loopScope[node.varName] = i;
        try {
          const r = evalBlock(node.body, loopScope);
          if (r instanceof ReturnSignal) return r;
        } catch (e) {
          if (e instanceof StopSignal) break;
          if (e instanceof SkipSignal) continue;
          throw e;
        }
      }
    }
    return null;
  }

  function evalDefine(node, sc) {
    const fn = makeSoftFunction(node.name, node.sig, node.body, sc);
    sc[node.name] = fn;
    return null;
  }

  function makeSoftFunction(name, sig, body, defScope) {
    const fn = function (...args) {
      const callScope = createScope(defScope);
      // bind params from args
      let argIdx = 0;
      for (const p of sig) {
        if (p.variadic) {
          callScope[p.param] = args.slice(argIdx);
          break;
        }
        if (argIdx < args.length) {
          callScope[p.param] = args[argIdx++];
        } else if (p.default !== undefined) {
          // default may be an AST node (from parser) — evaluate it
          callScope[p.param] = (typeof p.default === 'object' && p.default && p.default.type)
            ? evalExpr(p.default, defScope) : p.default;
        } else {
          callScope[p.param] = null;
        }
      }
      const result = evalBlock(body, callScope);
      if (result instanceof ReturnSignal) return result.value;
      return null;
    };
    fn._softName = name;
    fn._softSig = sig;
    return fn;
  }

  function evalReturn(node, sc) {
    const val = node.value ? evalExpr(node.value, sc) : null;
    return new ReturnSignal(val);
  }

  function evalExprStmt(node, sc) {
    const val = evalExpr(node.expr, sc);
    sc.it = val;
    return val;
  }

  const STMT_TYPES = new Set(['Pipeline', 'Take', 'Filter', 'Sort', 'Aggregate', 'Count',
    'Limit', 'Group', 'Pick', 'Round', 'With', 'PipeCalled', 'ExprStmt']);
  function evalCapture(node, sc) {
    // Pipeline and transform nodes are statements, not expressions
    const val = STMT_TYPES.has(node.expr.type) ? evalNode(node.expr, sc) : evalExpr(node.expr, sc);
    sc.it = val;
    scopeSet(sc, node.name, sc.it); // use sc.it because pipeline transforms set it
    return null;
  }

  function evalAdd(node, sc) {
    const val = evalExpr(node.value, sc);
    const arr = sc[node.target];
    if (!Array.isArray(arr)) throw new Error(`Cannot add to non-list "${node.target}"`);
    arr.push(val);
    return null;
  }

  function evalRemove(node, sc) {
    const val = evalExpr(node.value, sc);
    const arr = sc[node.target];
    if (!Array.isArray(arr)) throw new Error(`Cannot remove from non-list "${node.target}"`);
    const idx = arr.indexOf(val);
    if (idx !== -1) arr.splice(idx, 1);
    return null;
  }

  function evalTry(node, sc) {
    try {
      return evalBlock(node.body, sc);
    } catch (e) {
      if (e instanceof ReturnSignal || e instanceof StopSignal || e instanceof SkipSignal) throw e;
      const handlerScope = createScope(sc);
      handlerScope['the error'] = e.message || String(e);
      return evalBlock(node.handler, handlerScope);
    }
  }

  function evalAssume(node, sc) {
    const cond = evalExpr(node.cond, sc);
    if (!isTruthy(cond)) {
      const msg = node.message ? evalExpr(node.message, sc) : 'Assumption failed';
      throw new Error(softString(msg));
    }
    return null;
  }

  function evalSuppose(node, sc) {
    const oldVal = sc[node.name];
    const val = evalExpr(node.value, sc);
    sc[node.name] = val;
    const result = evalBlock(node.body, sc);
    sc[node.name] = oldVal;
    if (result instanceof ReturnSignal) return result;
    return null;
  }

  function evalUse(node, sc) {
    // resolve dot-path from globals
    const parts = node.path.split('.');
    let val = globals;
    for (const p of parts) {
      if (val == null) throw new Error(`Cannot resolve "${node.path}"`);
      val = val[p];
    }
    const name = node.alias || parts[parts.length - 1];
    sc[name] = val;
    return null;
  }

  // ── host-dependent evaluators (file I/O, DOM, events) ──

  function evalLoad(node, sc) {
    const path = evalExpr(node.path, sc);
    if (!host.load) throw new Error('load is not available in this environment');
    const data = host.load(path);
    sc.it = data;
    if (node.name) scopeSet(sc, node.name, data);
    return data;
  }

  function evalSave(node, sc) {
    const value = evalExpr(node.value, sc);
    const path = evalExpr(node.path, sc);
    if (!host.save) throw new Error('save is not available in this environment');
    host.save(path, value);
    return null;
  }

  function evalMake(node, sc) {
    const tag = evalExpr(node.tag, sc);
    const parent = node.parent ? evalExpr(node.parent, sc) : null;
    if (!host.make) throw new Error('make is not available in this environment');
    const el = host.make(tag, parent);
    sc.it = el;
    if (node.name) scopeSet(sc, node.name, el);
    return el;
  }

  function evalOn(node, sc) {
    const event = node.event;
    const target = node.target ? sc[node.target] : null;
    if (!host.on) return null; // silently skip in headless
    const handler = (e) => {
      const handlerScope = createScope(sc);
      // inject event object properties into handler scope
      if (e) {
        if (node.target) handlerScope[node.target] = e.target || e;
        handlerScope['the event'] = e;
        // common event properties as bare names
        if (e.key !== undefined) handlerScope.key = e.key;
        if (e.target) handlerScope.target = e.target;
        if (e.value !== undefined) handlerScope.value = e.value;
        else if (e.target?.value !== undefined) handlerScope.value = e.target.value;
      }
      try { evalBlock(node.body, handlerScope); } catch (err) {
        if (err instanceof StopSignal) return;
        if (!(err instanceof ReturnSignal)) throw err;
      }
    };
    host.on(event, target, handler);
    return null;
  }

  // ── pipeline evaluators ──

  // helper: evaluate an expression in row context (bare identifiers resolve against row first)
  function evalInRowContext(node, row, sc) {
    const rowScope = createScope(sc);
    for (const [k, v] of Object.entries(row)) rowScope[k] = v;
    return evalExpr(node, rowScope);
  }

  function evalCondInRowContext(node, row, sc) {
    const rowScope = createScope(sc);
    for (const [k, v] of Object.entries(row)) rowScope[k] = v;
    return isTruthy(evalExpr(node, rowScope));
  }

  function pipeSet(sc, val) { sc.it = val; return val; }

  function evalTake(node, sc) {
    const val = sc[node.name];
    if (val === undefined) throw new Error(`"${node.name}" is not defined`);
    return pipeSet(sc, val);
  }

  function evalFilter(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot filter: not a list`);
    const keep = node.op === 'keep';
    const result = data.filter(row => {
      const match = evalCondInRowContext(node.cond, row, sc);
      return keep ? match : !match;
    });
    return pipeSet(sc, result);
  }

  function evalSort(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot sort: not a list`);
    const field = node.field;
    const desc = node.order === 'descending';
    const sorted = [...data].sort((a, b) => {
      const va = a[field], vb = b[field];
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
      return 0;
    });
    return pipeSet(sc, sorted);
  }

  function evalAggregate(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot aggregate: not a list`);
    const vals = data.map(r => r[node.field]);
    let result;
    switch (node.op) {
      case 'average': result = vals.reduce((s, v) => s + v, 0) / vals.length; break;
      case 'total': result = vals.reduce((s, v) => s + v, 0); break;
      case 'smallest': result = Math.min(...vals); break;
      case 'largest': result = Math.max(...vals); break;
      default: throw new Error(`Unknown aggregate: ${node.op}`);
    }
    return pipeSet(sc, result);
  }

  function evalCount(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot count: not a list`);
    return pipeSet(sc, data.length);
  }

  function evalLimit(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot limit: not a list`);
    const n = node.n ? evalExpr(node.n, sc) : 1;
    const result = node.op === 'first' ? data.slice(0, n) : data.slice(-n);
    return pipeSet(sc, result);
  }

  function evalGroup(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot group: not a list`);
    const field = node.field;
    const groups = new Map();
    for (const row of data) {
      const key = row[field];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const result = [];
    for (const [key, rows] of groups) {
      result.push({ [field]: key, rows, count: rows.length });
    }
    return pipeSet(sc, result);
  }

  function evalPick(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot pick: not a list`);
    if (node.fields.length === 1) {
      // single field → flat array of values
      const f = node.fields[0];
      return pipeSet(sc, data.map(r => r[f]));
    }
    // multiple fields → array of objects
    const result = data.map(r => {
      const obj = {};
      for (const f of node.fields) obj[f] = r[f];
      return obj;
    });
    return pipeSet(sc, result);
  }

  function evalRound(node, sc) {
    const val = node.value ? evalExpr(node.value, sc) : sc.it;
    if (typeof val !== 'number') throw new Error(`Cannot round: not a number`);
    const factor = Math.pow(10, node.places);
    return pipeSet(sc, Math.round(val * factor) / factor);
  }

  function evalWith(node, sc) {
    const data = sc.it;
    if (!Array.isArray(data)) throw new Error(`Cannot compute column: not a list`);
    const result = data.map(row => {
      const val = evalInRowContext(node.expr, row, sc);
      return { ...row, [node.field]: val };
    });
    return pipeSet(sc, result);
  }

  function evalPipeCalled(node, sc) {
    const val = evalNode(node.step, sc);
    scopeSet(sc, node.name, sc.it);
    return val;
  }

  function evalPipeline(node, sc) {
    for (const step of node.steps) evalNode(step, sc);
    return sc.it;
  }

  // function piping: "value then func" → func(value)
  function evalPipeCall(node, sc) {
    const val = sc.it;
    const expr = node.expr;
    // Call node: prepend piped value as first arg
    if (expr.type === 'Call') {
      const fn = expr.name.includes('.') ? evalDotPath(expr.name, sc) : sc[expr.name];
      if (typeof fn !== 'function') throw new Error(`"${expr.name}" is not a function`);
      const args = [val, ...expr.args.map(a => evalExpr(a, sc))];
      return pipeSet(sc, fn(...args));
    }
    // Ref node: call with piped value as only arg
    if (expr.type === 'Ref') {
      const fn = expr.name.includes('.') ? evalDotPath(expr.name, sc) : sc[expr.name];
      if (typeof fn !== 'function') throw new Error(`"${expr.name}" is not a function`);
      return pipeSet(sc, fn(val));
    }
    // fallback: just evaluate and set it
    const result = evalExpr(expr, sc);
    return pipeSet(sc, result);
  }

  function evalDotPath(name, sc) {
    const parts = name.split('.');
    let obj = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (obj == null) return undefined;
      obj = obj[parts[i]];
    }
    return obj;
  }

  // ── expression evaluators ──

  function evalRef(node, sc) {
    const name = node.name;
    // check scope chain — return raw value, no auto-call
    if (name in sc) {
      return sc[name];
    }
    // check dot-path: scope first, then globals
    if (name.includes('.')) {
      const parts = name.split('.');
      let val = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
      for (let i = 1; i < parts.length; i++) {
        if (val == null) return null;
        val = val[parts[i]];
      }
      return val;
    }
    return undefined;
  }

  function evalBinOp(node, sc) {
    if (node.op === '&') {
      return softString(evalExpr(node.left, sc)) + softString(evalExpr(node.right, sc));
    }
    const left = evalExpr(node.left, sc);
    const right = evalExpr(node.right, sc);
    switch (node.op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right; // IEEE 754
      case '%': return left % right;
      case '**': return left ** right;
      case '<<': return left << right;
      case '>>': return left >> right;
      case 'bitand': return left & right;
      case 'bitor': return left | right;
      case 'bitxor': return left ^ right;
      default: throw new Error(`Unknown binop: ${node.op}`);
    }
  }

  function evalUnary(node, sc) {
    const val = evalExpr(node.expr, sc);
    switch (node.op) {
      case 'not': return !isTruthy(val);
      case 'neg': return -val;
      case 'bitnot': return ~val;
      default: throw new Error(`Unknown unary: ${node.op}`);
    }
  }

  function evalCompare(node, sc) {
    const left = evalExpr(node.left, sc);
    const right = evalExpr(node.right, sc);
    switch (node.op) {
      case '>': return left > right;
      case '<': return left < right;
      case '==':
        if (typeof left === 'string' && typeof right === 'string')
          return left.toLowerCase() === right.toLowerCase();
        return left === right;
      case '!=':
        if (typeof left === 'string' && typeof right === 'string')
          return left.toLowerCase() !== right.toLowerCase();
        return left !== right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      case 'contains':
        return String(left).toLowerCase().includes(String(right).toLowerCase());
      case 'matches':
        if (right instanceof RegExp) return right.test(String(left));
        return globMatch(String(left), String(right));
      default: throw new Error(`Unknown comparison: ${node.op}`);
    }
  }

  function evalLogic(node, sc) {
    const left = evalExpr(node.left, sc);
    if (node.op === 'and') return isTruthy(left) ? evalExpr(node.right, sc) : left;
    if (node.op === 'or') return isTruthy(left) ? left : evalExpr(node.right, sc);
    throw new Error(`Unknown logic op: ${node.op}`);
  }

  function evalOf(node, sc) {
    // flatten of-chain: name of author of book → [name, author, book]
    // Of nodes nest left: Of(Of(name, author), book)
    // Flatten props left-recursively, then obj is the root
    const chain = [];
    let n = node;
    while (n.type === 'Of') { chain.unshift(n.obj); n = n.prop; }
    chain.unshift(n); // leftmost prop (e.g. 'name')
    // chain is now [name, author, book] — leftmost prop first, root last
    // root is last, properties read right-to-left: book → .author → .name

    // evaluate root (last element)
    let obj = evalExpr(chain[chain.length - 1], sc);
    // walk properties right-to-left (from second-to-last down to first)
    for (let i = chain.length - 2; i >= 0; i--) {
      const prop = chain[i];
      let key;
      if (prop.type === 'Ref' && !prop.name.includes('.')) {
        key = prop.name;
      } else if (prop.type === 'Group') {
        key = evalExpr(prop, sc);
      } else {
        key = evalExpr(prop, sc);
      }
      // array mapping
      if (Array.isArray(obj)) { obj = obj.map(item => item?.[key]); continue; }
      if (obj == null) throw new Error('Cannot access property of nothing');
      obj = obj[key];
    }
    return obj;
  }

  function evalInvoke(node, sc) {
    const val = evalExpr(node.expr, sc);
    if (typeof val !== 'function') return val;
    const args = (node.args || []).map(a => evalExpr(a, sc));
    return val(...args);
  }

  function evalChunk(node, sc) {
    const target = evalExpr(node.target, sc);
    const idx = evalExpr(node.index, sc);
    const str = String(target);
    switch (node.kind) {
      case 'character': return str[idx] || '';
      case 'word': return (str.split(/\s+/)[idx]) || '';
      case 'line': return (str.split('\n')[idx]) || '';
      case 'item': return (str.split(',').map(s => s.trim())[idx]) || '';
      default: throw new Error(`Unknown chunk kind: ${node.kind}`);
    }
  }

  function evalChunkRange(node, sc) {
    const target = evalExpr(node.target, sc);
    const from = evalExpr(node.from, sc);
    const to = evalExpr(node.to, sc);
    const str = String(target);
    switch (node.kind) {
      case 'characters': return str.slice(from, to + 1);
      case 'words': return str.split(/\s+/).slice(from, to + 1).join(' ');
      case 'lines': return str.split('\n').slice(from, to + 1).join('\n');
      case 'items': return str.split(',').map(s => s.trim()).slice(from, to + 1).join(', ');
      default: throw new Error(`Unknown chunk range kind: ${node.kind}`);
    }
  }

  function evalCountChunks(node, sc) {
    const val = evalExpr(node.expr, sc);
    const str = String(val);
    switch (node.kind) {
      case 'characters': return str.length;
      case 'words': return str.split(/\s+/).filter(Boolean).length;
      case 'lines': return str.split('\n').length;
      case 'items': return str.split(',').length;
      default: throw new Error(`Unknown chunk count kind: ${node.kind}`);
    }
  }

  function evalLengthOf(node, sc) {
    const val = evalExpr(node.expr, sc);
    if (Array.isArray(val)) return val.length;
    if (typeof val === 'string') return val.length;
    return 0;
  }

  function evalCall(node, sc) {
    step();
    if (++callDepth > maxCallDepth) { callDepth--; throw new Error('Call depth exceeded (possible infinite recursion)'); }
    try {
    // resolve function
    let fn;
    if (node.name.includes('.')) {
      const parts = node.name.split('.');
      // resolve root: check scope first, then globals
      let obj = (parts[0] in sc) ? sc[parts[0]] : globals[parts[0]];
      for (let i = 1; i < parts.length - 1; i++) {
        if (obj == null) throw new Error(`Cannot resolve "${node.name}"`);
        obj = obj[parts[i]];
      }
      fn = obj?.[parts[parts.length - 1]];
      if (typeof fn === 'function') fn = fn.bind(obj);
    } else {
      fn = sc[node.name];
    }
    if (typeof fn !== 'function') {
      // if it's not a function but we have 0 args, just return the value
      if (node.args.length === 0) return fn;
      throw new Error(`"${node.name}" is not a function`);
    }
    const args = node.args.map(a => evalExpr(a, sc));
    return fn(...args);
    } finally { callDepth--; }
  }

  function evalRecord(node, sc) {
    const obj = {};
    for (const f of node.fields) obj[f.name] = evalExpr(f.value, sc);
    return obj;
  }

  function evalRecordWith(node, sc) {
    const obj = {};
    for (const f of node.fields) {
      obj[f.name] = f.ref ? sc[f.name] : evalExpr(f.value, sc);
    }
    return obj;
  }

  function evalTernary(node, sc) {
    return isTruthy(evalExpr(node.cond, sc))
      ? evalExpr(node.ifTrue, sc)
      : evalExpr(node.ifFalse, sc);
  }

  function evalBetween(node, sc) {
    const val = evalExpr(node.value, sc);
    const lo = evalExpr(node.lo, sc);
    const hi = evalExpr(node.hi, sc);
    return val >= lo && val <= hi;
  }

  function evalTypeCheck(node, sc) {
    const val = evalExpr(node.expr, sc);
    switch (node.typeName) {
      case 'number': case 'numbers': return typeof val === 'number';
      case 'text': return typeof val === 'string';
      case 'boolean': return typeof val === 'boolean';
      case 'list': return Array.isArray(val);
      case 'record': return typeof val === 'object' && val !== null && !Array.isArray(val);
      case 'nothing': return val === null || val === undefined;
      default: return false;
    }
  }

  // ── run ──
  evalNode(ast, scope);
  return { output, scope };
}

// -- runtime.js --

// soft transpile runtime — Soft semantics helpers called from AIR-emitted JS.
// Soft is simpler than Python: direct JS arithmetic, no dunder methods.
// Helpers only needed for: truthiness, string coercion, polymorphic length,
// case-insensitive string equality, chunks, type checks.


function _truthy(v) {
  if (v === false || v === null || v === undefined || v === 0 || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function _eq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function _neq(a, b) { return !_eq(a, b); }

function _contains(haystack, needle) {
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function _matches(str, pattern) {
  if (pattern instanceof RegExp) return pattern.test(String(str));
  // glob match
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re, 'i').test(String(str));
}

function _between(v, lo, hi) { return v >= lo && v <= hi; }

function _lengthOf(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string') return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

function _of(obj, prop) {
  if (obj == null) return null;
  return obj[prop];
}

function _isType(v, typeName) {
  switch (typeName) {
    case 'number': return typeof v === 'number';
    case 'text': case 'string': return typeof v === 'string';
    case 'list': return Array.isArray(v);
    case 'record': case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'boolean': case 'bool': return typeof v === 'boolean';
    case 'nothing': case 'null': return v === null || v === undefined;
    default: return false;
  }
}

// Chunks: character, word, line, item
function _chunk(kind, index, target) {
  const str = String(target);
  switch (kind) {
    case 'character': return str[index] || '';
    case 'word': return (str.split(/\s+/)[index]) || '';
    case 'line': return (str.split('\n')[index]) || '';
    case 'item': return (str.split(',').map(s => s.trim())[index]) || '';
    default: return '';
  }
}

function _chunkRange(kind, from, to, target) {
  const str = String(target);
  switch (kind) {
    case 'characters': return str.slice(from, to + 1);
    case 'words': return str.split(/\s+/).slice(from, to + 1).join(' ');
    case 'lines': return str.split('\n').slice(from, to + 1).join('\n');
    case 'items': return str.split(',').map(s => s.trim()).slice(from, to + 1).join(', ');
    default: return '';
  }
}

function _countChunks(kind, v) {
  const str = String(v);
  switch (kind) {
    case 'characters': return str.length;
    case 'words': return str.split(/\s+/).filter(Boolean).length;
    case 'lines': return str.split('\n').length;
    case 'items': return str.split(',').length;
    default: return 0;
  }
}

function _add(value, target) {
  // `add X to Y` — mutate Y
  if (Array.isArray(target)) { target.push(value); return null; }
  if (target && typeof target === 'object') {
    // record: merge fields if value is a record
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(target, value);
    }
    return null;
  }
  throw new Error(`Cannot add to ${typeof target}`);
}

// Invoke: if val is already a non-function (e.g. inner Call resolved), return it.
// Otherwise call it with args. Mirrors evalInvoke in eval.js.
async function _invoke(val, args) {
  if (typeof val !== 'function') return val;
  return val(...(args || []));
}

function _remove(value, target) {
  if (Array.isArray(target)) {
    const idx = target.indexOf(value);
    if (idx !== -1) target.splice(idx, 1);
    return null;
  }
  throw new Error(`Cannot remove from ${typeof target}`);
}

// Scope helper: set a name walking up for existing binding, or create in current scope.
// For transpile, we emulate this by passing a scope object and emitting scope access.
// But it's cleaner to translate Set to native JS assignment (which uses closure chain naturally).

const _soft = {
  truthy: _truthy,
  str: softString,
  eq: _eq,
  neq: _neq,
  contains: _contains,
  matches: _matches,
  between: _between,
  lengthOf: _lengthOf,
  of: _of,
  isType: _isType,
  chunk: _chunk,
  chunkRange: _chunkRange,
  countChunks: _countChunks,
  add: _add,
  remove: _remove,
  invoke: _invoke,
};

// -- highlight.js --

// soft — syntax highlighting tokenizer + completions for CM6


const SOFT_KEYWORDS = [...KEYWORDS];
const _kwSet = new Set(SOFT_KEYWORDS);

const SOFT_BUILTINS = ['abs', 'floor', 'ceil', 'sqrt', 'random', 'number', 'text'];
const _builtinSet = new Set(SOFT_BUILTINS);

// transforms and query keywords get a distinct color
const SOFT_TRANSFORMS = new Set([
  'take', 'from', 'keep', 'drop', 'only', 'where', 'pick', 'get',
  'sort', 'ascending', 'descending', 'first', 'last', 'top',
  'average', 'total', 'count', 'smallest', 'largest',
  'mean', 'sum', 'min', 'max', 'group', 'round', 'with',
  'say', 'show', 'set', 'put', 'define', 'return', 'assume',
  'add', 'remove', 'load', 'save', 'call', 'run',
]);

function tokenizeSoft(code) {
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

    // string
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len && code[i] !== '"') {
        if (code[i] === '\\' && i + 1 < len) i++;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }

    // numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      const start = i;
      if (ch === '0' && i + 1 < len && 'xXbBoO'.includes(code[i + 1])) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(code[i])) i++;
      } else {
        while (i < len && code[i] >= '0' && code[i] <= '9') i++;
        if (i < len && code[i] === '.') { i++; while (i < len && code[i] >= '0' && code[i] <= '9') i++; }
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }

    // identifiers / keywords / builtins
    if (/[\p{L}_]/u.test(ch)) {
      const start = i;
      while (i < len && /[\p{L}\p{N}_.]/u.test(code[i])) i++;
      const rawWord = code.slice(start, i);
      const isDotPath = rawWord.includes('.');
      // resolve locale: map Portuguese words to English canonical for classification
      const locale = softGetLocale();
      const word = (!isDotPath && locale?.[rawWord.toLowerCase()]) || rawWord;
      let type;
      if (isDotPath) type = 'fn';
      else if (_builtinSet.has(word)) type = 'fn';
      else if (SOFT_TRANSFORMS.has(word)) type = 'tf';
      else if (_kwSet.has(word)) type = 'kw';
      else type = 'id';
      tokens.push({ type, text: rawWord });
      continue;
    }

    // operators/punctuation
    const start = i;
    // two-char ops
    if (i + 1 < len) {
      const two = code.slice(i, i + 2);
      if (['**', '==', '!=', '>=', '<=', '<<', '>>'].includes(two)) {
        i += 2;
        tokens.push({ type: 'op', text: two });
        continue;
      }
    }
    i++;
    tokens.push({ type: 'op', text: code.slice(start, i) });
  }

  return tokens;
}

// ── indentation ──

const BLOCK_OPENERS = new Set([
  'if', 'unless', 'repeat', 'while', 'until', 'for',
  'define', 'on', 'suppose', 'try', 'otherwise', 'else',
]);
const BLOCK_CLOSERS = new Set(['end']);
const DEDENT_LINES = new Set(['otherwise', 'else', 'end']);

function softIndent(state, textAfter, cx) {
  const pos = cx.pos;
  // get the indent of the previous non-blank line
  const doc = cx.state.doc;
  let prevLineIndent = 0;
  let prevLineText = '';
  const curLine = doc.lineAt(pos);
  for (let ln = curLine.number - 1; ln >= 1; ln--) {
    const line = doc.line(ln);
    const trimmed = line.text.trim();
    if (trimmed.length > 0) {
      prevLineIndent = line.text.match(/^ */)[0].length;
      prevLineText = trimmed;
      break;
    }
  }

  // check if previous line opens a block
  const prevFirstWord = prevLineText.split(/\s/)[0].toLowerCase();
  const prevOpens = BLOCK_OPENERS.has(prevFirstWord);
  // also check for "do" at end or "if it fails"
  const prevEndsDo = prevLineText.endsWith(' do');
  const prevIsFails = prevLineText.includes('if it fails');

  // check if current line is a closer/dedenter
  const curTrimmed = textAfter.trim();
  const curFirstWord = curTrimmed.split(/\s/)[0].toLowerCase();
  const curDedents = DEDENT_LINES.has(curFirstWord) || curTrimmed.startsWith('if it fails');

  let indent = prevLineIndent;
  if (prevOpens || prevEndsDo || prevIsFails) indent += 2;
  if (curDedents) indent -= 2;
  return Math.max(0, indent);
}

function softCompletions(prefix) {
  const lc = prefix.toLowerCase();
  const results = [];
  for (const kw of SOFT_KEYWORDS) {
    if (kw.startsWith(lc)) results.push(kw);
  }
  for (const bi of SOFT_BUILTINS) {
    if (bi.startsWith(lc)) results.push(bi);
  }
  return results;
}

// -- air-lower.js --

// @gcu/air — Soft → AIR lowerer
// Soft is simpler than Python: direct JS arithmetic, JS-semantic comparison,
// no dunder methods, no classes. Result: fewer _soft helper calls than _py needed.



class SoftLowerError extends Error {
  constructor(message) { super(message); this._airFallback = true; }
}

// SoftLowerCtx is just BaseLowerCtx with a Soft-specific loc(): Soft AST
// nodes carry `node.line` but no column. The shared base provides ops /
// symbols / types / topLevel / defines / imports / source / emit / id
// generation.
class SoftLowerCtx extends BaseLowerCtx {
  loc(node) {
    return node?.line != null ? { line: node.line, col: 0 } : null;
  }
}

// _soft.XYZ call
function emitSoftCall(ctx, method, args, loc, type) {
  const softLoad = ctx.emit('load', ['_soft'], DYNAMIC, loc);
  const methodGet = ctx.emit('object_get', [softLoad.id, method], DYNAMIC, loc);
  return ctx.emit('call', [methodGet.id, ...args.map(a => a.id)], type || DYNAMIC, loc);
}

function emitAwaitedCall_sf(ctx, fnId, argIds, loc, type) {
  const call = ctx.emit('call', [fnId, ...argIds], type || DYNAMIC, loc);
  return ctx.emit('await', [call.id], type || DYNAMIC, loc);
}

// Collect top-level defines from the AST (Set, Define, Capture, Use)
function collectDefines_sf(body, defines) {
  for (const node of body || []) {
    switch (node.type) {
      case 'Set': defines.add(node.name); break;
      case 'Define': defines.add(node.name); break;
      case 'Capture': defines.add(node.name); break;
      case 'Use': defines.add(node.alias || node.path.split('.').pop()); break;
      case 'Load': if (node.name) defines.add(node.name); break;
      case 'Take': defines.add(node.name); break;
      case 'PipeCalled': if (node.name) defines.add(node.name); break;
      case 'If':
        collectDefines_sf(node.body, defines);
        if (node.elseBody) collectDefines_sf(node.elseBody, defines);
        break;
      case 'While': case 'Repeat':
        collectDefines_sf(node.body, defines);
        break;
      case 'ForEach':
        defines.add(node.varName);
        collectDefines_sf(node.body, defines);
        break;
      case 'RangeLoop':
        defines.add(node.varName);
        collectDefines_sf(node.body, defines);
        break;
    }
  }
}

function lowerSoft(ast, source) {
  // SSA id counter lives on SoftLowerCtx instance via BaseLowerCtx's
  // _idGen; no module-level reset.
  const ctx = new SoftLowerCtx();
  ctx.source = source || null;

  if (ast.type !== 'Program') throw new SoftLowerError('Expected Program node');

  collectDefines_sf(ast.body, ctx.defines);

  // Identify names that will be declared by `Define` (function syntax-like)
  const funcNames = new Set();
  for (const stmt of ast.body) {
    if (stmt.type === 'Define') funcNames.add(stmt.name);
  }

  // Pre-declare all module-level defines (except functions)
  for (const name of ctx.defines) {
    if (name === '__lastExpr__') continue;
    if (funcNames.has(name)) continue;
    const undef = ctx.emit('const', [undefined], VOID, null);
    ctx.emit('store', [name, undef.id], VOID, null);
    ctx.symbols.set(name, undef.id);
  }

  for (const stmt of ast.body) lowerStmt_sf(ctx, stmt);

  const exports = new Map();
  for (const name of ctx.defines) {
    const ssaId = ctx.symbols.get(name);
    const type = ssaId ? (ctx.types.get(ssaId) || DYNAMIC) : DYNAMIC;
    exports.set(name, { ssa_name: ssaId || null, type });
  }

  return {
    ops: ctx.ops,
    symbol_table: ctx.symbols.flatten(),
    exports,
    imports: new Set(ctx.imports),
    defines: new Set(ctx.defines),
    side_effects: true,
  };
}

// ── Statement lowering ──

function lowerStmt_sf(ctx, node) {
  if (!node) return null;
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Set': return lowerSet(ctx, node);
    case 'Define': return lowerDefine(ctx, node);
    case 'Say': return lowerSay(ctx, node);
    case 'If': return lowerIf_sf(ctx, node);
    case 'While': return lowerWhile_sf(ctx, node);
    case 'ForEach': return lowerForEach(ctx, node);
    case 'RangeLoop': return lowerRangeLoop(ctx, node);
    case 'Repeat': return lowerRepeat(ctx, node);
    case 'Return': {
      const val = node.value ? lowerExpr_sf(ctx, node.value) : ctx.emit('const', [null], VOID, l);
      ctx.emit('return', [val.id], VOID, l);
      return null;
    }
    case 'ExprStmt': return lowerExpr_sf(ctx, node.expr);
    case 'Capture': return lowerCapture(ctx, node);
    case 'Stop': ctx.emit('break', [], VOID, l); return null;
    case 'Skip': ctx.emit('continue', [], VOID, l); return null;
    case 'Add': return lowerAddRemove(ctx, node, 'add');
    case 'Remove': return lowerAddRemove(ctx, node, 'remove');
    case 'Assume': return lowerAssume(ctx, node);
    case 'Explain': return null; // no-op for transpile

    // Fallback for complex constructs
    case 'Try':
    case 'Suppose':
    case 'Use':
    case 'On':
    case 'Load':
    case 'Save':
    case 'Make':
    case 'SetOf':
    case 'SetChunk':
    case 'Take':
    case 'Filter': case 'Sort': case 'Aggregate': case 'Count':
    case 'Limit': case 'Group': case 'Pick': case 'Round': case 'With':
    case 'PipeCalled': case 'Pipeline': case 'PipeCall':
      throw new SoftLowerError(`Soft: ${node.type} not yet supported in transpile`);

    default:
      throw new SoftLowerError(`Soft: unsupported statement: ${node.type}`);
  }
}

// ── Expression lowering ──

function lowerExpr_sf(ctx, node) {
  if (!node) return ctx.emit('const', [null], VOID, null);
  const l = ctx.loc(node);

  switch (node.type) {
    case 'Num': {
      const v = node.value;
      const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
      return ctx.emit('const', [v], isInt ? I32 : F64, l);
    }
    case 'Str': return ctx.emit('const', [node.value], STRING, l);
    case 'Bool': return ctx.emit('const', [node.value], BOOL, l);
    case 'Nothing': return ctx.emit('const', [null], DYNAMIC, l);
    case 'Ref': return lowerRef(ctx, node);
    case 'Group': return lowerExpr_sf(ctx, node.expr);

    case 'BinOp': return lowerBinOp_sf(ctx, node);
    case 'Unary': return lowerUnary_sf(ctx, node);
    case 'Compare': return lowerCompare_sf(ctx, node);
    case 'Logic': return lowerLogic(ctx, node);
    case 'Between': return lowerBetween(ctx, node);
    case 'TypeCheck': return lowerTypeCheck(ctx, node);
    case 'Ternary': return lowerTernary(ctx, node);

    case 'Of': return lowerOf(ctx, node);
    case 'LengthOf': {
      const e = lowerExpr_sf(ctx, node.expr);
      return emitSoftCall(ctx, 'lengthOf', [e], l);
    }

    case 'Call': return lowerCall_sf(ctx, node);
    case 'Invoke': return lowerInvoke(ctx, node);

    case 'List': {
      const items = node.items.map(e => lowerExpr_sf(ctx, e).id);
      return ctx.emit('array_new', items, DYNAMIC, l);
    }

    case 'Record': return lowerRecord(ctx, node);
    case 'RecordWith': return lowerRecordWith(ctx, node);

    case 'Juxtapose': {
      // String concat — a & b & c or implicit juxtaposition in say
      const parts = node.parts.map(p => lowerExpr_sf(ctx, p));
      if (parts.length === 0) return ctx.emit('const', [''], STRING, l);
      let result = emitSoftCall(ctx, 'str', [parts[0]], l, STRING);
      for (let i = 1; i < parts.length; i++) {
        const s = emitSoftCall(ctx, 'str', [parts[i]], l, STRING);
        result = ctx.emit('add', [result.id, s.id], STRING, l);
      }
      return result;
    }

    case 'Chunk': {
      const target = lowerExpr_sf(ctx, node.target);
      const index = lowerExpr_sf(ctx, node.index);
      const kind = ctx.emit('const', [node.kind], STRING, l);
      return emitSoftCall(ctx, 'chunk', [kind, index, target], l);
    }
    case 'ChunkRange': {
      const target = lowerExpr_sf(ctx, node.target);
      const from = lowerExpr_sf(ctx, node.from);
      const to = lowerExpr_sf(ctx, node.to);
      const kind = ctx.emit('const', [node.kind], STRING, l);
      return emitSoftCall(ctx, 'chunkRange', [kind, from, to, target], l);
    }
    case 'CountChunks': {
      const e = lowerExpr_sf(ctx, node.expr);
      const kind = ctx.emit('const', [node.kind], STRING, l);
      return emitSoftCall(ctx, 'countChunks', [kind, e], l);
    }

    case 'ThereIs': {
      // There is X — X in scope and not null/undefined
      if (!ctx.symbols.has(node.name) && !ctx.defines.has(node.name)) {
        ctx.imports.add(node.name);
      }
      // Emit: (x !== undefined && x !== null)
      const load = ctx.emit('load', [node.name], DYNAMIC, l);
      const undef = ctx.emit('const', [undefined], VOID, l);
      const nullVal = ctx.emit('const', [null], VOID, l);
      const notUndef = ctx.emit('neq', [load.id, undef.id], BOOL, l);
      const notNull = ctx.emit('neq', [load.id, nullVal.id], BOOL, l);
      return ctx.emit('logical_and', [notUndef.id, notNull.id], BOOL, l);
    }
    case 'ThereIsNo': {
      if (!ctx.symbols.has(node.name) && !ctx.defines.has(node.name)) {
        ctx.imports.add(node.name);
      }
      const load = ctx.emit('load', [node.name], DYNAMIC, l);
      const undef = ctx.emit('const', [undefined], VOID, l);
      const nullVal = ctx.emit('const', [null], VOID, l);
      const isUndef = ctx.emit('eq', [load.id, undef.id], BOOL, l);
      const isNull = ctx.emit('eq', [load.id, nullVal.id], BOOL, l);
      return ctx.emit('logical_or', [isUndef.id, isNull.id], BOOL, l);
    }

    case 'Regex':
      throw new SoftLowerError('Soft: Regex not yet supported');

    case 'RoundExpr':
    case 'PipeCall':
      throw new SoftLowerError(`Soft: ${node.type} not yet supported in transpile`);

    default:
      throw new SoftLowerError(`Soft: unsupported expression: ${node.type}`);
  }
}

// ── Reference ──

function lowerRef(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;
  if (name.includes('.')) {
    // Dot path: resolve as Of chain
    const parts = name.split('.');
    const rootName = parts[0];
    if (!ctx.symbols.has(rootName) && !ctx.defines.has(rootName)) {
      ctx.imports.add(rootName);
    }
    let v = ctx.emit('load', [rootName], DYNAMIC, l);
    for (let i = 1; i < parts.length; i++) {
      v = ctx.emit('object_get', [v.id, parts[i]], DYNAMIC, l);
    }
    return v;
  }
  if (!ctx.symbols.has(name) && !ctx.defines.has(name)) {
    ctx.imports.add(name);
  }
  return ctx.emit('load', [name], DYNAMIC, l);
}

// ── BinOp / Unary / Compare / Logic ──

const BINOP_TO_AIR = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '**': 'exp',
  '<<': 'shift_left', '>>': 'shift_right',
  'bitand': 'bitwise_and', 'bitor': 'bitwise_or', 'bitxor': 'bitwise_xor',
};

function lowerBinOp_sf(ctx, node) {
  const l = ctx.loc(node);
  if (node.op === '&') {
    // String concat — softString both, then +
    const left = lowerExpr_sf(ctx, node.left);
    const right = lowerExpr_sf(ctx, node.right);
    const ls = emitSoftCall(ctx, 'str', [left], l, STRING);
    const rs = emitSoftCall(ctx, 'str', [right], l, STRING);
    return ctx.emit('add', [ls.id, rs.id], STRING, l);
  }
  const airOp = BINOP_TO_AIR[node.op];
  if (!airOp) throw new SoftLowerError(`Soft: unknown binop ${node.op}`);
  const left = lowerExpr_sf(ctx, node.left);
  const right = lowerExpr_sf(ctx, node.right);
  // Soft uses direct JS arithmetic — no runtime dispatch. Result type
  // is dynamic (could be number, string concat via '+', etc.) but we
  // emit the JS op directly which is correct.
  const typeHint = airOp === 'shift_left' || airOp === 'shift_right' ||
    airOp.startsWith('bitwise_') ? I32 : DYNAMIC;
  return ctx.emit(airOp, [left.id, right.id], typeHint, l);
}

function lowerUnary_sf(ctx, node) {
  const l = ctx.loc(node);
  const arg = lowerExpr_sf(ctx, node.expr);
  switch (node.op) {
    case 'not': {
      // !_soft.truthy(v) — Soft's "not" uses its own truthiness
      const truthy = emitSoftCall(ctx, 'truthy', [arg], l, BOOL);
      return ctx.emit('logical_not', [truthy.id], BOOL, l);
    }
    case 'neg': return ctx.emit('neg', [arg.id], DYNAMIC, l);
    case 'bitnot': return ctx.emit('bitwise_not', [arg.id], I32, l);
    default: throw new SoftLowerError(`Soft: unknown unary ${node.op}`);
  }
}

function lowerCompare_sf(ctx, node) {
  const l = ctx.loc(node);
  const left = lowerExpr_sf(ctx, node.left);
  const right = lowerExpr_sf(ctx, node.right);
  switch (node.op) {
    case '<': return ctx.emit('lt', [left.id, right.id], BOOL, l);
    case '>': return ctx.emit('gt', [left.id, right.id], BOOL, l);
    case '<=': return ctx.emit('lte', [left.id, right.id], BOOL, l);
    case '>=': return ctx.emit('gte', [left.id, right.id], BOOL, l);
    case '==':
      // Case-insensitive for strings — use _soft.eq helper
      return emitSoftCall(ctx, 'eq', [left, right], l, BOOL);
    case '!=':
      return emitSoftCall(ctx, 'neq', [left, right], l, BOOL);
    case 'contains':
      return emitSoftCall(ctx, 'contains', [left, right], l, BOOL);
    case 'matches':
      return emitSoftCall(ctx, 'matches', [left, right], l, BOOL);
    default: throw new SoftLowerError(`Soft: unknown comparison ${node.op}`);
  }
}

function lowerLogic(ctx, node) {
  const l = ctx.loc(node);
  // Soft's and/or: short-circuit, return actual value not bool
  // a and b → truthy(a) ? b : a
  // a or b  → truthy(a) ? a : b
  const left = lowerExpr_sf(ctx, node.left);
  const truthy = emitSoftCall(ctx, 'truthy', [left], l, BOOL);

  const savedOps = ctx.ops;
  ctx.ops = [];
  const right = lowerExpr_sf(ctx, node.right);
  const rightBody = ctx.ops;
  ctx.ops = savedOps;

  if (node.op === 'and') {
    return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
      then_body: rightBody,
      else_body: [],
      phis: [{ then_val: right.id, else_val: left.id }],
    });
  }
  // or
  return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
    then_body: [],
    else_body: rightBody,
    phis: [{ then_val: left.id, else_val: right.id }],
  });
}

function lowerBetween(ctx, node) {
  const l = ctx.loc(node);
  const v = lowerExpr_sf(ctx, node.value);
  const lo = lowerExpr_sf(ctx, node.lo);
  const hi = lowerExpr_sf(ctx, node.hi);
  return emitSoftCall(ctx, 'between', [v, lo, hi], l, BOOL);
}

function lowerTypeCheck(ctx, node) {
  const l = ctx.loc(node);
  const e = lowerExpr_sf(ctx, node.expr);
  const tn = ctx.emit('const', [node.typeName], STRING, l);
  return emitSoftCall(ctx, 'isType', [e, tn], l, BOOL);
}

function lowerTernary(ctx, node) {
  const l = ctx.loc(node);
  // X if cond otherwise Y → _soft.truthy(cond) ? X : Y
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);

  const savedOps = ctx.ops;
  ctx.ops = [];
  const thenVal = lowerExpr_sf(ctx, node.ifTrue);
  const thenBody = ctx.ops;
  ctx.ops = [];
  const elseVal = lowerExpr_sf(ctx, node.ifFalse);
  const elseBody = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('if_region', [truthy.id], DYNAMIC, l, {
    then_body: thenBody,
    else_body: elseBody,
    phis: [{ then_val: thenVal.id, else_val: elseVal.id }],
  });
}

// ── Of: x of y → y.x (with null-safety) ──

function lowerOf(ctx, node) {
  const l = ctx.loc(node);
  const obj = lowerExpr_sf(ctx, node.obj);
  // node.prop is a node like Ref — get its name
  let propName;
  if (node.prop.type === 'Ref') propName = node.prop.name;
  else if (node.prop.type === 'Str') propName = node.prop.value;
  else {
    // Computed — use array_get (dynamic property)
    const prop = lowerExpr_sf(ctx, node.prop);
    return emitSoftCall(ctx, 'of', [obj, prop], l);
  }
  const name = ctx.emit('const', [propName], STRING, l);
  return emitSoftCall(ctx, 'of', [obj, name], l);
}

// ── Call ──

function lowerCall_sf(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;
  const args = node.args.map(a => lowerExpr_sf(ctx, a));

  // Dotted names (Text.upper, List.reverse, etc.) — lower as nested object_gets + call
  if (name.includes('.')) {
    const parts = name.split('.');
    const rootName = parts[0];
    if (!ctx.symbols.has(rootName) && !ctx.defines.has(rootName)) {
      ctx.imports.add(rootName);
    }
    let fn = ctx.emit('load', [rootName], DYNAMIC, l);
    for (let i = 1; i < parts.length; i++) {
      fn = ctx.emit('object_get', [fn.id, parts[i]], DYNAMIC, l);
    }
    return emitAwaitedCall_sf(ctx, fn.id, args.map(a => a.id), l);
  }

  if (!ctx.symbols.has(name) && !ctx.defines.has(name)) {
    ctx.imports.add(name);
  }
  const fn = ctx.emit('load', [name], DYNAMIC, l);
  return emitAwaitedCall_sf(ctx, fn.id, args.map(a => a.id), l);
}

function lowerInvoke(ctx, node) {
  const l = ctx.loc(node);
  const fn = lowerExpr_sf(ctx, node.expr);
  const args = node.args.map(a => lowerExpr_sf(ctx, a));
  // Use _soft.invoke to handle the "already resolved to non-function" case
  const argsArr = ctx.emit('array_new', args.map(a => a.id), DYNAMIC, l);
  const call = emitSoftCall(ctx, 'invoke', [fn, argsArr], l);
  return ctx.emit('await', [call.id], DYNAMIC, l);
}

// ── Records ──

function lowerRecord(ctx, node) {
  const l = ctx.loc(node);
  const pairs = node.fields.map(f => ({
    key: f.name,
    id: lowerExpr_sf(ctx, f.value).id,
  }));
  return ctx.emit('object_new', pairs, DYNAMIC, l);
}

function lowerRecordWith(ctx, node) {
  // Same as Record — field names spell out the shape
  return lowerRecord(ctx, node);
}

// ── Set ──

function lowerSet(ctx, node) {
  const l = ctx.loc(node);
  const val = lowerExpr_sf(ctx, node.value);
  ctx.emit('store', [node.name, val.id], VOID, l);
  ctx.symbols.set(node.name, val.id);
  if (ctx.topLevel) ctx.defines.add(node.name);
  return null;
}

// ── Define (function) ──

function lowerDefine(ctx, node) {
  const l = ctx.loc(node);
  const name = node.name;

  // Extract params from signature. Soft sig is an array of { param, variadic? }
  const params = [];
  for (const s of node.sig || []) {
    if (typeof s === 'object' && s !== null && s.param) {
      if (s.variadic) {
        params.push({ name: '...' + s.param, type: DYNAMIC });
      } else {
        params.push({ name: s.param, type: DYNAMIC });
      }
    }
  }

  const savedTopLevel = ctx.topLevel;
  const savedOps = ctx.ops;

  ctx.topLevel = false;
  ctx.ops = [];
  ctx.symbols = ctx.symbols.push();
  for (const p of params) {
    const pname = p.name.replace(/^\.\.\./, '');
    ctx.symbols.set(pname, null);
  }
  // Soft functions use `it` as implicit result
  ctx.symbols.set('it', null);

  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;
  ctx.topLevel = savedTopLevel;
  ctx.symbols = ctx.symbols.pop();

  const op = ctx.emit('func_region', [name], DYNAMIC, l, {
    name, params, body, ret_type: DYNAMIC,
    is_async: true,
    is_generator: false,
  });

  ctx.emit('store', [name, op.id], VOID, l);
  ctx.symbols.set(name, op.id);
  if (ctx.topLevel) ctx.defines.add(name);
  return op;
}

// ── Say ──

function lowerSay(ctx, node) {
  const l = ctx.loc(node);
  const val = lowerExpr_sf(ctx, node.value);
  // Soft's say calls `say` builtin (or the cell's display). Just call `say`.
  if (!ctx.symbols.has('say') && !ctx.defines.has('say')) {
    ctx.imports.add('say');
  }
  const sayFn = ctx.emit('load', ['say'], DYNAMIC, l);
  return emitAwaitedCall_sf(ctx, sayFn.id, [val.id], l);
}

// ── If / While / ForEach / RangeLoop / Repeat ──

function lowerIf_sf(ctx, node) {
  const l = ctx.loc(node);
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);

  const savedOps = ctx.ops;
  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const thenBody = ctx.ops;
  ctx.ops = [];
  if (node.elseBody) for (const s of node.elseBody) lowerStmt_sf(ctx, s);
  const elseBody = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('if_region', [truthy.id], VOID, l, {
    then_body: thenBody, else_body: elseBody, phis: [],
  });
}

function lowerWhile_sf(ctx, node) {
  const l = ctx.loc(node);
  const savedOps = ctx.ops;

  ctx.ops = [];
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);
  const testOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('loop_region', [], VOID, l, {
    test: testOps, test_val: truthy.id,
    body, phis: [], loop_kind: 'while',
  });
}

function lowerForEach(ctx, node) {
  const l = ctx.loc(node);
  const iter = lowerExpr_sf(ctx, node.iter);
  // Pre-declare var
  if (ctx.topLevel) ctx.defines.add(node.varName);

  const savedOps = ctx.ops;
  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;
  ctx.ops = savedOps;

  return ctx.emit('for_of_region', [iter.id], VOID, l, {
    body, phis: [], target_name: node.varName,
  });
}

function lowerRangeLoop(ctx, node) {
  const l = ctx.loc(node);
  // for each i from X to Y [by step]: body
  // Lower as: let i = X; while (step > 0 ? i <= Y : i >= Y) { body; i += step }
  // Use a standard for_region.
  const varName = node.varName;
  if (ctx.topLevel) ctx.defines.add(varName);

  const savedOps = ctx.ops;

  ctx.ops = [];
  const from = lowerExpr_sf(ctx, node.from);
  ctx.emit('store', [varName, from.id], VOID, l);
  ctx.symbols.set(varName, from.id);
  const initOps = ctx.ops;

  ctx.ops = [];
  const to = lowerExpr_sf(ctx, node.to);
  const vLoad = ctx.emit('load', [varName], DYNAMIC, l);
  const testOp = ctx.emit('lte', [vLoad.id, to.id], BOOL, l);
  const testOps = ctx.ops;

  ctx.ops = [];
  const stepVal = node.step ? lowerExpr_sf(ctx, node.step) : ctx.emit('const', [1], I32, l);
  const vLoad2 = ctx.emit('load', [varName], DYNAMIC, l);
  const newV = ctx.emit('add', [vLoad2.id, stepVal.id], DYNAMIC, l);
  ctx.emit('store', [varName, newV.id], VOID, l);
  const updateOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('for_region', [], VOID, l, {
    init: initOps,
    test: testOps,
    test_val: testOp.id,
    update: updateOps,
    body,
    phis: [],
  });
}

function lowerRepeat(ctx, node) {
  const l = ctx.loc(node);
  // repeat N times: body → for-loop 0..N
  const countExpr = lowerExpr_sf(ctx, node.count);
  const tempVar = `__rep_${ctx._idGen.peek()}`;

  const savedOps = ctx.ops;

  ctx.ops = [];
  const zero = ctx.emit('const', [0], I32, l);
  ctx.emit('store', [tempVar, zero.id], VOID, l);
  ctx.symbols.set(tempVar, zero.id);
  const initOps = ctx.ops;

  ctx.ops = [];
  const vLoad = ctx.emit('load', [tempVar], DYNAMIC, l);
  const testOp = ctx.emit('lt', [vLoad.id, countExpr.id], BOOL, l);
  const testOps = ctx.ops;

  ctx.ops = [];
  const one = ctx.emit('const', [1], I32, l);
  const vLoad2 = ctx.emit('load', [tempVar], DYNAMIC, l);
  const newV = ctx.emit('add', [vLoad2.id, one.id], I32, l);
  ctx.emit('store', [tempVar, newV.id], VOID, l);
  const updateOps = ctx.ops;

  ctx.ops = [];
  for (const s of node.body) lowerStmt_sf(ctx, s);
  const body = ctx.ops;

  ctx.ops = savedOps;

  return ctx.emit('for_region', [], VOID, l, {
    init: initOps, test: testOps, test_val: testOp.id,
    update: updateOps, body, phis: [],
  });
}

// ── Capture ──

function lowerCapture(ctx, node) {
  const l = ctx.loc(node);
  const val = lowerExpr_sf(ctx, node.expr);
  ctx.emit('store', [node.name, val.id], VOID, l);
  ctx.symbols.set(node.name, val.id);
  if (ctx.topLevel) ctx.defines.add(node.name);
  return null;
}

// ── Add / Remove ──

function lowerAddRemove(ctx, node, kind) {
  const l = ctx.loc(node);
  const value = lowerExpr_sf(ctx, node.value);
  const target = lowerExpr_sf(ctx, node.target);
  emitSoftCall(ctx, kind, [value, target], l, VOID);
  return null;
}

// ── Assume ──

function lowerAssume(ctx, node) {
  const l = ctx.loc(node);
  const cond = lowerExpr_sf(ctx, node.cond);
  const truthy = emitSoftCall(ctx, 'truthy', [cond], l, BOOL);

  const savedOps = ctx.ops;
  ctx.ops = [];
  const msg = node.message ? lowerExpr_sf(ctx, node.message)
    : ctx.emit('const', ['assumption failed'], STRING, l);
  ctx.emit('throw', [msg.id], VOID, l);
  const thenBody = ctx.ops;
  ctx.ops = savedOps;

  const notTruthy = ctx.emit('logical_not', [truthy.id], BOOL, l);
  ctx.emit('if_region', [notTruthy.id], VOID, l, {
    then_body: thenBody, else_body: [], phis: [],
  });
  return null;
}

// -- cell.js --

// soft — cell type handler: parseNames, findUses, execute




// ── parseNames: extract top-level variable defines ──
// Walks the AST for Set, Define, Capture, Use at top level.

function softParseNames(code) {
  try {
    const ast = softParse(code);
    const defines = new Set();
    for (const node of ast.body) _collectDefines(node, defines);
    return defines;
  } catch {
    return _parseNamesRegex(code);
  }
}

function _collectDefines(node, defines) {
  switch (node.type) {
    case 'Set': defines.add(node.name); break;
    case 'Define': defines.add(node.name); break;
    case 'Capture': defines.add(node.name); break;
    case 'Use': defines.add(node.alias || node.path.split('.').pop()); break;
    case 'Load': if (node.name) defines.add(node.name); break;
    case 'PipeCalled': if (node.name) defines.add(node.name); _collectDefines(node.step, defines); break;
    case 'If':
      for (const s of node.body) _collectDefines(s, defines);
      if (node.elseBody) for (const s of node.elseBody) _collectDefines(s, defines);
      break;
    case 'ForEach': case 'While': case 'Repeat': case 'RangeLoop':
      for (const s of node.body) _collectDefines(s, defines);
      break;
    default: break;
  }
}

function _parseNamesRegex(code) {
  const defines = new Set();
  for (const line of code.split('\n')) {
    const t = line.trim();
    let m;
    m = t.match(/^set\s+(?:the\s+)?(\w+)\s+to\b/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/^put\s+.+\s+into\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/^define\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\binto\s+(\w+)\s*$/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\bas\s+(\w+)\s*$/);
    if (m) { defines.add(m[1]); continue; }
    m = t.match(/\bcalled\s+(\w+)/);
    if (m) { defines.add(m[1]); continue; }
  }
  return defines;
}

// ── findUses: find references to other cells ──

function softFindUses(code, allDefined) {
  const selfDefines = softParseNames(code);
  const uses = new Set();
  // strip comments and strings, then scan for identifiers
  const stripped = code.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const idRe = /\b([a-zA-Z_]\w*)\b/g;
  let m;
  while ((m = idRe.exec(stripped))) {
    if (allDefined.has(m[1]) && !selfDefines.has(m[1])) uses.add(m[1]);
  }
  return uses;
}

// ── execute: run a Soft cell ──

async function softExecute(code, scopeIn, cell) {
  const globals = {};

  // inject Math, standard JS globals
  if (typeof Math !== 'undefined') globals.Math = Math;
  if (typeof JSON !== 'undefined') globals.JSON = JSON;

  // Text utilities
  globals.Text = {
    upper: (s) => String(s).toUpperCase(),
    lower: (s) => String(s).toLowerCase(),
    trim: (s) => String(s).trim(),
    split: (s, sep) => String(s).split(sep),
    replace: (s, a, b) => String(s).replace(a, b),
    starts: (s, prefix) => String(s).startsWith(prefix),
    ends: (s, suffix) => String(s).endsWith(suffix),
    slice: (s, a, b) => String(s).slice(a, b),
  };

  // List utilities
  globals.List = {
    range: (a, b, step) => {
      const arr = [];
      if (b === undefined) { b = a; a = 0; }
      step = step || 1;
      for (let i = a; step > 0 ? i < b : i > b; i += step) arr.push(i);
      return arr;
    },
    reverse: (arr) => [...arr].reverse(),
    flat: (arr) => arr.flat(),
    unique: (arr) => [...new Set(arr)],
    join: (arr, sep) => arr.join(sep ?? ', '),
    zip: (...arrs) => arrs[0].map((_, i) => arrs.map(a => a[i])),
  };

  // Date utilities
  globals.Date = {
    now: () => Date.now(),
    today: () => new Date().toISOString().slice(0, 10),
  };

  // host functions for file I/O, DOM, events
  const host = {};
  const hasCtx = !!cell?._ctx;

  // CSV parser
  const csvParse = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim());
      const row = {};
      headers.forEach((h, i) => {
        const v = vals[i];
        row[h] = v !== undefined && v !== '' && !isNaN(v) ? Number(v) : (v || '');
      });
      return row;
    });
  };
  const parseContent = (path, text) => {
    if (path.endsWith('.json')) return JSON.parse(text);
    if (path.endsWith('.csv')) return csvParse(text);
    return text;
  };

  // pre-read all files referenced in load statements (async, before sync evaluator)
  // parse the AST to find Load nodes — works regardless of locale
  const preloaded = {};
  const nbFs = hasCtx ? cell._ctx?.notebook?.fs : null;
  let loadPaths = [];
  try {
    const ast = softParse(code);
    for (const node of ast.body) {
      if (node.type === 'Load' && node.path?.type === 'Str') loadPaths.push(node.path.value);
    }
  } catch { /* parse error — no pre-loading */ }
  for (const path of loadPaths) {
    try {
      if (path.startsWith('http://') || path.startsWith('https://')) {
        preloaded[path] = await (await fetch(path)).text();
      } else if (nbFs) {
        preloaded[path] = await nbFs.read(path);
      }
    } catch { /* will error at eval time */ }
  }

  host.load = (path) => {
    if (preloaded[path] !== undefined) return parseContent(path, preloaded[path]);
    if (path in scopeIn) return scopeIn[path];
    throw new Error(`Cannot load "${path}": file not found`);
  };
  if (nbFs) {
    host.save = async (path, data) => {
      let content;
      if (typeof data === 'string') content = data;
      else if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        const keys = Object.keys(data[0]);
        content = keys.join(',') + '\n' + data.map(r => keys.map(k => r[k] ?? '').join(',')).join('\n');
      } else {
        content = JSON.stringify(data, null, 2);
      }
      await nbFs.write(path, content);
    };
  }

  // DOM helpers
  if (hasCtx) {
    const outputEl = cell._ctx.outputEl;
    // cleanup tracking for event listeners
    const cleanups = [];
    if (cell._ctx.invalidation) {
      cell._ctx.invalidation.then(() => { for (const fn of cleanups) fn(); });
    }

    host.make = (tag, parent) => {
      const el = document.createElement(tag);
      (parent || outputEl).appendChild(el);
      return el;
    };
    host.on = (event, target, handler) => {
      let el = target || outputEl;
      if (typeof el === 'string') el = document.getElementById(el);
      if (el && el.addEventListener) {
        el.addEventListener(event, handler);
        cleanups.push(() => el.removeEventListener(event, handler));
      }
    };
  }

  // Try transpile path first; fall back to tree-walker on any failure
  let result = null;
  let usedTranspile = false;

  const _airSoftLower = (typeof window !== 'undefined' && window._airGetLowerer)
    ? window._airGetLowerer('soft')
    : null;
  if (_airSoftLower && typeof window !== 'undefined' && window._airEmit) {
    try {
      const ast = softParse(code);
      const lowered = _airSoftLower(ast, code);
      if (lowered) {
        const air = lowered.air;
        const importNames = [...air.imports];
        const emittedJS = window._airEmit(air, importNames, [], {
          hinted: false,
          cellId: cell?.id || 'soft',
        });
        const AF = Object.getPrototypeOf(async function(){}).constructor;
        const transpileOutput = [];
        const saySink = (val) => { transpileOutput.push(val); return null; };
        // Resolve each import from: scopeIn, globals, builtins, special (say)
        const argValues = importNames.map(name => {
          if (name === 'say') return saySink;
          if (scopeIn && name in scopeIn) return scopeIn[name];
          if (name in globals) return globals[name];
          return undefined;
        });
        const fn = new AF('_soft', ...importNames, emittedJS);
        const retObj = await fn(_soft, ...argValues);
        // Build a compat scope object
        const transpileScope = { ...scopeIn };
        if (retObj && typeof retObj === 'object') {
          for (const [k, v] of Object.entries(retObj)) {
            if (k === '__lastExpr__') continue;
            transpileScope[k] = v;
          }
        }
        result = { scope: transpileScope, output: transpileOutput };
        usedTranspile = true;
      }
    } catch (e) {
      if (typeof window !== 'undefined' && window._airDebug) {
        console.warn('[AIR] soft transpile fallback for cell', cell?.id, ':', e.message);
      }
      usedTranspile = false;
      result = null;
    }
  }

  if (!usedTranspile) {
    result = softEval(code, {
      globals,
      scopeInit: scopeIn,
      host,
    });
  }

  // extract defines
  const defines = {};
  const cellDefines = softParseNames(code);
  for (const name of cellDefines) {
    if (result.scope[name] !== undefined) {
      defines[name] = result.scope[name];
    }
  }

  // build output
  if (hasCtx) {
    // render output to DOM — use ui.table for arrays-of-objects, display for everything else
    for (const val of result.output) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        cell._ctx.ui.table(val);
      } else if (typeof val === 'string') {
        cell._ctx.display(val);
      } else {
        cell._ctx.display(val);
      }
    }
    // last expression value as cell reactive output
    if (result.scope.it !== null && result.scope.it !== undefined && result.output.length === 0) {
      if (Array.isArray(result.scope.it) && result.scope.it.length > 0 && typeof result.scope.it[0] === 'object') {
        cell._ctx.ui.table(result.scope.it);
      } else {
        cell._ctx.display(result.scope.it);
      }
    }
    return { defines };
  }

  // headless mode — stringify raw values
  return {
    defines,
    output: result.output.length > 0
      ? result.output.map(v => typeof v === 'string' ? v : softStringify(v)).join('\n')
      : undefined,
  };
}

// -- tag.js --

// soft tagged template — use soft`...` in JS code cells
// Returns an object with all top-level defines as properties.



function softTag(strings, ...values) {
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
  if (start > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  code = lines.join('\n');

  // inject interpolated values into scope
  const scopeInit = {};
  for (let i = 0; i < values.length; i++) scopeInit['_v' + i] = values[i];

  const result = softEval(code, { scopeInit });

  // extract non-underscore-prefixed defines
  const out = {};
  for (const [k, v] of Object.entries(result.scope)) {
    if (k.startsWith('_') || k === 'it') continue;
    if (typeof v === 'function' && !v._softName) continue;
    out[k] = v;
  }
  return out;
}

// -- register.js --

// Registration: cell type, tagged language, AIR lowerer, plugin metadata.
// Single auditable.registerExtension(manifest) call replaces the legacy
// fan-out. Locale handling stays on a side channel since locales register
// additional cell types dynamically.







const SOFT_VERSION = '0.1.0';

const _baseHandler = {
  parseNames: softParseNames,
  findUses: softFindUses,
  execute: softExecute,
  tokenize: tokenizeSoft,
  completions: (prefix) => softCompletions(prefix),
  syntaxCheck: (code) => { try { softParse(code); return true; } catch { return false; } },
  indent: softIndent,
  indentUnit: '  ',
};

if (typeof window !== 'undefined' && !window._cellTypes?.['soft']) {
  const register = window.auditable?.registerExtension;
  if (register) {
    register({
      name: '@gcu/soft',
      version: SOFT_VERSION,
      apiVersion: '0.x',
      description: 'English keyword programming language — soft cells and tagged template',
      pluginUrl: '@gcu/soft',

      cellType: {
        name: 'soft',
        label: 'soft',
        color: '#c89b3c',
        shortcut: 'f',
        editDebounce: 500,
        capabilities: {
          executable: true,
          definesScope: true,
          hasOutput: true,
          hasEditor: true,
          builtin: false,
        },
        ..._baseHandler,
        createEditor: (cell, onChange) => {
          if (!window._ctCreateEditor) return null;
          const wrap = document.createElement('div');
          wrap.className = 'editor-wrap';
          const editor = window._ctCreateEditor(wrap, cell.id, cell.code, 'soft', onChange);
          return {
            el: wrap,
            getCode: () => editor.view.state.doc.toString(),
            setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
            focus: () => editor.focus(),
            destroy: () => editor.destroy(),
          };
        },
      },

      taggedLanguage: {
        name: 'soft',
        tokenize: tokenizeSoft,
        completions: softCompletions,
        indent: softIndent,
      },

      airLowerer: { language: 'soft', fn: lowerSoft },

      globals: { soft: softTag },

      onActivate: () => {
        // configure autocomplete for any existing soft cells (created before plugin loaded)
        if (window._configurePluginAutocomplete) window._configurePluginAutocomplete('soft');
      },
    });
  }
}

// Locale switcher kept as a side channel — not a cell-type contribution per se.
if (typeof window !== 'undefined') window._softSetLocale = softSetLocale;

// register a locale as a new cell type (e.g. 'soft-ptbr')
function registerLocale(localeData) {
  const localeName = (localeData.locale || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cellType = 'soft-' + localeName;

  // activate globally (for the base 'soft' type too)
  softSetLocale(localeData);

  // create locale-aware wrapper functions
  const withLocale = (fn) => (...args) => {
    const prev = softGetLocale();
    softSetLocale(localeData);
    try { return fn(...args); } finally { if (!prev) softSetLocale(null); }
  };

  const register = window.auditable?.registerExtension;
  if (!register) return;

  register({
    name: '@gcu/soft/' + localeData.locale,
    version: SOFT_VERSION,
    pluginUrl: '@gcu/soft/' + localeData.locale,

    cellType: {
      name: cellType,
      label: cellType,
      color: '#c89b3c',
      editDebounce: 500,
      capabilities: {
        executable: true,
        definesScope: true,
        hasOutput: true,
        hasEditor: true,
        builtin: false,
      },
      parseNames: withLocale(softParseNames),
      findUses: withLocale(softFindUses),
      execute: async (code, scopeIn, cell) => { softSetLocale(localeData); return softExecute(code, scopeIn, cell); },
      tokenize: withLocale(tokenizeSoft),
      completions: withLocale((prefix) => softCompletions(prefix)),
      syntaxCheck: withLocale((code) => { try { softParse(code); return true; } catch { return false; } }),
      indent: softIndent,
      indentUnit: '  ',
      createEditor: (cell, onChange) => {
        if (!window._ctCreateEditor) return null;
        const wrap = document.createElement('div');
        wrap.className = 'editor-wrap';
        const editor = window._ctCreateEditor(wrap, cell.id, cell.code, cellType, onChange);
        return {
          el: wrap,
          getCode: () => editor.view.state.doc.toString(),
          setCode: (s) => editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: s } }),
          focus: () => editor.focus(),
          destroy: () => editor.destroy(),
        };
      },
    },

    taggedLanguage: {
      name: cellType,
      tokenize: withLocale(tokenizeSoft),
      completions: withLocale(softCompletions),
      indent: softIndent,
    },

    onActivate: () => {
      if (window._configurePluginAutocomplete) window._configurePluginAutocomplete(cellType);
    },
  });
}

// load a locale by name — handles dev-mode fetch + installed module decompression
async function loadLocale(name) {
  if (window._importCache?.['@gcu/soft/' + name]) {
    registerLocale(window._importCache['@gcu/soft/' + name]);
    return;
  }
  const key = '@gcu/soft/' + name;
  if (window._installedModules?.[key]) {
    let src = window._installedModules[key];
    if (src.compressed && !src.binary && typeof src.source === 'string') {
      const bin = Uint8Array.from(atob(src.source), c => c.charCodeAt(0));
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bin); writer.close();
      src = await new Response(ds.readable).text();
    } else if (src.source) {
      src = src.source;
    }
    const data = typeof src === 'string' ? JSON.parse(src) : src;
    window._importCache = window._importCache || {};
    window._importCache[key] = data;
    registerLocale(data);
    return;
  }
  const resp = await fetch(`./ext/soft/locales/${name}.json`);
  if (!resp.ok) throw new Error(`Locale "${name}" not found`);
  const data = await resp.json();
  window._importCache = window._importCache || {};
  window._importCache[key] = data;
  registerLocale(data);
}

const soft = {
  softTag,
  softParseNames,
  softFindUses,
  tokenizeSoft,
  softCompletions,
  setLocale: softSetLocale,
  registerLocale,
  loadLocale,
};

export { soft };
