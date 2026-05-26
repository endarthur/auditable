import { S } from './state.js';
import { buildDAG } from './dag.js';
import * as hooks from './hooks.js';

// ── EXTENSION REGISTRY ──
//
// Single canonical API for everything an extension contributes:
// cell types, tagged languages, AIR lowerers, cross-language exports,
// cell-context hooks, plus plugin metadata. Replaces 4–6 scattered
// register* calls per extension with one `registerExtension(manifest)`.
//
// Storage: `window._cellTypes`, `window._taggedLanguages`,
// `window._auditableExtensions`, `window._auditablePlugins` are kept
// as the underlying maps (consumers in src/js/ still read them directly
// in some hot paths). The new API is the canonical *write* path; reads
// should prefer getCellType / getTaggedLanguage / getExports.
//
// Built-in cell types (code, md, css, html) are auto-registered as
// manifests at module load so listExtensions() / getCellType() return
// truthful results uniformly.

const _builtinTypes = new Set(['code', 'md', 'css', 'html']);

// Underlying registries (legacy; kept for hot-path readers)
window._cellTypes = window._cellTypes || {};
window._taggedLanguages = window._taggedLanguages || {};
window._auditableExtensions = window._auditableExtensions || {};
window._auditablePlugins = window._auditablePlugins || new Map();

// New manifest registry (name → manifest)
const _manifests = new Map();

// pluginUrl → Set<cellType-name>  (for uninstall tracking)
const _pluginCellTypes = new Map();

const _SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

// ── Semver range subset (EXTENSION_SPEC.md §2.4) ──
//
// Intentionally a small subset of node-semver: exact, >=, >, ^, ~, *,
// plus x-ranges (`0.x`, `1.2.x`). Disjunctions and AND-combinations
// are deliberately unsupported — if you need them, your extension is
// too coupled to its deps.
//
// x-range semantics match node-semver:
//   `<n>.x` / `<n>.x.x`  →  ^<n>.0.0   (any version in that major)
//   `<n>.<m>.x`          →  ~<n>.<m>.0 (any patch in that minor)
//   `>=<n>.x`            →  >=<n>.0.0  (lower bound only; no upper)
//   `>=<n>.<m>.x`        →  >=<n>.<m>.0

function _parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
  if (!m) return null;
  return [+m[1], +m[2], +m[3]];
}

function _cmpSemver(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

// Parse a range string into { op, target }; return null if unrecognized.
function _parseRange(range) {
  if (typeof range !== 'string') return null;
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') {
    return { op: '*', target: null };
  }

  let op = '=';
  let rest = trimmed;
  if (rest.startsWith('>=')) { op = '>='; rest = rest.slice(2); }
  else if (rest.startsWith('>'))  { op = '>';  rest = rest.slice(1); }
  else if (rest.startsWith('^'))  { op = '^';  rest = rest.slice(1); }
  else if (rest.startsWith('~'))  { op = '~';  rest = rest.slice(1); }
  else if (rest.startsWith('='))  { op = '=';  rest = rest.slice(1); }
  rest = rest.trim();

  // x-range expansion. Bare `<n>.x` is caret-equivalent; bare `<n>.<m>.x` is
  // tilde-equivalent. With a `>=` or `>` prefix, the x is treated as 0 and
  // the upper bound implied by x-range is dropped (the prefix wins).
  const xFull  = /^(\d+)\.([xX*])(?:\.[xX*])?$/.exec(rest);
  const xMinor = /^(\d+)\.(\d+)\.([xX*])$/.exec(rest);
  if (xFull) {
    const target = [+xFull[1], 0, 0];
    return { op: op === '=' ? '^' : op, target };
  }
  if (xMinor) {
    const target = [+xMinor[1], +xMinor[2], 0];
    return { op: op === '=' ? '~' : op, target };
  }

  const target = _parseSemver(rest);
  if (!target) return null;
  return { op, target };
}

function _satisfiesRange(version, range) {
  const parsed = _parseRange(range);
  if (!parsed) return false;
  if (parsed.op === '*') return true;

  const v = _parseSemver(version);
  if (!v) return false;
  const cmp = _cmpSemver(v, parsed.target);

  switch (parsed.op) {
    case '=':  return cmp === 0;
    case '>':  return cmp > 0;
    case '>=': return cmp >= 0;
    case '^':  return cmp >= 0 && v[0] === parsed.target[0];
    case '~':  return cmp >= 0 && v[0] === parsed.target[0] && v[1] === parsed.target[1];
    default:   return false;
  }
}

