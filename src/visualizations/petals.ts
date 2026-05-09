/**
 * Petal Bloom — concentric rings of audio-reactive flower petals
 *
 * 7 petal rings (one per frequency band) radiate from the centre.
 * Each ring rotates at an independent speed (alternating CW/CCW).
 * Band amplitude drives petal size, brightness, and ring radius.
 * A beat pulse causes a full-bloom burst across all rings.
 *
 * Sliders
 *   Petal Count  — number of petals per ring (3–16)
 *   Bloom Scale  — how much amplitude inflates each petal (0.1–2.0)
 *   Spin Speed   — base rotation speed of all rings (0–3)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// ── palette: cherry blossom — single pink hue, per-ring brightness ladder ───
const PETAL_HUE = 340; // cherry pink
const PETAL_HUE_RANGE = 8; // tiny per-ring variation 332–348°

// ── module-scoped state ──────────────────────────────────────────────────────
let lastBeatIndex = -1;
let beatPulse = 0;
const ringRotations: number[] = new Array(BAND_COUNT).fill(0);

// ── reset ────────────────────────────────────────────────────────────────────
export function resetPetals(): void {
  lastBeatIndex = -1;
  beatPulse = 0;
  for (let i = 0; i < BAND_COUNT; i++) ringRotations[i] = 0;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawPetals(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0
      ? Math.floor(adjusted / state.beatIntervalSec)
      : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.88, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  // ── layout ────────────────────────────────────────────────────────────────
  const cx = p.width / 2;
  const cy = p.height / 2;
  const maxDim = Math.min(p.width, p.height);

  const petalCount = Math.max(3, Math.round(config.petalsPetalCount));
  const bloomScale = config.petalsBloomScale;
  const spinSpeed = config.petalsSpinSpeed;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── soft glow halos behind the petals (outermost → innermost) ────────────
  for (let band = 0; band < BAND_COUNT; band++) {
    const amp = amps[band];
    if (amp < 0.04 && beatPulse < 0.1) continue;

    const t = band / (BAND_COUNT - 1);
    const ringRadius = maxDim * (0.09 + t * 0.37);
    const bloomed = ringRadius * (1.0 + amp * bloomScale * 0.35 + beatPulse * 0.1);
    // Inner rings warmer/redder pink (~334°); outer rings cooler pink (~346°).
    const hue = PETAL_HUE + (t - 0.5) * 2 * PETAL_HUE_RANGE;
    // Inner rings (low band index) brightest; outer rings dim more.
    const haloBri = 100 - t * 12;

    p.noFill();
    p.stroke(hue, 55 + amp * 35, haloBri, amp * 28 + beatPulse * 18);
    p.strokeWeight(4 + amp * 14 + beatPulse * 10);
    p.ellipse(cx, cy, bloomed * 2, bloomed * 2);
  }

  // ── petal rings (outermost first so inner rings render on top) ────────────
  for (let band = BAND_COUNT - 1; band >= 0; band--) {
    const amp = amps[band];
    const t = band / (BAND_COUNT - 1);

    // Ring geometry
    const ringRadius = maxDim * (0.09 + t * 0.37);
    const bloomed = ringRadius * (1.0 + amp * bloomScale * 0.35 + beatPulse * 0.1);

    // Per-ring rotation: alternating CW/CCW, higher bands and louder audio spin faster
    const dir = band % 2 === 0 ? 1 : -1;
    ringRotations[band] +=
      dir * spinSpeed * dt * 0.004 * (0.4 + band * 0.12 + amp * 2.0);

    // Petal dimensions scale with amplitude
    const petalLen = bloomed * (0.27 + amp * bloomScale * 0.22 + beatPulse * 0.08);
    const petalW = petalLen * 0.42;

    // Single-hue cherry-pink palette. Brightness ladder: inner rings (band=0)
    // glow brightest, outer rings stay softer — a depth gradient instead of
    // a hue gradient. Amplitude/beat drive sat+brightness, never hue.
    const hue = PETAL_HUE + (t - 0.5) * 2 * PETAL_HUE_RANGE;
    const innerBoost = 1 - t; // 1 at innermost ring, 0 at outermost
    const sat = 38 + amp * 50 + beatPulse * 12; // pastel resting, vivid on hits
    const bri = 60 + innerBoost * 30 + amp * 12 + beatPulse * 8;
    const fillA = 52 + amp * 48;
    const strokeA = 78 + amp * 22;

    for (let i = 0; i < petalCount; i++) {
      const angle = (i / petalCount) * Math.PI * 2 + ringRotations[band];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Perpendicular unit vector (rotated 90°)
      const px = -sin;
      const py = cos;

      // Tip (outer point) and base (inner point)
      const tipX = cx + cos * bloomed;
      const tipY = cy + sin * bloomed;
      const innerR = bloomed - petalLen;
      const baseX = cx + cos * innerR;
      const baseY = cy + sin * innerR;

      // Bezier control points for a symmetric leaf shape
      //  Left side: base → tip
      const pull = petalLen * 0.48;
      const cp1x = baseX + px * petalW + cos * pull;
      const cp1y = baseY + py * petalW + sin * pull;
      const cp2x = tipX + px * petalW * 0.18 - cos * petalLen * 0.08;
      const cp2y = tipY + py * petalW * 0.18 - sin * petalLen * 0.08;
      //  Right side: tip → base (mirror)
      const cp3x = tipX - px * petalW * 0.18 - cos * petalLen * 0.08;
      const cp3y = tipY - py * petalW * 0.18 - sin * petalLen * 0.08;
      const cp4x = baseX - px * petalW + cos * pull;
      const cp4y = baseY - py * petalW + sin * pull;

      p.fill(hue, sat, bri, fillA);
      p.stroke(hue, Math.min(100, sat + 8), Math.min(100, bri + 22), strokeA);
      p.strokeWeight(0.5 + amp * 1.2);

      p.beginShape();
      p.vertex(baseX, baseY);
      p.bezierVertex(cp1x, cp1y, cp2x, cp2y, tipX, tipY);
      p.bezierVertex(cp3x, cp3y, cp4x, cp4y, baseX, baseY);
      p.endShape(p['CLOSE']);
    }
  }

  // ── central glow pulsates with sub + bass ─────────────────────────────────
  // Stays in the same pink family — innermost-warm shade, near-white core.
  const centerAmp = amps[0] * 0.6 + amps[1] * 0.4;
  const centerHue = PETAL_HUE - PETAL_HUE_RANGE; // warmest pink

  for (let layer = 5; layer >= 1; layer--) {
    const r = layer * (5 + centerAmp * 16 + beatPulse * 14);
    const a = (6 - layer) * 11 + centerAmp * 14 + beatPulse * 10;
    p.noStroke();
    p.fill(centerHue, 30 + centerAmp * 40, 100, a);
    p.ellipse(cx, cy, r * 2, r * 2);
  }

  // ── reset colour mode ─────────────────────────────────────────────────────
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
