// Syntax highlighting — tokenizer + completions for auditable editor integration
//
// These keyword/type/builtin sets define the language's vocabulary. They're shared
// between this module (editor highlighting + completions) and lex.js (compiler tokenizer).

export const ATRA_KEYWORDS = new Set([
  'function','subroutine','begin','end','var','const','if','then','else',
  'for','while','do','break','and','or','not','mod','import','export',
  'call','array','true','false','from','tailcall','return',
  'layout','packed',
]);

export const ATRA_TYPES = new Set(['i32','i64','f32','f64','f64x2','f32x4','i32x4','i64x2']);

export const ATRA_BUILTINS = new Set([
  'sin','cos','sqrt','abs','floor','ceil','ln','exp','pow',
  'min','max','trunc','nearest','copysign','select',
  'clz','ctz','popcnt','rotl','rotr','memory_size','memory_grow',
  'memory_copy','memory_fill',
]);

export const ATRA_VECTOR_TYPES = new Set(['f64x2','f32x4','i32x4','i64x2']);

export function tokenizeAtra(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment: ! to end of line
    if (code[i] === '!') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // numbers (with optional type suffix _f32, _f64, _i32, _i64)
    if (/\d/.test(code[i]) || (code[i] === '.' && i + 1 < len && /\d/.test(code[i + 1]))) {
      const start = i;
      while (i < len && /[0-9.]/.test(code[i])) i++;
      if (i < len && /[eE]/.test(code[i])) {
        i++;
        if (i < len && /[+-]/.test(code[i])) i++;
        while (i < len && /\d/.test(code[i])) i++;
      }
      // type suffix: _f32, _f64, _i32, _i64
      if (code[i] === '_' && i + 3 <= len && /^[fi]/.test(code[i + 1])) {
        const suf = code.slice(i + 1, i + 4);
        if (ATRA_TYPES.has(suf)) i += 4;
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < len && /[\w.]/.test(code[i])) i++;
      const word = code.slice(start, i);
      const lower = word.toLowerCase();
      if (ATRA_KEYWORDS.has(lower)) {
        tokens.push({ type: 'kw', text: word });
      } else if (ATRA_TYPES.has(lower)) {
        // type names as builtins when followed by (
        if (i < len && code[i] === '(') {
          tokens.push({ type: 'fn', text: word });
        } else {
          tokens.push({ type: 'const', text: word });
        }
      } else if (ATRA_BUILTINS.has(lower) || lower.startsWith('wasm.') ||
                 lower.startsWith('v128.') || (ATRA_VECTOR_TYPES.has(lower.split('.')[0]) && lower.includes('.'))) {
        tokens.push({ type: 'fn', text: word });
      } else if (i < len && code[i] === '(') {
        tokens.push({ type: 'fn', text: word });
      } else {
        tokens.push({ type: 'id', text: word });
      }
      continue;
    }
    // multi-char operators
    if (i + 1 < len) {
      const two = code[i] + code[i + 1];
      if (two === '**' || two === ':=' || two === '+=' || two === '-=' ||
          two === '*=' || two === '/=' || two === '==' || two === '<=' ||
          two === '>=' || two === '<<' || two === '>>') {
        tokens.push({ type: 'op', text: two });
        i += 2;
        continue;
      }
    }
    // single-char operators
    if ('+-*/<>=&|^~@'.includes(code[i])) {
      tokens.push({ type: 'op', text: code[i] });
      i++;
      continue;
    }
    // punctuation
    if ('()[];,:'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // whitespace / other
    tokens.push({ type: '', text: code[i] });
    i++;
  }
  return tokens;
}

// ── Builtin signatures ──

const ATRA_BUILTIN_SIGS = {
  sin:      { sig: 'sin(x: f64): f64', desc: 'sine' },
  cos:      { sig: 'cos(x: f64): f64', desc: 'cosine' },
  sqrt:     { sig: 'sqrt(x: f64): f64', desc: 'square root' },
  abs:      { sig: 'abs(x: f64): f64', desc: 'absolute value' },
  floor:    { sig: 'floor(x: f64): f64', desc: 'round down' },
  ceil:     { sig: 'ceil(x: f64): f64', desc: 'round up' },
  ln:       { sig: 'ln(x: f64): f64', desc: 'natural logarithm' },
  exp:      { sig: 'exp(x: f64): f64', desc: 'exponential' },
  pow:      { sig: 'pow(base: f64, exp: f64): f64', desc: 'power' },
  min:      { sig: 'min(a: f64, b: f64): f64', desc: 'minimum' },
  max:      { sig: 'max(a: f64, b: f64): f64', desc: 'maximum' },
  trunc:    { sig: 'trunc(x: f64): f64', desc: 'truncate toward zero' },
  nearest:  { sig: 'nearest(x: f64): f64', desc: 'round to nearest' },
  copysign: { sig: 'copysign(x: f64, y: f64): f64', desc: 'copy sign of y to x' },
  select:   { sig: 'select(a: f64, b: f64, c: i32): f64', desc: 'if c then a else b' },
  clz:      { sig: 'clz(x: i32): i32', desc: 'count leading zeros' },
  ctz:      { sig: 'ctz(x: i32): i32', desc: 'count trailing zeros' },
  popcnt:   { sig: 'popcnt(x: i32): i32', desc: 'population count' },
  rotl:     { sig: 'rotl(x: i32, y: i32): i32', desc: 'rotate left' },
  rotr:     { sig: 'rotr(x: i32, y: i32): i32', desc: 'rotate right' },
  memory_size: { sig: 'memory_size(): i32', desc: 'current memory size in pages' },
  memory_grow: { sig: 'memory_grow(pages: i32): i32', desc: 'grow memory' },
  memory_copy: { sig: 'memory_copy(dst: i32, src: i32, len: i32)', desc: 'copy memory' },
  memory_fill: { sig: 'memory_fill(dst: i32, val: i32, len: i32)', desc: 'fill memory' },
};

