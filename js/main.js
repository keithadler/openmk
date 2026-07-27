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
  gainNode.gain.value = parseFloat($('volume-knob').dataset.value) / 100;
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

  // debug/verification handle
  window.__openmk = { get ctx() { return audioCtx; }, get node() { return epNode; }, get gain() { return gainNode; } };

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

const FX_PRESETS = {
  'dry':          { reverbMix: 0,  reverbDecay: 10, delayMix: 0,  delayTime: 200, delayFeedback: 0,  desc: 'No effects. Pure SA output.' },
  'small-room':   { reverbMix: 20, reverbDecay: 12, delayMix: 0,  delayTime: 200, delayFeedback: 0,  desc: 'Tight, intimate room. Great for electric pianos.' },
  'studio':       { reverbMix: 25, reverbDecay: 22, delayMix: 15, delayTime: 340, delayFeedback: 25, desc: 'Balanced reverb + subtle delay. Good for everything.' },
  'concert-hall': { reverbMix: 40, reverbDecay: 45, delayMix: 8,  delayTime: 500, delayFeedback: 20, desc: 'Large hall with long tail. Beautiful for ballads.' },
  'cathedral':    { reverbMix: 55, reverbDecay: 70, delayMix: 5,  delayTime: 600, delayFeedback: 15, desc: 'Massive space with very long decay. Ethereal.' },
  'plate':        { reverbMix: 35, reverbDecay: 18, delayMix: 0,  delayTime: 200, delayFeedback: 0,  desc: 'Classic plate reverb. Bright and smooth.' },
  'slapback':     { reverbMix: 10, reverbDecay: 8,  delayMix: 40, delayTime: 80,  delayFeedback: 10, desc: 'Quick single echo. Rockabilly, vintage keys.' },
  'tape-delay':   { reverbMix: 15, reverbDecay: 15, delayMix: 35, delayTime: 375, delayFeedback: 45, desc: 'Warm repeating echoes like a tape machine.' },
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
      if (k !== 'desc') updateFx(k, v);
    }
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
  setStatus('Loading ROM images...');
  const result = await loadRoms((name, i, total) =>
    setStatus(`Loading ROM images... ${i + 1}/${total} (${name})`));

  if (result.missing.length > 0) {
    setStatus('Some ROM images could not be downloaded.');
    $('rom-missing').textContent = result.missing.join(', ');
    $('rom-drop').hidden = false;
    return false;
  }

  romGroups = groupRoms(result.roms);
  const src = result.fromCache === Object.keys(ROM_FILES).length
    ? 'browser cache' : 'giulioz/rdpiano';
  setStatus(`ROMs ready (${src}). Click or play a key to start the engine.`);
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
// Wheels (pitch bend snaps to center, mod stays)
// ============================================================
function setupWheels() {
  const pbTrack = $('pitch-bend-track'), pbThumb = $('pitch-bend-thumb');
  const mwTrack = $('mod-wheel-track'), mwThumb = $('mod-wheel-thumb');
  let pbDragging = false, mwDragging = false;

  function setPitchBend(norm) {
    const c = Math.max(0, Math.min(1, norm));
    pbThumb.style.bottom = `calc(${c * 100}% - 9px)`;
    pbThumb.style.transform = 'none';
    const v = Math.round(c * 16383);
    sendMidi(0xE0, v & 0x7f, (v >> 7) & 0x7f);
  }
  function setModWheel(norm) {
    const c = Math.max(0, Math.min(1, norm));
    mwThumb.style.bottom = (c * 100) + '%';
    sendMidi(0xB0, 1, Math.round(c * 127));
  }
  const trackY = (track, y) => 1 - (y - track.getBoundingClientRect().top) / track.getBoundingClientRect().height;

  pbTrack.addEventListener('pointerdown', (e) => { pbDragging = true; pbTrack.setPointerCapture(e.pointerId); setPitchBend(trackY(pbTrack, e.clientY)); });
  pbTrack.addEventListener('pointermove', (e) => { if (pbDragging) setPitchBend(trackY(pbTrack, e.clientY)); });
  pbTrack.addEventListener('pointerup', () => { pbDragging = false; setPitchBend(0.5); });
  pbTrack.addEventListener('pointercancel', () => { pbDragging = false; setPitchBend(0.5); });

  mwTrack.addEventListener('pointerdown', (e) => { mwDragging = true; mwTrack.setPointerCapture(e.pointerId); setModWheel(trackY(mwTrack, e.clientY)); });
  mwTrack.addEventListener('pointermove', (e) => { if (mwDragging) setModWheel(trackY(mwTrack, e.clientY)); });
  mwTrack.addEventListener('pointerup', () => { mwDragging = false; });
  mwTrack.addEventListener('pointercancel', () => { mwDragging = false; });
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
        if (type === 0x90 || type === 0x80 || type === 0xB0 || type === 0xE0 || type === 0xD0) {
          await ensureAudio();
          const kbd = $('keyboard');
          if (type === 0x90 && d2 > 0) {
            noteOn(d1, d2);
            kbd?.setNote?.(1, d1);
          } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
            noteOff(d1);
            kbd?.setNote?.(0, d1);
          } else {
            sendMidi(st, d1 || 0, d2 || 0);
          }
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
      setTimeout(() => {
        const t = audioCtx.currentTime;
        dryGain?.gain.setValueAtTime(1.0, t);
        reverbGain?.gain.setValueAtTime(fxState.reverbMix / 100, t);
        delayGain?.gain.setValueAtTime(fxState.delayMix / 100, t);
        delayFbNode?.gain.setValueAtTime(Math.min(0.85, fxState.delayFeedback / 100), t);
      }, 200);
    }
  });

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
    if (el.id === 'volume-knob' && gainNode) {
      gainNode.gain.value = parseFloat(el.dataset.value) / 100;
    } else if (el.id === 'chorus-rate' || el.id === 'chorus-depth') {
      sendChorus();
    }
  });

  midiPlayer = new MidiPlayer(
    (note, vel) => { noteOn(note, vel); kbd?.setNote?.(1, note); },
    (note) => { noteOff(note); kbd?.setNote?.(0, note); },
    (cc, value) => sendMidi(0xB0, cc, value),
  );
  $('demo-select').addEventListener('change', async function () {
    if (!this.value) { midiPlayer.stop(); return; }
    const url = this.value;
    const opt = this.selectedOptions[0];
    this.value = '';
    if (!(await ensureAudio())) return; // no engine yet (ROMs missing / audio failed)
    if (opt?.dataset.patch !== undefined) setPatch(parseInt(opt.dataset.patch, 10));
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
  setupWheels();
  setupQwerty();
  setupRomDrop();
  setupMidi();

  // Keyboard sizing: fill the window width next to the wheel strip
  function resizeKbd() {
    const kbd = $('keyboard');
    const strip = document.querySelector('.perf-strip');
    if (kbd) {
      kbd.width = window.innerWidth - (strip ? strip.offsetWidth : 0);
      kbd.height = 200;
    }
  }
  const waitKbd = setInterval(() => {
    if (customElements.get('webaudio-keyboard')) { clearInterval(waitKbd); resizeKbd(); }
  }, 50);
  setTimeout(resizeKbd, 2000); // fallback
  window.addEventListener('resize', resizeKbd);

  await bootRoms();
});
