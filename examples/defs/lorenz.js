const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_lorenz.html',
  title: 'Lorenz attractor',
  cells: [
    workshopCell('Lorenz attractor', [
      `{
    title: 'Reactive DAG',
    content: md\`This notebook has three cells: **parameters**,
**integration**, and **rendering**. They form a dependency
chain \\u2014 the DAG (directed acyclic graph).

When you drag a slider, auditable detects which variables
changed, finds all downstream cells, and re-executes them
in topological order. You don\\u2019t wire anything up \\u2014
the DAG engine does it automatically.\`
  }`,
      `{
    title: 'Reactive widgets',
    content: md\`\\\`ui.slider(label, default, opts)\\\` returns
the current numeric value. Without an \\\`onInput\\\` callback,
it\\u2019s a **reactive widget**: changing it re-runs the cell
and all dependents.

The five sliders here (\\u03c3, \\u03c1, \\u03b2, steps, rotation)
each define a \\\`const\\\`. Downstream cells that reference
those names are automatically re-executed when any
slider moves.\`
  }`,
      `{
    title: 'Multi-cell data flow',
    content: md\`Cell 2 produces \\\`pts\\\` (the trajectory array).
Cell 3 consumes \\\`pts\\\`, \\\`rotation\\\`, \\\`steps\\\`, etc.
The DAG ensures cell 3 always sees fresh data.

Scope is passed **by value** \\u2014 each cell gets its
upstream variables as function parameters. This means
you can\\u2019t mutate a variable in one cell and see the
change in another. Design your data flow as immutable
pipelines.\`
  }`
    ]),
    { type: 'md', code: "# lorenz attractor\n\na 3D chaotic system rendered as a 2D projection. adjust the parameters and watch the butterfly change shape." },
    { type: 'code', code: "// parameters\nconst sigma = ui.slider(\"\\u03c3 (sigma)\", 10, {min:1, max:30, step:0.5});\nconst rho = ui.slider(\"\\u03c1 (rho)\", 28, {min:1, max:50, step:0.5});\nconst beta = ui.slider(\"\\u03b2 (beta)\", 2.667, {min:0.5, max:8, step:0.1});\nconst steps = ui.slider(\"steps\", 8000, {min:1000, max:20000, step:500});\nconst rotation = ui.slider(\"rotation\", 0, {min:0, max:360, step:1});" },
    { type: 'code', code: "// integrate lorenz system\nconst dt = 0.005;\nconst pts = [];\nlet x = 0.1, y = 0, z = 0;\n\nfor (let i = 0; i < steps; i++) {\n  const dx = sigma * (y - x);\n  const dy = x * (rho - z) - y;\n  const dz = x * y - beta * z;\n  x += dx * dt;\n  y += dy * dt;\n  z += dz * dt;\n  pts.push([x, y, z]);\n}" },
    { type: 'code', code: "// render with rotation and color gradient\nconst size = Math.min(600, window.innerWidth - 80);\nconst c = ui.canvas(size, size);\nconst ctx = c.getContext(\"2d\");\nctx.fillStyle = \"#0a0a0a\";\nctx.fillRect(0, 0, size, size);\n\nconst rad = rotation * Math.PI / 180;\nconst cosR = Math.cos(rad), sinR = Math.sin(rad);\n\n// project 3D to 2D with rotation around Z axis\nfunction project(p) {\n  const rx = p[0] * cosR - p[1] * sinR;\n  const ry = p[0] * sinR + p[1] * cosR;\n  return [rx, p[2]];\n}\n\n// find bounds\nlet xmin = Infinity, xmax = -Infinity;\nlet ymin = Infinity, ymax = -Infinity;\nfor (const p of pts) {\n  const [px, py] = project(p);\n  if (px < xmin) xmin = px;\n  if (px > xmax) xmax = px;\n  if (py < ymin) ymin = py;\n  if (py > ymax) ymax = py;\n}\n\nconst margin = 40;\nconst w = size - 2 * margin;\nconst scx = w / (xmax - xmin);\nconst scy = w / (ymax - ymin);\nconst sc = Math.min(scx, scy);\n\nctx.lineWidth = 0.5;\nctx.globalAlpha = 0.6;\n\nfor (let i = 1; i < pts.length; i++) {\n  const [ax, ay] = project(pts[i - 1]);\n  const [bx, by] = project(pts[i]);\n\n  const t = i / pts.length;\n  const r = Math.round(40 + 180 * t);\n  const g = Math.round(100 + 100 * Math.sin(t * Math.PI));\n  const b = Math.round(220 - 160 * t);\n\n  ctx.strokeStyle = `rgb(${r},${g},${b})`;\n  ctx.beginPath();\n  ctx.moveTo(\n    margin + (ax - xmin) * sc,\n    margin + (ymax - ay) * sc\n  );\n  ctx.lineTo(\n    margin + (bx - xmin) * sc,\n    margin + (ymax - by) * sc\n  );\n  ctx.stroke();\n}\n\nctx.globalAlpha = 1;\nui.display(`${steps} steps \\u00b7 \\u03c3=${sigma} \\u03c1=${rho} \\u03b2=${beta}`);" }
  ]
};
