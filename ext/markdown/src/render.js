// @gcu/markdown — AST → HTML. The consumer owns the output (SPEC §2.6): every
// node type renders through a rule that opts.rules can override; the defaults
// implement the §5 policies (scheme-allowlisted links, raster-data-only
// images) and the §7 output-compat markup (renderMd's admonition classes,
// auto-slug algorithm, kbd pills, language-<tag> code classes).
//
// "Generate, never sanitize": there is no sanitizer here. html:false never
// produces html nodes (the parsers don't emit them), and every text path goes
// through escapeHtml — inert by construction.

import { escapeHtml, slugify, urlScheme, strippedUrl } from './chars.js';
import { flattenText } from './inline.js';

// ── policies (§5) — overridable via opts.linkPolicy / opts.imagePolicy ──
export function defaultLinkPolicy(href) {
  const probe = strippedUrl(href);
  if (probe.startsWith('#')) return true;            // in-page anchor
  const scheme = urlScheme(probe);
  if (!scheme) return true;                          // relative — nothing to abuse
  return /^(https?|mailto|tel)$/.test(scheme);
}
export function defaultImagePolicy(src) {
  const probe = strippedUrl(src);
  const scheme = urlScheme(probe);
  if (!scheme) return true;                          // relative
  if (scheme === 'https' || scheme === 'http') return true;
  return /^data:image\/(png|jpe?g|gif|webp)[;,]/i.test(probe);   // raster only, no svg
}

const attr = (v) => escapeHtml(v);

// ── default rules ─────────────────────────────────────────────────────
// Each rule: (node, ctx) → html string. ctx.render(nodes) renders children;
// ctx.opts, ctx.slug(text, explicitId), ctx.footnoteIndex are available.
export const defaultRules = {
  doc: (n, ctx) => ctx.render(n.children),

  heading: (n, ctx) => {
    const inner = ctx.render(n.children);
    const id = ctx.headingId(n);
    return `<h${n.level}${id ? ` id="${attr(id)}"` : ''}>${inner}</h${n.level}>\n`;
  },

  paragraph: (n, ctx) => `<p>${ctx.render(n.children)}</p>\n`,

  fence: (n, ctx) => {
    const cls = n.lang ? ` class="language-${attr(n.lang)}"` : '';
    return `<pre><code${cls}>${escapeHtml(n.code)}</code></pre>\n`;
  },

  blockquote: (n, ctx) => `<blockquote>\n${ctx.render(n.children)}</blockquote>\n`,

  hr: () => '<hr>\n',

  list: (n, ctx) => {
    const tag = n.ordered ? 'ol' : 'ul';
    const start = n.ordered && n.startNum !== 1 && n.startNum != null ? ` start="${n.startNum}"` : '';
    return `<${tag}${start}>\n${ctx.render(n.children)}</${tag}>\n`;
  },

  listItem: (n, ctx) => {
    // Tight lists unwrap paragraphs (CM): `b` + nested list renders as
    // `b\n<ul>…` with no <p>; loose lists keep paragraphs intact.
    const tight = ctx._tightStack[ctx._tightStack.length - 1];
    let inner;
    if (tight) {
      inner = n.children.map((c) =>
        c.type === 'paragraph' ? ctx.render(c.children) : '\n' + ctx.render([c])).join('');
    } else {
      inner = '\n' + ctx.render(n.children);
    }
    if (n.task) {
      const checked = n.task === 'checked' ? ' checked' : '';
      return `<li class="task"><input type="checkbox" disabled${checked}> ${inner}</li>\n`;
    }
    return `<li>${inner}</li>\n`;
  },

  table: (n, ctx) => {
    const cell = (children, tag, align) => {
      const a = align ? ` style="text-align:${align}"` : '';
      return `<${tag}${a}>${ctx.render(children)}</${tag}>`;
    };
    const head = n.head.map((c, i) => cell(c, 'th', n.align[i])).join('');
    const rows = n.rows.map((r) =>
      `<tr>${r.map((c, i) => cell(c, 'td', n.align[i])).join('')}</tr>`).join('\n');
    return `<table><thead><tr>${head}</tr></thead>`
      + (rows ? `<tbody>\n${rows}\n</tbody>` : '') + '</table>\n';
  },

  admonition: (n, ctx) => {
    const title = n.title || (n.kind[0].toUpperCase() + n.kind.slice(1));
    return `<div class="admonition adm-${attr(n.kind)}">`
      + `<div class="admonition-title">${escapeHtml(title)}</div>`
      + ctx.render(n.children) + '</div>\n';
  },

  footnoteDef: () => '',   // bodies render in the trailing section, not in place

  htmlBlock: (n, ctx) => (ctx.opts.html ? n.raw + '\n' : escapeHtml(n.raw) + '\n'),

  // ── inlines ──
  text: (n) => escapeHtml(n.value),
  softbreak: () => '\n',
  hardbreak: () => '<br>\n',
  codeSpan: (n) => `<code>${escapeHtml(n.value)}</code>`,
  em: (n, ctx) => `<em>${ctx.render(n.children)}</em>`,
  strong: (n, ctx) => `<strong>${ctx.render(n.children)}</strong>`,
  strike: (n, ctx) => `<del>${ctx.render(n.children)}</del>`,
  mark: (n, ctx) => `<mark>${ctx.render(n.children)}</mark>`,
  sub: (n, ctx) => `<sub>${ctx.render(n.children)}</sub>`,
  sup: (n, ctx) => `<sup>${ctx.render(n.children)}</sup>`,
  kbd: (n) => `<kbd>${escapeHtml(n.value)}</kbd>`,

  link: (n, ctx) => {
    const inner = ctx.render(n.children);
    if (!ctx.linkPolicy(n.href)) return inner;       // disallowed scheme → text only
    const title = n.title ? ` title="${attr(n.title)}"` : '';
    return `<a href="${attr(n.href)}"${title}>${inner}</a>`;
  },

  autolink: (n, ctx) => {
    if (!ctx.linkPolicy(n.href)) return escapeHtml(n.email || n.href);
    return `<a href="${attr(n.href)}">${escapeHtml(n.email || n.href)}</a>`;
  },

  image: (n, ctx) => {
    if (!ctx.imagePolicy(n.src)) return escapeHtml(n.alt || '');   // disallowed → alt text
    const title = n.title ? ` title="${attr(n.title)}"` : '';
    return `<img src="${attr(n.src)}" alt="${attr(n.alt || '')}"${title}>`;
  },

  math: (n, ctx) => {
    if (ctx.opts.mathRenderer) {
      try { return String(ctx.opts.mathRenderer(n.latex, n.mode)); }
      catch { /* fall through to passthrough */ }
    }
    const d = n.mode === 'display' ? '$$' : '$';
    return `<span class="math math-${n.mode}">${escapeHtml(d + n.latex + d)}</span>`;
  },

  footnoteRef: (n, ctx) => {
    const idx = ctx.footnoteIndex(n.label);
    if (idx == null) return escapeHtml(`[^${n.label}]`);
    return `<sup class="footnote-ref"><a href="#fn-${idx}" id="fnref-${idx}">[${idx}]</a></sup>`;
  },

  htmlInline: (n, ctx) => (ctx.opts.html ? n.raw : escapeHtml(n.raw)),
};

