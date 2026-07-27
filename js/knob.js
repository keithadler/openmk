// OpenMK - SVG arc knob (GPL-3.0), adapted from OpenDX7
// Copyright (c) 2026 Keith Adler
// SVG arc knob — clean, high-DPI, zero dependencies
// Usage: call initKnobs() after DOM ready. Each .knob div becomes an interactive knob.
// Attributes: data-min, data-max, data-value, data-color, data-size

const ARC_START = 0.75 * Math.PI;  // 135°
const ARC_END = 2.25 * Math.PI;    // 405° (= 45°)
const ARC_RANGE = ARC_END - ARC_START;

function polarToXY(cx, cy, r, angle) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const s = polarToXY(cx, cy, r, startAngle);
  const e = polarToXY(cx, cy, r, endAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

function renderKnob(el) {
  const min = parseFloat(el.dataset.min) || 0;
  const max = parseFloat(el.dataset.max) || 99;
  const val = parseFloat(el.dataset.value) || 0;
  const color = el.dataset.color || '#4af';
  const size = parseFloat(el.dataset.size) || 64;

  const norm = (val - min) / (max - min);
  const angle = ARC_START + norm * ARC_RANGE;
  const cx = size / 2, cy = size / 2;
  const stroke = Math.max(2.5, size / 16);
  const r = size / 2 - stroke;
  const dotR = r - stroke * 2;
  const dotSize = Math.max(2, size / 18);
  const innerR = r - stroke * 2.5;

  const dot = polarToXY(cx, cy, dotR, angle);

  el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <path d="${describeArc(cx, cy, r, ARC_START, ARC_END)}"
      fill="none" stroke="#333" stroke-width="${stroke}" stroke-linecap="round"/>
    <path d="${describeArc(cx, cy, r, ARC_START, angle)}"
      fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="1"/>
    <circle cx="${dot.x}" cy="${dot.y}" r="${dotSize}" fill="${color}"/>
  </svg><span class="knob-val">${Math.round(val)}</span>`;

  el.style.width = size + 'px';
  el.style.height = size + 14 + 'px'; // room for value text
}

export function initKnobs() {
  document.querySelectorAll('.knob').forEach(el => {
    // Capture the markup's initial value as the double-click reset target, so
    // center-based knobs (detune 7, transpose 24, pitch EG levels 50, PB range 2)
    // reset to their neutral position instead of their minimum.
    if (el.dataset.default === undefined) el.dataset.default = el.dataset.value || '0';
    renderKnob(el);
    el.style.cursor = 'ns-resize';
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';

    let dragging = false, startY = 0, startVal = 0;

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startVal = parseFloat(el.dataset.value) || 0;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const min = parseFloat(el.dataset.min) || 0;
      const max = parseFloat(el.dataset.max) || 99;
      const range = max - min;
      const sensitivity = range > 20 ? 1.5 : 3; // pixels per unit
      const delta = (startY - e.clientY) / sensitivity;
      const newVal = Math.round(Math.max(min, Math.min(max, startVal + delta)));
      if (newVal !== parseFloat(el.dataset.value)) {
        el.dataset.value = newVal;
        renderKnob(el);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    el.addEventListener('pointerup', () => { dragging = false; });
    el.addEventListener('pointercancel', () => { dragging = false; });

    // Double-click to reset to the knob's default value
    el.addEventListener('dblclick', () => {
      const min = parseFloat(el.dataset.min) || 0;
      el.dataset.value = el.dataset.default !== undefined ? el.dataset.default : min;
      renderKnob(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Scroll wheel support
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const min = parseFloat(el.dataset.min) || 0;
      const max = parseFloat(el.dataset.max) || 99;
      const val = parseFloat(el.dataset.value) || 0;
      const step = e.deltaY < 0 ? 1 : -1;
      const newVal = Math.max(min, Math.min(max, val + step));
      el.dataset.value = newVal;
      renderKnob(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { passive: false });
  });
}

// Set a knob's value programmatically
export function setKnobValue(el, val) {
  if (!el) return;
  el.dataset.value = val;
  renderKnob(el);
}
