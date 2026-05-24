# ed

**The standard text editor — POSIX line editor semantics, GNU-ish defaults, run in a web worker.**

A line-oriented text editor in the [POSIX ed](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/ed.html) tradition. The buffer is a sequence of lines, addressed by number or pattern; commands are single letters that mutate the buffer or print parts of it. No screen, no cursor beyond the "current line," no surprises.

| Field      | Value                                          |
|------------|------------------------------------------------|
| Version    | 0.1                                            |
| Status     | Pre-1.0; shipped 2026-05                       |
| License    | MIT                                            |
| Owner      | endarthur                                      |
| Lineage    | POSIX.1-2017 ed; GNU ed extensions             |

---

## Lineage

ed is the [original Unix text editor](https://www.bell-labs.com/usr/dmr/www/qed.html), descended from Ken Thompson's qed at Berkeley (1969) and refined into the program that shipped with Unix V1 in 1971. It's the editor every Unix-like system ships in `/bin` because every Unix-like system, including the most stripped-down recovery environment, can run it.

This implementation tracks POSIX.1-2017 ed semantics closely, with a few GNU-ed-style conveniences turned on by default (visible prompt, verbose errors, `wq` shortcut). `--posix` flips those off for strict compatibility.

> "When in doubt, use brute force." — Ken Thompson, who wrote the original.

## Premise

Three commitments drive the design:

1. **POSIX semantics on every command.** Addressing, command effects, the implicit current-line cursor, the `?` error mode, single-level undo — all match what POSIX prescribes. A muscle-memory ed user gets exactly what they expect.
2. **GNU-ed defaults on first launch.** A bare `ed file.txt` invocation shows a prompt (`*`), prints verbose errors, and accepts the `wq` shortcut. New users don't get punished for not knowing they need to toggle `P` first. `--posix` opts out into strict compatibility.
3. **Worker-friendly I/O.** ed runs inside [@gcu/geas](https://www.npmjs.com/package/@gcu/geas), which lives in a web worker. All I/O goes through an injected `ctx` object — `vfs`, `stdin`, `stdout`, `stderr`, `readLine` — so ed has no platform assumptions and no global state. The same code runs in Node tests with a string-array adapter.

## Buffer model

A **buffer** is a sequence of lines plus a small set of cursor-like fields. The structure is documented as JS, but the model is platform-neutral:

```js
{
  lines:         string[],          // 0-indexed; no trailing newlines
  cur:           number,            // 1-indexed; 0 = empty buffer
  filename:      string | null,
  dirty:         boolean,           // set on any mutation
  lastSearch:    RegExp | null,     // for repeating // ??
  lastSubstitute: { re, repl, flags } | null,
  lastError:     string,
  prompt:        string,            // default '*'
  showPrompt:    boolean,           // GNU default true; --posix false
  posix:         boolean,
  verboseErrors: boolean,           // GNU default true; --posix false
  cutBuffer:     string[],          // last d / c removed lines
  quitPending:   boolean,           // first q on dirty buffer warns
  undoSnap:      Snapshot | null,   // single-level undo
}
```

The **current line** (`cur`) is the cursor: 1 = first line, `lines.length` = last line, 0 = empty buffer. Every mutating command updates `cur` to a sensible new value (usually the last line touched).

The **cut buffer** holds the most recently deleted lines (`d`, `c`). It's separate from the kill ring most editors have — POSIX ed only remembers one cut.

The **undo snapshot** is single-level by POSIX rule: `u` undoes the last buffer-changing command, and a second `u` undoes the undo (so `u` is its own inverse). Captured *before* every mutation; cleared after non-mutating commands like `p`.

## Address language

Every command takes an optional address (or address range) before the command letter. Addresses identify specific lines or ranges; without one, each command has a per-command default (e.g. `p` defaults to the current line, `g` defaults to the whole buffer).

### Atoms

| Atom | Means |
|---|---|
| `N` (digit) | Absolute line number |
| `.` | Current line |
| `$` | Last line |
| `/regex/` | Forward search from current line (wraps at end of buffer) |
| `?regex?` | Backward search from current line (wraps at start) |

### Offsets

Any atom may be followed by `+N` or `-N` (or `+`/`-` alone for `±1`), repeatedly. The deltas sum:

```
.+3      — three lines after current
$-1      — penultimate line
/foo/+2  — two lines after the next match of /foo/
.+1-2+3  — net +2 from current
```

### Ranges

Two addresses separated by `,` form a range. `;` is the same but with a side-effect: the current line is moved to the first address before the second resolves. This matters when the second uses `/pat/`:

```
1,$       — whole buffer
.,+5      — current line through current+5
,         — shorthand for 1,$
;         — shorthand for .,$
1;/foo/   — line 1, search forward from THERE for /foo/
```

### Defaults

Each command has its own default address range, applied when the user gives none:

| Command | Default |
|---|---|
| `a`, `i`, `c`, `d`, `p`, `n`, `l`, `m`, `t`, `s`, `u` | current line |
| `g`, `w`, `e` | whole buffer (`1,$`) |
| `=`, `r` | last line (`$`) |
| `j` | current line and the next (`. , .+1`) |

## Commands

### Input commands

| Cmd | Effect |
|---|---|
| `a` | Open input mode AFTER the addressed line. User types lines; a single `.` on its own line ends input. `cur` ← last inserted line. |
| `i` | Like `a` but inserts BEFORE the addressed line. |
| `c` | Delete the addressed lines, then enter input mode at that position. |

`0a` inserts at the top of the buffer (the only address where `0` is valid).

### Print commands

| Cmd | Effect |
|---|---|
| `p` | Print the addressed lines verbatim. |
| `n` | Print with a `N\t` line-number prefix on each. |
| `l` | Print with control characters escaped (`\t`, `\\`, etc.) and a trailing `$` to show end-of-line. |
| `=` | Print the line number of the addressed line (just the number). |

A bare address line (`5` alone) acts like `5p`: jump to the line and print it.

### Modify commands

| Cmd | Effect |
|---|---|
| `d` | Delete the addressed lines. Saved to the cut buffer. `cur` ← line after the deleted block, or the new last line. |
| `j` | Join the addressed lines into one (no separator). |
| `m N` | Move the addressed lines to AFTER line N. Errors if N is inside the source range. |
| `t N` | Transfer (copy) the addressed lines to AFTER line N. |
| `u` | Undo the last mutating command. Single-level — POSIX. |

### Substitution

```
s/pattern/replacement/[flags]
```

Substitute the first match of `pattern` on each addressed line with `replacement`. Flags:

| Flag | Means |
|---|---|
| `g` | Replace all matches on each line (not just the first) |
| `p` | Print each modified line afterward |
| `<N>` (digit) | Replace the Nth match only |
| `i` | Case-insensitive (extension) |

`pattern` is empty → reuse the last regex (from `/pat/` or a previous `s`). The delimiter doesn't have to be `/` — `s,foo,bar,` works (any non-alphanumeric character).

Replacement special syntax:

- `&` — the whole match
- `\1` .. `\9` — backreferences to captures in `\( … \)`
- `\&` — literal `&`
- `\\` — literal `\`

### Global

```
g/pattern/command
v/pattern/command   (inverse — lines NOT matching)
```

Apply `command` to every addressed line matching `pattern` (or, for `v`, not matching). `command` is any ed command, executed once per matching line. The current line is set to the match before `command` runs. Cumulative effect: a one-line scripted edit pass.

```
g/^[ \t]*$/d        — delete all blank lines
g/TODO/p            — print every line containing TODO
g/^/m$              — reverse the buffer (each line moves to end)
```

### File I/O

| Cmd | Effect |
|---|---|
| `w [file]` | Write the addressed lines to `file` (or the current filename). Prints byte count. `wq` writes and quits. |
| `W [file]` | Append (write with `>>` semantics). |
| `r [file]` | Read `file` and insert it AFTER the addressed line. Prints byte count. |
| `e [file]` | Edit a new file (discards current buffer; warns if dirty). |
| `E [file]` | Force-edit (skip dirty warning). |
| `f [file]` | Show the current filename, or set it. |

All file I/O goes through `ctx.vfs` — see [I/O contract](#i-o-contract) below.

### Quit

| Cmd | Effect |
|---|---|
| `q` | Quit. On a dirty buffer: first `q` prints `?` and sets `quitPending`; a second `q` (or `Q`) confirms. |
| `Q` | Force quit (unconditional). |
| `wq` | Write then quit, no warning. |

### Toggles

| Cmd | Effect |
|---|---|
| `H` | Toggle verbose errors (default on in GNU-style; off in POSIX). |
| `P` | Toggle prompt visibility (default on in GNU-style; off in POSIX). |

## Regex dialect

ed historically uses POSIX BRE (Basic Regular Expressions), where some characters that are operators in modern regex are literals — and where you escape characters to make them operators rather than to make them literal. This implementation translates ed-flavoured patterns to JS RegExp on the fly.

| ed (BRE) | Means |
|---|---|
| `.` | Any single character |
| `*` | Zero or more of the previous |
| `^` | Start of line (only at start of pattern) |
| `$` | End of line (only at end of pattern) |
| `[abc]`, `[^abc]` | Character class / negated class |
| `\(`, `\)` | Capturing group |
| `\|` | Alternation |
| `\{m,n\}` | Counted repetition |
| `\<`, `\>` | Word boundary (both map to JS `\b`) |
| `\+` | One or more (extension; native BRE has none) |
| `\?` | Zero or one (extension) |
| `+`, `?`, `(`, `)`, `\|`, `{`, `}` | Literal characters |
| `\d`, `\w`, `\s` | Pass through to JS regex (extensions, not strict POSIX) |

So `\(foo\)\+` matches "one or more 'foo'" (BRE), while `(foo)+` matches the literal string `(foo)+` (BRE treats `(`, `)`, `+` as literals).

The translator is in `ext/ed/src/regex.js`. It's about 100 lines and ships only what real-world ed users type at a prompt — strict POSIX BRE edge cases (`[[:alpha:]]` collation classes, locale-aware character ranges) aren't supported.

## I/O contract

`runEd(argv, ctx)` takes:

- `argv` — array of strings; `argv[0]` is `'ed'`, the rest are command-line flags + the filename.
- `ctx` — adapter object the editor uses for all platform I/O:

```ts
{
  vfs: {
    readFile(path, encoding) -> Promise<string>,
    writeFile(path, contents) -> Promise<void>,
  },
  stdin: (n?) -> Promise<string>,           // raw stdin reader (rarely used)
  stdout: (s) -> Promise<void>,
  stderr: (s) -> Promise<void>,
  readLine: ({ prompt }) -> Promise<{ line, eof }>,
}
```

This is the same shape every geas builtin receives. To embed ed in a different host, supply a `ctx` with adapters; no DOM, no Node-specific APIs.

### Command-line flags

| Flag | Effect |
|---|---|
| `--posix` | Strict POSIX mode: no prompt, terse errors, no `wq` shortcut. |
| `--script` / `-s` / `-q` | Suppress the byte count printed on `e` / `w`. For non-interactive use. |
| `--prompt=STR` | Custom prompt string (default `*`). |
| `--help` / `-h` | Print usage to stdout, exit 0. |

The exit code is 0 on clean quit, 1 if a file-open at startup failed.

## Error handling

ed has a famously minimal error mode: `?` on its own line, then continue. The user toggles verbose errors with `H` (which also prints the last error message). This implementation defaults to verbose (`H` is on at start); `--posix` flips it off.

Error messages are short:

```
? cannot open
? no match
? invalid address
? unsaved changes
? unknown command: x
```

The `quitPending` flag implements "first `q` on a dirty buffer prints `?` and arms; second confirms" — a tiny safety net for `q` typos.

## Architecture

```
ext/ed/src/
  api.js        — runEd(argv, ctx) entry + REPL + command dispatcher; ~190 LOC
  buffer.js     — line buffer, snapshot/undo, insert/delete/move/transfer; ~110 LOC
  address.js    — address parser and resolver; ~160 LOC
  commands.js   — one function per command letter; ~325 LOC
  regex.js      — ed-BRE → JS RegExp translator; ~100 LOC
  main.js       — re-exports
build.js        — concatenates src/ into index.js
index.js        — BUILD OUTPUT
```

Pure ESM; no DOM, no Node-specific APIs. The only globals touched are the `ctx` parameter the host passes in. `address.js` and `regex.js` are independently importable for tooling that wants to lex an ed-style address or translate a pattern.

## Testing

Tests live in `test/ed.test.mjs` (and the corresponding pass in geas's harness, since ed is also a geas builtin). Coverage:

- Address parser — atoms, offsets, ranges, the `;` side-effect
- Each command's effect on `lines` + `cur` + `dirty`
- Substitute — flags, backreferences, delimiter alternatives
- Global — recursive command dispatch, no-match handling
- Regex translator — BRE escapes, replacement syntax
- Undo — single-level, self-inverse
- Quit — dirty-buffer two-step

## Open questions

- **Marks.** POSIX ed supports named marks (`ka` marks the current line as `a`, `'a` references it). Not implemented yet; the `cur` field is the only persistent cursor.
- **Bracketed regex classes (`[[:alpha:]]`).** Not supported. Real-world ed scripts rarely use them.
- **`!cmd` shell escape.** ed traditionally lets you run a shell command on the current line. Inside geas (a worker), there's no fork(2); we'd need to round-trip through the geas process model. Possible but not yet implemented.
- **Multi-level undo.** POSIX is single-level. GNU ed kept it single-level too. Probably stays that way.
- **`vi` mode.** Some descendants of ed (ex, vi) added screen editing on top. Not on the roadmap; that's a different editor.

## What ed is NOT

- **A modern editor.** No syntax highlighting, no autocomplete, no LSP. ed is the line-oriented editor; if you want a modal screen editor, use vim. If you want a shell editor, use readline.
- **Posix-strict by default.** Defaults match GNU ed (prompt visible, verbose errors). `--posix` opts in to strict mode.
- **A scripting language.** `g/pat/cmd` chains are powerful but ed isn't sed — sed's stream-oriented one-pass model is a different thing.

## Versioning

Pre-1.0 means we may extend command syntax (new flags on `s`, additional address shortcuts) without warning. The buffer model and POSIX-equivalent commands are stable.
