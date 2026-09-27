// Does every MIDI message this page can send actually reach the machine?
//
// openmk shipped a bend wheel and a mod wheel that did nothing for anybody,
// for as long as the project existed. Nothing was broken in the usual sense.
// The page sent 0xE0 and CC 1, and Mcu::sendMidiCmd, which is the only door
// into the emulated board, simply has no branch for either, so both fell off
// the end of an if/else chain and were dropped without a word.
//
// A screenshot could not catch that and neither could playing it, because the
// wheels moved. So this reads both sides and compares them: the statuses the
// UI emits, and the statuses the C++ handles. Emitting something the machine
// drops is the failure.
//
//   node tests/midi_reach.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const pass = (m) => console.log('  ok    ' + m);

// ── what the machine handles ────────────────────────────────────────────────
// Read the body of Mcu::sendMidiCmd and pull out each `command == 0xN` branch,
// noting whether that branch also pins data2 (a specific controller number).
const mcu = read('engine/librdpiano/src/mcu.cpp');
const sig = mcu.indexOf('void Mcu::sendMidiCmd');
if (sig < 0) { fail('Mcu::sendMidiCmd not found; this test is reading the wrong file'); }
let depth = 0, i = mcu.indexOf('{', sig), body = '';
for (; i < mcu.length; i++) {
  const c = mcu[i];
  if (c === '{') depth++;
  if (c === '}' && --depth === 0) break;
  body += c;
}

const handled = new Map();   // high nibble -> Set of allowed data2, or null for "any"
for (const branch of body.split(/else\s+if|\bif\b/).slice(1)) {
  const cond = branch.slice(0, branch.indexOf('{') < 0 ? branch.length : branch.indexOf('{'));
  for (const m of cond.matchAll(/command\s*==\s*(0x[0-9a-fA-F]+)/g)) {
    const hi = parseInt(m[1], 16) << 4;
    const d2 = [...cond.matchAll(/data2\s*==\s*(\d+|0x[0-9a-fA-F]+)/g)].map((x) => Number(x[1]));
    if (!handled.has(hi)) handled.set(hi, d2.length ? new Set(d2) : null);
    else if (handled.get(hi) !== null && d2.length) d2.forEach((v) => handled.get(hi).add(v));
    else handled.set(hi, null);
  }
}

if (handled.size === 0) fail('parsed no handled commands out of sendMidiCmd; the parser is broken, not the code');
else pass(`machine handles: ${[...handled].map(([h, d]) =>
        hex(h) + (d ? ' (data2 ' + [...d].join(',') + ')' : '')).sort().join(', ')}`);

// ── what the page emits ────────────────────────────────────────────────────
// sendMidi(status, d1, d2) in the UI, ep_midi(...) in the worklet. Literal
// hex statuses only; a computed status would need a real parser and there is
// none in this codebase, so assert that too rather than passing quietly.
const sources = ['js/main.js', 'js/ep-processor.js'];
const emitted = [];   // {raw, d1, where}
for (const f of sources) {
  const src = read(f);
  // `const NAME = <number>;` so a named controller resolves instead of being
  // waved through. A name this cannot resolve is a failure, not a pass.
  const consts = new Map();
  for (const c of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(\d+|0x[0-9a-fA-F]+)\s*;/g))
    consts.set(c[1], Number(c[2]));
  const resolve = (t) => (consts.has(t) ? String(consts.get(t)) : t);

  for (const m of src.matchAll(/(\w*\s*)\b(?:sendMidi|ep_midi)\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,/g)) {
    if (m[1].trim() === 'function') continue;   // the declaration, not a call
    const line = src.slice(0, m.index).split('\n').length;
    emitted.push({ raw: resolve(m[2].trim()), d1: resolve(m[3].trim()), where: `${f}:${line}` });
  }
}

if (emitted.length === 0) fail('found no sendMidi/ep_midi call sites; the parser is broken');
else pass(`${emitted.length} call sites in ${sources.join(', ')}`);

for (const e of emitted) {
  if (!/^0x[0-9a-fA-F]{2}$/.test(e.raw)) {
    // st from a MIDI port, forwarded after an explicit type check: fine.
    if (e.raw === 'st' || e.raw === 'msg.data[0]') {
      pass(`${e.where}: forwards a status already filtered upstream`); continue;
    }
    fail(`${e.where}: status "${e.raw}" is not a literal, so this test cannot vouch for it`);
    continue;
  }
  const st = parseInt(e.raw, 16), hi = st & 0xf0;
  if (!handled.has(hi)) {
    fail(`${e.where}: sends ${hex(st)}, which sendMidiCmd has no branch for. It is dropped in silence.`);
    continue;
  }
  const allowed = handled.get(hi);
  if (allowed !== null) {
    const cc = Number(e.d1);
    if (!Number.isInteger(cc)) {
      fail(`${e.where}: sends ${hex(hi)} with a non-literal controller "${e.d1}"; only ${[...allowed].join(',')} are handled`);
    } else if (!allowed.has(cc)) {
      fail(`${e.where}: sends ${hex(hi)} controller ${cc}, but only ${[...allowed].join(',')} reach the machine`);
    } else {
      pass(`${e.where}: ${hex(hi)} controller ${cc} reaches the machine`);
    }
  } else {
    pass(`${e.where}: ${hex(st)} reaches the machine`);
  }
}

// ── the UI must not draw a control the machine cannot use ──────────────────
// The original bug was visible in the markup, not only in the wiring.
const html = read('index.html');
for (const dead of ['pitch-bend-track', 'mod-wheel-track']) {
  if (html.includes(dead)) fail(`index.html still draws #${dead}, which nothing downstream honors`);
  else pass(`index.html draws no #${dead}`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
