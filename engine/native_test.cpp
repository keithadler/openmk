// Native sanity test: boot the emulator with the MK-80 ROM set, play a few
// notes, and write the output to a WAV file. Not part of the web build.
//
//   c++ -O2 -std=c++17 -Ilibrdpiano/include -Ilsp native_test.cpp \
//       librdpiano/src/mcu.cpp librdpiano/src/sound_chip.cpp lsp/spaced.cpp \
//       -o native_test && ./native_test <roms_dir> out.wav

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

extern "C" {
void ep_init(const uint8_t *ic5, const uint8_t *ic6, const uint8_t *ic7,
             const uint8_t *progrom, const uint8_t *ic18);
void ep_load_sounds(const uint8_t *ic5, const uint8_t *ic6, const uint8_t *ic7,
                    const uint8_t *ic18, uint32_t offset);
void ep_midi(uint8_t status, uint8_t d1, uint8_t d2);
void ep_set_chorus(int enabled, int rate, int depth);
void ep_render(float *outL, float *outR, int numSamples, int mode32khz);
}

static std::vector<uint8_t> load_file(const std::string &path, size_t expected) {
  FILE *f = fopen(path.c_str(), "rb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", path.c_str());
    exit(1);
  }
  std::vector<uint8_t> data(expected);
  size_t got = fread(data.data(), 1, expected, f);
  fclose(f);
  if (got != expected) {
    fprintf(stderr, "%s: expected %zu bytes, got %zu\n", path.c_str(), expected, got);
    exit(1);
  }
  return data;
}

static void write_wav(const char *path, const std::vector<int16_t> &samples,
                      int sampleRate) {
  FILE *f = fopen(path, "wb");
  uint32_t dataSize = samples.size() * 2;
  uint32_t chunkSize = 36 + dataSize;
  uint16_t channels = 2, bits = 16;
  uint32_t byteRate = sampleRate * channels * bits / 8;
  uint16_t blockAlign = channels * bits / 8;
  uint16_t fmt = 1;
  uint32_t fmtSize = 16, rate = sampleRate;
  fwrite("RIFF", 1, 4, f); fwrite(&chunkSize, 4, 1, f); fwrite("WAVE", 1, 4, f);
  fwrite("fmt ", 1, 4, f); fwrite(&fmtSize, 4, 1, f); fwrite(&fmt, 2, 1, f);
  fwrite(&channels, 2, 1, f); fwrite(&rate, 4, 1, f); fwrite(&byteRate, 4, 1, f);
  fwrite(&blockAlign, 2, 1, f); fwrite(&bits, 2, 1, f);
  fwrite("data", 1, 4, f); fwrite(&dataSize, 4, 1, f);
  fwrite(samples.data(), 2, samples.size(), f);
  fclose(f);
}

int main(int argc, char **argv) {
  std::string romsDir = argc > 1 ? argv[1] : "roms";
  const char *outPath = argc > 2 ? argv[2] : "out.wav";

  auto ic5 = load_file(romsDir + "/MK80_IC5.bin", 0x20000);
  auto ic6 = load_file(romsDir + "/MK80_IC6.bin", 0x20000);
  auto ic7 = load_file(romsDir + "/MK80_IC7.bin", 0x20000);
  auto ic18 = load_file(romsDir + "/MK80_IC18.bin", 0x20000);
  auto progrom = load_file(romsDir + "/RD200_B.bin", 0x2000);

  ep_init(ic5.data(), ic6.data(), ic7.data(), progrom.data(), ic18.data());
  // MK-80 Classic: params offset 0x20, native rate 20 kHz
  ep_load_sounds(ic5.data(), ic6.data(), ic7.data(), ic18.data(), 0x20);

  const int sampleRate = 20000;
  std::vector<float> bufL(sampleRate), bufR(sampleRate);
  std::vector<int16_t> wav;

  // Let the patch load settle for a second
  ep_render(bufL.data(), bufR.data(), sampleRate, 0);

  // Play a C major chord, one note per half second, hold, release
  int notes[] = {60, 64, 67};
  for (int n = 0; n < 3; n++) {
    ep_midi(0x90, notes[n], 100);
    ep_render(bufL.data(), bufR.data(), sampleRate / 2, 0);
    for (int i = 0; i < sampleRate / 2; i++) {
      wav.push_back((int16_t)(bufL[i] * 32767));
      wav.push_back((int16_t)(bufR[i] * 32767));
    }
  }
  ep_render(bufL.data(), bufR.data(), sampleRate, 0);
  for (int i = 0; i < sampleRate; i++) {
    wav.push_back((int16_t)(bufL[i] * 32767));
    wav.push_back((int16_t)(bufR[i] * 32767));
  }
  for (int n = 0; n < 3; n++) {
    ep_midi(0x80, notes[n], 0);
  }
  ep_render(bufL.data(), bufR.data(), sampleRate, 0);
  for (int i = 0; i < sampleRate; i++) {
    wav.push_back((int16_t)(bufL[i] * 32767));
    wav.push_back((int16_t)(bufR[i] * 32767));
  }

  double rms = 0, peak = 0;
  for (int16_t s : wav) {
    double v = s / 32768.0;
    rms += v * v;
    if (fabs(v) > peak) peak = fabs(v);
  }
  rms = sqrt(rms / wav.size());
  printf("rendered %zu frames, peak %.4f, rms %.4f\n", wav.size() / 2, peak, rms);

  write_wav(outPath, wav, sampleRate);
  printf("wrote %s\n", outPath);
  return peak > 0.01 ? 0 : 3;
}
