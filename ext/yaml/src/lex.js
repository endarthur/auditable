// Lexer for @gcu/yaml.
//
// Two layers:
//   1. preprocess(text) — splits into line records, normalizes CRLF→LF,
//      rejects BOM and bare CR, strips trailing SP, computes indent.
//   2. Scalar / key / tag / comment parsers — pure functions the parser
//      uses to interpret line content.
//
// Block scalar bodies are NOT processed here. The parser captures the body
// lines verbatim from the raw line records.

import { YamlParseError, scalar } from './types.js';

// ---- 1. Line preprocessing ------------------------------------------------

export function preprocess(text) {
  // §4.1 — UTF-8 BOM at start is an error.
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    throw new YamlParseError('4.1', 1, 1, 'UTF-8 BOM not permitted');
  }

  // §4.2 — accept LF and CRLF; bare CR is an error. We walk the input
  // character by character to give precise diagnostics for bare CR.
  const out = [];
  let line = 1, col = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0D) {
      if (text.charCodeAt(i + 1) !== 0x0A) {
        throw new YamlParseError('4.2', line, col, 'bare CR not followed by LF');
      }
      // Skip the CR; the LF on the next iteration ends the line.
      continue;
    }
    out.push(text[i]);
    if (c === 0x0A) { line++; col = 1; }
    else { col++; }
  }
  const norm = out.join('');

  // Split into line records.
  const lines = [];
  let cur = '';
  let curLine = 1;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '\n') {
      lines.push(makeLineRecord(cur, curLine));
      cur = '';
      curLine++;
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) lines.push(makeLineRecord(cur, curLine));
  return lines;
}

function makeLineRecord(raw, lineNumber) {
  // §4.4 — strip trailing SP silently.
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 0x20) end--;
  const trimmed = raw.slice(0, end);

  // §4.4 — tabs anywhere before the first non-whitespace character are
  // forbidden (and tabs as a separator are forbidden, but the parser checks
  // that against content).
  let indent = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c === 0x20) { indent++; continue; }
    if (c === 0x09) {
      throw new YamlParseError('4.4', lineNumber, i + 1,
        'tab not permitted in indentation');
    }
    break;
  }

  return {
    raw,
    indent,
    content: trimmed.slice(indent),
    lineNumber,
    isBlank: trimmed.length === 0,
  };
}

// ---- 2. Comment splitting -------------------------------------------------

// Splits a line's content into { body, comment }.
//   body:    content with the trailing-comment portion removed and any
//            trailing SP between body and # stripped.
//   comment: the comment text without the # (or null if no comment).
// Respects "..." and '...' boundaries so a # inside a string is not a comment.
// A trailing # must have at least one SP before it (or be at start of content).
export function splitComment(content) {
  let inDQ = false, inSQ = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inDQ) {
      if (c === '\\') { i++; continue; }  // skip escaped next char
      if (c === '"') inDQ = false;
      continue;
    }
    if (inSQ) {
      if (c === "'" && content[i + 1] === "'") { i++; continue; }
      if (c === "'") inSQ = false;
      continue;
    }
    if (c === '"') { inDQ = true; continue; }
    if (c === "'") { inSQ = true; continue; }
    if (c === '#') {
      if (i === 0 || content[i - 1] === ' ') {
        let bodyEnd = i;
        while (bodyEnd > 0 && content[bodyEnd - 1] === ' ') bodyEnd--;
        return { body: content.slice(0, bodyEnd), comment: content.slice(i + 1) };
      }
      // # not preceded by SP — part of value. Let the value parser fail on it.
    }
  }
  return { body: content, comment: null };
}

// Returns true if content is a comment-only line (after indent).
export function isCommentOnly(content) {
  return content.length > 0 && content[0] === '#';
}

// Extracts the text of a comment-only line (without the leading #).
export function commentBody(content) {
  return content.slice(1);
}

// ---- 3. Character classes ------------------------------------------------

function isLetterOrUnderscore(c) {
  return (c >= 0x41 && c <= 0x5A)   // A-Z
      || (c >= 0x61 && c <= 0x7A)   // a-z
      || c === 0x5F;                 // _
}

