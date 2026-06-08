// notebook.shell(script) — run a geas script in a Web Worker, capture
// stdout/stderr, return { stdout, stderr, exitCode, error?, _repr_html_ }.
//
// Backs the cell-level `!cmd` sugar (rewriteShellCell in dag-core.js) and
// is also callable directly. Works-only — needs @gcu/geas, which the shell
// surfaces at /usr/lib/@gcu/geas; standalone notebooks throw a clear error.
//
// v1: spawn-per-call. Cwd/env don't persist across calls. Cheap enough for
// interactive use; a session-shared shell can come later if a real workflow
// asks for it.

import { ProcessManager } from '#proc';
import { run as coreutilsRun, names as coreutilsNames } from '#coreutils';

function _escHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

// Every shell result has the same shape (geas path + lite path) so display() / the
// `!cmd` rewrite render identically.
function _shellResult(stdout, stderr, exitCode) {
  const r = {
    stdout, stderr, exitCode,
    _repr_html_() {
      const parts = [];
      if (stdout) parts.push(`<pre class="au-shell-out">${_escHtml(stdout)}</pre>`);
      if (stderr) parts.push(`<pre class="au-shell-err">${_escHtml(stderr)}</pre>`);
      return parts.join('') || '<pre class="au-shell-out"></pre>';
    },
  };
  if (exitCode !== 0) r.error = new Error(`shell exited ${exitCode}`);
  return r;
}

// Minimal argv tokenizer: whitespace split with "double" / 'single' quote support.
function _tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Lite, worker-free dispatch for the built-in commands (pkg + @gcu/coreutils). Runs
// natively over the notebook VFS, so it works everywhere including file:// — no geas.
// Returns a result, or null when the script isn't a single lite command (pipes,
// redirects, sequencing, multi-line) → fall through to geas.
async function _runLite(script, vfs, ctx, opts) {
  if (/[|<>&;`$]/.test(script) || script.includes('\n')) return null;
  const argv = _tokenize(script.trim());
  if (!argv.length) return null;
  const cmd = argv[0];
  if (cmd === 'pkg') return _pkg(argv.slice(1), ctx);
  if (coreutilsNames.includes(cmd)) {
    const { stdout, stderr, code } = await coreutilsRun(argv, { vfs, cwd: opts.cwd || '/home/nb' });
    return _shellResult(stdout, stderr, code);
  }
  return null;
}

// pkg-lite: install / list / remove over the host's module system (install() +
// _installedModules). Notebook-scoped — the package persists in the saved notebook.
// (In Works, geas's richer `pkg` — workspace /lib, lockfile, SRI — is reachable as a
// non-lite command; this is the universal, standalone-friendly subset.)
async function _pkg(args, ctx) {
  const sub = args[0];
  try {
    if (sub === 'install' || sub === 'add' || sub === 'i') {
      const specs = args.slice(1).filter(Boolean);
      if (!specs.length) return _shellResult('', 'pkg: install needs a package spec', 1);
      const done = [];
      for (const spec of specs) { await ctx.install(spec); done.push(spec); }
      return _shellResult(`installed: ${done.join(', ')}`, '', 0);
    }
    if (sub === 'list' || sub === 'ls') {
      return _shellResult(Object.keys(window._installedModules || {}).sort().join('\n'), '', 0);
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
      const name = args[1];
      if (!name) return _shellResult('', 'pkg: remove needs a package name', 1);
      const mods = window._installedModules || {};
      if (!(name in mods)) return _shellResult('', `pkg: ${name}: not installed`, 1);
      delete mods[name];
      if (window._importCache) delete window._importCache[name];
      return _shellResult(`removed: ${name}`, '', 0);
    }
    return _shellResult('', `pkg: unknown subcommand "${sub || ''}" — try install | list | remove`, 1);
  } catch (e) {
    return _shellResult('', `pkg: ${(e && e.message) || e}`, 1);
  }
}

// Resolve a module that was installed into the notebook's VFS at boot
// (hydrateModulesFromVfs put it on window._installedModules). Returns the
// already-decoded JS source string or throws.
async function _loadInstalledSource(name) {
  const entry = (window._installedModules || {})[name];
  if (!entry) throw new Error(`notebook.shell: ${name} is not available (Works-only feature)`);
  if (typeof entry === 'string') return entry;
  if (entry.source && !entry.compressed && !entry.binary) return entry.source;
  if (entry.source && entry.compressed && !entry.binary) {
    // Reuse the same gzip+base64 decode the modules builtin uses.
    const bin = Uint8Array.from(atob(entry.source), (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(bin); w.close();
    const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    return new TextDecoder().decode(out);
  }
  throw new Error(`notebook.shell: cannot decode ${name} entry`);
}

let _geasCache = null;   // { module, source } — source kept for the worker bootstrap
async function _getGeas() {
  if (_geasCache) return _geasCache;
  const source = await _loadInstalledSource('@gcu/geas');
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let module;
  try { module = await import(/* @vite-ignore */ url); }
  finally { URL.revokeObjectURL(url); }
  _geasCache = { module, source };
  return _geasCache;
}

let _sharedManager = null;
function _getManager() {
  if (!_sharedManager) _sharedManager = new ProcessManager();
  return _sharedManager;
}

export function makeShell(cell, ctx) {
  const { invalidation } = ctx;

  return async function shell(script, opts = {}) {
    const vfs = window._notebookVFS;
    if (!vfs) throw new Error('notebook.shell: no VFS in scope');

    // Lite built-ins (pkg + coreutils) run natively over the VFS — no geas worker, so
    // they work on file:// too. Non-lite scripts fall through to geas (Works/http).
    const lite = await _runLite(script, vfs, ctx, opts);
    if (lite) return lite;

    const { module, source } = await _getGeas();
    const { createGeasClient, procToWorker } = module;

    // Build the worker source: the geas bundle text, stripped of the
    // trailing `export {…}`, plus a registerEntry tail. Same approach as
    // works/surfaces/terminal.html.
    const stripped = source.replace(/\nexport\s*\{[^}]*\}\s*;?\s*$/, '');
    const inlineSource = stripped
      + '\n_procRegisterEntry(geasProcEntry({ createShell, isTyped, setupGeasWorker }));\n';

    const pm = _getManager();
    let proc, worker, client;
    const stdoutBuf = [];
    const stderrBuf = [];
    let killed = false;
    const kill = async () => {
      killed = true;
      try { if (client) await client.terminate(); }
      catch { /* */ }
      try { if (proc) await proc.terminate(); }
      catch { /* */ }
    };
    invalidation.then(kill);

    try {
      proc = await pm.spawn({ inlineSource, command: 'geas-shell' });
      worker = procToWorker(proc);
      client = createGeasClient({
        worker,
        vfs,
        env: { HOME: '/home', PS1: '$ ', ...(opts.env || {}) },
        cwd: opts.cwd || '/projects/self',
        onStdout: (t) => stdoutBuf.push(t),
        onStderr: (t) => stderrBuf.push(t),
      });
      await client.ready();
      const { exitCode } = await client.exec(script);
      return _shellResult(stdoutBuf.join(''), stderrBuf.join(''), exitCode);
    } finally {
      if (!killed) await kill();
    }
  };
}
