// @gcu/build — pure core: bundleModules (SPEC §1.4, §6, §7)
//
// I/O-free. Input is the complete module set already read into memory
// ({ [path]: source }); output is { code, map, meta, warnings }. The same
// function runs unchanged in node, in a @gcu/vfs-backed Works build, and in
// tests — it touches no fs and no environment globals beyond an optional parser.
//
// It reuses @gcu/air's parser config + import/export extraction (SPEC §21).
// Phase 1 imports those from air's SOURCE (../../air/src/api.js), NOT the bare
// '@gcu/air' bundle — the bundle is strip-only and has no export footer yet
// (the footer fix + the self-host path is phase 2).

import { parseModule, extractImports, extractExports } from '../../air/src/api.js';
import { classify } from './resolve.js';
import { renameCollisions } from './rename.js';
import { collectRenamePatches } from './scope.js';
import { stmtDelete, exportPrefixStrip, declaredNames, declSitePatches } from './rewrite.js';
import { applyPatches } from './emit.js';
import { validateDefine, collectDefinePatches } from './define.js';
import { collectAnnotations } from './annotations.js';
import { lintModule } from './lint.js';
import { buildError, astLoc } from './errors.js';

const PARSE_OPTS = { ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true };

function getParser(opts) {
  if (opts && opts.parser) return opts.parser;
  const A = (typeof globalThis !== 'undefined' && globalThis.Acorn) || (typeof window !== 'undefined' && window.Acorn);
  if (A) return A.Parser.extend(A.tsPlugin());
  throw new Error('gcu-build: no parser. Pass opts.parser (acorn Parser) or load window.Acorn.');
}

function dirOf(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; }
function baseOf(p) {
  const f = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
  return f.replace(/\.[^.]+$/, '');
}

// Scan for forbidden dynamic import() expressions (SPEC §3.2, E006).
function findDynamicImport(ast) {
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'ImportExpression') { found = n; return; }
    for (const k in n) {
      if (k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) walk(c); }
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  return found;
}

/**
 * Bundle a complete in-memory module set into one flat ESM string.
 * @param {Object<string,string>} sources  path → source code
 * @param {{ entry:string, parser?:object, srcRoot?:string, header?:string,
 *           packageName?:string, packageDesc?:string }} opts
 * @returns {{ code:string, map:null, meta:object, warnings:Array }}
 */
