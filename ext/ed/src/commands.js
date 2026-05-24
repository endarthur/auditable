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

import {
  snapshot, undo,
  insertAfter, deleteRange, moveRange, transferRange, replaceLine,
} from './buffer.js';
import { edToJsRegex, applySubstitute } from './regex.js';
import { resolveDest } from './address.js';

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
export async function cmdAppend(state, range, rest, ctx) {
  const at = range.to;   // even when from!=to, append uses the upper bound
  const lines = await _readInputLines(ctx);
  if (lines.length === 0) return;
  snapshot(state);
  insertAfter(state, at, lines);
}

// `i` — insert before the given address (default `.`). Equivalent to
// `a` at `addr - 1`, except `0i` and `1i` both insert at the very top.
export async function cmdInsert(state, range, rest, ctx) {
  const at = Math.max(0, range.from - 1);
  const lines = await _readInputLines(ctx);
  if (lines.length === 0) return;
  snapshot(state);
  insertAfter(state, at, lines);
}

// `c` — change. Delete the range, then enter input mode to replace.
export async function cmdChange(state, range, rest, ctx) {
  const lines = await _readInputLines(ctx);
  snapshot(state);
  if (range.from > 0) deleteRange(state, range.from, range.to);
  insertAfter(state, range.from - 1, lines);
}

// `d` — delete the range. Cur moves to the line after; cut goes to cut buffer.
export function cmdDelete(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  snapshot(state);
  deleteRange(state, range.from, range.to);
}

// `p` — print the range. Cur lands on the last printed line.
export async function cmdPrint(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    await ctx.stdout(state.lines[i - 1] + '\n');
  }
  state.cur = range.to;
}

// `n` — print with line numbers.
export async function cmdNumber(state, range, rest, ctx) {
  if (range.from < 1) throw new Error('invalid address');
  for (let i = range.from; i <= range.to; i++) {
    await ctx.stdout(`${i}\t${state.lines[i - 1]}\n`);
  }
  state.cur = range.to;
}

// `l` — list with visible non-printing chars.
export async function cmdList(state, range, rest, ctx) {
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
export async function cmdEquals(state, range, rest, ctx) {
  await ctx.stdout(`${range.to}\n`);
}

// `j` — join range (default `.,.+1`) into one line, no separator.
export function cmdJoin(state, range, rest, ctx) {
  if (range.from === range.to) return;   // no-op, matches POSIX
  snapshot(state);
  const joined = state.lines.slice(range.from - 1, range.to).join('');
  state.lines.splice(range.from - 1, range.to - range.from + 1, joined);
  state.cur = range.from;
  state.dirty = true;
}

// `u` — undo.
export function cmdUndo(state, range, rest, ctx) {
  if (!undo(state)) throw new Error('nothing to undo');
}

// `m addr` — move range to AFTER addr.
export function cmdMove(state, range, rest, ctx) {
  const { dest } = resolveDest(rest, state);
  snapshot(state);
  moveRange(state, range.from, range.to, dest);
}

// `t addr` — transfer (copy) range to AFTER addr.
export function cmdTransfer(state, range, rest, ctx) {
  const { dest } = resolveDest(rest, state);
  snapshot(state);
  transferRange(state, range.from, range.to, dest);
}

// `s/pat/repl/[flags]` — substitute. Flags: `g` (all matches), number
// (Nth match — not implemented v1), `p` (print after), `i` (case-fold —
// GNU extension).
export async function cmdSubstitute(state, range, rest, ctx) {
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
export async function cmdGlobal(state, range, rest, ctx, runCommand) {
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
export async function cmdWrite(state, range, rest, ctx, append) {
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
export async function cmdRead(state, range, rest, ctx) {
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
export async function cmdEdit(state, range, rest, ctx) {
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
export async function cmdFilename(state, range, rest, ctx) {
  rest = rest.trim();
  if (rest.length > 0) state.filename = rest;
  if (state.filename) await ctx.stdout(state.filename + '\n');
}

// `q` — quit. First call with dirty buffer warns; second confirms.
export async function cmdQuit(state, range, rest, ctx) {
  if (state.dirty && !state.quitPending) {
    state.quitPending = true;
    throw new Error('warning: buffer modified');
  }
  return 'quit';
}

// `Q` — force quit. No warning.
export function cmdForceQuit(state, range, rest, ctx) {
  return 'quit';
}

// `wq [file]` — write + quit (GNU shortcut).
export async function cmdWriteQuit(state, range, rest, ctx) {
  await cmdWrite(state, range, rest, ctx, false);
  return 'quit';
}

// `H` — toggle verbose-error mode (POSIX default off; we default on).
export function cmdToggleH(state, range, rest, ctx) {
  state.verboseErrors = !state.verboseErrors;
}

// `P` — toggle prompt visibility.
export function cmdToggleP(state, range, rest, ctx) {
  state.showPrompt = !state.showPrompt;
}
