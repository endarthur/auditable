// aggregateLicenses(vfs) — pure view function over the workspace VFS.
//
// Walks three well-known roots and returns a flat table:
//   /var/modules/<key>/         — install()'d modules (meta.json + LICENSE)
//   /lib/<source>/<pkg>@<ver>/  — pkg-managed (package.json + LICENSE)
//   /sys/licenses/<name>/       — build-time-vendored (index.json + LICENSE)
//
// No caching, no aggregator file. The per-folder LICENSE is the canonical
// store; this function just walks + classifies. Tolerant of missing roots
// (returns the entries from whichever roots exist).
//
// VFS duck type — needs only:
//   readdir(path)            → array of names (string)
//   readFile(path, encoding) → string (encoding='utf8') or Uint8Array
//   stat(path)               → { type: 'file' | 'directory', ... }
//
// All three may throw on missing paths; we catch and treat as empty.

import { parseUrlToSource } from './fetch.js';
import { classify } from './classify.js';

// ── VFS-safe helpers ─────────────────────────────────────────────────────

async function safeReaddir(vfs, path) {
  try {
    const r = vfs.readdir(path);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return []; }
}

async function safeReadFile(vfs, path, encoding) {
  try {
    const r = vfs.readFile(path, encoding);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return null; }
}

async function safeStat(vfs, path) {
  try {
    const r = vfs.stat(path);
    return (r && typeof r.then === 'function') ? (await r) : r;
  } catch { return null; }
}

async function readJson(vfs, path) {
  const text = await safeReadFile(vfs, path, 'utf8');
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Try the standard LICENSE-file variants in a directory, return first hit.
const LICENSE_FILENAMES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'license', 'license.md', 'license.txt',
  'COPYING', 'COPYING.md', 'COPYING.txt',
  'NOTICE',
];

async function readLicenseFile(vfs, dir) {
  for (const name of LICENSE_FILENAMES) {
    const text = await safeReadFile(vfs, `${dir}/${name}`, 'utf8');
    if (typeof text === 'string' && text.length > 0) {
      return { text, filename: name };
    }
  }
  return null;
}

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

// ── Per-root walkers ─────────────────────────────────────────────────────

// /var/modules/<url-encoded-key>/  → install()'d ESM modules
async function walkVarModules(vfs) {
  const out = [];
  const entries = await safeReaddir(vfs, '/var/modules');
  for (const key of entries) {
    const dir = `/var/modules/${key}`;
    const st = await safeStat(vfs, dir);
    if (!st || st.type !== 'directory') continue;

    const meta = await readJson(vfs, `${dir}/meta.json`) || {};
    const lic  = await readLicenseFile(vfs, dir);

    // Prefer meta.json.url for canonical pkg/version (round-trippable through
    // parseUrlToSource); fall back to decoded key.
    let pkg = null, version = null;
    if (typeof meta.url === 'string') {
      const desc = parseUrlToSource(meta.url);
      if (desc) { pkg = desc.pkg; version = desc.version; }
    }
    if (!pkg) {
      try {
        const decoded = decodeURIComponent(key);
        const desc = parseUrlToSource(decoded);
        if (desc) { pkg = desc.pkg; version = desc.version; }
      } catch { /* fall through */ }
    }
    if (!pkg) pkg = key;

    const spdx = (meta.license && typeof meta.license.spdx === 'string')
      ? meta.license.spdx
      : (lic ? null : 'UNKNOWN');

    out.push({
      pkg, version,
      source: 'install',
      path: dir,
      spdx: spdx || 'UNKNOWN',
      classification: classify(spdx),
      copyright: meta.license && meta.license.copyright || (lic ? extractCopyright(lic.text) : null),
      text: lic ? lic.text : null,
      fetchedFrom: meta.license && meta.license.fetchedFrom || null,
      verified: !!(meta.license && lic),  // meta says X, file present — verifiable
    });
  }
  return out;
}