export function bundleModules(sources, opts) {
  if (!opts || !opts.entry) throw new Error('gcu-build: opts.entry is required');
  const parser = getParser(opts);
  const entry = opts.entry;
  if (sources[entry] === undefined) throw new Error(`gcu-build: entry '${entry}' not in sources`);
  const srcRoot = opts.srcRoot != null ? opts.srcRoot : dirOf(entry);
  const parse = (code) => parseModule(code, parser);
  const defineMap = validateDefine(opts.define, parse);
  // inline (§4.2): the adapter has already read inlined deps into `sources` and
  // built inlineAliases (bare-specifier → source key). lintEscaping defaults on.
  const clsOpts = { inlineAliases: opts.inlineAliases || {}, lintEscaping: opts.lintEscaping !== false };
  const doLint = opts.lint !== false;
  const warnings = [];

  // ── parse + classify (memoized per path) ──────────────────────────
  const byPath = new Map();
  function load(path) {
    if (byPath.has(path)) return byPath.get(path);
    let ast;
    try { ast = parse(sources[path]); }
    catch (e) { throw buildError('E001', `parse error: ${e.message}`, { file: path, line: e.loc ? e.loc.line : 0, col: e.loc ? e.loc.column : 0 }); }

    const dyn = findDynamicImport(ast);
    if (dyn) throw buildError('E006', `dynamic import() not allowed`, astLoc(path, dyn));

    if (doLint) lintModule(ast, path, warnings);

    const imports = extractImports(ast);
    const exports = extractExports(ast);

    const internalImportBindings = []; // { local, source(path), imported, kind }
    const externalImports = [];        // { local, source(spec), imported, kind, node }
    const namespaceImports = [];       // { local, source(path) } — internal `import * as ns`
    const internalDeps = [];           // resolved paths, in body order

    // classify imports (body-order via ast.body for deterministic dep order)
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        const spec = node.source.value;
        // default import banned (SPEC §3.1)
        for (const s of node.specifiers) {
          if (s.type === 'ImportDefaultSpecifier') {
            throw buildError('E005', `default imports are not allowed ('${spec}')`, astLoc(path, node));
          }
        }
        const c = classify(spec, path, srcRoot, sources, astLoc(path, node), clsOpts);
        if (c.kind === 'internal') {
          internalDeps.push(c.path);
          for (const s of node.specifiers) {
            if (s.type === 'ImportNamespaceSpecifier') {
              namespaceImports.push({ local: s.local.name, source: c.path });
              continue;
            }
            internalImportBindings.push({
              local: s.local.name,
              source: c.path,
              imported: s.imported ? (s.imported.name || s.imported.value) : null,
              kind: 'named',
            });
          }
        } else {
          for (const s of node.specifiers) {
            externalImports.push({
              local: s.local.name,
              source: spec,
              imported: s.type === 'ImportNamespaceSpecifier' ? '*' : (s.imported ? (s.imported.name || s.imported.value) : null),
              kind: s.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'named',
              node,
            });
          }
          if (node.specifiers.length === 0) {
            externalImports.push({ local: null, source: spec, imported: null, kind: 'side-effect', node });
          }
        }
      } else if (node.type === 'ExportAllDeclaration') {
        const c = classify(node.source.value, path, srcRoot, sources, astLoc(path, node), clsOpts);
        if (c.kind === 'internal') internalDeps.push(c.path);
      } else if (node.type === 'ExportDefaultDeclaration') {
        throw buildError('E005', `'export default' is not allowed in sources`, astLoc(path, node));
      } else if (node.type === 'ExportNamedDeclaration' && node.source) {
        const c = classify(node.source.value, path, srcRoot, sources, astLoc(path, node), clsOpts);
        if (c.kind === 'internal') internalDeps.push(c.path);
      }
    }

    // own top-level bindings (declared names; NOT import locals). Namespace
    // imports synthesize a real `const ns = ...`, so they're owned bindings too.
    const ownBindings = new Set();
    for (const node of ast.body) {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (!decl) continue;
      for (const nm of declaredNames(decl)) ownBindings.add(nm);
    }
    for (const ns of namespaceImports) ownBindings.add(ns.local);

    const { shared: sharedNames, verbatimRanges } = collectAnnotations(ast, sources[path]);

    const mod = { path, source: sources[path], ast, imports, exports, internalImportBindings, externalImports, namespaceImports, internalDeps, ownBindings, sharedNames, verbatimRanges, basename: baseOf(path) };
    byPath.set(path, mod);
    return mod;
  }

  // ── manifest walk: post-order DFS (deps before dependents) ─────────
  const order = [];
  const visited = new Set();
  const onstack = new Set();
  (function visit(path) {
    if (visited.has(path)) return;
    if (onstack.has(path)) throw buildError('E013', `circular import involving '${path}'`, { file: path, line: 0, col: 0 });
    onstack.add(path);
    const mod = load(path);
    for (const dep of mod.internalDeps) visit(dep);
    onstack.delete(path);
    visited.add(path);
    order.push(mod);
  })(entry);

  // ── rename-on-collision ───────────────────────────────────────────
  const { renames, warnings: rcWarnings } = renameCollisions(order);
  for (const w of rcWarnings) warnings.push(w);
  const outputName = (mod, name) => {
    const mm = renames.get(mod);
    return (mm && mm.get(name)) || name;
  };

  // Resolve an exported name of an internal module to its final output binding,
  // following re-exports and import-internal aliases.
  function resolveTarget(modPath, name, seen = new Set()) {
    const key = modPath + '::' + name;
    if (seen.has(key)) return name;
    seen.add(key);
    const mod = byPath.get(modPath);
    if (!mod) return name;
    if (mod.ownBindings.has(name)) return outputName(mod, name);
    const imp = mod.internalImportBindings.find((b) => b.local === name);
    if (imp) return resolveTarget(imp.source, imp.imported, seen);
    const ext = mod.externalImports.find((b) => b.local === name);
    if (ext) return outputName(mod, name);
    for (const ex of mod.exports) {
      if (ex.kind === 'reexport-named') {
        const m = ex.specifiers.find((s) => s.exported === name);
        if (m) {
          const c = classify(ex.source, modPath, srcRoot, sources, null, clsOpts);
          if (c.kind === 'internal') return resolveTarget(c.path, m.local, seen);
          return name; // re-export from external — leave as-is
        }
      }
    }
    return name;
  }

  // Enumerate a module's public export surface as ordered { exported, internal }
  // pairs, following declarations, named exports, named re-exports, and `export *`
  // (with ESM precedence: direct exports shadow `export *`; star ambiguity → W002).
  function exportsOf(modPath, seen = new Set()) {
    if (seen.has(modPath)) return [];
    seen.add(modPath);
    const mod = byPath.get(modPath);
    if (!mod) return [];
    const direct = new Map();        // exported → internal
    const star = new Map();          // exported → Set(internal)
    for (const node of mod.ast.body) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          for (const nm of declaredNames(node.declaration)) direct.set(nm, outputName(mod, nm));
        } else if (node.source) {
          const c = classify(node.source.value, modPath, srcRoot, sources, null, clsOpts);
          for (const s of node.specifiers) {
            const exported = s.exported.name || s.exported.value;
            const local = s.local.name || s.local.value;
            direct.set(exported, c.kind === 'internal' ? resolveTarget(c.path, local) : local);
          }
        } else {
          for (const s of node.specifiers) {
            const exported = s.exported.name || s.exported.value;
            const local = s.local.name || s.local.value;
            direct.set(exported, resolveTarget(modPath, local));
          }
        }
      } else if (node.type === 'ExportAllDeclaration') {
        if (node.exported) continue; // `export * as ns` — namespace re-export, deferred
        const c = classify(node.source.value, modPath, srcRoot, sources, null, clsOpts);
        if (c.kind !== 'internal') continue; // external `export *` — not enumerable
        for (const e of exportsOf(c.path, seen)) {
          let set = star.get(e.exported);
          if (!set) star.set(e.exported, (set = new Set()));
          set.add(e.internal);
        }
      }
    }
    const out = [];
    for (const [exported, internal] of direct) out.push({ exported, internal });
    for (const [exported, set] of star) {
      if (direct.has(exported)) continue; // direct export wins
      if (set.size > 1) { warnings.push({ code: 'W002', message: `ambiguous 'export *' re-export of '${exported}' in ${modPath}` }); continue; }
      out.push({ exported, internal: [...set][0] });
    }
    return out;
  }

  // define names collide with any owning module (SPEC §10).
  for (const name of defineMap.keys()) {
    for (const mod of order) {
      if (mod.ownBindings.has(name)) {
        throw buildError('E007', `define '${name}' collides with a top-level declaration in ${mod.path}`, null);
      }
    }
  }

  // ── per-module rewrite ─────────────────────────────────────────────
  const hoistNamed = new Map();   // source → Map(specText → true) preserving order
  const hoistSideEffect = [];     // sources, first-appearance order
  const hoistVerbatim = [];       // verbatim lines (namespace/other external), deduped
  const seenSideEffect = new Set();
  const seenVerbatim = new Set();

  const moduleOut = [];
  for (const mod of order) {
    const isEntry = mod.path === entry;
    const patches = [];

    // build per-module reference rename map + topNames
    const renameMap = new Map();
    const ownRenames = renames.get(mod) || new Map();
    for (const [nm, nn] of ownRenames) renameMap.set(nm, nn);
    const topNames = new Set(mod.ownBindings);
    for (const b of mod.internalImportBindings) {
      topNames.add(b.local);
      const target = resolveTarget(b.source, b.imported);
      if (target !== b.local) renameMap.set(b.local, target);
    }
    for (const b of mod.externalImports) {
      if (!b.local) continue;
      topNames.add(b.local);
      const on = outputName(mod, b.local);
      if (on !== b.local) renameMap.set(b.local, on);
    }

    // structural patches: imports, exports, decl-site renames
    for (const node of mod.ast.body) {
      if (node.type === 'ImportDeclaration') {
        patches.push(stmtDelete(node, mod.source));
        const spec = node.source.value;
        const c = classify(spec, mod.path, srcRoot, sources, null, clsOpts);
        if (c.kind === 'external') {
          const out = c.out; // specifier rewritten for the output location
          if (node.specifiers.length === 0) {
            if (!seenSideEffect.has(out)) { seenSideEffect.add(out); hoistSideEffect.push(out); }
          } else if (node.specifiers.some((s) => s.type === 'ImportNamespaceSpecifier' || s.type === 'ImportDefaultSpecifier')) {
            // verbatim slice, but with the source specifier rewritten for the output location
            const text = mod.source.slice(node.start, node.source.start) + `'${out}'` + mod.source.slice(node.source.end, node.end);
            if (!seenVerbatim.has(text)) { seenVerbatim.add(text); hoistVerbatim.push(text); }
          } else {
            let m = hoistNamed.get(out);
            if (!m) hoistNamed.set(out, (m = new Map()));
            for (const s of node.specifiers) {
              const imported = s.imported.name || s.imported.value;
              const localOut = outputName(mod, s.local.name);
              const t = imported === localOut ? imported : `${imported} as ${localOut}`;
              m.set(t, true);
            }
          }
        }
        continue;
      }

      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          patches.push(exportPrefixStrip(node));
          declSitePatches(node.declaration, ownRenames, patches);
        } else {
          patches.push(stmtDelete(node, mod.source));
        }
        continue;
      }

      if (node.type === 'ExportAllDeclaration') {
        patches.push(stmtDelete(node, mod.source));
        continue;
      }

      // plain top-level declaration → decl-site renames only
      declSitePatches(node, ownRenames, patches);
    }

    // reference rename patches (scope-aware) + define substitution. @bundle-verbatim
    // declaration bodies are emitted unchanged — drop patches landing inside them
    // (decl-site renames, pushed above, are kept so collisions still resolve).
    const inVerbatim = (p) => mod.verbatimRanges.some(([s, e]) => p.start >= s && p.end <= e);
    for (const p of collectRenamePatches(mod.ast, renameMap, topNames)) if (!inVerbatim(p)) patches.push(p);
    for (const p of collectDefinePatches(mod.ast, defineMap)) if (!inVerbatim(p)) patches.push(p);

    let body = applyPatches(mod.source, patches).replace(/^\n+/, '').replace(/\n+$/, '');

    // synthesize frozen namespace objects for internal `import * as ns` (SPEC §7.3)
    if (mod.namespaceImports.length) {
      const synth = mod.namespaceImports.map((ns) => {
        const props = exportsOf(ns.source)
          .map((e) => (e.exported === e.internal ? e.exported : `${e.exported}: ${e.internal}`))
          .join(', ');
        return `const ${outputName(mod, ns.local)} = Object.freeze({ ${props} });`;
      });
      body = synth.join('\n') + '\n' + body;
    }

    moduleOut.push({ path: mod.path, body });
  }

  // entry export surface (declarations, named, re-exports, export *) — SPEC §7.7
  const exportEntries = exportsOf(entry);

  // ── assemble ───────────────────────────────────────────────────────
  const pkgName = opts.packageName || '';
  const pkgDesc = opts.packageDesc || '';
  const defaultHeader =
    `// ⚠ GENERATED FILE — DO NOT EDIT. Source: ${srcRoot}/  Build: @gcu/build ${entry}\n` +
    (pkgName ? `// ${pkgName}${pkgDesc ? ' — ' + pkgDesc : ''}\n` : '');
  const header = opts.header != null ? opts.header : defaultHeader;

  const lines = [];
  lines.push(header.replace(/\n+$/, ''));
  lines.push('');

  // hoisted external imports
  const importLines = [];
  for (const spec of hoistSideEffect) importLines.push(`import '${spec}';`);
  for (const [spec, m] of hoistNamed) {
    importLines.push(`import { ${[...m.keys()].join(', ')} } from '${spec}';`);
  }
  for (const text of hoistVerbatim) importLines.push(text);
  if (importLines.length) { lines.push(importLines.join('\n')); lines.push(''); }

  for (const mod of moduleOut) {
    lines.push(`// ── ${mod.path} ──`);
    lines.push('');
    lines.push(mod.body);
    lines.push('');
  }

  if (exportEntries.length) {
    const body = exportEntries
      .map((e) => (e.exported === e.internal ? `  ${e.exported},` : `  ${e.internal} as ${e.exported},`))
      .join('\n');
    lines.push(`export {\n${body}\n};`);
    lines.push('');
  }

  const code = lines.join('\n');

  // ── meta.json (SPEC §12) ───────────────────────────────────────────
  const enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  const byteLen = (s) => enc ? enc.encode(s).length : s.length;
  // group colliding modules per original name (for the renames detail).
  const collidingByName = new Map();
  for (const [mod, mm] of renames) {
    for (const name of mm.keys()) {
      let arr = collidingByName.get(name);
      if (!arr) collidingByName.set(name, (arr = []));
      arr.push(mod.path);
    }
  }
  const metaRenames = [];
  for (const [mod, mm] of renames) {
    for (const [original, renamed] of mm) {
      metaRenames.push({ original, renamed, module: mod.path, reason: 'collision', collidingModules: collidingByName.get(original) || [] });
    }
  }
  const meta = {
    entry,
    package: pkgName || null,
    version: opts.version || null,
    modules: order.map((m) => ({
      path: m.path,
      bytes: byteLen(m.source),
      lines: m.source.split('\n').length,
      exports: exportsOf(m.path).map((e) => e.exported),
    })),
    renames: metaRenames,
    shared: [],
    exports: exportEntries.map((e) => e.exported),
    warnings,
    bundleSize: byteLen(code),
    bundleHash: null, // filled by the adapter that has a hash primitive
  };

  return { code, map: null, meta, warnings };
}

export { renameCollisions };
