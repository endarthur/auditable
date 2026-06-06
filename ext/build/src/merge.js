// @gcu/build — merge mode (SPEC §6.7)
//
// The second collision site: the Works surface inliner raw-concatenates several
// already-built `index.js` bundles into one iframe scope. Two independently-clean
// packages can both export `inferType` (over × loom did) and flat-concat collides
// them — caught only at surface load. Merge mode is renameCollisions (§6.6)
// applied to PRE-BUILT bundles, so the inliner becomes a @gcu/build consumer
// instead of a hand-rolled export→const text substitution.
//
//   mergeBundles(bundles, opts) → { code, renames, warnings }
//     bundles: [{ name, source }]   each an already-built export-bearing ESM
//     opts:    { surface?, parser? }
//       surface — optional consumer source that imports `{ X } from '@gcu/<name>'`;
//                 those consume sites are rewritten to the (possibly renamed)
//                 binding and the import is stripped.
//
// @bundle-share is per-package (already resolved inside each build), so it's
// ignored here — everything is name-by-name.

import { parseModule } from '../../air/src/api.js';
import { renameCollisions } from './rename.js';
import { collectRenamePatches } from './scope.js';
import { stmtDelete, exportPrefixStrip, declaredNames, declSitePatches } from './rewrite.js';
import { applyPatches } from './emit.js';

function getParser(opts) {
  if (opts && opts.parser) return opts.parser;
  const A = (typeof globalThis !== 'undefined' && globalThis.Acorn) || (typeof window !== 'undefined' && window.Acorn);
  if (A) return A.Parser.extend(A.tsPlugin());
  throw new Error('gcu-build: no parser. Pass opts.parser (acorn Parser) or load window.Acorn.');
}

function baseId(name) {
  let s = String(name).replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  return s;
}

// Parse one built bundle into { name, basename, source, ast, ownBindings,
// externalImports, exportMap (exported→internal) }.
function loadBundle(bundle, parse) {
  const ast = parse(bundle.source);
  const ownBindings = new Set();
  const externalImports = []; // { local, source, imported, kind, node }
  const exportMap = new Map(); // exported → internal binding name
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      if (node.specifiers.length === 0) { externalImports.push({ local: null, source, imported: null, kind: 'side-effect', node }); continue; }
      for (const s of node.specifiers) {
        if (s.type === 'ImportNamespaceSpecifier') externalImports.push({ local: s.local.name, source, imported: '*', kind: 'namespace', node });
        else if (s.type === 'ImportDefaultSpecifier') externalImports.push({ local: s.local.name, source, imported: 'default', kind: 'default', node });
        else externalImports.push({ local: s.local.name, source, imported: s.imported.name || s.imported.value, kind: 'named', node });
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        for (const nm of declaredNames(node.declaration)) { ownBindings.add(nm); exportMap.set(nm, nm); }
      } else {
        for (const s of node.specifiers) {
          exportMap.set(s.exported.name || s.exported.value, s.local.name || s.local.value);
        }
      }
    } else {
      for (const nm of declaredNames(node)) ownBindings.add(nm);
    }
  }
  return { name: bundle.name, basename: baseId(bundle.name), source: bundle.source, ast, ownBindings, externalImports, exportMap };
}

export function mergeBundles(bundles, opts = {}) {
  const parser = getParser(opts);
  const parse = (code) => parseModule(code, parser);

  const mods = bundles.map((b) => loadBundle(b, parse));
  const { renames, warnings } = renameCollisions(mods);
  const outputName = (mod, name) => {
    const mm = renames.get(mod);
    return (mm && mm.get(name)) || name;
  };

  // hoist + dedup external imports across all bundles
  const hoist = [];
  const seenHoist = new Set();

  const bodies = [];
  for (const mod of mods) {
    const patches = [];
    const ownRenames = renames.get(mod) || new Map();
    const renameMap = new Map(ownRenames);
    const topNames = new Set(mod.ownBindings);
    for (const b of mod.externalImports) {
      if (!b.local) continue;
      topNames.add(b.local);
      const on = outputName(mod, b.local);
      if (on !== b.local) renameMap.set(b.local, on);
    }
    for (const node of mod.ast.body) {
      if (node.type === 'ImportDeclaration') {
        patches.push(stmtDelete(node, mod.source));
        const text = mod.source.slice(node.start, node.end);
        if (!seenHoist.has(text)) { seenHoist.add(text); hoist.push(text); }
      } else if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) { patches.push(exportPrefixStrip(node)); declSitePatches(node.declaration, ownRenames, patches); }
        else patches.push(stmtDelete(node, mod.source));
      } else {
        declSitePatches(node, ownRenames, patches);
      }
    }
    for (const p of collectRenamePatches(mod.ast, renameMap, topNames)) patches.push(p);
    bodies.push({ name: mod.name, body: applyPatches(mod.source, patches).replace(/^\n+/, '').replace(/\n+$/, '') });
  }

  // surface consumer: rewrite `import { X } from '@gcu/<name>'` to the final binding
  let surfaceOut = '';
  if (opts.surface != null) {
    const byName = new Map();
    for (const m of mods) {
      byName.set(m.name, m);
      if (!m.name.startsWith('@')) byName.set('@gcu/' + m.name, m); // surface imports use the scoped form
    }
    const sAst = parse(opts.surface);
    const patches = [];
    const renameMap = new Map();
    const topNames = new Set();
    for (const node of sAst.body) {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (decl) for (const nm of declaredNames(decl)) topNames.add(nm);
    }
    for (const node of sAst.body) {
      if (node.type !== 'ImportDeclaration') continue;
      const spec = node.source.value;
      const m = byName.get(spec);
      if (!m) continue; // non-merged import — leave it
      patches.push(stmtDelete(node, opts.surface));
      for (const s of node.specifiers) {
        if (s.type !== 'ImportSpecifier') continue;
        const imported = s.imported.name || s.imported.value;
        const internal = m.exportMap.get(imported) || imported;
        const final = outputName(m, internal);
        topNames.add(s.local.name);
        if (s.local.name !== final) renameMap.set(s.local.name, final);
      }
    }
    for (const p of collectRenamePatches(sAst, renameMap, topNames)) patches.push(p);
    surfaceOut = applyPatches(opts.surface, patches).replace(/^\n+/, '').replace(/\n+$/, '');
  }

  const lines = [];
  if (hoist.length) { lines.push(hoist.join('\n')); lines.push(''); }
  for (const b of bodies) { lines.push(`// ── @gcu/${b.name} ──`); lines.push(''); lines.push(b.body); lines.push(''); }
  if (surfaceOut) { lines.push('// ── surface ──'); lines.push(''); lines.push(surfaceOut); lines.push(''); }

  const renameList = [];
  for (const [mod, mm] of renames) for (const [original, renamed] of mm) renameList.push({ original, renamed, bundle: mod.name });

  return { code: lines.join('\n'), renames: renameList, warnings };
}
