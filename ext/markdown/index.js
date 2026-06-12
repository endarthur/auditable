// ⚠ GENERATED FILE — DO NOT EDIT. Source: src/  Build: @gcu/build src/main.js
// @gcu/markdown — The GCU markdown engine: a zero-dependency, regex-free scanner with a source-mapped AST, renderer-rule overrides, and a two-position html toggle (inert by default, no sanitizer ever). Liberal reading grammar, strict authoring lint. One engine for notebook md cells, works surfaces, READMEs, and (eventually) cradle docs and gcu-press typesetting.

// ── src/chars.js ──

// @gcu/markdown — character classification + escaping. Code-point aware where
// it matters: the corpus check caught mathematical alphanumerics (𝑃, 𝑠 — outside
// the BMP, surrogate pairs in UTF-16) misclassifying under unit-at-a-time reads,
// so every neighbor probe goes through cpBefore/cpAt (SPEC §3.2.4).

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The code point (as a string, 1–2 UTF-16 units) ending at index i, or
// undefined at the start of input.
function cpBefore(text, i) {
  if (i <= 0) return undefined;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1];
}

// The code point starting at index i, or undefined at the end of input.
function cpAt(text, i) {
  if (i >= text.length) return undefined;
  const hi = text.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
    const lo = text.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return text.slice(i, i + 2);
  }
  return text[i];
}

const RE_SPACE = /\s/;
const RE_ALNUM = /[\p{L}\p{N}]/u;
const RE_PUNCT = /[\p{P}\p{S}]/u;

// Undefined (start/end of input) classifies as space — a delimiter at the edge
// of the text behaves as if bordered by whitespace, which is what flanking wants.
const isSpaceCp = (cp) => cp === undefined || RE_SPACE.test(cp);
const isAlnumCp = (cp) => cp !== undefined && RE_ALNUM.test(cp);
const isPunctCp = (cp) => cp !== undefined && RE_PUNCT.test(cp);

// CommonMark's escapable set: ALL ASCII punctuation (the corpus caught `\,` in
// LaTeX — escapes are not limited to markdown's own marker characters).
function isEscapable(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40)
    || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
}

