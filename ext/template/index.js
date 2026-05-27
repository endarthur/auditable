// @gcu/template — VFS-backed template engine with {{path | filter}} syntax.
// Auto-generated from ext/template/src/ — do not edit directly.

// -- util.js --

// Tiny shared helpers — kept separate so filters.js and render.js can both
// pull them in without a circular dependency.

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Decode bytes as UTF-8 text. Used when a binary read needs to be treated as
// text by a filter. Falls back to a best-effort string conversion if the
// runtime has no TextDecoder (it always does in modern browsers + Node 11+,
// but the defensive path is cheap).
function textForBytes(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Uint8Array) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(input); }
    catch { /* fall through */ }
    let s = '';
    for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i]);
    return s;
  }
  return String(input);
}

// Split a path's extension. Returns '' for files with no extension. The
// extension keeps its leading dot so it matches the filter registry keys
// (.csv, .png) directly.
function extOf(path) {
  const i = path.lastIndexOf('.');
  if (i < 0) return '';
  const slash = path.lastIndexOf('/');
  if (i < slash) return '';   // dot is in a directory name, not the file
  return path.slice(i).toLowerCase();
}

// Decide whether a path needs binary or text bytes. Binary extensions get
// Uint8Array; everything else is read as utf-8 text. Caller can override
// via filter behaviour (e.g. .csv filters call textForBytes themselves so
// they accept either form).
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.wasm',
]);
function isBinaryExt(ext) {
  return BINARY_EXTS.has(ext);
}

// -- parse.js --

// Tokenizer + parser for {{path | filter args | filter args}} syntax.
//
// Output AST is a flat array of nodes:
//   { kind: 'literal', text }                        — passthrough text
//   { kind: 'opaque',  text }                        — interpolated value
//                                                      from a tagged template;
//                                                      never re-scanned for
//                                                      template syntax
//   { kind: 'template', path, filters: [{name, args}] }
//
// Two entry points: parseText(s) for plain strings, parseTagged(strings, values)
// for tagged-template-literal calls. parseTagged is the safe form: interpolated
// JS values land as 'opaque' nodes and can't introduce new {{...}} directives.
//
// The template syntax itself: anything between `{{` and `}}`. Inside:
//   path[ | filter [arg [arg ...]] [| filter [arg ...]] ... ]
// Path is everything up to the first `|` (or `}}` if no filters). Filters are
// pipe-separated, each: a name followed by space-separated args. Args support
// double-quoted strings for spaces.

class TemplateParseError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'TemplateParseError';
    this.pos = pos;
  }
}

const OPEN = '{{';
const CLOSE = '}}';

// Walk a single string, emit a list of literal-or-template nodes. Used both by
// parseText directly and by parseTagged on each raw string segment.
function _parseString(s, nodesOut) {
  let i = 0;
  while (i < s.length) {
    const openIdx = s.indexOf(OPEN, i);
    if (openIdx === -1) {
      if (i < s.length) nodesOut.push({ kind: 'literal', text: s.slice(i) });
      return;
    }
    if (openIdx > i) nodesOut.push({ kind: 'literal', text: s.slice(i, openIdx) });
    const closeIdx = s.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      throw new TemplateParseError(
        `unclosed '{{' starting at offset ${openIdx}`, openIdx);
    }
    const body = s.slice(openIdx + OPEN.length, closeIdx);
    nodesOut.push(_parseDirective(body, openIdx + OPEN.length));
    i = closeIdx + CLOSE.length;
  }
}

// path | filter args | filter args ...
//
// Splitting on `|` is straightforward — `|` is not a legal VFS path character
// and we don't (yet) support pipes inside quoted strings. If that becomes a
// need, tokenize properly.
function _parseDirective(body, pos) {
  const parts = body.split('|').map((p) => p.trim());
  const path = parts[0];
  if (!path) {
    throw new TemplateParseError(`empty template directive at offset ${pos}`, pos);
  }
  const filters = [];
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];
    if (!segment) {
      throw new TemplateParseError(
        `empty filter segment in '{{${body}}}' at offset ${pos}`, pos);
    }
    filters.push(_parseFilter(segment, pos));
  }
  return { kind: 'template', path, filters };
}

// Tokenize one filter segment. Name is the first whitespace-delimited token,
// remaining tokens are args. Args support double-quoted strings (with \" and
// \\ escapes); a bare token is whatever non-space sequence follows.
function _parseFilter(segment, pos) {
  const tokens = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i])) i++;
    if (i >= segment.length) break;
    if (segment[i] === '"') {
      let buf = '';
      i++;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\' && i + 1 < segment.length) {
          buf += segment[i + 1];
          i += 2;
        } else {
          buf += segment[i++];
        }
      }
      if (i >= segment.length) {
        throw new TemplateParseError(
          `unterminated quoted argument in filter "${segment}"`, pos);
      }
      i++;
      tokens.push(buf);
    } else {
      let buf = '';
      while (i < segment.length && !/\s/.test(segment[i])) buf += segment[i++];
      tokens.push(buf);
    }
  }
  if (tokens.length === 0) {
    throw new TemplateParseError(`empty filter segment at offset ${pos}`, pos);
  }
  return { name: tokens[0], args: tokens.slice(1) };
}

