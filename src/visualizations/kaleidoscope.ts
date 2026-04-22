/**
 * Kaleidoscope — N-fold symmetric audio-reactive mandala
 *
 * Seven oscillating polar curves (one per frequency band) are drawn in a
 * source wedge, then mirrored 2×N times around the canvas to form a
 * kaleidoscope. Each band drives its curve's oscillation width; beats snap
 * the hue palette and widen all oscillations. The whole pattern spins.
 *
 * Sliders
 *   Segments   — symmetry fold (3–12); visual fold = 2× this value
 *   Complexity — harmonic layers per wedge (1–4)
 *   Spin Speed — rotation speed (0–3)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// ── constants ────────────────────────────────────────────────────────────────
const CURVE_STEPS = isMobile ? 16 : 28;

// ── module-scoped state ──────────────────────────────────────────────────────
let lastBeatIndex = -1;
let beatPulse = 0;
let hueShift = 0;
let spinAngle = 0;

// ── reset ────────────────────────────────────────────────────────────────────
export function resetKaleidoscope(): void {
  lastBeatIndex = -1;
  beatPulse = 0;
  hueShift = 0;
  spinAngle = 0;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawKaleidoscope(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const idx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeatIndex) {
      lastBeatIndex = idx;
      beatPulse = 1.0;
      hueShift = (hueShift + 30) % 360;
    }
  }
  beatPulse *= Math.pow(0.88, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  hueShift = (hueShift + 0.045 * dt) % 360;

  const numSeg = Math.max(3, Math.round(config.kaleidoscopeSegments));
  const complexity = isMobile
    ? Math.max(1, Math.min(2, Math.round(config.kaleidoscopeComplexity)))
    : Math.max(1, Math.min(4, Math.round(config.kaleidoscopeComplexity)));
  const spinSpeed = config.kaleidoscopeSpinSpeed;

  spinAngle = (spinAngle + spinSpeed * 0.0015 * dt) % (Math.PI * 2);

  const cx = p.width / 2;
  const cy = p.height / 2;
  const maxR = Math.min(p.width, p.height) * 0.48;
  // Each source wedge spans π/numSeg; 2*numSeg copies tile the full circle
  const halfAngle = Math.PI / numSeg;
  const totalSeg = numSeg * 2;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── draw 2·numSeg segments: alternating source + mirror ──────────────────
  for (let i = 0; i < totalSeg; i++) {
    p.push();
    p.translate(cx, cy);
    p.rotate(spinAngle + i * halfAngle);
    if (i % 2 === 1) (p as any).scale(1, -1); // mirror odd segments
    drawWedge(p, amps, maxR, halfAngle, complexity, hueShift, beatPulse);
    p.pop();
  }

  // ── central glow pulsates with sub + bass ─────────────────────────────────
  const centerAmp = amps[0] * 0.6 + amps[1] * 0.4;
  const centerHue = (hueShift + 180) % 360;
  for (let layer = 5; layer >= 1; layer--) {
    const r = layer * (4 + centerAmp * 16 + beatPulse * 12);
    const a = (6 - layer) * 11 + centerAmp * 14 + beatPulse * 10;
    p.noStroke();
    p.fill(centerHue, 50, 100, a);
    p.ellipse(cx, cy, r * 2, r * 2);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

// ── wedge renderer ────────────────────────────────────────────────────────────
// Draws BAND_COUNT oscillating polar curves from the origin within [0, halfAngle].
// Each curve oscillates at frequency (b+1), so it always closes smoothly at r=maxR.
function drawWedge(
  p: P5Instance,
  amps: number[],
  maxR: number,
  halfAngle: number,
  complexity: number,
  hueShift: number,
  beatPulse: number
): void {
  for (let layer = 0; layer < complexity; layer++) {
    const phaseOffset = layer * (Math.PI / Math.max(complexity, 1));
    const layerHueShift = layer * (360 / Math.max(complexity, 2));

    for (let b = 0; b < BAND_COUNT; b++) {
      const amp = amps[b];
      if (amp < 0.018 && beatPulse < 0.07) continue;

      // Oscillation: freq=(b+1) ensures sin(freq*PI)=0 → seamless at outer edge
      const freq = b + 1;
      const oscAmp = halfAngle * (0.22 + amp * 0.78 + beatPulse * 0.18);
      const hue = (hueShift + b * 51 + layerHueShift) % 360;
      const sat = 72 + amp * 28;
      const bri = 52 + amp * 48;

      // ── glow pass (thick, translucent) ─────────────────────────────────
      p.noFill();
      p.stroke(hue, sat, bri, 22 + amp * 28 + beatPulse * 14);
      p.strokeWeight(4 + amp * 10 + beatPulse * 5);
      p.beginShape();
      for (let s = 0; s <= CURVE_STEPS; s++) {
        const t = s / CURVE_STEPS;
        const r = maxR * t;
        const theta = oscAmp * Math.sin(freq * t * Math.PI + phaseOffset);
        p.vertex(r * Math.cos(theta), r * Math.sin(theta));
      }
      p.endShape();

      // ── core pass (thin, bright) ───────────────────────────────────────
      p.stroke(hue, sat - 5, Math.min(100, bri + 22), 55 + amp * 45 + beatPulse * 20);
      p.strokeWeight(0.7 + amp * 2.2);
      p.beginShape();
      for (let s = 0; s <= CURVE_STEPS; s++) {
        const t = s / CURVE_STEPS;
        const r = maxR * t;
        const theta = oscAmp * Math.sin(freq * t * Math.PI + phaseOffset);
        p.vertex(r * Math.cos(theta), r * Math.sin(theta));
      }
      p.endShape();

      // ── tip node ───────────────────────────────────────────────────────
      const tipTheta = oscAmp * Math.sin(freq * Math.PI + phaseOffset);
      const tipR = 2 + amp * maxR * 0.055 + beatPulse * 4;
      p.noStroke();
      p.fill(hue, sat, Math.min(100, bri + 30), 60 + amp * 40);
      p.ellipse(maxR * Math.cos(tipTheta), maxR * Math.sin(tipTheta), tipR * 2, tipR * 2);
    }
  }
}
