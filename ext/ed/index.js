// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/ed/src/  Build: node ext/ed/build.js
// @gcu/ed — POSIX-style line editor with GNU-ish sanded edges.
// "ed is the standard text editor."

// -- buffer.js --

// buffer.js — the in-memory document model for ed.
//
// `lines` is a 0-indexed array of strings (no trailing newlines). The
// classic ed `current line` cursor is 1-indexed; 0 means "buffer is
// empty." `dirty` flips on any mutation; `undo` snapshots state before
// every buffer-changing command so `u` rolls back exactly one step
// (POSIX one-level undo).

function createBuffer() {
  return {
    lines: [],
    cur: 0,
    filename: null,
    dirty: false,
    lastSearch: null,
    lastSubstitute: null,   // { re: RegExp, repl: string, flags: string }
    lastError: '',
    prompt: '* ',
    showPrompt: true,       // GNU-ish default; --posix turns it off
    posix: false,
    verboseErrors: true,    // toggled by `H` in posix mode
    cutBuffer: [],          // for `d`/`c`'s implicit cut + `u` reach
    quitPending: false,     // first `q` with dirty buffer warns; second confirms
    // Single-level undo snapshot. Captured BEFORE each mutating command.
    undoSnap: null,
  };
}

// Snapshot current state for `u`. Called before any mutation.
function snapshot(buf) {
  buf.undoSnap = {
    lines: buf.lines.slice(),
    cur: buf.cur,
    dirty: buf.dirty,
    lastSearch: buf.lastSearch,
    lastSubstitute: buf.lastSubstitute,
  };
}

function undo(buf) {
  if (!buf.undoSnap) return false;
  const snap = buf.undoSnap;
  // Snapshot CURRENT state as the new undo so `u` is its own inverse.
  const inverse = {
    lines: buf.lines.slice(),
    cur: buf.cur,
    dirty: buf.dirty,
    lastSearch: buf.lastSearch,
    lastSubstitute: buf.lastSubstitute,
  };
  buf.lines = snap.lines;
  buf.cur = snap.cur;
  buf.dirty = snap.dirty;
  buf.lastSearch = snap.lastSearch;
  buf.lastSubstitute = snap.lastSubstitute;
  buf.undoSnap = inverse;
  return true;
}

// Insert `newLines` into `buf` AFTER `at` (1-indexed; 0 = before line 1).
// Updates cur to the last inserted line. Marks dirty.
function insertAfter(buf, at, newLines) {
  if (newLines.length === 0) return;
  buf.lines.splice(at, 0, ...newLines);
  buf.cur = at + newLines.length;
  buf.dirty = true;
}

// Delete inclusive range [from, to] (1-indexed). Updates cur to the
// line that was just after the deleted block (or last line if at end).
function deleteRange(buf, from, to) {
  const cut = buf.lines.splice(from - 1, to - from + 1);
  buf.cutBuffer = cut;
  buf.cur = Math.min(from, buf.lines.length);
  if (buf.cur < 1 && buf.lines.length > 0) buf.cur = 1;
  buf.dirty = true;
  return cut;
}

// Move inclusive range [from, to] to AFTER `dest` (1-indexed).
// Errors if dest falls inside the range.
function moveRange(buf, from, to, dest) {
  if (dest >= from - 1 && dest <= to) {
    throw new Error('invalid destination');
  }
  const cut = buf.lines.splice(from - 1, to - from + 1);
  // After the cut, line numbers from `from` onward have shifted down by
  // cut.length. Adjust dest accordingly.
  const adjustedDest = dest >= to ? dest - cut.length : dest;
  buf.lines.splice(adjustedDest, 0, ...cut);
  buf.cur = adjustedDest + cut.length;
  buf.dirty = true;
}

// Copy (transfer) inclusive range [from, to] to AFTER `dest` (1-indexed).
function transferRange(buf, from, to, dest) {
  const copy = buf.lines.slice(from - 1, to);
  buf.lines.splice(dest, 0, ...copy);
  buf.cur = dest + copy.length;
  buf.dirty = true;
}

// Replace one line. Used by `s` per-line and `c` after insert.
function replaceLine(buf, n, text) {
  buf.lines[n - 1] = text;
  buf.cur = n;
  buf.dirty = true;
}

// -- regex.js --

