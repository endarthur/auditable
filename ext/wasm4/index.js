// @gcu/wasm4 — BUILD OUTPUT (ext/wasm4/build.js). The host engine
// (host.mjs) + the atra rasterizer and demo cart baked as wasm. Do not edit by
// hand — run `node ext/wasm4/build.js` after changing raster.atra / cart-demo.atra
// / host.mjs.

// @gcu/wasm4 — the host engine. Instantiates a WASM-4 cart + the atra
// rasterizer over ONE shared 64 KB memory, wires the `env` API, and runs the
// per-frame tick. Pure: no DOM, and NO atra at runtime — both the cart and the
// rasterizer are pre-compiled `.wasm` bytes (the rasterizer is fixed; carts are
// any conformant module). The browser surface adds canvas present + input on
// top of this; a Node test drives it headless.
//
//   import { createConsole } from './host.mjs';
//   const c = createConsole({ cartBytes, rasterBytes });
//   c.start();
//   c.setGamepad(0, BUTTON_RIGHT);
//   c.frame();                       // clear (unless PRESERVE) → cart.update()
//   c.getPixel(x, y);                // 0..3 framebuffer index
//
// The env is late-bound: the cart is instantiated first to obtain its exported
// memory; the rasterizer then imports that same memory, so every draw op writes
// directly into the shared framebuffer at native speed (SPEC-wasm4 §4).

// ── WASM-4 memory map ──────────────────────────────────────────────────────
export const PALETTE = 0x04;        // 4 × u32  (0x00RRGGBB)
export const DRAW_COLORS = 0x14;    // u16
export const GAMEPADS = 0x16;       // 4 × u8
export const MOUSE_X = 0x1a;        // i16
export const MOUSE_Y = 0x1c;        // i16
export const MOUSE_BUTTONS = 0x1e;  // u8
export const SYSTEM_FLAGS = 0x1f;   // u8
export const FRAMEBUFFER = 0xa0;    // 160×160 @ 2bpp, 40 bytes/row = 6400 bytes
export const FB_BYTES = 6400;
export const SCREEN = 160;
export const FONT_BASE = 0xdc00;    // the rasterizer's font (host-written, reserved)
export const FONT_SHEET_BYTES = 1792;  // 224 glyphs (0x20-0xFF) × 8 rows

// Button bits.
export const BUTTON_1 = 0x01, BUTTON_2 = 0x02;
export const BUTTON_LEFT = 0x10, BUTTON_RIGHT = 0x20, BUTTON_UP = 0x40, BUTTON_DOWN = 0x80;
export const SYSTEM_PRESERVE_FRAMEBUFFER = 0x01;