// Walk a manifest's requires map; throw on the first missing or out-of-range
// dependency. Returns silently when every dep is satisfied (or none declared).
function _checkRequires(manifest) {
  const req = manifest.requires;
  if (!req || typeof req !== 'object') return;
  for (const [name, range] of Object.entries(req)) {
    const dep = _manifests.get(name);
    if (!dep) {
      throw new Error(
        `registerExtension: "${manifest.name}" requires "${name}" ${range} but it is not registered`
      );
    }
    if (!_satisfiesRange(dep.version, range)) {
      throw new Error(
        `registerExtension: "${manifest.name}" requires "${name}" ${range} but ${dep.version} is registered`
      );
    }
  }
}

// ── Validation ──

function _validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('registerExtension: manifest must be an object');
  if (typeof m.name !== 'string' || !m.name) throw new Error('registerExtension: manifest.name is required');
  if (typeof m.version !== 'string' || !_SEMVER_RE.test(m.version)) {
    throw new Error(`registerExtension: manifest.version "${m.version}" must be semver (\\d+.\\d+.\\d+)`);
  }
  if (m.cellType) {
    const ct = m.cellType;
    if (typeof ct.name !== 'string' || !ct.name) throw new Error('registerExtension: cellType.name is required');
    if (_builtinTypes.has(ct.name) && !ct.capabilities?.builtin) {
      throw new Error(`registerExtension: built-in cell type "${ct.name}" cannot be shadowed`);
    }
    if (!ct.capabilities || typeof ct.capabilities !== 'object') {
      throw new Error(`registerExtension: cellType.capabilities is required`);
    }
    // Built-in cell types are dispatched via hardcoded paths in exec.js, so
    // they don't require execute()/parseNames() — capabilities describe them
    // for uniform queries, not for plugin-style dispatch.
    if (!ct.capabilities.builtin) {
      if (ct.capabilities.executable && typeof ct.execute !== 'function') {
        throw new Error(`registerExtension: cellType "${ct.name}" declares executable: true but provides no execute()`);
      }
      if (ct.capabilities.definesScope && typeof ct.parseNames !== 'function') {
        throw new Error(`registerExtension: cellType "${ct.name}" declares definesScope: true but provides no parseNames()`);
      }
    }
  }
  if (m.taggedLanguage) {
    const tl = m.taggedLanguage;
    if (typeof tl.name !== 'string' || !tl.name) throw new Error('registerExtension: taggedLanguage.name is required');
    if (typeof tl.tokenize !== 'function') throw new Error(`registerExtension: taggedLanguage "${tl.name}" requires tokenize()`);
  }
  if (m.taggedLanguages) {
    if (!Array.isArray(m.taggedLanguages)) throw new Error('registerExtension: taggedLanguages must be an array');
    for (const tl of m.taggedLanguages) {
      if (typeof tl.name !== 'string' || !tl.name) throw new Error('registerExtension: taggedLanguages[].name is required');
      if (typeof tl.tokenize !== 'function') throw new Error(`registerExtension: taggedLanguages "${tl.name}" requires tokenize()`);
    }
  }
  if (m.airLowerer) {
    if (typeof m.airLowerer.language !== 'string') throw new Error('registerExtension: airLowerer.language is required');
    if (typeof m.airLowerer.fn !== 'function') throw new Error('registerExtension: airLowerer.fn is required');
  }
  if (m.contextHook && typeof m.contextHook.setup !== 'function') {
    throw new Error('registerExtension: contextHook.setup must be a function');
  }
  // Surface contributions — EXTENSION_SPEC §3.8.1. Shape-validated even
  // outside Works (the registrar no-ops the registration in standalone
  // auditable, but the schema lint still fires). Per-field rules mirror
  // the spec's "Field rules" subsection.
  if (m.surfaces !== undefined) {
    if (!Array.isArray(m.surfaces)) {
      throw new Error('registerExtension: manifest.surfaces must be an array');
    }
    const seenKinds = new Set();
    for (const s of m.surfaces) {
      if (!s || typeof s !== 'object') throw new Error('registerExtension: surfaces[] entries must be objects');
      if (typeof s.kind !== 'string' || !s.kind) {
        throw new Error('registerExtension: surfaces[].kind is required');
      }
      if (seenKinds.has(s.kind)) {
        throw new Error(`registerExtension: surfaces[] declares kind "${s.kind}" twice in the same manifest`);
      }
      seenKinds.add(s.kind);
      if (typeof s.file !== 'string' || !s.file) {
        throw new Error(`registerExtension: surfaces["${s.kind}"].file is required`);
      }
      if (s.extensions !== undefined && !Array.isArray(s.extensions)) {
        throw new Error(`registerExtension: surfaces["${s.kind}"].extensions must be an array`);
      }
      if (s.extensions) {
        for (const ext of s.extensions) {
          if (typeof ext !== 'string' || !ext.startsWith('.')) {
            throw new Error(`registerExtension: surfaces["${s.kind}"].extensions must be dot-prefixed strings (got ${JSON.stringify(ext)})`);
          }
        }
      }
      if (s.detect !== undefined && typeof s.detect !== 'function') {
        throw new Error(`registerExtension: surfaces["${s.kind}"].detect must be a function`);
      }
      if (s.requires !== undefined && !Array.isArray(s.requires)) {
        throw new Error(`registerExtension: surfaces["${s.kind}"].requires must be an array of shared-lib names`);
      }
    }
  }
  // Context-menu contributions — EXTENSION_SPEC §3.8.2.
  if (m.contextMenu !== undefined) {
    if (!Array.isArray(m.contextMenu)) {
      throw new Error('registerExtension: manifest.contextMenu must be an array');
    }
    for (const item of m.contextMenu) {
      if (!item || typeof item !== 'object') throw new Error('registerExtension: contextMenu[] entries must be objects');
      if (typeof item.label !== 'string' || !item.label) {
        throw new Error('registerExtension: contextMenu[].label is required');
      }
      if (item.scope !== undefined && !['file', 'folder', 'project'].includes(item.scope)) {
        throw new Error(`registerExtension: contextMenu["${item.label}"].scope must be one of: file, folder, project (got ${JSON.stringify(item.scope)})`);
      }
      if (item.filter !== undefined && typeof item.filter !== 'function') {
        throw new Error(`registerExtension: contextMenu["${item.label}"].filter must be a function`);
      }
      if (typeof item.action !== 'function') {
        throw new Error(`registerExtension: contextMenu["${item.label}"].action must be a function`);
      }
    }
  }
  if (m.requires !== undefined) {
    if (m.requires === null || typeof m.requires !== 'object' || Array.isArray(m.requires)) {
      throw new Error('registerExtension: manifest.requires must be an object mapping names to range strings');
    }
    for (const [name, range] of Object.entries(m.requires)) {
      if (typeof range !== 'string' || !range) {
        throw new Error(`registerExtension: requires["${name}"] must be a non-empty range string`);
      }
      if (!_parseRange(range)) {
        throw new Error(`registerExtension: requires["${name}"] = "${range}" is not a recognized range (expected one of: 1.2.3, >=1.2.3, >1.2.3, ^1.2.3, ~1.2.3, 0.x, 1.2.x, *)`);
      }
    }
  }
}

