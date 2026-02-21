#!/usr/bin/env node
// Generates all example notebooks from auditable.html + inline cell definitions.
// Usage: node gen_examples.js
//
// To add a new example: append an entry to the `examples` array below,
// then run `node gen_examples.js`.

const path = require('path');
const makeExample = require('./make_example');

const outDir = path.join(__dirname, 'examples');

const examples = [
  {
    file: 'example_life.html',
    title: 'game of life',
    cells: [
      { type: 'md', code: "# conway's game of life\n\na cellular automaton running on canvas. press **step** or toggle **play** to watch it evolve. this is a single `// %manual` cell using imperative callbacks \u2014 no reactive DAG needed." },
      { type: 'code', code: "// %manual\nconst W = 80, H = 60;\nlet grid = new Uint8Array(W * H);\nlet gen = 0;\n\nfunction seed(density) {\n  for (let i = 0; i < grid.length; i++)\n    grid[i] = Math.random() < density ? 1 : 0;\n  gen = 0;\n}\nseed(0.3);\n\nfunction step() {\n  const next = new Uint8Array(W * H);\n  for (let y = 0; y < H; y++) {\n    for (let x = 0; x < W; x++) {\n      let n = 0;\n      for (let dy = -1; dy <= 1; dy++) {\n        for (let dx = -1; dx <= 1; dx++) {\n          if (dx === 0 && dy === 0) continue;\n          n += grid[((y + dy + H) % H) * W + ((x + dx + W) % W)];\n        }\n      }\n      const alive = grid[y * W + x];\n      next[y * W + x] = (alive && (n === 2 || n === 3)) || (!alive && n === 3) ? 1 : 0;\n    }\n  }\n  grid = next;\n  gen++;\n}\n\n// renderer\nconst cellSize = Math.max(4, Math.min(8, Math.floor((window.innerWidth - 80) / W)));\nconst c = canvas(W * cellSize, H * cellSize);\nconst ctx = c.getContext(\"2d\");\n\nfunction draw() {\n  ctx.fillStyle = \"#0a0a0a\";\n  ctx.fillRect(0, 0, c.width, c.height);\n  ctx.fillStyle = \"#c89b3c\";\n  for (let y = 0; y < H; y++)\n    for (let x = 0; x < W; x++)\n      if (grid[y * W + x])\n        ctx.fillRect(x * cellSize, y * cellSize, cellSize - 1, cellSize - 1);\n}\ndraw();\n\n// controls\nlet playing = false, timer = null;\nconst genLabel = document.createElement(\"span\");\ngenLabel.textContent = \"generation: 0\";\n\nconst btnStep = document.createElement(\"button\");\nbtnStep.textContent = \"step\";\nbtnStep.onclick = () => { step(); draw(); genLabel.textContent = \"generation: \" + gen; };\n\nconst btnPlay = document.createElement(\"button\");\nbtnPlay.textContent = \"\\u25b6 play\";\nbtnPlay.onclick = () => {\n  playing = !playing;\n  btnPlay.textContent = playing ? \"\\u23f8 pause\" : \"\\u25b6 play\";\n  if (playing) {\n    timer = setInterval(() => {\n      step(); draw();\n      genLabel.textContent = \"generation: \" + gen;\n    }, 80);\n  } else clearInterval(timer);\n};\n\nconst btnReset = document.createElement(\"button\");\nbtnReset.textContent = \"reset\";\nbtnReset.onclick = () => {\n  playing = false; clearInterval(timer);\n  btnPlay.textContent = \"\\u25b6 play\";\n  seed(0.3); draw();\n  genLabel.textContent = \"generation: 0\";\n};\n\nconst bar = document.createElement(\"div\");\nbar.style.cssText = \"display:flex;gap:8px;margin:8px 0;align-items:center\";\nbar.append(btnStep, btnPlay, btnReset, genLabel);\ndisplay(bar);" }
    ]
  },
  {
    file: 'example_lorenz.html',
    title: 'Lorenz attractor',
    cells: [
      { type: 'md', code: "# lorenz attractor\n\na 3D chaotic system rendered as a 2D projection. adjust the parameters and watch the butterfly change shape." },
      { type: 'code', code: "// parameters\nconst sigma = slider(\"\\u03c3 (sigma)\", 10, {min:1, max:30, step:0.5});\nconst rho = slider(\"\\u03c1 (rho)\", 28, {min:1, max:50, step:0.5});\nconst beta = slider(\"\\u03b2 (beta)\", 2.667, {min:0.5, max:8, step:0.1});\nconst steps = slider(\"steps\", 8000, {min:1000, max:20000, step:500});\nconst rotation = slider(\"rotation\", 0, {min:0, max:360, step:1});" },
      { type: 'code', code: "// integrate lorenz system\nconst dt = 0.005;\nconst pts = [];\nlet x = 0.1, y = 0, z = 0;\n\nfor (let i = 0; i < steps; i++) {\n  const dx = sigma * (y - x);\n  const dy = x * (rho - z) - y;\n  const dz = x * y - beta * z;\n  x += dx * dt;\n  y += dy * dt;\n  z += dz * dt;\n  pts.push([x, y, z]);\n}" },
      { type: 'code', code: "// render with rotation and color gradient\nconst size = Math.min(600, window.innerWidth - 80);\nconst c = canvas(size, size);\nconst ctx = c.getContext(\"2d\");\nctx.fillStyle = \"#0a0a0a\";\nctx.fillRect(0, 0, size, size);\n\nconst rad = rotation * Math.PI / 180;\nconst cosR = Math.cos(rad), sinR = Math.sin(rad);\n\n// project 3D to 2D with rotation around Z axis\nfunction project(p) {\n  const rx = p[0] * cosR - p[1] * sinR;\n  const ry = p[0] * sinR + p[1] * cosR;\n  return [rx, p[2]];\n}\n\n// find bounds\nlet xmin = Infinity, xmax = -Infinity;\nlet ymin = Infinity, ymax = -Infinity;\nfor (const p of pts) {\n  const [px, py] = project(p);\n  if (px < xmin) xmin = px;\n  if (px > xmax) xmax = px;\n  if (py < ymin) ymin = py;\n  if (py > ymax) ymax = py;\n}\n\nconst margin = 40;\nconst w = size - 2 * margin;\nconst scx = w / (xmax - xmin);\nconst scy = w / (ymax - ymin);\nconst sc = Math.min(scx, scy);\n\nctx.lineWidth = 0.5;\nctx.globalAlpha = 0.6;\n\nfor (let i = 1; i < pts.length; i++) {\n  const [ax, ay] = project(pts[i - 1]);\n  const [bx, by] = project(pts[i]);\n\n  const t = i / pts.length;\n  const r = Math.round(40 + 180 * t);\n  const g = Math.round(100 + 100 * Math.sin(t * Math.PI));\n  const b = Math.round(220 - 160 * t);\n\n  ctx.strokeStyle = `rgb(${r},${g},${b})`;\n  ctx.beginPath();\n  ctx.moveTo(\n    margin + (ax - xmin) * sc,\n    margin + (ymax - ay) * sc\n  );\n  ctx.lineTo(\n    margin + (bx - xmin) * sc,\n    margin + (ymax - by) * sc\n  );\n  ctx.stroke();\n}\n\nctx.globalAlpha = 1;\ndisplay(`${steps} steps \\u00b7 \\u03c3=${sigma} \\u03c1=${rho} \\u03b2=${beta}`);" }
    ]
  },
  {
    file: 'example_mandelbrot.html',
    title: 'Mandelbrot explorer',
    cells: [
      { type: 'md', code: "# mandelbrot set\n\nexplore the fractal. adjust iterations for detail, zoom and pan to find interesting regions." },
      { type: 'code', code: "const maxIter = slider(\"iterations\", 100, {min:20, max:500, step:10});\nconst zoom = slider(\"zoom\", 1, {min:0.5, max:500, step:0.5});\nconst centerX = slider(\"center x\", -0.5, {min:-2.5, max:1.5, step:0.01});\nconst centerY = slider(\"center y\", 0, {min:-1.5, max:1.5, step:0.01});\nconst colorShift = slider(\"color shift\", 0, {min:0, max:360, step:5});" },
      { type: 'code', code: "const size = Math.min(500, window.innerWidth - 80);\nconst c = canvas(size, size);\nconst ctx = c.getContext(\"2d\");\nconst img = ctx.createImageData(size, size);\n\nconst scale = 3 / (size * zoom);\nconst ox = centerX - (size / 2) * scale;\nconst oy = centerY - (size / 2) * scale;\n\nfor (let py = 0; py < size; py++) {\n  for (let px = 0; px < size; px++) {\n    let x0 = ox + px * scale;\n    let y0 = oy + py * scale;\n    let x = 0, y = 0, i = 0;\n    while (x * x + y * y <= 4 && i < maxIter) {\n      const tmp = x * x - y * y + x0;\n      y = 2 * x * y + y0;\n      x = tmp;\n      i++;\n    }\n\n    const idx = (py * size + px) * 4;\n    if (i === maxIter) {\n      img.data[idx] = img.data[idx+1] = img.data[idx+2] = 0;\n    } else {\n      const t = i / maxIter;\n      const hue = (colorShift + 360 * t) % 360;\n      const s = 0.8, l = 0.15 + 0.35 * t;\n      // HSL to RGB\n      const c2 = (1 - Math.abs(2 * l - 1)) * s;\n      const x2 = c2 * (1 - Math.abs((hue / 60) % 2 - 1));\n      const m = l - c2 / 2;\n      let r, g, b;\n      if (hue < 60)       { r = c2; g = x2; b = 0; }\n      else if (hue < 120) { r = x2; g = c2; b = 0; }\n      else if (hue < 180) { r = 0;  g = c2; b = x2; }\n      else if (hue < 240) { r = 0;  g = x2; b = c2; }\n      else if (hue < 300) { r = x2; g = 0;  b = c2; }\n      else                { r = c2; g = 0;  b = x2; }\n      img.data[idx]   = Math.round((r + m) * 255);\n      img.data[idx+1] = Math.round((g + m) * 255);\n      img.data[idx+2] = Math.round((b + m) * 255);\n    }\n    img.data[idx+3] = 255;\n  }\n}\n\nctx.putImageData(img, 0, 0);\ndisplay(`${size}\\u00d7${size} \\u00b7 ${maxIter} iterations \\u00b7 zoom ${zoom}x \\u00b7 center (${centerX}, ${centerY})`);" }
    ]
  },
  {
    file: 'example_stereonet.html',
    title: 'stereonet',
    cells: [
      { type: 'md', code: "# interactive stereonet\n\nusing `@gcu/bearing` to plot structural geology data on an equal-area stereonet. try changing the measurements or rotating the view." },
      { type: 'code', code: "const { Stereonet } = await load(\"https://esm.sh/@gcu/bearing\");" },
      { type: 'code', code: "// bedding planes \u2014 strike/dip (right-hand rule)\nconst planes = [\n  [120, 35], [125, 40], [118, 32],\n  [130, 38], [115, 30], [122, 42],\n  [128, 36], [117, 33], [135, 45],\n];\n\n// a fault\nconst fault = [210, 65];" },
      { type: 'code', code: "const trend = slider(\"view trend\", 0, {min:0, max:360, step:5});\nconst plunge = slider(\"view plunge\", 90, {min:0, max:90, step:5});\nconst showPlanes = checkbox(\"great circles\", true);\nconst showPoles = checkbox(\"poles\", true);" },
      { type: 'code', code: "const s = new Stereonet({ size: 500, projection: 'equal-area' });\n\nif (trend !== 0 || plunge !== 90) {\n  s.setCenter(trend, plunge);\n}\n\nif (showPlanes) {\n  for (const [strike, dip] of planes) {\n    s.plane(strike, dip);\n  }\n  s.plane(fault[0], fault[1], { color: '#c33', width: 2 });\n}\n\nif (showPoles) {\n  for (const [strike, dip] of planes) {\n    s.pole(strike, dip);\n  }\n  s.pole(fault[0], fault[1], { color: '#c33', radius: 5 });\n}\n\ns.render();\ndisplay(s.element());\ndisplay(`${planes.length} bedding planes + 1 fault \\u00b7 view: ${trend}/${plunge}`);" }
    ]
  },
  {
    file: 'example_synth.html',
    title: 'synth',
    cells: [
      { type: 'md', code: "# browser synth\n\na simple synthesizer using the Web Audio API. all from vanilla JS in a single HTML file." },
      { type: 'code', code: "// %manual\n// audio context (needs user interaction to start)\nconst audioCtx = new (window.AudioContext || window.webkitAudioContext)();\n\nfunction playNote(freq, duration, type) {\n  const osc = audioCtx.createOscillator();\n  const gain = audioCtx.createGain();\n  osc.type = type;\n  osc.frequency.value = freq;\n  gain.gain.setValueAtTime(0.3, audioCtx.currentTime);\n  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);\n  osc.connect(gain);\n  gain.connect(audioCtx.destination);\n  osc.start();\n  osc.stop(audioCtx.currentTime + duration);\n}\n\ndisplay(\"audio engine ready\");" },
      { type: 'code', code: "const wave = dropdown(\"waveform\", [\"sine\", \"triangle\", \"sawtooth\", \"square\"]);\nconst octave = slider(\"octave\", 4, {min:2, max:6, step:1});\nconst decay = slider(\"decay\", 0.5, {min:0.1, max:2, step:0.1});" },
      { type: 'code', code: "// build keyboard\nconst notes = [\n  [\"C\", 0], [\"C#\", 1], [\"D\", 2], [\"D#\", 3],\n  [\"E\", 4], [\"F\", 5], [\"F#\", 6], [\"G\", 7],\n  [\"G#\", 8], [\"A\", 9], [\"A#\", 10], [\"B\", 11]\n];\n\nfunction noteFreq(semitone, oct) {\n  return 440 * Math.pow(2, (semitone - 9) / 12 + (oct - 4));\n}\n\nconst kb = document.createElement(\"div\");\nkb.style.cssText = \"display:flex;gap:2px;margin:12px 0;flex-wrap:wrap\";\n\nfor (const [name, semi] of notes) {\n  const btn = document.createElement(\"button\");\n  const isSharp = name.includes(\"#\");\n  btn.textContent = name;\n  btn.style.cssText = isSharp\n    ? \"background:#222;color:#c89b3c;border:1px solid #444;padding:20px 8px 40px;font-size:11px;min-width:30px;cursor:pointer;font-family:monospace\"\n    : \"background:#1a1a1a;color:#aaa;border:1px solid #333;padding:20px 12px 40px;font-size:11px;min-width:36px;cursor:pointer;font-family:monospace\";\n  btn.onmousedown = () => {\n    playNote(noteFreq(semi, octave), decay, wave);\n    btn.style.borderColor = \"#c89b3c\";\n  };\n  btn.onmouseup = () => {\n    btn.style.borderColor = isSharp ? \"#444\" : \"#333\";\n  };\n  btn.onmouseleave = () => {\n    btn.style.borderColor = isSharp ? \"#444\" : \"#333\";\n  };\n  kb.appendChild(btn);\n}\n\ndisplay(kb);\ndisplay(`octave ${octave} \\u00b7 ${wave} \\u00b7 decay ${decay}s`);" }
    ]
  },
  {
    file: 'example_idw.html',
    title: 'IDW interpolation',
    cells: [
      { type: 'md', code: "# inverse distance weighting\n\nan interactive IDW interpolation demo. drag the sliders to see the effect of **power** and **sample count** on the estimated surface." },
      { type: 'code', code: "// parameters\nconst nSamples = slider(\"samples\", 20, {min:5, max:80, step:1});\nconst power = slider(\"power\", 2, {min:0.5, max:6, step:0.25});\nconst gridRes = slider(\"grid size\", 100, {min:30, max:200, step:10});\nconst showPts = checkbox(\"show samples\", true);" },
      { type: 'code', code: "// seeded RNG + spatially structured samples\nfunction mulberry32(a) {\n  return function() {\n    a |= 0; a = a + 0x6D2B79F5 | 0;\n    let t = Math.imul(a ^ a >>> 15, 1 | a);\n    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;\n    return ((t ^ t >>> 14) >>> 0) / 4294967296;\n  };\n}\nconst rng = mulberry32(42);\n\nconst samples = Array.from({length: nSamples}, () => {\n  const x = rng(), y = rng();\n  const trend = 0.5 * Math.sin(x * 3.5) * Math.cos(y * 2.8) + 0.5;\n  return { x, y, v: 0.4 * rng() + 0.6 * trend };\n});" },
      { type: 'code', code: "// IDW interpolation\nfunction idw(px, py, pts, p) {\n  let wsum = 0, vsum = 0;\n  for (const s of pts) {\n    const dx = px - s.x, dy = py - s.y;\n    const d2 = dx * dx + dy * dy;\n    if (d2 < 1e-12) return s.v;\n    const w = 1 / Math.pow(Math.sqrt(d2), p);\n    wsum += w;\n    vsum += w * s.v;\n  }\n  return vsum / wsum;\n}\n\nconst grid = new Float64Array(gridRes * gridRes);\nfor (let iy = 0; iy < gridRes; iy++) {\n  for (let ix = 0; ix < gridRes; ix++) {\n    grid[iy * gridRes + ix] = idw(\n      (ix + 0.5) / gridRes,\n      (iy + 0.5) / gridRes,\n      samples, power\n    );\n  }\n}" },
      { type: 'code', code: "// render\nconst size = Math.min(500, window.innerWidth - 80);\nconst c = canvas(size, size);\nconst ctx = c.getContext(\"2d\");\n\n// viridis-ish colormap\nfunction viridis(t) {\n  t = Math.max(0, Math.min(1, t));\n  const r = Math.round(255 * Math.max(0, Math.min(1,\n    0.267 + t * (0.004 + t * (5.294 + t * (-14.05 + t * 8.5))))));\n  const g = Math.round(255 * Math.max(0, Math.min(1,\n    0.004 + t * (1.384 + t * (0.098 + t * (-2.74 + t * 2.23))))));\n  const b = Math.round(255 * Math.max(0, Math.min(1,\n    0.329 + t * (1.44 + t * (-5.11 + t * (6.87 + t * -3.57))))));\n  return `rgb(${r},${g},${b})`;\n}\n\nlet vmin = Infinity, vmax = -Infinity;\nfor (let i = 0; i < grid.length; i++) {\n  if (grid[i] < vmin) vmin = grid[i];\n  if (grid[i] > vmax) vmax = grid[i];\n}\nconst vrange = vmax - vmin || 1;\n\nconst cellW = size / gridRes;\nfor (let iy = 0; iy < gridRes; iy++) {\n  for (let ix = 0; ix < gridRes; ix++) {\n    const t = (grid[iy * gridRes + ix] - vmin) / vrange;\n    ctx.fillStyle = viridis(t);\n    ctx.fillRect(ix * cellW, iy * cellW, cellW + 0.5, cellW + 0.5);\n  }\n}\n\nif (showPts) {\n  for (const s of samples) {\n    ctx.beginPath();\n    ctx.arc(s.x * size, s.y * size, 4, 0, Math.PI * 2);\n    ctx.fillStyle = \"#fff\";\n    ctx.fill();\n    ctx.lineWidth = 1.5;\n    ctx.strokeStyle = \"#000\";\n    ctx.stroke();\n  }\n}\n\ndisplay(`${gridRes}\\u00d7${gridRes} grid \\u00b7 ${nSamples} samples \\u00b7 p=${power} \\u00b7 range [${vmin.toFixed(3)}, ${vmax.toFixed(3)}]`);" }
    ]
  },
  {
    file: 'example_dashboard.html',
    title: 'data dashboard',
    cells: [
      { type: 'md', code: "# world cities dashboard\n\ndemonstrates **css cells** for custom styling, **html cells** for reactive templates, `table()` for data display, and `textInput()` for filtering." },
      { type: 'css', code: ".dashboard-stat {\n  display: inline-block;\n  padding: 8px 16px;\n  margin: 4px;\n  border: 1px solid var(--border);\n  background: var(--bg2);\n  min-width: 120px;\n  text-align: center;\n}\n.dashboard-stat .value {\n  font-size: 20px;\n  color: var(--accent);\n}\n.dashboard-stat .label {\n  font-size: 9px;\n  letter-spacing: 2px;\n  text-transform: uppercase;\n  color: var(--fg-dim);\n}" },
      { type: 'code', code: "const cities = [\n  { city: \"Tokyo\",         country: \"Japan\",     pop: 37.4,  lat: 35.68,  lon: 139.69 },\n  { city: \"Delhi\",         country: \"India\",     pop: 32.9,  lat: 28.61,  lon: 77.23  },\n  { city: \"Shanghai\",      country: \"China\",     pop: 29.2,  lat: 31.23,  lon: 121.47 },\n  { city: \"S\\u00e3o Paulo\",     country: \"Brazil\",    pop: 22.6,  lat: -23.55, lon: -46.63 },\n  { city: \"Mexico City\",   country: \"Mexico\",    pop: 22.1,  lat: 19.43,  lon: -99.13 },\n  { city: \"Cairo\",         country: \"Egypt\",     pop: 21.8,  lat: 30.04,  lon: 31.24  },\n  { city: \"Dhaka\",         country: \"Bangladesh\",pop: 23.2,  lat: 23.81,  lon: 90.41  },\n  { city: \"Mumbai\",        country: \"India\",     pop: 21.7,  lat: 19.08,  lon: 72.88  },\n  { city: \"Beijing\",       country: \"China\",     pop: 21.5,  lat: 39.90,  lon: 116.41 },\n  { city: \"Osaka\",         country: \"Japan\",     pop: 19.1,  lat: 34.69,  lon: 135.50 },\n  { city: \"New York\",      country: \"USA\",       pop: 18.8,  lat: 40.71,  lon: -74.01 },\n  { city: \"Karachi\",       country: \"Pakistan\",  pop: 16.8,  lat: 24.86,  lon: 67.01  },\n  { city: \"Chongqing\",     country: \"China\",     pop: 16.4,  lat: 29.43,  lon: 106.91 },\n  { city: \"Istanbul\",      country: \"Turkey\",    pop: 15.6,  lat: 41.01,  lon: 28.98  },\n  { city: \"Buenos Aires\",  country: \"Argentina\", pop: 15.4,  lat: -34.60, lon: -58.38 },\n  { city: \"Lagos\",         country: \"Nigeria\",   pop: 15.3,  lat: 6.52,   lon: 3.38   },\n  { city: \"Kolkata\",       country: \"India\",     pop: 15.1,  lat: 22.57,  lon: 88.36  },\n  { city: \"Manila\",        country: \"Philippines\",pop: 14.4, lat: 14.60,  lon: 120.98 },\n  { city: \"Guangzhou\",     country: \"China\",     pop: 13.9,  lat: 23.13,  lon: 113.26 },\n  { city: \"Rio de Janeiro\",country: \"Brazil\",    pop: 13.6,  lat: -22.91, lon: -43.17 }\n];" },
      { type: 'code', code: "// controls\nconst search = textInput(\"search\", \"\");\nconst topN = slider(\"show top\", 20, { min: 5, max: 20, step: 1 });\nconst hemisphere = dropdown(\"hemisphere\", [\"all\", \"northern\", \"southern\"]);" },
      { type: 'code', code: "// filter\nconst term = search.toLowerCase();\nconst filtered = cities\n  .filter(c => {\n    if (term && !c.city.toLowerCase().includes(term) && !c.country.toLowerCase().includes(term)) return false;\n    if (hemisphere === \"northern\" && c.lat < 0) return false;\n    if (hemisphere === \"southern\" && c.lat >= 0) return false;\n    return true;\n  })\n  .slice(0, topN);\nconst totalPop = filtered.reduce((s, c) => s + c.pop, 0);\nconst avgLat = filtered.length ? (filtered.reduce((s, c) => s + c.lat, 0) / filtered.length) : 0;\nconst nCountries = new Set(filtered.map(c => c.country)).size;" },
      { type: 'html', code: "<div style=\"margin:8px 0\">\n  <div class=\"dashboard-stat\"><div class=\"value\">${filtered.length}</div><div class=\"label\">cities</div></div>\n  <div class=\"dashboard-stat\"><div class=\"value\">${nCountries}</div><div class=\"label\">countries</div></div>\n  <div class=\"dashboard-stat\"><div class=\"value\">${totalPop.toFixed(1)}M</div><div class=\"label\">total pop</div></div>\n  <div class=\"dashboard-stat\"><div class=\"value\">${avgLat.toFixed(1)}&deg;</div><div class=\"label\">avg latitude</div></div>\n</div>" },
      { type: 'code', code: "table(filtered, [\"city\", \"country\", \"pop\", \"lat\", \"lon\"]);" }
    ]
  },
  {
    file: 'example_modules.html',
    title: 'module playground',
    cells: [
      { type: 'md', code: "# module playground\n\ndemonstrates `install()` for offline-capable module embedding and `load()` for on-demand imports. after saving, installed modules work without a network connection." },
      { type: 'code', code: "// install() fetches the module source and embeds it in the HTML on save.\n// this means the notebook works offline after saving.\nconst { format, formatDistanceToNow } = await install(\"https://esm.sh/date-fns\");" },
      { type: 'code', code: "// load() imports a module at runtime (requires network).\n// useful for modules you don't need offline.\nconst confetti = await load(\"https://esm.sh/canvas-confetti\");" },
      { type: 'code', code: "const dateStyle = dropdown(\"format\", [\"full\", \"short\", \"relative\"]);\nconst sampleDate = textInput(\"date\", \"2024-07-20\");" },
      { type: 'code', code: "const d = new Date(sampleDate);\nlet formatted;\nif (isNaN(d.getTime())) {\n  formatted = \"(invalid date)\";\n} else if (dateStyle === \"full\") {\n  formatted = format(d, \"EEEE, MMMM do, yyyy\");\n} else if (dateStyle === \"short\") {\n  formatted = format(d, \"MM/dd/yy\");\n} else {\n  formatted = formatDistanceToNow(d, { addSuffix: true });\n}\ndisplay(formatted);" },
      { type: 'code', code: "// confetti on demand\nconst fire = checkbox(\"confetti\", false);\nif (fire) confetti.default({ particleCount: 120, spread: 80, origin: { y: 0.7 } });" }
    ]
  }
];

// ── Generate ──
console.log('Generating examples from auditable.html:');
for (const ex of examples) {
  makeExample({
    title: ex.title,
    cells: ex.cells,
    settings: ex.settings || { theme: 'dark', fontSize: 13, width: '860' },
    outPath: path.join(outDir, ex.file)
  });
}
console.log(`Done \u2014 ${examples.length} examples generated.`);