// Heading auto-slugs — byte-compatible with src/js/markdown.js's slugify so
// existing TOC anchors don't move when renderMd becomes a re-export (SPEC §7).
// Operates on the heading's PLAIN TEXT (inline nodes flattened), so the
// code-placeholder and marker-stripping passes of the original are no-ops here
// but kept for output parity on pathological inputs.
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/`([^`]*)`/g, ' $1 ')
    .replace(/[*_]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// HTML entities — numeric forms plus a curated named set (the full HTML list
// is ~2200 names; wild markdown uses a handful). Decoding to TEXT is safe by
// construction: a decoded `<` is a text value, re-escaped at render. Unknown
// names stay literal.
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×',
  divide: '÷', middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', sigma: 'σ',
  mu: 'μ', pi: 'π', lambda: 'λ', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔',
};

// Decode one entity at src[i] (which is '&'). Returns { text, len } or null.
function decodeEntity(src, i) {
  const m = src.slice(i, i + 36).match(/^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/);
  if (!m) return null;
  if (m[1] != null || m[2] != null) {
    let cp = m[1] != null ? parseInt(m[1], 10) : parseInt(m[2], 16);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  const named = ENTITIES[m[3]];
  return named ? { text: named, len: m[0].length } : null;
}

// Link-scheme probe — strip ASCII controls/space first so `java\tscript:`
// cannot slip past (cradle's reviewed posture, SPEC §5).
function urlScheme(url) {
  const probe = String(url).replace(/[\x00-\x20]+/g, '');
  const m = probe.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}
function strippedUrl(url) {
  return String(url).replace(/[\x00-\x20]+/g, '');
}

// ── src/inline.js ──

// @gcu/markdown — the inline scanner. One forward pass over a block's content
// string producing inline AST nodes; emphasis/strike/mark resolve afterward via
// the delimiter machinery (the corpus-frozen rule, SPEC §3.2). Never throws on
// content: every malformed construct degrades to literal text.
//
// Direct-scan constructs (resolved at sight, no delimiter stack): code spans,
// math, kbd, sub/sup, autolinks, bare-URL linkify, footnote refs, escapes,
// breaks. Bracket constructs (links/images) use marker tokens resolved at `]`.
// Delimiter constructs (* _ em/strong, ~~ strike, == mark) collect run tokens
// and resolve per sibling scope — link children resolve when the link closes,
// so emphasis never spans a bracket boundary.
//
// Offsets: node.start/.end index into the block's CONTENT string (the block
// node carries the absolute source range; see block.js).


const text = (value, start, end) => ({ type: 'text', value, start, end });

// ── delimiter classification (SPEC §3.2, frozen by corpus) ────────────
function classify(src, ch, i, j) {
  const prev = cpBefore(src, i), next = cpAt(src, j);
  let canOpen = !isSpaceCp(next);
  let canClose = !isSpaceCp(prev);
  // Punctuation guard: a run facing punctuation only opens/closes from a
  // space-or-punctuation side (kills `2*$nx$ + 1, 2*$ny$` spurious italics).
  if (isPunctCp(next) && isAlnumCp(prev)) canOpen = false;
  if (isPunctCp(prev) && isAlnumCp(next)) canClose = false;
  if (ch === '_') {           // intraword _ never triggers
    if (isAlnumCp(prev)) canOpen = false;
    if (isAlnumCp(next)) canClose = false;
  }
  return { canOpen, canClose };
}

// ── emphasis resolution over one sibling scope ────────────────────────
// Pairing exactly as corpus-proven: nearest same-char opener, skipped openers
// discarded (no cross-nesting), 2-then-1 length consumption; opener consumes
// from its right (innermost), closer from its left — so ***x*** = em(strong x).
// `kind` maps a delimiter to node type(s): dual ('*'/'_') or single.
function resolveDelims(tokens) {
  const delims = tokens.filter((t) => t._delim);
  const stack = [];
  for (const d of delims) {
    if (d.canClose) {
      while (d.rem > 0) {
        let m = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].ch === d.ch) { m = s; break; }
        }
        if (m < 0) break;
        stack.length = m + 1;            // discard skipped openers → literal
        const o = stack[m];
        while (d.rem > 0 && o.rem > 0) {
          let take, type;
          if (d.dual) {
            take = (d.rem >= 2 && o.rem >= 2) ? 2 : 1;
            type = take === 2 ? 'strong' : 'em';
          } else {
            take = d.unit; type = d.kind;
          }
          o.opens.push(type);            // recorded inner→outer
          d.closes.push(type);
          o.rem -= take; d.rem -= take;
        }
        if (o.rem <= 0) stack.pop();
      }
    }
    if (d.rem >= (d.dual ? 1 : d.unit) && d.canOpen) stack.push(d);
  }
  // Rebuild the sibling array with nested nodes. Pairings are well-nested by
  // construction; the defensive branches keep malformed states literal.
  const root = [];
  const open = [];                       // stack of {node}
  let cur = root;
  for (const t of tokens) {
    if (!t._delim) { cur.push(t); continue; }
    for (const type of t.closes) {
      const width = t.dual ? (type === 'strong' ? 2 : 1) : t.unit;
      t._closeUsed = (t._closeUsed || 0) + width;
      const top = open[open.length - 1];
      if (top && top.node.type === type) {
        open.pop();
        top.node.end = t.start + t._closeUsed;
        cur = open.length ? open[open.length - 1].node.children : root;
      } else {
        cur.push(text(t.ch.repeat(width), t.start, t.start + width));
      }
    }
    if (t.rem > 0) cur.push(text(t.ch.repeat(t.rem), t.start, t.end));
    for (let k = t.opens.length - 1; k >= 0; k--) {   // reversed → outermost first
      const type = t.opens[k];
      const node = { type, children: [], start: t.start, end: t.end };
      cur.push(node);
      open.push({ node });
      cur = node.children;
    }
  }
  // Unclosed opens (defensive — shouldn't happen): flatten to literal-ish by
  // leaving the nodes in place; their children are already attached.
  return mergeText(root);
}

function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === 'text' && last && last.type === 'text') {
      last.value += n.value; last.end = n.end;
    } else out.push(n);
  }
  return out;
}

// ── the scanner ───────────────────────────────────────────────────────
// ctx: { refs: Map, ext: {…extension flags}, html: bool, footnotes: Map }
function parseInline(src, ctx) {
  const ext = ctx.ext || {};
  const tokens = [];
  let i = 0;
  let textStart = 0;
  let buf = '';

  const flush = () => {
    if (buf) { tokens.push(text(buf, textStart, i)); buf = ''; }
  };
  const push = (node) => { flush(); tokens.push(node); };
  const lit = (s, n = s.length) => {       // literal text, advance n
    if (!buf) textStart = i;
    buf += s; i += n;
  };

  while (i < src.length) {
    const c = src[i];

    // escapes — \punct → literal char; \<newline> → hard break
    if (c === '\\') {
      const n = src[i + 1];
      if (n === '\n') { push({ type: 'hardbreak', start: i, end: i + 2 }); i += 2; textStart = i; continue; }
      if (isEscapable(n)) { if (!buf) textStart = i; buf += n; i += 2; continue; }
      lit('\\', 1); continue;
    }

    // line breaks — trailing two-spaces accepted on read (lint flags them)
    if (c === '\n') {
      const trimmed = buf.replace(/[ \t]+$/, '');
      const hard = buf.length - trimmed.length >= 2;
      buf = trimmed;
      push({ type: hard ? 'hardbreak' : 'softbreak', start: i, end: i + 1 });
      i++; textStart = i; continue;
    }

    // code spans — backtick run, matching closer of the same length
    if (c === '`') {
      let j = i; while (src[j] === '`') j++;
      const fence = j - i;
      let k = j, close = -1;
      while (k < src.length) {
        if (src[k] === '`') {
          let l = k; while (src[l] === '`') l++;
          if (l - k === fence) { close = k; break; }
          k = l;
        } else k++;
      }
      if (close < 0) { lit(src.slice(i, j), fence); continue; }
      let content = src.slice(j, close).replace(/\n/g, ' ');
      if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
        content = content.slice(1, -1);    // CM: strip one padding space pair
      }
      push({ type: 'codeSpan', value: content, start: i, end: close + fence });
      i = close + fence; textStart = i; continue;
    }

    // math — $$display$$ / $inline$ (extension)
    if (c === '$' && ext.math) {
      if (src[i + 1] === '$') {
        const close = src.indexOf('$$', i + 2);
        if (close > i + 1) {
          push({ type: 'math', mode: 'display', latex: src.slice(i + 2, close), start: i, end: close + 2 });
          i = close + 2; textStart = i; continue;
        }
        lit('$$', 2); continue;
      }
      if (!isSpaceCp(cpAt(src, i + 1))) {
        let k = i + 1;
        while (k < src.length && src[k] !== '$') { if (src[k] === '\\') k++; k++; }
        if (k < src.length && k > i + 1 && !isSpaceCp(cpBefore(src, k))) {
          push({ type: 'math', mode: 'inline', latex: src.slice(i + 1, k), start: i, end: k + 1 });
          i = k + 1; textStart = i; continue;
        }
      }
      lit('$', 1); continue;
    }

    // kbd — ++ctrl+enter++ (extension)
    if (c === '+' && src[i + 1] === '+' && ext.kbd) {
      const close = src.indexOf('++', i + 2);
      const nl = src.indexOf('\n', i + 2);
      if (close > i + 1 && (nl < 0 || close < nl) && close > i + 2) {
        push({ type: 'kbd', value: src.slice(i + 2, close), start: i, end: close + 2 });
        i = close + 2; textStart = i; continue;
      }
      lit('++', 2); continue;
    }

    // sub/sup — ~x~ / ^x^, intraword by design (H~2~O, x^2^), no spaces inside
    if ((c === '^' || c === '~') && ext.subsup && !(c === '~' && src[i + 1] === '~')) {
      let k = i + 1, ok = false;
      while (k < src.length) {
        const ch = src[k];
        if (ch === c) { ok = k > i + 1; break; }
        if (ch === ' ' || ch === '\t' || ch === '\n') break;
        k++;
      }
      if (ok) {
        push({ type: c === '^' ? 'sup' : 'sub', children: [text(src.slice(i + 1, k), i + 1, k)], start: i, end: k + 1 });
        i = k + 1; textStart = i; continue;
      }
      if (c === '^') { lit('^', 1); continue; }
      // single ~ falls through to the delimiter path below (strike handles runs)
    }

    // delimiter runs — * _ (dual), ~~ strike, == mark
    if (c === '*' || c === '_' || (c === '~' && src[i + 1] === '~' && ext.strike)
      || (c === '=' && src[i + 1] === '=' && ext.mark)) {
      let j = i; while (src[j] === c) j++;
      const len = j - i;
      const { canOpen, canClose } = classify(src, c, i, j);
      const dual = c === '*' || c === '_';
      if (!dual && len < 2) { lit(c, 1); continue; }
      flush();
      tokens.push({
        _delim: true, ch: c, start: i, end: j, len,
        rem: dual ? len : (len - (len % 2)),
        dual, unit: dual ? 1 : 2,
        kind: c === '~' ? 'strike' : c === '=' ? 'mark' : null,
        canOpen, canClose, opens: [], closes: [],
      });
      if (!dual && len % 2) tokens.push(text(c, j - 1, j));
      i = j; textStart = i; continue;
    }

    // footnote ref / bracket markers
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const image = c === '!';
      const bi = image ? i + 1 : i;
      if (!image && src[i + 1] === '^' && ext.footnotes) {
        const close = src.indexOf(']', i + 2);
        if (close > i + 2 && !/\s/.test(src.slice(i + 2, close))) {
          push({ type: 'footnoteRef', label: src.slice(i + 2, close), start: i, end: close + 1 });
          i = close + 1; textStart = i; continue;
        }
      }
      flush();
      tokens.push({ _bracket: true, image, active: true, start: i, end: bi + 1 });
      i = bi + 1; textStart = i; continue;
    }

    // bracket close — resolve link/image
    if (c === ']') {
      flush();   // label text must be IN tokens for shortcut-ref flattening
      let bk = -1;
      for (let t = tokens.length - 1; t >= 0; t--) {
        if (tokens[t]._bracket && tokens[t].active) { bk = t; break; }
      }
      if (bk < 0) { lit(']', 1); continue; }
      const marker = tokens[bk];
      const resolved = resolveLinkAt(src, i + 1, marker, tokens, bk, ctx);
      if (resolved) {
        const children = resolveDelims(tokens.splice(bk + 1));
        tokens.splice(bk, 1);   // remove the bracket marker
        const node = marker.image
          ? { type: 'image', src: resolved.dest, title: resolved.title, alt: flattenText(children), start: marker.start, end: resolved.end }
          : { type: 'link', href: resolved.dest, title: resolved.title, children, start: marker.start, end: resolved.end };
        tokens.push(node);
        if (!marker.image) {
          for (const t of tokens) if (t._bracket && !t.image) t.active = false;  // no links in links
        }
        i = resolved.end; textStart = i; continue;
      }
      marker.active = false;
      lit(']', 1); continue;
    }

    // entities — numeric + curated named set, decoded to TEXT (re-escaped at
    // render; decode-to-text cannot inject)
    if (c === '&') {
      const e = decodeEntity(src, i);
      if (e) { if (!buf) textStart = i; buf += e.text; i += e.len; continue; }
      lit('&', 1); continue;
    }

    // autolinks / inline HTML-shaped tokens
    if (c === '<') {
      const rest = src.slice(i, i + 512);
      let m = rest.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^\s<>]*)>/);
      if (m) {
        push({ type: 'autolink', href: m[1] + ':' + m[2], start: i, end: i + m[0].length });
        i += m[0].length; textStart = i; continue;
      }
      m = rest.match(/^<([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/);
      if (m) {
        push({ type: 'autolink', href: 'mailto:' + m[1], email: m[1], start: i, end: i + m[0].length });
        i += m[0].length; textStart = i; continue;
      }
      if (ctx.html) {
        m = rest.match(/^<\/?[a-zA-Z][^<>\n]*>|^<!--[\s\S]*?-->/);
        if (m) {
          push({ type: 'htmlInline', raw: m[0], start: i, end: i + m[0].length });
          i += m[0].length; textStart = i; continue;
        }
      }
      lit('<', 1); continue;
    }

    // bare-URL linkify (extension; GFM trailing-punctuation trimming)
    if (c === 'h' && ext.autolinkBare && /^https?:\/\//.test(src.slice(i, i + 8))
      && (i === 0 || isSpaceCp(cpBefore(src, i)) || '([{'.includes(src[i - 1]))) {
      let k = i;
      while (k < src.length && !/[\s<>]/.test(src[k])) k++;
      let url = src.slice(i, k);
      for (;;) {
        const last = url[url.length - 1];
        if (')' === last) {
          let bal = 0;
          for (const ch of url) { if (ch === '(') bal++; else if (ch === ')') bal--; }
          if (bal < 0) { url = url.slice(0, -1); continue; }
          break;
        }
        if (/[.,:;!?'"\]]/.test(last)) { url = url.slice(0, -1); continue; }
        break;
      }
      if (url.length > 8) {
        push({ type: 'autolink', href: url, start: i, end: i + url.length });
        i += url.length; textStart = i; continue;
      }
      lit('h', 1); continue;
    }

    lit(c, c.length);
  }
  flush();

  // deactivate leftover bracket markers → literal text
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t]._bracket) {
      tokens[t] = text(tokens[t].image ? '![' : '[', tokens[t].start, tokens[t].end);
    }
  }
  return resolveDelims(tokens);
}

