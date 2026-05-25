// .gcupkg consumer — reader + VFS installer per EXTENSION_SPEC.md §6.1.
//
// A `.gcupkg` is a ZIP archive with a fixed internal layout:
//   package.json              ← required
//   index.js                  ← required (primary ES module entry)
//   adder.js                  ← optional (Python-shape adapter)
//   LICENSE                   ← required
//   README.md, SPEC.md        ← optional
//   examples/*.txt + manifest.json   ← optional (§6.3)
//   docs/*.md                 ← optional (§6.2)
//   .gcupkg-meta.json         ← required (schema below)
//
// Two phases:
//   parseGcupkg(bytes, archiveLib) → { meta, packageJson, files, integrity }
//     Unzips, parses metadata, validates schema, computes/verifies integrity.
//   installGcupkg(parsed, { vfs, installedModules }) → { libPath, ... }
//     Writes to /lib/<name>/, /usr/share/examples/<name>/, /usr/share/docs/<name>/.
//     Updates /lib/.gcu-lock.json + window._installedModules.
//
// Caller supplies the archive lib (zip reader). Auditable doesn't bundle
// @gcu/archive by default; works does, and geas can prepend it. The
// dependency is injected so this module stays portable.

const _DECODER = new TextDecoder();
const _ENCODER = new TextEncoder();

// ── Parse phase ──────────────────────────────────────────────────────────

