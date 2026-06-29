// op (proto) — the op descriptor model, harvested into geas FIRST (op-over-geas: the
// substrate's first real consumer). Lives here until a 2nd consumer proves the shape →
// then extract @gcu/op. Design: spec_inbox/gcu-works-substrate-specs/op-effect-and-frontends-NOTE.md.
//
// Effect-class = orthogonal FACETS (the schema behaviour derives from) + named PRESETS (the
// one-word declared API). Nothing here persists yet, so the vocabulary stays revisable.

// ── the facet vocabulary (freeze-grade once a ledger persists it; not yet) ──
export const WRITES = ['none', 'view', 'doc', 'fs', 'net'];   // what the op mutates (net incl. devices)
export const REVERSE = ['recompute', 'snapshot', 'inverse', 'none'];   // how it undoes

// named presets → facet tuples (declare a preset; the TUPLE is what behaviour reads)
export const EFFECT_PRESETS = {
  pure:        { writes: 'none', reverse: 'recompute', pure: true },
  read:        { writes: 'none', reverse: 'recompute', pure: false },
  view:        { writes: 'view', reverse: 'snapshot',  pure: false },
  edit:        { writes: 'doc',  reverse: 'snapshot',  pure: false },
  write:       { writes: 'fs',   reverse: 'snapshot',  pure: false },
  egress:      { writes: 'net',  reverse: 'none',      pure: false },
  destructive: { writes: 'doc',  reverse: 'none',      pure: false },
};

// resolve a declared effect (a preset name OR an explicit partial tuple) → the full tuple
export function effectFacets(effect) {
  if (typeof effect === 'string') {
    const f = EFFECT_PRESETS[effect];
    if (!f) throw new Error(`op: unknown effect preset "${effect}"`);
    return f;
  }
  return { writes: 'none', reverse: 'recompute', pure: false, ...effect };   // explicit edge-case tuple
}

// ── behaviour derivations: each reads the ONE facet it cares about (not a switch on preset) ──
export function gateOf(facets) {                     // agent / confirm gate
  const base = facets.writes === 'net' ? 'always'
    : (facets.writes === 'doc' || facets.writes === 'fs') ? 'confirm'
      : 'free';                                      // none / view
  return (facets.reverse === 'none' && base === 'confirm') ? 'double' : base;   // irreversible → escalate
}
export const undoOf = (facets) => facets.reverse;                                   // recompute|snapshot|inverse|none
export const cacheable = (facets) => facets.pure && facets.writes === 'none';       // flowsheet may cache + stale-on-input
export const dirtiesDoc = (facets) => facets.writes === 'doc';
export const ledgered = (facets) => facets.writes === 'doc' || facets.writes === 'fs' || facets.writes === 'net';

// ── coherence validator: rejects the nonsense tuples facets can over-generate ──
export function validateEffect(effect) {
  const f = effectFacets(effect);
  if (!WRITES.includes(f.writes)) return `bad writes "${f.writes}"`;
  if (!REVERSE.includes(f.reverse)) return `bad reverse "${f.reverse}"`;
  if (f.pure && f.writes !== 'none') return `pure op cannot write (writes:${f.writes})`;
  if (f.writes === 'none' && f.reverse !== 'recompute') return `non-writing op must be reverse:recompute`;
  if (f.writes === 'net' && f.reverse === 'recompute') return `network op cannot be reverse:recompute`;
  return null;
}

