/**
 * Kaleidoscope — polar-coordinate spectrum mandala
 *
 * The audio spectrum (7 bands) is mapped to a continuous closed curve in polar
 * coordinates. Radius at each angle is interpolated from the nearest frequency
 * bands, then the curve is repeated with N-fold mirror symmetry to create
 * kaleidoscopic mandala patterns that morph in real-time with the music.
 *
 * Sliders
 *   Segments — mirror-fold count (2 = bilateral, 6 = hexagonal, 12 = complex)
 *   Trail    — motion-trail persistence (0 = instant clear, 1 = long layering)
 *   Organic  — phase-harmonic distortion (0 = clean symmetry, 1 = fluid chaos)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Harmonic multiplier per band for the organic-smear effect
const HARMONICS = [2, 3, 4, 5, 7, 9, 11];
// Phase drift rates (radians per dt unit, higher bands drift faster)
const PHASE_RATES = [0.0009, 0.0013, 0.0018, 0.0023, 0.0029, 0.0035, 0.0042];

// ── module-scoped state ──────────────────────────────────────────────────────
const phases = new Float32Array(BAND_COUNT); // per-band phase offsets for smear
let lastBeatIndex = -1;
let beatPulse = 0; // 1.0 on beat → decays to 0
let globalHue = 200; // slowly drifting base hue (degrees)

// ── reset ────────────────────────────────────────────────────────────────────
export function resetKaleido(): void {
  phases.fill(0);
  lastBeatIndex = -1;
  beatPulse = 0;
  globalHue = 200;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawKaleido(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const N = Math.max(2, Math.round(config.kaleidoSegments));
  const trail = config.kaleidoTrail;
  const smear = config.kaleidoSmear;

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex =
      adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatPulse = 1.0;
      // Jump hue on beat for visual drama
      globalHue = (globalHue + 35 + Math.random() * 25) % 360;
    }
  }
  beatPulse *= Math.pow(0.82, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  // Slowly drift hue between beats
  globalHue = (globalHue + 0.05 * dt) % 360;

  // Evolve phase offsets for the organic-smear effect
  for (let i = 0; i < BAND_COUNT; i++) {
    phases[i] = (phases[i] + PHASE_RATES[i] * dt) % (Math.PI * 2);
  }

  // ── trail fade ────────────────────────────────────────────────────────────
  // Semi-transparent black rect fades old frames; higher trail = slower fade
  const fadeAlpha = Math.round((1.0 - trail) * 58 + 8); // 8..66
  (p as any).colorMode(p['RGB'], 255);
  p.noStroke();
  p.fill(0, 0, 0, fadeAlpha);
  p.rect(0, 0, p.width, p.height);

  // ── geometry ──────────────────────────────────────────────────────────────
  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const baseR = minDim * 0.07; // inner hub radius
  const outerR = minDim * 0.44; // max possible radius
  const audioRange = outerR - baseR; // amplitude maps into this range

  const STEPS = 256; // vertices around the full circle
  const segAngle = (Math.PI * 2) / N;

  // ── precompute radii ──────────────────────────────────────────────────────
  // For each angle step, fold into one symmetry segment, mirror within it,
  // then interpolate between adjacent bands to get a smooth polar radius.
  const radii = new Float32Array(STEPS + 1);
  for (let step = 0; step <= STEPS; step++) {
    const rawT = step / STEPS; // [0, 1) for full circle

    // Fold into one segment (N-fold), then mirror within that segment
    const segT = (rawT * N) % 1.0;
    const tMirror = segT < 0.5 ? segT * 2.0 : 2.0 - segT * 2.0; // [0..1..0]

    // Smooth interpolation between adjacent frequency bands
    const bandPos = tMirror * (BAND_COUNT - 1);
    const lo = Math.min(Math.floor(bandPos), BAND_COUNT - 2);
    const hi = lo + 1;
    const frac = bandPos - lo;
    const baseAmp = amps[lo] * (1.0 - frac) + amps[hi] * frac;

    let r = baseR + baseAmp * audioRange;

    // Organic smear: add phase-shifted harmonics to break perfect symmetry
    if (smear > 0.005) {
      const theta = rawT * Math.PI * 2;
      for (let b = 0; b < BAND_COUNT; b++) {
        r += amps[b] * smear * audioRange * 0.22 *
             Math.sin(HARMONICS[b] * theta + phases[b]);
      }
    }

    radii[step] = Math.max(baseR * 0.4, r);
  }

  // ── render ────────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Find the dominant band to tint the shape
  let domBand = 0;
  let maxAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    if (amps[b] > maxAmp) { maxAmp = amps[b]; domBand = b; }
  }

  // Draw N rainbow-tinted wedge fills (one per segment) for color variety
  p.noStroke();
  for (let seg = 0; seg < N; seg++) {
    const startStep = Math.floor(seg * STEPS / N);
    const endStep = Math.floor((seg + 1) * STEPS / N);
    const segHue = (globalHue + (seg / N) * 360) % 360;
    const sat = 68 + maxAmp * 22;
    const bri = 38 + maxAmp * 30 + beatPulse * 12;
    const alpha = 28 + maxAmp * 20 + beatPulse * 12;

    p.fill(segHue, sat, bri, alpha);
    p.beginShape();
    p.vertex(cx, cy); // center of fan
    for (let step = startStep; step <= endStep; step++) {
      const theta = (step / STEPS) * Math.PI * 2;
      p.vertex(cx + Math.cos(theta) * radii[step], cy + Math.sin(theta) * radii[step]);
    }
    p.endShape(p['CLOSE']);
  }

  // Glow layer 1 — wide outer halo
  p.noFill();
  const coreHue = (globalHue + domBand * 30) % 360;
  p.stroke(coreHue, 70, 80, 14 + beatPulse * 8);
  p.strokeWeight(8);
  p.beginShape();
  for (let step = 0; step <= STEPS; step++) {
    const theta = (step / STEPS) * Math.PI * 2;
    p.vertex(cx + Math.cos(theta) * radii[step], cy + Math.sin(theta) * radii[step]);
  }
  p.endShape(p['CLOSE']);

  // Glow layer 2 — medium body
  p.stroke(coreHue, 78, 90, 38 + beatPulse * 18);
  p.strokeWeight(3.5);
  p.beginShape();
  for (let step = 0; step <= STEPS; step++) {
    const theta = (step / STEPS) * Math.PI * 2;
    p.vertex(cx + Math.cos(theta) * radii[step], cy + Math.sin(theta) * radii[step]);
  }
  p.endShape(p['CLOSE']);

  // Glow layer 3 — sharp bright core
  p.stroke((coreHue + 18) % 360, 82, 98, 80 + beatPulse * 20);
  p.strokeWeight(1.2);
  p.beginShape();
  for (let step = 0; step <= STEPS; step++) {
    const theta = (step / STEPS) * Math.PI * 2;
    p.vertex(cx + Math.cos(theta) * radii[step], cy + Math.sin(theta) * radii[step]);
  }
  p.endShape(p['CLOSE']);

  // Central hub — glows with sub + bass energy and beat
  const hubEnergy = amps[0] * 0.55 + amps[1] * 0.45;
  const hubR = baseR * (0.9 + hubEnergy * 1.0 + beatPulse * 0.5);
  const hubHue = (coreHue + 40) % 360;
  for (let layer = 5; layer >= 1; layer--) {
    const r = hubR * layer * 0.52;
    const alpha = (6 - layer) * 10 + hubEnergy * 18 + beatPulse * 20;
    p.noStroke();
    p.fill(hubHue, 52, 100, alpha);
    p.ellipse(cx, cy, r * 2, r * 2);
  }

  // Beat flash: quick white glaze across the whole shape
  if (beatPulse > 0.3) {
    p.noStroke();
    p.fill(0, 0, 100, beatPulse * 18);
    p.ellipse(cx, cy, outerR * 2.2, outerR * 2.2);
  }

  // Reset color mode
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
