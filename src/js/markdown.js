// ── MARKDOWN RENDERING (minimal) ──

export function renderMd(src) {
  let html = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // bold/italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // inline code
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');

  // links
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  // tables — detect pipe-delimited blocks before paragraph wrapping
  html = html.replace(
    /((?:^\|.+\|[ \t]*$\n?)+)/gm,
    (block) => {
      const rows = block.trim().split('\n').map(r =>
        r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      );
      if (rows.length < 2) return block;
      // check for separator row (--- or :--- etc)
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

  // paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  if (!html.startsWith('<h') && !html.startsWith('<p') && !html.startsWith('<table')) html = '<p>' + html + '</p>';

  return html;
}
