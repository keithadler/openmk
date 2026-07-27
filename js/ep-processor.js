// OpenMK — SA-synthesis electric piano (GPL-3.0)
// AudioWorklet processor hosting the librdpiano WASM engine.
//
// The emulator produces mono samples at its native rate (20 kHz or 32 kHz
// depending on patch); we linearly interpolate up to the context rate.
// Chorus (Roland "Space D" BBD approximation) runs inside the WASM at the
// native rate, producing stereo, just like the hardware.

const PATCHES = [
  // MKS-20 bank (RD-1000/RD-200 voices)
  { name: 'MKS-20: Piano 1',      romset: 'mks20a', offset: 0x000000, rate: 20000 },
  { name: 'MKS-20: Piano 2',      romset: 'mks20a', offset: 0x008000, rate: 20000 },
  { name: 'MKS-20: Piano 3',      romset: 'mks20a', offset: 0x010000, rate: 20000 },
  { name: 'MKS-20: Harpsichord',  romset: 'mks20b', offset: 0x018000, rate: 32000 },
  { name: 'MKS-20: Clavi',        romset: 'mks20b', offset: 0x003c20, rate: 32000 },
  { name: 'MKS-20: Vibraphone',   romset: 'mks20b', offset: 0x00ab50, rate: 20000 },
  { name: 'MKS-20: E-Piano 1',    romset: 'mks20b', offset: 0x014260, rate: 20000 },
  { name: 'MKS-20: E-Piano 2',    romset: 'mks20b', offset: 0x01bef0, rate: 32000 },
  // MK-80 bank (Rhodes)
  { name: 'MK-80: Classic',       romset: 'mk80',   offset: 0x000020, rate: 20000 },
  { name: 'MK-80: Special',       romset: 'mk80',   offset: 0x008000, rate: 20000 },
  { name: 'MK-80: Blend',         romset: 'mk80',   offset: 0x010000, rate: 20000 },
  { name: 'MK-80: Contemporary',  romset: 'mk80',   offset: 0x018000, rate: 32000 },
  { name: 'MK-80: A. Piano 1',    romset: 'mk80',   offset: 0x002c00, rate: 20000 },
  { name: 'MK-80: A. Piano 2',    romset: 'mk80',   offset: 0x00b1f0, rate: 20000 },
  { name: 'MK-80: Clavi',         romset: 'mk80',   offset: 0x012910, rate: 32000 },
  { name: 'MK-80: Vibraphone',    romset: 'mk80',   offset: 0x0199f0, rate: 20000 },
];

const WAVE_ROM_SIZE = 0x20000;
const PROG_ROM_SIZE = 0x2000;
const RENDER_CHUNK = 4096; // max source samples per process() call

class EpProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.wasm = null;
    this.romPtrs = {};   // romset key -> {ic5, ic6, ic7, ic18} pointers
    this.currentPatch = 8; // MK-80 Classic
    this.srcRate = 20000;

    // resampler state
    this.phase = 1; // force an initial pull
    this.prevL = 0; this.prevR = 0;
    this.curL = 0; this.curR = 0;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        try {
          this.initWasm(msg);
          this.ready = true;
          this.port.postMessage({ type: 'ready', patch: this.currentPatch });
        } catch (err) {
          this.port.postMessage({ type: 'error', message: String(err && err.stack || err) });
        }
        break;
      case 'midi':
        if (this.ready) this.wasm.ep_midi(msg.data[0], msg.data[1], msg.data[2]);
        break;
      case 'patch':
        if (this.ready) this.setPatch(msg.index);
        break;
      case 'chorus':
        if (this.ready) {
          this.wasm.ep_set_chorus(msg.enabled ? 1 : 0, msg.rate, msg.depth);
        }
        break;
      case 'panic':
        if (this.ready) {
          for (let n = 0; n < 128; n++) this.wasm.ep_midi(0x80, n, 0);
          this.wasm.ep_midi(0xB0, 64, 0); // sustain off
        }
        break;
    }
  }

  initWasm(msg) {
    const module = new WebAssembly.Module(msg.wasmBytes);
    const imports = {
      env: {
        emscripten_notify_memory_growth: () => this.refreshViews(),
      },
      wasi_snapshot_preview1: {
        fd_write: (fd, iov, iovcnt, pnum) => {
          // swallow printf output; report 0 bytes written
          if (pnum) new DataView(this.memory.buffer).setUint32(pnum, 0, true);
          return 0;
        },
      },
    };
    const instance = new WebAssembly.Instance(module, imports);
    this.wasm = instance.exports;
    this.memory = this.wasm.memory;
    this.wasm._initialize();

    // Copy all ROM sets into WASM memory once; loadSounds re-reads them on
    // every patch change so they must stay resident.
    const heapWrite = (bytes) => {
      const ptr = this.wasm.ep_alloc(bytes.length);
      new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
      return ptr;
    };

    const progPtr = heapWrite(new Uint8Array(msg.roms.prog, 0, PROG_ROM_SIZE));
    for (const key of ['mks20a', 'mks20b', 'mk80']) {
      const set = msg.roms[key];
      this.romPtrs[key] = {
        ic5: heapWrite(new Uint8Array(set.ic5, 0, WAVE_ROM_SIZE)),
        ic6: heapWrite(new Uint8Array(set.ic6, 0, WAVE_ROM_SIZE)),
        ic7: heapWrite(new Uint8Array(set.ic7, 0, WAVE_ROM_SIZE)),
        ic18: heapWrite(new Uint8Array(set.ic18, 0, WAVE_ROM_SIZE)),
      };
    }

    // Scratch buffers for rendered floats
    this.bufPtrL = this.wasm.ep_alloc(RENDER_CHUNK * 4);
    this.bufPtrR = this.wasm.ep_alloc(RENDER_CHUNK * 4);
    this.refreshViews();

    const boot = this.romPtrs.mk80;
    this.wasm.ep_init(boot.ic5, boot.ic6, boot.ic7, progPtr, boot.ic18);
    this.setPatch(this.currentPatch);
  }

  refreshViews() {
    this.viewL = new Float32Array(this.memory.buffer, this.bufPtrL, RENDER_CHUNK);
    this.viewR = new Float32Array(this.memory.buffer, this.bufPtrR, RENDER_CHUNK);
  }

  setPatch(index) {
    const patch = PATCHES[index];
    if (!patch) return;
    const set = this.romPtrs[patch.romset];
    this.wasm.ep_load_sounds(set.ic5, set.ic6, set.ic7, set.ic18, patch.offset);
    this.currentPatch = index;
    this.srcRate = patch.rate;
    // settle: let the MCU process the program change
    this.wasm.ep_render(this.bufPtrL, this.bufPtrR, RENDER_CHUNK, patch.rate === 32000 ? 1 : 0);
    this.phase = 1;
    this.prevL = this.prevR = this.curL = this.curR = 0;
    this.port.postMessage({ type: 'patchChanged', index });
  }

  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];
    if (!this.ready) {
      outL.fill(0); outR.fill(0);
      return true;
    }

    const n = outL.length;
    const ratio = this.srcRate / sampleRate;
    const mode32 = this.srcRate === 32000 ? 1 : 0;

    // Count how many new source samples this block consumes, render them in
    // one WASM call, then walk the same phase accumulator to interpolate.
    let ph = this.phase;
    let need = 0;
    for (let i = 0; i < n; i++) {
      ph += ratio;
      while (ph >= 1) { ph -= 1; need++; }
    }
    if (need > RENDER_CHUNK) need = RENDER_CHUNK; // paranoia; never hit in practice
    if (need > 0) {
      this.wasm.ep_render(this.bufPtrL, this.bufPtrR, need, mode32);
      if (this.viewL.buffer !== this.memory.buffer) this.refreshViews();
    }

    let k = 0;
    ph = this.phase;
    for (let i = 0; i < n; i++) {
      ph += ratio;
      while (ph >= 1 && k < need) {
        ph -= 1;
        this.prevL = this.curL; this.prevR = this.curR;
        this.curL = this.viewL[k]; this.curR = this.viewR[k];
        k++;
      }
      outL[i] = this.prevL + (this.curL - this.prevL) * ph;
      outR[i] = this.prevR + (this.curR - this.prevR) * ph;
    }
    this.phase = ph;

    return true;
  }
}

registerProcessor('ep-processor', EpProcessor);