// ── the geas builtins, classified by effect — coreutils are the textbook effect cases, so this
// table is the facet taxonomy's acceptance test. Each descriptor is the SINGLE source the doc
// projection renders: `summary` = the NAME line; optional `synopsis` (string | string[]),
// `doc` (DESCRIPTION prose, \n\n-separated paragraphs ok), `examples` (string[]), `seeAlso`
// (related command names). Synopses reflect the flags geas ACTUALLY parses, not the full
// GNU surface — they're honest about this implementation. ──
export const GEAS_OPS = {
  // pure — output is a function of args/stdin, no side effect
  echo: {
    effect: 'pure', summary: 'write arguments to stdout',
    synopsis: 'echo [-neE] [arg ...]',
    doc: 'Write each argument to stdout, separated by single spaces and followed by a newline. `-n` suppresses the trailing newline; `-e` enables backslash escape interpretation (\\n, \\t, …); `-E` disables it (the default). Flags combine, e.g. -ne.',
    examples: ['echo hello world', 'echo -n "no trailing newline"', 'echo -e "col1\\tcol2"'],
    seeAlso: ['printf'],
  },
  printf: {
    effect: 'pure', summary: 'format and print data',
    synopsis: 'printf format [arg ...]',
    doc: 'Format and print ARGs under the control of FORMAT — literal text, backslash escapes, and % conversion specs (%s string, %d integer, %x hex, %f float, …). The format is reused until all arguments are consumed.',
    examples: ['printf "%s = %d\\n" count 42', 'printf "%05.2f\\n" 3.14159'],
    seeAlso: ['echo'],
  },
  seq: {
    effect: 'pure', summary: 'print a sequence of numbers',
    synopsis: 'seq [-s sep] [first [incr]] last',
    doc: 'Print numbers from FIRST (default 1) to LAST, stepping by INCR (default 1), one per line. `-s` sets the separator instead of a newline.',
    examples: ['seq 5', 'seq 2 2 10', 'seq -s , 1 5'],
  },
  true: {
    effect: 'pure', summary: 'do nothing, successfully',
    doc: 'Do nothing and exit with status 0. Used as a no-op or to force a success status, e.g. in `while true` loops.',
    seeAlso: ['false', ':'],
  },
  false: {
    effect: 'pure', summary: 'do nothing, unsuccessfully',
    doc: 'Do nothing and exit with status 1 (failure). The counterpart to `true`.',
    seeAlso: ['true', ':'],
  },
  ':': {
    effect: 'pure', summary: 'the null command — expand args, return success',
    synopsis: ': [arg ...]',
    doc: 'The null command. Expands its arguments (so expansion side effects happen) and returns success without doing anything else. Common as a no-op placeholder or a `while :` infinite loop.',
    seeAlso: ['true'],
  },
  test: {
    effect: 'pure', summary: 'evaluate a conditional expression',
    synopsis: 'test expression',
    doc: 'Evaluate a conditional EXPRESSION, exiting 0 (true) or 1 (false). File tests: -e exists, -f regular file, -d directory, -s non-empty, -r/-w/-x access. String tests: -z empty, -n non-empty, = / !=. Numeric: -eq -ne -lt -le -gt -ge. Combine with -a (and), -o (or).',
    examples: ['test -f /etc/works.json', 'test "$count" -gt 10'],
    seeAlso: ['['],
  },
  '[': {
    effect: 'pure', summary: 'evaluate a conditional expression (test)',
    synopsis: '[ expression ]',
    doc: 'An alias for `test` that requires a closing `]` as its final argument, so conditionals read naturally as `[ -f file ]`.',
    examples: ['[ -d /tmp ] && echo present'],
    seeAlso: ['test'],
  },
  sort: {
    effect: 'pure', summary: 'sort lines of text',
    synopsis: 'sort [-nru] [file ...]',
    doc: 'Sort the lines of FILEs (or stdin). Lexicographic by default; `-n` numeric, `-r` reverse, `-u` discard duplicate lines.',
    examples: ['sort names.txt', 'sort -nr scores.txt', 'ls | sort'],
    seeAlso: ['uniq'],
  },
  uniq: {
    effect: 'pure', summary: 'filter adjacent repeated lines',
    synopsis: 'uniq [-cdu] [file]',
    doc: 'Collapse adjacent matching lines (sort the input first for global uniqueness). `-c` prefix each line with its repeat count, `-d` only repeated lines, `-u` only non-repeated lines.',
    examples: ['sort log.txt | uniq', 'sort log.txt | uniq -c'],
    seeAlso: ['sort'],
  },
  cut: {
    effect: 'pure', summary: 'select fields/columns from each line',
    synopsis: ['cut -f list [-d delim] [file ...]', 'cut -c list [file ...]'],
    doc: 'Select portions of each line. `-f` picks delimited fields (delimiter set by `-d`, default TAB); `-c` picks character positions. LIST is comma/range-separated, e.g. 1,3-5.',
    examples: ['cut -d, -f1,3 data.csv', 'cut -c1-10 file.txt'],
    seeAlso: ['tr', 'grep'],
  },
  tr: {
    effect: 'pure', summary: 'translate or delete characters',
    synopsis: 'tr [-cds] set1 [set2]',
    doc: 'Translate, squeeze, or delete characters from stdin. By default maps each char of SET1 to SET2. `-d` deletes SET1, `-s` squeezes runs of SET1 to one, `-c` complements (operate on chars NOT in SET1).',
    examples: ['tr a-z A-Z', 'tr -d " "', 'echo "a   b" | tr -s " "'],
    seeAlso: ['cut'],
  },
  base64: {
    effect: 'pure', summary: 'base64 encode/decode',
    synopsis: 'base64 [-d] [file]',
    doc: 'Base64-encode stdin or FILE (output wrapped at 76 columns), or decode with `-d`.',
    examples: ['echo hi | base64', 'cat token.b64 | base64 -d'],
    seeAlso: ['md5sum', 'sha256sum'],
  },
  md5sum: {
    effect: 'pure', summary: 'compute MD5 checksums',
    synopsis: 'md5sum [file ...]',
    doc: 'Compute the MD5 checksum of each FILE (or stdin). Prints the hex digest followed by the filename.',
    examples: ['md5sum archive.bin'],
    seeAlso: ['sha256sum', 'base64'],
  },
  sha256sum: {
    effect: 'pure', summary: 'compute SHA-256 checksums',
    synopsis: 'sha256sum [file ...]',
    doc: 'Compute the SHA-256 checksum of each FILE (or stdin). Prints the hex digest followed by the filename.',
    examples: ['sha256sum dist.zip'],
    seeAlso: ['md5sum'],
  },
  // read — reads the fs / session state, no mutation
  pwd: {
    effect: 'read', summary: 'print the working directory',
    synopsis: 'pwd',
    doc: 'Print the absolute pathname of the current working directory.',
    seeAlso: ['cd'],
  },
  cat: {
    effect: 'read', summary: 'concatenate files to stdout',
    synopsis: 'cat [file ...]',
    doc: 'Concatenate FILEs to stdout, in order. With no files, copy stdin through. (geas\'s cat takes no flags.)',
    examples: ['cat README.md', 'cat part1 part2 > whole.txt'],
    seeAlso: ['head', 'tail'],
  },
  ls: {
    effect: 'read', summary: 'list directory contents',
    synopsis: 'ls [-la] [path ...]',
    doc: 'List the contents of each PATH (default: the current directory), sorted by name. `-l` long format (type flag, size, name); `-a` include dotfiles. Flags combine, e.g. -la.',
    examples: ['ls', 'ls -la /home/nb', 'ls /projects'],
    seeAlso: ['tree', 'stat', 'find'],
  },
  tree: {
    effect: 'read', summary: 'list contents as an indented tree',
    synopsis: 'tree [-L level] [path]',
    doc: 'List PATH (default cwd) recursively as an indented tree. `-L` (alias --level) limits how deep the descent goes.',
    examples: ['tree', 'tree -L 2 /projects'],
    seeAlso: ['ls', 'find'],
  },
  stat: {
    effect: 'read', summary: 'display file status',
    synopsis: 'stat [-c format] [file ...]',
    doc: 'Display status (type, size, metadata) for each FILE. `-c` selects a custom format string, e.g. %n name, %s size.',
    examples: ['stat notebook.txt', "stat -c '%s' big.bin"],
    seeAlso: ['ls'],
  },
  find: {
    effect: 'read', summary: 'search for files',
    synopsis: 'find [path] [expression]',
    doc: 'Recursively search PATH for entries matching an EXPRESSION. Tests: -name / -iname (glob), -path, -type f|d, -size, -empty, -maxdepth / -mindepth. Actions: -print (default), -print0 (NUL-separated, pairs with `xargs -0`). Combine with -a (and) / -o (or).',
    examples: ["find . -name '*.txt'", 'find /projects -type d', "find . -name '*.tmp' -print0 | xargs -0 rm"],
    seeAlso: ['ls', 'grep', 'xargs'],
  },
  head: {
    effect: 'read', summary: 'output the first part of files',
    synopsis: 'head [-n count] [file ...]',
    doc: 'Output the first COUNT lines (default 10) of each FILE or stdin. `-n N` sets the count; the shorthand `-N` works too.',
    examples: ['head -n 5 log.txt', 'ls | head'],
    seeAlso: ['tail', 'cat'],
  },
  tail: {
    effect: 'read', summary: 'output the last part of files',
    synopsis: 'tail [-n count] [file ...]',
    doc: 'Output the last COUNT lines (default 10) of each FILE or stdin. `-n N` sets the count; the shorthand `-N` works too.',
    examples: ['tail -n 20 log.txt'],
    seeAlso: ['head', 'cat'],
  },
  wc: {
    effect: 'read', summary: 'count lines, words and bytes',
    synopsis: 'wc [-lwc] [file ...]',
    doc: 'Count lines, words, and bytes of FILEs or stdin. With no flag, prints all three; `-l` lines only, `-w` words, `-c` bytes.',
    examples: ['wc -l file.txt', 'ls | wc -l'],
    seeAlso: ['grep'],
  },
  grep: {
    effect: 'read', summary: 'search text for a pattern',
    synopsis: 'grep [-icnvF] pattern [file ...]',
    doc: 'Print the lines of FILEs (or stdin) matching a regular-expression PATTERN. `-i` ignore case, `-v` invert (print non-matching), `-c` print only a count, `-n` prefix line numbers, `-F` treat the pattern as a fixed string (no regex).',
    examples: ['grep -i error log.txt', "ls | grep '\\.js$'", 'grep -c TODO src.js'],
    seeAlso: ['find', 'cut', 'wc'],
  },
  du: {
    effect: 'read', summary: 'estimate file space usage',
    synopsis: 'du [-hs] [-d depth] [path ...]',
    doc: 'Estimate disk usage of each PATH, summed recursively. `-h` human-readable sizes, `-s` print only the grand total, `-d` limit the reported subtree depth.',
    examples: ['du -sh /projects', 'du -d1 /home'],
    seeAlso: ['df', 'ls'],
  },
  df: {
    effect: 'read', summary: 'report filesystem space usage',
    synopsis: 'df [-h]',
    doc: 'Report space usage of the mounted VFS filesystems. `-h` for human-readable sizes.',
    examples: ['df -h'],
    seeAlso: ['du'],
  },
  which: {
    effect: 'read', summary: 'locate a command',
    synopsis: 'which name ...',
    doc: 'Report, for each NAME, whether it resolves to a builtin, a shell function, or is not found.',
    examples: ['which ls grep frobnicate'],
    seeAlso: ['command', 'op'],
  },
  date: {
    effect: 'read', summary: 'print the date and time',
    synopsis: 'date [+format]',
    doc: 'Print the current date and time. A leading `+FORMAT` controls the output with strftime-style specifiers (%Y %m %d %H %M %S %a %b %e %T).',
    examples: ['date', "date +%Y-%m-%d"],
  },
  env: {
    effect: 'read', summary: 'print the environment',
    synopsis: 'env',
    doc: 'Print the shell environment, one NAME=value pair per line.',
    examples: ['env', 'env | grep PATH'],
    seeAlso: ['export', 'set'],
  },
  read: {
    effect: 'read', summary: 'read a line of input into variables',
    synopsis: 'read [-rs] [-p prompt] [-n n] [-d delim] [-t sec] name ...',
    doc: 'Read one line of input and split it across the NAMEs by $IFS. `-r` raw (no backslash escapes), `-p` print PROMPT first, `-s` silent (no echo), `-n N` stop after N characters, `-d` end at DELIM instead of newline, `-t` time out after SEC seconds.',
    examples: ['read -p "Name: " name', 'read -r line'],
    seeAlso: ['echo'],
  },
  // view — mutates session/shell state (cwd, vars, screen), reversible, not the fs/a doc
  cd: {
    effect: 'view', summary: 'change the working directory',
    synopsis: 'cd [dir]',
    doc: 'Change the working directory to DIR (default $HOME) and update $PWD. Reversible within the session — it touches shell state, not the filesystem.',
    examples: ['cd /projects', 'cd ..', 'cd'],
    seeAlso: ['pwd'],
  },
  clear: {
    effect: 'view', summary: 'clear the terminal screen',
    synopsis: 'clear',
    doc: 'Clear the terminal screen and move the cursor to the top-left.',
  },
  set: {
    effect: 'view', summary: 'set shell options / positional params',
    synopsis: 'set [-o option] [+o option] [arg ...]',
    doc: 'Set or unset shell options and positional parameters. `-o name` enables an option (errexit, nounset, xtrace, …), `+o name` disables it. Bare ARGs replace the positional parameters $1, $2, ….',
    examples: ['set -o errexit', 'set -- a b c'],
    seeAlso: ['export', 'shift'],
  },
  export: {
    effect: 'view', summary: 'mark variables for the environment',
    synopsis: 'export name[=value] ...',
    doc: 'Mark variables for export to the environment of subsequently run commands. With `=value`, assign first.',
    examples: ['export PATH=/bin:/usr/bin', 'export DEBUG=1'],
    seeAlso: ['env', 'set', 'local'],
  },
  local: {
    effect: 'view', summary: 'declare a function-local variable',
    synopsis: 'local name[=value] ...',
    doc: 'Declare variables local to the current shell function; they are unset when the function returns. Valid only inside a function.',
    examples: ['local count=0'],
    seeAlso: ['export', 'set'],
  },
  shift: {
    effect: 'view', summary: 'shift positional parameters',
    synopsis: 'shift [n]',
    doc: 'Shift the positional parameters left by N (default 1): $2 becomes $1, and so on. Used to consume arguments in a loop.',
    examples: ['shift', 'shift 2'],
    seeAlso: ['set'],
  },
  // write — reversible fs mutation
  mkdir: {
    effect: 'write', summary: 'make directories',
    synopsis: 'mkdir [-p] dir ...',
    doc: 'Create each DIRectory. `-p` creates missing parent directories and does not error if the target already exists.',
    examples: ['mkdir build', 'mkdir -p a/b/c'],
    seeAlso: ['rm', 'touch'],
  },
  touch: {
    effect: 'write', summary: 'create files / update timestamps',
    synopsis: 'touch file ...',
    doc: 'Create each FILE empty if it does not exist, or update its modification time if it does.',
    examples: ['touch notes.txt'],
    seeAlso: ['mkdir', 'cat'],
  },
  cp: {
    effect: 'write', summary: 'copy files',
    synopsis: 'cp [-r] source ... dest',
    doc: 'Copy SOURCE to DEST (or into DEST when DEST is a directory). `-r` copies directories recursively. The copy is reversible by removing the new file.',
    examples: ['cp a.txt b.txt', 'cp -r src/ backup/'],
    seeAlso: ['mv', 'rm'],
  },
  mv: {
    effect: 'write', summary: 'move or rename files',
    synopsis: 'mv source ... dest',
    doc: 'Rename SOURCE to DEST, or move one or more SOURCEs into a DEST directory.',
    examples: ['mv old.txt new.txt', 'mv *.png images/'],
    seeAlso: ['cp', 'rm'],
  },
  tee: {
    effect: 'write', summary: 'copy stdin to stdout and to files',
    synopsis: 'tee [-a] file ...',
    doc: 'Copy stdin to stdout AND to each FILE. `-a` appends instead of overwriting.',
    examples: ['ls | tee listing.txt', 'echo log | tee -a app.log'],
    seeAlso: ['cat'],
  },
  // destructive — irreversible loss (fs, not a doc → the explicit tuple, not the doc `destructive` preset)
  rm: {
    effect: { writes: 'fs', reverse: 'none' }, summary: 'remove files and directories',
    synopsis: 'rm [-rf] file ...',
    doc: 'Remove each FILE. `-r` recurses into directories, `-f` ignores missing files and never prompts.\n\nIrreversible — there is no trash. Because the descriptor declares writes:fs + reverse:none, an agent is gated to a double-confirm before this runs.',
    examples: ['rm tmp.txt', 'rm -rf build/'],
    seeAlso: ['mv', 'mkdir'],
  },
  // meta — effect is the UNION of whatever they run (dynamic); conservative default, noted
  eval: {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'run arguments as a command (effect = what it runs)',
    synopsis: 'eval [arg ...]',
    doc: 'Concatenate ARGs into one command and execute it in the current shell. The real effect is whatever that command does; the descriptor\'s classification is a conservative upper bound, since the target is only known at runtime.',
    examples: ['eval "$cmd"'],
    seeAlso: ['source', 'command', 'xargs'],
  },
  source: {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'execute a script in the current shell (effect = the script)',
    synopsis: 'source file [arg ...]',
    doc: 'Read and execute commands from FILE in the CURRENT shell, so its variable and function definitions persist. Effect = the script\'s effect.',
    examples: ['source ~/.geasrc'],
    seeAlso: ['.', 'eval'],
  },
  '.': {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'execute a script in the current shell (source)',
    synopsis: '. file [arg ...]',
    doc: 'Synonym for `source`: execute FILE in the current shell.',
    examples: ['. ./env.sh'],
    seeAlso: ['source'],
  },
  command: {
    effect: 'read', summary: 'run a command, bypassing functions',
    synopsis: 'command name [arg ...]',
    doc: 'Run NAME as a builtin or external command, bypassing any shell function of the same name.',
    examples: ['command ls'],
    seeAlso: ['which', 'eval'],
  },
  xargs: {
    effect: { writes: 'doc', reverse: 'none' }, summary: 'build and run commands from stdin (effect = what it runs)',
    synopsis: 'xargs [-0] [-n max] [-I repl] command ...',
    doc: 'Build and execute command lines from whitespace-separated stdin tokens. `-0` reads NUL-separated input (pairs with `find -print0`), `-n` caps arguments per invocation, `-I` substitutes a replacement string per token. Effect = what the built command does.',
    examples: ["find . -name '*.tmp' -print0 | xargs -0 rm", 'ls | xargs -n1 echo'],
    seeAlso: ['find', 'eval'],
  },
  getopts: {
    effect: 'read', summary: 'parse positional parameters as options',
    synopsis: 'getopts optstring name [arg ...]',
    doc: 'Parse positional parameters as options per OPTSTRING, one option per call, for a `while getopts` loop. Sets NAME to the option letter and $OPTARG / $OPTIND.',
    examples: ['while getopts "vf:" opt; do echo "$opt"; done'],
    seeAlso: ['set', 'shift'],
  },
  exit: {
    effect: 'view', summary: 'exit the shell',
    synopsis: 'exit [n]',
    doc: 'Exit the shell with status N (default: the status of the last command run).',
    examples: ['exit', 'exit 1'],
    seeAlso: ['return'],
  },
  return: {
    effect: 'view', summary: 'return from a shell function',
    synopsis: 'return [n]',
    doc: 'Return from the current shell function with status N (default: the last command\'s status). Valid only inside a function.',
    examples: ['return 0'],
    seeAlso: ['exit'],
  },
  // the doc projection itself (so `man man` / `op op` work)
  man: {
    effect: 'read', summary: 'display the manual for a command',
    synopsis: 'man command',
    doc: 'Display the manual page for COMMAND, rendered from its op descriptor: NAME, SYNOPSIS, the EFFECT class (what it writes, whether it is undoable, how an agent is gated), DESCRIPTION, EXAMPLES, and SEE ALSO.',
    examples: ['man rm', 'man find'],
    seeAlso: ['op', 'which'],
  },
  op: {
    effect: 'read', summary: 'browse the op registry by effect',
    synopsis: ['op [name]', 'op list [--effect=preset] [--writes=facet] [--gate=level]'],
    doc: 'Browse the op registry. With no arguments, list every op with its effect preset. `op list` filters by --effect (pure/read/view/edit/write/egress/destructive), --writes (none/view/doc/fs/net), or --gate (free/confirm/double/always). `op NAME` shows that op\'s manual (same as `man NAME`).',
    examples: ['op', 'op list --writes=fs', 'op list --gate=double', 'op rm'],
    seeAlso: ['man', 'which'],
  },
};

