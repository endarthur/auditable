// Sink adapter — normalize a destination into a thin shape the format
// handlers write extraction output through. Mirrors source.js.
//
// Accepted sink shapes:
//   - { vfs, path }       VFS adapter; `path` is the destination directory.
//                         writeFile creates path/<entry>; mkdir creates
//                         path/<entryDir>. Both auto-create parents.
//   - 'memory'            Returns the populated `Map<innerPath, Uint8Array>`
//                         from the sink's `.result()` method.
//   - WritableStream      Streaming write (not yet implemented for extract;
//                         placeholder shape for future compress streaming).
//
// Overwrite semantics ('error' | 'skip' | 'rename' | 'overwrite') are handled
// by the per-format extract code, not here — the sink just writes when asked.

const joinPath = (a, b) => {
  if (!a || a === '/') return '/' + String(b).replace(/^\/+/, '');
  return a.replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '');
};

const parentOf = (p) => {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
};

export function normalizeSink(input) {
  if (!input) throw new TypeError('sink: required');

  // 'memory' — collect into a Map. result() drains it.
  if (input === 'memory') {
    const map = new Map();
    return {
      kind: 'memory',
      async writeFile(innerPath, bytes) {
        map.set(innerPath, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      },
      async mkdir(/* innerPath */) { /* memory sink doesn't track dirs */ },
      async exists(innerPath)      { return map.has(innerPath); },
      result()                     { return map; },
    };
  }

  // { vfs, path } — VFS adapter with destination directory.
  if (typeof input === 'object' && input.vfs && typeof input.path === 'string') {
    const vfs = input.vfs;
    const root = input.path.replace(/\/+$/, '') || '/';
    const callMaybeAsync = async (fn) => {
      const r = fn();
      return (r && typeof r.then === 'function') ? await r : r;
    };
    return {
      kind: 'vfs',
      root,
      async writeFile(innerPath, bytes) {
        const full = joinPath(root, innerPath);
        const dir = parentOf(full);
        try { await callMaybeAsync(() => vfs.mkdir(dir, { recursive: true })); } catch {}
        await callMaybeAsync(() => vfs.writeFile(full,
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
      },
      async mkdir(innerPath) {
        const full = joinPath(root, innerPath);
        try { await callMaybeAsync(() => vfs.mkdir(full, { recursive: true })); } catch {}
      },
      async exists(innerPath) {
        const full = joinPath(root, innerPath);
        try {
          const r = await callMaybeAsync(() => vfs.exists ? vfs.exists(full) :
            (vfs.stat ? vfs.stat(full).then(() => true, () => false) : false));
          return !!r;
        } catch { return false; }
      },
    };
  }

  // WritableStream — not yet hooked up for extract.
  if (typeof WritableStream !== 'undefined' && input instanceof WritableStream) {
    throw new TypeError('sink: WritableStream is reserved for streaming compress (not yet implemented)');
  }

  throw new TypeError('sink: unrecognized shape — expected { vfs, path } | "memory" | WritableStream');
}
