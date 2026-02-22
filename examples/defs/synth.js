const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_synth.html',
  title: 'synth',
  cells: [
    workshopCell('Browser synth', [
      `{
    title: 'Callbacks vs reactive',
    content: md\`This synth uses **callback widgets**
exclusively. Each \\\`ui.slider\\\` and \\\`ui.dropdown\\\`
has an \\\`onInput\\\` callback that fires on every
input event.

With callbacks, dragging a slider calls your function
directly \\u2014 no cell re-run, no DAG traversal, no
scope rebuild. This is essential for real-time audio
where even a few milliseconds of latency matters.\`
  }`,
      `{
    title: 'Manual cells & mutable state',
    content: md\`The \\\`// %manual\\\` directive means this
cell only runs on Ctrl+Enter or Run All \\u2014 never
automatically.

Manual cells can use \\\`let\\\` for mutable state
(\\\`currentWave\\\`, \\\`currentOctave\\\`). Callbacks write
to these variables directly. In a reactive cell,
scope is passed by value so cross-cell mutation
doesn\\u2019t work \\u2014 but within a single manual cell,
it\\u2019s fine.\`
  }`,
      `{
    title: 'Web Audio & invalidation',
    content: md\`The cell creates an \\\`AudioContext\\\` and
oscillator that persist across interactions. The
\\\`invalidation\\\` promise handles cleanup:

\\\`invalidation.then(() => { osc.stop(); audioCtx.close(); })\\\`

This runs just before the cell re-executes, preventing
resource leaks. Every long-lived resource (intervals,
audio contexts, WebSocket connections) should be
cleaned up via \\\`invalidation\\\`.\`
  }`
    ]),
    { type: 'md', code: "# browser synth\n\na synthesizer using the Web Audio API with **callback widgets** for real-time parameter control. the sliders wire directly to audio nodes \u2014 no DAG re-execution, just the browser event loop.\n\nuses `onInput` callbacks on `ui.slider` and `ui.dropdown` so dragging a knob instantly updates the sound without re-running any cells." },
    { type: 'code', code: "// %manual\nconst audioCtx = new (window.AudioContext || window.webkitAudioContext)();\n\n// persistent oscillator + gain for continuous tone\nconst osc = audioCtx.createOscillator();\nconst gainNode = audioCtx.createGain();\nosc.connect(gainNode);\ngainNode.connect(audioCtx.destination);\nosc.frequency.value = 440;\ngainNode.gain.value = 0;\nosc.start();\n\n// mutable state that callbacks update directly\nlet currentWave = \"sine\";\nlet currentOctave = 4;\nlet currentDecay = 0.5;\n\n// callback widgets \u2014 real-time, zero DAG overhead\nui.slider(\"frequency\", 440, {min: 20, max: 2000, step: 1, onInput: v => osc.frequency.value = v});\nui.slider(\"volume\", 0.3, {min: 0, max: 1, step: 0.01, onInput: v => gainNode.gain.value = v});\nui.dropdown(\"waveform\", [\"sine\", \"triangle\", \"sawtooth\", \"square\"], \"sine\", {onInput: v => { osc.type = v; currentWave = v; }});\nui.slider(\"octave\", 4, {min: 2, max: 6, step: 1, onInput: v => currentOctave = v});\nui.slider(\"decay\", 0.5, {min: 0.1, max: 2, step: 0.1, onInput: v => currentDecay = v});\n\n// keyboard for playing notes\nfunction playNote(freq) {\n  const o = audioCtx.createOscillator();\n  const g = audioCtx.createGain();\n  o.type = currentWave;\n  o.frequency.value = freq;\n  g.gain.setValueAtTime(0.3, audioCtx.currentTime);\n  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + currentDecay);\n  o.connect(g);\n  g.connect(audioCtx.destination);\n  o.start();\n  o.stop(audioCtx.currentTime + currentDecay);\n}\n\nfunction noteFreq(semitone, oct) {\n  return 440 * Math.pow(2, (semitone - 9) / 12 + (oct - 4));\n}\n\nconst notes = [\n  [\"C\", 0], [\"C#\", 1], [\"D\", 2], [\"D#\", 3],\n  [\"E\", 4], [\"F\", 5], [\"F#\", 6], [\"G\", 7],\n  [\"G#\", 8], [\"A\", 9], [\"A#\", 10], [\"B\", 11]\n];\n\nconst kb = document.createElement(\"div\");\nkb.style.cssText = \"display:flex;gap:2px;margin:12px 0;flex-wrap:wrap\";\n\nfor (const [name, semi] of notes) {\n  const btn = document.createElement(\"button\");\n  const isSharp = name.includes(\"#\");\n  btn.textContent = name;\n  btn.style.cssText = isSharp\n    ? \"background:#222;color:#c89b3c;border:1px solid #444;padding:20px 8px 40px;font-size:11px;min-width:30px;cursor:pointer;font-family:monospace\"\n    : \"background:#1a1a1a;color:#aaa;border:1px solid #333;padding:20px 12px 40px;font-size:11px;min-width:36px;cursor:pointer;font-family:monospace\";\n  btn.onmousedown = () => {\n    playNote(noteFreq(semi, currentOctave));\n    btn.style.borderColor = \"#c89b3c\";\n  };\n  btn.onmouseup = () => btn.style.borderColor = isSharp ? \"#444\" : \"#333\";\n  btn.onmouseleave = () => btn.style.borderColor = isSharp ? \"#444\" : \"#333\";\n  kb.appendChild(btn);\n}\n\nui.display(kb);\n\n// cleanup on cell invalidation\ninvalidation.then(() => { osc.stop(); audioCtx.close(); });" }
  ]
};
