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

import { cpBefore, cpAt, isSpaceCp, isAlnumCp, isPunctCp, isEscapable, decodeEntity } from './chars.js';

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
export function parseInline(src, ctx) {
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

export const normLabel = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
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

export function flattenText(nodes) {
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
