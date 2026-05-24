// api.js — ed main loop. Exposed as runEd(argv, ctx); geas's pkg
// command pattern wraps this into a one-line builtin.

import { createBuffer } from './buffer.js';
import { parseAddress, resolveRange } from './address.js';
import {
  cmdAppend, cmdInsert, cmdChange, cmdDelete,
  cmdPrint, cmdNumber, cmdList, cmdEquals,
  cmdJoin, cmdUndo, cmdMove, cmdTransfer,
  cmdSubstitute, cmdGlobal,
  cmdWrite, cmdRead, cmdEdit, cmdFilename,
  cmdQuit, cmdForceQuit, cmdWriteQuit,
  cmdToggleH, cmdToggleP,
} from './commands.js';

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

export async function runEd(argv, ctx) {
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