// ── User-defined name extraction ──

const NAMING_KW = new Set(['var', 'const', 'function', 'subroutine', 'import']);
const STMT_STARTERS = new Set(['begin', 'end', 'then', 'else', 'do']);
const EXPR_KEYWORDS = new Set(['and', 'or', 'not', 'mod', 'true', 'false', 'array', 'call', 'tailcall']);

function extractAtraNames(code) {
  const tokens = tokenizeAtra(code);
  const functions = [];
  const variables = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'kw') continue;
    const kw = t.text.toLowerCase();

    if (kw === 'function' || kw === 'subroutine' || kw === 'import') {
      // next non-ws should be the name
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === '') j++;
      if (j >= tokens.length || (tokens[j].type !== 'fn' && tokens[j].type !== 'id')) continue;
      const name = tokens[j].text;

      // find opening paren
      let k = j + 1;
      while (k < tokens.length && tokens[k].type === '') k++;
      if (k >= tokens.length || tokens[k].text !== '(') {
        if (kw !== 'import') functions.push({ name, sig: name + '()', desc: kw });
        continue;
      }

      // collect params text
      let paramText = '';
      let depth = 1;
      k++;
      while (k < tokens.length && depth > 0) {
        if (tokens[k].text === '(') depth++;
        else if (tokens[k].text === ')') { depth--; if (depth === 0) break; }
        paramText += tokens[k].text;
        k++;
      }

      // check for return type: ) : TYPE
      let retType = '';
      let m = k + 1;
      while (m < tokens.length && tokens[m].type === '') m++;
      if (m < tokens.length && tokens[m].text === ':') {
        m++;
        while (m < tokens.length && tokens[m].type === '') m++;
        if (m < tokens.length && (tokens[m].type === 'const' || tokens[m].type === 'id')) {
          retType = tokens[m].text;
        }
      }

      const sig = retType ? `${name}(${paramText.trim()}): ${retType}` : `${name}(${paramText.trim()})`;
      functions.push({ name, sig, desc: kw });
      continue;
    }

    if (kw === 'var' || kw === 'const') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === '') j++;
      if (j < tokens.length && (tokens[j].type === 'id' || tokens[j].type === 'fn')) {
        variables.push({ name: tokens[j].text, kind: kw });
      }
    }
  }

  return { functions, variables };
}

// ── Signature hints ──

export function atraSigHint(code, cursor) {
  const tokens = tokenizeAtra(code.slice(0, cursor));

  // compute token offsets
  const offsets = [];
  let pos = 0;
  for (const t of tokens) {
    offsets.push(pos);
    pos += t.text.length;
  }

  // scan backwards for unmatched (
  let depth = 0;
  let parenIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type === 'punc') {
      if (tokens[i].text === ')') depth++;
      else if (tokens[i].text === '(') {
        if (depth === 0) { parenIdx = i; break; }
        depth--;
      }
    }
  }
  if (parenIdx < 0) return null;

  // find function name before the (
  let fnIdx = -1;
  for (let i = parenIdx - 1; i >= 0; i--) {
    if (tokens[i].type === '') continue;
    if (tokens[i].type === 'fn' || tokens[i].type === 'id') fnIdx = i;
    break;
  }
  if (fnIdx < 0) return null;

  const fnName = tokens[fnIdx].text.toLowerCase();

  // look up signature
  let sig, desc;
  if (ATRA_BUILTIN_SIGS[fnName]) {
    sig = ATRA_BUILTIN_SIGS[fnName].sig;
    desc = ATRA_BUILTIN_SIGS[fnName].desc;
  } else {
    const names = extractAtraNames(code);
    const fn = names.functions.find(f => f.name.toLowerCase() === fnName);
    if (!fn) return null;
    sig = fn.sig;
    desc = fn.desc || '';
  }

  // count commas at depth 0 for paramIdx
  let paramIdx = 0;
  let d = 0;
  for (let i = parenIdx + 1; i < tokens.length; i++) {
    if (tokens[i].type === 'punc') {
      if (tokens[i].text === '(' || tokens[i].text === '[') d++;
      else if (tokens[i].text === ')' || tokens[i].text === ']') d--;
      else if (tokens[i].text === ',' && d === 0) paramIdx++;
    }
  }

  return { sig, desc, paramIdx, parenPos: offsets[parenIdx] };
}

