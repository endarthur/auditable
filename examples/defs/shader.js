const { workshopCell } = require('../workshop-helpers');

module.exports = {
  file: 'example_shader.html',
  title: 'shader playground',
  _buildModule: { url: './ext/shader/index.js', path: 'ext/shader/index.js' },
  cells: [
    workshopCell('Shader playground', [
      `{
    title: 'Manual cells & glsl tag',
    content: md\`This cell is \\\`// %manual\\\` because the
shader runs a continuous animation loop. Re-running
on every slider drag would destroy and recreate the
WebGL context.

The \\\`glsl\\\` tag from \\\`@auditable/shader\\\` provides
**syntax highlighting** and **completions** for GLSL
code inside the template literal. It\\u2019s a tagged
language extension, like \\\`sql\\\`.\`
  }`,
      `{
    title: 'Real-time uniforms',
    content: md\`The sliders use \\\`onInput\\\` callbacks to
call \\\`s.set(name, value)\\\` directly. This updates
the shader uniform **on the GPU** without recompiling
the shader or re-running the cell.

This is the fastest feedback path: slider event
\\u2192 callback \\u2192 \\\`gl.uniform*()\\\` \\u2192 next frame
renders with new value. No DAG, no scope rebuild,
no JavaScript re-execution.\`
  }`,
      `{
    title: 'Cleanup with invalidation',
    content: md\`\\\`invalidation.then(() => s.destroy())\\\`
ensures the WebGL context and animation loop are
cleaned up before any re-run.

The \\\`shader()\\\` helper manages Shadertoy-compatible
builtins (\\\`iTime\\\`, \\\`iResolution\\\`, \\\`iMouse\\\`) and
the render loop. \\\`s.destroy()\\\` stops the
\\\`requestAnimationFrame\\\` loop and releases GPU
resources. Always pair long-lived resources with
\\\`invalidation\\\`.\`
  }`
    ]),
    { type: 'md', code: "# shader playground\n\na Shadertoy-compatible WebGL 2 shader running in a single cell. the `@auditable/shader` extension injects `iTime`, `iResolution`, `iMouse` and other builtins automatically \u2014 just write `mainImage`. the `glsl` tag provides syntax highlighting and completions inside the template literal.\n\nthe sliders use `onInput` callbacks to update custom uniforms in real time, with zero DAG overhead." },
    { type: 'code', code: "// %manual\nconst { shader, glsl } = await load(\"./ext/shader/index.js\");\n\nconst c = ui.canvas(600, 400);\nconst col = [0.78, 0.61, 0.24];\n\nconst s = shader(c, glsl`\n  void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n    vec2 uv = fragCoord / iResolution.xy;\n    float t = iTime * speed;\n\n    // layered sine waves\n    float r = 0.5 + 0.5 * sin(uv.x * 6.0 + t);\n    float g = 0.5 + 0.5 * sin(uv.y * 6.0 + t * 1.3 + 2.0);\n    float b = 0.5 + 0.5 * sin((uv.x + uv.y) * 4.0 + t * 0.7 + 4.0);\n\n    // mix with custom color\n    vec3 base = vec3(r, g, b);\n    fragColor = vec4(mix(base, color, 0.4), 1.0);\n  }\n`, {\n  uniforms: { speed: 1.0, color: col }\n});\n\nui.slider(\"speed\", 1.0, {min: 0.1, max: 5.0, step: 0.1, onInput: v => s.set(\"speed\", v)});\nui.slider(\"red\",   0.78, {min: 0, max: 1, step: 0.01, onInput: v => { col[0] = v; s.set(\"color\", col); }});\nui.slider(\"green\", 0.61, {min: 0, max: 1, step: 0.01, onInput: v => { col[1] = v; s.set(\"color\", col); }});\nui.slider(\"blue\",  0.24, {min: 0, max: 1, step: 0.01, onInput: v => { col[2] = v; s.set(\"color\", col); }});\n\ninvalidation.then(() => s.destroy());" }
  ]
};
