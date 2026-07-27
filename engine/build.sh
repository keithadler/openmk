#!/bin/bash
# Build librdpiano + wrapper to a standalone WASM module for the AudioWorklet.
# Requires emscripten (brew install emscripten). Output: js/rdpiano.wasm
set -e
cd "$(dirname "$0")"

em++ -O3 -std=c++17 -Wno-constant-logical-operand \
  -Ilibrdpiano/include -Ilsp \
  wrapper.cpp \
  librdpiano/src/mcu.cpp \
  librdpiano/src/sound_chip.cpp \
  lsp/spaced.cpp \
  --no-entry \
  -s STANDALONE_WASM=1 \
  -s EXPORTED_FUNCTIONS=_ep_init,_ep_load_sounds,_ep_midi,_ep_set_chorus,_ep_render,_ep_alloc,_ep_free \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s STACK_SIZE=2097152 \
  -o ../js/rdpiano.wasm

ls -la ../js/rdpiano.wasm
