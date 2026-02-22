const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_modules.html',
  title: 'module playground',
  cells: [
    workshopCell('Module playground', [
      `{
    title: 'install() vs load()',
    content: md\`\\\`install(url)\\\` fetches a module and
**embeds its source** in the HTML file on save.
After saving, the module loads instantly with no
network access. Use it for dependencies you need
offline.

\\\`load(url)\\\` imports a module at runtime from the
network. It\\u2019s cached for the session but not
persisted. Use it for modules you\\u2019re experimenting
with or that are too large to embed.\`
  }`,
      `{
    title: 'Offline capability',
    content: md\`When you save a notebook with
\\\`install()\\\`-ed modules, the module source is stored
in the \\\`AUDITABLE-MODULES\\\` HTML comment block
(base64-encoded). The notebook becomes fully
self-contained.

Open a saved notebook on an airplane \\u2014 installed
modules work. \\\`load()\\\`-ed modules will fail because
they need the network. This is the core trade-off:
embed size vs offline access.\`
  }`,
      `{
    title: 'Save persistence',
    content: md\`Both \\\`install()\\\` and \\\`load()\\\` share the
same import cache (\\\`window._importCache\\\`). But only
\\\`install()\\\` writes to \\\`window._installedModules\\\`,
which gets serialized into the HTML on save.

The esm.sh URL gets \\\`?bundle\\\` appended automatically
so the module and its dependencies are bundled into
a single fetch. This keeps the installed module
self-contained.\`
  }`
    ]),
    { type: 'md', code: "# module playground\n\ndemonstrates `install()` for offline-capable module embedding and `load()` for on-demand imports. after saving, installed modules work without a network connection." },
    { type: 'code', code: "// install() fetches the module source and embeds it in the HTML on save.\n// this means the notebook works offline after saving.\nconst { format, formatDistanceToNow } = await install(\"https://esm.sh/date-fns\");" },
    { type: 'code', code: "// load() imports a module at runtime (requires network).\n// useful for modules you don't need offline.\nconst confetti = await load(\"https://esm.sh/canvas-confetti\");" },
    { type: 'code', code: "const dateStyle = ui.dropdown(\"format\", [\"full\", \"short\", \"relative\"]);\nconst sampleDate = ui.textInput(\"date\", \"2024-07-20\");" },
    { type: 'code', code: "const d = new Date(sampleDate);\nlet formatted;\nif (isNaN(d.getTime())) {\n  formatted = \"(invalid date)\";\n} else if (dateStyle === \"full\") {\n  formatted = format(d, \"EEEE, MMMM do, yyyy\");\n} else if (dateStyle === \"short\") {\n  formatted = format(d, \"MM/dd/yy\");\n} else {\n  formatted = formatDistanceToNow(d, { addSuffix: true });\n}\nui.display(formatted);" },
    { type: 'code', code: "// confetti on demand\nconst fire = ui.checkbox(\"confetti\", false);\nif (fire) confetti.default({ particleCount: 120, spread: 80, origin: { y: 0.7 } });" }
  ]
};
