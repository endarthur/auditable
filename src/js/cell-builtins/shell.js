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

function _escHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
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
      const stdout = stdoutBuf.join('');
      const stderr = stderrBuf.join('');
      const result = {
        stdout, stderr, exitCode,
        _repr_html_() {
          const parts = [];
          if (stdout) parts.push(`<pre class="au-shell-out">${_escHtml(stdout)}</pre>`);
          if (stderr) parts.push(`<pre class="au-shell-err">${_escHtml(stderr)}</pre>`);
          return parts.join('') || '<pre class="au-shell-out"></pre>';
        },
      };
      if (exitCode !== 0) result.error = new Error(`shell exited ${exitCode}`);
      return result;
    } finally {
      if (!killed) await kill();
    }
  };
}
