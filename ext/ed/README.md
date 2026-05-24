# @gcu/ed

**The standard text editor.** A POSIX-ish line editor for browser terminals.

`ed` is a line-oriented editor: the buffer is a sequence of lines, you address them by number or pattern, and you operate on them with single-letter commands (`a` append, `c` change, `d` delete, `p` print, `s` substitute, `w` write, `q` quit). No screen, no cursor, no surprises. Useful inside [geas](https://www.npmjs.com/package/@gcu/geas) and anywhere else you have an interactive terminal but no display addressable beyond stdout.

> "When in doubt, use brute force." — Ken Thompson, who wrote the original.

Pre-1.0 — APIs may change on minor version bumps.

## Install

```sh
npm install @gcu/ed
```

## Quick start

From the shell:

```
$ ed greeting.txt
greeting.txt: No such file or directory
a
Hello, world.
Second line.
.
2
Second line.
s/Second/Greetings from the second/
2
Greetings from the second line.
w
46
q
```

From JavaScript:

```js
import { runEd } from '@gcu/ed';

const result = await runEd(['ed', 'greeting.txt'], {
  vfs: workspaceVfs,
  stdin: ttyAdapter,
  stdout: ttyAdapter,
  stderr: ttyAdapter,
});
// result.exitCode === 0 if the user `q`'d cleanly
```

The `ctx` parameter is the same `{ vfs, stdin, stdout, stderr }` shape that geas builtins receive — `runEd` is itself one of those builtins.

## Commands

| Cmd | What it does |
|---|---|
| `a` | Append text after the current line, end with `.` on its own line |
| `i` | Insert text before the current line |
| `c` | Change (replace) the addressed lines |
| `d` | Delete the addressed lines |
| `p` | Print the addressed lines |
| `n` | Print with line numbers |
| `l` | Print with control characters escaped |
| `=` | Print the line number of the address |
| `j` | Join the addressed lines into one |
| `m` | Move the addressed lines after the destination |
| `t` | Transfer (copy) the addressed lines after the destination |
| `s/re/replace/flags` | Substitute matches of `re` with `replace`; flags: `g` (global), `N` (Nth match), `p` (print result) |
| `g/re/cmd` | Apply `cmd` to every line matching `re` |
| `u` | Undo the last buffer-modifying command (single level — POSIX) |
| `w [file]` | Write the buffer to `file` (or the current filename) |
| `r [file]` | Read `file` into the buffer after the addressed line |
| `e [file]` | Edit a new file (discards unsaved changes) |
| `f [file]` | Show or set the current filename |
| `q` | Quit (warns if unsaved changes) |
| `Q` | Quit unconditionally |
| `H` | Toggle verbose errors (default: just `?`) |
| `P` | Toggle the command prompt (default: off — POSIX) |

## Addressing

| Address | Means |
|---|---|
| `1` | Line 1 |
| `$` | Last line |
| `.` | Current line |
| `,` | Lines 1 through `$` |
| `;` | Current line through `$` |
| `5,10` | Lines 5 through 10 |
| `/re/` | Next line matching `re` (search forward) |
| `?re?` | Previous line matching `re` (search backward) |
| `5+2` | Line 7 |
| `.-1` | Previous line |

## Files

```
ext/ed/
  src/
    api.js        — runEd(argv, ctx) entry point + main loop
    buffer.js     — line buffer, undo, dirty flag
    address.js    — address parser, range resolver
    commands.js   — one function per ed command letter
    regex.js      — POSIX BRE to JS regex (subset)
    main.js       — concat manifest
  build.js        — concatenates src/ into index.js
  index.js        — BUILD OUTPUT
```

## What's not supported

- Multi-line undo. POSIX ed is single-level; we match.
- `!cmd` shell escape — geas runs in a worker and doesn't shell out the way Unix ed does.
- `c` doesn't support marks (`'`) yet.
- Extended regex (`-E`) — only POSIX basic regex (`\(...\)`, `\?`, `\+` are escapes, not specials).

## Status

Pre-1.0. Ships in geas as a builtin (`/bin/ed`); usable as a standalone library too.

## License

MIT.
