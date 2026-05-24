# geas

**The GCU shell.** Pronounced *gesh*. Real POSIX-shape command line, real pipes, real filesystem — all inside [Auditable Works](works.md).

```
$ ls /home
notebook.html  data.csv  README.md
$ cat data.csv | head -3
sample,grade,domain
DH001,0.45,oxide
DH002,0.61,oxide
$ pkg install npm:leaflet
fetching npm:leaflet... installed (43.2 KB → /lib/npm/leaflet)
$ ed README.md
1234
,p
hello world
q
```

Etymology: Irish *geas* (plural *geasa*) — a magical binding obligation that must be obeyed. A shell *commands* the system; the system is *bound* to perform.

## Why a shell?

Auditable notebooks are reactive; a notebook re-runs cells when inputs change. That's the right model for analysis. But many tasks aren't reactive — install a library, peek at a file, rename a folder, run a one-shot script. Those want a shell: command, response, done. geas fills that gap.

Inside Works, geas is a surface (**Tools → Terminal**). It has the full surface contract — A-Bus connection, workspace VFS access, the shell's settings — so what you do in geas immediately reflects everywhere else (file tree, open notebooks, docs surface). Conversely, what happens elsewhere shows up in geas (new files appear, settings updates apply).

## Opening a terminal

**Tools → Terminal** in Works opens a geas terminal in a new tab. A second invocation opens a second terminal — you can have many. Each is independent: its own working directory, its own command history. The workspace VFS is shared (everyone is looking at the same `/home`).

