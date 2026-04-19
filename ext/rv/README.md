# @gcu/rv

RV32IMA RISC-V system emulator. [Atra](https://www.npmjs.com/package/@gcu/atra)-compiled Wasm CPU core + JavaScript host (ELF loader, DTB, UART console, Web Worker wrapper). Capable of booting a Linux kernel. See [SPEC.md](./SPEC.md) for details.

Part of [Auditable](https://github.com/endarthur/auditable).

Pre-1.0 — APIs may break on minor version bumps.

## Install

```sh
npm install @gcu/rv
```

## Usage

```js
import { createMachine } from '@gcu/rv';

const mach = createMachine({ memSize: 64 * 1024 * 1024 });
await mach.loadELF(kernelBytes);
await mach.loadDTB(dtbBytes);
mach.run();
```

Worker variant at sub-path `@gcu/rv/worker` — launch in a Web Worker to keep the main thread responsive.

## License

MIT — see [LICENSE](./LICENSE).
