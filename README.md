# OpenMK

A browser-based SA-synthesis electric piano. No plugins, no installs - just open and play.

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
- **On-screen**: click the keyboard, drag the bend and mod wheels

## ROMs

OpenMK ships no ROM data. The ROM images are fetched at runtime from the rdpiano
repository and cached in your browser (IndexedDB). If the download fails, the app
shows a drop zone where you can supply the files yourself.

## Architecture

```
engine/               C++ sources (vendored librdpiano + Space D chorus + wrapper)
engine/build.sh       emscripten build -> js/rdpiano.wasm
js/ep-processor.js    AudioWorklet: hosts the WASM, resamples 20/32 kHz -> context rate
js/rom-loader.js      runtime ROM fetch + IndexedDB cache + drop-zone fallback
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
