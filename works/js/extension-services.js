// Declarative service contributions — the boot manifest scan.
//
// works-contribution-registry-spec. A package contributes a shell-realm A-Bus
// service by DECLARING it as DATA in package.json (`gcu.services`) — no
// boot-time code, unlike the surface/contextMenu contributions that run a
// package's works.js. That data/code split is the safety point: trusting a
// package's data to NAME a service is weaker than trusting it to RUN code at
// boot. The service's code only runs cold→hot, on first call.
//
// At boot we walk /lib, read each package's `gcu.services[]`, and
// broker.declareService(name, { permission, activator }) for each. The
// activator (the broker runs it on the first call to the name):
//   1. resolves the service's declared `requires` lib names to their module
//      namespaces (getLibSource → blob-import) — dependency injection, so the
//      service code carries no imports and needs no post-boot import map;
//   2. blob-imports the service entry module from /lib/<pkg>/<entry>;
//   3. calls its `setupService(ctx)` export, which connects a broker peer +
//      claims the service name + exposes its interface.
//
// This is what lets a feature's shell engine be PROVISIONED with the feature
// (the package), rather than baked into the shell — the model the lean
// works-core shell + a runtime provisioner (distributions phase 3) need.

import { WKS } from './state.js';
import { connect } from '#abus';
import { getLibSource, ensureLibSource } from './surface-registry.js';
import { enumerateInstalled } from './extension-loader.js';

function _libPathFor(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

function _blobImport(src) {
  return import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
}

// Build the cold→hot activator for one declared service. Captured per-service
// so the broker can run it lazily with the right package + entry + requires.
function _makeActivator(pkgName, libPath, svc) {
  return async function activate() {
    // 1. Resolve declared deps to module namespaces. ensureLibSource finds them
    //    among the build-baked builtins (works/works-all) OR an installed copy in
    //    /lib (a provisioned lean shell) — and caches each into the lib-source
    //    store, so the service's own later sync getLibSource() (its proc-worker
    //    sluice URL, the omf1 reader) sees them too.
    const deps = {};
    for (const r of svc.requires || []) {
      const src = await ensureLibSource(r, WKS.vfs);
      if (!src) throw new Error(`service "${svc.name}" (${pkgName}): required lib @gcu/${r} is unavailable (not baked, not in /lib)`);
      deps[r] = await _blobImport(src);
    }

    // 2. Blob-import the service entry. It is dependency-injected (no imports of
    //    its own), so a bare blob-import resolves with no import map.
    const entryPath = libPath + '/' + (svc.entry || 'service.js');
    let entrySrc;
    try { entrySrc = await WKS.vfs.readFile(entryPath, 'utf8'); }
    catch (e) { throw new Error(`service "${svc.name}" (${pkgName}): cannot read entry ${entryPath}: ${e.message}`); }
    const mod = await _blobImport(entrySrc);
    const setup = mod[svc.export || 'setupService'];
    if (typeof setup !== 'function') {
      throw new Error(`service "${svc.name}" (${pkgName}): entry ${entryPath} has no "${svc.export || 'setupService'}" export`);
    }

    // 3. Run it. setupService must connect a peer + claim svc.name.
    await setup({
      broker:       WKS.broker,
      connect,
      vfs:          WKS.vfs,
      libDir:       libPath,
      getLibSource,
      deps,
    });
  };
}

// Declare every service one installed package's gcu.services manifest names.
// Returns the declared names. Shared by the boot scan and the post-install path
// (file-ops.js installGcupkgBytes) so a runtime-installed service is usable
// without a reload — the mirror of evaluateWorksScript for surfaces.
export async function declarePackageServices(pkgName) {
  if (!WKS.broker || !WKS.vfs) return [];
  const libPath = _libPathFor(pkgName);
  let pkg;
  try { pkg = JSON.parse(await WKS.vfs.readFile(libPath + '/package.json', 'utf8')); }
  catch { return []; }   // no package.json — not a declarative package
  const services = pkg && pkg.gcu && Array.isArray(pkg.gcu.services) ? pkg.gcu.services : [];
  const declared = [];
  for (const svc of services) {
    if (!svc || typeof svc.name !== 'string' || !svc.name) continue;
    try {
      WKS.broker.declareService(svc.name, {
        permission: svc.permission,
        activator:  _makeActivator(pkgName, libPath, svc),
      });
      declared.push(svc.name);
    } catch (e) {
      console.warn(`[works] service-scan: declare "${svc.name}" (${pkgName}) failed:`, e);
    }
  }
  return declared;
}

// Walk /lib, read each package's gcu.services, declare them all cold. Call once
// at boot, after the broker + VFS + lib sources exist (so activators can run
// when a call lands). Idempotent enough — declaring the same name twice just
// replaces the (inert) declaration; activation is still once.
export async function declareInstalledServices() {
  if (!WKS.broker || !WKS.vfs) return;
  let names;
  try { names = await enumerateInstalled(); }
  catch (e) { console.warn('[works] service-scan: /lib enumerate failed:', e); return; }

  const seen = [];
  for (const pkgName of names) {
    for (const name of await declarePackageServices(pkgName)) seen.push(`${name} ⇐ ${pkgName}`);
  }
  if (seen.length) console.info(`[works] declared ${seen.length} cold service(s): ${seen.join(', ')}`);
}
