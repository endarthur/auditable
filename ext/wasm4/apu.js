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
