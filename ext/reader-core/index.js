// @gcu/reader-core — environment-agnostic book-reader engine.
//
// Zero imports by design: everything environment-specific (file I/O, state
// persistence) and every rendering library (markdown, docview, katex,
// librarian) is injected through createReader(opts). That keeps the core
// reusable across the Works book surface, the DD-60 skin, and a future
// standalone PWA — none of them share a transport or a chrome.
//
// The core owns the book model, the chapter render pipeline (a registry of
// format→backend renderers, reflowable shipped), the math pipeline, code-copy
// buttons, highlight/bookmark anchoring, the search index, and reading-state.
// The *chrome* (element layout, chapter/marks/search list rendering, overlays,
// control wiring) lives in each surface and drives the core through its API +
// the on.* hooks.
//
// DOM is assumed (browser / iframe surface / PWA) but no specific element IDs
// or message bus are — the chrome passes in the content element and the I/O
// callbacks.

// ── default KaTeX shims (books may extend via book.katexMacros) ──────
const KATEX_MACROS = {
  '\\mbox': '\\text', '\\eq': '=', '\\E': '\\mathrm{E}',
  '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}',
  '\\ddiv': '\\operatorname{div}',
};
// Normalise TeX KaTeX rejects: amsmath environments → aligned, @{…} array
// column separators stripped, output-less label/proof commands dropped.
function katexFix(tex) {
  return tex
    .replace(/\\begin\{(?:align\*?|eqnarray\*?)\}/g, '\\begin{aligned}')
    .replace(/\\end\{(?:align\*?|eqnarray\*?)\}/g, '\\end{aligned}')
    .replace(/@\{[^{}]*\}/g, '')
    .replace(/\\(?:label|eqlabel)\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:qedhere|nonumber|notag)\b/g, '');
}
const MATH_DELIMS = [
  { l: '$$', r: '$$', display: true },
  { l: '\\[', r: '\\]', display: true },
  { l: '\\(', r: '\\)', display: false },
];
const MATH_SKIP = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'A', 'MATH']);

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-9999px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

