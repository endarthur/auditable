# @gcu/shader

Shadertoy-compatible WebGL 2 shader helper. Tagged-template `glsl` + `shader(canvas, code)` with live hot-compile, Shadertoy-style uniforms (`iTime`, `iResolution`, `iMouse`), and automatic vertex/fragment wiring.

Part of [Auditable](https://github.com/gentropic/auditable).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/shader
```

## Usage

```js
import { shader, glsl } from '@gcu/shader';

const canvas = document.querySelector('canvas');
shader(canvas, glsl`
  void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
  }
`);
```

## License

MIT.