// Public entry: parse a plain template string.
function parseText(s) {
  if (typeof s !== 'string') {
    throw new TemplateParseError(`parseText expected a string, got ${typeof s}`, 0);
  }
  const nodes = [];
  _parseString(s, nodes);
  return nodes;
}

// Public entry: parse from tagged-template arguments. Interpolated `${expr}`
// values land as 'opaque' nodes so they're never re-scanned for {{...}}, which
// would otherwise let a user-controlled value inject directives.
function parseTagged(strings, values) {
  const nodes = [];
  for (let i = 0; i < strings.length; i++) {
    _parseString(strings[i], nodes);
    if (i < values.length) {
      nodes.push({ kind: 'opaque', text: String(values[i]) });
    }
  }
  return nodes;
}

// Walk an AST and return the set of paths it references. Used for reactivity:
// the consumer subscribes to VFS.Changed for each path and re-renders.
// Resolved paths (relative vs absolute) are NOT computed here — the renderer
// does that with cwd context. This returns the raw `path` field from each
// template node.
function listPaths(ast) {
  const out = [];
  for (const n of ast) if (n.kind === 'template') out.push(n.path);
  return out;
}

// -- filters.js --

// Per-extension filter registry plus the default filters shipped with the
// engine. Filters are pure async (input, ...args) → output functions. The
// first filter in a chain receives the file's raw content (text for textual
// extensions, Uint8Array for binary). The last filter's return value is the
// rendered output — typically an HTML string; consumers can use a different
// final type, but HTML is the lingua franca for doc / deck / sheet surfaces.
//
// Extension dispatch:
//   - Filter lookup is per-extension: registerFilter('.csv', 'head', fn).
//   - Filters can also be registered under '*' to apply to any extension.
//   - A bareword `default` filter per extension picks the sensible rendering
//     when no filter is given (a `.csv` table, a `.png` <img>, a `.md` inline).
//
// Built-ins are intentionally small. Surfaces can register their own per-call
// via render({ filters: { ... } }), and apps can globally extend via the
// registerFilter API.


const _registry = new Map();   // ext -> Map<name, fn>
function _bucket(ext) {
  let m = _registry.get(ext);
  if (!m) { m = new Map(); _registry.set(ext, m); }
  return m;
}

function registerFilter(ext, name, fn) {
  _bucket(ext).set(name, fn);
}

// Look up a filter for the given extension, falling back to the wildcard
// bucket if the per-extension table has no match. Returns null if neither.
function lookupFilter(ext, name) {
  const e = _registry.get(ext);
  if (e && e.has(name)) return e.get(name);
  const w = _registry.get('*');
  if (w && w.has(name)) return w.get(name);
  return null;
}

// Run the default filter for an extension on the raw content. Falls back to
// '*'.default; if no default registered anywhere, returns the input as-is.
async function applyDefault(ext, input) {
  const fn = lookupFilter(ext, 'default');
  if (!fn) return input;
  return fn(input);
}

// ── Built-in defaults ────────────────────────────────────────────────────
//
// Textual:
//   .md     default → render markdown (caller's renderMd hook, falls back to
//                     escaped inline if absent — keep the engine renderer-agnostic)
//   .csv    default → format as HTML table
//   .json   default → pretty-printed <pre> block
//   .txt    default → escaped <pre> block
//   .html   default → raw HTML (trusted; producer wrote the file)
// Binary:
//   .png/.jpg/.gif/.webp/.svg default → <img> tag with data URL
//
// Common filters:
//   head N   — first N lines (csv/txt) or first N items (json array)
//   tail N   — last N lines / items
//   raw      — return contents verbatim, no HTML wrapping
//   pretty   — JSON-pretty (also default for .json)
//   compact  — JSON-compact