export function createConsole({ cartBytes, rasterBytes, fontBytes, fontBase = FONT_BASE, onTone }) {
  let raster = null;   // filled in just below; the env closures read it lazily.

  // The drawing half of `env` dispatches to the atra rasterizer. blit/blitSub/
  // text/tone are phase-2 (sprites/font/APU) — stubbed so any cart still runs.
  const env = {
    blit:    (sprite, x, y, w, h, flags) => raster.blit(sprite, x, y, w, h, flags),
    blitSub: (sprite, x, y, w, h, sx, sy, stride, flags) => raster.blitSub(sprite, x, y, w, h, sx, sy, stride, flags),
    line:  (x1, y1, x2, y2) => raster.line(x1, y1, x2, y2),
    hline: (x, y, len) => raster.hline(x, y, len),
    vline: (x, y, len) => raster.vline(x, y, len),
    oval:  (x, y, w, h) => raster.oval(x, y, w, h),
    rect:  (x, y, w, h) => raster.rect(x, y, w, h),
    text:  (strPtr, x, y) => raster.text(strPtr, x, y),
    // Audio is a host concern (WebAudio), not pixel-pushing — forward to the
    // injected sink (the surface passes an @gcu/wasm4 APU's tone). Pure here.
    tone:  (frequency, duration, volume, flags) => { if (onTone) onTone(frequency, duration, volume, flags); },
    diskr: () => 0,
    diskw: () => 0,
    trace() {},
  };

  const cart = new WebAssembly.Instance(new WebAssembly.Module(cartBytes), { env });
  const memory = cart.exports.memory;
  if (!memory || !(memory instanceof WebAssembly.Memory)) {
    throw new Error('wasm4: cart does not export a "memory"');
  }
  // The rasterizer imports the cart's memory (compiled with __memory → env.memory).
  raster = new WebAssembly.Instance(
    new WebAssembly.Module(rasterBytes), { env: { memory } }).exports;

  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);

  // The font lives in a reserved high region (survives frame-clears, which only
  // touch the framebuffer). Written once here; text() blits glyphs from it. The
  // font is inverted (on-pixel = 0 bit), so a zeroed region would draw SOLID
  // blocks — baseline to 0xFF (all-off = blank) before overlaying the real font.
  mem.fill(0xff, fontBase, fontBase + FONT_SHEET_BYTES);
  if (fontBytes) mem.set(fontBytes, fontBase);

  function start() { if (typeof cart.exports.start === 'function') cart.exports.start(); }

  function frame() {
    // The console clears the framebuffer each frame unless the cart opted into
    // SYSTEM_PRESERVE_FRAMEBUFFER (§4).
    if (!(mem[SYSTEM_FLAGS] & SYSTEM_PRESERVE_FRAMEBUFFER)) {
      mem.fill(0, FRAMEBUFFER, FRAMEBUFFER + FB_BYTES);
    }
    if (typeof cart.exports.update === 'function') cart.exports.update();
  }

  return {
    memory,
    exports: cart.exports,
    start,
    frame,
    setGamepad(i, bits) { mem[GAMEPADS + i] = bits & 0xff; },
    setMouse(x, y, buttons) {
      dv.setInt16(MOUSE_X, x | 0, true);
      dv.setInt16(MOUSE_Y, y | 0, true);
      mem[MOUSE_BUTTONS] = buttons & 0xff;
    },
    // 2-bit framebuffer index (0..3) at pixel (x, y).
    getPixel(x, y) {
      return (mem[FRAMEBUFFER + y * 40 + (x >> 2)] >> ((x & 3) * 2)) & 3;
    },
    // Palette entry i (0..3) as 0x00RRGGBB.
    getPalette(i) { return dv.getUint32(PALETTE + i * 4, true) & 0xffffff; },
  };
}

// @gcu/wasm4 — the APU (audio). A faithful-enough WASM-4 synth on WebAudio:
// 4 channels (2 pulse w/ duty cycle, 1 triangle, 1 noise), an ADSR envelope,
// an optional frequency slide, and L/C/R pan. createAPU takes an AudioContext
// (the surface owns it + resumes it on a user gesture); tone() decodes the
// packed WASM-4 args and schedules one note. No DOM beyond AudioContext, so the
// engine stays pure — the surface passes apu.tone as createConsole's onTone.
//
//   tone(frequency, duration, volume, flags)  — the WASM-4 env.tone packing:
//     frequency: freq1 | (freq2 << 16)        (freq2 = slide target, 0 = none)
//     duration:  sustain | release<<8 | decay<<16 | attack<<24   (frames @ 60Hz)
//     volume:    sustain | peak<<8             (0-100; peak defaults 100 if 0)
//     flags:     channel(0-3) | mode<<2 (pulse duty) | pan<<4 (0 C, 1 L, 2 R)

const DUTY = [0.125, 0.25, 0.5, 0.75];

