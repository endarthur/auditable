// Distribution-profile provisioning — the engine the lean works-core's first-run
// setup drives (distributions phase 3). A profile (a .gcuprofile, resolved +
// baked into works-core as the profiles-payload) names a package set + settings
// + starter; provisioning installs those packages (+ their lib closure) from the
// catalog, applies the settings, and records a `provisioned` marker so later
// boots skip setup.
//
// The invariant: this is the NETWORK-named feature. The profile LIST is baked
// (offline/first-paint); only the package install reaches the network. On
// file:// (no network) provisioning degrades — the setup screen offers a baked
// monolith instead. Nothing here runs at boot unless setup invokes it.

import { WKS, setStatus } from './state.js';
import { ensurePackage, addSourceSilent, addSourceWithConsent, DEFAULT_SOURCE, _setProfileApply } from './registry.js';
import { surfaceAvailable, availableKindForExtension } from './surface-registry.js';
import { getInstalled } from './gcudat-install.js';
import { readSettings, writeSettings, applyWorkspaceSettings } from './settings-store.js';
import { metaGet, metaSet } from './meta.js';

// Build-injected (works build): the package catalog URL — the first-party code
// source a provisioned shell installs from. Hosted SAME-ORIGIN as the Works PWA
// (gentropic.org/works/packages/) so provisioning needs no CORS and the SW
// runtime-caches the .gcupkgs for offline re-provision. Overridable per-workspace
// via the `registry.catalogUrl` meta key (tests + custom deployments) or
// showSetupDialog({ catalogUrl }).
const __GCU_CATALOG_URL__ = 'https://gentropic.org/works/packages/registry.json';

export async function getCatalogUrl() {
  const override = await metaGet('registry.catalogUrl').catch(() => null);
  return override || __GCU_CATALOG_URL__;
}

let _profiles = null;

