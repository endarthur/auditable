const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_life.html',
  title: 'game of life',
  cells: [
    workshopCell('Game of Life', [
      `{
    title: 'Manual cells',
    content: md\`This entire notebook is a single
\\\`// %manual\\\` cell. Manual cells **don\\u2019t re-run**
when upstream values change \\u2014 they only execute
on **Ctrl+Enter** or **Run All**.

This is ideal for stateful simulations like Game of
Life, where you need persistent mutable state
(\\\`grid\\\`, \\\`gen\\\`) that survives between frames.\`
  }`,
      `{
    title: 'Imperative callbacks',
    content: md\`The controls (step, play, reset) are plain
DOM buttons with \\\`onclick\\\` handlers. No reactive
widgets, no DAG overhead \\u2014 just imperative JavaScript.

This pattern works when your UI is a tight loop:
\\\`step() \\u2192 draw() \\u2192 update label\\\`. Callbacks
mutate shared state directly, which is exactly what
the reactive model forbids in normal cells.\`
  }`,
      `{
    title: 'Canvas & invalidation',
    content: md\`\\\`ui.canvas(w, h)\\\` creates a
\\\`<canvas>\\\` element in the cell\\u2019s output. The cell
draws to it imperatively via \\\`getContext("2d")\\\`.

The \\\`invalidation\\\` promise resolves just before a
cell re-runs. Use it for cleanup:
\\\`invalidation.then(() => clearInterval(timer))\\\`.
Without this, re-running the cell would leak
intervals and canvases.\`
  }`
    ]),
    { type: 'md', code: "# conway's game of life\n\na cellular automaton running on canvas. press **step** or toggle **play** to watch it evolve. this is a single `// %manual` cell using imperative callbacks \u2014 no reactive DAG needed." },
    { type: 'code', code: "// %manual\nconst W = 80, H = 60;\nlet grid = new Uint8Array(W * H);\nlet gen = 0;\n\nfunction seed(density) {\n  for (let i = 0; i < grid.length; i++)\n    grid[i] = Math.random() < density ? 1 : 0;\n  gen = 0;\n}\nseed(0.3);\n\nfunction step() {\n  const next = new Uint8Array(W * H);\n  for (let y = 0; y < H; y++) {\n    for (let x = 0; x < W; x++) {\n      let n = 0;\n      for (let dy = -1; dy <= 1; dy++) {\n        for (let dx = -1; dx <= 1; dx++) {\n          if (dx === 0 && dy === 0) continue;\n          n += grid[((y + dy + H) % H) * W + ((x + dx + W) % W)];\n        }\n      }\n      const alive = grid[y * W + x];\n      next[y * W + x] = (alive && (n === 2 || n === 3)) || (!alive && n === 3) ? 1 : 0;\n    }\n  }\n  grid = next;\n  gen++;\n}\n\n// renderer\nconst cellSize = Math.max(4, Math.min(8, Math.floor((window.innerWidth - 80) / W)));\nconst c = ui.canvas(W * cellSize, H * cellSize);\nconst ctx = c.getContext(\"2d\");\n\nfunction draw() {\n  ctx.fillStyle = \"#0a0a0a\";\n  ctx.fillRect(0, 0, c.width, c.height);\n  ctx.fillStyle = \"#c89b3c\";\n  for (let y = 0; y < H; y++)\n    for (let x = 0; x < W; x++)\n      if (grid[y * W + x])\n        ctx.fillRect(x * cellSize, y * cellSize, cellSize - 1, cellSize - 1);\n}\ndraw();\n\n// controls\nlet playing = false, timer = null;\nconst genLabel = document.createElement(\"span\");\ngenLabel.textContent = \"generation: 0\";\n\nconst btnStep = document.createElement(\"button\");\nbtnStep.textContent = \"step\";\nbtnStep.onclick = () => { step(); draw(); genLabel.textContent = \"generation: \" + gen; };\n\nconst btnPlay = document.createElement(\"button\");\nbtnPlay.textContent = \"\\u25b6 play\";\nbtnPlay.onclick = () => {\n  playing = !playing;\n  btnPlay.textContent = playing ? \"\\u23f8 pause\" : \"\\u25b6 play\";\n  if (playing) {\n    timer = setInterval(() => {\n      step(); draw();\n      genLabel.textContent = \"generation: \" + gen;\n    }, 80);\n  } else clearInterval(timer);\n};\n\nconst btnReset = document.createElement(\"button\");\nbtnReset.textContent = \"reset\";\nbtnReset.onclick = () => {\n  playing = false; clearInterval(timer);\n  btnPlay.textContent = \"\\u25b6 play\";\n  seed(0.3); draw();\n  genLabel.textContent = \"generation: 0\";\n};\n\nconst bar = document.createElement(\"div\");\nbar.style.cssText = \"display:flex;gap:8px;margin:8px 0;align-items:center\";\nbar.append(btnStep, btnPlay, btnReset, genLabel);\nui.display(bar);" }
  ]
};