// Try to resolve a link tail at position `at` (just past `]`). Returns
// { dest, title, end } or null. Inline form, full/collapsed/shortcut reference.
function resolveLinkAt(src, at, marker, tokens, bk, ctx) {
  // inline: (dest "title")
  if (src[at] === '(') {
    let k = at + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    let dest = '', title = null;
    if (src[k] === '<') {
      const close = src.indexOf('>', k + 1);
      if (close < 0) return null;
      dest = src.slice(k + 1, close);
      k = close + 1;
    } else {
      let depth = 0;
      const start = k;
      while (k < src.length) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (/\s/.test(ch)) break;
        if (ch === '(') depth++;
        if (ch === ')') { if (depth === 0) break; depth--; }
        k++;
      }
      dest = src.slice(start, k);
    }
    while (k < src.length && /\s/.test(src[k])) k++;
    const q = src[k];
    if (q === '"' || q === "'") {
      let close = -1;
      for (let t = k + 1; t < src.length; t++) {
        if (src[t] === '\\') { t++; continue; }     // \" inside a title
        if (src[t] === q) { close = t; break; }
      }
      if (close < 0) return null;
      title = src.slice(k + 1, close);
      k = close + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
    }
    if (src[k] !== ')') return null;
    return { dest: unescapeMd(dest), title: title && unescapeMd(title), end: k + 1 };
  }
  // reference forms
  const refs = ctx.refs;
  const labelText = () => normLabel(flattenRaw(tokens.slice(bk + 1)));
  const hit = (def, end) => {
    if (!def) return null;
    def.used = true;
    return { dest: def.dest, title: def.title, end };
  };
  if (src[at] === '[') {
    const close = src.indexOf(']', at + 1);
    if (close < 0) return null;
    const label = close === at + 1 ? labelText() : normLabel(src.slice(at + 1, close));
    return hit(refs && refs.get(label), close + 1);
  }
  // shortcut [label]
  return hit(refs && refs.get(labelText()), at);
}