export function createReader(opts) {
  const {
    contentEl,
    readFile,
    loadState = async () => null,
    saveState = async () => {},
    libs = {},
    on = {},
    saveDebounce = 600,
    footer = true,           // chapter-end prev/next links inside the page
  } = opts;

  const {
    renderMd, slugify, decorateHeadings, highlightCode, rewireLinks,
    scrollToAnchor, splitByHeadings, Librarian, renderToString,
  } = libs;

  // ── state ─────────────────────────────────────────────────────────
  let book = null, bookDir = '', slug = 'book', chapters = [], curIndex = 0;
  let settings = { font: 'serif', size: 18, width: 680 };
  let bookmarks = [], highlights = [], markSeq = 1, bookIndex = null;
  let saveTimer = null;
  const emit = (name, ...a) => { if (typeof on[name] === 'function') on[name](...a); };

  // ── render pipeline: format → backend registry (extensible) ────────
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (const el of tpl.content.querySelectorAll('script, style, link, meta, iframe, object, embed')) el.remove();
    for (const el of tpl.content.querySelectorAll('*')) {
      for (const at of [...el.attributes]) {
        if (/^on/i.test(at.name) || (/^(href|src)$/i.test(at.name) && /^\s*javascript:/i.test(at.value))) el.removeAttribute(at.name);
      }
    }
    return tpl.innerHTML;
  }
  function renderMdWithMath(md) {
    const math = [];
    const stashed = md.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g,
      (m) => { math.push(m); return '@@MATH' + (math.length - 1) + '@@'; });
    return renderMd(stashed).replace(/@@MATH(\d+)@@/g, (_, i) => math[+i]);
  }
  function renderMath(root) {
    if (!root || !renderToString) return;
    const macros = { ...KATEX_MACROS, ...((book && book.katexMacros) || {}) };
    for (const el of root.querySelectorAll('span.math')) {
      const display = el.classList.contains('display');
      const clone = el.cloneNode(true);
      for (const c of clone.querySelectorAll('code'))
        c.replaceWith(document.createTextNode('\\texttt{' + c.textContent
          .replace(/\\/g, '\\textbackslash ')
          .replace(/([%$#&_{}])/g, '\\$1')
          .replace(/~/g, '\\textasciitilde ')
          .replace(/\^/g, '\\textasciicircum ') + '}'));
      const tex = clone.textContent.trim().replace(/^\\[([]/, '').replace(/\\[)\]]$/, '').trim();
      if (!tex) continue;
      try { el.innerHTML = renderToString(katexFix(tex), { output: 'mathml', displayMode: display, macros }); }
      catch { /* leave the span's raw text in place */ }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!/\$\$|\\\(|\\\[/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        for (let p = n.parentNode; p && p !== root; p = p.parentNode) if (MATH_SKIP.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    for (let n; (n = walker.nextNode());) targets.push(n);
    for (const node of targets) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let i = 0, any = false;
      while (i < text.length) {
        let best = null;
        for (const d of MATH_DELIMS) {
          const s = text.indexOf(d.l, i);
          if (s < 0) continue;
          const e = text.indexOf(d.r, s + d.l.length);
          if (e < 0) continue;
          if (!best || s < best.s) best = { s, e, d };
        }
        if (!best) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
        if (best.s > i) frag.appendChild(document.createTextNode(text.slice(i, best.s)));
        const tex = text.slice(best.s + best.d.l.length, best.e);
        const span = document.createElement('span');
        try { span.innerHTML = renderToString(katexFix(tex), { output: 'mathml', displayMode: best.d.display, macros }); any = true; }
        catch { span.textContent = best.d.l + tex + best.d.r; }
        frag.appendChild(span);
        i = best.e + best.d.r.length;
      }
      if (any) node.parentNode.replaceChild(frag, node);
    }
  }
  function decorateCodeBlocks(root) {
    for (const pre of root.querySelectorAll('pre')) {
      const code = pre.querySelector('code') || pre;
      if (pre.querySelector(':scope > .code-copy')) continue;
      const btn = document.createElement('button');
      btn.className = 'code-copy'; btn.type = 'button';
      btn.title = 'Copy code'; btn.setAttribute('aria-label', 'Copy code');
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const ok = await copyToClipboard(code.textContent);
        btn.classList.remove('copied', 'failed');
        btn.classList.add(ok ? 'copied' : 'failed');
        clearTimeout(btn._t);
        btn._t = setTimeout(() => btn.classList.remove('copied', 'failed'), 1100);
      });
      pre.appendChild(btn);
    }
  }

  const backends = {
    reflowable: {
      render(chapter, raw, pageEl) {
        pageEl.innerHTML = chapter.format === 'html' ? sanitizeHtml(raw) : renderMdWithMath(raw);
        decorateHeadings(pageEl, (id) => {
          try { navigator.clipboard?.writeText(slug + '/' + chapter.id + '#' + id); } catch {}
        });
        highlightCode(pageEl);
        renderMath(pageEl);
        decorateCodeBlocks(pageEl);
      },
    },
  };
  function backendFor(format) {
    if (format === 'pdf' || format === 'djvu') return backends[format] || null;
    return backends[format] || backends.reflowable;
  }

  function resolveInBook(relPath) {
    const base = relPath.startsWith('/') ? relPath : bookDir + '/' + relPath;
    const out = [];
    for (const seg of base.split('/')) {
      if (seg === '..') out.pop();
      else if (seg && seg !== '.') out.push(seg);
    }
    return '/' + out.join('/');
  }

  // ── persistence ───────────────────────────────────────────────────
  function scheduleSave() {
    if (!chapters.length) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const state = {
        chapterId: chapters[curIndex] && chapters[curIndex].id,
        scrollTop: contentEl ? contentEl.scrollTop || 0 : 0,
        settings, bookmarks, highlights,
      };
      try { saveState(state); } catch { /* ignore */ }
      emit('stateChange', state);
    }, saveDebounce);
  }

  // ── highlight / bookmark anchoring ─────────────────────────────────
  const currentPage = () => contentEl && contentEl.querySelector('.page');
  const chapIndexOf = (id) => chapters.findIndex((c) => c.id === id);

  function charOffset(root, node, offset) {
    const r = document.createRange();
    r.setStart(root, 0); r.setEnd(node, offset);
    return r.toString().length;
  }
  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const root = currentPage();
    if (!root) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const a = charOffset(root, range.startContainer, range.startOffset);
    const b = charOffset(root, range.endContainer, range.endOffset);
    const start = Math.min(a, b), end = Math.max(a, b);
    const quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 240);
    if (end <= start || !quote) return null;
    return { start, end, quote, rect: range.getBoundingClientRect() };
  }
  function wrapRange(root, start, end, hl) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let pos = 0, n;
    const segs = [];
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length, nodeStart = pos;
      pos += len;
      if (pos <= start || nodeStart >= end) continue;
      segs.push({ node: n, from: Math.max(0, start - nodeStart), to: Math.min(len, end - nodeStart) });
    }
    const cls = 'hl c-' + (hl.color || 'yellow') + (hl.note && hl.note.trim() ? ' has-note' : '');
    for (const { node, from, to } of segs) {
      const range = document.createRange();
      range.setStart(node, from); range.setEnd(node, to);
      const mark = document.createElement('mark');
      mark.className = cls; mark.dataset.id = hl.id;
      try { range.surroundContents(mark); } catch { /* unwrappable segment */ }
    }
  }
  function wireMarkClicks(root) {
    for (const mk of root.querySelectorAll('mark.hl')) {
      mk.addEventListener('click', (e) => { e.stopPropagation(); emit('markClick', mk.dataset.id, mk); });
    }
  }
  function applyHighlights(chapterId) {
    const root = currentPage();
    if (!root) return;
    for (const h of highlights.filter((x) => x.chapterId === chapterId).sort((a, b) => a.start - b.start))
      wrapRange(root, h.start, h.end, h);
    wireMarkClicks(root);
  }

  // ── public API ─────────────────────────────────────────────────────
  const api = {
    get book() { return book; },
    get chapters() { return chapters; },
    get index() { return curIndex; },
    get slug() { return slug; },
    get bookDir() { return bookDir; },
    get settings() { return settings; },
    get marks() { return { bookmarks, highlights }; },
    get toc() { return _toc; },
    currentPage,
    chapIndexOf,
    resolveInBook,
    selectionInfo,

    registerBackend(format, backend) { backends[format] = backend; return api; },

    async open(pathOrDir) {
      const manifestPath = pathOrDir.endsWith('.json') ? pathOrDir : (pathOrDir.replace(/\/$/, '') + '/book.json');
      bookDir = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
      book = JSON.parse(await readFile(manifestPath));
      chapters = Array.isArray(book.chapters) ? book.chapters : [];
      chapters.forEach((c, i) => { if (!c.id) c.id = 'ch' + (i + 1); });
      slug = book.slug || bookDir.split('/').pop() || 'book';
      bookIndex = null;
      const saved = await loadState();
      if (saved && saved.settings) settings = { ...settings, ...saved.settings };
      if (saved && Array.isArray(saved.bookmarks)) bookmarks = saved.bookmarks;
      if (saved && Array.isArray(saved.highlights)) highlights = saved.highlights;
      for (const m of [...bookmarks, ...highlights]) {
        const num = parseInt(String(m.id).slice(1), 10);
        if (num >= markSeq) markSeq = num + 1;
      }
      emit('ready', book, chapters);
      emit('marksChange', { bookmarks, highlights });
      // resume at saved chapter
      const startIdx = saved && saved.chapterId ? Math.max(0, chapIndexOf(saved.chapterId)) : 0;
      await api.loadChapter(startIdx);
      if (saved && typeof saved.scrollTop === 'number' && contentEl) contentEl.scrollTop = saved.scrollTop;
      return { book, chapters };
    },

    async loadChapter(index, anchor) {
      if (index < 0 || index >= chapters.length) return;
      curIndex = index;
      const chapter = chapters[index];
      const backend = backendFor(chapter.format || 'md');
      if (!contentEl) return;
      if (!backend) {
        contentEl.innerHTML = '<div class="err">This chapter is ' + (chapter.format || '?')
          + ' — a fixed-layout reader backend isn\'t available yet.</div>';
        emit('chapterChange', { index, chapter, page: null });
        return;
      }
      let raw;
      try { raw = await readFile(resolveInBook(chapter.file)); }
      catch (e) {
        contentEl.innerHTML = '<div class="err">failed to load ' + chapter.file + ': ' + (e.message || e) + '</div>';
        return;
      }
      contentEl.innerHTML = '';
      const page = document.createElement('div');
      page.className = 'page';
      contentEl.appendChild(page);
      backend.render(chapter, raw, page, {
        renderMath, decorateCodeBlocks, sanitizeHtml, renderMdWithMath, resolveInBook, slug, libs,
      });
      if (rewireLinks) rewireLinks(page, chapter.file, (resolved, anch) => {
        const want = resolveInBook(chapter.file.includes('/') ? chapter.file.slice(0, chapter.file.lastIndexOf('/') + 1) + resolved.split('/').slice(-1)[0] : resolved);
        const idx = chapters.findIndex((c) => resolveInBook(c.file) === resolveInBook(resolved) || resolveInBook(c.file) === want);
        if (idx >= 0) api.loadChapter(idx, anch);
      });
      if (footer) {
        const foot = document.createElement('div');
        foot.className = 'chap-foot';
        const prev = document.createElement('a');
        if (index > 0) { prev.textContent = '‹ ' + (chapters[index - 1].title || 'Previous'); prev.addEventListener('click', () => api.loadChapter(index - 1)); }
        const next = document.createElement('a');
        if (index < chapters.length - 1) { next.textContent = (chapters[index + 1].title || 'Next') + ' ›'; next.addEventListener('click', () => api.loadChapter(index + 1)); }
        foot.append(prev, Object.assign(document.createElement('span'), { className: 'sp' }), next);
        page.appendChild(foot);
      }
      applyHighlights(chapter.id);
      emit('chapterChange', { index, chapter, page });
      if (anchor && scrollToAnchor && scrollToAnchor(anchor)) { /* anchor wins */ }
      else { contentEl.scrollTop = 0; }
      scheduleSave();
    },

    persist() { scheduleSave(); },
    next() { return api.loadChapter(curIndex + 1); },
    prev() { return api.loadChapter(curIndex - 1); },
    scrollBy(dy) { if (contentEl) contentEl.scrollTop += dy; scheduleSave(); },
    pageDown() { if (contentEl) contentEl.scrollTop += contentEl.clientHeight * 0.9; scheduleSave(); },
    pageUp() { if (contentEl) contentEl.scrollTop -= contentEl.clientHeight * 0.9; scheduleSave(); },

    setSettings(partial) {
      settings = { ...settings, ...partial };
      emit('settingsChange', settings);
      scheduleSave();
      return settings;
    },

    // ── marks ─────────────────────────────────────────────────────
    addHighlightFromSelection(color) {
      const sel = selectionInfo();
      if (!sel) return null;
      const h = { id: 'h' + (markSeq++), chapterId: chapters[curIndex].id, start: sel.start, end: sel.end, quote: sel.quote, color: color || 'yellow', note: '' };
      highlights.push(h);
      window.getSelection().removeAllRanges();
      wrapRange(currentPage(), h.start, h.end, h);
      const root = currentPage();
      if (root) wireMarkClicks(root);
      emit('marksChange', { bookmarks, highlights });
      scheduleSave();
      return h;
    },
    addBookmark() {
      if (!chapters.length) return null;
      const c = chapters[curIndex];
      let label = c.title || ('Chapter ' + (curIndex + 1));
      const root = currentPage();
      if (root && contentEl) {
        const top = contentEl.getBoundingClientRect().top + 60;
        let h = null;
        for (const hd of root.querySelectorAll('h1, h2, h3')) {
          if (hd.getBoundingClientRect().top <= top) h = hd; else break;
        }
        if (h) label = (c.title ? c.title + ' · ' : '') + (h.textContent || '').replace(/^§\s*/, '').trim();
      }
      const bm = { id: 'b' + (markSeq++), chapterId: c.id, scrollTop: contentEl ? contentEl.scrollTop || 0 : 0, label };
      bookmarks.push(bm);
      emit('marksChange', { bookmarks, highlights });
      scheduleSave();
      return bm;
    },
    getMark(id) { return highlights.find((x) => x.id === id) || bookmarks.find((b) => b.id === id) || null; },
    setNote(id, text) {
      const h = highlights.find((x) => x.id === id); if (!h) return;
      h.note = text;
      const on2 = !!(text && text.trim());
      const root = currentPage();
      if (root) for (const mk of root.querySelectorAll('mark.hl[data-id="' + id + '"]')) mk.classList.toggle('has-note', on2);
      emit('marksChange', { bookmarks, highlights });
      scheduleSave();
    },
    setColor(id, color) {
      const h = highlights.find((x) => x.id === id); if (!h) return;
      h.color = color;
      const cls = 'hl c-' + color + (h.note && h.note.trim() ? ' has-note' : '');
      const root = currentPage();
      if (root) for (const mk of root.querySelectorAll('mark.hl[data-id="' + id + '"]')) mk.className = cls;
      emit('marksChange', { bookmarks, highlights });
      scheduleSave();
    },
    removeMark(kind, id) {
      if (kind === 'bm') bookmarks = bookmarks.filter((b) => b.id !== id);
      else {
        highlights = highlights.filter((h) => h.id !== id);
        const p = currentPage();
        if (p) { for (const mk of [...p.querySelectorAll('mark.hl[data-id="' + id + '"]')]) mk.replaceWith(...mk.childNodes); p.normalize(); }
      }
      emit('marksChange', { bookmarks, highlights });
      scheduleSave();
    },
    async jumpToMark(m) {
      const idx = chapIndexOf(m.chapterId);
      if (idx < 0) return;
      if (idx !== curIndex) await api.loadChapter(idx);
      if (m.kind === 'bm' && typeof m.scrollTop === 'number' && contentEl) contentEl.scrollTop = m.scrollTop;
      else if (m.kind === 'hl') {
        const mk = currentPage() && currentPage().querySelector('mark.hl[data-id="' + m.id + '"]');
        if (mk) mk.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },

    // ── search ─────────────────────────────────────────────────────
    async buildIndex() {
      if (bookIndex) return bookIndex;
      const docs = [];
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        let raw = '';
        try { raw = await readFile(resolveInBook(ch.file)); } catch { continue; }
        const secs = (ch.format || 'md') === 'html'
          ? htmlSections(raw, ch.title)
          : splitByHeadings(raw, ch.id, ch.title, slugify);
        for (const s of secs) docs.push({
          id: ch.id + '#' + (s.anchor || ''),
          chapterIndex: i, anchor: s.anchor || '',
          fileTitle: ch.title, heading: s.heading || ch.title,
          title: s.heading || ch.title, body: s.body || '',
        });
      }
      bookIndex = Librarian.index({ docs, fields: { heading: { boost: 4 }, fileTitle: { boost: 2 }, body: { boost: 1 } }, synonyms: {} });
      return bookIndex;
    },
    search(q, searchOpts) {
      if (!bookIndex || !q.trim()) return [];
      return Librarian.search(bookIndex, q, { fuzzy: 1, limit: 20, ...(searchOpts || {}) });
    },

    destroy() { clearTimeout(saveTimer); },
  };

  let _toc = { items: [], update() {} };

  function htmlSections(html, chapterTitle) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    let cur = { heading: chapterTitle, anchor: '', body: '' };
    for (const el of doc.body.querySelectorAll('h1, h2, h3, p, li, pre, blockquote, td')) {
      if (/^H[123]$/.test(el.tagName)) {
        if (cur.body.trim() || cur.heading) out.push(cur);
        cur = { heading: (el.textContent || '').replace(/^§\s*/, '').trim(), anchor: el.id || '', body: '' };
      } else { cur.body += ' ' + (el.textContent || ''); }
    }
    if (cur.body.trim() || cur.heading) out.push(cur);
    return out;
  }

  return api;
}
