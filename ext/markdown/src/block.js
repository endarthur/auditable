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

import { normLabel } from './inline.js';

const BLANK = /^[ \t]*$/;

export function splitLines(src) {
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
export function parseBlocks(lines, ctx) {
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