export async function parseGcupkg(bytes, archiveLib) {
  if (!bytes || !(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
    throw new TypeError('parseGcupkg: bytes must be Uint8Array | ArrayBuffer');
  }
  if (!archiveLib || !archiveLib.archive) {
    throw new Error('parseGcupkg: archive library required — pass { archive } from @gcu/archive');
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const archive = archiveLib.archive;

  // ZIP must be the outer container.
  const fmt = await archive.detect(u8);
  if (fmt !== 'zip') {
    throw new Error(`parseGcupkg: expected ZIP archive, detected '${fmt || 'unknown'}'`);
  }

  // Drain every entry into a flat map. .gcupkg are small (KB to MB range);
  // streaming would be overkill.
  const entries = await archive.list(u8);
  const files = {};
  for (const e of entries) {
    if (e.type !== 'file') continue;
    files[e.path] = await archive.read(u8, e.path);
  }

  // Required-file check before any further parsing.
  for (const required of ['.gcupkg-meta.json', 'package.json', 'index.js', 'LICENSE']) {
    if (!files[required]) {
      throw new Error(`parseGcupkg: missing required file '${required}'`);
    }
  }

  // Parse JSON.
  let meta, packageJson;
  try {
    meta = JSON.parse(_DECODER.decode(files['.gcupkg-meta.json']));
  } catch (e) {
    throw new Error(`parseGcupkg: invalid .gcupkg-meta.json — ${e.message}`);
  }
  try {
    packageJson = JSON.parse(_DECODER.decode(files['package.json']));
  } catch (e) {
    throw new Error(`parseGcupkg: invalid package.json — ${e.message}`);
  }

  // Schema check (small, intentional — keep the surface tight).
  if (meta.gcupkgVersion !== 1) {
    throw new Error(`parseGcupkg: unsupported gcupkgVersion ${JSON.stringify(meta.gcupkgVersion)} (this build supports 1)`);
  }
  if (typeof meta.name !== 'string' || !meta.name) {
    throw new Error('parseGcupkg: meta.name is required');
  }
  if (typeof meta.version !== 'string' || !meta.version) {
    throw new Error('parseGcupkg: meta.version is required');
  }
  if (packageJson.name && packageJson.name !== meta.name) {
    throw new Error(`parseGcupkg: name mismatch — meta says ${JSON.stringify(meta.name)}, package.json says ${JSON.stringify(packageJson.name)}`);
  }

  // Integrity verification, if the meta provides enough info.
  //
  // EXTENSION_SPEC §6.1 (revised): `integrityCovers` lists the files included
  // in the hash. Sort lexicographically, then for each: filename + NUL byte +
  // file bytes + NUL byte, all concatenated and SHA-256'd. The spec's
  // recommended scope is index.js + every secondary entry from
  // package.json `exports`, but the meta is the source of truth here.
  //
  // Legacy single-file integrity (carotte 0.1.0 shape — hash of index.js
  // only, no `integrityCovers` field) is verified as an `index.js`-only
  // hash for backwards compatibility, with a hint logged so the producer
  // can upgrade.
  let integrity = { ok: null, covered: null, computed: null, declared: null, note: null };
  if (typeof meta.integrity === 'string' && meta.integrity.startsWith('sha256-')) {
    integrity.declared = meta.integrity;
    if (Array.isArray(meta.integrityCovers) && meta.integrityCovers.length > 0) {
      integrity.covered = meta.integrityCovers;
      integrity.computed = await _computeIntegrity(meta.integrityCovers, files);
      integrity.ok = integrity.computed === meta.integrity;
    } else {
      // Legacy: single-file index.js hash (no separator framing).
      integrity.covered = ['index.js'];
      integrity.computed = await _computeLegacyIntegrity(files['index.js']);
      integrity.ok = integrity.computed === meta.integrity;
      integrity.note = 'legacy single-file integrity (index.js only); upgrade producer to emit integrityCovers';
    }
  } else {
    integrity.note = 'no integrity hash in meta';
  }

  return { meta, packageJson, files, integrity };
}

// SHA-256 of: sorted filename\0bytes\0... concatenation. Matches carotte's
// CLAUDE.md §1.1 recommendation + EXTENSION_SPEC §6.1's revised scope.
async function _computeIntegrity(coverList, files) {
  const sorted = [...coverList].sort();
  const chunks = [];
  let totalLen = 0;
  for (const name of sorted) {
    if (!files[name]) throw new Error(`integrity: file missing from archive: ${name}`);
    const nameBytes = _ENCODER.encode(name);
    chunks.push(nameBytes, _NUL, files[name], _NUL);
    totalLen += nameBytes.length + 1 + files[name].length + 1;
  }
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return _toSriSha256(await crypto.subtle.digest('SHA-256', merged));
}

// Legacy compatibility: SHA-256 of index.js bytes alone, no framing.
async function _computeLegacyIntegrity(indexBytes) {
  return _toSriSha256(await crypto.subtle.digest('SHA-256', indexBytes));
}

const _NUL = new Uint8Array([0]);

function _toSriSha256(hashBuffer) {
  const u8 = new Uint8Array(hashBuffer);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return 'sha256-' + btoa(bin);
}

// ── Install phase ────────────────────────────────────────────────────────

export async function installGcupkg(parsed, opts = {}) {
  const { meta, packageJson, files, integrity } = parsed;
  if (!opts.vfs) throw new Error('installGcupkg: opts.vfs is required');
  const { vfs, installedModules, strictIntegrity } = opts;

  // Refuse to install if integrity is declared but doesn't verify, when
  // the caller asks for strict mode. Default is permissive (warn-only via
  // the returned integrity record) so users can still install partially-
  // broken packages if they choose.
  if (strictIntegrity && integrity.ok === false) {
    throw new Error(
      `installGcupkg: integrity mismatch — meta declared ${integrity.declared}, ` +
      `computed ${integrity.computed} over [${integrity.covered.join(', ')}]`
    );
  }

  const libPath = _libPathForName(meta.name);
  await vfs.mkdir(libPath, { recursive: true });

  // Canonical artifact: `source` (matches pkg's existing /lib layout).
  await vfs.writeFile(libPath + '/source', files['index.js']);

  // Optional secondary entry — adder.js. Stored under the same dir; the
  // load() resolution for `@gcu/<name>/adder` finds it via _installedModules.
  if (files['adder.js']) {
    await vfs.writeFile(libPath + '/adder.js', files['adder.js']);
  }

  // Other extension data alongside (consumed by aggregateLicenses walkLib
  // for license, by future tooling for the rest).
  await vfs.writeFile(libPath + '/package.json', files['package.json']);
  await vfs.writeFile(libPath + '/LICENSE', files['LICENSE']);
  if (files['README.md']) await vfs.writeFile(libPath + '/README.md', files['README.md']);
  if (files['SPEC.md'])   await vfs.writeFile(libPath + '/SPEC.md',   files['SPEC.md']);

  // pkg's per-entry meta + lockfile entry. Match the shape pkg-cmd.js writes
  // so `pkg list` and `pkg licenses` pick the entry up uniformly.
  const pkgMeta = {
    alias:       meta.name,
    url:         meta.homepage || meta.name,
    kind:        'gcupkg',
    installedAt: new Date().toISOString(),
    size:        files['index.js'].length,
    version:     meta.version,
    license: {
      spdx:        meta.spdx || packageJson.license || null,
      spdxSource:  'gcupkg-meta',
      fetchedFrom: 'gcupkg',
    },
    gcupkg: {
      version:      meta.gcupkgVersion,
      contributes:  meta.contributes || [],
      integrity:    meta.integrity || null,
      integrityOk:  integrity.ok,
      hasAdder:     !!files['adder.js'],
    },
  };
  await vfs.writeFile(libPath + '/meta.json', _ENCODER.encode(JSON.stringify(pkgMeta, null, 2)));
  await _updateLockfile(vfs, meta.name, pkgMeta);

  // Examples → /usr/share/examples/<safe-name>/  (§6.3).
  const slug = _slugifyName(meta.name);
  let exampleCount = 0;
  const exampleRoot = '/usr/share/examples/' + slug;
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('examples/') || path === 'examples/') continue;
    const inner = path.slice('examples/'.length);
    if (!inner) continue;
    await vfs.mkdir(exampleRoot, { recursive: true });
    await vfs.writeFile(exampleRoot + '/' + inner, bytes);
    if (inner.endsWith('.txt')) exampleCount++;
  }

  // Docs → /usr/share/docs/<safe-name>/  (§6.2).
  let docsCount = 0;
  const docsRoot = '/usr/share/docs/' + slug;
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('docs/') || path === 'docs/') continue;
    const inner = path.slice('docs/'.length);
    if (!inner) continue;
    await vfs.mkdir(docsRoot, { recursive: true });
    await vfs.writeFile(docsRoot + '/' + inner, bytes);
    if (inner.endsWith('.md')) docsCount++;
  }

  // Hydrate the runtime module cache so load() resolves immediately
  // — without this, the user has to reload the notebook for the install
  // to take effect.
  if (installedModules) {
    const indexSource = _DECODER.decode(files['index.js']);
    installedModules[meta.name] = {
      url:         meta.name,
      alias:       meta.name,
      source:      indexSource,
      compressed:  false,
      kind:        'js',
      installedAt: pkgMeta.installedAt,
      size:        files['index.js'].length,
      license:     pkgMeta.license,
    };
    if (files['adder.js']) {
      const adderSource = _DECODER.decode(files['adder.js']);
      const adderKey = meta.name + '/adder';
      installedModules[adderKey] = {
        url:         adderKey,
        alias:       adderKey,
        source:      adderSource,
        compressed:  false,
        kind:        'js',
        installedAt: pkgMeta.installedAt,
        size:        files['adder.js'].length,
      };
    }
  }

  return {
    libPath,
    exampleRoot:   exampleCount > 0 ? exampleRoot : null,
    docsRoot:      docsCount > 0    ? docsRoot    : null,
    exampleCount,
    docsCount,
    hasAdder:      !!files['adder.js'],
    integrity,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

// Map an extension name to its /lib path. Scoped names land at
// /lib/<scope>/<name> (matches pkg-cmd's existing convention); bare
// names go under /lib/local/.
function _libPathForName(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

// Slugify the extension name for VFS paths that can't have a `/` in them
// (the examples and docs roots). @gcu/foo → @gcu_foo.
function _slugifyName(name) {
  return name.replace(/\//g, '_');
}

async function _updateLockfile(vfs, name, pkgMeta) {
  const lockPath = '/lib/.gcu-lock.json';
  let lockfile;
  try {
    const raw = await vfs.readFile(lockPath, 'utf8');
    lockfile = JSON.parse(raw);
  } catch {
    lockfile = { version: 1, modules: {} };
  }
  if (!lockfile.modules || typeof lockfile.modules !== 'object') lockfile.modules = {};
  lockfile.modules[name] = pkgMeta;
  await vfs.writeFile(lockPath, JSON.stringify(lockfile, null, 2));
}
