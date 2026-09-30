// Do the computer keys and the space bar do exactly one thing each?
//
// Two bugs @Reaper10 hit, both invisible to anyone who clicked around:
//
// 1. Clicking the drawn keyboard gives it focus, and webaudio-keyboard has a
//    computer-key map of its own. From then on every letter played two notes,
//    ours and the widget's, one to three octaves apart. The page has its own
//    map, so it must empty the widget's.
//
// 2. The space bar is the damper, but it stood aside whenever a button had
//    focus, and you have to click a button to start the audio at all. So the
//    pedal did nothing, for the rest of the visit, after the first click.
//
//   node tests/page_input.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'js/main.js'), 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const pass = (m) => console.log('  ok    ' + m);

for (const map of ['keycodes1', 'keycodes2']) {
  if (new RegExp(`\\.${map}\\s*=\\s*\\[\\s*\\]`).test(main)) pass(`the widget's ${map} is emptied`);
  else fail(`js/main.js never empties the keyboard widget's ${map}; its keys will double ours`);
}

// Nothing in the damper setup may stand aside for a focused BUTTON.
const damper = main.slice(main.indexOf('function setupDamper'), main.indexOf('async function setupMidi'));
if (!damper.includes("'Space'")) fail('setupDamper has no Space handling; this test is reading the wrong code');
else if (/'BUTTON'/.test(damper)) fail('the space bar still ignores focused buttons, so the pedal dies after the first click');
else pass('Space is the damper even when a button has focus');

// A release during engine start must not be lost: state first, then the wait.
const press = main.match(/async function press\(v\)\s*\{([^}]*)\}/);
if (!press) fail('press(v) not found');
else if (press[1].indexOf('held = v') < press[1].indexOf('await')) pass('press() records the pedal before waiting on the audio');
else fail('press() waits on the audio before recording the pedal; a quick tap can stick it down');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