function _attrEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── csv ──
registerFilter('.csv', 'head', async (input, n) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  const lines = text.split(/\r?\n/);
  const k = Math.max(0, Number(n) || 0);
  return lines.slice(0, k + 1).join('\n');   // +1 keeps header row
});
registerFilter('.csv', 'tail', async (input, n) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0];
  const body = lines.slice(1);
  const k = Math.max(0, Number(n) || 0);
  return [header, ...body.slice(-k)].join('\n');
});
registerFilter('.csv', 'format', async (input, mode) => {
  if (mode === 'inline' || mode === 'raw') return typeof input === 'string' ? input : textForBytes(input);
  // 'table' default — naive split-on-comma. No quoted-field handling here;
  // dedicated CSV cells should use std.csv in the notebook. This is the
  // "show me what's in the file" default for documents.
  const text = typeof input === 'string' ? input : textForBytes(input);
  const rows = text.split(/\r?\n/).filter(Boolean).map((r) => r.split(','));
  if (!rows.length) return '';
  const [head, ...body] = rows;
  const th = head.map((c) => `<th>${_attrEscape(c)}</th>`).join('');
  const trs = body.map((r) =>
    '<tr>' + r.map((c) => `<td>${_attrEscape(c)}</td>`).join('') + '</tr>').join('');
  return `<table class="tpl-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
});
registerFilter('.csv', 'default', async (input) => {
  return (await lookupFilter('.csv', 'format'))(input, 'table');
});

// ── json ──
registerFilter('.json', 'pretty', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
});
registerFilter('.json', 'compact', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  try { return JSON.stringify(JSON.parse(text)); }
  catch { return text; }
});
registerFilter('.json', 'pick', async (input, key) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  let obj;
  try { obj = JSON.parse(text); }
  catch { return text; }
  for (const part of String(key).split('.')) {
    if (obj == null) return '';
    obj = obj[part];
  }
  return typeof obj === 'string' ? obj : JSON.stringify(obj);
});
registerFilter('.json', 'default', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  try {
    const pretty = JSON.stringify(JSON.parse(text), null, 2);
    return `<pre class="tpl-json">${_attrEscape(pretty)}</pre>`;
  } catch {
    return `<pre class="tpl-json">${_attrEscape(text)}</pre>`;
  }
});

// ── markdown / text / html ──
registerFilter('.md', 'default', async (input) => {
  // Engine stays renderer-agnostic — the consumer (doc surface) overrides
  // this filter with its own markdown→HTML pipeline when it sets up render.
  // The fallback is a <pre> block so a bare engine still produces output.
  const text = typeof input === 'string' ? input : textForBytes(input);
  return `<div class="tpl-md">${_attrEscape(text)}</div>`;
});
registerFilter('.txt', 'default', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  return `<pre class="tpl-txt">${_attrEscape(text)}</pre>`;
});
registerFilter('.html', 'default', async (input) => {
  return typeof input === 'string' ? input : textForBytes(input);
});

// ── images ──
function _bytesToDataUrl(input, mime) {
  if (typeof input === 'string') {
    // Already a data URL or other ready-to-embed form
    return input;
  }
  let bin = '';
  for (let i = 0; i < input.length; i++) bin += String.fromCharCode(input[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}
function _imgFilter(mime) {
  return async (input, ...attrs) => {
    const url = _bytesToDataUrl(input, mime);
    // attrs are space-separated key=value pairs OR positional width
    const kv = [];
    for (const a of attrs) {
      if (a.includes('=')) {
        const [k, v] = a.split('=', 2);
        kv.push(`${_attrEscape(k)}="${_attrEscape(v)}"`);
      } else {
        kv.push(`width="${_attrEscape(a)}"`);
      }
    }
    return `<img src="${url}" ${kv.join(' ')}/>`;
  };
}
for (const [ext, mime] of [
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
]) {
  registerFilter(ext, 'default', _imgFilter(mime));
}

// ── wildcard ──
registerFilter('*', 'raw', async (input) => {
  return typeof input === 'string' ? input : textForBytes(input);
});
registerFilter('*', 'escape', async (input) => {
  const text = typeof input === 'string' ? input : textForBytes(input);
  return htmlEscape(text);
});

// -- render.js --

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



class TemplateRenderError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'TemplateRenderError';
    this.path = path;
  }
}

class TemplateCycleError extends TemplateRenderError {
  constructor(chain) {
    super('template cycle: ' + chain.join(' → '), chain[chain.length - 1]);
    this.name = 'TemplateCycleError';
    this.chain = chain;
  }
}

// Resolve a path token from the template against the consumer's cwd.
// Absolute paths (leading '/') are taken as-is. Relative paths are joined
// to cwd. The result is normalized — './x' or '../x' segments resolved.
function resolvePath(rawPath, cwd) {
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
async function render(ast, opts = {}) {
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

// -- api.js --

// Public API for @gcu/template — the surface every consumer (doc / deck /
// sheet / notebook cell builtin) reaches for. Re-exports the parser, the
// renderer, and the filter registry; adds two convenience entrypoints that
// cover the common shapes.





// Parse + render a plain string in one call. Most callers want this.
async function renderText(text, opts = {}) {
  const ast = parseText(text);
  return render(ast, opts);
}

// Tagged-template-literal entry. Use as:
//   const html = await tpl(opts)`hello {{intro.md}} ${name}`;
// or with default opts:
//   const html = await tpl()`hello {{intro.md}}`;
//
// The factory shape lets the caller bind opts (vfs, cwd, filters) once and
// reuse the tag inside a render scope. ${expr} values are inserted as opaque
// literal nodes — the safety guarantee that user-controlled values can't
// inject new {{...}} directives.
function tpl(opts = {}) {
  return async (strings, ...values) => {
    const ast = parseTagged(strings, values);
    return render(ast, opts);
  };
}

// Lower-level: just resolve the dependency set from a parsed AST, mapped
// through cwd. Useful for wiring reactivity before rendering: subscribe to
// VFS.Changed for each path, then render lazily.
function getDependencies(ast, cwd) {
  const out = new Set();
  for (const p of listPaths(ast)) out.add(resolvePath(p, cwd || '/'));
  return out;
}
export {
  parseText, parseTagged, listPaths,
  render, resolvePath, renderText, tpl,
  registerFilter, lookupFilter, getDependencies,
  TemplateParseError, TemplateRenderError, TemplateCycleError,
};