The terminal uses [@gcu/xterm](https://github.com/endarthur/auditable/tree/main/ext/xterm) for rendering and [@gcu/readline](https://github.com/endarthur/auditable/tree/main/ext/readline) for line editing — full history, autosuggest from history (fish-style), tab completion, kill ring, all the bash keystrokes.

## POSIX shape

Pipes, redirects, command substitution, conditionals, loops, functions — geas implements the POSIX shell language.

```bash
# pipes + filters
cat data.csv | grep oxide | wc -l

# redirects
ls /home > files.txt
cat files.txt 2>/dev/null

# command substitution
TODAY=$(date +%Y-%m-%d)
echo "today is $TODAY"

# conditionals
if [ -f /home/data.csv ]; then
  echo "found"
fi

# loops
for f in /home/*.html; do
  echo "notebook: $f"
done

# functions
backup() {
  cp "$1" "$1.bak"
}
backup /home/notebook.html
```

The parser is a recursive-descent over a simplified POSIX grammar — see [@gcu/geas](https://github.com/endarthur/auditable/tree/main/ext/geas) for the AST shape. Quoting (`'` literal, `"` interpolation), expansions (`$var`, `${var}`, `$(cmd)`, `` `cmd` ``), here-docs (`<<EOF`, `<<-` with tab-strip), pipelines (`|`, `2>&1`), and-or chains (`&&`, `||`) all behave the way you'd expect.

## Builtins

geas ships with a small core of essentials, with more arriving as `@gcu/coreutils` matures.

| Builtin | Use |
|---|---|
| `cd` | change working directory |
| `ls`, `ll` | list files |
| `cat`, `head`, `tail`, `wc` | file inspection |
| `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch` | filesystem ops |
| `grep`, `find` | search |
| `echo`, `printf` | output |
| `pwd` | current directory |
| `env`, `export` | environment |
| `which`, `type` | command lookup |
| `pkg` | workspace package manager (see below) |
| `ed` | the standard text editor (see [@gcu/ed](https://github.com/endarthur/auditable/tree/main/ext/ed)) |
| `set` | shell options |
| `history` | command history |
| `clear` | clear the terminal |
| `exit` | close the terminal |

Workspace VFS access is the default — `cat /home/data.csv` reads from the workspace; `cd /mnt/projects` enters a disk-folder mount; `ls /tmp` lists the volatile scratch space.

## `pkg` — workspace package manager

`pkg` is geas's package manager — install npm, JSR, GitHub, or `@gcu/` libraries into the workspace `/lib/`, with a lockfile, integrity hashes, and offline reload after export.

```bash
pkg install npm:leaflet          # npm package
pkg install jsr:@std/csv         # JSR
pkg install gh:user/repo         # GitHub
pkg install @gcu/yaml            # GCU registry
pkg install                      # restore from /lib/.gcu-lock.json
pkg list                         # show installed
pkg freeze                       # print the lockfile
pkg remove leaflet               # uninstall
```

Installed modules live at `/lib/<source>/<name>/`. Once installed, notebooks `load()` them by alias:

```js
const L = await load('npm:leaflet');
const map = L.map('#map').setView([0, 0], 2);
```

The lockfile (`/lib/.gcu-lock.json`) records the resolved URL, version, and SHA-256 SRI hash for every install. A workspace exported from Works carries `/lib/` inline (no fresh fetch on the recipient's machine), and `pkg install` with no args re-fetches everything in the lockfile against the integrity hashes if needed.

Spec: [auditable-pkg-spec.md](https://github.com/endarthur/auditable/tree/main/spec_inbox) (deferred from the public docs because the format is pre-1.0).

## `ed` — the standard text editor

`ed` is the POSIX line editor — single letter commands, line addresses, no screen. Useful when you want to make a quick edit from the terminal without firing up a text surface.

```bash
$ ed README.md
1234
1,$p
# README
This is a project.
s/project/example/
,p
# README
This is a example.
w
1228
q
```

See [@gcu/ed](https://github.com/endarthur/auditable/tree/main/ext/ed) for the full reference. Quick summary: `a` append, `i` insert, `c` change, `d` delete, `p` print, `s/old/new/` substitute, `g/pat/cmd` apply to matching lines, `w` write, `q` quit.

## Filesystem layout in the terminal

The terminal sees the workspace VFS — the same one [Auditable Works](works.md) describes:

```
/home/              your work (notebooks, data, projects)
/home/.gcu_history  shell command history
/tmp/               volatile scratch (shared across terminals + surfaces)
/usr/lib/           shell-bundled @gcu libraries (load()-able)
/lib/               pkg-installed modules
/mnt/<name>/        disk-folder mounts (FSAA — Chromium only)
/etc/               workspace settings
```

`cd ~` goes to `/home`. `cd /tmp` is the scratch area. Everything is `/`-rooted; there's no Windows / MacOS / Linux path divergence here.

## Typed pipes (experimental)

A geas extension over POSIX: commands can produce *typed* values (a sadpan Table, a natra ndarray, a JSON object) instead of raw bytes, and the pipe protocol preserves the structure across commands that opt in.

```bash
cat data.csv | from-csv | filter '.grade > 0.5' | plot --x sample --y grade
```

Inside that pipeline, `from-csv` parses CSV bytes into a typed Table; `filter` runs a predicate over Table rows; `plot` renders the Table directly. None of those calls have to serialize through stdin/stdout as text.

The typed-pipe protocol is opt-in per builtin — a builtin that doesn't know about it sees regular byte streams (`from-csv` would still produce CSV text). Documented in `@gcu/geas/builtins-typed`.

## Notebook `!` cells

Inside Works, a notebook cell that begins with `!` runs in a geas worker:

```js
!ls -la /home
!cat /home/data.csv | head -5
```

The shell sees the rest of the line, runs it, and the cell's output is whatever the command wrote to stdout / stderr. Combined with `pkg`, this means you can install dependencies from a notebook cell:

```js
!pkg install npm:plotly
```

The notebook then `load()`s the installed module like any other:

```js
const Plotly = await load('npm:plotly');
```

## Adapters

geas is terminal-frontend-agnostic. Three adapters ship:

- **xterm.js** — the default in Works, full ANSI + UTF-8 + mouse support.
- **@gcu/term** — a lighter DOM renderer.
- **headless** — in-memory adapter for tests and MCP scripting (no DOM at all).

The same `geas` core runs against all three; the adapter is a thin layer that talks to the renderer.

## Running geas standalone

Outside Works, geas runs anywhere that can call ES modules:

```js
import { createShell, createHeadlessAdapter } from '@gcu/geas';

const term = createHeadlessAdapter();
const shell = createShell({ adapter: term, vfs: myVfs });
await shell.exec('ls -l /home');
console.log(term.output);
```

The `vfs` parameter is any [@gcu/vfs](https://github.com/endarthur/auditable/tree/main/ext/vfs)-shape filesystem; `term` is any GeasTerminal-shape adapter. Useful for testing, MCP scripting, or embedding geas in non-Works contexts.

## What geas is NOT

- **Not bash.** POSIX is the shape, but extensions are deliberately scoped: no bash-specific arrays (`${arr[@]}`), no parameter-expansion arithmetic (`${var:offset:len}` is supported; `${var//pat/sub}` is partial). geas targets the well-portable POSIX subset, plus typed pipes.
- **Not zsh.** No globbing extensions, no autoload, no completion DSL. Tab completion is built-in and contextual but not user-programmable.
- **Not a job control shell (yet).** [@gcu/proc](https://github.com/endarthur/auditable/tree/main/ext/proc) gave geas a real process model — PID tracking, lifecycle, signals, channels — and it's what `worker()` / `workerPool()` ride on. But the shell's `&`-backgrounding currently parses and runs synchronously (v0); wiring `&` through to `pm.spawn` plus adding `fg` / `bg` / `jobs` builtins is the obvious next step, not done yet.
- **Not a system shell.** geas runs in the browser, against the workspace VFS. It doesn't escape to the operating system; `!` doesn't shell out; `mkfs` would be a category error.

## See also

- [@gcu/geas](https://github.com/endarthur/auditable/tree/main/ext/geas) — implementation, AST, parser, executor.
- [@gcu/readline](https://github.com/endarthur/auditable/tree/main/ext/readline) — the line editor.
- [@gcu/ed](https://github.com/endarthur/auditable/tree/main/ext/ed) — the line text editor.
- [Auditable Works](works.md) — the shell that hosts the terminal surface.