function pulseWave(ctx, duty) {
  // Fourier coefficients of a unit pulse of the given duty cycle.
  const N = 32;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

export function createAPU(ctx, opts = {}) {
  const master = ctx.createGain();
  master.gain.value = opts.master == null ? 0.3 : opts.master;
  master.connect(ctx.destination);

  const waves = DUTY.map((d) => pulseWave(ctx, d));

  let noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    const len = (ctx.sampleRate * 0.5) | 0;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function tone(frequency, duration, volume, flags) {
    const freq1 = frequency & 0xffff;
    const freq2 = (frequency >> 16) & 0xffff;
    const attack = (duration >> 24) & 0xff;
    const decay = (duration >> 16) & 0xff;
    const release = (duration >> 8) & 0xff;
    const sustain = duration & 0xff;
    const peak = ((volume >> 8) & 0xff) || 100;
    const sus = volume & 0xff;
    const channel = flags & 0x3;
    const mode = (flags >> 2) & 0x3;
    const pan = (flags >> 4) & 0x3;

    const F = 1 / 60;
    const aT = attack * F, dT = decay * F, sT = sustain * F, rT = release * F;
    const total = aT + dT + sT + rT;
    if (total <= 0) return;

    const t0 = Math.max(ctx.currentTime, 0);
    let src;
    if (channel === 3) {
      src = ctx.createBufferSource();
      src.buffer = noise();
      src.loop = true;
      // Map the frequency to a playback rate (approximate — WASM-4's noise is an
      // LFSR; white noise resampled is a close-enough game-audio stand-in).
      src.playbackRate.value = Math.min(4, Math.max(0.1, freq1 / 1000));
    } else {
      src = ctx.createOscillator();
      if (channel === 2) src.type = 'triangle';
      else src.setPeriodicWave(waves[mode]);
      src.frequency.setValueAtTime(freq1, t0);
      if (freq2 > 0) src.frequency.linearRampToValueAtTime(freq2, t0 + total);
    }

    const env = ctx.createGain();
    const pv = peak / 100, sv = sus / 100;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(pv, t0 + aT);          // attack → peak
    env.gain.linearRampToValueAtTime(sv, t0 + aT + dT);     // decay → sustain
    env.gain.setValueAtTime(sv, t0 + aT + dT + sT);         // hold sustain
    env.gain.linearRampToValueAtTime(0, t0 + total);        // release → 0

    src.connect(env);
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan === 1 ? -1 : 1;
      env.connect(p);
      p.connect(master);
    } else {
      env.connect(master);
    }
    src.start(t0);
    src.stop(t0 + total + 0.02);
  }

  return {
    tone,
    setMaster(v) { master.gain.value = v; },
    get context() { return ctx; },
  };
}

