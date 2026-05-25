// Module loading: load() / install() / installBinary() builtins, plus
// shared helpers (decodeModuleEntry, decodeBinary, resolveModulePaths).
//
// `_installedModules[url]` storage shape variants:
//   - `string`                                          (legacy raw source)
//   - `{ source: string }`                              (legacy uncompressed)
//   - `{ source: string, compressed: true }`            (gzipped JS source, base64)
//   - `{ source: string, binary: true, compressed?, type? }` (binary asset)
//
// decodeModuleEntry normalises across these — used here and by globals.js,
// init.js, save.js, settings.js (legacy decode duplication eliminated).

import { compressText, decompressText, uint8ToBase64 } from './text-compression.js';
import { fetchLicense, parseUrlToSource, classify } from '#licenses';
import { parseGcupkg, installGcupkg, makeUnzipArchiveShim } from '../gcupkg.js';
import { unzipArchive } from '../stdlib-core.js';

// SRI-shaped integrity hash. Computed over the un-compressed source bytes
// (matches what a browser would do for a <script integrity="..."> tag).
// pkg-spec §4.1 — fetch + verify before extraction.
async function _sha256SRI(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256-' + uint8ToBase64(new Uint8Array(buf));
}

// Read the strict-mode flag. Lives on window._auditableLicensesStrict;
// settings.js owns the UI toggle that flips it. Default off.
function _licensesStrict() {
  return !!(typeof window !== 'undefined' && window._auditableLicensesStrict);
}

// licenses-spec §5: classify result → policy decision.
// Returns { allow: bool, level: 'permissive'|'weak-copyleft'|'strong-copyleft'|'unknown', message: string }.
function _licensePolicy(classification, pkgLabel, strict) {
  const level = classification || 'unknown';
  let message = null;
  if (level === 'weak-copyleft')   message = `${pkgLabel}: weak-copyleft license — file/library-level reciprocity applies`;
  if (level === 'strong-copyleft') message = `${pkgLabel}: STRONG-COPYLEFT (GPL-family) — viral terms; redistribution constraints apply`;
  if (level === 'unknown')         message = `${pkgLabel}: no recognised SPDX license — review before redistributing`;
  return {
    allow: !(strict && level !== 'permissive'),
    level, message,
  };
}

// Fetch + apply license policy for an install. Mutates the entry to add
// `license` and `licenseText`. On strict-mode block, throws BEFORE the entry
// is committed (caller is expected to call this between fetching source and
// writing to _installedModules). On any non-strict path, returns silently
// (the caller surfaces the warning via display()).
async function _captureLicense(url, entry, pkgLabel, displayFn) {
  let lic = null;
  try { lic = await fetchLicense(url); } catch { lic = null; }
  const spdx = (lic && typeof lic.spdx === 'string') ? lic.spdx : 'UNKNOWN';
  const classification = classify(spdx);
  const policy = _licensePolicy(classification, pkgLabel, _licensesStrict());

  if (!policy.allow) {
    throw new Error(
      `License policy refused (strict mode): ${pkgLabel} is ${classification} (${spdx}). ` +
      `Disable strict mode in Settings → Licenses, or remove this install().`
    );
  }
  if (policy.message && displayFn) {
    displayFn(`⚠ ${policy.message}`);
  }

  if (lic) {
    entry.license = {
      spdx,
      copyright: lic.copyright || null,
      fetchedFrom: lic.fetchedFrom || null,
      spdxSource: lic.spdxSource || null,
      textSource: lic.textSource || null,
      fetchedAt: lic.fetchedAt || new Date().toISOString(),
      classification,
      confidence: lic.confidence || 'low',
    };
    if (typeof lic.text === 'string' && lic.text.length > 0) {
      // Compress the LICENSE text alongside the source. Same gzip+base64
      // encoding so a single decoder shape (decompressText) handles both.
      try { entry.licenseText = await compressText(lic.text); entry.licenseTextCompressed = true; }
      catch { entry.licenseText = lic.text; entry.licenseTextCompressed = false; }
    }
  } else {
    entry.license = { spdx: 'UNKNOWN', classification: 'unknown', fetchedAt: new Date().toISOString(), spdxSource: 'fetch-failed' };
  }
  return entry;
}