// Project a manifest's surface + contextMenu contributions into a
// JSON-clone-safe slice — function values (detect, filter, action) are
// stripped so the manifest survives the A-Bus structured clone. The
// shell uses this for declarative registration; live JS callbacks stay
// in the originating window's local registration (cell-types.js
// keeps the full manifest in _manifests).
function _stripJsCallbacks(manifest) {
  const out = { name: manifest.name, version: manifest.version };
  if (Array.isArray(manifest.surfaces)) {
    out.surfaces = manifest.surfaces.map((s) => ({
      kind:        s.kind,
      label:       s.label,
      icon:        s.icon,
      file:        s.file,
      extensions:  s.extensions || [],
      requires:    s.requires || null,
      openAction:  !!s.openAction,
    }));
  }
  if (Array.isArray(manifest.contextMenu)) {
    out.contextMenu = manifest.contextMenu.map((it) => ({
      label:   it.label,
      scope:   it.scope || 'file',
      icon:    it.icon || null,
      section: it.section || null,
    }));
  }
  return out;
}

// ── Public API: registerExtension ──

export function registerExtension(manifest) {
  _validateManifest(manifest);
  // Cross-extension dependency check — spec §2.3 step 1. Fail-fast before
  // any contribution is wired so a missing dep can't leave half-registered
  // state behind. A silently-missing dep would be the worst plugin-ecosystem
  // debug mode imaginable.
  _checkRequires(manifest);

  const existing = _manifests.get(manifest.name);
  if (existing) {
    console.warn(`[auditable] extension "${manifest.name}" already registered, replacing`);
    _unregisterContributions(existing);
  }
  _manifests.set(manifest.name, manifest);

  // Apply contributions to underlying registries.
  if (manifest.cellType) _applyCellType(manifest);
  if (manifest.taggedLanguage) _applyTaggedLanguage(manifest.taggedLanguage);
  if (manifest.taggedLanguages) {
    for (const tl of manifest.taggedLanguages) _applyTaggedLanguage(tl);
  }
  if (manifest.airLowerer && window._airRegisterLowerer) {
    window._airRegisterLowerer(manifest.airLowerer.language, manifest.airLowerer.fn);
  }
  if (manifest.exports) {
    for (const [k, v] of Object.entries(manifest.exports)) {
      window._auditableExtensions[k] = v;
    }
  }
  if (manifest.globals) {
    for (const [k, v] of Object.entries(manifest.globals)) window[k] = v;
  }
  if (manifest.contextHook) {
    (window._cellContextHooks = window._cellContextHooks || []).push(manifest.contextHook);
  }
  // Surfaces + context-menu contributions are Works-host-only. Three
  // routing paths, exactly one fires per call. EXTENSION_SPEC §3.8.
  //
  //   1. window._worksRegisterExtensionSurfaces present → same-window
  //      (e.g. registerExtension called from a script running in the
  //      Works shell itself, future use case).
  //   2. window._worksBus present → cross-frame: forward to the works
  //      shell via A-Bus. This is the common case — the notebook
  //      iframe in Works boots with worksBoot stashing the bus, and
  //      every install() inside a notebook cell ends up here.
  //   3. Neither → standalone auditable. Silently no-op the surface
  //      registration. Schema has been validated above so a malformed
  //      manifest still throws.
  if (manifest.surfaces) {
    if (typeof window._worksRegisterExtensionSurfaces === 'function') {
      try { window._worksRegisterExtensionSurfaces(manifest); }
      catch (e) { console.error(`[auditable] surfaces registration for "${manifest.name}":`, e); }
    } else if (window._worksBus && typeof window._worksBus.call === 'function') {
      // Strip JS-only fields before posting (functions don't survive
      // structured clone). The shell re-binds to a stub with extension
      // routing only; detect callbacks won't fire until the live JS
      // also runs in the shell context (§3.8.9 known v1 limit).
      const safe = _stripJsCallbacks(manifest);
      window._worksBus.call(
        { to: 'works', path: '/', interface: 'Extension', member: 'Register' },
        [safe]
      ).catch((e) => console.error(`[auditable] bridging surfaces for "${manifest.name}":`, e));
    }
  }
  if (manifest.contextMenu) {
    if (typeof window._worksRegisterExtensionContextMenu === 'function') {
      try { window._worksRegisterExtensionContextMenu(manifest); }
      catch (e) { console.error(`[auditable] contextMenu registration for "${manifest.name}":`, e); }
    } else if (window._worksBus && typeof window._worksBus.call === 'function') {
      const safe = _stripJsCallbacks(manifest);
      // Same call wires both fields (the works service splits them on
      // its side), so we don't post twice when both surfaces and
      // contextMenu are present. Skip if we just posted above.
      if (!manifest.surfaces) {
        window._worksBus.call(
          { to: 'works', path: '/', interface: 'Extension', member: 'Register' },
          [safe]
        ).catch((e) => console.error(`[auditable] bridging contextMenu for "${manifest.name}":`, e));
      }
    }
  }
  if (manifest.description || manifest.pluginUrl) {
    window._auditablePlugins.set(manifest.pluginUrl || manifest.name, {
      description: manifest.description || '',
    });
  }

  if (typeof manifest.onActivate === 'function') {
    try { manifest.onActivate(); } catch (e) { console.error(`[auditable] onActivate for "${manifest.name}":`, e); }
  }
}

