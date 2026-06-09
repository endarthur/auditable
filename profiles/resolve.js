// profiles/resolve.js — resolve a .gcuprofile (a distribution) to its concrete makeup.
//
// A profile names packages + a base + settings + starter, and may `extends` other
// profiles. resolveProfile() flattens that into a flat shape; resolveToEdition() maps
// it to the [url, srcPath, adderExports?] form the baked build path consumes. The same
// resolveProfile() will feed the runtime/provisioned path (pkg specs) later — that one
// just maps package names to registry specs instead of in-repo paths.
//
// Merge rules (child over parent): packages = union in extends-then-self order (deduped,
// first occurrence wins); settings = shallow merge, child keys override; starter = child
// REPLACES parent if present; base = first defined (self, else inherited).
//
// See spec_inbox/gcu-distributions-spec.md.

const fs = require('fs');
const path = require('path');

function loadProfile(profilesDir, name) {
  const p = path.join(profilesDir, name + '.gcuprofile');
  if (!fs.existsSync(p)) throw new Error(`profile not found: ${name} (${p})`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function resolveProfile(name, opts = {}) {
  const profilesDir = opts.profilesDir || __dirname;
  // Track the current ancestry PATH (not a global visited set) so diamond inheritance
  // (two profiles extending the same parent) isn't mistaken for a cycle.
  const ancestry = opts._ancestry || [];
  if (ancestry.includes(name)) throw new Error(`profile cycle: ${[...ancestry, name].join(' -> ')}`);
  const childAncestry = [...ancestry, name];

  const prof = loadProfile(profilesDir, name);

  const packages = [];
  let settings = {};
  let starter = null;
  let base = prof.base || null;

  for (const parent of prof.extends || []) {
    const r = resolveProfile(parent, { ...opts, profilesDir, _ancestry: childAncestry });
    packages.push(...r.packages);
    settings = { ...settings, ...r.settings };
    if (r.starter && r.starter.length) starter = r.starter;
    base = base || r.base;
  }

  packages.push(...(prof.packages || []));
  settings = { ...settings, ...(prof.settings || {}) };
  if (prof.starter && prof.starter.length) starter = prof.starter;

  return {
    name,
    title: prof.title || name,
    base: base || 'auditable',
    packages: [...new Set(packages)],
    settings,
    starter: starter || [],
  };
}

// Map a resolved profile to the baked-build edition shape: { title, base, settings,
// cells, exts: [[url, srcPath, adderExports?], …] } via the package index.
function resolveToEdition(name, opts = {}) {
  const profilesDir = opts.profilesDir || __dirname;
  const index = opts.packages
    || JSON.parse(fs.readFileSync(opts.packagesPath || path.join(profilesDir, 'packages.json'), 'utf8'));
  const r = resolveProfile(name, { ...opts, profilesDir });
  const exts = r.packages.map((pkg) => {
    const meta = index[pkg];
    if (!meta || !meta.path) throw new Error(`profile ${name}: package ${pkg} is not in the package index (packages.json)`);
    return meta.adderExports ? [pkg, meta.path, meta.adderExports] : [pkg, meta.path];
  });
  return { title: r.title, base: r.base, settings: r.settings, cells: r.starter, exts };
}

module.exports = { resolveProfile, resolveToEdition, loadProfile };