const normLabel = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const unescapeMd = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

function flattenRaw(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.type === 'text') out += t.value;
    else if (t._delim) out += t.ch.repeat(t.len);
    else if (t.type === 'codeSpan') out += t.value;
    else if (t.children) out += flattenText(t.children);
    else if (t.value != null) out += t.value;
  }
  return out;
}

function flattenText(nodes) {
  let out = '';
  for (const n of nodes || []) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'codeSpan' || n.type === 'kbd') out += n.value;
    else if (n.type === 'math') out += n.latex;
    else if (n.type === 'autolink') out += n.email || n.href;
    else if (n.children) out += flattenText(n.children);
    else if (n.type === 'softbreak' || n.type === 'hardbreak') out += ' ';
  }
  return out;
}

// ── src/block.js ──

// @gcu/markdown — the block scanner. Line-classified, single forward pass with
// bounded lookahead (one line, for GFM table separators only — SPEC §3.1); no
// setext, no indented code blocks, no lazy continuation (§3.3), so every line's
// block role is decided where it stands. Containers (blockquotes, list items)
// recurse on sliced line groups rather than a mutable container stack — the
// natural shape once laziness is gone.
//
// Lines arrive as { text, start } (absolute source offset of the line start);
// container recursion slices text and bumps start so block nodes keep absolute
// { start, end } ranges. Inline content offsets are relative to the joined
// content string (the block's `start` anchors them; SPEC §2.4 note).


