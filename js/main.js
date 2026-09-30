// OpenMK - SA-synthesis electric piano (GPL-3.0)
// UI wiring: audio graph, ROM loading, patch selection, MIDI, keyboard.

import { initKnobs } from './knob.js';
import { MidiPlayer } from './midi-player.js';
import { loadRoms, importRomFiles, groupRoms, ROM_FILES } from './rom-loader.js';
import { activeNotes, recordNoteOn, updateChordDisplay, clearHarmonyState } from './chord-detect.js';
import { setAudioLevel } from './ui-fx.js';

const PATCH_NAMES = [
  'MKS-20: Piano 1', 'MKS-20: Piano 2', 'MKS-20: Piano 3', 'MKS-20: Harpsichord',
  'MKS-20: Clavi', 'MKS-20: Vibraphone', 'MKS-20: E-Piano 1', 'MKS-20: E-Piano 2',
  'MK-80: Classic', 'MK-80: Special', 'MK-80: Blend', 'MK-80: Contemporary',
  'MK-80: A. Piano 1', 'MK-80: A. Piano 2', 'MK-80: Clavi', 'MK-80: Vibraphone',
];
const PATCH_RATES = [20000, 20000, 20000, 32000, 32000, 20000, 20000, 32000,
                     20000, 20000, 20000, 32000, 20000, 20000, 32000, 20000];
const DEFAULT_PATCH = 8; // MK-80 Classic

let audioCtx = null;
let epNode = null;
let gainNode = null;
let playerVolume = 1;   // CC 7 out of a demo file, folded into the knob
let engineReady = false;
let romGroups = null;
let currentPatch = DEFAULT_PATCH;
let chorusOn = false;
let audioInitPromise = null;

// Send-style effects (ported from OpenDX7)
const fxState = { reverbMix: 20, reverbDecay: 12, delayMix: 0, delayTime: 200, delayFeedback: 0 };
let dryGain = null;
let reverbNode = null, reverbGain = null;
let delayNode = null, delayFbNode = null, delayGain = null;
let midiPlayer = null;

// Tape echo: a separate unit after the instrument, like a real one on the floor.
const tapeState = { on: false, time: 330, repeats: 40, mix: 35, wear: 40 };
let tape = null;   // { input, delay, lp, fb, out, wow, flutter } once audio runs

