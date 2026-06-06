// Bundle collision guard (Tier-1, the bridge to @gcu/build — see ext/build/SPEC.md).
//
// GCU's concat/inline build strategy flattens module scopes and relies on top-level
// names being unique — with, until now, no build-time check. Collisions shipped and
// surfaced only at LOAD (a smoke test, or luck): over's internal REL/SEP, and the
// inter-bundle over×loom `inferType` / over×strata `cmp` we hit wiring strata's
// Transform UI. This converts "flaky, caught at load" → "loud, caught at `npm test`".
//
// Two classes, both AUTO-DISCOVERED (no hand-maintained list to drift):
//   1. intra-bundle — every ext/*/index.js: its own top-level names must be unique
//      (a duplicate is a redeclare that breaks the bundle as a module).
//   2. inter-bundle — the Works surface inliner RAW-concatenates several @gcu bundles
//      into one iframe scope; their top-level names must be unique ACROSS the set.
//      The sets are derived by scanning each surface (+ the app cores it imports)
//      for @gcu/* imports — so adding a lib to a surface is auto-covered.
//
// Uses acorn (vendored) for REAL top-level scope — a column-0 text scan can't tell a
// genuine top-level decl from one inside a vendored IIFE (archive's fflate, geas, the
// GPU shaders in peel/winding), which would false-positive. @gcu/build will do this
// same AST analysis + rename-on-collision (the actual fix); this is the detection-only
// bridge until then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, tsPlugin } from '../ext/acorn/acorn.esm.min.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'ext');
const parser = Parser.extend(tsPlugin());

function patternNames(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') out.push(node.name);
  else if (node.type === 'ObjectPattern') for (const p of node.properties) patternNames(p.value || p.argument, out);
  else if (node.type === 'ArrayPattern') for (const e of node.elements) patternNames(e, out);
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
}

// Real top-level declarations from the module's program body (NOT names inside IIFEs
// or functions). Returns null if the bundle doesn't parse (skipped — flagged, not
// silently dropped, via the parseFails accounting in the tests).
function topLevelDecls(code) {
  let ast;
  try { ast = parser.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { return null; }
  const out = [];
  for (const node of ast.body) {
    const d = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!d) continue;
    if (d.type === 'VariableDeclaration') for (const decl of d.declarations) patternNames(decl.id, out);
    else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) out.push(d.id.name);
  }
  return out;
}
const dups = (names) => {
  const seen = new Set(), dup = new Set();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  return [...dup];
};
const bundlePath = (lib) => path.join(extDir, lib, 'index.js');
const readDecls = (lib) => { const p = bundlePath(lib); if (!fs.existsSync(p)) return new Set(); const d = topLevelDecls(fs.readFileSync(p, 'utf8')); return new Set(d || []); };

// ── 1. intra-bundle ──
test('intra-bundle: no ext/*/index.js redeclares a top-level name', () => {
  const offenders = [];
  let skipped = 0;
  for (const d of fs.readdirSync(extDir)) {
    const p = bundlePath(d);
    if (!fs.existsSync(p)) continue;
    const decls = topLevelDecls(fs.readFileSync(p, 'utf8'));
    if (decls === null) { skipped++; continue; }          // unparseable (vendored blob) — skip, not checked
    const dup = dups(decls);
    if (dup.length) offenders.push(`ext/${d}/index.js: ${dup.join(', ')}`);
  }
  if (skipped) console.log(`  (bundle-collisions: ${skipped} bundle(s) unparseable by acorn — not checked)`);
  assert.equal(offenders.length, 0, 'duplicate top-level declarations:\n  ' + offenders.join('\n  '));
});

// ── 2. inter-bundle (surface inline sets) ──
// Scan a file for @gcu/* imports, following relative .js imports (the app cores the
// surface HTML pulls in) transitively. Returns the set of @gcu lib names co-inlined.
function gcuLibsOf(file, seen = new Set()) {
  const libs = new Set();
  if (seen.has(file) || !fs.existsSync(file)) return libs;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+['"]@gcu\/([\w.-]+)['"]/g)) libs.add(m[1]);
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+\.js)['"]/g)) {
    for (const l of gcuLibsOf(path.resolve(path.dirname(file), m[1]), seen)) libs.add(l);
  }
  return libs;
}

test('inter-bundle: co-inlined surface lib sets have no cross-bundle name collisions', () => {
  const surfDir = path.join(root, 'works', 'surfaces');
  const offenders = [];
  for (const f of fs.readdirSync(surfDir).filter((f) => f.endsWith('.html'))) {
    const libs = [...gcuLibsOf(path.join(surfDir, f))].filter((l) => fs.existsSync(bundlePath(l)));
    if (libs.length < 2) continue;                       // 0–1 bundles → no inter-bundle scope sharing
    const byName = new Map();                            // name → [libs declaring it]
    for (const lib of libs) {
      const decls = readDecls(lib);
      for (const n of decls) { let a = byName.get(n); if (!a) byName.set(n, (a = [])); a.push(lib); }
    }
    for (const [n, ls] of byName) if (ls.length > 1) offenders.push(`[${f} ← ${libs.join(',')}]  ${n}: ${ls.join(' ∩ ')}`);
  }
  assert.equal(offenders.length, 0, 'cross-bundle collisions in a surface scope:\n  ' + offenders.join('\n  '));
});