function _applyCellType(manifest) {
  const ct = manifest.cellType;

  // Built-ins are registered with capabilities.builtin = true; we still
  // populate _cellTypes for them so plugin-style code paths can find them.
  // Direct hardcoded checks (cell.type === 'code') still work as before.

  // Compose a handler-shaped object for compatibility with legacy readers.
  const handler = {
    label: ct.label || ct.name,
    color: ct.color,
    shortcut: ct.shortcut,
    editDebounce: ct.editDebounce,
    parseNames: ct.parseNames,
    findUses: ct.findUses,
    execute: ct.execute,
    createEditor: ct.createEditor,
    syntaxCheck: ct.syntaxCheck,
    completions: ct.completions,
    tokenize: ct.tokenize,
    indent: ct.indent,
    indentUnit: ct.indentUnit,
    capabilities: ct.capabilities,
    _manifest: manifest,
  };
  if (manifest.pluginUrl) handler._pluginUrl = manifest.pluginUrl;

  if (_builtinTypes.has(ct.name)) {
    // built-in: don't register into _cellTypes (which is for plugins),
    // but the manifest is reachable via getCellType('code') etc.
    return;
  }

  window._cellTypes[ct.name] = handler;
  if (manifest.pluginUrl) {
    let set = _pluginCellTypes.get(manifest.pluginUrl);
    if (!set) { set = new Set(); _pluginCellTypes.set(manifest.pluginUrl, set); }
    set.add(ct.name);
  }
  // activate any fallback cells of this type
  _ctActivatePendingCells(ct.name);
}

