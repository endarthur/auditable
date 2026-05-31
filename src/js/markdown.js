// ── MARKDOWN RENDERING (minimal) ──
//
// Hand-rolled subset of CommonMark: headings (h1-h6), bold, italic,
// inline code, links, images, fenced code blocks, blockquotes,
// unordered + ordered lists, tables, and raw HTML pass-through. Not a
// full CommonMark implementation — covers what we hit in practice
// (auditable md cells + Jupyter notebook imports via @gcu/ipynb).
//
// HTML pass-through policy: most tags pass through verbatim so authored
// markup (e.g. `<p align="center">` or inline `<br>`) renders. A small
// blacklist of dangerous tags is stripped: script, iframe, object,
// embed, style, meta, link, form, input, textarea, button, noscript.
// `on*=` event-handler attributes and `javascript:` / `vbscript:` /
// `data:` URLs are also stripped. This matches what most notebook
// renderers do and is appropriate for imported content the user has
// already chosen to trust.

// Tags whose CONTENT must also be stripped (a stray `<script>foo</script>`
// would otherwise leave `foo` as visible page text).
const _DANGEROUS_CONTAINER_RE = /<(script|style|iframe|noscript|object|embed|form|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Standalone dangerous tags (void elements, or unclosed) — strip the tag itself.
const _DANGEROUS_TAG_RE = /<\/?(script|style|iframe|noscript|object|embed|meta|link|form|input|textarea|button)\b[^>]*>/gi;
const _ON_ATTR_RE = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const _DANGEROUS_URL_RE = /(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data)\s*:[^"'\s>]*\2/gi;

// Heading slug. Shared with consumers (e.g. the docs surface) so they
// can pre-compute anchors that match what renderMd actually emits.
// Strips inline-code (raw + extracted placeholders), bold/italic markers,
// HTML tags, and punctuation; collapses whitespace to hyphens. Idempotent
// across the renderer's transformation stages — feeding it raw markdown
// or the post-extraction text yields the same slug.
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/\bi?code\d+\b/g, '')   // extracted-code placeholders (post-lowercase)
    .replace(/`([^`]*)`/g, ' $1 ')    // keep content from raw inline code
    .replace(/[*_]/g, '')             // bold / italic markers
    .replace(/<[^>]+>/g, '')          // stray HTML
    .replace(/[^\w\s-]/g, '')         // punctuation
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function _sanitize(html) {
  return html
    .replace(_DANGEROUS_CONTAINER_RE, '')
    .replace(_DANGEROUS_TAG_RE, '')
    .replace(_ON_ATTR_RE, '')
    .replace(_DANGEROUS_URL_RE, '$1=""');
}

export function renderMd(src) {
  let html = src;

  // Admonitions — MkDocs-Material syntax. `!!! type ["title"]` followed
  // by a 4-space-indented body. Body is recursively rendered at the end
  // so nested markdown (lists, code, more admonitions) works. Extracted
  // before code so a fenced block inside an admonition doesn't get
  // captured by the outer code-extract pass.
  const admonitions = [];
  html = html.replace(
    /^!!! (\w+)(?:\s+"([^"]*)")?[ \t]*\n((?:[ \t]*\n)?(?:(?:[ \t]{4,}[^\n]*|[ \t]*)\n?)+)/gm,
    (_m, type, title, body) => {
      const dedented = body.split('\n').map(line => {
        if (!line.trim()) return '';
        return line.replace(/^[ \t]{1,4}/, '');
      }).join('\n').trim();
      const idx = admonitions.length;
      admonitions.push({ type, title: title || null, body: dedented });
      // Block-level placeholder so paragraph-wrapping leaves it alone.
      return `\n<div data-adm="${idx}"></div>\n`;
    }
  );

  // Fenced code blocks (```…```) — extract first so internal markdown
  // patterns inside don't get processed. Replace with placeholders.
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, body) => {
    const idx = codeBlocks.length;
    const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cls = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${cls}>${escaped}</code></pre>`);
    return ` CODE${idx} `;
  });

  // Inline code — extract BEFORE sanitising so a `<script>` inside
  // backticks can't pair up with another `</script>` elsewhere and have
  // the dangerous-tag regex eat all the prose between them. Bodies are
  // HTML-escaped at extract time.
  const inlineCode = [];
  html = html.replace(/`(.+?)`/g, (_m, body) => {
    const escaped = body
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const idx = inlineCode.length;
    inlineCode.push('<code>' + escaped + '</code>');
    return ` ICODE${idx} `;
  });

  // Sanitise the prose. Code placeholders are inert tokens, so the
  // dangerous-tag regexes never see the script/style text inside.
  html = _sanitize(html);

  // headings — most-# first so `#### foo` doesn't match the `# .+` rule.
  // h1/h2/h3 get id attrs (for TOC + deep-link anchors). h4-h6 stay
  // anchor-less; they're rare and TOC clutter is worse than missing ids.
  // The slug helper expands ICODE placeholders back to their original
  // text so headings like `### \`// %manual\`` slug to `manual` instead
  // of an empty string.
  const _slugH = (t) => {
    const expanded = t.replace(/\bICODE(\d+)\b/g, (_, i) => {
      const html = inlineCode[Number(i)] || '';
      const m = html.match(/^<code>([\s\S]*)<\/code>$/);
      if (!m) return '';
      return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    });
    return slugify(expanded);
  };
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, (_m, t) => `<h3 id="${_slugH(t)}">${t}</h3>`);
  html = html.replace(/^## (.+)$/gm, (_m, t) => `<h2 id="${_slugH(t)}">${t}</h2>`);
  html = html.replace(/^# (.+)$/gm, (_m, t) => `<h1 id="${_slugH(t)}">${t}</h1>`);

  // horizontal rule — `---` on its own line (must come before lists / paragraphs)
  html = html.replace(/^---+$/gm, '<hr/>');

  // Images — must come before links since the regexes overlap. The emitted
  // tag is stashed behind an IMGTAG placeholder so the inline rules below
  // (++keys++, ~~strike~~, *em*, links) never rewrite inside its src/alt.
  // Critical for `data:` image URLs: base64 contains '+', so a `++X++`
  // substring would otherwise be mangled into `<kbd>…</kbd>` mid-URL,
  // injecting '<' and producing an ERR_INVALID_URL image.
  const imgTags = [];
  html = html.replace(/!\[(.*?)\]\((.+?)\)/g, (_m, alt, url) => {
    if (/^\s*(javascript|vbscript|data)\s*:/i.test(url) && !/^data:image\//i.test(url)) return alt;
    const idx = imgTags.length;
    imgTags.push(`<img src="${url}" alt="${alt}"/>`);
    return ` IMGTAG${idx} `;
  });

  // ++keys++ — MkDocs `pymdownx.keys`. Render each key as a <kbd> pill,
  // joined by literal '+'. Non-greedy so `++a++ ++b++` stays separate.
  html = html.replace(/\+\+([\w][\w +-]*?[\w]|[\w])\+\+/g, (_m, keys) => {
    return keys.split('+').map(k => `<kbd>${k.trim()}</kbd>`).join('+');
  });

  // Strikethrough — `~~text~~`.
  html = html.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

  // Bold then italic (order matters — `**x**` should not be eaten by `*x*`)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');

  // (Inline code was already extracted as ICODE placeholders before
  // sanitisation, so nothing to do here. The placeholders are restored
  // alongside fenced-code placeholders at the end of the pipeline.)

  // Links (reject dangerous URI schemes)
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_m, text, url) => {
    if (/^\s*(javascript|vbscript|data)\s*:/i.test(url)) return text;
    return `<a href="${url}">${text}</a>`;
  });

  // Tables — pipe-delimited blocks (process before paragraph wrapping)
  html = html.replace(
    /((?:^\|.+\|[ \t]*$\n?)+)/gm,
    (block) => {
      const rows = block.trim().split('\n').map(r =>
        r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      );
      if (rows.length < 2) return block;
      const sep = rows[1];
      if (!sep.every(c => /^:?-{1,}:?$/.test(c))) return block;
      const hdr = rows[0];
      const body = rows.slice(2);
      let t = '<table><thead><tr>' +
        hdr.map(c => `<th>${c}</th>`).join('') +
        '</tr></thead><tbody>';
      for (const row of body) {
        t += '<tr>' + row.map(c => `<td>${c}</td>`).join('') + '</tr>';
      }
      t += '</tbody></table>';
      return t;
    }
  );

  // Lists — block-level. Group consecutive `- ` / `* ` lines into <ul>,
  // `N. ` lines into <ol>. Nested lists aren't handled (we render flat).
  html = html.replace(
    /(?:^[ \t]*[-*][ \t]+.+(?:\n|$))+/gm,
    (block) => {
      const items = block.trim().split('\n').map(line =>
        line.replace(/^[ \t]*[-*][ \t]+/, '')
      );
      return '<ul>' + items.map(it => `<li>${it}</li>`).join('') + '</ul>';
    }
  );
  html = html.replace(
    /(?:^[ \t]*\d+\.[ \t]+.+(?:\n|$))+/gm,
    (block) => {
      const items = block.trim().split('\n').map(line =>
        line.replace(/^[ \t]*\d+\.[ \t]+/, '')
      );
      return '<ol>' + items.map(it => `<li>${it}</li>`).join('') + '</ol>';
    }
  );

  // Blockquotes — `> ` at start of line
  html = html.replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs — split on blank lines, wrap stretches of plain text in <p>.
  // Block-level elements (headings, ul, ol, blockquote, table, pre, hr,
  // div, p) already have their own wrappers; only wrap orphans.
  const blocks = html.split(/\n\n+/);
  html = blocks.map(b => {
    const trimmed = b.trim();
    if (!trimmed) return '';
    if (/^<(h[1-6]|ul|ol|blockquote|table|pre|hr|div|p|figure|img|section|article|aside|nav|header|footer|details|summary)\b/i.test(trimmed)) {
      return trimmed;
    }
    // Treat as a paragraph. Single newlines inside a paragraph are soft
    // breaks (collapse to whitespace, LaTeX-style); blank lines were
    // already split out as paragraph boundaries by the \n\n+ split above.
    return '<p>' + trimmed + '</p>';
  }).join('\n');

  // Restore fenced-code + inline-code + image placeholders.
  html = html.replace(/\bCODE(\d+)\b/g, (_m, i) => codeBlocks[Number(i)]);
  html = html.replace(/\bICODE(\d+)\b/g, (_m, i) => inlineCode[Number(i)]);
  html = html.replace(/\bIMGTAG(\d+)\b/g, (_m, i) => imgTags[Number(i)] || '');

  // Restore admonitions. Each body is recursively rendered so nested
  // markdown lights up. Title defaults to a capitalised type name.
  html = html.replace(/<div data-adm="(\d+)"><\/div>/g, (_m, i) => {
    const adm = admonitions[Number(i)];
    const title = adm.title || (adm.type[0].toUpperCase() + adm.type.slice(1));
    const inner = renderMd(adm.body);
    return `<div class="admonition adm-${adm.type}">`
      + `<div class="admonition-title">${title}</div>`
      + inner + '</div>';
  });

  return html;
}