const BLANK = /^[ \t]*$/;

function splitLines(src) {
  const lines = [];
  let pos = 0;
  for (const part of src.split('\n')) {
    lines.push({ text: part, start: pos });
    pos += part.length + 1;
  }
  return lines;
}

const indentOf = (s) => { let n = 0; while (s[n] === ' ') n++; return n; };
const lineEnd = (line) => line.start + line.text.length;

// ── block-start classifiers ──────────────────────────────────────────
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_QUOTE = /^ {0,3}> ?/;
const RE_BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
const RE_ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const RE_REFDEF = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?[ \t]*$/;
const RE_ADMONITION = /^!!![ \t]+(\w+)(?:[ \t]+"([^"]*)")?[ \t]*$/;
const RE_FOOTDEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const RE_TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_HTML_OPEN = /^ {0,3}<\/?[a-zA-Z!][^>]*>?/;

// ctx: { refs: Map, footnotes: Map, ext, html, lintSink?, pending: [] }
//
// Inline content is parsed LAZILY: blocks receive an empty children array and
// a { holder, raw } entry lands in ctx.pending; api.parse resolves them after
// the whole block pass — so reference definitions ANYWHERE in the document are
// collected before any [text][label] tries to resolve.
function parseBlocks(lines, ctx) {
  const nodes = [];
  const ext = ctx.ext || {};
  let i = 0;

  const inl = (raw) => {
    const holder = [];
    ctx.pending.push({ holder, raw });
    return holder;
  };

  const lint = (rule, message, line) => {
    if (ctx.lintSink) ctx.lintSink.push({ rule, message, start: line.start, end: lineEnd(line) });
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.text;

    if (BLANK.test(t)) { i++; continue; }

    // fenced code
    let m = t.match(RE_FENCE);
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      const indent = m[1].length, fch = m[2][0], flen = m[2].length;
      const lang = m[3].trim().split(/\s+/)[0] || '';
      const body = [];
      let j = i + 1, closed = false;
      for (; j < lines.length; j++) {
        const ct = lines[j].text;
        const cm = ct.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (cm && cm[1][0] === fch && cm[1].length >= flen) { closed = true; break; }
        body.push(ct.replace(new RegExp(`^ {0,${indent}}`), ''));
      }
      nodes.push({
        type: 'fence', lang, code: body.join('\n') + (body.length ? '\n' : ''),
        start: line.start, end: lineEnd(lines[Math.min(j, lines.length - 1)]),
      });
      i = closed ? j + 1 : j;
      continue;
    }

    // ATX heading
    m = t.match(RE_ATX);
    if (m) {
      let content = m[2] || '';
      let id = null;
      if (ext.headingIds) {
        const idm = content.match(/[ \t]+\{#([A-Za-z][\w-]*)\}[ \t]*$/);
        if (idm) { id = idm[1]; content = content.slice(0, idm.index); }
      }
      nodes.push({
        type: 'heading', level: m[1].length, id,
        children: inl(content.trim()),
        start: line.start, end: lineEnd(line),
      });
      i++; continue;
    }

    // thematic break (before lists: `- - -` is an hr, not a list)
    if (RE_HR.test(t)) {
      nodes.push({ type: 'hr', start: line.start, end: lineEnd(line) });
      i++; continue;
    }

    // blockquote — consecutive `>` lines (blank or unprefixed line ends it; no laziness)
    if (RE_QUOTE.test(t)) {
      const inner = [];
      let j = i;
      for (; j < lines.length; j++) {
        const qm = lines[j].text.match(RE_QUOTE);
        if (!qm) break;
        inner.push({ text: lines[j].text.slice(qm[0].length), start: lines[j].start + qm[0].length });
      }
      nodes.push({
        type: 'blockquote', children: parseBlocks(inner, ctx),
        start: line.start, end: lineEnd(lines[j - 1]),
      });
      i = j; continue;
    }

    // admonition (extension) — `!!! type "title"` + indented body. Dedent =
    // strip up to 4 leading spaces / one tab per line (renderMd's behavior).
    if (ext.admonitions) {
      m = t.match(RE_ADMONITION);
      if (m) {
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bt = lines[j].text;
          if (BLANK.test(bt)) continue;
          if (!/^[ \t]/.test(bt)) break;
        }
        const dedented = [];
        for (let k = i + 1; k < j; k++) {
          const bt = lines[k].text;
          const stripped = bt.replace(/^(?: {1,4}|\t)/, '');
          dedented.push({ text: stripped, start: lines[k].start + (bt.length - stripped.length) });
        }
        while (dedented.length && BLANK.test(dedented[dedented.length - 1].text)) dedented.pop();
        nodes.push({
          type: 'admonition', kind: m[1], title: m[2] || null,
          children: parseBlocks(dedented, ctx),
          start: line.start, end: dedented.length ? lineEnd(lines[j - 1]) : lineEnd(line),
        });
        i = j; continue;
      }
    }

    // footnote definition (extension) — `[^label]: text` + 4-indented continuation
    if (ext.footnotes) {
      m = t.match(RE_FOOTDEF);
      if (m) {
        const label = m[1];
        const inner = [{ text: m[2], start: line.start + (t.length - m[2].length) }];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const bt = lines[j].text;
          if (BLANK.test(bt)) { inner.push({ text: '', start: lines[j].start }); continue; }
          if (!/^(?: {4}|\t)/.test(bt)) break;
          const stripped = bt.replace(/^(?: {4}|\t)/, '');
          inner.push({ text: stripped, start: lines[j].start + (bt.length - stripped.length) });
        }
        while (inner.length && BLANK.test(inner[inner.length - 1].text)) inner.pop();
        const node = {
          type: 'footnoteDef', label,
          children: parseBlocks(inner, ctx),
          start: line.start, end: lineEnd(lines[j - 1] || line),
        };
        nodes.push(node);
        if (ctx.footnotes && !ctx.footnotes.has(label)) ctx.footnotes.set(label, node);
        i = j; continue;
      }
    }

    // link reference definition (single-line form)
    m = t.match(RE_REFDEF);
    if (m && ctx.refs) {
      const label = normLabel(m[1]);
      if (!ctx.refs.has(label)) {
        let dest = m[2];
        if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1);
        ctx.refs.set(label, { dest, title: m[3] ?? m[4] ?? null, used: false, start: line.start });
      } else lint('duplicate-refdef', `duplicate reference definition [${m[1]}]`, line);
      i++; continue;
    }

    // lists
    m = t.match(RE_BULLET) || t.match(RE_ORDERED);
    if (m) {
      const ordered = m.length === 5;
      const markerCh = ordered ? m[3] : m[2];
      const startNum = ordered ? parseInt(m[2], 10) : null;
      const items = [];
      let loose = false;
      let j = i;
      let pendingBlank = false;
      while (j < lines.length) {
        const lt = lines[j].text;
        if (BLANK.test(lt)) { pendingBlank = true; j++; continue; }
        const im = ordered ? lt.match(RE_ORDERED) : lt.match(RE_BULLET);
        if (!im || (ordered ? im[3] : im[2]) !== markerCh) break;
        if (pendingBlank && items.length) loose = true;
        pendingBlank = false;
        // content column: indent + marker + one space block (cap 4)
        const markerLen = im[1].length + (ordered ? im[2].length + 1 : 1);
        const spaces = (im[4] ?? im[3] ?? '').length || 1;
        const col = markerLen + Math.min(Math.max(spaces, 1), 4);
        const first = lt.slice(Math.min(col, lt.length));
        const inner = [{ text: first, start: lines[j].start + Math.min(col, lt.length) }];
        let k = j + 1;
        for (; k < lines.length; k++) {
          const ct = lines[k].text;
          if (BLANK.test(ct)) { inner.push({ text: '', start: lines[k].start }); continue; }
          if (indentOf(ct) < col) break;
          inner.push({ text: ct.slice(col), start: lines[k].start + col });
        }
        while (inner.length && BLANK.test(inner[inner.length - 1].text)) inner.pop();
        // a blank line BETWEEN blocks inside an item → the list is loose
        // (a nested list with no blank keeps the list tight — blank-driven,
        // not structure-driven)
        for (let q = 1; q < inner.length - 1; q++) {
          if (BLANK.test(inner[q].text)) { loose = true; break; }
        }
        let task = null;
        if (ext.tasklists && !ordered) {
          const tm = inner[0] && inner[0].text.match(/^\[([ xX])\][ \t]+/);
          if (tm) {
            task = tm[1] === ' ' ? 'unchecked' : 'checked';
            inner[0] = { text: inner[0].text.slice(tm[0].length), start: inner[0].start + tm[0].length };
          }
        }
        const children = parseBlocks(inner, ctx);
        items.push({
          type: 'listItem', task, children,
          start: lines[j].start, end: lineEnd(lines[k - 1] || lines[j]),
        });
        // blanks consumed (then trimmed) at the item's tail still separate
        // items — the next iteration must see them as a pending blank.
        if (k > j && k < lines.length && BLANK.test(lines[k - 1].text)) pendingBlank = true;
        j = k;
      }
      nodes.push({
        type: 'list', ordered, startNum, tight: !loose, children: items,
        start: line.start, end: items.length ? items[items.length - 1].end : lineEnd(line),
      });
      i = j; continue;
    }

    // GFM table — the one-line lookahead (header row + separator row)
    if (ext.tables && t.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1].text)) {
      const head = splitRow(t);
      const align = splitRow(lines[i + 1].text).map((c) => {
        const s = c.trim();
        const l = s.startsWith(':'), r = s.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      if (head.length >= 1 && align.length >= 1) {
        const rows = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const rt = lines[j].text;
          if (BLANK.test(rt) || !rt.includes('|')) break;
          rows.push(splitRow(rt));
        }
        nodes.push({
          type: 'table', align,
          head: head.map((c) => inl(c.trim())),
          rows: rows.map((r) => {
            const cells = r.map((c) => inl(c.trim()));
            while (cells.length < head.length) cells.push([]);
            return cells.slice(0, head.length);
          }),
          start: line.start, end: lineEnd(lines[j - 1]),
        });
        i = j; continue;
      }
    }

    // raw HTML block (html: true only) — tag-opened lines until blank
    if (ctx.html && RE_HTML_OPEN.test(t)) {
      const raw = [t];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (BLANK.test(lines[j].text)) break;
        raw.push(lines[j].text);
      }
      nodes.push({ type: 'htmlBlock', raw: raw.join('\n'), start: line.start, end: lineEnd(lines[j - 1]) });
      i = j; continue;
    }

    // paragraph — consecutive lines until blank or a new block opener
    {
      const para = [t];
      const pstart = line.start;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const pt = lines[j].text;
        if (BLANK.test(pt) || RE_ATX.test(pt) || RE_HR.test(pt) || RE_FENCE.test(pt)
          || RE_QUOTE.test(pt) || RE_BULLET.test(pt) || RE_ORDERED.test(pt)
          || (ext.admonitions && RE_ADMONITION.test(pt))
          || (ext.footnotes && RE_FOOTDEF.test(pt))
          || (ext.tables && pt.includes('|') && j + 1 < lines.length && RE_TABLE_SEP.test(lines[j + 1].text))) break;
        para.push(pt);
      }
      nodes.push({
        type: 'paragraph',
        children: inl(para.join('\n').replace(/[ \t]+$/, '')),
        start: pstart, end: lineEnd(lines[j - 1]),
      });
      i = j;
    }
  }
  return nodes;
}