// Output visualizer
let analyser = null, analyserData = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// Audio bootstrap
// ============================================================
async function ensureAudio() {
  if (!romGroups) return false;
  // Single in-flight init: concurrent calls must not build a second graph,
  // and everyone waits for full engine readiness, not just graph creation.
  if (!audioInitPromise) audioInitPromise = initAudioGraph();
  try {
    await audioInitPromise;
  } catch (err) {
    // Tear down so the next gesture can retry cleanly.
    audioInitPromise = null;
    try { audioCtx?.close(); } catch { /* already closed */ }
    audioCtx = null; epNode = null; gainNode = null; engineReady = false;
    setStatus('Audio failed to start: ' + (err?.message || err) + ' - click or play a key to retry.');
    return false;
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return engineReady;
}

async function initAudioGraph() {
  audioCtx = new AudioContext();
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule('js/ep-processor.js');
  epNode = new AudioWorkletNode(audioCtx, 'ep-processor', { outputChannelCount: [2] });

  // Routing (same shape as OpenDX7): epNode -> dryGain -> masterBus, with
  // reverb and delay as sends off epNode merging at masterBus, then a
  // brick-wall limiter, then the volume knob, then out.
  const masterBus = audioCtx.createGain();
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;

  gainNode = audioCtx.createGain();
  applyGain();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyserData = new Float32Array(analyser.fftSize);
  masterBus.connect(limiter).connect(gainNode).connect(analyser).connect(audioCtx.destination);
  startViz();

  dryGain = audioCtx.createGain();
  epNode.connect(dryGain).connect(masterBus);

  try {
    reverbNode = audioCtx.createConvolver();
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = fxState.reverbMix / 100;
    reverbNode.buffer = createReverbIR(fxState.reverbDecay / 10);
    epNode.connect(reverbNode).connect(reverbGain).connect(masterBus);
  } catch (e) { console.warn('Reverb:', e); }

  try {
    delayNode = audioCtx.createDelay(2.0);
    delayNode.delayTime.value = fxState.delayTime / 1000;
    delayFbNode = audioCtx.createGain();
    delayFbNode.gain.value = Math.min(0.85, fxState.delayFeedback / 100);
    delayGain = audioCtx.createGain();
    delayGain.gain.value = fxState.delayMix / 100;
    const lpf = audioCtx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 4000;
    epNode.connect(delayNode).connect(lpf).connect(delayGain).connect(masterBus);
    lpf.connect(delayFbNode).connect(delayNode);
  } catch (e) { console.warn('Delay:', e); }

  try { tape = buildTapeEcho(masterBus); } catch (e) { console.warn('Tape echo:', e); }

  // debug/verification handle
  window.__openmk = { get ctx() { return audioCtx; }, get node() { return epNode; }, get gain() { return gainNode; }, get tape() { return tape; } };

  const engineUp = new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error('engine start timed out')), 20000);
    epNode.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        clearTimeout(bail);
        engineReady = true;
        setPatch(currentPatch);
        sendChorus();
        setStatus('Engine running. Play something.');
        resolve();
      } else if (msg.type === 'error') {
        clearTimeout(bail);
        console.error('[openmk worklet]', msg.message);
        reject(new Error(msg.message));
      }
    };
  });

  const wasmResp = await fetch('js/rdpiano.wasm');
  if (!wasmResp.ok) throw new Error(`rdpiano.wasm: HTTP ${wasmResp.status}`);
  const wasmBytes = await wasmResp.arrayBuffer();
  epNode.port.postMessage({ type: 'init', wasmBytes, roms: romGroups });
  await engineUp;
}

// ============================================================
// Effects (send-style reverb + delay, ported from OpenDX7)
// ============================================================
function createReverbIR(decay) {
  const sr = audioCtx.sampleRate, len = sr * Math.max(0.5, decay);
  const buf = audioCtx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay * 1.2);
  }
  return buf;
}

function updateFx(p, v) {
  fxState[p] = v;
  if (!audioCtx) return;
  if (p === 'reverbMix' && reverbGain) reverbGain.gain.value = v / 100;
  else if (p === 'reverbDecay' && reverbNode) reverbNode.buffer = createReverbIR(v / 10);
  else if (p === 'delayMix' && delayGain) delayGain.gain.value = v / 100;
  else if (p === 'delayTime' && delayNode) delayNode.delayTime.value = v / 1000;
  else if (p === 'delayFeedback' && delayFbNode) delayFbNode.gain.value = Math.min(0.85, v / 100);
}

// ============================================================
// Tape echo
//
// The delay in the presets is a clean digital line with a low-pass on it.
// A tape echo is a different instrument: the loop runs through a record head
// that saturates, a tape that wobbles slowly (wow) and quickly (flutter), and
// a playback path that loses top and bottom on every pass, so each repeat is
// darker, thinner and a little out of tune with the last. That is what this
// builds, entirely after the emulator: the board still only does what the
// silicon does.
//
//   epNode -> input (0 when off) -> delay -> low cut -> high cut -> saturation -> out -> masterBus
//                                     ^                                   |
//                                     +--------------- repeats -----------+
//
// Switching it off closes the input and leaves the loop running, so the
// echoes already on the tape die away instead of stopping dead.
// ============================================================
// Unity gain for quiet signals, so Repeats means what it says: normalizing to
// tanh(k) instead gave the loop a gain of 1.7 and it ran away at half way.
// Loud repeats squash instead of growing, which is the tape.
function saturationCurve(k = 1.6) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / k;
  }
  return curve;
}

