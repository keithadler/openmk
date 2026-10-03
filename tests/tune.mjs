// Does the tuning knob actually tune?
//
// This drives the real EpProcessor.process() rather than reading its source. The
// board itself is replaced by a stub that streams a clean 1000 Hz sine at the
// patch's native rate, so what comes out of the other end is the resampler and
// nothing else, and the output pitch can be measured exactly.
//
// Asked for by Reaper10: "a tuning knob, so you could have it deliberately be
// out of tune". It is varispeed on the board's output, never a command to the
// board, which has no notion of pitch to be given. So the thing worth proving is
// that it moves the pitch by the right amount, in the right direction, at both
// native rates, stays inside a semitone whatever it is sent, takes effect, and
// survives changing patch.
//
//   node tests/tune.mjs
//   node tests/tune.mjs path/to/ep-processor.js    (a mutant, for the harness)

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : pathToFileURL(join(here, '..', 'js', 'ep-processor.js')).href;

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const pass = (m) => console.log('  ok    ' + m);
const check = (cond, m) => (cond ? pass(m) : fail(m));

// ---- the world an AudioWorklet module expects --------------------------------
const SAMPLE_RATE = 48000;
globalThis.sampleRate = SAMPLE_RATE;
let Processor = null;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
globalThis.registerProcessor = (name, cls) => { if (name === 'ep-processor') Processor = cls; };

await import(target + '?v=' + Math.random());
if (!Processor) { console.log('ep-processor.js did not register a processor'); process.exit(1); }

// ---- a board that makes one clean tone ---------------------------------------
const SRC_FREQ = 1000;

function makeProcessor(srcRate) {
  const p = new Processor();
  const viewL = new Float32Array(8192), viewR = new Float32Array(8192);
  let srcIndex = 0;
  p.ready = true;
  p.srcRate = srcRate;
  p.viewL = viewL; p.viewR = viewR;
  p.memory = { buffer: viewL.buffer };     // so the worklet sees no reallocation
  p.refreshViews = () => {};
  p.romPtrs = { mk80: { ic5: 0, ic6: 0, ic7: 0, ic18: 0 }, mks20a: {}, mks20b: {} };
  p.wasm = {
    ep_render(_pl, _pr, n) {
      for (let i = 0; i < n; i++) {
        const v = Math.sin(2 * Math.PI * SRC_FREQ * (srcIndex++) / srcRate);
        viewL[i] = v; viewR[i] = v;
      }
    },
    ep_load_sounds() {}, ep_midi() {}, ep_set_chorus() {},
  };
  return p;
}

function run(p, seconds) {
  const frames = 128, blocks = Math.ceil(seconds * SAMPLE_RATE / frames);
  const out = new Float32Array(blocks * frames);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let b = 0; b < blocks; b++) {
    p.process([[]], [[L, R]]);
    out.set(L, b * frames);
  }
  return out;
}

// Pitch from the spacing of positive going zero crossings, interpolated, so the
// answer is good to a small fraction of a cent rather than to the nearest bin.
function pitch(samples) {
  const xs = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      xs.push(i - 1 + (-samples[i - 1]) / (samples[i] - samples[i - 1]));
    }
  }
  if (xs.length < 20) return 0;
  return (xs.length - 1) * SAMPLE_RATE / (xs[xs.length - 1] - xs[0]);
}
const cents = (hz) => 1200 * Math.log2(hz / SRC_FREQ);

function measure(srcRate, tuneCents) {
  const p = makeProcessor(srcRate);
  if (tuneCents !== null) p.handleMessage({ type: 'tune', cents: tuneCents });
  run(p, 0.5);                      // let the glide finish
  return cents(pitch(run(p, 1.0)));
}

// ---- the checks ---------------------------------------------------------------
for (const rate of [20000, 32000]) {
  console.log(`native rate ${rate} Hz`);

  const flat = measure(rate, null);
  check(Math.abs(flat) < 0.5,
    `untouched, the pitch is exactly the board's (${flat.toFixed(3)} cents off)`);

  for (const want of [100, 50, 7, -7, -50, -100]) {
    const got = measure(rate, want);
    check(Math.abs(got - want) < 0.5,
      `${want >= 0 ? '+' : ''}${want} cents lands on ${want >= 0 ? '+' : ''}${want} (measured ${got.toFixed(2)})`);
  }

  // out of range is clamped by the worklet itself, not trusted to the UI
  for (const [asked, limit] of [[5000, 100], [-5000, -100], [1e9, 100]]) {
    const got = measure(rate, asked);
    check(Math.abs(got - limit) < 0.5,
      `asking for ${asked} cents is held to ${limit} (measured ${got.toFixed(2)})`);
  }

  // garbage must not poison the ratio: NaN would silence the instrument
  for (const junk of [NaN, undefined, 'abc', Infinity]) {
    const got = measure(rate, junk);
    check(Number.isFinite(got) && Math.abs(got) <= 100.5,
      `a message carrying ${String(junk)} leaves a usable pitch (measured ${Number.isFinite(got) ? got.toFixed(2) : got})`);
  }
}

console.log('behaviour');
{
  // it takes effect, and promptly: within 100 ms of the message
  const p = makeProcessor(20000);
  run(p, 0.2);
  p.handleMessage({ type: 'tune', cents: 100 });
  run(p, 0.1);
  const soon = cents(pitch(run(p, 0.25)));
  check(soon > 90, `a turn of the knob is audible within a third of a second (${soon.toFixed(1)} of 100 cents)`);

  // and it glides rather than jumping, so turning it does not click
  const q = makeProcessor(20000);
  run(q, 0.2);
  q.handleMessage({ type: 'tune', cents: 100 });
  const first = new Float32Array(128), unused = new Float32Array(128);
  q.process([[]], [[first, unused]]);
  check(q.tuneMul < Math.pow(2, 100 / 1200) - 1e-6,
    'the first block after a turn has not already jumped all the way');

  // it stays put when the sound changes: the instrument is detuned, not the preset
  const r = makeProcessor(20000);
  r.handleMessage({ type: 'tune', cents: -60 });
  run(r, 0.3);
  r.handleMessage({ type: 'patch', index: 8 });
  r.srcRate = 20000;
  run(r, 0.3);
  const after = cents(pitch(run(r, 1.0)));
  check(Math.abs(after - (-60)) < 0.5,
    `changing patch keeps the tuning the player set (measured ${after.toFixed(2)}, wanted -60)`);

  // and coming back to zero returns the board's own pitch exactly
  r.handleMessage({ type: 'tune', cents: 0 });
  run(r, 0.5);
  const home = cents(pitch(run(r, 1.0)));
  check(Math.abs(home) < 0.5, `zero is zero again (${home.toFixed(3)} cents off)`);

  // the output is still a clean tone: a ratio that is wrong in the middle of a
  // block would show up as a second frequency
  const t = makeProcessor(32000);
  t.handleMessage({ type: 'tune', cents: 37 });
  run(t, 0.5);
  const tone = run(t, 0.5);
  let peak = 0;
  for (const v of tone) peak = Math.max(peak, Math.abs(v));
  check(peak > 0.9 && peak < 1.01, `the tone stays full scale and unclipped (peak ${peak.toFixed(3)})`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
