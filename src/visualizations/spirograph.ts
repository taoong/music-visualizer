/**
 * Spirograph — Hypotrochoid gear-drawing visualization.
 *
 * 7 spirograph layers (one per frequency band) trace hypotrochoid curves using
 * distinct R/r integer ratios that produce different petal counts (3, 4, 5, 6,
 * 7, 8, 11). Each layer's drawing phase advances continuously, building up a
 * mandala-like accumulation in the trail buffer. Audio amplitude drives the
 * pen offset (d), which controls how "open" the petal pattern is — near
 * silence draws tight near-circles, full amplitude flares into spiky rosettes.
 * Beat events snap the hue palette and temporarily spike the pen offset.
 *
 * Inspired by the mathematical art of Hamid Naderi Yeganeh
 * (https://www.scientificamerican.com/blog/roots-of-unity/math-art-created-from-trigonometric-functions/)
 * and the Spirograph toy by Denys Fisher (Hasbro, 1965), which made
 * hypotrochoid geometry a playful artistic medium.
 *
 * Sliders: Layers (1–7 simultaneous), Complexity (pen offset range), Trail (persistence)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// R/r ratio for each band → determines petal count (R/r - 1 petals for int ratios)
const BAND_RATIOS = [3, 4, 5, 6, 7, 8, 11];
// Hue palette: violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES  = [280, 230, 180, 120, 60, 30, 310];

let globalAngle  = 0;
let hueShift     = 0;
let beatPulse    = 0;
let lastBeatIndex = -1;
let pg: any      = null;

export function resetSpirograph(): void {
  globalAngle   = 0;
  hueShift      = 0;
  beatPulse     = 0;
  lastBeatIndex = -1;
  pg            = null;
}

export function drawSpirograph(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w  = p.width;
  const h  = p.height;
  const cx = w / 2;
  const cy = h / 2;

  // Init / resize offscreen buffer
  if (!pg || pg.width !== w || pg.height !== h) {
    pg = (p as any).createGraphics(w, h);
    pg.pixelDensity(1);
    pg.background(0);
    globalAngle   = 0;
    hueShift      = 0;
    beatPulse     = 0;
    lastBeatIndex = -1;
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatPulse     = 1.0;
      hueShift      = (hueShift + 40 + Math.random() * 50) % 360;
    }
  }
  beatPulse *= Math.pow(0.80, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  // Slider parameters
  const layers     = Math.max(1, Math.min(BAND_COUNT, Math.round(config.spirographLayers * (BAND_COUNT - 1) + 1)));
  const complexity = Math.max(0.02, config.spirographComplexity);
  const trailAlpha = Math.round(2 + (1 - config.spirographTrail) * 32);

  // Overall energy across active layers
  let energy = 0;
  for (let b = 0; b < layers; b++) energy += amps[b] ?? 0;
  energy /= layers;

  // How many segments to draw per frame — more = faster trace
  const nSteps     = isMobile ? 10 : 20;
  const stepSize   = (0.005 + energy * 0.007 + beatPulse * 0.010) * dt;
  const stepPerSeg = stepSize / nSteps;

  // Fade trail buffer
  pg.noStroke();
  pg.fill(0, 0, 0, trailAlpha);
  pg.rect(0, 0, w, h);

  (pg as any).colorMode(pg['HSB'] ?? 'hsb', 360, 100, 100, 100);

  const baseR = Math.min(w, h) * 0.42;

  for (let b = 0; b < layers; b++) {
    const amp = amps[b] ?? 0;
    const k   = BAND_RATIOS[b];     // R/r integer ratio
    const R   = baseR;
    const r   = R / k;              // rolling circle radius
    // Pen offset: complexity scales the max, amplitude drives within that range
    const dMax = r * (0.25 + complexity * 0.75);
    const d    = dMax * (0.08 + amp * 0.92 + beatPulse * 0.25 * (b + 1) / BAND_COUNT);

    const hue  = ((BAND_HUES[b] + hueShift) % 360 + 360) % 360;
    const sat  = 72 + amp * 28;
    const bri  = 48 + amp * 52 + beatPulse * 16;
    const alph = 20 + amp * 60 + beatPulse * 25;
    const sw   = 0.5 + amp * 1.8 + beatPulse * 0.4;

    // Glow pass (desktop only)
    if (!isMobile) {
      pg.noFill();
      (pg as any).stroke(hue, sat * 0.5, Math.min(100, bri + 4), alph * 0.22);
      (pg as any).strokeWeight(sw * 3.8);
      pg.beginShape();
      for (let s = 0; s < nSteps; s++) {
        const θ = globalAngle + s * stepPerSeg;
        pg.vertex(
          cx + (R - r) * Math.cos(θ) + d * Math.cos((k - 1) * θ),
          cy + (R - r) * Math.sin(θ) - d * Math.sin((k - 1) * θ),
        );
      }
      pg.endShape();
    }

    // Core pass
    (pg as any).stroke(hue, sat, Math.min(100, bri + 8), alph);
    (pg as any).strokeWeight(sw);
    pg.noFill();
    pg.beginShape();
    for (let s = 0; s < nSteps; s++) {
      const θ = globalAngle + s * stepPerSeg;
      pg.vertex(
        cx + (R - r) * Math.cos(θ) + d * Math.cos((k - 1) * θ),
        cy + (R - r) * Math.sin(θ) - d * Math.sin((k - 1) * θ),
      );
    }
    pg.endShape();
  }

  // Advance drawing phase
  globalAngle += stepSize;
  if (globalAngle > Math.PI * 2 * 100) globalAngle -= Math.PI * 2 * 100;

  (pg as any).colorMode(pg['RGB'] ?? 'rgb', 255);

  // Composite onto main canvas
  p.background(0);
  p.image(pg, 0, 0);

  // Beat flash overlay
  if (beatPulse > 0.2) {
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
    (p as any).fill((hueShift + 180) % 360, 20, 100, beatPulse * 9);
    (p as any).noStroke();
    p.rect(0, 0, w, h);
    (p as any).colorMode(p['RGB'], 255);
  }
}
