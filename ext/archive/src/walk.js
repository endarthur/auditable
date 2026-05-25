// VFS directory walker — recursively enumerates a tree into a flat list of
// `{ path, type, bytes }` entries with paths relative to the root.
//
// Used by archive.compress to build the entry map for ZIP / tar / tar.gz
// from a workspace directory. The output shape matches what zipSync /
// writeTar consume (after a final reduce to `{ path: bytes }`).
//
// VFS duck type: needs readdir, stat, readFile. Same surface as
// aggregateLicenses uses. Each method may be sync or return a Promise —
// we await both shapes uniformly.

async function _call(fn, ...args) {
  const r = fn(...args);
  return (r && typeof r.then === 'function') ? await r : r;
}

// Read the file at path as bytes. The VFS contract is loose — some backends
// default to utf8 strings, others return Uint8Array. Try the explicit bytes
// mode first; fall back to utf8 + TextEncoder if that fails or returns junk.
async function _readBytes(vfs, path) {
  // Try a bytes-mode request when supported.
  try {
    const r = await _call(vfs.readFile.bind(vfs), path);
    if (r instanceof Uint8Array) return r;
    if (r && r.buffer && typeof r.byteLength === 'number') {
      return new Uint8Array(r.buffer, r.byteOffset || 0, r.byteLength);
    }
    if (typeof r === 'string') return new TextEncoder().encode(r);
  } catch (e) {
    throw new Error(`walk: read ${path} failed: ${e.message || e}`);
  }
  throw new Error(`walk: read ${path} returned unsupported shape`);
}

// walkVfsTree(vfs, rootPath, opts?) → Promise<entries[]>
//
// rootPath may be a directory or a single file. For a directory, we recurse
// and return entries with paths relative to rootPath. For a file, we return
// one entry whose path is the file's basename.
//
// opts.filter: predicate ({ path, type }) → boolean. Excluded entries are
// neither recursed into nor emitted; truthy values are kept.
//
// opts.includeRootDirEntry: emit a leading `path: ''` directory entry for
// the root. Defaults to false — most archive formats don't need it and ZIP
// conventions vary.
export async function walkVfsTree(vfs, rootPath, opts = {}) {
  if (!vfs || typeof vfs.readdir !== 'function' || typeof vfs.readFile !== 'function'
      || typeof vfs.stat !== 'function') {
    throw new TypeError('walkVfsTree: vfs must implement readdir, readFile, stat');
  }
  const filter = opts.filter || (() => true);
  const entries = [];

  const root = String(rootPath).replace(/\/+$/, '') || '/';
  const stRoot = await _call(vfs.stat.bind(vfs), root);
  if (!stRoot) throw new Error(`walk: root path does not exist: ${root}`);

  // Single-file root — emit just the file.
  if (stRoot.type === 'file') {
    const name = root.split('/').filter(Boolean).pop() || 'file';
    if (filter({ path: name, type: 'file' })) {
      entries.push({ path: name, type: 'file', bytes: await _readBytes(vfs, root) });
    }
    return entries;
  }

  if (stRoot.type !== 'directory') {
    throw new Error(`walk: root ${root} has unsupported type: ${stRoot.type}`);
  }

  // Directory root — recurse. `relPath` accumulates the path inside the
  // archive; rootPath stays separate so we don't leak the workspace
  // absolute path into the archive's entry names.
  async function recurse(absPath, relPath) {
    const names = (await _call(vfs.readdir.bind(vfs), absPath)) || [];
    // Sort for determinism — archive byte output is reproducible across runs.
    names.sort();
    for (const name of names) {
      const child = absPath === '/' ? `/${name}` : `${absPath}/${name}`;
      const childRel = relPath ? `${relPath}/${name}` : name;
      let st;
      try { st = await _call(vfs.stat.bind(vfs), child); } catch { continue; }
      if (!st) continue;

      if (st.type === 'directory') {
        if (!filter({ path: childRel, type: 'directory' })) continue;
        entries.push({ path: childRel + '/', type: 'directory', bytes: new Uint8Array(0) });
        await recurse(child, childRel);
      } else if (st.type === 'file') {
        if (!filter({ path: childRel, type: 'file' })) continue;
        entries.push({ path: childRel, type: 'file',
          bytes: await _readBytes(vfs, child) });
      }
      // Anything else (symlinks etc.) is skipped silently.
    }
  }

  if (opts.includeRootDirEntry) {
    entries.push({ path: '', type: 'directory', bytes: new Uint8Array(0) });
  }
  await recurse(root, '');
  return entries;
}

// Convenience: walk + reduce to a flat { path: bytes } object — the input
// shape that fflate's zipSync and our own writeTar accept directly.
// Directory entries are emitted as zero-byte values keyed with a trailing '/'.
export async function buildEntryMap(vfs, rootPath, opts = {}) {
  const entries = await walkVfsTree(vfs, rootPath, opts);
  const map = {};
  for (const e of entries) map[e.path] = e.bytes;
  return map;
}
