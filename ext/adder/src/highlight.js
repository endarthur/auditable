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

export function tokenizePython(code) {
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

export function pythonCompletions(prefix) {
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

export { PYTHON_KEYWORDS, PYTHON_BUILTINS };
