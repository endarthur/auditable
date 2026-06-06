// @gcu/build — collision detection & rename decisions (SPEC §6, §6.6)
//
// The collect → classify step of the rename algorithm, exported as a reusable
// pass (SPEC §6.6 — its second caller is merge mode in phase 2). Returns the
// rename decisions; rewrite.js + scope.js apply them.
//
// Rule (SPEC §6.2): a top-level name declared by more than one distinct binding
// across the module set collides; every colliding declaration is renamed to
// `name$moduleBasename`, deterministic from the file name alone. A name marked
// /* @bundle-share */ is never renamed; colliding with it is an error (§5.1).

import { buildError } from './errors.js';

// Sanitize a module basename to valid identifier characters.
export function sanitizeBasename(name) {
  let s = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

/**
 * @param {Array<{ basename:string, ownBindings:Set<string>,
 *   externalImports:Array<{local,source,imported,kind}> }>} modules
 * @returns {{ renames: Map<object, Map<string,string>>, warnings: Array }}
 *   renames keyed by module object → (originalName → newName).
 */
export function renameCollisions(modules) {
  const warnings = [];
  // name → [{ module, identity }]  where identity dedups "same symbol".
  const byName = new Map();

  const add = (name, module, identity) => {
    let arr = byName.get(name);
    if (!arr) byName.set(name, (arr = []));
    arr.push({ module, identity });
  };

  modules.forEach((m, i) => {
    for (const name of m.ownBindings) add(name, m, `owned:${i}:${name}`);
    for (const imp of m.externalImports || []) {
      // Same (source, imported) is one external symbol shared across modules.
      add(imp.local, m, `ext:${imp.source}:${imp.imported}`);
    }
  });

  const renames = new Map(); // module → Map(name → newName)
  const put = (module, name, newName) => {
    let mm = renames.get(module);
    if (!mm) renames.set(module, (mm = new Map()));
    mm.set(name, newName);
  };

  for (const [name, group] of byName) {
    const sharedEntries = group.filter((g) => g.module.sharedNames && g.module.sharedNames.has(name));
    const distinct = new Set(group.map((g) => g.identity));
    if (sharedEntries.length > 0) {
      if (sharedEntries.length > 1) {
        throw buildError('E007', `'${name}' is marked @bundle-share in multiple modules (shared-intent must be single-site)`, null);
      }
      if (distinct.size > 1) {
        throw buildError('E007', `'${name}' is @bundle-share but also declared elsewhere`, null);
      }
      continue; // single shared singleton — keep, never rename
    }
    if (distinct.size <= 1) continue; // single symbol — no rename
    for (const { module } of group) {
      put(module, name, `${name}$${sanitizeBasename(module.basename)}`);
    }
  }

  return { renames, warnings };
}