function _applyTaggedLanguage(tl) {
  // Pass through all fields except `name` so consumers (cm6, complete) see
  // the same shape as legacy `_taggedLanguages[x] = {...}` writes — including
  // optional fields like `sigHint`, `indent`, etc.
  const { name, ...rest } = tl;
  window._taggedLanguages[name] = rest;
}

function _unregisterContributions(manifest) {
  if (manifest.cellType && !_builtinTypes.has(manifest.cellType.name)) {
    delete window._cellTypes[manifest.cellType.name];
  }
  if (manifest.taggedLanguage) delete window._taggedLanguages[manifest.taggedLanguage.name];
  if (manifest.taggedLanguages) for (const tl of manifest.taggedLanguages) delete window._taggedLanguages[tl.name];
  if (manifest.exports) for (const k of Object.keys(manifest.exports)) delete window._auditableExtensions[k];
  // contextHook removal: filter out by reference
  if (manifest.contextHook && Array.isArray(window._cellContextHooks)) {
    const idx = window._cellContextHooks.indexOf(manifest.contextHook);
    if (idx >= 0) window._cellContextHooks.splice(idx, 1);
  }
  if (manifest.surfaces && typeof window._worksUnregisterExtensionSurfaces === 'function') {
    try { window._worksUnregisterExtensionSurfaces(manifest); } catch (e) { console.error(e); }
  } else if (manifest.surfaces && window._worksBus && typeof window._worksBus.call === 'function') {
    const safe = _stripJsCallbacks(manifest);
    window._worksBus.call(
      { to: 'works', path: '/', interface: 'Extension', member: 'Unregister' },
      [safe]
    ).catch((e) => console.error(`[auditable] bridging surface unregister for "${manifest.name}":`, e));
  }
  if (manifest.contextMenu && typeof window._worksUnregisterExtensionContextMenu === 'function') {
    try { window._worksUnregisterExtensionContextMenu(manifest); } catch (e) { console.error(e); }
  } else if (manifest.contextMenu && !manifest.surfaces && window._worksBus && typeof window._worksBus.call === 'function') {
    const safe = _stripJsCallbacks(manifest);
    window._worksBus.call(
      { to: 'works', path: '/', interface: 'Extension', member: 'Unregister' },
      [safe]
    ).catch((e) => console.error(`[auditable] bridging contextMenu unregister for "${manifest.name}":`, e));
  }
  if (typeof manifest.onDeactivate === 'function') {
    try { manifest.onDeactivate(); } catch (e) { console.error(`[auditable] onDeactivate for "${manifest.name}":`, e); }
  }
}

