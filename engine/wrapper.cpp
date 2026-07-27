// openmk — WASM wrapper around librdpiano (GPL-3.0)
// Exposes a tiny C ABI for the AudioWorklet: init, patch load, MIDI in,
// chorus control, and block rendering to float stereo.

#include <stdint.h>
#include <stdlib.h>

#include "mcu.h"
#include "spaced.h"

static Mcu *mcu = nullptr;
static SpaceD spaceD;
static int chorusEnabled = 0;

// From the RD-1000 front panel: chorus rate positions 1-15 mapped to LFO
// period in ms (see rdpiano_juce PluginProcessor.cpp).
static const int chorusRateToMsPeriod[15] = {2700, 1380, 910, 680, 540,
                                             450,  385,  335, 300, 265,
                                             245,  220,  205, 190, 175};

static void handshake() {
  // MCU handshake as done by the JUCE plugin: program change + master tune,
  // let the CPU run, then re-select the patch.
  mcu->commands_queue.push(0x30);
  mcu->commands_queue.push(0xE0);
  mcu->commands_queue.push(0x00);
  mcu->commands_queue.push(0x00);
  for (int i = 0; i < 1024; i++) {
    mcu->generate_next_sample();
  }
  mcu->commands_queue.push(0x31);
  mcu->commands_queue.push(0x30);
}

extern "C" {

void ep_init(const uint8_t *ic5, const uint8_t *ic6, const uint8_t *ic7,
             const uint8_t *progrom, const uint8_t *ic18) {
  if (mcu) {
    delete mcu;
  }
  mcu = new Mcu(ic5, ic6, ic7, progrom, ic18);
  mcu->reset();
  handshake();
  spaceD.reset();
}

void ep_load_sounds(const uint8_t *ic5, const uint8_t *ic6, const uint8_t *ic7,
                    const uint8_t *ic18, uint32_t offset) {
  mcu->loadSounds(ic5, ic6, ic7, ic18, offset);
  mcu->commands_queue.push(0x31);
  mcu->commands_queue.push(0x30);
}

void ep_midi(uint8_t status, uint8_t d1, uint8_t d2) {
  mcu->sendMidiCmd(status, d1, d2);
}

// rate: 1-15 panel position, depth: 0-15 panel position
void ep_set_chorus(int enabled, int rate, int depth) {
  chorusEnabled = enabled;
  if (rate < 1) rate = 1;
  if (rate > 15) rate = 15;
  if (depth < 0) depth = 0;
  if (depth > 15) depth = 15;
  spaceD.rate = spaceDRateFromMs(1000.0f / chorusRateToMsPeriod[rate - 1] / 4.0f);
  spaceD.depth = spaceDDepth(depth / 15.0f);
}

void ep_render(float *outL, float *outR, int numSamples, int mode32khz) {
  for (int i = 0; i < numSamples; i++) {
    int32_t sample = mcu->generate_next_sample(mode32khz != 0);

    spaceD.audioInL = sample << 5;
    spaceD.audioInR = sample << 5;
    if (chorusEnabled) {
      spaceD.process();
    } else {
      spaceD.audioOutL = spaceD.audioInL;
      spaceD.audioOutR = spaceD.audioInR;
    }

    outL[i] = (float)(spaceD.audioOutL >> 6) / 32768.0f;
    outR[i] = (float)(spaceD.audioOutR >> 6) / 32768.0f;
  }
}

uint8_t *ep_alloc(int size) { return (uint8_t *)malloc(size); }
void ep_free(uint8_t *ptr) { free(ptr); }

} // extern "C"