async function _decompressEl(el) {
  const bytes = Uint8Array.from(atob(el.textContent.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// The baked profile list (resolveToProvisioned shapes). [] when the payload is
// absent (works / works-all monoliths don't carry it — they don't provision).
export async function listProfiles() {
  if (_profiles) return _profiles;
  const el = document.getElementById('profiles-payload');
  if (!el) { _profiles = []; return _profiles; }
  try {
    const payload = JSON.parse(await _decompressEl(el));
    _profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  } catch (e) {
    console.warn('[works] profiles payload decode failed:', e);
    _profiles = [];
  }
  return _profiles;
}

// Has this workspace already been provisioned? (the marker the setup screen
// checks to decide whether to show first-run setup). Returns the marker or null.
export async function getProvisioned() {
  return metaGet('provisioned').catch(() => null);
}
export async function isProvisioned() {
  return !!(await getProvisioned());
}

// Provision a profile: add the catalog source, install each package (+ its lib
// dep-closure) from it, apply the profile's settings, record the marker. Returns
// a report { name, installed: [...], failed: [...] }. Throws only on an unknown
// profile — per-package failures are collected, not fatal (a partial provision is
// re-runnable; that's the robustness model).
export async function provisionProfile(name, catalogUrl, opts = {}) {
  const prof = (await listProfiles()).find((p) => p.name === name);
  if (!prof) throw new Error('unknown profile: ' + name);
  return _provision(prof, catalogUrl, opts);
}

// Provision a RAW .gcuprofile spec — the v1 "Custom…" path (Form 1): point the
// setup at a .gcuprofile (a URL / pasted JSON), provision its packages from the
// configured sources. Treated FLAT — `extends` is ignored in v1 (runtime extends
// resolution against the baked base profiles is roadmapped). The packages it
// names must exist in some configured/added source (partial provisions are fine).
export async function provisionProfileSpec(spec, catalogUrl, opts = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('invalid profile spec');
  const prof = {
    name: spec.name || 'custom',
    title: spec.title || spec.name || 'Custom',
    packages: Array.isArray(spec.packages) ? spec.packages : [],
    sources: Array.isArray(spec.sources) ? spec.sources : [],
    settings: spec.settings || {},
    starter: Array.isArray(spec.starter) ? spec.starter : [],
    welcome: Array.isArray(spec.welcome) ? spec.welcome : [],
  };
  return _provision(prof, catalogUrl, opts);
}

async function _provision(prof, catalogUrl, opts = {}) {
  // Add the catalog as a source so the dep-closure can resolve libs from it.
  if (catalogUrl) {
    try { await addSourceSilent(catalogUrl, opts.sourceName || 'GCU Packages'); }
    catch (e) { console.warn('[works] provision: addSource failed:', e); }
  }

  // A profile may carry its packages' origin sources (an exported profile whose
  // packages came from a non-default source). Unknown sources get the trust
  // prompt — the profile itself is inert data, but a source can serve code, so
  // adding one silently would break the consent model. A declined source just
  // means its packages fail to resolve (collected below, not fatal).
  for (const src of prof.sources || []) {
    if (typeof src !== 'string' || !src) continue;
    try { await addSourceWithConsent(src); }
    catch (e) { console.warn('[works] provision: source add failed:', e); }
  }

  const report = { name: prof.name, title: prof.title, installed: [], failed: [] };
  for (const pkg of prof.packages || []) {
    setStatus('provisioning ' + pkg + '…');
    try {
      // ensurePackage is idempotent + recovering (#5): an already-installed
      // package skips the re-download but completes any dep-closure a prior
      // interrupted run left unfinished (and re-assembles its surface); a
      // missing one installs across sources (catalog preferred, then the rest).
      // Returns null when an installed package's closure still can't complete →
      // marked failed so the re-run / setup re-offer picks it up.
      const dest = await ensurePackage(pkg, opts.preferredSource || catalogUrl);
      if (dest) report.installed.push(pkg); else report.failed.push(pkg);
    } catch (e) {
      console.warn('[works] provision package', pkg, 'failed:', e);
      report.failed.push(pkg);
    }
  }

  // Apply the profile's settings (merged over current).
  if (prof.settings && Object.keys(prof.settings).length) {
    try {
      const merged = { ...(await readSettings(WKS.vfs)), ...prof.settings };
      await writeSettings(WKS.vfs, merged);
      applyWorkspaceSettings(merged);
    } catch (e) { console.warn('[works] provision: settings apply failed:', e); }
  }

  // Seed the profile's welcome (an ordered list of modes — see _seedWelcome).
  // Skippable (the setup checkbox / `profile provision --no-starter`);
  // write-if-absent so a re-provision never clobbers — or resurrects — an
  // edited/deleted welcome. report.starter carries the seeded path when (and
  // only when) seeded now; report.starterOpenable says whether THIS build
  // carries a surface that can open it.
  report.starter = null;
  report.starterOpenable = false;
  if (!opts.skipStarter) {
    try {
      const seeded = await _seedWelcome(prof);
      if (seeded) { report.starter = seeded.path; report.starterOpenable = seeded.openable; }
    } catch (e) { console.warn('[works] provision: welcome seed failed:', e); }
  }

  // Record the marker (re-runnable: a later provision overwrites it).
  await metaSet('provisioned', {
    profile: prof.name, at: Date.now(),
    installed: report.installed, failed: report.failed,
  }).catch(() => {});

  setStatus(report.failed.length ? `provisioned ${prof.title} (${report.failed.length} failed)` : `provisioned ${prof.title}`);
  return report;
}

// ── welcome modes ───────────────────────────────────────────────────
// A profile's `welcome` is an ORDERED list of alternative greetings:
//   { kind: 'notebook' }            — seed the `starter` cells as a project
//   { kind: 'doc', content: '…md…' } — seed inline markdown as welcome.md
// The first mode whose surface is present in this build seeds (+ reports
// openable); when none is openable the FIRST valid mode still seeds — it
// opens once its surface arrives (e.g. the notebook ships as a package).
// No `welcome` + a non-empty `starter` ≡ [{ kind: 'notebook' }].
function _welcomeModes(prof) {
  const list = (Array.isArray(prof.welcome) && prof.welcome.length) ? prof.welcome
    : ((Array.isArray(prof.starter) && prof.starter.length) ? [{ kind: 'notebook' }] : []);
  return list.filter((m) => m && (
    (m.kind === 'notebook' && Array.isArray(prof.starter) && prof.starter.length)
    || (m.kind === 'doc' && typeof m.content === 'string' && m.content)));
}

function _modeOpenable(mode) {
  return mode.kind === 'notebook' ? surfaceAvailable('notebook')
    : !!availableKindForExtension('welcome.md');
}

async function _seedWelcome(prof) {
  const modes = _welcomeModes(prof);
  if (!modes.length) return null;
  const mode = modes.find(_modeOpenable) || modes[0];
  const openable = _modeOpenable(mode);
  if (mode.kind === 'notebook') {
    const path = await _seedStarter(prof);
    return path ? { path, openable } : null;
  }
  // doc — inline markdown, write-if-absent (same never-clobber contract).
  const path = '/projects/welcome.md';
  if (await WKS.vfs.exists(path).catch(() => false)) return null;
  await WKS.vfs.writeFile(path, mode.content.replace(/\s+$/, '') + '\n');
  return { path, openable };
}

// Write the profile's starter cells as a notebook project (the shape
// tree.js's newProject creates: project.json + notebook.txt in the /// form).
// Write-if-absent: an existing /projects/welcome — even a deleted-then-
// recreated-by-the-user one — is never touched. Returns the project path,
// or null when it already existed.
async function _seedStarter(prof) {
  const dir = '/projects/welcome';
  if (await WKS.vfs.exists(dir + '/project.json').catch(() => false)) return null;
  const title = 'Welcome — ' + (prof.title || prof.name);
  const lines = ['/// auditable', '/// title: ' + title];
  for (const cell of prof.starter) {
    if (!cell || typeof cell.code !== 'string') continue;
    lines.push('', '/// ' + (cell.type || 'code'), cell.code.replace(/\s+$/, ''));
  }
  await WKS.vfs.mkdir(dir, { recursive: true });
  await WKS.vfs.writeFile(dir + '/project.json', JSON.stringify({
    kind: 'notebook', id: 'p-' + Math.random().toString(36).slice(2, 9), title,
  }, null, 2));
  await WKS.vfs.writeFile(dir + '/notebook.txt', lines.join('\n') + '\n');
  return dir;
}

// ── profile export ──────────────────────────────────────────────────
// Snapshot this workspace as a .gcuprofile spec — the inverse of _provision,
// and the sharing path: export here, host it (or a registry pointing at it),
// provision it elsewhere via the setup screen's Custom… / `profile provision`.
//
// What's captured: every install-ledger entry with a recorded `source` (both
// code extensions and content packs — re-resolvable by name), the origin
// sources beyond the defaults (consumed by _provision with a trust prompt),
// and the benign workspace prefs (appearance, textEditor). Deliberately NOT
// captured: sideloads/direct installs (no source to re-resolve from), baked
// builtins (not in the ledger), and security-relevant settings like
// abusWorkspace — a shared profile must never pre-grant anything.
export async function exportProfileSpec(opts = {}) {
  const ledger = await getInstalled();
  const defaults = new Set([DEFAULT_SOURCE.url, __GCU_CATALOG_URL__, await getCatalogUrl()]);
  const packages = [];
  const sources = [];
  for (const name of Object.keys(ledger).sort()) {
    const rec = ledger[name];
    if (!rec || !rec.source) continue;
    if (rec.dep) continue;   // transitive dep-closure install — re-derives at provision time
    packages.push(name);
    if (!defaults.has(rec.source) && !sources.includes(rec.source)) sources.push(rec.source);
  }

  const cur = await readSettings(WKS.vfs).catch(() => ({}));
  const settings = {};
  if (cur.appearance) settings.appearance = cur.appearance;
  if (cur.textEditor) settings.textEditor = cur.textEditor;

  const name = String(opts.name || 'my-works').trim() || 'my-works';
  const spec = {
    name,
    title: opts.title || name,
    base: 'works-core',
    description: opts.description
      || ('Exported from an Auditable Works workspace, ' + new Date().toISOString().slice(0, 10) + '.'),
    packages,
  };
  if (sources.length) spec.sources = sources;
  spec.settings = settings;
  spec.starter = [];
  return spec;
}

// Register as the registry's profile-entry applier (Form 2: a registry can
// carry kind:'profile' entries; "installing" one provisions its spec). Late-
// bound through _setProfileApply because this module imports registry.js for
// the install primitives — a static import back would be a cycle. Packages
// resolve preferring the source the profile shipped from, then the rest.
_setProfileApply(async (spec, sourceUrl, opts) =>
  provisionProfileSpec(spec, await getCatalogUrl(), { preferredSource: sourceUrl, ...(opts || {}) }));
