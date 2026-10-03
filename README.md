# OpenMK

A browser-based SA-synthesis electric piano. No plugins and nothing to install;
supply the ROM images from an instrument you own and it plays in the page.

### ▶ [Play now](https://keithadler.github.io/openmk/)

OpenMK runs the [rdpiano](https://github.com/giulioz/rdpiano) emulator by Giulio Zausa, compiled to WebAssembly inside an AudioWorklet. rdpiano is a silicon-level emulation of the CPU-B board used in the Roland RD-1000, MKS-20, and Rhodes MK-80 digital pianos: the HD6301 microcontroller and the custom SA sound chip, both reverse engineered from decapped chips.

Companion project to [OpenDX7](https://github.com/keithadler/opendx7).

## Sounds

All 16 patches from both machines:

- **MK-80 (Rhodes)**: Classic, Special, Blend, Contemporary, A. Piano 1/2, Clavi, Vibraphone
- **MKS-20 (Roland)**: Piano 1/2/3, Harpsichord, Clavi, Vibraphone, E-Piano 1/2

Plus the Space D stereo chorus (a BBD approximation, same as the rdpiano plugin).

## Playing

- **MIDI**: plug in a keyboard, it just works (Chrome/Edge)
- **Computer keys**: A-L rows play notes, Z-M row plays the lower octave
- **Damper**: hold the pedal in the left strip, or hold the space bar, or use a
  real sustain pedal. LOCK keeps it down.
- **Tune**: the knob beside Volume puts the whole instrument up to a semitone
  sharp or flat, for the out-of-tune sound of a piano nobody has looked after.
  Double-click it to come back to the instrument's own pitch. It is not
  remembered between visits and turns amber whenever it is off pitch, so a
  detuned piano is never a surprise.
- **On-screen**: click the keyboard
- **Tape Echo**: its own unit after the instrument. Time, Repeats, Mix, and
  Wear, which adds the wow, flutter and darkening of an old machine. Switching
  it off lets the echoes already on the tape die away. The Tape Delay preset
  turns it on; Dry turns it off.
- **Chord helper**: the Detected panel names the chord and key and suggests
  where to go next. HIDE puts it away, and the page remembers.

Clicking the drawn keyboard used to make every computer key play two notes:
the keyboard widget has its own key map, and once it had focus it answered too,
one to three octaves below ours. And the space bar stopped working as the
damper after you clicked any button, which you have to do to start the audio.
Both were found by [@Reaper10](https://github.com/Reaper10), and
`tests/page_input.mjs` keeps them fixed.

### There are no wheels, and that is the hardware

The CPU-B board is a sound engine, not a whole instrument. rdpiano gets commands
into it by watching the firmware's program counter and putting a byte on the
internal data bus, and the commands anybody has read off the decapped silicon
are note on, note off, program change and damper. That is the whole vocabulary.

openmk used to draw a bend wheel and a mod wheel anyway. They moved, they sent
0xE0 and CC 1, and `Mcu::sendMidiCmd` has no branch for either, so both fell off
the end of an if/else chain and were discarded without a word. They had never
worked, for anyone. Thanks to [@Reaper10](https://github.com/Reaper10) for
reporting it; he assumed it was his machine, and it was not.

Bending from outside the emulator, by resampling its output, would bend notes
already sounding in a way the instrument cannot, in a project whose only claim
is that it is the instrument. So the wheels are gone and the damper, which the
board really does honor, is what the strip holds. `tests/midi_reach.mjs` reads
both the C++ and the page and fails if the page ever sends something the board
would drop again.

Program change now comes through from a MIDI keyboard too, which the board
always accepted and this page never sent it. And a demo file's CC 7 moves the
master level instead of vanishing, which is why the Gymnopédie used to play
without its dynamics.

### What Tune is, and is not

Tune is a speed control on the sound coming out of the emulator, not a command
to the board, which has no notion of pitch to be given. So it behaves like the
speed knob on a tape machine: pitch moves, and so does the timing of the
instrument's own envelopes, by the same small amount. At a semitone that is
about six percent, and it is audible as the decay being a touch quicker when
sharp.

Bending a note that is already sounding is a different thing and the wheels
could not do it either. Tune is steady, so it is the same on every note.

The worklet refuses anything past a semitone itself rather than trusting the
page. A value large enough would make the resampling ratio infinite, and the
loop that counts samples subtracts one from infinity forever, which would freeze
the audio thread. `tests/tune.mjs` drives the real `process()` with a stub that
streams a clean tone and measures the pitch that comes out, to a fraction of a
cent, at both native rates. Eleven deliberate faults are all caught, including
that one, which is caught by timing out.

## ROMs

**You supply the ROM images, from an instrument you own.** OpenMK ships no ROM
data and downloads none. Drop the files onto the page once and they are kept in
your browser (IndexedDB); they are never uploaded anywhere.

The twelve files are listed on the page when they are missing. They are Roland's
own program and sample data, which is why they are not here and not fetched for
you.

This used to pull them at runtime from another project's repository. OpenMK
still shipped no ROM bytes itself, which was the careful half of it, but
arranging for somebody else to serve Roland's data to every visitor is the same
act at one remove. hexter has always asked you for your own DX7 ROM and
Nuked-MT32 will not start without an MT-32 ROM you already have; this now asks
the same.

## Architecture

```
engine/               C++ sources (vendored librdpiano + Space D chorus + wrapper)
engine/build.sh       emscripten build -> js/rdpiano.wasm
js/ep-processor.js    AudioWorklet: hosts the WASM, resamples 20/32 kHz -> context rate
js/rom-loader.js      user-supplied ROMs + IndexedDB cache
js/main.js            UI wiring, Web MIDI, QWERTY keys, demo player
```

The emulator produces mono samples at the patch's native rate (20 kHz or 32 kHz).
The worklet renders exactly as many source samples as each 128-frame quantum
consumes and linearly interpolates up to the context rate. The chorus runs inside
the WASM at native rate, producing stereo, like the hardware.

## Building the engine

Only needed if you change `engine/`:

```bash
brew install emscripten
./engine/build.sh
```

There is also a native test that renders a chord to WAV without a browser:

```bash
cd engine
c++ -O2 -std=c++17 -Ilibrdpiano/include -Ilsp native_test.cpp wrapper.cpp \
    librdpiano/src/mcu.cpp librdpiano/src/sound_chip.cpp lsp/spaced.cpp \
    -o native_test && ./native_test <roms_dir> out.wav
```

## Running locally

Any static server works:

```bash
python3 -m http.server 8472
```

## Checks

```bash
node tests/midi_reach.mjs
```

It reads `Mcu::sendMidiCmd` for the commands the board handles and the page for
the messages it sends, and fails if the page sends one the board would drop.
CI also puts the old pitch bend back and requires the test to go red, because a
check that cannot fail is not a check.

## License

GPL-3.0 (see LICENSE). Copyright:

- Emulation core (`engine/librdpiano`, `engine/lsp`): Copyright (c) Giulio Zausa,
  from the [rdpiano](https://github.com/giulioz/rdpiano) project, GPL-3.0.
- Web shell (everything else): Copyright (c) 2026 Keith Adler, GPL-3.0.
  Parts adapted from [OpenDX7](https://github.com/keithadler/opendx7) by the
  same author.
- Demo MIDI files (`midi/`): Public Domain, from the
  [Mutopia Project](https://www.mutopiaproject.org/).

Roland and Rhodes are trademarks of their respective owners; this project is
not affiliated with either.
