const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_mandelbrot.html',
  title: 'Mandelbrot explorer',
  cells: [
    workshopCell('Mandelbrot explorer', [
      `{
    title: 'Reactive widgets',
    content: md\`Five \\\`ui.slider\\\` calls define the exploration
parameters. Each returns a numeric \\\`const\\\` \\u2014 when the
user drags a slider, the cell re-runs and all downstream
cells re-execute automatically.

This is the **reactive** widget pattern: no \\\`onInput\\\`
callback, so the DAG handles propagation. Contrast this
with the synth or shader examples that use callbacks
for real-time control.\`
  }`,
      `{
    title: 'Pixel-level canvas',
    content: md\`The render cell creates an \\\`ImageData\\\`
buffer and writes RGBA values pixel by pixel. This is
the fastest way to do per-pixel computation on a
canvas \\u2014 no draw calls, just array writes followed
by a single \\\`putImageData\\\`.

\\\`ui.canvas(w, h)\\\` creates the canvas element in the
cell output. The computation runs synchronously \\u2014
for very high iterations or resolution, consider
\\\`// %manual\\\` to avoid blocking on every slider drag.\`
  }`,
      `{
    title: 'Computed dependencies',
    content: md\`Both cells live in the same notebook scope.
The render cell references \\\`maxIter\\\`, \\\`zoom\\\`,
\\\`centerX\\\`, \\\`centerY\\\`, and \\\`colorShift\\\` \\u2014 all
defined by the slider cell.

The DAG engine sees these references via
\\\`findUses()\\\` and builds the dependency edge
automatically. Change any slider \\u2192 parameter cell
re-runs \\u2192 render cell re-runs. No manual wiring
needed.\`
  }`
    ]),
    { type: 'md', code: "# mandelbrot set\n\nexplore the fractal. adjust iterations for detail, zoom and pan to find interesting regions." },
    { type: 'code', code: "const maxIter = ui.slider(\"iterations\", 100, {min:20, max:500, step:10});\nconst zoom = ui.slider(\"zoom\", 1, {min:0.5, max:500, step:0.5});\nconst centerX = ui.slider(\"center x\", -0.5, {min:-2.5, max:1.5, step:0.01});\nconst centerY = ui.slider(\"center y\", 0, {min:-1.5, max:1.5, step:0.01});\nconst colorShift = ui.slider(\"color shift\", 0, {min:0, max:360, step:5});" },
    { type: 'code', code: "const size = Math.min(500, window.innerWidth - 80);\nconst c = ui.canvas(size, size);\nconst ctx = c.getContext(\"2d\");\nconst img = ctx.createImageData(size, size);\n\nconst scale = 3 / (size * zoom);\nconst ox = centerX - (size / 2) * scale;\nconst oy = centerY - (size / 2) * scale;\n\nfor (let py = 0; py < size; py++) {\n  for (let px = 0; px < size; px++) {\n    let x0 = ox + px * scale;\n    let y0 = oy + py * scale;\n    let x = 0, y = 0, i = 0;\n    while (x * x + y * y <= 4 && i < maxIter) {\n      const tmp = x * x - y * y + x0;\n      y = 2 * x * y + y0;\n      x = tmp;\n      i++;\n    }\n\n    const idx = (py * size + px) * 4;\n    if (i === maxIter) {\n      img.data[idx] = img.data[idx+1] = img.data[idx+2] = 0;\n    } else {\n      const t = i / maxIter;\n      const hue = (colorShift + 360 * t) % 360;\n      const s = 0.8, l = 0.15 + 0.35 * t;\n      // HSL to RGB\n      const c2 = (1 - Math.abs(2 * l - 1)) * s;\n      const x2 = c2 * (1 - Math.abs((hue / 60) % 2 - 1));\n      const m = l - c2 / 2;\n      let r, g, b;\n      if (hue < 60)       { r = c2; g = x2; b = 0; }\n      else if (hue < 120) { r = x2; g = c2; b = 0; }\n      else if (hue < 180) { r = 0;  g = c2; b = x2; }\n      else if (hue < 240) { r = 0;  g = x2; b = c2; }\n      else if (hue < 300) { r = x2; g = 0;  b = c2; }\n      else                { r = c2; g = 0;  b = x2; }\n      img.data[idx]   = Math.round((r + m) * 255);\n      img.data[idx+1] = Math.round((g + m) * 255);\n      img.data[idx+2] = Math.round((b + m) * 255);\n    }\n    img.data[idx+3] = 255;\n  }\n}\n\nctx.putImageData(img, 0, 0);\nui.display(`${size}\\u00d7${size} \\u00b7 ${maxIter} iterations \\u00b7 zoom ${zoom}x \\u00b7 center (${centerX}, ${centerY})`);" }
  ]
};
