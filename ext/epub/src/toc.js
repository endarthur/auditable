// Heading extraction → nested TOC structure.
//
// Walk each chapter's HTML body for <h1>..<h6> elements, build a flat
// list of { level, id, text, chapterId, chapterTitle }, then nest them
// into a tree following the level hierarchy. The tree is consumed by
// the nav.xhtml + toc.ncx emitters in manifest.js.

const HEADING_RE = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
const ID_ATTR_RE = /\bid\s*=\s*"([^"]*)"/i;

// Strip inline HTML tags from heading text to get a plain-text label
// for the TOC. The actual chapter body keeps full markup; the TOC
// just needs words.
function _stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Slugify a heading's text into an id usable as a fragment. Lowercase,
// non-word → '-', collapse runs of '-', trim. Empty inputs become 'h'.
function _slugify(s) {
  const base = s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-{2,}/g, '-');
  return base || 'h';
}

// Walk a single chapter's body, return [{ level, id, text, href }].
// `href` is the path-with-fragment that the TOC will link to —
// 'chapter1.xhtml#section-x'. Headings without explicit ids get one
// synthesized (and we'd rewrite the chapter body to inject them in a
// later pass; for v1 the TOC just points at the chapter file without
// the fragment if id is synthesized).
//
// Returns the headings AND a body with synthesized ids inlined so
// the same chapter render is reachable by fragment from the nav.
export function extractHeadings(body, chapterHref) {
  const headings = [];
  const seenIds = new Set();

  // Two-pass: collect, synthesize ids for any missing, rewrite.
  const rewritten = body.replace(HEADING_RE, (full, lvlStr, attrsRaw, inner) => {
    const level = Number(lvlStr);
    const attrs = attrsRaw || '';
    const text = _stripTags(inner);
    const idMatch = ID_ATTR_RE.exec(attrs);
    let id = idMatch ? idMatch[1] : null;
    if (!id) {
      // Synthesize an id; ensure uniqueness within the chapter.
      let candidate = _slugify(text);
      let i = 1;
      while (seenIds.has(candidate)) {
        i++;
        candidate = _slugify(text) + '-' + i;
      }
      id = candidate;
    }
    seenIds.add(id);
    headings.push({
      level, id, text,
      href: chapterHref + '#' + id,
    });
    // Re-emit the heading with the (possibly synthesized) id.
    const newAttrs = idMatch
      ? attrs   // already had id, keep verbatim
      : attrs + ` id="${id}"`;
    return `<h${level}${newAttrs}>${inner}</h${level}>`;
  });

  return { headings, body: rewritten };
}

// Take a list of heading entries (flat, in document order across
// chapters) plus chapter metadata, and nest them by level. Each
// chapter starts a new top-level entry — even if its first heading
// isn't an h1, the chapter is a TOC root. Sub-headings within a
// chapter nest under their nearest-shallower parent.
export function buildTocTree(chapters) {
  // Each chapter contributes one root entry (the chapter title +
  // chapter-level href, no fragment), then a nested list of its
  // headings under children.
  const roots = [];
  for (const ch of chapters) {
    const root = {
      title: ch.title || ch.id,
      href: ch.href,
      children: [],
    };
    // Stack of { level, node } for current parents
    const stack = [{ level: 0, node: root }];
    for (const h of ch.headings || []) {
      // Skip a chapter's first heading if its text matches the
      // chapter title — already in the root.
      if (h.level === 1 && root.children.length === 0
          && h.text.trim() === root.title.trim()) {
        // Promote the heading's anchor onto the root and skip
        root.href = h.href;
        continue;
      }
      while (stack[stack.length - 1].level >= h.level) stack.pop();
      const parent = stack[stack.length - 1].node;
      const node = { title: h.text, href: h.href, children: [] };
      parent.children.push(node);
      stack.push({ level: h.level, node });
    }
    roots.push(root);
  }
  return roots;
}