// ── renderAst ─────────────────────────────────────────────────────────
export function renderAst(ast, opts = {}) {
  const rules = { ...defaultRules, ...(opts.rules || {}) };
  const slugCounts = new Map();
  const fnOrder = [];                       // labels in first-use order
  const fnIndex = new Map();

  const ctx = {
    opts,
    _tightStack: [],
    linkPolicy: opts.linkPolicy || defaultLinkPolicy,
    imagePolicy: opts.imagePolicy || defaultImagePolicy,
    footnoteIndex(label) {
      if (!ast.footnotes || !ast.footnotes.has(label)) return null;
      if (!fnIndex.has(label)) { fnOrder.push(label); fnIndex.set(label, fnOrder.length); }
      return fnIndex.get(label);
    },
    headingId(n) {
      if (n.id) return dedupe(n.id);
      if (!opts.extensions || !opts.extensions.headingIds || !opts.autoIds) return null;
      const slug = slugify(flattenText(n.children));
      return slug ? dedupe(slug) : null;
    },
    render(nodes) {
      let out = '';
      for (const node of nodes || []) {
        const rule = rules[node.type];
        if (node.type === 'list') ctx._tightStack.push(node.tight);
        out += rule ? rule(node, ctx) : '';
        if (node.type === 'list') ctx._tightStack.pop();
      }
      return out;
    },
  };
  function dedupe(slug) {
    const n = slugCounts.get(slug) || 0;
    slugCounts.set(slug, n + 1);
    return n === 0 ? slug : `${slug}-${n + 1}`;
  }

  let html = ctx.render(ast.children);

  // footnote section — only used refs, in first-use order
  if (fnOrder.length) {
    const items = fnOrder.map((label) => {
      const def = ast.footnotes.get(label);
      const idx = fnIndex.get(label);
      const body = ctx.render(def.children).trim();
      return `<li id="fn-${idx}">${body} <a href="#fnref-${idx}" class="footnote-backref">↩</a></li>`;
    });
    html += `<section class="footnotes"><ol>\n${items.join('\n')}\n</ol></section>\n`;
  }
  return html;
}
