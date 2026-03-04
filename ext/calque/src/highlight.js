// Syntax highlighting — tokenizer + completions for auditable editor integration
//
// These keyword/builtin sets define calque's vocabulary. Shared between
// this module (editor highlighting + completions) and lex.js (compiler tokenizer).

export const CALQUE_KEYWORDS = new Set([
  'if', 'then', 'else', 'and', 'or', 'not',
  'true', 'false', 'null', 'import', 'sheet',
]);

export const CALQUE_BUILTINS = new Set([
  'sum', 'mean', 'count', 'min', 'max',
  'lookup', 'sort', 'unique',
  'scan', 'rolling',
  'left', 'right', 'mid', 'len', 'trim', 'text', 'str',
  'date', 'year', 'month', 'day', 'today',
  'iferror', 'ifna',
  'round', 'abs', 'floor', 'ceil', 'sqrt', 'log', 'exp', 'mod',
]);

export function tokenizeCalque(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    // line comment: -- to end of line
    if (code[i] === '-' && code[i + 1] === '-') {
      const start = i;
      while (i < len && code[i] !== '\n') i++;
      tokens.push({ type: 'cmt', text: code.slice(start, i) });
      continue;
    }
    // template string
    if (code[i] === '`') {
      const start = i;
      i++; // skip opening backtick
      while (i < len && code[i] !== '`') {
        if (code[i] === '$' && code[i + 1] === '{') {
          // push text before interpolation
          if (i > start + 1) {
            const seg = code.slice(start, i);
            tokens.push({ type: 'str', text: seg });
          }
          tokens.push({ type: 'punc', text: '${' });
          i += 2;
          // tokenize inside interpolation until matching }
          let depth = 1;
          const exprStart = i;
          while (i < len && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) break; }
            i++;
          }
          // tokenize the inner expression
          const inner = code.slice(exprStart, i);
          const innerTokens = tokenizeCalque(inner);
          tokens.push(...innerTokens);
          tokens.push({ type: 'punc', text: '}' });
          if (i < len) i++; // skip closing }
          // restart string segment tracking - use a pseudo-start
          continue;
        }
        if (code[i] === '\\') { i++; if (i < len) i++; }
        else i++;
      }
      if (i < len) i++; // skip closing backtick
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // numbers
    if (/\d/.test(code[i]) || (code[i] === '.' && i + 1 < len && /\d/.test(code[i + 1]))) {
      const start = i;
      while (i < len && /\d/.test(code[i])) i++;
      if (code[i] === '.' && /\d/.test(code[i + 1] || '')) {
        i++;
        while (i < len && /\d/.test(code[i])) i++;
      }
      if (i < len && /[eE]/.test(code[i])) {
        i++;
        if (i < len && /[+-]/.test(code[i])) i++;
        while (i < len && /\d/.test(code[i])) i++;
      }
      tokens.push({ type: 'num', text: code.slice(start, i) });
      continue;
    }
    // string literal
    if (code[i] === '"') {
      const start = i;
      i++;
      while (i < len && code[i] !== '"') {
        if (code[i] === '\\') { i++; if (i < len) i++; }
        else i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'str', text: code.slice(start, i) });
      continue;
    }
    // directive: @name
    if (code[i] === '@') {
      const start = i;
      i++;
      while (i < len && /[\w]/.test(code[i])) i++;
      tokens.push({ type: 'dir', text: code.slice(start, i) });
      continue;
    }
    // identifiers / keywords
    if (/[a-zA-Z_]/.test(code[i])) {
      const start = i;
      while (i < len && /[\w]/.test(code[i])) i++;
      const word = code.slice(start, i);
      if (CALQUE_KEYWORDS.has(word)) {
        tokens.push({ type: 'kw', text: word });
      } else if (CALQUE_BUILTINS.has(word)) {
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
      if (two === '..' || two === '->' || two === '==' || two === '/=' ||
          two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'op', text: two });
        i += 2;
        continue;
      }
    }
    // single-char operators
    if ('+-*/^&<>='.includes(code[i])) {
      tokens.push({ type: 'op', text: code[i] });
      i++;
      continue;
    }
    // punctuation
    if ('()[]{},:'.includes(code[i])) {
      tokens.push({ type: 'punc', text: code[i] });
      i++;
      continue;
    }
    // dot (member access)
    if (code[i] === '.') {
      tokens.push({ type: 'punc', text: '.' });
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

const CALQUE_BUILTIN_SIGS = {
  sum:     { sig: 'sum(col)', desc: 'sum of column values' },
  mean:    { sig: 'mean(col)', desc: 'arithmetic mean' },
  count:   { sig: 'count(col)', desc: 'count non-blank values' },
  min:     { sig: 'min(col)', desc: 'minimum value' },
  max:     { sig: 'max(col)', desc: 'maximum value' },
  lookup:  { sig: 'lookup(needle, keys, values, nearest?)', desc: 'look up value by key' },
  sort:    { sig: 'sort(table, col, desc?)', desc: 'sort table by column' },
  unique:  { sig: 'unique(col)', desc: 'unique values' },
  scan:    { sig: 'scan(col, init, fn)', desc: 'cumulative scan with accumulator' },
  rolling: { sig: 'rolling(col, window, fn)', desc: 'windowed computation' },
  left:    { sig: 'left(str, n)', desc: 'first n characters' },
  right:   { sig: 'right(str, n)', desc: 'last n characters' },
  mid:     { sig: 'mid(str, start, n)', desc: 'substring from start' },
  len:     { sig: 'len(str)', desc: 'string length' },
  trim:    { sig: 'trim(str)', desc: 'remove leading/trailing whitespace' },
  text:    { sig: 'text(val, fmt)', desc: 'format value as string' },
  str:     { sig: 'str(val)', desc: 'convert to string' },
  date:    { sig: 'date(year, month, day)', desc: 'date serial number' },
  year:    { sig: 'year(date)', desc: 'year from date serial' },
  month:   { sig: 'month(date)', desc: 'month from date serial' },
  day:     { sig: 'day(date)', desc: 'day from date serial' },
  today:   { sig: 'today()', desc: 'current date serial number' },
  iferror: { sig: 'iferror(expr, fallback)', desc: 'fallback on error' },
  ifna:    { sig: 'ifna(expr, fallback)', desc: 'fallback on #N/A' },
  round:   { sig: 'round(val, digits?)', desc: 'round to digits' },
  abs:     { sig: 'abs(val)', desc: 'absolute value' },
  floor:   { sig: 'floor(val)', desc: 'round down' },
  ceil:    { sig: 'ceil(val)', desc: 'round up' },
  sqrt:    { sig: 'sqrt(val)', desc: 'square root' },
  log:     { sig: 'log(val, base?)', desc: 'logarithm (default base 10)' },
  exp:     { sig: 'exp(val)', desc: 'e^val' },
  mod:     { sig: 'mod(val, divisor)', desc: 'remainder' },
};

// ── User-defined name extraction ──

function extractCalqueNames(code) {
  const tokens = tokenizeCalque(code);
  const functions = [];
  const variables = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'id' && t.type !== 'fn') continue;
    const name = t.text;

    // look ahead past whitespace
    let j = i + 1;
    while (j < tokens.length && tokens[j].type === '') j++;

    // name(params) = expr → function
    if (j < tokens.length && tokens[j].text === '(') {
      // find matching )
      let k = j + 1, depth = 1;
      let paramText = '';
      while (k < tokens.length && depth > 0) {
        if (tokens[k].text === '(') depth++;
        else if (tokens[k].text === ')') { depth--; if (depth === 0) break; }
        paramText += tokens[k].text;
        k++;
      }
      // check for = after )
      let m = k + 1;
      while (m < tokens.length && tokens[m].type === '') m++;
      if (m < tokens.length && tokens[m].text === '=') {
        functions.push({ name, sig: `${name}(${paramText.trim()})`, desc: 'function' });
        i = m;
        continue;
      }
    }

    // name = expr → variable binding
    if (j < tokens.length && tokens[j].text === '=') {
      // make sure it's not ==
      if (j + 1 < tokens.length && tokens[j + 1].text === '=') continue;
      variables.push({ name, kind: 'binding' });
      i = j;
    }
  }

  return { functions, variables };
}