// ── Layout name/field extraction for completions ──

function extractLayoutNames(code) {
  const tokens = tokenizeAtra(code);
  const names = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'kw' && tokens[i].text.toLowerCase() === 'layout') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === '') j++;
      // skip optional 'packed'
      if (j < tokens.length && tokens[j].type === 'kw' && tokens[j].text.toLowerCase() === 'packed') {
        j++;
        while (j < tokens.length && tokens[j].type === '') j++;
      }
      if (j < tokens.length && tokens[j].type === 'id') {
        names.push(tokens[j].text);
      }
    }
  }
  return names;
}

function extractLayoutFields(code, layoutName) {
  const tokens = tokenizeAtra(code);
  const fields = [];
  let inLayout = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'kw' && tokens[i].text.toLowerCase() === 'layout') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === '') j++;
      if (j < tokens.length && tokens[j].type === 'kw' && tokens[j].text.toLowerCase() === 'packed') {
        j++;
        while (j < tokens.length && tokens[j].type === '') j++;
      }
      if (j < tokens.length && tokens[j].text === layoutName) {
        inLayout = true;
        i = j;
        continue;
      }
    }
    if (inLayout) {
      if (tokens[i].type === 'kw' && tokens[i].text.toLowerCase() === 'end') {
        break;
      }
      if (tokens[i].type === 'id') fields.push(tokens[i].text);
    }
  }
  return fields;
}

// ── Context-aware completions ──

export function atraCompletions(code, cursor, prefix) {
  // backward compat: old callers may pass just (prefix) or nothing
  if (cursor === undefined) {
    const items = [];
    for (const w of ATRA_KEYWORDS) items.push({ text: w, kind: 'kw' });
    for (const w of ATRA_TYPES)    items.push({ text: w, kind: 'const' });
    for (const w of ATRA_BUILTINS) items.push({ text: w, kind: 'fn' });
    return items;
  }

  const beforePrefix = code.slice(0, cursor - prefix.length);
  const tokens = tokenizeAtra(beforePrefix);

  // determine context from last meaningful token
  let context = 'statement';
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === '') {
      if (t.text === '\n') break; // newline → statement start
      continue;
    }
    if (t.type === 'punc' && t.text === ':') { context = 'type'; break; }
    if (t.type === 'kw' && NAMING_KW.has(t.text.toLowerCase())) { context = 'naming'; break; }
    if (t.type === 'kw' && STMT_STARTERS.has(t.text.toLowerCase())) break; // statement start
    context = 'expression';
    break;
  }

  if (context === 'naming') return [];
  if (context === 'type') {
    const items = Array.from(ATRA_TYPES).map(w => ({ text: w, kind: 'const' }));
    items.push({ text: 'layout', kind: 'kw' });
    const layoutNames = extractLayoutNames(code);
    for (const n of layoutNames) items.push({ text: n, kind: 'const' });
    return items;
  }

  // Layout field completions: prefix is "LayoutName." → offer field names + __size, __align
  if (prefix.includes('.')) {
    const dotIdx = prefix.lastIndexOf('.');
    const base = prefix.slice(0, dotIdx);
    const layoutNames = extractLayoutNames(code);
    if (layoutNames.includes(base)) {
      const fields = extractLayoutFields(code, base);
      return [
        ...fields.map(f => ({ text: base + '.' + f, kind: 'var' })),
        { text: base + '.__size', kind: 'const' },
        { text: base + '.__align', kind: 'const' },
      ];
    }
  }

  const items = [];
  const { functions, variables } = extractAtraNames(code);

  if (context === 'statement') {
    for (const w of ATRA_KEYWORDS) items.push({ text: w, kind: 'kw' });
    for (const w of ATRA_TYPES)    items.push({ text: w, kind: 'const' });
  } else {
    for (const w of EXPR_KEYWORDS) items.push({ text: w, kind: 'kw' });
    for (const w of ATRA_TYPES)    items.push({ text: w, kind: 'const' });
  }

  for (const w of ATRA_BUILTINS) items.push({ text: w, kind: 'fn' });
  for (const f of functions) items.push({ text: f.name, kind: 'fn' });
  for (const v of variables) items.push({ text: v.name, kind: 'var' });

  // Add layout names to expression/statement completions
  const layoutNames = extractLayoutNames(code);
  for (const n of layoutNames) items.push({ text: n, kind: 'const' });

  return items;
}
