// OpenMK - chord & key detection (GPL-3.0), shared with OpenDX7
// Copyright (c) 2026 Keith Adler
//
// Detected panel brains: chord naming (exact-set matching with optional
// fifth and slash-chord display), Krumhansl-Kessler key estimation with
// hysteresis, and scale-degree-based next-chord suggestions.

const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Conventional key spellings (F♯ major over G♭, E♭ minor over D♯, ...)
const MAJOR_KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

// Keys whose accidentals are sharps (for spelling chord roots in context)
const SHARP_MAJOR_PCS = new Set([7, 2, 9, 4, 11, 6]);   // G D A E B F♯
const SHARP_MINOR_PCS = new Set([4, 11, 6, 1, 8]);       // e b f♯ c♯ g♯

const activeNotes = new Set();
const recentChords = [];
let idleTimer = null;
let keyIdleTimer = null;
const IDLE_CLEAR_SEC = 8;      // chord history resets after a short pause
const KEY_IDLE_CLEAR_SEC = 45; // the key survives much longer

// Rolling history of every note played (MIDI note + timestamp)
const noteHistory = [];
const KEY_HISTORY_SEC = 30;

// Chord vocabulary: exact interval sets from the root. Ordering matters only
// for ties; scoring prefers the fullest exact match. The fifth (7) may be
// omitted from any chord with four or more tones (shell voicings).
const CHORD_TYPES = [
  { name: '',      iv: [0, 4, 7] },
  { name: 'm',     iv: [0, 3, 7] },
  { name: 'dim',   iv: [0, 3, 6] },
  { name: 'aug',   iv: [0, 4, 8] },
  { name: 'sus4',  iv: [0, 5, 7] },
  { name: 'sus2',  iv: [0, 2, 7] },
  { name: '5',     iv: [0, 7] },
  { name: '6',     iv: [0, 4, 7, 9] },
  { name: 'm6',    iv: [0, 3, 7, 9] },
  { name: '7',     iv: [0, 4, 7, 10] },
  { name: 'maj7',  iv: [0, 4, 7, 11] },
  { name: 'm7',    iv: [0, 3, 7, 10] },
  { name: 'mMaj7', iv: [0, 3, 7, 11] },
  { name: 'dim7',  iv: [0, 3, 6, 9] },
  { name: 'm7♭5',  iv: [0, 3, 6, 10] },
  { name: '7sus4', iv: [0, 5, 7, 10] },
  { name: 'aug7',  iv: [0, 4, 8, 10] },
  { name: 'add9',  iv: [0, 2, 4, 7] },
  { name: 'madd9', iv: [0, 2, 3, 7] },
  { name: '6/9',   iv: [0, 2, 4, 7, 9] },
  { name: '9',     iv: [0, 2, 4, 7, 10] },
  { name: 'maj9',  iv: [0, 2, 4, 7, 11] },
  { name: 'm9',    iv: [0, 2, 3, 7, 10] },
  { name: '7♭9',   iv: [0, 1, 4, 7, 10] },
  { name: '7♯9',   iv: [0, 3, 4, 7, 10] },
  { name: 'm11',   iv: [0, 2, 3, 5, 7, 10] },
  { name: '13',    iv: [0, 2, 4, 7, 9, 10] },
];

// Krumhansl-Kessler key profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// ── Spelling ──────────────────────────────────────────────

// Pick sharp or flat note names from the current key context.
function noteNamesForKey(key) {
  if (!key) return FLAT_NAMES;
  const sharp = key.minor ? SHARP_MINOR_PCS.has(key.root) : SHARP_MAJOR_PCS.has(key.root);
  return sharp ? SHARP_NAMES : FLAT_NAMES;
}

function keyDisplayName(key) {
  if (!key) return null;
  return key.minor
    ? MINOR_KEY_NAMES[key.root] + ' minor'
    : MAJOR_KEY_NAMES[key.root] + ' major';
}

// ── Note history ──────────────────────────────────────────

function recordNoteOn(midiNote) {
  const now = Date.now();
  noteHistory.push({ pc: midiNote % 12, note: midiNote, time: now });
  const cutoff = now - KEY_HISTORY_SEC * 1000;
  while (noteHistory.length > 0 && noteHistory[0].time < cutoff) noteHistory.shift();

  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(clearChordHistory, IDLE_CLEAR_SEC * 1000);
  if (keyIdleTimer) clearTimeout(keyIdleTimer);
  keyIdleTimer = setTimeout(clearHarmonyState, KEY_IDLE_CLEAR_SEC * 1000);
}

function clearChordHistory() {
  recentChords.length = 0;
  const chordEl = document.getElementById('chord-display');
  if (chordEl) chordEl.textContent = '—';
}

