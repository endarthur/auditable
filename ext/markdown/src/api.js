// @gcu/markdown — public API (SPEC §6): parse / render / renderAst / lint +
// the per-consumer presets. A preset is a plain options object — spread and
// override, no magic.

import { splitLines, parseBlocks } from './block.js';
import { parseInline } from './inline.js';
import { renderAst, defaultRules, defaultLinkPolicy, defaultImagePolicy } from './render.js';
import { escapeHtml, slugify } from './chars.js';

export { renderAst, defaultRules, defaultLinkPolicy, defaultImagePolicy, escapeHtml, slugify };

const EXT_ALL = {
  tables: true, tasklists: true, strike: true, footnotes: true, math: true,
  admonitions: true, kbd: true, headingIds: true, autolinkBare: true,
  subsup: true, mark: true, comments: true,
};

// ── presets (SPEC §6) ─────────────────────────────────────────────────
export const presets = {
  // auditable notebook md cells — renderMd parity; md renders on open, so
  // inert. autoIds: 3 = h1-h3 anchor, h4-h6 stay anchor-less (TOC compat).
  notebook: {
    html: false, autoIds: 3,
    extensions: { tables: true, tasklists: true, strike: true, math: true, admonitions: true, kbd: true, headingIds: true, subsup: true, mark: true },
  },
  // works docs/reader surfaces — notebook + footnotes.
  docs: {
    html: false, autoIds: 3,
    extensions: { tables: true, tasklists: true, strike: true, math: true, admonitions: true, kbd: true, headingIds: true, subsup: true, mark: true, footnotes: true },
  },
  // wild content (READMEs, imported .ipynb): tolerant, linkified, no GCU-isms.
  // math off — a $ in wild prose is a dollar sign.
  wild: {
    html: false, autoIds: true,
    extensions: { tables: true, tasklists: true, strike: true, headingIds: true, autolinkBare: true },
  },
  // strict-authored GCU content — everything, including // comments.
  gcu: {
    html: false, autoIds: true,
    extensions: { ...EXT_ALL },
  },
  // cradle-doc parity (SPEC §8.5): footnotes/subsup/mark/heading ids/linkify.
  doc1: {
    html: false, autoIds: true,
    extensions: { tables: true, tasklists: true, strike: true, footnotes: true, headingIds: true, autolinkBare: true, subsup: true, mark: true },
  },
};

// ── // comment stripping (gcu preset) ─────────────────────────────────
// Pre-parse pass: cut `// …` to end of line outside fences and code spans;
// `\//` escapes a literal `//`. NOTE: stripping shifts source offsets right of
// a comment — acceptable for the authoring-side preset that enables it.
function stripComments(src) {
  const out = [];
  let inFence = false, fenceCh = '';
  for (const line of src.split('\n')) {
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fm) {
      if (!inFence) { inFence = true; fenceCh = fm[1][0]; }
      else if (fm[1][0] === fenceCh) inFence = false;
      out.push(line); continue;
    }
    if (inFence) { out.push(line); continue; }
    let res = '', ticks = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && line[i + 1] === '/' && line[i + 2] === '/') { res += '//'; i += 2; continue; }
      if (c === '`') { ticks = !ticks; res += c; continue; }
      if (!ticks && c === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) {
        res = res.replace(/[ \t]+$/, '');
        break;
      }
      res += c;
    }
    out.push(res);
  }
  return out.join('\n');
}

// ── parse ─────────────────────────────────────────────────────────────
// → { ast, refs, warnings }. Never throws on content; maxBytes is a caller
// config violation and DOES throw (a visible cap, not a silent truncation).
export function parse(src, opts = {}) {
  src = String(src ?? '');
  if (opts.maxBytes && src.length > opts.maxBytes) {
    throw new Error(`@gcu/markdown: input exceeds maxBytes (${src.length} > ${opts.maxBytes})`);
  }
  const ext = opts.extensions || {};
  if (ext.comments) src = stripComments(src);

  const ctx = {
    ext,
    html: !!opts.html,
    refs: new Map(),
    footnotes: new Map(),
    lintSink: opts.lint ? [] : null,
    pending: [],
  };
  const children = parseBlocks(splitLines(src), ctx);
  // Second phase: inline content. Deferred so reference definitions anywhere
  // in the document exist before any [text][label] resolves (see block.js).
  for (const p of ctx.pending) {
    p.holder.push(...parseInline(p.raw, ctx));
  }
  const ast = { type: 'doc', children, footnotes: ctx.footnotes, refs: ctx.refs, start: 0, end: src.length };
  return { ast, refs: ctx.refs, warnings: ctx.lintSink || [] };
}

// ── render ────────────────────────────────────────────────────────────
export function render(src, opts = {}) {
  return renderAst(parse(src, opts).ast, opts);
}

// ── lint — the strict authoring profile (SPEC §3.4) ───────────────────
// Returns source-mapped findings for everything the reader accepts but the
// canonical GCU dialect writes one way. render() never rejects; this advises.
export function lint(src, opts = {}) {
  src = String(src ?? '');
  const { ast, refs, warnings } = parse(src, { ...opts, lint: true });
  const out = [...warnings];
  const f = (rule, message, start, end) => out.push({ rule, message, start, end });

  // line-level sweeps, fence-aware
  let inFence = false, fenceCh = '';
  let pos = 0;
  for (const line of src.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    const fm = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fm) {
      if (!inFence) { inFence = true; fenceCh = fm[1][0]; }
      else if (fm[1][0] === fenceCh) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    const end = start + line.length;

    let m = line.match(/^( {0,3})([*+]) /);
    if (m) f('bullet-marker', `bullet \`${m[2]}\` — canonical is \`-\``, start + m[1].length, start + m[1].length + 1);
    m = line.match(/^( {0,3})\d{1,9}\) /);
    if (m) f('ordered-marker', 'ordered marker `n)` — canonical is `n.`', start + m[1].length, end);
    if (/\S {2,}$/.test(line)) f('two-space-break', 'trailing-space hard break — canonical is `\\` at line end', end - 2, end);
    if (/^ {0,3}(=+|-{2,})[ \t]*$/.test(line)) f('setext-underline', 'setext-style underline does not form a heading in this dialect', start, end);
    if (/^(?: {4,}|\t)\S/.test(line)) f('indented-block', 'indented lines do not form code blocks in this dialect — use a fence', start, end);
    m = line.match(/__([^\s_][^_]*)__/);
    if (m) f('bold-marker', 'bold `__x__` — canonical is `**x**`', start + m.index, start + m.index + m[0].length);
    m = line.match(/(^|[^*])\*([^\s*][^*]*)\*(?!\*)/);
    if (m) f('italic-marker', 'italic `*x*` — canonical is `_x_`', start + m.index, start + m.index + m[0].length);
  }

  // heading level jumps
  let prevLevel = 0;
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (n.type === 'heading') {
        if (prevLevel && n.level > prevLevel + 1) {
          f('heading-jump', `heading level jumps h${prevLevel} → h${n.level}`, n.start, n.end);
        }
        prevLevel = n.level;
      }
      if (n.children && n.type !== 'heading' && n.type !== 'paragraph') walk(n.children);
    }
  })(ast.children);

  // unused reference definitions
  for (const [label, def] of refs) {
    if (!def.used) f('unused-refdef', `reference definition [${label}] is never used`, def.start, def.start);
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}