// ── baked wasm modules (base64) ─────────────────────────────────────────────
export const RASTER_B64 = "AGFzbQEAAAABKgVgA39/fwBgBH9/f38AYAN/f38Bf2AJf39/f39/f39/AGAGf39/f39/AAIPAQNlbnYGbWVtb3J5AgABAwsKAAAAAQEBAgMEAAdQCgVzZXRweAAABWhsaW5lAAEFdmxpbmUAAgRyZWN0AAMEbGluZQAEBG92YWwABQdibGl0X3B4AAYHYmxpdFN1YgAHBGJsaXQACAR0ZXh0AAkKwgoKbQEEfyAAQQBIBEAPCyAAQZ8BSgRADwsgAUEASARADwsgAUGfAUoEQA8LQaABIAFBKGxqIABBAnVqIQMgAEEDcUECbCEEIAMtAAAhBUEDIAR0IQYgBSAGQX9zcSACQQNxIAR0ciEFIAMgBToAAAtDAQN/QRQvAAAhAyADQQ9xIQQgBEEARgRADwsgACEFAkADQCAFIAAgAmpODQEgBSABIARBAWsQACAFQQFqIQUMAAsLC0MBA39BFC8AACEDIANBD3EhBCAEQQBGBEAPCyABIQUCQANAIAUgASACak4NASAAIAUgBEEBaxAAIAVBAWohBQwACwsL4wEBBX9BFC8AACEEIARBD3EhBSAEQQR1QQ9xIQYgBUEARwRAIAEhCAJAA0AgCCABIANqTg0BIAAhBwJAA0AgByAAIAJqTg0BIAcgCCAFQQFrEAAgB0EBaiEHDAALCyAIQQFqIQgMAAsLCyAGQQBHBEAgACEHAkADQCAHIAAgAmpODQEgByABIAZBAWsQACAHIAEgA2pBAWsgBkEBaxAAIAdBAWohBwwACwsgASEIAkADQCAIIAEgA2pODQEgACAIIAZBAWsQACAAIAJqQQFrIAggBkEBaxAAIAhBAWohCAwACwsLC94BAQp/QRQvAAAhBCAEQQ9xIQUgBUEARgRADwsgACEMIAEhDSACIABrIQYgBkEASARAQQAgBmshBgsgAyABayEHIAdBAEgEQEEAIAdrIQcLIAAgAkgEQEEBIQgFQQBBAWshCAsgASADSARAQQEhCQVBAEEBayEJCyAGIAdrIQoCQANAQQFFDQEgDCANIAVBAWsQACAMIAJGBEAgDSADRgRADAMLC0ECIApsIQsgC0EAIAdrSgRAIAogB2shCiAMIAhqIQwLIAsgBkgEQCAKIAZqIQogDSAJaiENCwwACwsLzgEBDX9BFC8AACEEIARBD3EhBSAFIQYgBkEARgRAIARBBHVBD3EhBgsgBkEARgRADwsgAkECbSEJIANBAm0hCiAAIAlqIQcgASAKaiEIIAkgCWwgCmwgCmwhECABIQwCQANAIAwgASADak4NASAAIQsCQANAIAsgACACak4NASALIAdrIQ0gDCAIayEOIA0gDWwgCmwgCmwgDiAObCAJbCAJbGohDyAPIBBMBEAgCyAMIAZBAWsQAAsgC0EBaiELDAALCyAMQQFqIQwMAAsLC0QBBH8gASACbCEDIAAgA0EDdWotAAAhBCADQQdxIQUgAkEBRgRAIARBByAFa3VBAXEhBgUgBEEGIAVrdUEDcSEGCyAGC9oBAQx/IAhBAXFBAWohCSAIQQJxIQogCEEEcSELIAhBCHEhDEEULwAAIQ1BACEOAkADQCAOIARODQFBACEPAkADQCAPIANODQEgACAGIA5qIAdsIAUgD2pqIAkQBiEQIA0gEEEEbHVBD3EhESARQQBHBEAgDyESIA4hEyAKQQBHBEAgA0EBayASayESCyALQQBHBEAgBEEBayATayETCyAMQQBHBEAgEiEUIBMhEiAUIRMLIAEgEmogAiATaiARQQFrEAALIA9BAWohDwwACwsgDkEBaiEODAALCwsWACAAIAEgAiADIARBAEEAIAMgBRAHC30BBH9BACEDIAIhBEEAIQUCQANAQQFFDQEgACAFai0AACEGIAZBAEYEQAwCCyAGQQpGBEBBACEDIARBCGohBAUgBkEgTgRAQYC4AyABIANBCGxqIARBCEEIQQAgBkEga0EIbEEIQQAQBwsgA0EBaiEDCyAFQQFqIQUMAAsLCw==";
export const DEMO_CART_B64 = "AGFzbQEAAAABEQNgBH9/f38AYAN/f38AYAAAAiIDA2VudgRyZWN0AAADZW52BHRleHQAAQNlbnYEdG9uZQAAAwMCAgIFAwEAAQYQA38BQQALfwFBAAt/AUEACwcbAwVzdGFydAADBnVwZGF0ZQAEBm1lbW9yeQIACqgCAlIBAX9BBCEAIABBAEEEbGpBrLjoADYCACAAQQFBBGxqQd3O9AI2AgAgAEECQQRsakHT/MQFNgIAIABBA0EEbGpB1/q9BzYCAEHMACQAQcwAJAEL0gEBAX9BFi0AACEAIABBEHFBAEcEQCMAQQFrJAALIABBIHFBAEcEQCMAQQFqJAALIABBwABxQQBHBEAjAUEBayQBCyAAQYABcUEARwRAIwFBAWokAQsjAEEASARAQQAkAAsjAEGYAUoEQEGYASQACyMBQQBIBEBBACQBCyMBQZgBSgRAQZgBJAELIABBAXFBAEcEQCMCQQFxQQBGBEBBuANBhBBB0ABBABACCwsgACQCQRRBwgA7AAAjACMBQQhBCBAAQRRBBDsAAEGgM0EEQQQQAQsLDAEAQaAzCwVNT1ZFAA==";
export const FONT_B64 = "///////////Hx8fPz//P/5OTk///////kwGTk5MBk//vgy+D6QPv/51bN+/ZtXP/jycnjyUzgf/Pz8////////Pnz8/P5/P/n8/n5+fPn///k8cBx5P////n54Hn5//////////Pz5////+B////////////z8///fv379+/f//Hszk5OZvH/+fH5+fn54H/gznxw4cfAf+B8+fD+TmD/+PDkzMB8/P/Az8D+fk5g//Dnz8DOTmD/wE58+fPz8//hzsbh2F5g/+DOTmB+fOH///Pz//Pz////8/P/8/Pn//z58+fz+fz////Af8B////n8/n8+fPn/+DATnzx//H/4N9RVVBf4P/x5M5OQE5Of8DOTkDOTkD/8OZPz8/mcP/BzM5OTkzB/8BPz8DPz8B/wE/PwM/Pz//wZ8/MTmZwf85OTkBOTk5/4Hn5+fn54H/+fn5+fk5g/85MycPByMx/5+fn5+fn4H/OREBASk5Of85GQkBITE5/4M5OTk5OYP/Azk5OQM/P/+DOTk5ITOF/wM5OTEHIzH/hzM/g/k5g/+B5+fn5+fn/zk5OTk5OYP/OTk5EYPH7/85OSkBARE5/zkRg8eDETn/mZmZw+fn5/8B8ePHjx8B/8PPz8/Pz8P/f7/f7/f7/f+H5+fn5+eH/8eT/////////////////wHv9///////////g/mBOYH/Pz8DOTk5g////4E/Pz+B//n5gTk5OYH///+DOQE/g//x54Hn5+fn////gTk5gfmDPz8DOTk5Of/n/8fn5+eB//P/4/Pz8/OHPz8xAwcjMf/H5+fn5+eB////A0lJSUn///8DOTk5Of///4M5OTmD////Azk5Az8///+BOTmB+fn//5GPn5+f////gz+D+QP/5+eB5+fn5////zk5OTmB////mZmZw+f///9JSUlJgf///zkBxwE5////OTk5gfmD//8B48ePAf/z5+fP5+fz/+fn5+fn5+f/n8/P58/Pn////49F4///////////k5P/gykpESkpg/+DOQkRITmD//////////////////////+DESF9IRGD/4MRCX0JEYP/gxE5VRERg/+DERFVORGD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////5//n58fHx//vgykvKYPv/8OZnwOfnwH//6Xb29ul//+ZmcOB54Hn/+fn5//n5+f/w5mH2+GZw/+T/////////8O9Zl5eZr3Dh8OTw///////yZMnk8n/////gfn5///////////////DvUZaRlq9w4P/////////79fv///////n54Hn5/+B/8fz58P/////w+fzx//////37///////////MzMzMwk/wZW1lcH19f/////Pz/////////////fP58fnw//////Hk5PH//////8nk8mTJ///vTu3rdmxff+9O7ep3btx/x271y3ZsX3/x//HnzkBg//f78eTOQE5//fvx5M5ATn/x5PHkzkBOf/Lp8eTOQE5/5P/x5M5ATn/79fHkzkBOf/BhychBych/8OZPz+Zw/fP3+8BPwM/Af/37wE/Az8B/8eTAT8DPwH/k/8BPwM/Af/v94Hn5+eB//fvgefn54H/58OB5+fngf+Z/4Hn5+eB/4eTmQmZk4f/y6cZCQEhMf/f74M5OTmD//fvgzk5OYP/x5ODOTk5g//Lp4M5OTmD/5P/gzk5OYP//7vX79e7//+DOTEpGTmD/9/vOTk5OYP/9+85OTk5g//Hk/85OTmD/5P/OTk5OYP/9++ZmcPn5/8/Azk5OQM//8OZmZOZiZP/3++D+YE5gf/374P5gTmB/8eTg/mBOYH/y6eD+YE5gf+T/4P5gTmB/+/Xg/mBOYH///+D6YEvg////4E/P4H3z9/vgzkBP4P/9++DOQE/g//Hk4M5AT+D/5P/gzkBP4P/3+//x+fngf/37//H5+eB/8eT/8fn54H/k//H5+fngf+bh2eDOTmD/8unAzk5OTn/3++DOTk5g//374M5OTmD/8eTgzk5OYP/y6eDOTk5g/+T/4M5OTmD///n/4H/5/////+DMSkZg//f7zk5OTmB//fvOTk5OYH/x5P/OTk5gf+T/zk5OTmB//fvOTk5gfmDPz8DOTkDPz+T/zk5OYH5gw==";

export function bytesFromB64(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

export const RASTER_WASM = bytesFromB64(RASTER_B64);
export const DEMO_CART_WASM = bytesFromB64(DEMO_CART_B64);
export const FONT_BYTES = bytesFromB64(FONT_B64);
