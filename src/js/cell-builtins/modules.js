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

export function makeModuleLoaders(cell, ctx, deps) {
  const { display } = ctx;
  const { std, python, zenOfPython, fsRead, refreshTaggedLanguages, notifyDirty } = deps;

  if (!window._importCache) window._importCache = {};
  if (!window._installedModules) window._installedModules = {};

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

    // Legacy alias + @scope/name dev-mode fallback
    const resolved = LEGACY_ALIASES[url] || url;
    const scopedMatch = /^@[\w.-]+\/([\w.-]+)$/.exec(resolved);
    if (scopedMatch && !resolved.startsWith('@atra/')
        && !window._importCache[url] && !window._installedModules[url]) {
      try {
        const mod = await import('./ext/' + scopedMatch[1] + '/index.js');
        window._importCache[url] = mod;
        return mod;
      } catch {
        // dev path not available; fall through
      }
    }

    if (window._importCache[url]) return window._importCache[url];

    // binary assets — return blob URL
    if (window._installedModules[url]?.binary) {
      const blobUrl = await decodeBinary(window._installedModules[url]);
      window._importCache[url] = blobUrl;
      return blobUrl;
    }

    const langsBefore = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;

    let mod;
    if (window._installedModules[url]) {
      const decoded = await decodeModuleEntry(window._installedModules[url]);
      let src = decoded.source;
      try { src = resolveModulePaths(src, url); } catch {}
      const blob = new Blob([src], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      mod = await import(blobUrl);
    } else {
      mod = await import(url);
    }
    window._importCache[url] = mod;

    const langsAfter = window._taggedLanguages ? Object.keys(window._taggedLanguages).length : 0;
    if (langsAfter > langsBefore) refreshTaggedLanguages();

    return mod;
  };

  const install = async (url) => {
    const storeKey = url;
    if (window._importCache[storeKey]) return window._importCache[storeKey];

    const existing = window._installedModules[storeKey];
    if (existing && !existing.binary) {
      const decoded = await decodeModuleEntry(existing);
      const src = decoded.source;
      const blob = new Blob([src], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      const mod = await import(blobUrl);
      window._importCache[storeKey] = mod;
      display(`loaded ${storeKey} from cache (${(src.length / 1024).toFixed(1)} KB)`);
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
    const blob = new Blob([source], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
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