// ── the doc projection: render a descriptor as a man page; browse the registry as a catalog ──
const WRITES_HUMAN = { none: 'no side effects', view: 'changes the session', doc: 'edits the document', fs: 'writes the filesystem', net: 'network / device I/O' };
const REVERSE_HUMAN = { recompute: 'recomputable', snapshot: 'undoable', inverse: 'undoable', none: 'not undoable' };
const GATE_HUMAN = { free: 'runs freely', confirm: 'confirms first', double: 'double-confirms', always: 'always asks' };

// effect → human description (the GCU-distinctive man section: what hand-written pages can't carry)
export function describeEffect(effect) {
  const f = effectFacets(effect);
  return { preset: typeof effect === 'string' ? effect : 'custom', writes: WRITES_HUMAN[f.writes], undo: REVERSE_HUMAN[f.reverse], gate: GATE_HUMAN[gateOf(f)] };
}

// indent every line of `text` by `pad` (blank lines stay blank — no trailing whitespace).
const indent = (text, pad = '    ') => String(text).split('\n').map((l) => (l ? pad + l : l)).join('\n');

// `man <command>` — render the op descriptor as a man page (NAME · SYNOPSIS? · EFFECT · DESCRIPTION · …).
export async function manCmd(argv, ctx) {
  const name = argv[0];
  if (!name) { await ctx.stderr('usage: man <command>\n'); return 1; }
  const op = GEAS_OPS[name];
  if (!op) { await ctx.stderr(`man: no manual entry for ${name}\n`); return 1; }
  const d = describeEffect(op.effect);
  let s = `NAME\n${indent(`${name} — ${op.summary || ''}`)}\n\n`;
  if (op.synopsis) {
    const forms = Array.isArray(op.synopsis) ? op.synopsis : [op.synopsis];
    s += `SYNOPSIS\n${forms.map((f) => indent(f)).join('\n')}\n\n`;
  }
  s += `EFFECT\n${indent(`${d.preset} · ${d.writes} · ${d.undo} · agent: ${d.gate}`)}\n\n`;
  s += `DESCRIPTION\n${indent(op.doc || op.summary || '')}\n`;
  if (op.examples?.length) s += '\nEXAMPLES\n' + op.examples.map((e) => indent(e)).join('\n') + '\n';
  if (op.seeAlso?.length) s += `\nSEE ALSO\n${indent(op.seeAlso.join(', '))}\n`;
  await ctx.stdout(s);
  return 0;
}

