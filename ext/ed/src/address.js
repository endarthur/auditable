// address.js — parse and resolve ed addresses.
//
// Supported forms:
//   <n>           absolute line number
//   .             current line
//   $             last line
//   +n / -n       offset from current line
//   +<n> / -<n>   same with explicit number
//   /pat/         forward search from current line (wraps to top)
//   ?pat?         backward search from current line (wraps to bottom)
//   addr1,addr2   range
//   addr1;addr2   range, with side-effect of moving cur to addr1 first
//
// Returns: { range, rest } where `range` is { from, to, explicit } and
// `rest` is the remainder of the command line (the bare command + args).
// `explicit` reports whether an address was given so commands can pick
// sensible defaults.

import { edToJsRegex } from './regex.js';

function _resolveSingle(spec, buf) {
  if (spec.type === 'num')   return spec.value;
  if (spec.type === 'cur')   return buf.cur;
  if (spec.type === 'last')  return buf.lines.length;
  if (spec.type === 'offset') {
    return _resolveSingle(spec.from, buf) + spec.delta;
  }
  if (spec.type === 'search') {
    const re = edToJsRegex(spec.pattern, '');
    return _doSearch(buf, re, spec.forward);
  }
  throw new Error('bad address');
}

function _doSearch(buf, re, forward) {
  const N = buf.lines.length;
  if (N === 0) throw new Error('no match');
  const start = buf.cur;
  for (let i = 1; i <= N; i++) {
    const idx = forward
      ? ((start + i - 1) % N) + 1
      : ((start - i - 1 + N * 2) % N) + 1;
    if (re.test(buf.lines[idx - 1])) return idx;
  }
  throw new Error('no match');
}

// Parse the address portion of `line`. Returns { range, rest }.
// `range`: { from, to, explicit, semi } where semi=true if the `;`
// separator was used (caller updates buf.cur to from before resolving to).
export function parseAddress(line) {
  let i = 0;
  function skipWS() { while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++; }

  function parseOne() {
    skipWS();
    if (i >= line.length) return null;
    let base = null;
    const c = line[i];
    if (c === '.') { base = { type: 'cur' }; i++; }
    else if (c === '$') { base = { type: 'last' }; i++; }
    else if (c >= '0' && c <= '9') {
      let n = 0;
      while (i < line.length && line[i] >= '0' && line[i] <= '9') {
        n = n * 10 + (line.charCodeAt(i) - 48);
        i++;
      }
      base = { type: 'num', value: n };
    } else if (c === '/' || c === '?') {
      const close = c;
      const forward = c === '/';
      i++;
      let pat = '';
      while (i < line.length && line[i] !== close) {
        if (line[i] === '\\' && i + 1 < line.length) { pat += line[i] + line[i+1]; i += 2; }
        else { pat += line[i]; i++; }
      }
      if (i < line.length) i++;   // consume the closing delimiter
      base = { type: 'search', pattern: pat, forward };
    }
    // Offsets — repeatable: `.+3-1+2` works (each adds to running sum).
    let delta = 0;
    skipWS();
    while (i < line.length && (line[i] === '+' || line[i] === '-')) {
      const sign = line[i] === '+' ? 1 : -1;
      i++;
      let mag = 1;
      let hasNum = false;
      let n = 0;
      while (i < line.length && line[i] >= '0' && line[i] <= '9') {
        n = n * 10 + (line.charCodeAt(i) - 48);
        i++;
        hasNum = true;
      }
      if (hasNum) mag = n;
      delta += sign * mag;
      skipWS();
    }
    if (base === null && delta === 0) return null;
    if (base === null) base = { type: 'cur' };   // bare +/-N → relative to .
    if (delta !== 0) return { type: 'offset', from: base, delta };
    return base;
  }

  const a1 = parseOne();
  skipWS();
  let sep = null;
  let a2 = null;
  if (i < line.length && (line[i] === ',' || line[i] === ';')) {
    sep = line[i];
    i++;
    a2 = parseOne();
  }
  const rest = line.slice(i);
  return {
    range: { a1, a2, sep, explicit: a1 != null || sep != null },
    rest,
  };
}

// Resolve the parsed range against the buffer. Returns { from, to, semi }.
// Throws on out-of-range / no-match.
export function resolveRange(range, buf, defaults) {
  let from, to;
  const { a1, a2, sep } = range;

  if (sep === ',' || sep === ';') {
    // Shortcuts: `,` alone = 1,$  ; `;` alone = .,$
    const r1 = a1 != null
      ? _resolveSingle(a1, buf)
      : (sep === ',' ? 1 : buf.cur);
    // `;` semantics: set cur to r1 before resolving a2.
    if (sep === ';') buf.cur = r1;
    const r2 = a2 != null ? _resolveSingle(a2, buf) : buf.lines.length;
    from = r1; to = r2;
  } else if (a1) {
    const r = _resolveSingle(a1, buf);
    from = to = r;
  } else {
    // No address — use defaults.
    from = defaults.from;
    to = defaults.to;
  }

  // Validate. Lines are 1..N; 0 is allowed only for addr-before-line-1 in
  // a few commands (e.g. `0a` to insert at the top); callers handle that.
  const N = buf.lines.length;
  if (from < 0 || from > N) throw new Error('invalid address');
  if (to < from || to > N) throw new Error('invalid address');
  return { from, to };
}

// Convenience: resolve a single address (used by `m` `t` `r` for the
// destination argument).
export function resolveDest(line, buf) {
  const { range, rest } = parseAddress(line);
  if (!range.a1) throw new Error('missing destination');
  const dest = _resolveSingle(range.a1, buf);
  return { dest, rest };
}