function buildTapeEcho(dest) {
  const input = audioCtx.createGain();
  const delay = audioCtx.createDelay(2.0);
  const hp = audioCtx.createBiquadFilter();
  const lp = audioCtx.createBiquadFilter();
  const sat = audioCtx.createWaveShaper();
  const fb = audioCtx.createGain();
  const out = audioCtx.createGain();
  hp.type = 'highpass'; hp.frequency.value = 110; hp.Q.value = 0.5;
  lp.type = 'lowpass';  lp.Q.value = 0.6;
  sat.curve = saturationCurve();
  sat.oversample = '2x';

  // Wow and flutter move the read point, which is what bends the pitch.
  const wow = { osc: audioCtx.createOscillator(), depth: audioCtx.createGain() };
  const flutter = { osc: audioCtx.createOscillator(), depth: audioCtx.createGain() };
  wow.osc.frequency.value = 0.55;
  flutter.osc.frequency.value = 6.8;
  wow.osc.connect(wow.depth).connect(delay.delayTime);
  flutter.osc.connect(flutter.depth).connect(delay.delayTime);
  wow.osc.start(); flutter.osc.start();

  epNode.connect(input).connect(delay).connect(hp).connect(lp).connect(sat).connect(out).connect(dest);
  sat.connect(fb).connect(delay);

  const t = { input, delay, lp, fb, out, wow, flutter };
  applyTape(t, true);
  return t;
}

function applyTape(t = tape, instant = false) {
  if (!t) return;
  const now = audioCtx.currentTime;
  const s = tapeState, w = s.wear / 100;
  const set = (param, v, tc) => instant ? param.setValueAtTime(v, now) : param.setTargetAtTime(v, now, tc);
  set(t.input.gain, s.on ? 1 : 0, 0.01);
  // A real one glides when you move the time: the tape speed changes, not a jump.
  set(t.delay.delayTime, s.time / 1000, 0.12);
  set(t.fb.gain, (s.repeats / 100) * 0.92, 0.02);
  set(t.out.gain, s.mix / 100, 0.02);
  set(t.lp.frequency, 5600 - 3400 * w, 0.02);
  set(t.wow.depth.gain, 0.0002 + 0.0016 * w, 0.05);
  set(t.flutter.depth.gain, 0.00002 + 0.00008 * w, 0.05);
}

function setTapeOn(on) {
  tapeState.on = on;
  const btn = $('tape-btn');
  btn.textContent = on ? 'ON' : 'OFF';
  btn.classList.toggle('active', on);
  applyTape();
}

const TAPE_KNOBS = { 'tape-time': 'time', 'tape-repeats': 'repeats', 'tape-mix': 'mix', 'tape-wear': 'wear' };

const FX_PRESETS = {
  'dry':          { reverbMix: 0,  reverbDecay: 10, delayMix: 0,  delayTime: 200, delayFeedback: 0,  tape: false, desc: 'No effects. Pure SA output.' },
  'small-room':   { reverbMix: 20, reverbDecay: 12, delayMix: 0,  delayTime: 200, delayFeedback: 0,  desc: 'Tight, intimate room. Great for electric pianos.' },
  'studio':       { reverbMix: 25, reverbDecay: 22, delayMix: 15, delayTime: 340, delayFeedback: 25, desc: 'Balanced reverb + subtle delay. Good for everything.' },
  'concert-hall': { reverbMix: 40, reverbDecay: 45, delayMix: 8,  delayTime: 500, delayFeedback: 20, desc: 'Large hall with long tail. Beautiful for ballads.' },
  'cathedral':    { reverbMix: 55, reverbDecay: 70, delayMix: 5,  delayTime: 600, delayFeedback: 15, desc: 'Massive space with very long decay. Ethereal.' },
  'plate':        { reverbMix: 35, reverbDecay: 18, delayMix: 0,  delayTime: 200, delayFeedback: 0,  desc: 'Classic plate reverb. Bright and smooth.' },
  'slapback':     { reverbMix: 10, reverbDecay: 8,  delayMix: 40, delayTime: 80,  delayFeedback: 10, desc: 'Quick single echo. Rockabilly, vintage keys.' },
  'tape-delay':   { reverbMix: 15, reverbDecay: 15, delayMix: 0,  delayTime: 200, delayFeedback: 0,  tape: true, desc: 'Switches on the Tape Echo, with a little room.' },
  'ping-pong':    { reverbMix: 10, reverbDecay: 12, delayMix: 30, delayTime: 250, delayFeedback: 55, desc: 'Rhythmic bouncing echoes. Great for leads.' },
  'ambient':      { reverbMix: 50, reverbDecay: 55, delayMix: 25, delayTime: 500, delayFeedback: 40, desc: 'Lush wash of reverb and delay. Cinematic.' },
  '80s-shimmer':  { reverbMix: 45, reverbDecay: 40, delayMix: 20, delayTime: 440, delayFeedback: 35, desc: 'The iconic 80s sound. Big reverb, rhythmic delay.' },
  'spring':       { reverbMix: 30, reverbDecay: 10, delayMix: 0,  delayTime: 200, delayFeedback: 0,  desc: 'Short, bright spring reverb. Vintage vibe.' },
};

