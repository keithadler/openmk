// OpenMK - UI effects layer (GPL-3.0)
// Publishes the live output level as a CSS variable (--fx-level); the
// stylesheet uses it for brand/LCD/header glow that breathes with the audio.

export function setAudioLevel(rms) {
  const level = Math.min(1, rms * 5);
  document.documentElement.style.setProperty('--fx-level', level.toFixed(3));
}
