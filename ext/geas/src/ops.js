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
// table is the facet taxonomy's acceptance test. `summary` is the one-line man synopsis. ──
export const GEAS_OPS = {
  // pure — output is a function of args/stdin, no side effect
  echo:      { effect: 'pure', summary: 'write arguments to stdout' },
  printf:    { effect: 'pure', summary: 'format and print data' },
  seq:       { effect: 'pure', summary: 'print a sequence of numbers' },
  true:      { effect: 'pure', summary: 'do nothing, successfully' },
  false:     { effect: 'pure', summary: 'do nothing, unsuccessfully' },
  ':':       { effect: 'pure', summary: 'the null command — expand args, return success' },
  test:      { effect: 'pure', summary: 'evaluate a conditional expression' },
  '[':       { effect: 'pure', summary: 'evaluate a conditional expression (test)' },
  sort:      { effect: 'pure', summary: 'sort lines of text' },
  uniq:      { effect: 'pure', summary: 'filter adjacent repeated lines' },
  cut:       { effect: 'pure', summary: 'select fields/columns from each line' },
  tr:        { effect: 'pure', summary: 'translate or delete characters' },
  base64:    { effect: 'pure', summary: 'base64 encode/decode' },
  md5sum:    { effect: 'pure', summary: 'compute MD5 checksums' },
  sha256sum: { effect: 'pure', summary: 'compute SHA-256 checksums' },
  // read — reads the fs / session state, no mutation
  pwd:   { effect: 'read', summary: 'print the working directory' },
  cat:   { effect: 'read', summary: 'concatenate files to stdout' },
  ls:    { effect: 'read', summary: 'list directory contents' },
  tree:  { effect: 'read', summary: 'list contents as an indented tree' },
  stat:  { effect: 'read', summary: 'display file status' },
  find:  { effect: 'read', summary: 'search for files' },
  head:  { effect: 'read', summary: 'output the first part of files' },
  tail:  { effect: 'read', summary: 'output the last part of files' },
  wc:    { effect: 'read', summary: 'count lines, words and bytes' },
  grep:  { effect: 'read', summary: 'search text for a pattern' },
  du:    { effect: 'read', summary: 'estimate file space usage' },
  df:    { effect: 'read', summary: 'report filesystem space usage' },
  which: { effect: 'read', summary: 'locate a command' },
  date:  { effect: 'read', summary: 'print the date and time' },
  env:   { effect: 'read', summary: 'print the environment' },
  read:  { effect: 'read', summary: 'read a line of input into variables' },
  // view — mutates session/shell state (cwd, vars, screen), reversible, not the fs/a doc
  cd:     { effect: 'view', summary: 'change the working directory' },
  clear:  { effect: 'view', summary: 'clear the terminal screen' },
  set:    { effect: 'view', summary: 'set shell options / positional params' },
  export: { effect: 'view', summary: 'mark variables for the environment' },
  local:  { effect: 'view', summary: 'declare a function-local variable' },
  shift:  { effect: 'view', summary: 'shift positional parameters' },
  // write — reversible fs mutation
  mkdir: { effect: 'write', summary: 'make directories' },
  touch: { effect: 'write', summary: 'create files / update timestamps' },
  cp:    { effect: 'write', summary: 'copy files' },
  mv:    { effect: 'write', summary: 'move or rename files' },
  tee:   { effect: 'write', summary: 'copy stdin to stdout and to files' },
  // destructive — irreversible loss
  rm:    { effect: 'destructive', summary: 'remove files and directories' },
  // meta — effect is the UNION of whatever they run (dynamic); conservative default, noted
  eval:    { effect: { writes: 'doc', reverse: 'none' }, summary: 'run arguments as a command (effect = what it runs)' },
  source:  { effect: { writes: 'doc', reverse: 'none' }, summary: 'execute a script in the current shell (effect = the script)' },
  '.':     { effect: { writes: 'doc', reverse: 'none' }, summary: 'execute a script in the current shell (source)' },
  command: { effect: 'read', summary: 'run a command, bypassing functions' },
  xargs:   { effect: { writes: 'doc', reverse: 'none' }, summary: 'build and run commands from stdin (effect = what it runs)' },
  getopts: { effect: 'read', summary: 'parse positional parameters as options' },
  exit:    { effect: 'view', summary: 'exit the shell' },
  return:  { effect: 'view', summary: 'return from a shell function' },
};