function isDigit(c) {
  return c >= 0x30 && c <= 0x39;
}

function isBareKeyTail(c) {
  return isLetterOrUnderscore(c) || isDigit(c) || c === 0x2D || c === 0x2E;  // - .
}

function isTagNameTail(c) {
  // §9.2 — tag names exclude the dot.
  return isLetterOrUnderscore(c) || isDigit(c) || c === 0x2D;
}

// ---- 4. Tag parsing ------------------------------------------------------

// If `content` starts with a tag, returns { tag, restAfterTag, tagWidth }.
// `restAfterTag` is `content` with the tag and the SP after it (if any) consumed.
// Returns null if there is no tag. Throws on malformed tag.
export function tryParseTag(content, lineNumber, columnBase) {
  if (content[0] !== '!') return null;

  if (content[1] === '!') {
    throw new YamlParseError('9.2', lineNumber, columnBase + 1,
      '!!-prefixed tags not permitted');
  }
  if (content[1] === '<') {
    throw new YamlParseError('9.2', lineNumber, columnBase + 1,
      'verbatim !<...> tags not permitted');
  }
  if (content.length < 2 || !isLetterOrUnderscore(content.charCodeAt(1))) {
    throw new YamlParseError('9.2', lineNumber, columnBase + 1,
      'tag name must begin with letter or underscore');
  }

  let i = 2;
  while (i < content.length && isTagNameTail(content.charCodeAt(i))) i++;
  const tag = content.slice(1, i);

  // After the tag, expect either end-of-content, or exactly one SP then more.
  let rest = content.slice(i);
  if (rest.length > 0 && rest[0] !== ' ') {
    throw new YamlParseError('9.3', lineNumber, columnBase + i + 1,
      'tag must be followed by space or end of line');
  }
  if (rest.length > 0) rest = rest.slice(1);

  return { tag, restAfterTag: rest, tagWidth: i + (content.slice(i).length > 0 ? 1 : 0) };
}

// ---- 5. Bare key detection -----------------------------------------------

export function tryParseBareKey(content) {
  if (content.length === 0) return null;
  if (!isLetterOrUnderscore(content.charCodeAt(0))) return null;
  let i = 1;
  while (i < content.length && isBareKeyTail(content.charCodeAt(i))) i++;
  return { key: content.slice(0, i), len: i };
}

// ---- 6. Scalar value parsing ---------------------------------------------

// Parses the "value" text (after `key: ` or `- `).
//   { node }            — scalar AST node
//   { emptySeq: true }  — text was `[]`
//   { emptyMap: true }  — text was `{}`
// Throws on malformed values or unquoted plain scalars.
export function parseValueText(text, lineNumber, columnBase) {
  if (text === '[]') return { emptySeq: true };
  if (text === '{}') return { emptyMap: true };

  // Detect any flow-collection use beyond empty (must come before scalar parse
  // so we point at the right column).
  rejectFlowChars(text, lineNumber, columnBase);

  if (text === 'null') {
    return { node: scalar('null', null, { loc: { line: lineNumber, column: columnBase } }) };
  }
  if (text === 'true') {
    return { node: scalar('bool', true, { loc: { line: lineNumber, column: columnBase } }) };
  }
  if (text === 'false') {
    return { node: scalar('bool', false, { loc: { line: lineNumber, column: columnBase } }) };
  }

  if (/^(Null|NULL|~)$/.test(text)) {
    throw new YamlParseError('6.1', lineNumber, columnBase,
      `null must be written as 'null' (got '${text}')`);
  }
  if (/^(True|TRUE|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/.test(text)) {
    throw new YamlParseError('6.2', lineNumber, columnBase,
      `booleans must be 'true' or 'false' (got '${text}')`);
  }

  if (text[0] === '"') {
    return { node: parseDoubleQuoted(text, lineNumber, columnBase) };
  }
  if (text[0] === "'") {
    return { node: parseSingleQuoted(text, lineNumber, columnBase) };
  }

  // Try integer first (since "1" parses as int, not float). Then float.
  const intResult = tryParseInt(text);
  if (intResult !== null) {
    if (intResult.error) {
      throw new YamlParseError(intResult.rule, lineNumber, columnBase, intResult.error);
    }
    return {
      node: scalar('int', intResult.value, {
        radix: intResult.radix,
        separators: intResult.separators,
        loc: { line: lineNumber, column: columnBase },
      }),
    };
  }

  const floatResult = tryParseFloat(text);
  if (floatResult !== null) {
    if (floatResult.error) {
      throw new YamlParseError(floatResult.rule, lineNumber, columnBase, floatResult.error);
    }
    return {
      node: scalar('float', floatResult.value, {
        loc: { line: lineNumber, column: columnBase },
      }),
    };
  }

  // No quote, doesn't match null/bool/int/float → plain scalar, rejected.
  throw new YamlParseError('6.5', lineNumber, columnBase,
    `plain (unquoted) scalars not permitted; quote the value`);
}

function rejectFlowChars(text, lineNumber, columnBase) {
  let inDQ = false, inSQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inDQ) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inDQ = false;
      continue;
    }
    if (inSQ) {
      if (c === "'" && text[i + 1] === "'") { i++; continue; }
      if (c === "'") inSQ = false;
      continue;
    }
    if (c === '"') { inDQ = true; continue; }
    if (c === "'") { inSQ = true; continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}') {
      throw new YamlParseError('8.3', lineNumber, columnBase + i,
        'flow collections not permitted except empty [] and {}');
    }
  }
}

