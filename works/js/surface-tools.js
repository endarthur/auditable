// Surface-contributed agent tools — the `gcu.agentTools` registry.
//
// works-agent-tools-spec. A package teaches the agent its own verbs by DECLARING
// them as DATA in package.json (`gcu.agentTools[]`) — no boot-time code, same
// data/code safety split as `gcu.services`. The shell registers shell-side
// DISPATCHERS (mcp-adapter's worksListSurfaceTools / worksCallSurfaceTool) that
// route each call to the surface's own A-Bus interface on the gated agent peer,
// so gating/consent/audit hold unchanged. This module owns the registry: built
// at boot from the /lib scan, extendable programmatically (post-install + tests).
//
// A tool entry (validated, normalized):
//   { name, description, inputSchema,        // agent-facing
//     surface, interface, member,            // routing → callSurfaceAt
//     args,                                  // method positional params (NOT path;
//                                            //   path is routing+scope, always first
//                                            //   to the relay)
//     gated, pkg }                           // gated → SurfaceTools.Mutate (consent)

import { WKS } from './state.js';
import { enumerateInstalled } from './extension-loader.js';

const _registry = [];   // normalized tool entries

// All available surface tools (agent-facing shape). The `path` arg is reserved
// for future per-path filtering; ambient today (a tool is available wherever a
// matching surface can open).
export function listSurfaceTools(/* path */) {
  return _registry.map((e) => ({
    name: e.name, description: e.description, inputSchema: e.inputSchema,
    surface: e.surface, args: e.args, gated: e.gated,
  }));
}

export function getSurfaceTool(name) {
  return _registry.find((e) => e.name === name) || null;
}

// Validate + add entries (the /lib scan and post-install/tests share this).
// Same-name re-registration replaces. Invalid entries are skipped with a warn.
export function registerSurfaceTools(pkgName, entries) {
  const added = [];
  for (const t of (entries || [])) {
    if (!t || typeof t.name !== 'string' || !t.name) continue;
    if (typeof t.surface !== 'string' || typeof t.interface !== 'string' || typeof t.member !== 'string') {
      console.warn(`[works] agentTool "${t.name}" (${pkgName}): needs surface + interface + member`);
      continue;
    }
    const entry = {
      name: t.name,
      description: t.description || `${t.member} on the ${t.surface} surface`,
      inputSchema: t.inputSchema || { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      surface: t.surface,
      interface: t.interface,
      member: t.member,
      // method positional params (path is routing-only unless explicitly listed)
      args: Array.isArray(t.args) ? t.args.slice() : [],
      gated: !!t.gated,
      pkg: pkgName,
    };
    const i = _registry.findIndex((e) => e.name === entry.name);
    if (i >= 0) _registry[i] = entry; else _registry.push(entry);
    added.push(entry.name);
  }
  return added;
}

// Lightweight validation of an agent's input against a tool's inputSchema — the
// common JSON-schema subset these schemas use (type, required, per-property type,
// enum). Runs SHELL-SIDE (trusted adapter) BEFORE the call crosses A-Bus to the
// surface, so a malformed call fails here with a precise message instead of deep
// in the surface. Returns an error string, or null when valid. Rejects rather
// than coerces — silently "fixing" an agent's args would mask its mistakes; a
// clear error lets it retry. Not a full validator (no nested/$ref) — flat tool
// inputs are the norm; deepen if a real schema needs it.
export function validateToolInput(entry, input) {
  const schema = entry && entry.inputSchema;
  if (!schema || typeof schema !== 'object') return null;   // nothing declared to check
  const obj = input && typeof input === 'object' ? input : {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const errs = [];
  for (const k of required) {
    if (obj[k] === undefined || obj[k] === null) errs.push(`missing required "${k}"`);
  }
  const typeOk = (v, t) => {
    switch (t) {
      case 'string':  return typeof v === 'string';
      case 'number':  return typeof v === 'number' && !Number.isNaN(v);
      case 'integer': return typeof v === 'number' && Number.isInteger(v);
      case 'boolean': return typeof v === 'boolean';
      case 'array':   return Array.isArray(v);
      case 'object':  return !!v && typeof v === 'object' && !Array.isArray(v);
      default:        return true;
    }
  };
  for (const [k, spec] of Object.entries(props)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;   // absence is the `required` check's job
    if (spec && spec.type && !typeOk(v, spec.type)) errs.push(`"${k}" must be ${spec.type}`);
    if (spec && Array.isArray(spec.enum) && !spec.enum.includes(v)) errs.push(`"${k}" must be one of: ${spec.enum.join(', ')}`);
  }
  return errs.length ? `invalid input for "${entry.name}": ${errs.join('; ')}` : null;
}

function _libPathFor(name) {
  if (/^@[\w.-]+\/[\w.-]+$/.test(name)) return '/lib/' + name;
  return '/lib/local/' + name;
}

// Register one installed package's gcu.agentTools from its /lib manifest. Shared
// by the boot scan and the post-install path (file-ops installGcupkgBytes) so a
// runtime-installed package's tools are reachable WITHOUT a reload — the mirror
// of extension-services' declarePackageServices. Returns the registered names.
export async function registerPackageSurfaceTools(pkgName) {
  if (!WKS.vfs) return [];
  let pkg;
  try { pkg = JSON.parse(await WKS.vfs.readFile(_libPathFor(pkgName) + '/package.json', 'utf8')); }
  catch { return []; }   // no package.json — not a declarative package
  const tools = pkg && pkg.gcu && Array.isArray(pkg.gcu.agentTools) ? pkg.gcu.agentTools : [];
  return registerSurfaceTools(pkgName, tools);
}

// Walk /lib, register every package's gcu.agentTools. Call at boot after VFS +
// /lib exist. Idempotent (same-name replaces). Mirrors declareInstalledServices.
export async function buildSurfaceToolRegistry() {
  if (!WKS.vfs) return;
  let names;
  try { names = await enumerateInstalled(); }
  catch (e) { console.warn('[works] agentTools: /lib enumerate failed:', e); return; }
  const seen = [];
  for (const pkgName of names) {
    for (const n of await registerPackageSurfaceTools(pkgName)) seen.push(`${n} ⇐ ${pkgName}`);
  }
  if (seen.length) console.info(`[works] registered ${seen.length} surface tool(s): ${seen.join(', ')}`);
}
