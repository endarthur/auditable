// Async renderer — walks an AST, resolves each template node against the VFS,
// dispatches the filter chain, splices the result into the output. Pure
// orchestration; no DOM, no file-extension knowledge beyond what the filter
// registry encodes.
//
// Cycle detection: opts.visited is a Set<absolutePath> that carries across
// nested renders (when a filter recursively templates a piece of content).
// The renderer enforces this for direct file-inclusion cycles; render-chain
// cycles where filter output feeds back into a different file are the
// consumer's problem (we don't track output paths, only inputs).
//
// Dependency reporting: every VFS read fires opts.onDependency(absolutePath).
// Consumers wire this to subscribe to VFS.Changed and trigger re-render.

import { extOf, isBinaryExt } from './util.js';
import { lookupFilter } from './filters.js';

export class TemplateRenderError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'TemplateRenderError';
    this.path = path;
  }
}

export class TemplateCycleError extends TemplateRenderError {
  constructor(chain) {
    super('template cycle: ' + chain.join(' → '), chain[chain.length - 1]);
    this.name = 'TemplateCycleError';
    this.chain = chain;
  }
}

// Resolve a path token from the template against the consumer's cwd.
// Absolute paths (leading '/') are taken as-is. Relative paths are joined
// to cwd. The result is normalized — './x' or '../x' segments resolved.
export function resolvePath(rawPath, cwd) {
  if (rawPath.startsWith('/')) return _normalize(rawPath);
  const base = cwd && cwd !== '/' ? cwd : '';
  return _normalize(base + '/' + rawPath);
}

function _normalize(p) {
  const parts = p.split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

// Render one template directive. Reads the file (text or bytes by extension),
// runs the filter chain, returns the final value. May recursively re-render
// if a filter returns a result that itself contains template syntax — that's
// not implemented in v1 (filters return final values).
async function _renderNode(node, opts) {
  const abs = resolvePath(node.path, opts.cwd);
  if (opts.visited.has(abs)) {
    throw new TemplateCycleError([...opts.visited, abs]);
  }
  if (typeof opts.onDependency === 'function') opts.onDependency(abs);

  const ext = extOf(abs);
  let content;
  try {
    if (isBinaryExt(ext)) {
      content = await opts.vfs.readFile(abs, 'bytes');
    } else {
      content = await opts.vfs.readFile(abs, 'text');
    }
  } catch (e) {
    if (opts.onMissing) return opts.onMissing(abs, e);
    return `<span class="tpl-missing" title="${_escAttr(e.message || 'missing')}">⌽ ${_escText(abs)}</span>`;
  }

  // Filter chain. First filter receives the raw content; each subsequent
  // filter receives the previous filter's return value. If no filters were
  // declared, apply the per-extension default.
  let current = content;
  opts.visited.add(abs);
  try {
    if (node.filters.length === 0) {
      // No filters declared — apply the per-extension `default` filter,
      // consulting opts.filters first so consumers can override how a
      // bare {{file.md}} renders without touching the global registry.
      const fn = _resolveFilter(ext, 'default', opts);
      if (fn) current = await fn(current);
    } else {
      for (const f of node.filters) {
        const fn = _resolveFilter(ext, f.name, opts);
        if (!fn) {
          throw new TemplateRenderError(
            `unknown filter "${f.name}" for ${ext || '(no ext)'} in {{${node.path}}}`, abs);
        }
        current = await fn(current, ...f.args);
      }
    }
  } finally {
    opts.visited.delete(abs);
  }
  return typeof current === 'string' ? current : String(current);
}

function _resolveFilter(ext, name, opts) {
  // Per-call overrides win over the global registry — lets a consumer surface
  // (doc, sheet, deck) inject its own renderer-aware filter for .md without
  // mutating the global table.
  if (opts.filters) {
    const byExt = opts.filters[ext];
    if (byExt && byExt[name]) return byExt[name];
    const byStar = opts.filters['*'];
    if (byStar && byStar[name]) return byStar[name];
  }
  return lookupFilter(ext, name);
}

function _escText(s) {
  return String(s).replace(/[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function _escAttr(s) {
  return String(s).replace(/["&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Render a full AST to a single string. Literal and opaque nodes pass through
// verbatim (opaque values are NEVER re-scanned — that's the safety guarantee
// for tagged-template-literal use). Template nodes go through _renderNode.
export async function render(ast, opts = {}) {
  const ctx = {
    vfs: opts.vfs,
    cwd: opts.cwd || '/',
    filters: opts.filters,
    onMissing: opts.onMissing,
    onDependency: opts.onDependency,
    visited: opts.visited || new Set(),
  };
  if (!ctx.vfs) {
    throw new TemplateRenderError('render: opts.vfs is required', null);
  }
  const out = [];
  for (const node of ast) {
    if (node.kind === 'literal' || node.kind === 'opaque') {
      out.push(node.text);
    } else if (node.kind === 'template') {
      out.push(await _renderNode(node, ctx));
    }
  }
  return out.join('');
}
