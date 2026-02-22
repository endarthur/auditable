// Shared helpers for generating workshop cells in examples.

function workshopIntro(title) {
  return `{
    title: '${title}',
    content: md\`This is a guided **workshop** for this notebook.
Use the **prev** and **next** buttons below to navigate
between pages, or click the progress dots to jump directly.

Close this panel with the **\\u00d7** button. Reopen it
anytime with the **workshop** tab on the right edge
of the screen.\`
  }`;
}

function workshopCell(introTitle, pages) {
  const allPages = [workshopIntro(introTitle), ...pages];
  return {
    type: 'code',
    collapsed: true,
    code: `// %collapsed\nworkshop([\n  ${allPages.join(',\n  ')},\n])`
  };
}

module.exports = { workshopIntro, workshopCell };
