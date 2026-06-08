# @gcu/geas

geas (pronounced *gesh*) — the GCU shell. POSIX-syntax baseline with typed-pipe extensions. Async-native, VFS-bound, terminal-frontend-agnostic, worker-runnable.

> Etymology: Irish *geas* (plural *geasa*) — a magical binding obligation that must be obeyed. A shell *commands* the system; the system is *bound* to perform.

Part of the [GCU](https://github.com/gentropic/auditable) stack.

## Status

**v0.0.4** — Full POSIX-shape shell: lexer + parser + executor + 100+ builtins + three terminal adapters + worker harness + typed pipes + pkg + ed.

What's here:

- **Lexer** — POSIX-shape tokenizer. Words preserve quoting and expansions verbatim. Token types: `WORD`, `OPERATOR`, `IO_NUMBER`, `NEWLINE`, `HEREDOC_BODY`, `EOF`. Comments, line continuations, quoting (single/double), `$var`, `${var}`, `$(cmd)`, `` `cmd` `` all handled. Here-doc bodies are captured at the next newline; `<<-` strips leading tabs; quoted delimiters mark bodies for no-expansion.
- **Parser** — Recursive-descent over a simplified POSIX shell grammar. Simple commands (assignments + words + redirects), pipelines (`|`), and-or chains (`&&`/`||`), lists (`;`/`&`/newline), brace groups, subshells, `if`/`elif`/`else`/`fi`, `for`/`while`/`until`/`case`, function definitions, trailing redirects on compound commands.
- **Executor** — interprets the AST against a context (VFS, env, stdin/stdout/stderr). Implements: pipelines, redirections (`>`, `>>`, `<`, `2>&1`, `<<EOF`), command substitution, parameter expansion (`${var:-default}`, `${var:offset:length}`, `${var/pat/sub}`, `${#var}`), arithmetic (`$(())`), conditionals (`[ ]`, `[[ ]]`, `test`), all control-flow constructs, `set -e` / `set -o pipefail` / `set -u` / `set -x`, exit-code propagation, error-trap handling.
- **Builtins** — 100+ commands across coreutils-shape categories: filesystem (`cd`, `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `find`, `chmod`), text (`grep`, `sed`, `awk`-subset, `cut`, `head`, `tail`, `wc`, `sort`, `uniq`, `tr`), shell (`echo`, `printf`, `test`, `set`, `export`, `unset`, `local`, `readonly`, `which`, `type`, `history`), pkg (workspace package manager), ed (POSIX line editor).
- **Three terminal adapters** — `createHeadlessAdapter()` (in-memory, for tests + MCP), `createTermAdapter()` (for [@gcu/term](https://github.com/gentropic/auditable/tree/main/ext/term)), `createXtermAdapter()` (for xterm.js — the Works default).
- **Worker harness** — `setupGeasWorker()` + `createGeasClient()` for running geas inside a Web Worker with main-thread proxying. VFS proxy via `serveVFS()` / `createVfsClient()` so the worker sees the same workspace VFS the main thread does.
- **Typed pipes** — opt-in extension over POSIX: builtins can produce *typed* values (sadpan Table, natra ndarray, JSON object) and pipes preserve the structure across the next builtin if it also opts in. Untyped builtins see raw bytes.

What's deferred:

- **Job control.** `&` parses but runs synchronously (v0); needs to route through `ctx.pm.spawn` to actually background. `fg` / `bg` / `jobs` / `wait` / `disown` builtins TBD. `SIGTSTP` (++ctrl+z++) → `SIGCONT` cycle TBD. [@gcu/proc](https://github.com/gentropic/auditable/tree/main/ext/proc) supplies the process model; the wiring is the work.
- **`top`** — process-table TTY builtin against `ctx.pm`. Refreshes a static table at a 2 s interval (`-d` configurable). Columns: PID, PPID, COMMAND, MODE (function / service / shell / daemon), STATUS, UPTIME, MSGS, IO-IN, IO-OUT. Header: active workers / `navigator.hardwareConcurrency`, JS heap (Chrome only via `performance.memory.usedJSHeapSize`), VFS quota usage per mount (`navigator.storage.estimate()` + per-mount walk), A-Bus calls/min if the broker is reachable. Skips CPU% (browsers don't expose per-worker CPU time; faking it would mislead). An `htop`-style Works surface (bars, kill-from-keypress, per-peer A-Bus subscription counts) is a follow-up, not in this scope.
- **`@gcu/coreutils` extraction.** Builtins live inside geas today. Promoting them to their own package would let other shells reuse them and would deduplicate the alias prefixes that pkg also carries.
- **`!` history expansion** (`!!`, `!$`, `!42`) — bash/zsh shape; not in POSIX. Low priority.
- **Bash-specific arrays** (`${arr[@]}`, `${arr[*]}`) — deliberately not implemented; geas targets the portable POSIX subset.
- **Subshell process isolation.** `( cmd )` runs in the same JS context with the env restored after; a true subshell would `pm.spawn` a fresh worker. Cosmetic difference until someone writes `( exec 1>>log )` in production.

## Usage

```js
import { tokenize, parse } from '@gcu/geas';

const tokens = tokenize('ls -l /home | grep arthur');
// → [{type:'WORD', value:'ls', pos:{…}}, {type:'WORD', value:'-l', …},
//    {type:'WORD', value:'/home', …}, {type:'OPERATOR', value:'|', …},
//    {type:'WORD', value:'grep', …}, {type:'WORD', value:'arthur', …},
//    {type:'EOF', …}]

const ast = parse('if test -f foo; then cat foo; fi');
// → { type:'Program', commands:[ { type:'IfClause', cond:…, then:…, … } ] }
```

The parser also accepts a pre-tokenized array, so you can introspect tokens
before parsing:

```js
const tokens = tokenize(source);
// ...do something with tokens...
const ast = parse(tokens);
```

## Design

See `project_geas_shell.md` in the project's private memory for the full design rationale. Public summary:

- **POSIX-syntax baseline** so muscle memory transfers
- **Typed pipes opt-in** as the killer feature (carries sadpan Tables / natra ndarrays end-to-end when both ends are GCU-aware; falls back to text otherwise)
- **VFS-native**: all paths through `@gcu/vfs`
- **Async-native**: every command is async; pipes await
- **Sandboxable**: every shell instance has a principal; VFS permissions enforced
- **Worker-runnable**: geas itself runs in a worker (UI never blocks); spawns sub-workers for heavy commands

## License

MIT.