// Split a table row on unescaped `|`, honoring `\|` and code spans crudely
// (a backtick-balanced heuristic: pipes inside an open code span don't split).
function splitRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', ticks = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') { ticks ^= 1; cur += c; continue; }
    if (c === '|' && !ticks) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

// ── src/render.js ──

// @gcu/markdown — AST → HTML. The consumer owns the output (SPEC §2.6): every
// node type renders through a rule that opts.rules can override; the defaults
// implement the §5 policies (scheme-allowlisted links, raster-data-only
// images) and the §7 output-compat markup (renderMd's admonition classes,
// auto-slug algorithm, kbd pills, language-<tag> code classes).
//
// "Generate, never sanitize": there is no sanitizer here. html:false never
// produces html nodes (the parsers don't emit them), and every text path goes
// through escapeHtml — inert by construction.


// ── policies (§5) — overridable via opts.linkPolicy / opts.imagePolicy ──
function defaultLinkPolicy(href) {
  const probe = strippedUrl(href);
  if (probe.startsWith('#')) return true;            // in-page anchor
  const scheme = urlScheme(probe);
  if (!scheme) return true;                          // relative — nothing to abuse
  return /^(https?|mailto|tel)$/.test(scheme);
}
function defaultImagePolicy(src) {
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
const defaultRules = {
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
  // renderMd compat: ++ctrl+enter++ → one pill per key, joined by '+'.
  kbd: (n) => n.value.split('+').map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('+'),

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
function renderAst(ast, opts = {}) {
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
      // autoIds: true = every level; a number = max level (renderMd compat:
      // the notebook/docs presets use 3 — h4-h6 stay anchor-less).
      const auto = opts.autoIds;
      if (!opts.extensions || !opts.extensions.headingIds || !auto) return null;
      if (typeof auto === 'number' && n.level > auto) return null;
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

// ── src/api.js ──

// @gcu/markdown — public API (SPEC §6): parse / render / renderAst / lint +
// the per-consumer presets. A preset is a plain options object — spread and
// override, no magic.



const EXT_ALL = {
  tables: true, tasklists: true, strike: true, footnotes: true, math: true,
  admonitions: true, kbd: true, headingIds: true, autolinkBare: true,
  subsup: true, mark: true, comments: true,
};

// ── presets (SPEC §6) ─────────────────────────────────────────────────
const presets = {
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
function parse(src, opts = {}) {
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
function render(src, opts = {}) {
  return renderAst(parse(src, opts).ast, opts);
}

// ── lint — the strict authoring profile (SPEC §3.4) ───────────────────
// Returns source-mapped findings for everything the reader accepts but the
// canonical GCU dialect writes one way. render() never rejects; this advises.
function lint(src, opts = {}) {
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

// ── src/main.js ──

// @gcu/markdown — module manifest (build entry; api.js is the public surface).

export {
  renderAst,
  defaultRules,
  defaultLinkPolicy,
  defaultImagePolicy,
  escapeHtml,
  slugify,
  presets,
  parse,
  render,
  lint,
};