// `op` / `op list [--effect=|--writes=|--gate=]` — the registry as a queryable catalog; `op <name>` → man.
export async function opCmd(argv, ctx) {
  const head = argv[0];
  if (head && head !== 'list' && GEAS_OPS[head]) return manCmd([head], ctx);   // `op rm` → man rm
  const rest = head === 'list' ? argv.slice(1) : argv;
  const filters = {};
  for (const a of rest) { const m = /^--(effect|writes|gate)=(.+)$/.exec(a); if (m) filters[m[1]] = m[2]; }
  const rows = [];
  for (const [name, op] of Object.entries(GEAS_OPS)) {
    const f = effectFacets(op.effect), preset = typeof op.effect === 'string' ? op.effect : 'custom';
    if (filters.effect && preset !== filters.effect) continue;
    if (filters.writes && f.writes !== filters.writes) continue;
    if (filters.gate && gateOf(f) !== filters.gate) continue;
    rows.push([name, preset, op.summary || '']);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) { await ctx.stdout('(no ops match)\n'); return 0; }
  const nw = Math.max(4, ...rows.map((r) => r[0].length)), pw = Math.max(6, ...rows.map((r) => r[1].length));
  await ctx.stdout(rows.map((r) => `${r[0].padEnd(nw)}  ${r[1].padEnd(pw)}  ${r[2]}`).join('\n') + '\n');
  return 0;
}