// ── Public API: lookup ──

export function getExtension(name) { return _manifests.get(name) || null; }
export function listExtensions() { return [..._manifests.values()]; }

export function getCellType(name) {
  // Built-ins are returned via their synthesized manifest's cellType field.
  for (const m of _manifests.values()) {
    if (m.cellType && m.cellType.name === name) return m.cellType;
  }
  // Fallback: legacy registerCellType call paths that haven't migrated
  const handler = window._cellTypes?.[name];
  if (handler) return _legacyHandlerToCellType(name, handler);
  return null;
}

function _legacyHandlerToCellType(name, handler) {
  // Synthesize a cellType view from a legacy handler object.
  return {
    name,
    label: handler.label,
    color: handler.color,
    shortcut: handler.shortcut,
    editDebounce: handler.editDebounce,
    parseNames: handler.parseNames,
    findUses: handler.findUses,
    execute: handler.execute,
    createEditor: handler.createEditor,
    syntaxCheck: handler.syntaxCheck,
    completions: handler.completions,
    tokenize: handler.tokenize,
    indent: handler.indent,
    indentUnit: handler.indentUnit,
    capabilities: handler.capabilities || {
      executable: !!handler.execute,
      definesScope: !!handler.parseNames,
      hasOutput: !!handler.execute,
      hasEditor: !!(handler.createEditor || handler.tokenize),
      builtin: false,
    },
  };
}

export function getTaggedLanguage(name) { return window._taggedLanguages?.[name] || null; }
export function getExports(name) { return window._auditableExtensions?.[name] || null; }
export function hasExports(name) { return !!(window._auditableExtensions && window._auditableExtensions[name]); }

// ── Capability checks (manifest-driven; legacy duck-typing kept as fallback) ──

/** Can be run via Ctrl+Enter, participates in reactive DAG execution. */
export function _ctIsExecutable(type) {
  return !!getCellType(type)?.capabilities?.executable;
}

/** Defines scope variables visible to downstream cells. */
export function _ctDefinesScope(type) {
  return !!getCellType(type)?.capabilities?.definesScope;
}

/** Has an output area for display/results. */
export function _ctHasOutput(type) {
  return !!getCellType(type)?.capabilities?.hasOutput;
}

/** Has a CM6 code editor (vs textarea fallback). */
export function _ctHasEditor(type) {
  return !!getCellType(type)?.capabilities?.hasEditor;
}

export function _ctIsBuiltin(type) { return _builtinTypes.has(type); }

export function _ctIsPlugin(type) {
  if (_builtinTypes.has(type)) return false;
  return !!window._cellTypes?.[type];
}

export function _ctIsFallback(cell) { return !!cell._fallback; }

export function _ctGetHandler(type) {
  return window._cellTypes?.[type] || null;
}

export function _ctAllTypeNames() {
  return [..._builtinTypes, ...Object.keys(window._cellTypes || {})];
}

export function _ctRegisteredTypes() {
  return Object.keys(window._cellTypes || {});
}

// ── Built-in cell type manifests ──
// Auto-registered at module load so getCellType('code') etc. return uniform results.

registerExtension({
  name: 'auditable:builtin/code',
  version: '1.0.0',
  cellType: {
    name: 'code',
    label: 'js',
    capabilities: { executable: true, definesScope: true, hasOutput: true, hasEditor: true, builtin: true },
  },
});
registerExtension({
  name: 'auditable:builtin/md',
  version: '1.0.0',
  cellType: {
    name: 'md',
    label: 'md',
    capabilities: { executable: false, definesScope: false, hasOutput: false, hasEditor: true, builtin: true },
  },
});
registerExtension({
  name: 'auditable:builtin/css',
  version: '1.0.0',
  cellType: {
    name: 'css',
    label: 'css',
    capabilities: { executable: false, definesScope: false, hasOutput: false, hasEditor: true, builtin: true },
  },
});
registerExtension({
  name: 'auditable:builtin/html',
  version: '1.0.0',
  cellType: {
    name: 'html',
    label: 'html',
    capabilities: { executable: true, definesScope: true, hasOutput: true, hasEditor: true, builtin: true },
  },
});

