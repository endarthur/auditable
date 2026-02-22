const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_workshop.html',
  title: 'workshop workshop',
  cells: [
    workshopCell('Workshop workshop', [
      `{
    title: 'What is a workshop?',
    content: md\`A **workshop** is a guided side panel that walks
users through a notebook. Call \\\`workshop(pages)\\\`
with an array of page objects and a panel slides in
from the right.

The workshop cell is typically \\\`// %collapsed\\\` so
it stays out of the way. Users see the normal notebook
layout but get step-by-step guidance in the panel.

Each page has a \\\`title\\\` and \\\`content\\\`. Content is
usually written with the \\\`md\\\` tagged template for
markdown rendering.\`
  }`,
      `{
    title: 'Pages & content',
    content: md\`Each page is an object with \\\`title\\\` and
\\\`content\\\`. The \\\`md\\\` tagged template renders markdown:

\\\`\\\`\\\`js
workshop([
  { title: 'Intro', content: md\\\`**bold** and \\\\\\\`code\\\\\\\`\\\` },
  { title: 'HTML', content: html\\\`<em>raw html</em>\\\` },
])
\\\`\\\`\\\`

You can also use \\\`html\\\` for raw HTML content or
\\\`css\\\` for code display. The \\\`md\\\` tag is the most
common choice.\`
  }`,
      `{
    title: 'Gating progress',
    content: md\`Add a \\\`canAdvance\\\` function to a page to
block the **next** button until a condition is met:

\\\`\\\`\\\`js
{ title: 'Task', content: md\\\`Set x to 5\\\`,
  canAdvance: () => notebook.scope.x === 5 }
\\\`\\\`\\\`

\\\`notebook.scope\\\` is a read-only snapshot of all cell
outputs. When any cell re-runs, the workshop
automatically rechecks gates. This enables interactive
exercises where users must complete a step before
advancing.\`
  }`,
      `{
    title: 'The notebook API',
    content: md\`The \\\`notebook\\\` object lets workshops
interact with the notebook:

- \\\`notebook.cells\\\` \\u2014 read-only array of \\\`{id, type, code}\\\`
- \\\`notebook.scope\\\` \\u2014 snapshot of current variable values
- \\\`notebook.scrollTo(id)\\\` \\u2014 scroll a cell into view
- \\\`notebook.focus(id)\\\` \\u2014 focus a cell\\u2019s editor
- \\\`notebook.addCell(type, code, afterId)\\\` \\u2014 insert a new cell
- \\\`notebook.run(ids)\\\` \\u2014 execute specific cells

The \\\`workshop()\\\` call returns
\\\`{ goto, toggle, recheck }\\\`
for programmatic control.\`
  }`
    ]),
    { type: 'md', code: "# workshop workshop\n\na self-referential example: the side panel you see is itself a workshop, built from the collapsed code cell above. open it with the **workshop** tab on the right edge." },
    { type: 'code', code: "// try defining a variable \u2014 workshops can read notebook.scope\nconst x = 5;" },
    { type: 'code', code: "// the workshop() builtin returns controls\n// you can call w.goto(0) to jump to a page,\n// w.toggle() to show/hide, w.recheck() to re-evaluate gates.\nui.display(\"open the workshop panel via the tab on the right edge \u2192\");" }
  ]
};