// ── Signature hints ──

export function calqueSigHint(code, cursor) {
  const tokens = tokenizeCalque(code.slice(0, cursor));

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
    if (tokens[i].type === 'punc' || tokens[i].type === 'op') {
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

  const fnName = tokens[fnIdx].text;

  // look up signature
  let sig, desc;
  if (CALQUE_BUILTIN_SIGS[fnName]) {
    sig = CALQUE_BUILTIN_SIGS[fnName].sig;
    desc = CALQUE_BUILTIN_SIGS[fnName].desc;
  } else {
    const names = extractCalqueNames(code);
    const fn = names.functions.find(f => f.name === fnName);
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

// ── Completions ──

const CALQUE_DIRECTIVES = ['@below', '@right', '@anchor', '@formula'];

export function calqueCompletions(code, cursor, prefix) {
  if (cursor === undefined) {
    const items = [];
    for (const w of CALQUE_KEYWORDS) items.push({ text: w, kind: 'kw' });
    for (const w of CALQUE_BUILTINS) items.push({ text: w, kind: 'fn' });
    for (const w of CALQUE_DIRECTIVES) items.push({ text: w, kind: 'dir' });
    return items;
  }

  const items = [];
  const { functions, variables } = extractCalqueNames(code);

  for (const w of CALQUE_KEYWORDS) items.push({ text: w, kind: 'kw' });
  for (const w of CALQUE_BUILTINS) items.push({ text: w, kind: 'fn' });
  for (const w of CALQUE_DIRECTIVES) items.push({ text: w, kind: 'dir' });
  for (const f of functions) items.push({ text: f.name, kind: 'fn' });
  for (const v of variables) items.push({ text: v.name, kind: 'var' });

  return items;
}