// (Legacy registerCellType / registerPlugin shims removed 2026-05-08 once all
// in-tree extensions migrated to registerExtension manifests. Pre-1.0 — no
// deprecation window. Re-add only if external consumers materialise.)

// ── Cell type activation (when a plugin loads after fallback cells exist) ──

function _ctActivatePendingCells(typeName) {
  const handler = window._cellTypes[typeName];
  if (!handler) return;

  let activated = false;
  for (const cell of S.cells) {
    if (cell.type === typeName && cell._fallback) {
      cell._fallback = false;
      activated = true;

      // update header label
      const labelEl = cell.el?.querySelector?.('.cell-type');
      if (labelEl) {
        labelEl.textContent = handler.label || typeName;
        if (handler.color) labelEl.style.color = handler.color;
      }

      // replace textarea with plugin editor if handler provides one
      if (handler.createEditor) {
        const codeWrap = cell.el?.querySelector?.('.cell-plugin-code');
        if (codeWrap) {
          const ta = codeWrap.querySelector('textarea');
          const debounce = handler.editDebounce || 300;
          const editorObj = handler.createEditor(cell, (newCode) => {
            cell.code = newCode;
            if (S.autorun) {
              clearTimeout(S.editTimer);
              if (handler.syntaxCheck) {
                const ok = handler.syntaxCheck(newCode);
                cell.el?.classList.toggle('syntax-pending', !ok);
                if (!ok) return;
                cell.el?.classList.remove('syntax-pending');
              }
              S.editTimer = setTimeout(() => {
                if (window._ctRunDAG) {
                  buildDAG();
                  window._ctRunDAG([cell.id]);
                }
              }, debounce);
            }
          });
          if (editorObj && editorObj.el) {
            if (ta) ta.remove();
            codeWrap.appendChild(editorObj.el);
            cell._pluginEditor = editorObj;
          }
        }
      }
    }
  }

  if (!activated) return;

  buildDAG();
  if (window._ctRunAll) window._ctRunAll();
}

// ── Plugin output rendering ──

export function _ctRenderOutput(cell, output) {
  const el = cell.el.querySelector('.cell-output');
  if (!el) return;
  el.className = 'cell-output';
  if (output === undefined || output === null) {
    el.textContent = '';
    return;
  }
  if (output instanceof Element || output instanceof DocumentFragment) {
    el.innerHTML = '';
    el.appendChild(output);
  } else if (typeof output === 'string') {
    el.textContent = output;
  } else {
    const pre = document.createElement('span');
    try { pre.textContent = JSON.stringify(output, null, 2); }
    catch { pre.textContent = String(output); }
    el.innerHTML = '';
    el.appendChild(pre);
  }
}

// ── Uninstall ──

export function _ctUninstallPlugin(url) {
  // Find any manifests with matching pluginUrl and remove them
  for (const [name, m] of [..._manifests.entries()]) {
    if (m.pluginUrl === url || name === url) {
      _unregisterContributions(m);
      _manifests.delete(name);
    }
  }

  // Revert any cells of removed types to fallback
  const types = _pluginCellTypes.get(url);
  if (types) {
    for (const name of types) {
      for (const cell of S.cells) {
        if (cell.type === name) {
          cell._fallback = true;
          if (cell._pluginEditor) {
            if (cell._pluginEditor.destroy) cell._pluginEditor.destroy();
            cell._pluginEditor = null;
          }
          const labelEl = cell.el.querySelector('.cell-type');
          if (labelEl) {
            labelEl.textContent = name + ' (not installed)';
            labelEl.style.color = '';
          }
          const codeWrap = cell.el.querySelector('.cell-plugin-code');
          if (codeWrap && !codeWrap.querySelector('textarea')) {
            const ta = document.createElement('textarea');
            ta.className = 'plugin-textarea';
            ta.rows = 4;
            ta.spellcheck = false;
            ta.value = cell.code;
            ta.addEventListener('input', () => { cell.code = ta.value; });
            codeWrap.insertBefore(ta, codeWrap.firstChild);
          }
        }
      }
    }
    _pluginCellTypes.delete(url);
  }

  window._auditablePlugins.delete(url);
  if (window._installedModules) delete window._installedModules[url];
  if (window._importCache) delete window._importCache[url];

  buildDAG();
}

