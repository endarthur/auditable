// @gcu/markdown — engine tests: dialect features, the corpus-frozen emphasis
// rule, the §5 security model (adversarial), rule/policy overrides, presets,
// lint, and the never-throw guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, render, renderAst, lint, presets, escapeHtml, slugify } from '../ext/markdown/src/api.js';
import { slugify as renderMdSlugify } from '../src/js/markdown.js';

const nb = (s, extra) => render(s, { ...presets.notebook, ...(extra || {}) });
const docs = (s) => render(s, presets.docs);
const wild = (s) => render(s, presets.wild);

// ── blocks ────────────────────────────────────────────────────────────

test('headings: levels, trailing #s, explicit {#id}, empty', () => {
  assert.equal(nb('# A'), '<h1 id="a">A</h1>\n');
  assert.equal(nb('###### deep ##'), '<h6>deep</h6>\n');   // autoIds:3 → h4-h6 anchor-less
  assert.equal(render('###### deep', { ...presets.notebook, autoIds: true }), '<h6 id="deep">deep</h6>\n');
  assert.match(nb('###### deep {#kept}'), /<h6 id="kept">/);   // explicit id wins at any level
  assert.match(nb('## T {#custom}'), /<h2 id="custom">T<\/h2>/);
  assert.match(nb('##'), /<h2><\/h2>/);
  assert.match(nb('####### seven'), /<p>/);          // 7 hashes = paragraph
});

test('heading auto-slugs dedupe and match renderMd slugify', () => {
  const html = nb('# Dup\n\n# Dup');
  assert.match(html, /id="dup".*id="dup-2"/s);
  for (const t of ['Hello World', 'Kriging & Co.', 'café crème', 'a `code` b']) {
    assert.equal(slugify(t), renderMdSlugify(t));
  }
});

test('setext underlines do NOT form headings (parse-level removal)', () => {
  const html = nb('Title\n=====');
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /Title/);
  // `---` after a paragraph = paragraph + hr (graceful), not an h2
  const html2 = nb('Text\n\n---');
  assert.match(html2, /<p>Text<\/p>\n<hr>/);
});

test('indented lines do not form code blocks', () => {
  assert.doesNotMatch(nb('para\n\n    not code'), /<pre>/);
});

test('fences: lang class, escape, tilde, unclosed runs to end', () => {
  assert.equal(nb('```js\n1 < 2\n```'), '<pre><code class="language-js">1 &lt; 2\n</code></pre>\n');
  assert.match(nb('~~~\nx\n~~~'), /<pre><code>x\n<\/code><\/pre>/);
  assert.match(nb('```\nunclosed'), /<pre><code>unclosed\n<\/code><\/pre>/);
  assert.match(nb('````\n```\ninner\n```\n````'), /```\ninner\n```/);
});

test('blockquotes: nest, end at unprefixed line (no laziness)', () => {
  assert.match(nb('> a\n> > b'), /<blockquote>\n<p>a<\/p>\n<blockquote>\n<p>b<\/p>\n<\/blockquote>\n<\/blockquote>/);
  // no lazy continuation: the unprefixed line is a SEPARATE paragraph
  const html = nb('> quoted\nplain');
  assert.match(html, /<blockquote>\n<p>quoted<\/p>\n<\/blockquote>\n<p>plain<\/p>/);
});

test('lists: nesting, ordered start, marker-char change splits, tight/loose', () => {
  assert.match(nb('- a\n  - b'), /<ul>\n<li>a\n<ul>\n<li>b<\/li>\n<\/ul>\n<\/li>\n<\/ul>/);
  assert.match(nb('3. x\n4. y'), /<ol start="3">/);
  assert.match(nb('1) paren'), /<ol>/);
  const split = nb('- a\n* b');
  assert.equal((split.match(/<ul>/g) || []).length, 2);  // different bullet char = new list
  assert.doesNotMatch(nb('- t1\n- t2'), /<p>/);          // tight
  assert.match(nb('- l1\n\n- l2'), /<li>\n<p>l1<\/p>\n<\/li>/);  // loose
});

test('task lists', () => {
  const html = nb('- [ ] todo\n- [x] done');
  assert.match(html, /<li class="task"><input type="checkbox" disabled> todo/);
  assert.match(html, /<input type="checkbox" disabled checked> done/);
});

test('hr wins over list for `- - -`', () => {
  assert.equal(nb('- - -'), '<hr>\n');
  assert.equal(nb('***'), '<hr>\n');
});