// ---- 7. Integer parsing --------------------------------------------------

function tryParseInt(text) {
  if (text.length === 0) return null;

  let sign = 1;
  let s = text;
  // §6.3 — hex/oct/bin allow only leading '-' (not '+').
  if (s[0] === '+') { sign = 1; s = s.slice(1); }
  else if (s[0] === '-') { sign = -1; s = s.slice(1); }

  if (s.length === 0) return null;

  // Hex / Oct / Bin
  if (s[0] === '0' && s.length > 1) {
    const p = s[1];
    if (p === 'x' || p === 'X') return parseRadix(s.slice(2), 16, sign, 'hex', text[0] === '+');
    if (p === 'o' || p === 'O') return parseRadix(s.slice(2), 8, sign, 'oct', text[0] === '+');
    if (p === 'b' || p === 'B') return parseRadix(s.slice(2), 2, sign, 'bin', text[0] === '+');
  }

  // Decimal: 0 alone, or [1-9] then digit/_digit
  if (!/^[0-9]/.test(s)) return null;
  if (s === '0') return { value: 0, radix: null, separators: false };
  if (s[0] === '0') {
    // Could be a float (0.5) or invalid (01). Only reject if it's a pure-digit
    // run that doesn't continue into a float.
    if (/^0[0-9_]/.test(s) && !s.includes('.') && !/[eE]/.test(s)) {
      return { error: 'decimal integers may not have a leading zero', rule: '6.3' };
    }
    return null;  // let the float parser try
  }

  if (!validateUnderscored(s, c => c >= '0' && c <= '9')) {
    // Not a pure integer literal — could still be a float (has '.', 'e', etc.).
    return null;
  }

  const separators = s.includes('_');
  const plain = s.replace(/_/g, '');
  const value = sign * Number(plain);
  if (!Number.isSafeInteger(value)) {
    return { error: 'integer outside safe range (above 2^53)', rule: '6.3' };
  }
  return { value, radix: null, separators };
}

function parseRadix(body, radix, sign, name, hadPlus) {
  if (hadPlus) return { error: `${name} integer cannot have leading '+'`, rule: '6.3' };
  if (body.length === 0) {
    return { error: `${name} integer requires at least one digit`, rule: '6.3' };
  }
  if (body[0] === '_') return { error: 'leading underscore not permitted in number', rule: '6.3' };
  if (body[body.length - 1] === '_') return { error: 'trailing underscore not permitted in number', rule: '6.3' };
  if (body.includes('__')) return { error: 'doubled underscore not permitted in number', rule: '6.3' };

  let valid;
  if (radix === 16) valid = c => /[0-9a-fA-F]/.test(c) || c === '_';
  else if (radix === 8) valid = c => (c >= '0' && c <= '7') || c === '_';
  else valid = c => c === '0' || c === '1' || c === '_';

  for (const c of body) {
    if (!valid(c)) return null;
  }

  const stripped = body.replace(/_/g, '');
  const value = sign * parseInt(stripped, radix);
  if (!Number.isSafeInteger(value)) {
    return { error: `${name} integer outside safe range`, rule: '6.3' };
  }
  return { value, radix: name, separators: body.includes('_') };
}