function setupFx() {
  $('fx-preset').addEventListener('change', function () {
    const preset = FX_PRESETS[this.value];
    if (!preset) return;
    for (const [k, v] of Object.entries(preset)) {
      if (k !== 'desc' && k !== 'tape') updateFx(k, v);
    }
    // Only Tape Delay and Dry touch the tape echo; it is its own unit otherwise.
    if (preset.tape !== undefined) setTapeOn(preset.tape);
    $('fx-desc').textContent = preset.desc;
  });
}

function sendMidi(status, d1, d2) {
  if (epNode) epNode.port.postMessage({ type: 'midi', data: [status, d1, d2] });
}

function noteOn(n, v = 100) {
  sendMidi(0x90, n, v);
  activeNotes.add(n);
  recordNoteOn(n);
  updateChordDisplay();
}
function noteOff(n) {
  sendMidi(0x80, n, 0);
  activeNotes.delete(n);
  updateChordDisplay();
}

// ============================================================
// Output visualizer (ported from OpenDX7)
// ============================================================
function drawGrid(ctx, w, h, label) {
  ctx.fillStyle = '#080c14'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#1a2030'; ctx.lineWidth = 0.5;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); ctx.stroke(); }
  for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(w * i / 8, 0); ctx.lineTo(w * i / 8, h); ctx.stroke(); }
  ctx.strokeStyle = '#1a3050'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  ctx.fillStyle = '#2a4060'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
  ctx.fillText(label, 4, 11);
}

let vizOn = false;
function startViz() {
  if (vizOn) return; vizOn = true;
  const wC = $('waveform-canvas');
  if (!wC) return;
  const wX = wC.getContext('2d');

  const dotsEl = $('voice-dots');
  if (dotsEl) {
    dotsEl.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const d = document.createElement('div');
      d.className = 'voice-dot';
      d.id = `vdot-${i}`;
      dotsEl.appendChild(d);
    }
  }

  (function draw() {
    requestAnimationFrame(draw);
    if (!analyser) return;
    const ww = wC.width, wh = wC.height;
    analyser.getFloatTimeDomainData(analyserData);

    drawGrid(wX, ww, wh, 'WAVEFORM');
    wX.strokeStyle = '#4af'; wX.lineWidth = 1.5;
    wX.beginPath();
    let wPeak = 0;
    for (let i = 0; i < analyserData.length; i++) wPeak = Math.max(wPeak, Math.abs(analyserData[i]));
    const wScale = wPeak > 0.001 ? 0.9 / wPeak : 1;
    const wStep = Math.max(1, Math.floor(analyserData.length / ww));
    for (let i = 0; i < ww; i++) {
      const y = (analyserData[i * wStep] * wScale * -0.5 + 0.5) * wh;
      i === 0 ? wX.moveTo(0, y) : wX.lineTo(i, y);
    }
    wX.stroke();

    let pk = 0, rmsSum = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const a = Math.abs(analyserData[i]);
      pk = Math.max(pk, a);
      rmsSum += analyserData[i] * analyserData[i];
    }
    const rmsVal = Math.sqrt(rmsSum / analyserData.length);
    setAudioLevel(rmsVal);
    const pkDb = pk > 0.0001 ? 20 * Math.log10(pk) : -Infinity;
    const rmsDb = rmsVal > 0.0001 ? 20 * Math.log10(rmsVal) : -Infinity;
    $('peak-fill').style.width = Math.min(100, pk * 120) + '%';
    $('rms-fill').style.width = Math.min(100, rmsVal * 200) + '%';
    $('peak-db').textContent = isFinite(pkDb) ? pkDb.toFixed(1) + ' dB' : '-∞ dB';
    $('rms-db').textContent = isFinite(rmsDb) ? rmsDb.toFixed(1) + ' dB' : '-∞ dB';

    const noteCount = activeNotes.size;
    for (let i = 0; i < 16; i++) {
      const dot = $(`vdot-${i}`);
      if (dot) dot.classList.toggle('active', i < noteCount);
    }
  })();
}