test('tables: alignment, escaped pipe, ragged rows padded/truncated', () => {
  const html = nb('| a | b |\n|:-:|--:|\n| 1 \\| x | 2 | extra |\n| only |');
  assert.match(html, /<th style="text-align:center">a<\/th>/);
  assert.match(html, /<td style="text-align:center">1 \| x<\/td>/);
  assert.doesNotMatch(html, /extra/);
  assert.match(html, /<td style="text-align:right"><\/td>/);   // padded short row
});

test('admonitions: renderMd-compatible markup, default title, nested md', () => {
  const html = nb('!!! warning\n    body with **bold**');
  assert.match(html, /<div class="admonition adm-warning"><div class="admonition-title">Warning<\/div>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(nb('!!! note "Custom"\n    x'), /admonition-title">Custom</);
});

test('footnotes: numbered in first-use order, backrefs, unknown ref literal', () => {
  const html = docs('b[^beta] a[^alpha]\n\n[^alpha]: A\n[^beta]: B');
  assert.match(html, /fnref-1.*fnref-2/s);
  assert.match(html, /<li id="fn-1"><p>B<\/p>/);          // beta used first → 1
  assert.match(docs('no def[^ghost]'), /\[\^ghost\]/);
  assert.doesNotMatch(docs('unused\n\n[^u]: never'), /footnotes/);
});

test('reference links: forward+backward defs, case-insensitive, titles, <dest>', () => {
  assert.match(nb('[x][R]\n\n[r]: /a "T"'), /<a href="\/a" title="T">x<\/a>/);
  assert.match(nb('[pre]: /b\n\nuse [pre]'), /<a href="\/b">pre<\/a>/);
  assert.match(nb('[c][]\n\n[c]: <//spaced dest>'), /href="\/\/spaced dest"/);
});

// ── the frozen emphasis rule ──────────────────────────────────────────

test('emphasis: corpus cases', () => {
  assert.match(nb('*i* **b** ***bi***'), /<em>i<\/em> <strong>b<\/strong> <em><strong>bi<\/strong><\/em>/);
  assert.match(nb('_i_ __b__'), /<em>i<\/em> <strong>b<\/strong>/);
  assert.equal(nb('snake_case_name and x_i'), '<p>snake_case_name and x_i</p>\n');
  // punctuation guard: digit*punct never opens
  assert.equal(nb('2*$nx$ + 1, 2*$ny$ + 1', { extensions: {} }), '<p>2*$nx$ + 1, 2*$ny$ + 1</p>\n');
  // surrogate-pair neighbors (math italic letters) — intraword _ suppressed
  assert.doesNotMatch(nb('E{𝑃_𝑠} and \\sum_{l=1}'), /<em>/);
  // unterminated → literal
  assert.equal(nb('a *b and __c'), '<p>a *b and __c</p>\n');
  // space-flanked never triggers
  assert.equal(nb('a * b * c'), '<p>a * b * c</p>\n');
  assert.match(nb('**a _b_ c**'), /<strong>a <em>b<\/em> c<\/strong>/);
});

test('emphasis never crosses a link boundary', () => {
  const html = nb('*a [b* c](/x)');
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /<a href="\/x">b\* c<\/a>/);
});

// ── inlines ───────────────────────────────────────────────────────────

test('code spans: padding strip, backtick runs, newline → space', () => {
  assert.equal(nb('`` `tick` ``'), '<p><code>`tick`</code></p>\n');
  assert.equal(nb('`a\nb`'), '<p><code>a b</code></p>\n');
  assert.equal(nb('` x `'), '<p><code>x</code></p>\n');
  assert.equal(nb('`unclosed'), '<p>`unclosed</p>\n');
});

test('links: titles, nested parens, <dest>, no links in links, image alt flattens', () => {
  assert.match(nb("[t](/u 'T')"), /<a href="\/u" title="T">t<\/a>/);
  assert.match(nb('[w](/wiki/A_(B))'), /href="\/wiki\/A_\(B\)"/);
  assert.match(nb('[s](</u r l>)'), /href="\/u r l"/);
  const noNest = nb('[a [b](/inner)](/outer)');
  assert.doesNotMatch(noNest, /href="\/outer"/);
  assert.match(nb('![**alt** text](/i.png)'), /<img src="\/i.png" alt="alt text">/);
});

test('autolinks + bare URLs (wild): GFM trailing trim', () => {
  assert.match(nb('<https://x.com/a?b=1>'), /<a href="https:\/\/x.com\/a\?b=1">/);
  assert.match(nb('<user@example.com>'), /<a href="mailto:user@example.com">user@example.com<\/a>/);
  assert.match(wild('see https://x.com/p(q) end'), /href="https:\/\/x.com\/p\(q\)"/);
  assert.match(wild('see https://x.com.'), /href="https:\/\/x.com"/);
  assert.doesNotMatch(nb('bare https://x.com here'), /<a /);   // off outside wild
});

test('math: inline, display, escapes, renderer hook, off in wild', () => {
  assert.match(nb('$x^2$'), /<span class="math math-inline">\$x\^2\$<\/span>/);
  assert.match(nb('$$\\sum_i$$'), /math-display/);
  assert.equal(nb('price \\$5 and \\$7'), '<p>price $5 and $7</p>\n');
  assert.equal(wild('a $5 price, $7 total'), '<p>a $5 price, $7 total</p>\n');
  const hooked = render('$x$', { ...presets.notebook, mathRenderer: (l, m) => `<m d="${m}">${l}</m>` });
  assert.match(hooked, /<m d="inline">x<\/m>/);
  const throwing = render('$x$', { ...presets.notebook, mathRenderer: () => { throw new Error('boom'); } });
  assert.match(throwing, /math-inline/);                       // hook failure → passthrough
});

test('kbd, sub/sup (no spaces), mark, strike odd runs', () => {
  assert.match(nb('++ctrl+s++'), /<kbd>ctrl<\/kbd>\+<kbd>s<\/kbd>/);   // pill per key (renderMd compat)
  assert.match(docs('H~2~O x^2^'), /H<sub>2<\/sub>O x<sup>2<\/sup>/);
  assert.equal(docs('a ~not sub~ b').includes('<sub>'), false); // space inside → literal
  assert.match(docs('==hi=='), /<mark>hi<\/mark>/);
  assert.match(nb('~~gone~~'), /<del>gone<\/del>/);
  assert.match(nb('a ~~~x~~~ b'), /<del>/);   // odd inline run: leftover literal
  assert.match(nb('~~~\nx\n~~~'), /<pre>/);   // at line start, ~~~ is a FENCE
});

test('breaks: backslash, two-space (read-liberal), soft', () => {
  assert.match(nb('a\\\nb'), /a<br>/);
  assert.match(nb('a  \nb'), /a<br>/);
  assert.match(nb('a\nb'), /a\nb/);
});

test('escapes: all ASCII punctuation', () => {
  assert.equal(nb('\\*not em\\* and \\, comma'), '<p>*not em* and , comma</p>\n');
  assert.equal(nb('\\# not heading'), '<p># not heading</p>\n');
});

test('entities: numeric + named decode to text (and re-escape safely)', () => {
  assert.equal(nb('a&nbsp;b &mdash; c'), '<p>a b — c</p>\n');   // nbsp = U+00A0, not a plain space
  assert.equal(nb('&#65;&#x42;'), '<p>AB</p>\n');
  assert.equal(nb('&lt;script&gt;'), '<p>&lt;script&gt;</p>\n');   // decoded < > re-escape
  assert.equal(nb('&unknownent; & plain'), '<p>&amp;unknownent; &amp; plain</p>\n');
  assert.equal(nb('&#0; &#x110000;'), '<p>� �</p>\n');   // invalid → replacement
});

// ── security (§5) ─────────────────────────────────────────────────────

test('html:false — raw HTML inert, both levels', () => {
  assert.equal(nb('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
  assert.match(nb('inline <b onmouseover=x>bold</b> here'), /&lt;b onmouseover=x&gt;/);
});

test('html:true — verbatim pass-through, zero filtering', () => {
  const t = (s) => render(s, { ...presets.notebook, html: true });
  assert.match(t('<div class="x">\nraw\n</div>'), /<div class="x">/);
  assert.match(t('inline <br> tag'), /inline <br> tag/);
});

test('link policy: dangerous schemes drop to text, obfuscation caught', () => {
  for (const url of ['javascript:alert(1)', 'vbscript:x', 'data:text/html,x', 'java\tscript:alert(1)', 'JAVASCRIPT:x', ' javascript:x']) {
    const html = nb(`[click](${url})`);
    assert.doesNotMatch(html, /<a /, url);
    assert.match(html, /click/);
  }
  assert.match(nb('[ok](#anchor)'), /<a href="#anchor">/);
  assert.match(nb('[ok](relative/path)'), /<a href="relative\/path">/);
  assert.match(nb('[ok](tel:+5511999999999)'), /<a href="tel:/);
});

test('image policy: raster data only, no svg, disallowed → alt text', () => {
  assert.match(nb('![a](data:image/png;base64,AA)'), /<img/);
  assert.match(nb('![a](data:image/webp;base64,AA)'), /<img/);
  for (const src of ['data:image/svg+xml,<svg/>', 'data:text/html,x', 'javascript:x']) {
    const html = nb(`![the alt](${src})`);
    assert.doesNotMatch(html, /<img/, src);
    assert.match(html, /the alt/);
  }
});

test('the original renderMd XSS: quote-in-url cannot break the attribute', () => {
  const html = nb('[x](https://e.com" onclick="alert(1))');
  assert.doesNotMatch(html, /onclick="alert/);
  assert.match(html, /&quot;/);
});

test('attribute escaping in titles and alts', () => {
  assert.match(nb('[x](/u "a\\"b<c>")'), /title="a&quot;b&lt;c&gt;"/);
  assert.match(nb('![a"<b>](/i.png)'), /alt="a&quot;&lt;b&gt;"/);
});

// ── overrides ─────────────────────────────────────────────────────────

test('renderer-rule overrides own the output', () => {
  const html = render('[x](/u)\n\n# H', {
    ...presets.notebook,
    rules: {
      link: (n, ctx) => `<a class="custom" href="${escapeHtml(n.href)}">${ctx.render(n.children)}</a>`,
      heading: (n, ctx) => `<div class="h${n.level}">${ctx.render(n.children)}</div>\n`,
    },
  });
  assert.match(html, /class="custom"/);
  assert.match(html, /<div class="h1">H<\/div>/);
});

test('policy overrides', () => {
  const html = render('[b](blob:xyz)', { ...presets.notebook, linkPolicy: (h) => h.startsWith('blob:') });
  assert.match(html, /<a href="blob:xyz">/);
});

// ── presets / comments ────────────────────────────────────────────────

test('gcu preset strips // comments; escapes and code protected', () => {
  const g = (s) => render(s, presets.gcu);
  assert.equal(g('text // gone'), '<p>text</p>\n');
  assert.match(g('a \\// kept'), /a \/\/ kept/);
  assert.match(g('`code // kept`'), /code \/\/ kept/);
  assert.match(g('```\n// kept\n```'), /\/\/ kept/);
  assert.match(g('see https://x.com/path'), /https:\/\/x.com\/path/);   // :// untouched
});

// ── lint (§3.4) ───────────────────────────────────────────────────────

test('lint: variant findings, source-mapped, render never rejects', () => {
  const src = '# H1\n\n### jump\n\n* star\n\n1) paren\n\nbold __x__ and *i*\nbreak  \nTitle\n-----\n\n    indented\n\n[u]: /never';
  const rules = lint(src).map((w) => w.rule);
  for (const r of ['heading-jump', 'bullet-marker', 'ordered-marker', 'bold-marker', 'italic-marker', 'two-space-break', 'setext-underline', 'indented-block', 'unused-refdef']) {
    assert.ok(rules.includes(r), r);
  }
  for (const w of lint(src)) assert.ok(w.start >= 0 && w.end >= w.start);
  assert.doesNotThrow(() => render(src, presets.notebook));
});

// ── robustness ────────────────────────────────────────────────────────

test('never throws on hostile/malformed content', () => {
  const nasty = [
    '', '\n\n\n', '*', '**', '_', '[', '![', '[]()', '[](', '```', '|', '|-|',
    '> > > >', '- - - -', '$$', '$', '++', '~~~~~~', '\\\\', '\\',
    '[a][b][c][d]', '![[![', '<', '<>', '<a', ']]]]', '#'.repeat(100),
    '*'.repeat(500), '`'.repeat(99), '[x](' + '('.repeat(200) + ')',
    'a b', '\ud800 lone surrogate', '𝑃_𝑠'.repeat(50),
  ];
  const big = nasty.join('\n') + '\n# h *e* [l](/) `m`\n';
  let seed = 42;
  const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 500; i++) {
    const a = Math.floor(rng() * big.length), b = a + Math.floor(rng() * (big.length - a));
    const mutated = big.slice(a, b) + big.slice(0, Math.floor(rng() * a));
    for (const preset of [presets.notebook, presets.wild, presets.gcu]) {
      assert.doesNotThrow(() => render(mutated, preset));
    }
  }
});

test('maxBytes throws (caller-visible cap, not truncation)', () => {
  assert.throws(() => parse('x'.repeat(100), { maxBytes: 10 }));
});

test('AST carries source offsets', () => {
  const { ast } = parse('# Head\n\npara *em* here', presets.notebook);
  const h = ast.children[0], p = ast.children[1];
  assert.equal(h.start, 0);
  assert.ok(h.end >= 6);
  assert.ok(p.start > h.end - 1);
  const em = p.children.find((n) => n.type === 'em');
  assert.ok(em && em.start >= 0 && em.end > em.start);
});

test('bundled output exposes the same API', async () => {
  const m = await import('../ext/markdown/index.js');
  assert.equal(typeof m.render, 'function');
  assert.match(m.render('**b**', m.presets.notebook), /<strong>b<\/strong>/);
});
