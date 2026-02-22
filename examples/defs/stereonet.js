const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_stereonet.html',
  title: 'stereonet',
  cells: [
    workshopCell('Stereonet', [
      `{
    title: 'Loading external modules',
    content: md\`\\\`load(url)\\\` imports an ES module at runtime
and caches it for the session. Here it fetches
\\\`@gcu/bearing\\\` from esm.sh.

Unlike \\\`install()\\\`, \\\`load()\\\` doesn\\u2019t embed the
source in the HTML \\u2014 it requires network access
each session. Use \\\`load()\\\` for libraries you don\\u2019t
need offline, or during development before committing
to \\\`install()\\\`.\`
  }`,
      `{
    title: 'Reactive checkboxes & sliders',
    content: md\`\\\`ui.checkbox(label, default)\\\` and
\\\`ui.slider(label, default, opts)\\\` are **reactive
widgets** \\u2014 no \\\`onInput\\\` callback, so changing them
re-runs the cell and all dependents.

The render cell reads \\\`showPlanes\\\`, \\\`showPoles\\\`,
\\\`trend\\\`, and \\\`plunge\\\`. Toggle a checkbox \\u2192 the
render cell re-runs \\u2192 the stereonet updates.
The DAG handles the propagation.\`
  }`,
      `{
    title: 'Multi-cell structure',
    content: md\`The data (\\\`planes\\\`, \\\`fault\\\`) lives in
its own cell, separate from controls and rendering.
This is a common auditable pattern:
**data \\u2192 controls \\u2192 computation \\u2192 display**.

Each cell defines \\\`const\\\` values that downstream
cells consume. Editing the planes array and pressing
Ctrl+Enter re-runs only the cells that depend on it.\`
  }`
    ]),
    { type: 'md', code: "# interactive stereonet\n\nusing `@gcu/bearing` to plot structural geology data on an equal-area stereonet. try changing the measurements or rotating the view." },
    { type: 'code', code: "const { Stereonet } = await load(\"https://esm.sh/@gcu/bearing\");" },
    { type: 'code', code: "// bedding planes \u2014 strike/dip (right-hand rule)\nconst planes = [\n  [120, 35], [125, 40], [118, 32],\n  [130, 38], [115, 30], [122, 42],\n  [128, 36], [117, 33], [135, 45],\n];\n\n// a fault\nconst fault = [210, 65];" },
    { type: 'code', code: "const trend = ui.slider(\"view trend\", 0, {min:0, max:360, step:5});\nconst plunge = ui.slider(\"view plunge\", 90, {min:0, max:90, step:5});\nconst showPlanes = ui.checkbox(\"great circles\", true);\nconst showPoles = ui.checkbox(\"poles\", true);" },
    { type: 'code', code: "const s = new Stereonet({ size: 500, projection: 'equal-area' });\n\nif (trend !== 0 || plunge !== 90) {\n  s.setCenter(trend, plunge);\n}\n\nif (showPlanes) {\n  for (const [strike, dip] of planes) {\n    s.plane(strike, dip);\n  }\n  s.plane(fault[0], fault[1], { color: '#c33', width: 2 });\n}\n\nif (showPoles) {\n  for (const [strike, dip] of planes) {\n    s.pole(strike, dip);\n  }\n  s.pole(fault[0], fault[1], { color: '#c33', radius: 5 });\n}\n\ns.render();\nui.display(s.element());\nui.display(`${planes.length} bedding planes + 1 fault \\u00b7 view: ${trend}/${plunge}`);" }
  ]
};