// /lib/<source>/<pkg-dir>/  — pkg-managed packages
// Sources we recognize: npm, jsr, gh, @gcu/local
async function walkLib(vfs) {
  const out = [];
  const sources = await safeReaddir(vfs, '/lib');
  for (const srcName of sources) {
    const sourcePath = `/lib/${srcName}`;
    const st = await safeStat(vfs, sourcePath);
    if (!st || st.type !== 'directory') continue;

    // gh has nested owner/repo, others have flat pkg@ver.
    if (srcName === 'gh') {
      const owners = await safeReaddir(vfs, sourcePath);
      for (const owner of owners) {
        const repos = await safeReaddir(vfs, `${sourcePath}/${owner}`);
        for (const repoSlug of repos) {
          const dir = `${sourcePath}/${owner}/${repoSlug}`;
          const st2 = await safeStat(vfs, dir);
          if (!st2 || st2.type !== 'directory') continue;
          const m = /^([^@]+)(?:@(.+))?$/.exec(repoSlug);
          const repo = m ? m[1] : repoSlug;
          const ref  = m && m[2] ? m[2] : null;
          out.push(await collectLibEntry(vfs, dir, `${owner}/${repo}`, ref, 'pkg/gh'));
        }
      }
      continue;
    }

    const items = await safeReaddir(vfs, sourcePath);
    for (const item of items) {
      // Scoped npm packages are nested: /lib/npm/@scope/pkg@ver
      if (item.startsWith('@')) {
        const scoped = await safeReaddir(vfs, `${sourcePath}/${item}`);
        for (const sub of scoped) {
          const dir = `${sourcePath}/${item}/${sub}`;
          const st2 = await safeStat(vfs, dir);
          if (!st2 || st2.type !== 'directory') continue;
          const m = /^([^@]+)(?:@(.+))?$/.exec(sub);
          const name = m ? m[1] : sub;
          const ver  = m && m[2] ? m[2] : null;
          out.push(await collectLibEntry(vfs, dir, `${item}/${name}`, ver, `pkg/${srcName}`));
        }
        continue;
      }
      const dir = `${sourcePath}/${item}`;
      const st2 = await safeStat(vfs, dir);
      if (!st2 || st2.type !== 'directory') continue;
      const m = /^([^@]+)(?:@(.+))?$/.exec(item);
      const name = m ? m[1] : item;
      const ver  = m && m[2] ? m[2] : null;
      out.push(await collectLibEntry(vfs, dir, name, ver, `pkg/${srcName}`));
    }
  }
  return out;
}

async function collectLibEntry(vfs, dir, pkg, version, sourceTag) {
  const pkgJson = await readJson(vfs, `${dir}/package.json`)
              || await readJson(vfs, `${dir}/jsr.json`)
              || {};
  const lic = await readLicenseFile(vfs, dir);
  const spdx = spdxFromPackageJson(pkgJson) || (lic ? null : 'UNKNOWN');
  return {
    pkg, version,
    source: sourceTag,
    path: dir,
    spdx: spdx || 'UNKNOWN',
    classification: classify(spdx),
    copyright: lic ? extractCopyright(lic.text) : null,
    text: lic ? lic.text : null,
    fetchedFrom: null,
    verified: !!(spdx && lic),
  };
}

// /sys/licenses/<name>/  — build-time-vendored deps
async function walkSysLicenses(vfs) {
  const out = [];
  const index = await readJson(vfs, '/sys/licenses/index.json') || {};
  const names = await safeReaddir(vfs, '/sys/licenses');
  for (const name of names) {
    if (name === 'index.json') continue;
    const dir = `/sys/licenses/${name}`;
    const st = await safeStat(vfs, dir);
    if (!st || st.type !== 'directory') continue;

    const entry = index[name] || {};
    const lic = await readLicenseFile(vfs, dir);
    const spdx = (typeof entry.spdx === 'string' ? entry.spdx : null)
              || (lic ? null : 'UNKNOWN');

    out.push({
      pkg: name,
      version: entry.version || null,
      source: 'vendored',
      path: dir,
      spdx: spdx || 'UNKNOWN',
      classification: classify(spdx),
      copyright: lic ? extractCopyright(lic.text) : null,
      text: lic ? lic.text : null,
      fetchedFrom: entry.homepage || null,
      verified: !!(spdx && lic),
    });
  }
  return out;
}

// ── Public ───────────────────────────────────────────────────────────────

export async function aggregateLicenses(vfs) {
  if (!vfs || typeof vfs.readdir !== 'function' || typeof vfs.readFile !== 'function') {
    throw new TypeError('aggregateLicenses: vfs must implement readdir() and readFile()');
  }
  const [installs, lib, sys] = await Promise.all([
    walkVarModules(vfs),
    walkLib(vfs),
    walkSysLicenses(vfs),
  ]);
  // Stable order: vendored first (the binary's own deps), then pkg, then install.
  return [...sys, ...lib, ...installs];
}
