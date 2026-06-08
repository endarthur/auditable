// util.js — path resolution + minimal getopt for the coreutils-lite commands.

// Resolve `p` against `cwd`, normalizing `.`/`..`. Absolute paths ignore cwd.
export function resolvePath(cwd, p) {
  const base = p && p.startsWith('/') ? p : (cwd || '/') + '/' + (p || '');
  const parts = [];
  for (const seg of base.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); }
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

// Join a directory and a child name into a normalized absolute path.
export function join(dir, name) {
  return (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
}

// Split argv into { flags:Set<char>, opts:{char:value}, positional:[] }.
// Supports clustered flags (-rf), value options (-n 5 or -n5), and `--`.
// `optsWithValue` lists the single-char options that take a value.
export function parseArgs(args, optsWithValue = []) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    // a flag/option group: starts with '-', not just '-', not a negative number
    if (a.length > 1 && a[0] === '-' && !/^-\d/.test(a)) {
      const body = a.slice(1);
      for (let j = 0; j < body.length; j++) {
        const ch = body[j];
        if (optsWithValue.includes(ch)) {
          const rest = body.slice(j + 1);
          opts[ch] = rest !== '' ? rest : args[++i];
          break; // value option consumes the remainder of this token
        }
        flags.add(ch);
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, opts, positional };
}

export const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 });
export const fail = (stderr, code = 1) => ({ stdout: '', stderr, code });