function clearHarmonyState() {
  recentChords.length = 0;
  noteHistory.length = 0;
  currentKey = null;
  keySwitchCounter = 0;
  pendingKey = null;
  const keyEl = document.getElementById('key-value');
  const chordEl = document.getElementById('chord-display');
  const nextEl = document.getElementById('next-chords');
  if (keyEl) keyEl.textContent = '—';
  if (chordEl) chordEl.textContent = '—';
  if (nextEl) nextEl.textContent = '—';
}

// ── Chord detection ───────────────────────────────────────
//
// Exact-set matching: every sounded pitch class must be a chord tone, and
// every chord tone must be sounded - except the fifth, which may be omitted
// from 4+ note chords (jazz shell voicings). The fullest match wins; the
// bass note breaks ties toward root position, and inversions display as
// slash chords.

function detectChord(notes, key = currentKey) {
  if (notes.length < 2) return null;
  const sorted = [...notes].sort((a, b) => a - b);
  const bass = sorted[0] % 12;
  const pcs = [...new Set(sorted.map((n) => n % 12))];
  if (pcs.length < 2) return null;

  const names = noteNamesForKey(key);
  let best = null;

  for (const root of pcs) {
    const ivSet = new Set(pcs.map((p) => (p - root + 12) % 12));
    for (const ct of CHORD_TYPES) {
      const required = ct.iv;
      let missingFifth = false;
      let disqualified = false;
      for (const iv of required) {
        if (!ivSet.has(iv)) {
          if (iv === 7 && required.length >= 4) { missingFifth = true; continue; }
          disqualified = true;
          break;
        }
      }
      if (disqualified) continue;
      const matched = required.length - (missingFifth ? 1 : 0);
      const extras = ivSet.size - matched;
      if (extras > 0) continue; // exact: no foreign tones
      if (matched < 2) continue;

      let score = matched * 10 - (missingFifth ? 1 : 0);
      if (root === bass) score += 5; // prefer root position on ties (C6 vs Am7)
      if (best && score <= best.score) continue;
      best = { rootPc: root, bassPc: bass, type: ct.name, score, matched };
    }
  }

  if (!best) return null;
  // Dyads only ever name a power chord; anything else needs 3+ tones.
  if (pcs.length === 2 && best.type !== '5') return null;

  const slash = best.bassPc !== best.rootPc ? '/' + names[best.bassPc] : '';
  return {
    root: names[best.rootPc],
    rootPc: best.rootPc,
    type: best.type,
    label: names[best.rootPc] + best.type + slash,
  };
}

// ── Key detection ─────────────────────────────────────────

function pearsonCorrelation(x, y) {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

let currentKey = null; // { root: pc, minor: bool }
let keySwitchCounter = 0;
let pendingKey = null; // stringified candidate
const KEY_SWITCH_THRESHOLD = 3;
const KEY_HYSTERESIS = 0.06;

function detectKey() {
  if (noteHistory.length < 3) return currentKey;

  const now = Date.now();
  const pcHist = new Float64Array(12);
  for (const entry of noteHistory) {
    const age = (now - entry.time) / 1000;
    const weight = Math.exp(-age / 15);
    pcHist[entry.pc] += weight;
    if (entry.note < 60) pcHist[entry.pc] += weight * 0.5; // bass carries harmony
  }
  for (const n of activeNotes) pcHist[n % 12] += 2.0;
  if (pcHist.every((v) => v === 0)) return currentKey;

  const scores = [];
  for (let root = 0; root < 12; root++) {
    const rotated = new Float64Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = pcHist[(root + i) % 12];
    scores.push({ root, minor: false, corr: pearsonCorrelation(rotated, MAJOR_PROFILE) });
    scores.push({ root, minor: true, corr: pearsonCorrelation(rotated, MINOR_PROFILE) });
  }
  scores.sort((a, b) => b.corr - a.corr);

  const best = scores[0];
  if (best.corr < 0.3) return currentKey;

  if (!currentKey) {
    currentKey = { root: best.root, minor: best.minor };
    return currentKey;
  }

  const sameAsCurrent = best.root === currentKey.root && best.minor === currentKey.minor;
  if (sameAsCurrent) {
    keySwitchCounter = 0;
    pendingKey = null;
    return currentKey;
  }

  const currentCorr = scores.find(
    (s) => s.root === currentKey.root && s.minor === currentKey.minor,
  )?.corr ?? 0;
  const margin = best.corr - currentCorr;
  const bestId = best.root + (best.minor ? 'm' : 'M');
  if (margin > KEY_HYSTERESIS) {
    if (bestId === pendingKey) {
      keySwitchCounter++;
    } else {
      pendingKey = bestId;
      keySwitchCounter = 1;
    }
    if (keySwitchCounter >= KEY_SWITCH_THRESHOLD) {
      currentKey = { root: best.root, minor: best.minor };
      keySwitchCounter = 0;
      pendingKey = null;
    }
  } else {
    keySwitchCounter = Math.max(0, keySwitchCounter - 1);
    if (keySwitchCounter === 0) pendingKey = null;
  }

  return currentKey;
}

// ── Next chord suggestions ────────────────────────────────
//
// The current chord maps to a scale degree by ROOT pitch class, not by
// name, so Cmaj7 / C6 / Cadd9 all count as I in C. Suggestions follow
// common-practice transition tables; when the player is using sevenths,
// the suggestions are spelled as sevenths too. In minor, the dominant is
// suggested as the (harmonic-minor) major V.

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];
const MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10];
const MAJOR_TRIADS = ['', 'm', 'm', '', '', 'm', 'dim'];
const MINOR_TRIADS = ['m', 'dim', '', 'm', '', '', ''];   // V raised to major
const MAJOR_SEVENTHS = ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7♭5'];
const MINOR_SEVENTHS = ['m7', 'm7♭5', 'maj7', 'm7', '7', 'maj7', '7'];