/**
 * Decode an _installedModules[url] entry into runtime form. Returns:
 *   - { kind: 'text', source: string }                          for JS modules
 *   - { kind: 'binary', bytes: Uint8Array, mimeType: string }   for binary assets
 *
 * Async because compressed entries need a streaming decompress.
 */
export async function decodeModuleEntry(entry) {
  if (typeof entry === 'string') return { kind: 'text', source: entry };
  if (!entry || typeof entry !== 'object') return null;

  if (entry.binary) {
    const bytes = Uint8Array.from(atob(entry.source), c => c.charCodeAt(0));
    const mimeType = entry.type || 'application/octet-stream';
    if (entry.compressed) {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      return { kind: 'binary', bytes: decompressed, mimeType };
    }
    return { kind: 'binary', bytes, mimeType };
  }

  // text module
  if (entry.compressed) {
    const source = await decompressText(entry.source);
    return { kind: 'text', source };
  }
  return { kind: 'text', source: entry.source };
}

export async function decodeBinary(entry) {
  const decoded = await decodeModuleEntry(entry);
  if (!decoded || decoded.kind !== 'binary') return null;
  return URL.createObjectURL(new Blob([decoded.bytes], { type: decoded.mimeType }));
}

// Rewrite root-relative imports/exports in module source so blob URLs
// dispatched from a cross-origin module still resolve correctly.
export function resolveModulePaths(source, responseUrl) {
  const origin = new URL(responseUrl).origin;
  return source.replace(/(from\s*["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3')
               .replace(/(import\s+["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3')
               .replace(/(import\s*\(\s*["'])(\/[^"']+)(["']\s*\))/g, '$1' + origin + '$2$3')
               .replace(/(export\s+\*\s+from\s*["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3')
               .replace(/(export\s*\{[^}]*\}\s*from\s*["'])(\/[^"']+)(["'])/g, '$1' + origin + '$2$3');
}

// Legacy single-segment aliases that predate the @gcu/* scope.
const LEGACY_ALIASES = {
  '@sheet':    '@gcu/sheet',
  '@calque':   '@gcu/calque',
  '@spinifex': '@gcu/spinifex',
  '@plan':     '@gcu/plan',
};

// pkg-spec §3.3: alias prefixes that rewrite to URLs at install time. The
// alias remains the user-facing key (stored in _installedModules and the
// lockfile); the URL is what fetch resolves. Returns { url, fallback? } or
// null for keys that aren't aliases.
//
// NOTE: @gcu/* still routes through esm.sh today; the spec calls for
// gentropic.org/lib/<name>.js once that's hosting. Migration is a
// one-line change here when the origin is live.
function _aliasToUrl(key) {
  if (key.startsWith('npm:')) {
    return { url: 'https://esm.sh/' + key.slice(4) };
  }
  if (key.startsWith('jsr:')) {
    return { url: 'https://esm.sh/jsr/' + key.slice(4) };
  }
  if (key.startsWith('gh:')) {
    return { url: 'https://esm.sh/gh/' + key.slice(3) };
  }
  // @gcu/* — bundled-first (deps inlined), fallback to plain.
  if (key.startsWith('@gcu/')) {
    return { url: 'https://esm.sh/' + key + '/bundled',
             fallback: 'https://esm.sh/' + key };
  }
  // Other @scope/name — esm.sh passthrough.
  if (/^@[\w.-]+\/[\w.-]+$/.test(key)) {
    return { url: 'https://esm.sh/' + key };
  }
  return null;
}

// Find every `@scope/pkg` bare specifier referenced by a module source's
// static or dynamic imports. Used to pre-load and rewrite cross-package
// deps before a blob-URL-hosted module tries to resolve them itself.
function _findScopedSpecifiers(source) {
  const re = /(?:from|import)\s*\(?\s*["'](@[\w.-]+\/[\w.-]+)["']/g;
  const specs = new Set();
  let m;
  while ((m = re.exec(source)) !== null) specs.add(m[1]);
  return specs;
}

// Rewrite every occurrence of `bareSpec` in import/from positions to the
// supplied URL. Used after a dependency has been materialised so the
// rewritten source can be wrapped in a blob URL and resolve correctly.
function _rewriteSpecifier(source, bareSpec, replacementUrl) {
  const esc = bareSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`(["'])${esc}(["'])`, 'g'),
                        '$1' + replacementUrl + '$2');
}

export function makeModuleLoaders(cell, ctx, deps) {
  const { display } = ctx;
  const { std, python, zenOfPython, fsRead, refreshTaggedLanguages, notifyDirty } = deps;

  if (!window._importCache) window._importCache = {};
  if (!window._installedModules) window._installedModules = {};
  // _moduleBlobUrls: url → stable blob (or absolute dev) URL used when
  // rewriting other modules' scoped imports. Stable means: same URL is
  // reused on re-load so the JS module map deduplicates the import.
  if (!window._moduleBlobUrls) window._moduleBlobUrls = {};
  // _importPromises: url → in-flight import Promise. Concurrent load()
  // calls for the same URL share the same Promise so the module body
  // only runs once. Necessary because some registrations (e.g. cell
  // types) trigger `_ctActivatePendingCells → runAll` synchronously,
  // re-entering load() before the outer `await import()` has populated
  // `_importCache[url]`.
  if (!window._importPromises) window._importPromises = {};

  // Materialise an installed-module entry into a blob URL whose source
  // has all `@scope/pkg` bare specifiers rewritten to stable per-spec
  // URLs (blob or absolute). Blob URLs aren't hierarchical, so a bundle
  // like @gcu/learn that imports @gcu/line cannot resolve that bare
  // specifier on its own — the resolution has to happen ahead of time
  // by recursively load()-ing each dep and rewriting the source.
  //
  // Idempotent — re-materialising the same URL returns the cached blob.
  async function _materializeInstalled(url) {
    if (window._moduleBlobUrls[url]) return window._moduleBlobUrls[url];
    const entry = window._installedModules[url];
    if (!entry || entry.binary) return null;

    const decoded = await decodeModuleEntry(entry);
    let src = decoded.source;
    try { src = resolveModulePaths(src, url); } catch {}

    // Pre-resolve scoped imports — each spec triggers a recursive
    // load() which handles dev/installed/CDN paths uniformly and
    // populates _moduleBlobUrls[spec] with the stable URL we rewrite to.
    for (const spec of _findScopedSpecifiers(src)) {
      if (spec === url) continue;
      try { await load(spec); } catch { continue; }
      const depUrl = window._moduleBlobUrls[spec];
      if (depUrl) src = _rewriteSpecifier(src, spec, depUrl);
    }

    const blob = new Blob([src], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    window._moduleBlobUrls[url] = blobUrl;
    return blobUrl;
  }

  const load = async (url) => {
    // virtual modules
    if (url === '@std') return std;
    if (url === '@python') return python;
    if (url === '@python/this') { display(zenOfPython()); return python; }

    // fs: scheme — load from notebook filesystem
    if (url.startsWith('fs:')) {
      const fsPath = url.slice(3);
      if (!window._importCache[url]) {
        const source = await fsRead(fsPath, 'text');
        const blob = new Blob([source], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        window._importCache[url] = await import(blobUrl);
      }
      return window._importCache[url];
    }

    // local: scheme — dev iteration. Reads the VFS every call (no
    // _importCache hit), so editing /scratch/mymod.js + re-running a cell
    // picks up the new bytes immediately. pkg-spec §3.4.
    if (url.startsWith('local:')) {
      const fsPath = url.slice('local:'.length);
      const vfs = window._notebookVFS;
      if (!vfs) throw new Error(`load(${url}): no VFS to read from`);
      const source = await vfs.readFile(fsPath, 'utf8');
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try { return await import(blobUrl); }
      finally { URL.revokeObjectURL(blobUrl); }
    }

    // @atra/<name> — dev-mode fallback to atra library binary distributions
    if (url.startsWith('@atra/')) {
      if (!window._importCache[url] && !window._installedModules[url]) {
        const name = url.slice(6);
        const mod = await import('./ext/atra/lib/' + name + '.js');
        window._importCache[url] = mod;
        return mod;
      }
    }

    // Legacy alias + @scope/name dev-mode fallback. Record the resolved
    // absolute URL in _moduleBlobUrls so other modules' scoped imports
    // can rewrite to it instead of failing on a relative path from a
    // blob URL host.
    const resolved = LEGACY_ALIASES[url] || url;
    const scopedMatch = /^@[\w.-]+\/([\w.-]+)$/.exec(resolved);
    if (scopedMatch && !resolved.startsWith('@atra/')
        && !window._importCache[url] && !window._installedModules[url]) {
      try {
        const devUrl = new URL('./ext/' + scopedMatch[1] + '/index.js', document.baseURI).href;
        const mod = await import(devUrl);
        window._importCache[url] = mod;
        window._moduleBlobUrls[url] = devUrl;
        return mod;
      } catch {
        // dev path not available; fall through
      }
    }

    if (window._importCache[url]) return window._importCache[url];
    // In-flight: another caller is already importing — share the promise
    // so the module body only runs once.
    if (window._importPromises[url]) return await window._importPromises[url];

    // binary assets — return blob URL
    if (window._installedModules[url]?.binary) {
      const blobUrl = await decodeBinary(window._installedModules[url]);
      window._importCache[url] = blobUrl;
      return blobUrl;
    }

    const langsBefore = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;

    const loadPromise = (async () => {
      let mod;
      if (window._installedModules[url]) {
        const blobUrl = await _materializeInstalled(url);
        mod = await import(blobUrl);
      } else {
        mod = await import(url);
      }
      window._importCache[url] = mod;
      return mod;
    })();
    window._importPromises[url] = loadPromise;
    let mod;
    try { mod = await loadPromise; }
    finally { delete window._importPromises[url]; }

    const langsAfter = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;
    if (langsAfter > langsBefore) refreshTaggedLanguages();

    return mod;
  };

  // .gcupkg sideload (EXTENSION_SPEC §6.1). Reads bytes from the source,
  // parses via stdlib's unzipArchive shim (zero new deps), runs the standard
  // installGcupkg, populates _installedModules so subsequent load() calls
  // resolve. Returns the freshly-imported engine module so the cell's
  // `const carotte = await install("...gcupkg")` pattern works directly.
  async function _installFromGcupkg(url) {
    const bytes = await _readGcupkgBytes(url);
    const parsed = await parseGcupkg(bytes, makeUnzipArchiveShim(unzipArchive));
    const vfs = window._notebookVFS;
    const result = await installGcupkg(parsed, {
      vfs: vfs || _makeMemoryVfsShim(),
      installedModules: window._installedModules,
    });
    notifyDirty();

    const versionTag = parsed.meta.version ? '@' + parsed.meta.version : '';
    const verdict = parsed.integrity.ok === false
      ? ' (⚠ integrity mismatch — see browser console)'
      : (parsed.integrity.ok === true ? ' ✓' : '');
    display(`installed ${parsed.meta.name}${versionTag}${verdict}`
      + (result.exampleCount > 0 ? ` · ${result.exampleCount} example${result.exampleCount === 1 ? '' : 's'}` : '')
      + (result.hasAdder ? ` · adder bridge` : ''));
    if (parsed.integrity.ok === false) {
      console.warn('[install] gcupkg integrity mismatch:', parsed.integrity);
    }

    // Materialise the engine immediately so the caller gets the live module,
    // mirroring the regular install() return contract.
    const engineKey = parsed.meta.name;
    const blobUrl = await _materializeInstalled(engineKey);
    const mod = await import(blobUrl);
    window._importCache[engineKey] = mod;
    return mod;
  }

  async function _readGcupkgBytes(url) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`install(${url}): fetch failed (${resp.status})`);
      return new Uint8Array(await resp.arrayBuffer());
    }
    // VFS-backed sources. fs:/<path> targets the notebook FS prefix;
    // local:/<path> and bare paths read directly from the workspace VFS.
    let vfsPath;
    if (url.startsWith('fs:'))     vfsPath = '/projects/self/' + url.slice('fs:'.length).replace(/^\/+/, '');
    else if (url.startsWith('local:')) vfsPath = url.slice('local:'.length);
    else                           vfsPath = url;  // absolute or relative VFS path
    const vfs = window._notebookVFS;
    if (!vfs) throw new Error(`install(${url}): no VFS to read from`);
    let bytes = await vfs.readFile(vfsPath, 'bytes');
    if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    return bytes;
  }

  // Fallback VFS for the no-workspace case (standalone notebook with no
  // _notebookVFS bound). installGcupkg writes to /lib/<name>/ etc.; without
  // a real VFS we just materialise everything in-memory and let the runtime
  // module cache hold the engine. The /lib + /usr/share writes become
  // no-ops — fine, the install survives via _installedModules.
  function _makeMemoryVfsShim() {
    const files = new Map();
    return {
      async readFile(p, enc) {
        if (!files.has(p)) throw new Error('ENOENT ' + p);
        const b = files.get(p);
        return enc === 'utf8' ? new TextDecoder().decode(b) : b;
      },
      async writeFile(p, c) {
        const bytes = c instanceof Uint8Array ? c
          : typeof c === 'string' ? new TextEncoder().encode(c)
          : new Uint8Array(c);
        files.set(p, bytes);
      },
      async mkdir() {},
      async rm() {},
    };
  }

  const install = async (url) => {
    const storeKey = url;
    if (window._importCache[storeKey]) return window._importCache[storeKey];
    if (window._importPromises[storeKey]) return await window._importPromises[storeKey];

    const existing = window._installedModules[storeKey];
    if (existing && !existing.binary) {
      // Use the shared materialiser so scoped imports get rewritten.
      const blobUrl = await _materializeInstalled(storeKey);
      const mod = await import(blobUrl);
      window._importCache[storeKey] = mod;
      const decoded = await decodeModuleEntry(existing);
      display(`loaded ${storeKey} from cache (${(decoded.source.length / 1024).toFixed(1)} KB)`);
      return mod;
    }

    // .gcupkg sideload — extension package per EXTENSION_SPEC §6.1.
    // Bytes come from (in priority order): http(s) URL, fs:/<vfs-path>,
    // local:/<vfs-path>, or a relative/absolute VFS path. The shim
    // bridges parseGcupkg to stdlib's unzipArchive — zero new vendor
    // deps; native DecompressionStream does the deflate.
    if (url.endsWith('.gcupkg') || url.includes('.gcupkg?')) {
      const mod = await _installFromGcupkg(url);
      return mod;
    }

    // local: — read straight from the surface VFS, store with kind:'local'
    // and no integrity. pkg-spec §3.4.
    if (url.startsWith('local:')) {
      const fsPath = url.slice('local:'.length);
      const vfs = window._notebookVFS;
      if (!vfs) throw new Error(`install(${url}): no VFS to read from`);
      const source = await vfs.readFile(fsPath, 'utf8');
      const compressedSrc = await compressText(source);
      window._installedModules[storeKey] = {
        source: compressedSrc, compressed: true, cellId: cell.id,
        alias: storeKey, url: storeKey, kind: 'local',
        installedAt: new Date().toISOString(),
        size: source.length,
      };
      notifyDirty();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[storeKey] = mod;
      display(`installed ${storeKey} from VFS (${(source.length / 1024).toFixed(1)} KB)`);
      return mod;
    }

    const resolved = LEGACY_ALIASES[url] || url;

    // @atra/<name> — atra library distributions from Pages origin
    if (resolved.startsWith('@atra/')) {
      const name = resolved.slice(6);
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/atra/lib/' + name + '.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const sourceBytes = new TextEncoder().encode(source);
      const integrity = await _sha256SRI(sourceBytes);
      const compressedSrc = await compressText(source);
      window._installedModules[storeKey] = {
        source: compressedSrc, compressed: true, cellId: cell.id,
        alias: storeKey, url: resp.url, integrity, kind: 'js',
        installedAt: new Date().toISOString(),
        size: sourceBytes.length,
      };
      notifyDirty();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[storeKey] = mod;
      display(`installed ${storeKey} (${(source.length / 1024).toFixed(1)} KB → ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }

    // pkg-spec §3.3 alias prefixes: npm:/jsr:/gh:/@gcu/*/@scope/name → URL.
    // _aliasToUrl returns null for non-alias inputs (bare URLs).
    const alias = _aliasToUrl(resolved);
    let esmUrl = alias ? alias.url : resolved;
    let esmFallbackUrl = alias ? (alias.fallback || null) : null;
    if (!alias && esmUrl.includes('esm.sh') && !esmUrl.includes('?bundle') && !esmUrl.includes('&bundle')) {
      esmUrl += (esmUrl.includes('?') ? '&' : '?') + 'bundle';
    }

    // esm.sh wrapper unwrap (bounded to 3 hops)
    const wrapperRe = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?export\s+\*\s+from\s*["']([^"']+)["'];?\s*$/;
    const fetchAndUnwrap = async (startUrl) => {
      let currentUrl = startUrl;
      for (let hop = 0; hop < 3; hop++) {
        const resp = await fetch(currentUrl);
        if (!resp.ok) {
          if (hop === 0) return { ok: false, status: resp.status };
          throw new Error(`Failed to fetch ${currentUrl}: ${resp.status}`);
        }
        const text = await resp.text();
        const m = text.trim().match(wrapperRe);
        if (m) { currentUrl = new URL(m[1], resp.url).href; continue; }
        return { ok: true, source: text, finalUrl: resp.url };
      }
      throw new Error('Too many esm.sh wrapper redirects');
    };

    let result = await fetchAndUnwrap(esmUrl);
    if (!result.ok && esmFallbackUrl) result = await fetchAndUnwrap(esmFallbackUrl);
    if (!result.ok) throw new Error(`Failed to fetch ${esmUrl}: ${result.status}`);

    let source = resolveModulePaths(result.source, result.finalUrl);
    // pkg-spec §4.1: integrity is computed over the FINAL response body
    // (post-redirect, post-path-rewrite), and the resolved URL is what
    // lands in the lockfile entry. Reproducibility pins both.
    const sourceBytes = new TextEncoder().encode(source);
    const integrity = await _sha256SRI(sourceBytes);
    const compressedSrc = await compressText(source);

    // Build the entry first; license capture is allowed to throw under
    // strict mode before we commit to _installedModules / blob materialise.
    const entry = {
      source: compressedSrc, compressed: true, cellId: cell.id,
      alias: storeKey, url: result.finalUrl, integrity, kind: 'js',
      installedAt: new Date().toISOString(),
      size: sourceBytes.length,
    };
    // For license capture, use the PRE-REDIRECT URL (the alias-resolved
    // clean form) — post-redirect URLs land deep inside esm.sh's versioned
    // paths (e.g. /v135/.../X-hash/lodash.js) where parseUrlToSource can't
    // recover the bare pkg@ver shape. The pre-redirect form is what the
    // package.json + LICENSE probe endpoints are anchored at.
    const licenseUrl = esmUrl.replace(/[?&]bundle\b[^&]*/, '').replace(/[?&]$/, '');
    await _captureLicense(licenseUrl, entry, storeKey, display);
    window._installedModules[storeKey] = entry;
    notifyDirty();
    // Use the shared materialiser so scoped imports get rewritten.
    const blobUrl = await _materializeInstalled(storeKey);
    const mod = await import(blobUrl);
    window._importCache[storeKey] = mod;
    const spdxLabel = entry.license?.spdx && entry.license.spdx !== 'UNKNOWN'
      ? ` [${entry.license.spdx}]` : '';
    display(`installed ${storeKey}${spdxLabel} (${(source.length / 1024).toFixed(1)} KB → ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
    return mod;
  };

  const installBinary = async (url, opts = {}) => {
    const compress = opts.compress !== false;
    if (window._installedModules[url]?.binary) return decodeBinary(window._installedModules[url]);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    const contentType = resp.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    const buf = await resp.arrayBuffer();
    const raw = new Uint8Array(buf);
    let stored, isCompressed = false;
    if (compress) {
      const cs = new CompressionStream('gzip');
      const stream = new Blob([raw]).stream().pipeThrough(cs);
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      stored = uint8ToBase64(compressed);
      isCompressed = true;
    } else {
      stored = uint8ToBase64(raw);
    }
    const integrity = await _sha256SRI(raw);
    window._installedModules[url] = {
      source: stored, cellId: cell.id, binary: true, compressed: isCompressed, type: contentType,
      alias: url, url: resp.url, integrity, kind: 'binary',
      installedAt: new Date().toISOString(),
      size: raw.length,
    };
    notifyDirty();
    const ratio = isCompressed ? ` → ${(stored.length / 1024).toFixed(1)} KB compressed` : '';
    display(`installed binary ${url} (${(buf.byteLength / 1024).toFixed(1)} KB${ratio})`);
    return URL.createObjectURL(new Blob([raw], { type: contentType }));
  };

  return { load, install, installBinary };
}