function applyGain() {
  if (!gainNode) return;
  const knob = parseFloat($('volume-knob').dataset.value) / 100;
  gainNode.gain.value = knob * playerVolume;
}

function setPatch(index) {
  currentPatch = ((index % 16) + 16) % 16;
  $('patch-select').value = String(currentPatch);
  $('patch-name').textContent = PATCH_NAMES[currentPatch];
  $('rate-display').textContent = (PATCH_RATES[currentPatch] / 1000) + ' kHz';
  if (epNode) epNode.port.postMessage({ type: 'patch', index: currentPatch });
}

function sendChorus() {
  if (!epNode) return;
  epNode.port.postMessage({
    type: 'chorus',
    enabled: chorusOn,
    rate: parseInt($('chorus-rate').dataset.value, 10),
    depth: parseInt($('chorus-depth').dataset.value, 10),
  });
}

function setStatus(text) { $('rom-status').textContent = text; }

// ============================================================
// ROM loading
// ============================================================
async function bootRoms() {
  setStatus('Looking for your ROM images...');
  const result = await loadRoms((name, i, total) =>
    setStatus(`Looking for your ROM images... ${i + 1}/${total} (${name})`));

  if (result.missing.length > 0) {
    const n = result.missing.length;
    setStatus(n === Object.keys(ROM_FILES).length
      ? 'No ROM images yet. Supply them below to start.'
      : `${n} ROM image${n === 1 ? '' : 's'} still needed.`);
    $('rom-missing').textContent = result.missing.join(', ');
    $('rom-drop').hidden = false;
    return false;
  }

  romGroups = groupRoms(result.roms);
  setStatus('ROMs ready, from your browser. Click or play a key to start the engine.');
  return true;
}

function setupRomDrop() {
  const drop = $('rom-drop');
  const input = $('rom-files');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); });
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    await importRomFiles([...e.dataTransfer.files]);
    if (await bootRoms()) drop.hidden = true;
  });
  input.addEventListener('change', async () => {
    await importRomFiles([...input.files]);
    if (await bootRoms()) drop.hidden = true;
  });
}

// ============================================================
// Damper pedal
//
// There used to be a bend wheel and a mod wheel here. They never did
// anything, for anybody, and that is not a bug in the browser or in the
// wiring: the CPU-B board has no wheel input. rdpiano injects commands by
// watching the firmware's program counter and putting a byte on the internal
// data bus, and the only commands anybody has reverse engineered off the
// silicon are note on, note off, program change and damper. Pitch bend and
// CC 1 fell off the end of that if/else chain and were dropped in silence.
//
// Bending it from out here, by resampling the output, would bend notes that
// are already sounding in a way the hardware cannot, in a project whose whole
// claim is that it is the hardware. So the wheels are gone and the damper,
// which the board really does honor, is what the strip holds.
// ============================================================
const DAMPER_CC = 64;
let showDamper = null;   // set by setupDamper; lets a hardware pedal move the drawn one

