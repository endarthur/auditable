// fetchLicense — fetch + interpret SPDX + LICENSE info for a remote module.
//
// parseUrlToSource(url) → { source, pkg, version, origin } normalizes a
// remote URL into a registry descriptor; fetchLicense(desc) then dispatches
// to the appropriate per-registry handler.
//
// Per-registry handlers (esm.sh, jsdelivr, unpkg, github, jsr, generic url)
// each do up to ~3 small HTTP requests: typically package metadata +
// LICENSE-file probe. Failures degrade gracefully — the function never
// throws on registry quirks; it returns `{ spdx: 'UNKNOWN', spdxSource: ..., hint }`
// instead so the caller's install path stays unaffected.
//
// Network is injected via opts.fetch (defaults to globalThis.fetch). Tests
// pass a mock; production passes the real thing.

// ── parseUrlToSource ─────────────────────────────────────────────────────
//
// URL shapes handled:
//   https://esm.sh/<pkg>@<ver>[/<deep>][?<qs>]            → esm.sh
//   https://esm.sh/<pkg>                                   → esm.sh (no version)
//   https://esm.sh/@<scope>/<pkg>@<ver>                    → esm.sh (scoped)
//   https://cdn.jsdelivr.net/npm/<pkg>@<ver>[/<deep>]      → jsdelivr (npm)
//   https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>[...]  → github (via jsdelivr)
//   https://unpkg.com/<pkg>@<ver>[/<deep>]                 → unpkg
//   https://jsr.io/<pkg>@<ver>[/<deep>]                    → jsr (pkg is @scope/name)
//   https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<file>  → github
//   https://github.com/<owner>/<repo>/raw/<sha>/<file>             → github
//   anything else                                          → 'url' (generic)

const PKG_VERSION_RE = /^(?:(@[^/]+)\/)?([^@/]+)(?:@([^/?#]+))?(.*)$/;
//                      ^scope?           ^name    ^version       ^rest

function splitPkgVersion(slug) {
  // slug here is the path-after-prefix, no leading slash. Returns { pkg, version }
  // or null if not parseable. Handles scoped packages.
  const m = PKG_VERSION_RE.exec(slug);
  if (!m) return null;
  const scope = m[1] || '';
  const name = m[2];
  const version = m[3] || null;
  if (!name) return null;
  return { pkg: scope ? `${scope}/${name}` : name, version };
}

export function parseUrlToSource(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }

  // esm.sh
  if (u.hostname === 'esm.sh' || u.hostname.endsWith('.esm.sh')) {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'esm.sh', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // jsdelivr (two prefixes: /npm/ and /gh/)
  if (u.hostname === 'cdn.jsdelivr.net') {
    if (u.pathname.startsWith('/npm/')) {
      const slug = u.pathname.slice(5);
      const pv = splitPkgVersion(slug);
      if (!pv) return null;
      return { source: 'jsdelivr', pkg: pv.pkg, version: pv.version, origin: url };
    }
    if (u.pathname.startsWith('/gh/')) {
      // /gh/<owner>/<repo>@<ref>[/...]
      const slug = u.pathname.slice(4);
      const m = /^([^/]+)\/([^/@]+)(?:@([^/]+))?(?:\/|$)/.exec(slug);
      if (!m) return null;
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3] || null,
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] || null },
      };
    }
  }

  // unpkg
  if (u.hostname === 'unpkg.com') {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'unpkg', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // jsr
  if (u.hostname === 'jsr.io') {
    const slug = u.pathname.replace(/^\//, '');
    const pv = splitPkgVersion(slug);
    if (!pv) return null;
    return { source: 'jsr', pkg: pv.pkg, version: pv.version, origin: url };
  }

  // GitHub raw
  if (u.hostname === 'raw.githubusercontent.com') {
    const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3],
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] },
      };
    }
  }
  if (u.hostname === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      return {
        source: 'github',
        pkg: `${m[1]}/${m[2]}`,
        version: m[3],
        origin: url,
        github: { owner: m[1], repo: m[2], ref: m[3] },
      };
    }
  }

  // Generic fallback — use hostname+path as pkg name, no version.
  return {
    source: 'url',
    pkg: u.hostname + u.pathname.replace(/\/[^/]*$/, ''),
    version: null,
    origin: url,
  };
}

// ── License field interpretation ─────────────────────────────────────────