const MAJOR_TRANSITIONS = {
  0: [3, 4, 5], 1: [4, 3, 0], 2: [5, 3, 1], 3: [4, 0, 1],
  4: [0, 5, 3], 5: [3, 1, 4], 6: [0, 5, 3],
};
const MINOR_TRANSITIONS = {
  0: [3, 4, 6], 1: [4, 0, 6], 2: [5, 3, 0], 3: [4, 0, 6],
  4: [0, 5, 3], 5: [3, 6, 4], 6: [0, 5, 3],
};

function suggestNextChords(key, chord) {
  if (!key) return [];
  const names = noteNamesForKey(key);
  const degreePcs = (key.minor ? MINOR_DEGREES : MAJOR_DEGREES).map(
    (d) => (key.root + d) % 12,
  );
  const useSevenths = !!chord && /7|9|11|13/.test(chord.type);
  const qualities = key.minor
    ? (useSevenths ? MINOR_SEVENTHS : MINOR_TRIADS)
    : (useSevenths ? MAJOR_SEVENTHS : MAJOR_TRIADS);
  const spell = (deg) => names[degreePcs[deg]] + qualities[deg];

  let degree = -1;
  if (chord) degree = degreePcs.indexOf(chord.rootPc);
  if (degree < 0) return [spell(0), spell(3), spell(4)];

  const table = key.minor ? MINOR_TRANSITIONS : MAJOR_TRANSITIONS;
  return (table[degree] || [0, 3, 4]).map(spell);
}

// ── Display ───────────────────────────────────────────────

function updateChordDisplay() {
  const notes = [...activeNotes].sort((a, b) => a - b);
  const chordEl = document.getElementById('chord-display');
  const notesEl = document.getElementById('chord-notes');
  const keyEl = document.getElementById('key-value');
  const recentEl = document.getElementById('recent-chords');

  const key = detectKey();
  if (keyEl) keyEl.textContent = keyDisplayName(key) || '—';

  const names = noteNamesForKey(key);
  const noteNames = notes.map((n) => names[n % 12] + Math.floor(n / 12 - 1));

  if (notes.length === 0) {
    if (chordEl) chordEl.textContent = '—';
    if (notesEl) notesEl.innerHTML = '&nbsp;';
    return;
  }
  if (notesEl) notesEl.textContent = noteNames.join(' · ');

  const chord = detectChord(notes, key);
  let shown = null;
  if (chord) {
    shown = chord.label;
  } else if (notes.length === 1) {
    shown = noteNames[0];
  } else {
    shown = noteNames.map((n) => n.replace(/-?\d+$/, '')).join('·');
  }
  if (chordEl) chordEl.textContent = shown;

  if ((chord || notes.length === 1) &&
      (recentChords.length === 0 || recentChords[recentChords.length - 1].str !== shown)) {
    recentChords.push({ str: shown });
    if (recentChords.length > 16) recentChords.shift();
  }

  const suggestions = suggestNextChords(key, chord);
  const nextEl = document.getElementById('next-chords');
  if (nextEl && suggestions.length > 0) {
    const colors = ['#4f4', '#ee4', '#f64'];
    nextEl.innerHTML = suggestions.map((s, i) =>
      `<span class="next-chord" style="color:${colors[i]}">${s}</span>`).join('');
  }

  if (recentEl) {
    recentEl.innerHTML = recentChords.slice(-8).map((c) =>
      `<span class="recent-chord">${c.str}</span>`).join('');
  }
}

export {
  activeNotes, recordNoteOn, updateChordDisplay, clearHarmonyState,
  // exposed for tests
  detectChord, detectKey, suggestNextChords, noteHistory,
};
