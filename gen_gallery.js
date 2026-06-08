// Generates examples/index.html — a browsable gallery of every example notebook,
// grouped by category, each card linking to the standalone HTML. Titles come from each
// def's `/// title:` line. Run after gen_examples.js (CI does both). The gallery is a
// generated artifact (de-committed like the examples themselves) — deployed to the
// Pages site at /examples/.
const fs = require('fs');
const path = require('path');

const defsDir = path.join(__dirname, 'examples', 'defs');
const outFile = path.join(__dirname, 'examples', 'index.html');

const CATEGORY_ORDER = ['basics', 'adder', 'atra', 'gslib', 'gis', 'geology', 'calque', 'extensions', 'etc'];
const CATEGORY_LABEL = {
  basics: 'Basics', adder: 'Adder · Python', atra: 'Atra · Wasm', gslib: 'Geostatistics',
  gis: 'GIS', geology: 'Geology', calque: 'Calque', extensions: 'Language extensions', etc: 'Etc',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const titleOf = (txt, fallback) => {
  const m = txt.match(/^\/\/\/\s*title:\s*(.+)$/m);
  return m ? m[1].trim() : fallback;
};

const cats = {};
for (const cat of fs.readdirSync(defsDir)) {
  const catDir = path.join(defsDir, cat);
  if (!fs.statSync(catDir).isDirectory() || cat === 'data-corpora') continue;
  const items = [];
  for (const f of fs.readdirSync(catDir)) {
    if (!f.endsWith('.txt')) continue;
    const txt = fs.readFileSync(path.join(catDir, f), 'utf8');
    if (!/^\/\/\/\s*auditable/m.test(txt)) continue;
    const name = f.replace(/\.txt$/, '');
    items.push({ name, title: titleOf(txt, name), href: `${cat}/${name}.html` });
  }
  if (items.length) { items.sort((a, b) => a.title.localeCompare(b.title)); cats[cat] = items; }
}

const ordered = [
  ...CATEGORY_ORDER.filter((c) => cats[c]),
  ...Object.keys(cats).filter((c) => !CATEGORY_ORDER.includes(c)),
];
const total = Object.values(cats).reduce((n, a) => n + a.length, 0);

const sections = ordered.map((cat) => `
    <section>
      <h2>${esc(CATEGORY_LABEL[cat] || cat)} <span class="count">${cats[cat].length}</span></h2>
      <div class="grid">
${cats[cat].map((it) => `        <a class="card" href="${esc(it.href)}"><span class="t">${esc(it.title)}</span><span class="n">${esc(it.name)}</span></a>`).join('\n')}
      </div>
    </section>`).join('\n');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>auditable — examples</title>
<style>
  :root { --bg:#14171c; --panel:#1b1f26; --line:#2a2f38; --fg:#e6e8eb; --dim:#9aa3af; --teal:#3fb6b2; --orange:#e08a3c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font-family:"Barlow",system-ui,-apple-system,Segoe UI,sans-serif; line-height:1.5; }
  a { color:inherit; text-decoration:none; }
  header { padding:48px 24px 8px; max-width:1100px; margin:0 auto; }
  header h1 { font-family:"Space Mono",ui-monospace,Menlo,monospace; font-size:28px; margin:0 0 6px; }
  header h1 a:hover { color:var(--teal); }
  header p { color:var(--dim); margin:0; max-width:60ch; }
  header .back { display:inline-block; margin-bottom:18px; color:var(--teal);
    font-family:"Space Mono",monospace; font-size:13px; }
  main { max-width:1100px; margin:0 auto; padding:16px 24px 64px; }
  section { margin-top:34px; }
  section h2 { font-family:"Space Mono",monospace; font-size:14px; letter-spacing:.04em;
    text-transform:uppercase; color:var(--dim); border-bottom:1px solid var(--line);
    padding-bottom:8px; margin:0 0 16px; }
  section h2 .count { color:var(--line); margin-left:6px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:14px 16px; display:flex; flex-direction:column; gap:4px; transition:border-color .12s,transform .12s; }
  .card:hover { border-color:var(--teal); transform:translateY(-1px); }
  .card .t { font-weight:600; }
  .card .n { font-family:"Space Mono",monospace; font-size:12px; color:var(--dim); }
  footer { max-width:1100px; margin:0 auto; padding:24px; color:var(--dim);
    font-size:13px; border-top:1px solid var(--line); }
</style>
</head>
<body>
<header>
  <a class="back" href="../index.html">← auditable</a>
  <h1><a href="../index.html">examples</a></h1>
  <p>${total} self-contained notebooks — each one a single HTML file. Click any to open and run it live; nothing is installed, nothing is fetched.</p>
</header>
<main>
${sections}
</main>
<footer>auditable · Geoscientific Chaos Union · <a href="https://github.com/endarthur/auditable" style="color:var(--teal)">github.com/endarthur/auditable</a></footer>
</body>
</html>
`;

fs.writeFileSync(outFile, html);
console.log(`Wrote examples/index.html — ${total} examples across ${ordered.length} categories`);
