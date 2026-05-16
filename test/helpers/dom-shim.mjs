// Shared DOM shim for headless adder/natra/scitra/plt tests.
//
// Provides a browser-shaped `globalThis.document`, `window`, and `CSS`
// plus a no-op Canvas 2D context so @gcu/plot calls don't blow up.
// Visual output isn't validated — these tests are for API gaps.

export function installDomShim() {
  function _stubCanvasCtx() {
    const noop = () => {};
    const ctx = {
      canvas: null,
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      save: noop, restore: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop,
      fill: noop, stroke: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
      fillText: noop, strokeText: noop, drawImage: noop,
      measureText: () => ({ width: 0 }),
      setLineDash: noop, getLineDash: () => [],
      translate: noop, rotate: noop, scale: noop, transform: noop, setTransform: noop, resetTransform: noop,
      clip: noop, isPointInPath: () => false, isPointInStroke: () => false,
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createPattern: () => null,
      createImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
      getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
      putImageData: noop,
      quadraticCurveTo: noop, bezierCurveTo: noop,
    };
    return ctx;
  }
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = {
        tagName: tag.toUpperCase(), className: '', dataset: {}, style: {},
        innerHTML: '', textContent: '', children: [],
        src: '', width: 0, height: 0, alt: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      };
      if (tag.toLowerCase() === 'canvas') {
        const ctx = _stubCanvasCtx();
        ctx.canvas = el;
        el.getContext = () => ctx;
        el.toDataURL = () => 'data:image/png;base64,';
        el.toBlob = (cb) => cb(null);
      }
      return el;
    },
    createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
  };
  globalThis.window = globalThis;
  globalThis.CSS = { escape: s => s };
}
