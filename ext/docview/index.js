// @gcu/docview — shared document-rendering helpers for Works reading surfaces.
//
// Extracted from works/surfaces/docs.html so the docs surface and the book
// reader share one implementation of: markdown-render decoration (heading
// anchors + smooth scroll), a regex syntax highlighter for fenced code, a
// scroll-spy "on this page" TOC, a librarian search-index builder, link
// rewiring, and a debounced VFS state-persister.
//
// Dependency-injected, NOT importing @gcu/markdown or @gcu/librarian itself:
// the consuming surface owns those imports and passes renderMd / slugify /
// Librarian in. (A shared lib that bare-imports another shared lib is fragile
// under the surface import-map build — see build.js rewriteSurfaceToDynamic.
// DI sidesteps it and mirrors the patchbay/sideact pattern.)

// ── Syntax highlighting ─────────────────────────────────────────────
// Minimal regex tokenizer for fenced code blocks. Covers js/py/json/sh via a
// shared identifier/comment/string/number scan; html via a separate
// tag-and-comment pass. Emits <span class="tok-*"> the surface styles.

const _SYNTAX = {
  js: {
    keywords: new Set('const let var function return if else for while do switch case break continue new class extends import export from as async await try catch finally throw of in typeof instanceof delete null undefined true false default static this super yield void debugger'.split(' ')),
    line: '//', block: ['/*', '*/'],
    strings: { '"': '"', "'": "'", '`': '`' },
  },
  py: {
    keywords: new Set('def class if elif else for while break continue return yield import from as pass raise try except finally with lambda global nonlocal True False None and or not in is async await match case del assert'.split(' ')),
    line: '#', block: null,
    strings: { '"""': '"""', "'''": "'''", '"': '"', "'": "'" },
  },
  json: {
    keywords: new Set(['true', 'false', 'null']),
    line: null, block: null,
    strings: { '"': '"' },
  },
  sh: {
    keywords: new Set('if then else elif fi for in do done while until case esac function return exit export local readonly'.split(' ')),
    builtins: new Set('cd ls cat echo pwd grep sed awk find chmod chown mv cp rm mkdir rmdir touch'.split(' ')),
    line: '#', block: null,
    strings: { '"': '"', "'": "'" },
  },
};
_SYNTAX.javascript = _SYNTAX.js;
_SYNTAX.python = _SYNTAX.py;
_SYNTAX.bash = _SYNTAX.sh;

function _escTok(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _reEscTok(s) { return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); }

function _tokenize(code, lang) {
  const spec = _SYNTAX[lang];
  if (!spec) return _escTok(code);
  const parts = [];
  if (spec.block) {
    parts.push({ type: 'comment',
      re: _reEscTok(spec.block[0]) + '[\\s\\S]*?' + _reEscTok(spec.block[1]) });
  }
  if (spec.line) {
    parts.push({ type: 'comment', re: _reEscTok(spec.line) + '[^\\n]*' });
  }
  if (spec.strings) {
    // Longest delimiters first (so `"""` wins over `"`).
    const delims = Object.keys(spec.strings).sort((a, b) => b.length - a.length);
    for (const d of delims) {
      const dE = _reEscTok(d);
      if (d.length === 3) {
        parts.push({ type: 'string', re: dE + '[\\s\\S]*?' + dE });
      } else if (d === '`') {
        parts.push({ type: 'string', re: '`(?:[^`\\\\]|\\\\.)*`' });
      } else {
        parts.push({ type: 'string',
          re: dE + '(?:[^' + dE + '\\\\\\n]|\\\\.)*' + dE });
      }
    }
  }
  parts.push({ type: 'number', re: '\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' });
  parts.push({ type: 'identifier', re: '[a-zA-Z_$][\\w$]*' });

  const combined = new RegExp(parts.map(p => `(${p.re})`).join('|'), 'g');
  let out = '', last = 0, m;
  while ((m = combined.exec(code)) !== null) {
    if (m.index > last) out += _escTok(code.slice(last, m.index));
    let part = null;
    for (let i = 1; i <= parts.length; i++) {
      if (m[i] !== undefined) { part = parts[i - 1]; break; }
    }
    const text = m[0];
    if (part.type === 'identifier') {
      if (spec.keywords && spec.keywords.has(text)) {
        out += `<span class="tok-keyword">${_escTok(text)}</span>`;
      } else if (spec.builtins && spec.builtins.has(text)) {
        out += `<span class="tok-builtin">${_escTok(text)}</span>`;
      } else {
        out += _escTok(text);
      }
    } else {
      out += `<span class="tok-${part.type}">${_escTok(text)}</span>`;
    }
    last = m.index + text.length;
  }
  if (last < code.length) out += _escTok(code.slice(last));
  return out;
}

