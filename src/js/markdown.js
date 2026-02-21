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

  // paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  if (!html.startsWith('<h') && !html.startsWith('<p')) html = '<p>' + html + '</p>';

  return html;
}