function validateUnderscored(s, isAllowedDigit) {
  if (s.length === 0) return false;
  if (s[0] === '_' || s[s.length - 1] === '_') return false;
  let prev = null;
  for (const c of s) {
    if (c === '_') {
      if (prev === '_' || prev === null) return false;
    } else if (!isAllowedDigit(c)) {
      return false;
    }
    prev = c;
  }
  return true;
}

// ---- 8. Float parsing ----------------------------------------------------

function tryParseFloat(text) {
  // To be a float, the token must contain '.' or 'e'/'E'.
  let s = text;
  let sign = 1;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') { sign = -1; s = s.slice(1); }

  const hasDot = s.includes('.');
  const hasExp = /[eE]/.test(s);
  if (!hasDot && !hasExp) return null;

  // Non-finite forbidden.
  if (/^[+-]?(NaN|nan|Inf|inf|Infinity|infinity|\.inf|\.nan|\.NaN|\.Inf)$/.test(text)) {
    return { error: 'non-finite floats not permitted', rule: '6.4' };
  }

  let i = 0;
  let intPart = '';
  while (i < s.length && /[0-9_]/.test(s[i])) { intPart += s[i]; i++; }

  let dotPresent = false;
  if (s[i] === '.') { dotPresent = true; i++; }

  let fracPart = '';
  while (i < s.length && /[0-9_]/.test(s[i])) { fracPart += s[i]; i++; }

  let expSign = '', expPart = '';
  if (i < s.length && (s[i] === 'e' || s[i] === 'E')) {
    i++;
    if (s[i] === '+' || s[i] === '-') { expSign = s[i]; i++; }
    while (i < s.length && /[0-9_]/.test(s[i])) { expPart += s[i]; i++; }
  }

  if (i !== s.length) return null;

  // Per grammar:
  //   significand = digits "." [digits]   (intPart present, dot present)
  //               | "." digits             (intPart empty, dot present, fracPart non-empty)
  //               | digits                  (with exponent only)
  if (dotPresent) {
    if (intPart === '' && fracPart === '') return null;
  } else {
    if (intPart === '' || expPart === '') return null;
  }

  const digitsRe = c => c >= '0' && c <= '9';
  if (intPart && !validateUnderscored(intPart, digitsRe)) {
    return { error: 'malformed float significand', rule: '6.4' };
  }
  if (fracPart && !validateUnderscored(fracPart, digitsRe)) {
    return { error: 'malformed float fraction', rule: '6.4' };
  }
  if (expPart && !validateUnderscored(expPart, digitsRe)) {
    return { error: 'malformed float exponent', rule: '6.4' };
  }
  if ((s.startsWith('e') || s.startsWith('E')) && intPart === '') {
    return null;
  }

  let assembled = (intPart.replace(/_/g, '') || '0');
  if (dotPresent) assembled += '.' + (fracPart.replace(/_/g, '') || '0');
  if (expPart) assembled += 'e' + expSign + expPart.replace(/_/g, '');

  const value = sign * Number(assembled);
  if (!Number.isFinite(value)) {
    return { error: 'float not finite', rule: '6.4' };
  }
  return { value };
}

// ---- 9. Double-quoted string ---------------------------------------------

