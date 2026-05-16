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

    const resolved = LEGACY_ALIASES[url] || url;

    // @atra/<name> — atra library distributions from Pages origin
    if (resolved.startsWith('@atra/')) {
      const name = resolved.slice(6);
      const realUrl = __AUDITABLE_PAGES_URL__ + '/ext/atra/lib/' + name + '.js';
      const resp = await fetch(realUrl);
      if (!resp.ok) throw new Error(`Failed to fetch ${realUrl}: ${resp.status}`);
      const source = await resp.text();
      const compressedSrc = await compressText(source);
      window._installedModules[storeKey] = { source: compressedSrc, compressed: true, cellId: cell.id };
      notifyDirty();
      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[storeKey] = mod;
      display(`installed ${storeKey} (${(source.length / 1024).toFixed(1)} KB → ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
      return mod;
    }

    // @scope/name → esm.sh, with /bundled preferred for @gcu/*
    const isScoped = /^@[\w.-]+\/[\w.-]+$/.test(resolved);
    let esmUrl = resolved;
    let esmFallbackUrl = null;
    if (isScoped) {
      if (resolved.startsWith('@gcu/')) {
        esmUrl = 'https://esm.sh/' + resolved + '/bundled';
        esmFallbackUrl = 'https://esm.sh/' + resolved;
      } else {
        esmUrl = 'https://esm.sh/' + resolved;
      }
    } else if (esmUrl.includes('esm.sh') && !esmUrl.includes('?bundle') && !esmUrl.includes('&bundle')) {
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
    const compressedSrc = await compressText(source);
    window._installedModules[storeKey] = { source: compressedSrc, compressed: true, cellId: cell.id };
    notifyDirty();
    // Use the shared materialiser so scoped imports get rewritten.
    const blobUrl = await _materializeInstalled(storeKey);
    const mod = await import(blobUrl);
    window._importCache[storeKey] = mod;
    display(`installed ${storeKey} (${(source.length / 1024).toFixed(1)} KB → ${(compressedSrc.length * 3 / 4 / 1024).toFixed(1)} KB gzipped)`);
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
    window._installedModules[url] = { source: stored, cellId: cell.id, binary: true, compressed: isCompressed, type: contentType };
    notifyDirty();
    const ratio = isCompressed ? ` → ${(stored.length / 1024).toFixed(1)} KB compressed` : '';
    display(`installed binary ${url} (${(buf.byteLength / 1024).toFixed(1)} KB${ratio})`);
    return URL.createObjectURL(new Blob([raw], { type: contentType }));
  };

  return { load, install, installBinary };
}