function _tokenizeHtml(code) {
  const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += _escTok(code.slice(last, m.index));
    const cls = m[0].startsWith('<!--') ? 'comment' : 'tag';
    out += `<span class="tok-${cls}">${_escTok(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  if (last < code.length) out += _escTok(code.slice(last));
  return out;
}

// Highlight every `pre code[class*="language-"]` under root in place.
export function highlightCode(root) {
  for (const code of root.querySelectorAll('pre code[class*="language-"]')) {
    const lang = (code.className.match(/language-([\w-]+)/) || [])[1];
    if (!lang) continue;
    const raw = code.textContent;
    if (lang === 'html' || lang === 'xml' || lang === 'svg') {
      code.innerHTML = _tokenizeHtml(raw);
    } else if (_SYNTAX[lang]) {
      code.innerHTML = _tokenize(raw, lang);
    }
  }
}

// ── Heading anchors + smooth scroll ─────────────────────────────────

// Scroll to a heading by id and flash it in the accent colour. Returns
// false if the id isn't present (caller can fall back to scroll-to-top).
// ids are document-global, so a plain getElementById finds them regardless
// of which container the content lives in.
export function scrollToAnchor(anchor) {
  if (!anchor) return false;
  const el = document.getElementById(anchor);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.style.transition = 'color 0.3s';
  const prev = el.style.color;
  el.style.color = 'var(--au-action)';
  setTimeout(() => { el.style.color = prev; }, 1200);
  return true;
}

// Add a § anchor next to each heading for copy-deep-link. onCopy(id) is
// called when a § is clicked (after scrolling), for clipboard handling.
export function decorateHeadings(contentEl, onCopy) {
  for (const h of contentEl.querySelectorAll('h1[id], h2[id], h3[id]')) {
    if (h.querySelector('.anchor-link')) continue;
    const a = document.createElement('a');
    a.className = 'anchor-link';
    a.textContent = '§';
    a.href = '#' + h.id;
    a.title = 'Copy link to this section';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      scrollToAnchor(h.id, contentEl);
      if (onCopy) { try { onCopy(h.id); } catch { /* ignore */ } }
    });
    h.insertBefore(a, h.firstChild);
  }
}

// ── Scroll-spy "On this page" TOC ───────────────────────────────────
// Builds from h2/h3[id] under contentEl into tocEl. Returns a controller
// with { update, items } — call update() on content scroll (rAF-coalesced
// by the caller) to track the active heading.

export function buildToc(contentEl, tocEl, { onClick, heading = 'On this page' } = {}) {
  tocEl.innerHTML = '';
  const items = [];
  const headings = contentEl.querySelectorAll('h2[id], h3[id]');
  if (headings.length < 2) {
    tocEl.classList.add('empty-toc');
    return { items, update() {} };
  }
  tocEl.classList.remove('empty-toc');
  const h4 = document.createElement('h4');
  h4.textContent = heading;
  tocEl.appendChild(h4);
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = (h.textContent || '').replace(/^§\s*/, '').trim();
    a.className = h.tagName === 'H3' ? 'lvl3' : 'lvl2';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (onClick) onClick(h.id); else scrollToAnchor(h.id, contentEl);
    });
    tocEl.appendChild(a);
    items.push({ id: h.id, link: a, heading: h });
  }
  const update = () => {
    if (items.length === 0) return;
    const threshold = contentEl.getBoundingClientRect().top + 80;
    let activeIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].heading.getBoundingClientRect();
      if (rect.top <= threshold) activeIdx = i;
      else break;
    }
    items.forEach((it, i) => it.link.classList.toggle('active', i === activeIdx));
  };
  update();
  return { items, update };
}

// ── Link rewiring ───────────────────────────────────────────────────
// External links → new tab; bare #anchor → in-doc scroll; internal
// .md/dir links → onInternal(resolvedPath, anchor). Path resolution is
// relative to relPath, normalising ../ segments.

export function rewireLinks(contentEl, relPath, onInternal) {
  for (const a of contentEl.querySelectorAll('a[href]')) {
    if (a.classList.contains('anchor-link')) continue;
    const href = a.getAttribute('href');
    if (!href) continue;
    if (/^https?:/i.test(href) || /^mailto:/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    if (href.startsWith('#')) {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        scrollToAnchor(href.slice(1), contentEl);
      });
      continue;
    }
    const [pathPart, anchorPart] = href.split('#');
    if (pathPart && (pathPart.endsWith('.md') || pathPart.endsWith('/'))) {
      const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
      let resolved = dir ? dir + '/' + pathPart : pathPart;
      const parts = resolved.split('/');
      const out = [];
      for (const p of parts) {
        if (p === '..') out.pop();
        else if (p && p !== '.') out.push(p);
      }
      resolved = out.join('/');
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (onInternal) onInternal(resolved, anchorPart || null, pathPart);
      });
    }
  }
}

// ── Librarian search index ──────────────────────────────────────────
// Split a markdown doc into heading-anchored sections, each an indexable
// "document". slugify (from the renderer) keeps anchors matching the
// rendered DOM ids so a hit can jump to the right heading.

export function splitByHeadings(md, filePath, fileTitle, slugify) {
  const lines = md.split('\n');
  const sections = [];
  let cur = { heading: fileTitle, level: 1, anchor: '', body: [] };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m && m[1].length <= 3) {
      if (cur.body.length > 0 || cur.heading) sections.push(cur);
      const headingText = m[2].replace(/[*`_]/g, '').trim();
      cur = { heading: headingText, level: m[1].length, anchor: slugify(m[2]), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.length > 0 || cur.heading) sections.push(cur);
  return sections.map((s) => ({
    id: filePath + (s.anchor ? '#' + s.anchor : ''),
    file: filePath,
    anchor: s.anchor,
    fileTitle,
    heading: s.heading,
    title: s.heading,
    body: s.body.join('\n').trim(),
  }));
}