function parseDoubleQuoted(text, lineNumber, columnBase) {
  let i = 1;
  const out = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      if (i !== text.length - 1) {
        throw new YamlParseError('6.5', lineNumber, columnBase + i + 1,
          'unexpected content after closing double quote');
      }
      return scalar('string', out.join(''), {
        style: 'double',
        loc: { line: lineNumber, column: columnBase },
      });
    }
    if (c === '\\') {
      const e = text[i + 1];
      if (e === undefined) {
        throw new YamlParseError('6.5', lineNumber, columnBase + i,
          'incomplete escape sequence');
      }
      if (e === '"') { out.push('"'); i += 2; continue; }
      if (e === '\\') { out.push('\\'); i += 2; continue; }
      if (e === '/') { out.push('/'); i += 2; continue; }
      if (e === 'b') { out.push('\b'); i += 2; continue; }
      if (e === 'f') { out.push('\f'); i += 2; continue; }
      if (e === 'n') { out.push('\n'); i += 2; continue; }
      if (e === 'r') { out.push('\r'); i += 2; continue; }
      if (e === 't') { out.push('\t'); i += 2; continue; }
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new YamlParseError('6.5', lineNumber, columnBase + i,
            'malformed \\uXXXX escape (needs 4 hex digits)');
        }
        out.push(String.fromCharCode(parseInt(hex, 16)));
        i += 6;
        continue;
      }
      throw new YamlParseError('6.5', lineNumber, columnBase + i,
        `invalid escape sequence \\${e}`);
    }
    const cc = c.charCodeAt(0);
    if (cc < 0x20 || cc === 0x7F) {
      throw new YamlParseError('6.5', lineNumber, columnBase + i,
        'raw control character in double-quoted string; use \\ escape');
    }
    out.push(c);
    i++;
  }
  throw new YamlParseError('6.5', lineNumber, columnBase,
    'unterminated double-quoted string (raw line break inside?)');
}

// ---- 10. Single-quoted string --------------------------------------------

function parseSingleQuoted(text, lineNumber, columnBase) {
  let i = 1;
  const out = [];
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      if (text[i + 1] === "'") {
        out.push("'");
        i += 2;
        continue;
      }
      if (i !== text.length - 1) {
        throw new YamlParseError('6.5', lineNumber, columnBase + i + 1,
          'unexpected content after closing single quote');
      }
      return scalar('string', out.join(''), {
        style: 'single',
        loc: { line: lineNumber, column: columnBase },
      });
    }
    const cc = c.charCodeAt(0);
    if (cc < 0x20 || cc === 0x7F) {
      throw new YamlParseError('6.5', lineNumber, columnBase + i,
        'raw control character in single-quoted string; use double quotes with \\ escape');
    }
    out.push(c);
    i++;
  }
  throw new YamlParseError('6.5', lineNumber, columnBase,
    'unterminated single-quoted string (raw line break inside?)');
}

// ---- 11. Parse a quoted key inline ---------------------------------------

// Used by the parser when a line starts with " or '. Returns
// { key, consumed } where `consumed` is the number of chars read (including
// the closing quote). Throws on malformed quote.
export function parseQuotedKey(content, lineNumber, columnBase) {
  const ch = content[0];
  if (ch !== '"' && ch !== "'") return null;

  let i = 1;
  if (ch === '"') {
    while (i < content.length) {
      if (content[i] === '\\') { i += 2; continue; }
      if (content[i] === '"') break;
      const cc = content.charCodeAt(i);
      if (cc < 0x20 || cc === 0x7F) {
        throw new YamlParseError('6.5', lineNumber, columnBase + i,
          'raw control character in double-quoted key');
      }
      i++;
    }
    if (content[i] !== '"') {
      throw new YamlParseError('6.5', lineNumber, columnBase,
        'unterminated double-quoted key');
    }
    const raw = content.slice(0, i + 1);
    const node = parseDoubleQuoted(raw, lineNumber, columnBase);
    return { keyNode: node, consumed: i + 1 };
  } else {
    while (i < content.length) {
      if (content[i] === "'" && content[i + 1] === "'") { i += 2; continue; }
      if (content[i] === "'") break;
      const cc = content.charCodeAt(i);
      if (cc < 0x20 || cc === 0x7F) {
        throw new YamlParseError('6.5', lineNumber, columnBase + i,
          'raw control character in single-quoted key');
      }
      i++;
    }
    if (content[i] !== "'") {
      throw new YamlParseError('6.5', lineNumber, columnBase,
        'unterminated single-quoted key');
    }
    const raw = content.slice(0, i + 1);
    const node = parseSingleQuoted(raw, lineNumber, columnBase);
    return { keyNode: node, consumed: i + 1 };
  }
}