// regex.js — translate ed-flavoured patterns to JS RegExp.
//
// Ed defaults to BRE (Basic Regular Expressions). The differences from
// JS regex that matter in practice:
//
//   - `\(` `\)`        — groups (parentheses are literal in BRE)
//   - `\|`             — alternation (pipe is literal in BRE)
//   - `\{m,n\}`        — counted repetition
//   - `\<` `\>`        — word boundaries (JS uses `\b` for both)
//   - `+` `?`          — literal characters in BRE (JS treats as operators)
//   - `\+` `\?`        — repetition operators in some BRE flavours
//   - `.` `^` `$` `*`  — same as JS
//   - `[abc]` `[^abc]` — same as JS
//   - `\n` in replace  — backreference (not newline)
//
// We translate the ed-style escapes into JS regex source. Anyone targeting
// strict POSIX BRE will hit edge cases; we ship the convenient subset that
// covers what's actually typed at an ed prompt.

function edToJsRegex(edPattern, flags) {
  let out = '';
  let i = 0;
  while (i < edPattern.length) {
    const c = edPattern[i];
    if (c === '\\') {
      const next = edPattern[i + 1];
      switch (next) {
        case '(': out += '(';  i += 2; continue;
        case ')': out += ')';  i += 2; continue;
        case '|': out += '|';  i += 2; continue;
        case '{': out += '{';  i += 2; continue;
        case '}': out += '}';  i += 2; continue;
        case '<': out += '\\b'; i += 2; continue;
        case '>': out += '\\b'; i += 2; continue;
        case '+': out += '+';  i += 2; continue;
        case '?': out += '?';  i += 2; continue;
        case '.': out += '\\.'; i += 2; continue;
        case '*': out += '\\*'; i += 2; continue;
        case '[': out += '\\['; i += 2; continue;
        case ']': out += '\\]'; i += 2; continue;
        case '^': out += '\\^'; i += 2; continue;
        case '$': out += '\\$'; i += 2; continue;
        case '/': out += '/';   i += 2; continue;
        default:
          // \n, \t, \\, \d etc. — pass through verbatim.
          out += '\\' + (next != null ? next : '');
          i += next != null ? 2 : 1;
          continue;
      }
    }
    if (c === '(' || c === ')' || c === '|' || c === '{' || c === '}'
        || c === '+' || c === '?') {
      // Literal in BRE → escape for JS.
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return new RegExp(out, flags);
}

// Apply an ed substitution: `repl` may contain `&` (whole match) and
// `\1` .. `\9` (backreferences). We rewrite to JS replacement syntax
// (`$&`, `$1`..) then call String.prototype.replace.
function _edReplToJs(repl) {
  let out = '';
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c === '\\') {
      const next = repl[i + 1];
      if (next >= '0' && next <= '9') {
        out += '$' + next;
        i += 2;
        continue;
      }
      if (next === '&') { out += '&'; i += 2; continue; }
      if (next === '\\') { out += '\\\\'; i += 2; continue; }
      // Other escapes pass through (\n → newline etc.)
      out += '\\' + (next != null ? next : '');
      i += next != null ? 2 : 1;
      continue;
    }
    if (c === '&')  { out += '$&';   i++; continue; }
    if (c === '$')  { out += '$$';   i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function applySubstitute(line, re, repl, global) {
  const jsRepl = _edReplToJs(repl);
  if (global) {
    const gre = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return line.replace(gre, jsRepl);
  }
  return line.replace(re, jsRepl);
}

// -- address.js --

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
function parseAddress(line) {
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
function resolveRange(range, buf, defaults) {
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
function resolveDest(line, buf) {
  const { range, rest } = parseAddress(line);
  if (!range.a1) throw new Error('missing destination');
  const dest = _resolveSingle(range.a1, buf);
  return { dest, rest };
}

// -- commands.js --

// commands.js — ed command implementations.
//
// Each command receives (state, range, rest, ctx) where:
//   state — the buffer state from createBuffer()
//   range — { from, to } already resolved + defaulted
//   rest  — remainder of command line (args after the command char)
//   ctx   — geas builtin context: stdout, stderr, vfs, readLine
//
// Return value: 'quit' to end the main loop, undefined otherwise.
// Throws on user errors (caught by the main loop and printed).


// Read lines from the user until a line is exactly ".". Returns the
// collected lines. EOF (ctx.readLine resolves with eof:true) ends input
// the same as `.`.
async function _readInputLines(ctx) {
  const lines = [];
  for (;;) {
    let r;
    try { r = await ctx.readLine({ prompt: '' }); }
    catch (e) { break; }
    if (!r || r.eof) break;
    if (r.line === '.') break;
    lines.push(r.line);
  }
  return lines;
}

// `a` — append after the given address (default `.`). Then enter input mode.
async function cmdAppend(state, range, rest, ctx) {
  const at = range.to;   // even when from!=to, append uses the upper bound
  const lines = await _readInputLines(ctx);
  if (lines.length === 0) return;
  snapshot(state);
  insertAfter(state, at, lines);
}

// `i` — insert before the given address (default `.`). Equivalent to
// `a` at `addr - 1`, except `0i` and `1i` both insert at the very top.
async function cmdInsert(state, range, rest, ctx) {
  const at = Math.max(0, range.from - 1);
  const lines = await _readInputLines(ctx);
  if (lines.length === 0) return;
  snapshot(state);
  insertAfter(state, at, lines);
}

// `c` — change. Delete the range, then enter input mode to replace.
async function cmdChange(state, range, rest, ctx) {
  const lines = await _readInputLines(ctx);
  snapshot(state);
  if (range.from > 0) deleteRange(state, range.from, range.to);
  insertAfter(state, range.from - 1, lines);
}

// `d` — delete the range. Cur moves to the line after; cut goes to cut buffer.
function cmdDelete(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  snapshot(state);
  deleteRange(state, range.from, range.to);
}

// `p` — print the range. Cur lands on the last printed line.
async function cmdPrint(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    await ctx.stdout(state.lines[i - 1] + '\n');
  }
  state.cur = range.to;
}

// `n` — print with line numbers.
async function cmdNumber(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    await ctx.stdout(`${i}\t${state.lines[i - 1]}\n`);
  }
  state.cur = range.to;
}

// `l` — list with visible non-printing chars.
async function cmdList(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    const v = state.lines[i - 1]
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f\x7f]/g, (c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'));
    await ctx.stdout(v + '$\n');
  }
  state.cur = range.to;
}

// `=` — print line number of address (default $).
async function cmdEquals(state, range, rest, ctx) {
  await ctx.stdout(`${range.to}\n`);
}

// `j` — join range (default `.,.+1`) into one line, no separator.
function cmdJoin(state, range, rest, ctx) {
  if (range.from === range.to) return;   // no-op, matches POSIX
  snapshot(state);
  const joined = state.lines.slice(range.from - 1, range.to).join('');
  state.lines.splice(range.from - 1, range.to - range.from + 1, joined);
  state.cur = range.from;
  state.dirty = true;
}

// `u` — undo.
function cmdUndo(state, range, rest, ctx) {
  if (!undo(state)) throw new Error('nothing to undo');
}

// `m addr` — move range to AFTER addr.
function cmdMove(state, range, rest, ctx) {
  const { dest } = resolveDest(rest, state);
  snapshot(state);
  moveRange(state, range.from, range.to, dest);
}

// `t addr` — transfer (copy) range to AFTER addr.
function cmdTransfer(state, range, rest, ctx) {
  const { dest } = resolveDest(rest, state);
  snapshot(state);
  transferRange(state, range.from, range.to, dest);
}

// `s/pat/repl/[flags]` — substitute. Flags: `g` (all matches), number
// (Nth match — not implemented v1), `p` (print after), `i` (case-fold —
// GNU extension).
async function cmdSubstitute(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  const m = _parseSubstitute(rest, state);
  if (!m) throw new Error('bad substitute');
  const re = edToJsRegex(m.pattern, m.iflag ? 'i' : '');
  let matched = 0;
  snapshot(state);
  for (let i = range.from; i <= range.to; i++) {
    const before = state.lines[i - 1];
    const after = applySubstitute(before, re, m.repl, m.gflag);
    if (after !== before) {
      replaceLine(state, i, after);
      matched++;
      if (m.pflag) await ctx.stdout(after + '\n');
    }
  }
  if (matched === 0) throw new Error('no match');
  state.lastSubstitute = m;
}

function _parseSubstitute(rest, state) {
  // s<delim>pat<delim>repl<delim>flags
  // Delimiter is the first character after `s`. `/` is conventional.
  rest = rest.trimStart();
  if (rest.length === 0) {
    // `s` with no args — re-run last s on the current line.
    if (!state.lastSubstitute) return null;
    return state.lastSubstitute;
  }
  const delim = rest[0];
  if (delim === ' ' || delim === '\t' || delim === '\n') return null;
  let i = 1;
  function readField() {
    let out = '';
    while (i < rest.length && rest[i] !== delim) {
      if (rest[i] === '\\' && i + 1 < rest.length) {
        out += rest[i] + rest[i + 1];
        i += 2;
      } else {
        out += rest[i];
        i++;
      }
    }
    if (i < rest.length) i++;   // consume delim
    return out;
  }
  const pattern = readField();
  const repl = readField();
  const flagStr = rest.slice(i).trim();
  return {
    pattern, repl,
    gflag: flagStr.includes('g'),
    pflag: flagStr.includes('p'),
    iflag: flagStr.includes('i'),
  };
}

// `g/pat/cmd` — global: run cmd on every matching line in range.
// `v/pat/cmd` — inverse: run cmd on every NON-matching line. (Skip v in v1.)
//
// Implementation: mark all matching lines first, then run cmd on each
// (resolving line numbers as the buffer shrinks/grows).
async function cmdGlobal(state, range, rest, ctx, runCommand) {
  // rest looks like `/pat/cmd`
  rest = rest.trimStart();
  if (rest.length === 0) throw new Error('bad global');
  const delim = rest[0];
  let i = 1;
  let pat = '';
  while (i < rest.length && rest[i] !== delim) {
    if (rest[i] === '\\' && i + 1 < rest.length) { pat += rest[i] + rest[i+1]; i += 2; }
    else { pat += rest[i]; i++; }
  }
  if (i < rest.length) i++;
  const cmd = rest.slice(i).trim() || 'p';
  const re = edToJsRegex(pat, '');
  // Mark matches by line content (an immutable signature, so we don't
  // confuse index after edits). Walk a copy of the lines.
  const targets = [];
  for (let n = range.from; n <= range.to; n++) {
    if (re.test(state.lines[n - 1])) targets.push(state.lines[n - 1]);
  }
  snapshot(state);
  for (const sig of targets) {
    // Find the (probably-moved) line index by content. Naive but
    // matches what ed does — global iterates over each matched line
    // once.
    const idx = state.lines.indexOf(sig) + 1;
    if (idx <= 0) continue;
    state.cur = idx;
    await runCommand(`${idx}${cmd}`);
  }
}

// `w [file]` — write buffer to file. With `>>file`, append.
async function cmdWrite(state, range, rest, ctx, append) {
  rest = rest.trim();
  let target = state.filename;
  if (rest.length > 0) {
    if (rest.startsWith('>>')) { append = true; rest = rest.slice(2).trim(); }
    if (rest.length > 0) target = rest;
  }
  if (!target) throw new Error('no current filename');
  const block = state.lines.slice(range.from - 1, range.to).join('\n')
    + (state.lines.length > 0 ? '\n' : '');
  if (append) {
    let prev = '';
    try { prev = await ctx.vfs.readFile(target, 'utf8'); } catch { /* */ }
    await ctx.vfs.writeFile(target, prev + block);
  } else {
    await ctx.vfs.writeFile(target, block);
  }
  if (!state.filename) state.filename = target;
  state.dirty = false;
  await ctx.stdout(`${block.length}\n`);
}

// `r [file]` — read file AFTER the given address (default $).
async function cmdRead(state, range, rest, ctx) {
  const target = rest.trim() || state.filename;
  if (!target) throw new Error('no current filename');
  let content;
  try { content = await ctx.vfs.readFile(target, 'utf8'); }
  catch { throw new Error(`cannot open ${target}`); }
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  snapshot(state);
  insertAfter(state, range.to, lines);
  await ctx.stdout(`${content.length}\n`);
}

// `e [file]` — discard buffer, edit new file.
async function cmdEdit(state, range, rest, ctx) {
  if (state.dirty && !state.quitPending) {
    state.quitPending = true;
    throw new Error('warning: buffer modified');
  }
  state.quitPending = false;
  const target = rest.trim() || state.filename;
  if (!target) throw new Error('no current filename');
  let content;
  try { content = await ctx.vfs.readFile(target, 'utf8'); }
  catch { throw new Error(`cannot open ${target}`); }
  snapshot(state);
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  state.lines = lines;
  state.filename = target;
  state.cur = lines.length;
  state.dirty = false;
  await ctx.stdout(`${content.length}\n`);
}

// `f [file]` — get or set current filename.
async function cmdFilename(state, range, rest, ctx) {
  rest = rest.trim();
  if (rest.length > 0) state.filename = rest;
  if (state.filename) await ctx.stdout(state.filename + '\n');
}

// `q` — quit. First call with dirty buffer warns; second confirms.
async function cmdQuit(state, range, rest, ctx) {
  if (state.dirty && !state.quitPending) {
    state.quitPending = true;
    throw new Error('warning: buffer modified');
  }
  return 'quit';
}

// `Q` — force quit. No warning.
function cmdForceQuit(state, range, rest, ctx) {
  return 'quit';
}

// `wq [file]` — write + quit (GNU shortcut).
async function cmdWriteQuit(state, range, rest, ctx) {
  await cmdWrite(state, range, rest, ctx, false);
  return 'quit';
}

// `H` — toggle verbose-error mode (POSIX default off; we default on).
function cmdToggleH(state, range, rest, ctx) {
  state.verboseErrors = !state.verboseErrors;
}

// `P` — toggle prompt visibility.
function cmdToggleP(state, range, rest, ctx) {
  state.showPrompt = !state.showPrompt;
}

// -- api.js --

// api.js — ed main loop. Exposed as runEd(argv, ctx); geas's pkg
// command pattern wraps this into a one-line builtin.




// Per-command default range when the user gave no address.
const DEFAULTS_CURRENT_LINE = (buf) => ({ from: buf.cur, to: buf.cur });
const DEFAULTS_WHOLE_BUFFER = (buf) => ({ from: 1, to: buf.lines.length });
const DEFAULTS_LAST_LINE    = (buf) => ({ from: buf.lines.length, to: buf.lines.length });
const DEFAULTS_JOIN         = (buf) => ({ from: buf.cur, to: Math.min(buf.cur + 1, buf.lines.length) });

const COMMANDS = {
  a: { fn: cmdAppend,     defaults: DEFAULTS_CURRENT_LINE },
  i: { fn: cmdInsert,     defaults: DEFAULTS_CURRENT_LINE },
  c: { fn: cmdChange,     defaults: DEFAULTS_CURRENT_LINE },
  d: { fn: cmdDelete,     defaults: DEFAULTS_CURRENT_LINE },
  p: { fn: cmdPrint,      defaults: DEFAULTS_CURRENT_LINE },
  n: { fn: cmdNumber,     defaults: DEFAULTS_CURRENT_LINE },
  l: { fn: cmdList,       defaults: DEFAULTS_CURRENT_LINE },
  '=': { fn: cmdEquals,   defaults: DEFAULTS_LAST_LINE },
  j: { fn: cmdJoin,       defaults: DEFAULTS_JOIN },
  u: { fn: cmdUndo,       defaults: DEFAULTS_CURRENT_LINE },
  m: { fn: cmdMove,       defaults: DEFAULTS_CURRENT_LINE },
  t: { fn: cmdTransfer,   defaults: DEFAULTS_CURRENT_LINE },
  s: { fn: cmdSubstitute, defaults: DEFAULTS_CURRENT_LINE },
  g: { fn: cmdGlobal,     defaults: DEFAULTS_WHOLE_BUFFER },
  w: { fn: cmdWrite,      defaults: DEFAULTS_WHOLE_BUFFER },
  r: { fn: cmdRead,       defaults: DEFAULTS_LAST_LINE },
  e: { fn: cmdEdit,       defaults: DEFAULTS_CURRENT_LINE },
  f: { fn: cmdFilename,   defaults: DEFAULTS_CURRENT_LINE },
  q: { fn: cmdQuit,       defaults: DEFAULTS_CURRENT_LINE },
  Q: { fn: cmdForceQuit,  defaults: DEFAULTS_CURRENT_LINE },
  H: { fn: cmdToggleH,    defaults: DEFAULTS_CURRENT_LINE },
  P: { fn: cmdToggleP,    defaults: DEFAULTS_CURRENT_LINE },
};

function _parseArgs(argv) {
  // argv[0] = 'ed', argv[1..] = options + filename.
  const opts = { posix: false, script: false, prompt: null, filename: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--posix') opts.posix = true;
    else if (a === '--script' || a === '-s' || a === '-q') opts.script = true;
    else if (a.startsWith('--prompt=')) opts.prompt = a.slice('--prompt='.length);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { /* unknown — silently ignore in v1 */ }
    else opts.filename = a;
  }
  return opts;
}

const HELP = `usage: ed [--posix] [--script] [--prompt=STR] [FILE]

A line-oriented text editor in the POSIX ed tradition with GNU-ish
defaults (visible prompt, verbose errors, wq shortcut).

commands:
  a/i/c   append / insert / change (enter input mode; '.' alone to end)
  d       delete
  p/n/l   print / number / list with control-char escapes
  =       print line number of address (default $)
  j       join consecutive lines
  m/t     move / transfer lines to AFTER address
  u       undo (one level)
  s/p/r/g substitute   s/old/new/[gpi]
  g/p/c   global       g/pattern/command
  e/f/r/w edit / filename / read-into / write
  wq      write and quit
  q/Q     quit / force quit
  H/P     toggle verbose errors / prompt

addresses:
  N       line N        .  current
  $       last line     +N -N   relative
  /pat/   forward       ?pat?   backward
  a1,a2   range         ,   1,$    ;   .,$
`;

async function runEd(argv, ctx) {
  const opts = _parseArgs(argv);
  if (opts.help) {
    await ctx.stdout(HELP);
    return 0;
  }

  const buf = createBuffer();
  if (opts.posix) {
    buf.posix = true;
    buf.showPrompt = false;
    buf.verboseErrors = false;
  }
  if (opts.prompt != null) {
    buf.prompt = opts.prompt;
    buf.showPrompt = true;
  }

  if (opts.filename) {
    buf.filename = opts.filename;
    try {
      const content = await ctx.vfs.readFile(opts.filename, 'utf8');
      const lines = content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      buf.lines = lines;
      buf.cur = lines.length;
      await ctx.stdout(`${content.length}\n`);
    } catch {
      // ed convention: report no-file as a single `?` (or verbose).
      if (buf.verboseErrors) await ctx.stderr(`${opts.filename}: cannot open\n`);
      else await ctx.stderr('?\n');
    }
  }

  // The dispatcher. Recursive callable for `g/pat/cmd`.
  async function runCommand(line) {
    if (line === '') {
      // Empty line — move to next line and print it.
      if (buf.cur < buf.lines.length) buf.cur++;
      if (buf.cur >= 1) await ctx.stdout(buf.lines[buf.cur - 1] + '\n');
      return;
    }
    const { range: rangeSpec, rest } = parseAddress(line);
    // The command char.
    let cmdChar, args;
    if (rest.length === 0) {
      // Address-only line: jump to that line and print it.
      if (!rangeSpec.explicit) return;
      const r = resolveRange(rangeSpec, buf, DEFAULTS_CURRENT_LINE(buf));
      buf.cur = r.to;
      if (buf.cur >= 1) await ctx.stdout(buf.lines[buf.cur - 1] + '\n');
      return;
    }
    cmdChar = rest[0];
    args = rest.slice(1);
    // `wq` two-char shortcut.
    if (cmdChar === 'w' && args[0] === 'q') {
      const r = resolveRange(rangeSpec, buf, DEFAULTS_WHOLE_BUFFER(buf));
      const result = await cmdWriteQuit(buf, r, args.slice(1), ctx);
      return result;
    }
    const spec = COMMANDS[cmdChar];
    if (!spec) throw new Error(`unknown command: ${cmdChar}`);
    const r = resolveRange(rangeSpec, buf, spec.defaults(buf));
    // `g` needs the dispatcher for recursive execution.
    if (cmdChar === 'g') {
      return await cmdGlobal(buf, r, args, ctx, runCommand);
    }
    // `w` extra: `>>` append handling.
    if (cmdChar === 'w') {
      return await cmdWrite(buf, r, args, ctx, false);
    }
    return await spec.fn(buf, r, args, ctx);
  }

  // Main REPL.
  for (;;) {
    let cmdLine;
    try {
      const promptStr = buf.showPrompt ? buf.prompt : '';
      const r = await ctx.readLine({ prompt: promptStr });
      if (!r || r.eof) break;
      cmdLine = r.line != null ? r.line : '';
    } catch (e) {
      await ctx.stderr(`ed: ${e.message || e}\n`);
      break;
    }
    let result;
    try { result = await runCommand(cmdLine); }
    catch (e) {
      buf.lastError = e.message;
      if (buf.verboseErrors) await ctx.stderr(`? ${e.message}\n`);
      else await ctx.stderr('?\n');
      // Don't clear quitPending here — it's set BY the warning thrower
      // and consumed by the next q/e to confirm.
      continue;
    }
    // A successful command clears the quit-pending flag.
    buf.quitPending = false;
    if (result === 'quit') break;
  }

  return 0;
}

export { runEd };