// Build a librarian index from a list of { path, title, md } docs. The
// caller supplies Librarian (the @gcu/librarian module), slugify, and any
// field-boost / synonym overrides.
export function buildSearchIndex(Librarian, docsInput, slugify, opts = {}) {
  const docs = [];
  for (const d of docsInput) {
    if (!d || !d.md) continue;
    for (const s of splitByHeadings(d.md, d.path, d.title, slugify)) docs.push(s);
  }
  return Librarian.index({
    docs,
    fields: opts.fields || {
      heading: { boost: 4 },
      fileTitle: { boost: 2 },
      body: { boost: 1 },
    },
    synonyms: opts.synonyms || {},
  });
}

// ── Debounced VFS state persister ───────────────────────────────────
// A surface keeps small per-view state (last doc, scroll, collapsed groups,
// bookmarks, …) at a VFS path. read() loads it; schedule(getState) debounces
// a write. ensureDir is created on first write.

export function makeStatePersister(bus, statePath, { delay = 500 } = {}) {
  let timer = null;
  const dir = statePath.includes('/') ? statePath.slice(0, statePath.lastIndexOf('/')) : '';
  async function read() {
    try {
      const txt = await bus.call(
        { to: 'works', path: '/', interface: 'VFS', member: 'Read' }, [statePath, 'utf8']);
      return JSON.parse(txt);
    } catch { return null; }
  }
  async function write(state) {
    try {
      if (dir) await bus.call({ to: 'works', path: '/', interface: 'VFS', member: 'MkDir' }, [dir]);
      await bus.call(
        { to: 'works', path: '/', interface: 'VFS', member: 'Write' },
        [statePath, JSON.stringify(state)]);
    } catch { /* state-write failures aren't worth surfacing */ }
  }
  function schedule(getState) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const s = typeof getState === 'function' ? getState() : getState;
      if (s != null) write(s);
    }, delay);
  }
  return { read, write, schedule };
}
