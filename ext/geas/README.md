# @gcu/geas

geas (pronounced *gesh*) — the GCU shell. POSIX-syntax baseline with typed-pipe extensions. Async-native, VFS-bound, terminal-frontend-agnostic, worker-runnable.

> Etymology: Irish *geas* (plural *geasa*) — a magical binding obligation that must be obeyed. A shell *commands* the system; the system is *bound* to perform.

Part of the [GCU](https://github.com/endarthur/auditable) stack.

## Status

**v0.0.2** — Lexer + parser + here-docs + headless adapter. No executor yet. The AST is reachable and round-tripable through fixtures, useful for tooling (syntax highlighting, completion, static analysis) even without execution.

What's here:

- **Lexer** — POSIX-shape tokenizer. Words preserve quoting and expansions verbatim (the executor will own expansion semantics). Token types: `WORD`, `OPERATOR`, `IO_NUMBER`, `NEWLINE`, `HEREDOC_BODY`, `EOF`. Comments, line continuations, quoting (single/double), `$var`, `${var}`, `$(cmd)`, `` `cmd` `` all handled. Here-doc bodies are captured at the next newline (queue order for stacked `<<A <<B` heredocs); `<<-` strips leading tabs; quoted delimiters mark bodies for no-expansion via a `quoted` flag.
- **Parser** — Recursive-descent over a simplified POSIX shell grammar. Simple commands (assignments + words + redirects), pipelines (`|`), and-or chains (`&&`/`||`), lists (`;`/`&`/newline), brace groups (`{ ... }`), subshells (`( ... )`), `if`/`elif`/`else`/`fi`, `for ... do ... done`, `while`/`until`, `case ... esac`, function definitions (`name() body`), trailing redirects on compound commands. Here-doc bodies attach to their owning `<<` / `<<-` Redirect nodes with `body` + `bodyQuoted` fields.
- **Headless terminal adapter** — pure in-memory implementation of the GeasTerminal interface. Used for tests, MCP scripting, and as the reference implementation for adapter authors. Methods: `write`, `writeBlock`, `onInput`, `size`, `onResize`, `clear`, `caps` (interface), plus `output`, `capturedBlocks`, `sendInput`, `setSize` (inspection / simulation).

What's deferred:

- Executor (interprets the AST against a context — VFS, env, stdin/stdout, etc.)
- Built-ins (cat, ls, echo, etc.) — will live in `@gcu/coreutils`, dispatched by geas
- Terminal adapters for `@gcu/term` and `xterm.js` (small wrappers around the same GeasTerminal interface the headless adapter implements)
- Worker harness (run geas in a worker; spawn sub-workers for heavy commands)
- Typed-pipe protocol (geas + adapter-aware built-ins for sadpan Tables, natra ndarrays)

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
