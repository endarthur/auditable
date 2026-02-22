const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_particles.html',
  title: 'particle sandbox',
  cells: [
    workshopCell('Particle sandbox', [
      `{
    title: 'Mixed widget patterns',
    content: md\`This example uses **both** reactive and
callback widgets in the same cell. The \\\`count\\\` slider
is reactive \\u2014 changing it re-runs the cell to resize
the particle array.

The other sliders (speed, size, hue) use \\\`onInput\\\`
callbacks that write to \\\`let\\\` variables directly.
The animation loop reads these variables each frame,
giving instant visual feedback with zero DAG overhead.\`
  }`,
      `{
    title: 'Manual cells & animation',
    content: md\`\\\`// %manual\\\` prevents re-execution on
upstream changes. The cell creates a
\\\`requestAnimationFrame\\\` loop that runs continuously.

\\\`invalidation.then(() => cancelAnimationFrame(raf))\\\`
ensures the animation stops before any re-run.
Without this, re-running the cell would create
duplicate animation loops, each fighting for
the canvas.\`
  }`,
      `{
    title: 'Reactive re-initialization',
    content: md\`The \\\`count\\\` slider has no \\\`onInput\\\`
callback, so changing it re-runs the entire cell.
This rebuilds the particle array with the new count,
resets the canvas, and restarts the animation loop.

This is the key pattern: use **callbacks** for
parameters that change continuously (speed, color)
and **reactive widgets** for structural changes that
require re-initialization (particle count).\`
  }`
    ]),
    { type: 'md', code: "# particle sandbox\n\na real-time canvas particle system driven by **callback widgets**. reactive widgets control structural parameters (particle count), while `onInput` callbacks give instant control over speed, size, color, and physics \u2014 no DAG overhead, just the browser event loop." },
    { type: 'code', code: "// %manual\nconst W = Math.min(600, window.innerWidth - 80), H = 400;\nconst c = ui.canvas(W, H);\nconst ctx = c.getContext(\"2d\");\n\n// mutable state \u2014 callbacks write directly here\nlet speed = 1, size = 3, hue = 30, gravity = false, trails = true;\n\n// reactive widget \u2014 changing count re-runs this cell to resize the array\nconst count = ui.slider(\"count\", 200, {min: 10, max: 1000, step: 10});\n\n// callback widgets \u2014 real-time, zero DAG overhead\nui.slider(\"speed\", 1, {min: 0.1, max: 5, step: 0.1, onInput: v => speed = v});\nui.slider(\"size\", 3, {min: 1, max: 10, step: 0.5, onInput: v => size = v});\nui.slider(\"hue\", 30, {min: 0, max: 360, step: 5, onInput: v => hue = v});\nui.checkbox(\"gravity\", false, {onInput: v => gravity = v});\nui.checkbox(\"trails\", true, {onInput: v => trails = v});\n\n// init particles\nconst particles = [];\nfor (let i = 0; i < count; i++) {\n  particles.push({\n    x: Math.random() * W,\n    y: Math.random() * H,\n    vx: (Math.random() - 0.5) * 4,\n    vy: (Math.random() - 0.5) * 4\n  });\n}\n\n// animation loop\nlet raf;\nfunction frame() {\n  if (trails) {\n    ctx.fillStyle = \"rgba(10, 10, 10, 0.15)\";\n    ctx.fillRect(0, 0, W, H);\n  } else {\n    ctx.fillStyle = \"#0a0a0a\";\n    ctx.fillRect(0, 0, W, H);\n  }\n\n  for (const p of particles) {\n    if (gravity) p.vy += 0.1 * speed;\n    p.x += p.vx * speed;\n    p.y += p.vy * speed;\n\n    // bounce off walls\n    if (p.x < 0)     { p.x = 0;     p.vx = Math.abs(p.vx); }\n    if (p.x > W)     { p.x = W;     p.vx = -Math.abs(p.vx); }\n    if (p.y < 0)     { p.y = 0;     p.vy = Math.abs(p.vy); }\n    if (p.y > H)     { p.y = H;     p.vy = -Math.abs(p.vy); }\n\n    const t = (p.x / W + p.y / H) / 2;\n    ctx.fillStyle = `hsl(${hue + t * 60}, 80%, 55%)`;\n    ctx.beginPath();\n    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);\n    ctx.fill();\n  }\n\n  raf = requestAnimationFrame(frame);\n}\nframe();\n\ninvalidation.then(() => cancelAnimationFrame(raf));" }
  ]
};