// package.json#license can be: string, { type, url }, or absent.
// Older packages used a `licenses` array of { type, url } objects.
function spdxFromPackageJson(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.license === 'string') return json.license;
  if (json.license && typeof json.license === 'object' && typeof json.license.type === 'string') {
    return json.license.type;
  }
  if (Array.isArray(json.licenses) && json.licenses.length > 0) {
    const types = json.licenses
      .map((l) => (l && typeof l === 'object' ? l.type : (typeof l === 'string' ? l : null)))
      .filter(Boolean);
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

// Extract a copyright notice line from LICENSE text. Best-effort, regex-y.
function extractCopyright(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (/^Copyright\b/i.test(t) || /^\(c\)\s/i.test(t) || /^©\s/.test(t)) {
      if (t.length > 4 && t.length < 400) return t;
    }
  }
  return null;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function tryFetchText(fetch, url) {
  try {
    const res = await fetch(url);
    if (!res || !res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function tryFetchJson(fetch, url) {
  const text = await tryFetchText(fetch, url);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Probe a base directory for a LICENSE-like file. Returns { text, filename, url }
// on first hit, or null. Order matches what most upstreams use.
const LICENSE_FILENAMES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'license', 'license.md', 'license.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt',
  'NOTICE',
];

async function probeLicense(fetch, baseUrl) {
  for (const name of LICENSE_FILENAMES) {
    const url = baseUrl.replace(/\/$/, '') + '/' + name;
    const text = await tryFetchText(fetch, url);
    if (text) return { text, filename: name, url };
  }
  return null;
}

// ── Per-registry fetchers ────────────────────────────────────────────────

const STAMP = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function unknownResult({ origin, hint, fetchedFrom = null }) {
  return {
    spdx: 'UNKNOWN',
    text: null,
    copyright: null,
    spdxSource: 'unknown',
    textSource: null,
    fetchedFrom: fetchedFrom || origin || null,
    fetchedAt: STAMP(),
    confidence: 'low',
    hint: hint || null,
  };
}

function buildResult({ spdx, text, filename, baseUrl, spdxSource, textSource, origin }) {
  return {
    spdx: spdx || 'UNKNOWN',
    text: text || null,
    copyright: text ? extractCopyright(text) : null,
    spdxSource: spdx ? spdxSource : (text ? 'inferred-from-license-file' : 'unknown'),
    textSource: text ? textSource : null,
    fetchedFrom: text && filename ? `${baseUrl.replace(/\/$/, '')}/${filename}` : (origin || null),
    fetchedAt: STAMP(),
    confidence: spdx ? 'high' : (text ? 'low' : 'low'),
    hint: null,
  };
}

async function fetchFromCdnBase(fetch, desc, baseUrl) {
  // Both esm.sh and jsdelivr/npm expose package.json at <base>/package.json
  // and LICENSE files at <base>/<name>. unpkg too.
  const pkgJson = await tryFetchJson(fetch, baseUrl.replace(/\/$/, '') + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const probe = await probeLicense(fetch, baseUrl);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no package.json and no LICENSE file at base url' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl,
    spdxSource: 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

async function fetchEsmSh(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://esm.sh/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchJsdelivr(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://cdn.jsdelivr.net/npm/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchUnpkg(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://unpkg.com/${desc.pkg}${verSlug}`;
  return fetchFromCdnBase(fetch, desc, base);
}

async function fetchJsr(fetch, desc) {
  if (!desc.pkg) return unknownResult({ origin: desc.origin, hint: 'no pkg in descriptor' });
  const verSlug = desc.version ? `@${desc.version}` : '';
  const base = `https://jsr.io/${desc.pkg}${verSlug}`;
  // jsr exposes jsr.json (not package.json) — try both, prefer jsr.json
  const jsrJson = await tryFetchJson(fetch, base + '/jsr.json');
  const pkgJson = jsrJson || await tryFetchJson(fetch, base + '/package.json');
  const spdx = pkgJson ? spdxFromPackageJson(pkgJson) : null;
  const probe = await probeLicense(fetch, base);
  if (!pkgJson && !probe) {
    return unknownResult({ origin: desc.origin, hint: 'no jsr.json/package.json and no LICENSE on jsr.io' });
  }
  return buildResult({
    spdx,
    text: probe ? probe.text : null,
    filename: probe ? probe.filename : null,
    baseUrl: base,
    spdxSource: jsrJson ? 'jsr.json' : 'package.json',
    textSource: probe ? 'LICENSE-file' : null,
    origin: desc.origin,
  });
}

// GitHub License API returns { license: { spdx_id, name }, content: <base64>,
// encoding: 'base64', download_url, ... }. Rate-limited (60/hr unauthenticated).
async function fetchGithub(fetch, desc) {
  const owner = desc.github && desc.github.owner;
  const repo  = desc.github && desc.github.repo;
  if (!owner || !repo) {
    // Fall back to parsing from desc.pkg = "owner/repo"
    const parts = (desc.pkg || '').split('/');
    if (parts.length !== 2) return unknownResult({ origin: desc.origin, hint: 'cannot parse github owner/repo' });
  }
  const o = owner || desc.pkg.split('/')[0];
  const r = repo  || desc.pkg.split('/')[1];

  const api = `https://api.github.com/repos/${o}/${r}/license`;
  const json = await tryFetchJson(fetch, api);
  if (!json) {
    // Rate-limit or 404 — try raw fallback at <ref>/LICENSE
    const ref = (desc.github && desc.github.ref) || desc.version || 'HEAD';
    const rawBase = `https://raw.githubusercontent.com/${o}/${r}/${ref}`;
    const probe = await probeLicense(fetch, rawBase);
    if (!probe) {
      return unknownResult({ origin: desc.origin, hint: 'github API unreachable and no LICENSE in raw' });
    }
    return buildResult({
      spdx: null,
      text: probe.text,
      filename: probe.filename,
      baseUrl: rawBase,
      spdxSource: null,
      textSource: 'LICENSE-file',
      origin: desc.origin,
    });
  }

  const spdx = json.license && typeof json.license.spdx_id === 'string'
    ? (json.license.spdx_id === 'NOASSERTION' ? null : json.license.spdx_id)
    : null;
  let text = null;
  if (typeof json.content === 'string' && json.encoding === 'base64') {
    try {
      // Node + browser both have atob in modern envs; Node 16+ has globalThis.atob.
      const cleaned = json.content.replace(/\s+/g, '');
      text = typeof atob === 'function'
        ? atob(cleaned)
        : Buffer.from(cleaned, 'base64').toString('utf8');
    } catch { text = null; }
  }

  return {
    spdx: spdx || 'UNKNOWN',
    text,
    copyright: text ? extractCopyright(text) : null,
    spdxSource: spdx ? 'github-api' : (text ? 'inferred-from-license-file' : 'unknown'),
    textSource: text ? 'github-api' : null,
    fetchedFrom: json.download_url || api,
    fetchedAt: STAMP(),
    confidence: spdx ? 'high' : 'low',
    hint: null,
  };
}

// Generic-URL: best-effort. If the URL is a JS file at <host>/<path>/<file>.js,
// try a sibling LICENSE at <host>/<path>/LICENSE. If the URL is a directory,
// try LICENSE at root. Nothing else.
async function fetchGenericUrl(fetch, desc) {
  let u;
  try { u = new URL(desc.origin); } catch { return unknownResult({ origin: desc.origin, hint: 'unparseable url' }); }
  const dir = u.origin + u.pathname.replace(/\/[^/]*$/, '');
  const probe = await probeLicense(fetch, dir);
  if (!probe) return unknownResult({ origin: desc.origin, hint: 'no LICENSE near url' });
  return buildResult({
    spdx: null,
    text: probe.text,
    filename: probe.filename,
    baseUrl: dir,
    spdxSource: null,
    textSource: 'LICENSE-file',
    origin: desc.origin,
  });
}

// ── Public ───────────────────────────────────────────────────────────────

export async function fetchLicense(input, opts = {}) {
  const fetch = opts.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
  if (!fetch) {
    return { ...unknownResult({ origin: null, hint: 'no fetch available in environment' }), spdxSource: 'no-fetch' };
  }

  let desc;
  if (typeof input === 'string') desc = parseUrlToSource(input);
  else if (input && typeof input === 'object') desc = input;
  else return { ...unknownResult({ origin: null, hint: 'invalid input to fetchLicense' }), spdxSource: 'invalid-input' };

  if (!desc) return { ...unknownResult({ origin: typeof input === 'string' ? input : null, hint: 'could not parse url' }), spdxSource: 'unparseable-source' };

  switch (desc.source) {
    case 'esm.sh':   return fetchEsmSh(fetch, desc);
    case 'jsdelivr': return fetchJsdelivr(fetch, desc);
    case 'unpkg':    return fetchUnpkg(fetch, desc);
    case 'jsr':      return fetchJsr(fetch, desc);
    case 'github':   return fetchGithub(fetch, desc);
    case 'url':      return fetchGenericUrl(fetch, desc);
    default:
      return { ...unknownResult({ origin: desc.origin, hint: `no handler for source '${desc.source}'` }), spdxSource: 'no-handler' };
  }
}