function setupDamper() {
  const pedal = $('damper-pedal'), lock = $('damper-lock');
  let held = false, locked = false;

  // A hardware pedal moves this one, without echoing the CC back to the engine.
  showDamper = (down) => pedal.setAttribute('aria-pressed', String(down || locked));

  function apply() {
    const down = held || locked;
    if (down === (pedal.getAttribute('aria-pressed') === 'true')) return;
    pedal.setAttribute('aria-pressed', String(down));
    sendMidi(0xB0, DAMPER_CC, down ? 127 : 0);
  }
  // Record the state before waiting on the audio, not after. The other way
  // round, a release that arrived while the engine was starting found the
  // pedal already up and did nothing, and then the late press put it down and
  // left it there: a stuck damper from one quick tap.
  async function press(v) { held = v; if (v) await ensureAudio(); apply(); }

  pedal.addEventListener('pointerdown', async (e) => {
    // Press first. Capture is a convenience, so that sliding off the button
    // still releases, and it must not be able to swallow the pedal if it
    // throws: a stuck-up damper is worse than a missed release.
    await press(true);
    try { pedal.setPointerCapture(e.pointerId); } catch { /* no capture; pointerup still fires */ }
  });
  pedal.addEventListener('pointerup', () => press(false));
  pedal.addEventListener('pointercancel', () => press(false));

  lock.addEventListener('click', async () => {
    locked = !locked;
    lock.setAttribute('aria-pressed', String(locked));
    if (locked) await ensureAudio();
    apply();
  });

  // Space bar is the pedal, the way it is on every other keyboard instrument.
  //
  // It used to stand aside whenever a button had focus, so that Space would
  // not also press the button. But you have to click something to start the
  // audio at all, the pedal and the patch arrows are buttons, and a clicked
  // button keeps focus: after the first click the space bar did nothing, and
  // the pedal looked broken. Now Space is always the pedal, and the button's
  // own Space activation is cancelled instead.
  const typing = (t) => ['SELECT', 'INPUT', 'TEXTAREA'].includes(t.tagName);
  document.addEventListener('keydown', async (e) => {
    if (e.code !== 'Space' || typing(e.target)) return;
    e.preventDefault();
    if (e.repeat) return;
    await press(true);
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || typing(e.target)) return;
    e.preventDefault();
    press(false);
  });
}

// ============================================================
// Web MIDI
// ============================================================
async function setupMidi() {
  if (!navigator.requestMIDIAccess) return;
  try {
    const ma = await navigator.requestMIDIAccess();
    const attach = (port) => {
      port.onmidimessage = async (e) => {
        const [st, d1, d2] = e.data;
        const type = st & 0xf0;

        // Only what the board honors. Bend (0xE0) and aftertouch (0xD0) used to
        // be forwarded here and were then dropped further down, which looked
        // like support and was not any. Leaving them out is the honest version.
        if (type !== 0x90 && type !== 0x80 && type !== 0xB0 && type !== 0xC0) return;

        await ensureAudio();
        const kbd = $('keyboard');

        if (type === 0x90 && d2 > 0) {
          noteOn(d1, d2);
          kbd?.setNote?.(1, d1);
        } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
          noteOff(d1);
          kbd?.setNote?.(0, d1);
        } else if (type === 0xC0) {
          // The board does take program change; this page never sent it one.
          setPatch(d1 & 0x0f);
        } else if (d1 === DAMPER_CC) {
          sendMidi(0xB0, DAMPER_CC, d2);
          showDamper?.(d2 >= 64);
        }
      };
    };
    ma.inputs.forEach(attach);
    ma.onstatechange = (e) => { if (e.port.type === 'input' && e.port.state === 'connected') attach(e.port); };
  } catch { /* no MIDI access; fine */ }
}

// ============================================================
// Computer keyboard
// ============================================================
const KEY_MAP = {
  'a': 60, 'w': 61, 's': 62, 'e': 63, 'd': 64, 'f': 65, 't': 66, 'g': 67,
  'y': 68, 'h': 69, 'u': 70, 'j': 71, 'k': 72, 'o': 73, 'l': 74, 'p': 75,
  ';': 76, "'": 77, 'z': 48, 'x': 50, 'c': 52, 'v': 53, 'b': 55, 'n': 57, 'm': 59,
};
const heldKeys = new Set();

