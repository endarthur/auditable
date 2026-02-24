// Syntax highlighting — tokenizer + completions for auditable editor integration

export const ATRA_KEYWORDS = new Set([
  'function','subroutine','begin','end','var','const','if','then','else',
  'for','while','do','break','and','or','not','mod','import','export',
  'call','array','true','false','from','tailcall','return',
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
    if ('+-*/<>=&|^~'.includes(code[i])) {
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

export function atraCompletions() {
  const items = [];
  for (const w of ATRA_KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of ATRA_TYPES)    items.push({ text: w, kind: 'const' });
  for (const w of ATRA_BUILTINS) items.push({ text: w, kind: 'fn' });
  return items;
}
