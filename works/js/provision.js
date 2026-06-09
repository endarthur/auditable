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
import { provisionPackage, addSourceSilent } from './registry.js';
import { readSettings, writeSettings, applyWorkspaceSettings } from './settings-store.js';
import { metaGet, metaSet } from './meta.js';

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

  // Add the catalog as a source so the dep-closure can resolve libs from it.
  if (catalogUrl) {
    try { await addSourceSilent(catalogUrl, opts.sourceName || 'GCU Packages'); }
    catch (e) { console.warn('[works] provision: addSource failed:', e); }
  }

  const report = { name, title: prof.title, installed: [], failed: [] };
  for (const pkg of prof.packages || []) {
    setStatus('provisioning ' + pkg + '…');
    try {
      const dest = await provisionPackage(catalogUrl, pkg);
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

  // TODO(starter): a profile's `starter` cells seed a welcome notebook — deferred
  // until the setup UI lands (it's notebook-cell-shaped; needs a project create).

  // Record the marker (re-runnable: a later provision overwrites it).
  await metaSet('provisioned', {
    profile: name, at: Date.now(),
    installed: report.installed, failed: report.failed,
  }).catch(() => {});

  setStatus(report.failed.length ? `provisioned ${prof.title} (${report.failed.length} failed)` : `provisioned ${prof.title}`);
  return report;
}