function setupQwerty() {
  document.addEventListener('keydown', async (e) => {
    if (e.repeat || ['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const n = KEY_MAP[e.key.toLowerCase()];
    if (n !== undefined && !heldKeys.has(e.key.toLowerCase())) {
      heldKeys.add(e.key.toLowerCase());
      await ensureAudio();
      if (!heldKeys.has(e.key.toLowerCase())) return; // released while booting
      noteOn(n);
      $('keyboard')?.setNote?.(1, n);
    }
  });
  document.addEventListener('keyup', (e) => {
    const n = KEY_MAP[e.key.toLowerCase()];
    if (n !== undefined) {
      heldKeys.delete(e.key.toLowerCase());
      noteOff(n);
      $('keyboard')?.setNote?.(0, n);
    }
  });
  // Losing focus swallows keyup events; release everything or notes stick.
  window.addEventListener('blur', () => {
    for (const k of [...heldKeys]) {
      heldKeys.delete(k);
      const n = KEY_MAP[k];
      if (n !== undefined) {
        noteOff(n);
        $('keyboard')?.setNote?.(0, n);
      }
    }
  });
}

// ============================================================
// Wiring
// ============================================================
function setupUi() {
  const sel = $('patch-select');
  PATCH_NAMES.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.value = String(DEFAULT_PATCH);
  $('patch-name').textContent = PATCH_NAMES[DEFAULT_PATCH];

  sel.addEventListener('change', async () => { await ensureAudio(); setPatch(parseInt(sel.value, 10)); });
  $('patch-prev').addEventListener('click', async () => { await ensureAudio(); setPatch(currentPatch - 1); });
  $('patch-next').addEventListener('click', async () => { await ensureAudio(); setPatch(currentPatch + 1); });
  $('panic-btn').addEventListener('click', () => {
    midiPlayer?.stop();
    epNode?.port.postMessage({ type: 'panic' });
    activeNotes.clear();
    clearHarmonyState();
    updateChordDisplay();
    const kbd = $('keyboard');
    if (kbd?.setNote) for (let n = 21; n <= 108; n++) kbd.setNote(0, n);

    // Kill effect tails by momentarily muting everything (same as OpenDX7)
    if (audioCtx) {
      const now = audioCtx.currentTime;
      dryGain?.gain.setValueAtTime(0, now);
      reverbGain?.gain.setValueAtTime(0, now);
      delayGain?.gain.setValueAtTime(0, now);
      delayFbNode?.gain.setValueAtTime(0, now);
      if (tape) { tape.fb.gain.cancelScheduledValues(now); tape.fb.gain.setValueAtTime(0, now);
                  tape.out.gain.cancelScheduledValues(now); tape.out.gain.setValueAtTime(0, now); }
      setTimeout(() => {
        const t = audioCtx.currentTime;
        dryGain?.gain.setValueAtTime(1.0, t);
        reverbGain?.gain.setValueAtTime(fxState.reverbMix / 100, t);
        delayGain?.gain.setValueAtTime(fxState.delayMix / 100, t);
        delayFbNode?.gain.setValueAtTime(Math.min(0.85, fxState.delayFeedback / 100), t);
        applyTape(tape, true);
      }, 200);
    }
  });

  $('tape-btn').addEventListener('click', async () => {
    if (!tapeState.on) await ensureAudio();
    setTapeOn(!tapeState.on);
  });

  // The chord helper is for learning; some players only want the instrument.
  const chordPanel = document.querySelector('.chord-panel');
  const chordToggle = $('chord-toggle');
  const showChords = (show) => {
    chordPanel.classList.toggle('collapsed', !show);
    chordToggle.textContent = show ? 'HIDE' : 'SHOW';
    chordToggle.setAttribute('aria-expanded', String(show));
    try { localStorage.setItem('openmk.chords', show ? 'on' : 'off'); } catch { /* private mode */ }
  };
  let chordsStored = null;
  try { chordsStored = localStorage.getItem('openmk.chords'); } catch { /* private mode */ }
  showChords(chordsStored !== 'off');
  chordToggle.addEventListener('click', () => showChords(chordPanel.classList.contains('collapsed')));

  $('chorus-btn').addEventListener('click', () => {
    chorusOn = !chorusOn;
    $('chorus-btn').textContent = chorusOn ? 'ON' : 'OFF';
    $('chorus-btn').classList.toggle('active', chorusOn);
    sendChorus();
  });

  const kbd = $('keyboard');
  kbd.addEventListener('change', async (e) => {
    if (!e.note) return;
    await ensureAudio();
    const [state, note] = e.note;
    if (state) noteOn(note); else noteOff(note);
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('knob')) return;
    if (el.id === 'volume-knob') {
      applyGain();
    } else if (el.id === 'chorus-rate' || el.id === 'chorus-depth') {
      sendChorus();
    } else if (TAPE_KNOBS[el.id]) {
      tapeState[TAPE_KNOBS[el.id]] = parseFloat(el.dataset.value);
      applyTape();
    }
  });

  midiPlayer = new MidiPlayer(
    (note, vel) => { noteOn(note, vel); kbd?.setNote?.(1, note); },
    (note) => { noteOff(note); kbd?.setNote?.(0, note); },
    (cc, value) => {
      // The board honors the damper and nothing else, so the rest of a file's
      // controllers vanish here. CC 7 is worth keeping: it is a mixer level,
      // not a synthesis parameter, and three of the demos automate their
      // dynamics with it. Dropping it was playing the Gymnopedie flat.
      if (cc === DAMPER_CC) { sendMidi(0xB0, DAMPER_CC, value); showDamper?.(value >= 64); }
      else if (cc === 7)    { playerVolume = value / 127; applyGain(); }
    },
  );
  $('demo-select').addEventListener('change', async function () {
    if (!this.value) { midiPlayer.stop(); playerVolume = 1; applyGain(); return; }
    const url = this.value;
    const opt = this.selectedOptions[0];
    this.value = '';
    if (!(await ensureAudio())) return; // no engine yet (ROMs missing / audio failed)
    if (opt?.dataset.patch !== undefined) setPatch(parseInt(opt.dataset.patch, 10));
    playerVolume = 1; applyGain();   // a file that ended mid fade must not quiet the next one
    await midiPlayer.loadUrl(url);
    midiPlayer.play();
  });
}

// ============================================================
// Boot
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  initKnobs();
  setupUi();

  // Idle grid until audio starts
  const wC = $('waveform-canvas');
  if (wC) drawGrid(wC.getContext('2d'), wC.width, wC.height, 'WAVEFORM · play a key');
  setupFx();
  setupDamper();
  setupQwerty();
  setupRomDrop();
  setupMidi();

  // Keyboard sizing: fill the window width next to the pedal strip
  function resizeKbd() {
    const kbd = $('keyboard');
    const strip = document.querySelector('.perf-strip');
    if (kbd) {
      kbd.width = window.innerWidth - (strip ? strip.offsetWidth : 0);
      kbd.height = 200;
    }
  }
  // webaudio-keyboard has a computer-key map of its own (Z S X D ... and
  // Q 2 W 3 ..., from C1) that listens whenever the drawn keyboard has focus,
  // and clicking a key gives it focus. From then on every letter played twice:
  // our note, and another one or two octaves down from the widget. That is the
  // stack of extra notes @Reaper10 saw. The page already has a key map, so the
  // widget's is emptied; its key handlers stay attached and find nothing.
  customElements.whenDefined('webaudio-keyboard').then(() => {
    const kbd = $('keyboard');
    kbd.keycodes1 = [];
    kbd.keycodes2 = [];
  });
  const waitKbd = setInterval(() => {
    if (customElements.get('webaudio-keyboard')) { clearInterval(waitKbd); resizeKbd(); }
  }, 50);
  setTimeout(resizeKbd, 2000); // fallback
  window.addEventListener('resize', resizeKbd);

  await bootRoms();
});
