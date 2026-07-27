// OpenMK - Standard MIDI File player (GPL-3.0), adapted from OpenDX7
// Copyright (c) 2026 Keith Adler
// Minimal Standard MIDI File player

export class MidiPlayer {
  constructor(noteOn, noteOff, onCC) {
    this.noteOn = noteOn;   // (note, velocity) => void
    this.noteOff = noteOff; // (note) => void
    this.onCC = onCC;       // optional (cc, value) => void — sustain etc.
    this.playing = false;
    this.events = [];
    this._timeout = null;
    this._idx = 0;
    this._startTime = 0;
  }

  async loadUrl(url) {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    this.events = parseMidi(new Uint8Array(buf));
  }

  play() {
    if (this.events.length === 0) return;
    this.stop();
    this.playing = true;
    this._idx = 0;
    this._startTime = performance.now();
    this._scheduleNext();
  }

  stop() {
    this.playing = false;
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    // All notes off, pedal up
    for (let n = 0; n < 128; n++) this.noteOff(n);
    if (this.onCC) this.onCC(64, 0);
  }

  _scheduleNext() {
    if (!this.playing || this._idx >= this.events.length) {
      this.playing = false;
      return;
    }
    const evt = this.events[this._idx];
    const elapsed = performance.now() - this._startTime;
    const delay = Math.max(0, evt.time * 1000 - elapsed);

    this._timeout = setTimeout(() => {
      if (!this.playing) return;
      if (evt.type === 'noteOn') this.noteOn(evt.note, evt.velocity);
      else if (evt.type === 'noteOff') this.noteOff(evt.note);
      else if (evt.type === 'cc' && this.onCC) this.onCC(evt.cc, evt.value);
      this._idx++;
      this._scheduleNext();
    }, delay);
  }
}

// ── Minimal MIDI parser ──
function parseMidi(data) {
  let pos = 0;
  const read = (n) => { const v = data.slice(pos, pos + n); pos += n; return v; };
  const readU16 = () => (data[pos++] << 8) | data[pos++];
  const readU32 = () => (data[pos++] << 24) | (data[pos++] << 16) | (data[pos++] << 8) | data[pos++];
  const readVarLen = () => {
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const b = data[pos++];
      val = (val << 7) | (b & 0x7F);
      if (!(b & 0x80)) break;
    }
    return val;
  };

  // Header
  const hdr = String.fromCharCode(...read(4));
  if (hdr !== 'MThd') throw new Error('Not a MIDI file');
  const hdrLen = readU32();
  const format = readU16();
  const numTracks = readU16();
  const division = readU16();

  const allEvents = [];
  const tempoChanges = []; // { tick, tempo } — microseconds per beat

  for (let t = 0; t < numTracks; t++) {
    const trkHdr = String.fromCharCode(...read(4));
    if (trkHdr !== 'MTrk') { pos += readU32(); continue; }
    const trkLen = readU32();
    const trkEnd = pos + trkLen;

    let tick = 0;
    let runningStatus = 0;

    while (pos < trkEnd) {
      const delta = readVarLen();
      tick += delta;

      let status = data[pos];
      if (status < 0x80) {
        status = runningStatus; // running status
      } else {
        pos++;
        if (status < 0xF0) runningStatus = status;
      }

      const cmd = status & 0xF0;
      const ch = status & 0x0F;

      if (cmd === 0x90) { // Note On
        const note = data[pos++];
        const vel = data[pos++];
        // Channel 10 (index 9) is GM percussion — its "notes" are drum-map keys,
        // not pitches, so skip it rather than play random blips through the synth.
        if (ch !== 9) allEvents.push({ tick, type: vel > 0 ? 'noteOn' : 'noteOff', note, velocity: vel, ch });
      } else if (cmd === 0x80) { // Note Off
        const note = data[pos++];
        pos++; // velocity (ignored)
        if (ch !== 9) allEvents.push({ tick, type: 'noteOff', note, ch });
      } else if (cmd === 0xB0) { // Control Change — keep sustain, skip the rest
        const cc = data[pos++];
        const value = data[pos++];
        if (cc === 64 && ch !== 9) allEvents.push({ tick, type: 'cc', cc, value, ch });
      } else if (cmd === 0xA0 || cmd === 0xE0) {
        pos += 2; // skip 2-byte messages
      } else if (cmd === 0xC0 || cmd === 0xD0) {
        pos += 1; // skip 1-byte messages
      } else if (status === 0xFF) { // Meta event
        const metaType = data[pos++];
        const metaLen = readVarLen();
        if (metaType === 0x51 && metaLen === 3) { // Tempo
          const tempo = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
          tempoChanges.push({ tick, tempo });
        }
        pos += metaLen;
      } else if (status === 0xF0 || status === 0xF7) { // SysEx
        const sysLen = readVarLen();
        pos += sysLen;
      } else {
        // Unknown, try to skip
        break;
      }
    }
    pos = trkEnd;
  }

  // Convert ticks to seconds, honoring the full tempo map.
  const ticksPerBeat = (division & 0x7FFF) || 480;

  // Build a piecewise tempo map: sorted changes, each with the cumulative
  // wall-clock time at which it takes effect. Default 120 BPM before any change.
  tempoChanges.sort((a, b) => a.tick - b.tick);
  const segs = [{ tick: 0, tempo: 500000, time: 0 }];
  for (const tc of tempoChanges) {
    if (tc.tick === 0) { segs[0].tempo = tc.tempo; continue; }
    const last = segs[segs.length - 1];
    const time = last.time + (tc.tick - last.tick) * (last.tempo / 1e6 / ticksPerBeat);
    segs.push({ tick: tc.tick, tempo: tc.tempo, time });
  }

  const tickToSec = (tick) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].tick > tick) i--;
    const s = segs[i];
    return s.time + (tick - s.tick) * (s.tempo / 1e6 / ticksPerBeat);
  };

  allEvents.sort((a, b) => a.tick - b.tick);
  for (const evt of allEvents) {
    evt.time = tickToSec(evt.tick);
  }

  return allEvents;
}
