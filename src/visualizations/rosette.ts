/**
 * Rosette — Audio-reactive hypotrochoid spirograph curves.
 *
 * Seven hypotrochoid curves (one per frequency band) are drawn as complete
 * closed loops around the canvas centre, each simulating a Spirograph gear
 * rolling inside a fixed wheel. Band amplitude drives the pen's extension
 * from the rolling circle's centre (d), morphing each curve from a collapsed
 * circle into a full petal bloom. Curves rotate at slightly different speeds
 * so they drift in and out of phase with one another, creating ever-shifting
 * mandala-like interference patterns. A beat-triggered petal-count snap
 * changes the loop topology of all curves simultaneously.
 *
 * Inspired by the guilloche engine-turning tradition — hypotrochoid patterns
 * mechanically engraved on gold by Fabergé craftsmen (St. Petersburg, 1885–1917)
 * beneath translucent enamel, and by the parametric curve generative art of
 * Reza Ali on fxhash (https://www.fxhash.xyz/u/Reza%20Ali).
 *
 * Audio reactivity
 *   Band[i] amplitude → pen extension d (quiet = circle, loud = full petal bloom)
 *   Overall energy    → rotation speed boost
 *   Beat              → hue palette jump + brief wobble burst + petal-count snap
 *
 * Sliders
 *   Petals — base petal count (3–8); each band adds its index to get 3–15 petals
 *   Bloom  — pen-extension scale (0 = circles only, 1 = full spirograph bloom)
 *   Glow   — trail persistence (0 = crisp/instant, 1 = dense layered mandala)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;
// violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES: readonly number[] = [280, 240, 190, 130, 70, 30, 320];

// ── Module-scoped state ────────────────────────────────────────────────────
let rotPhases: Float32Array = new Float32Array(BAND_COUNT);
let hueShift = 0;
let beatPulse = 0;
let wobblePulse = 0;
let petalOffset = 0;          // temporary integer offset added by beat
let petalOffsetTTL = 0;       // frames until offset resets
let lastBeatIndex = -1;
let pg: any = null;

export function resetRosette(): void {
  rotPhases = new Float32Array(BAND_COUNT);
  hueShift = 0;
  beatPulse = 0;
  wobblePulse = 0;
  petalOffset = 0;
  petalOffsetTTL = 0;
  lastBeatIndex = -1;
  pg = null;
}

export function drawRosette(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const cx = W * 0.5;
  const cy = H * 0.5;

  // Slider values
  const petalSlider = config.rosettePetals; // 0→1
  const bloomSlider = config.rosetteBloom;  // 0→1
  const glowSlider  = config.rosetteGlow;   // 0→1

  // Init / resize offscreen graphics buffer
  if (!pg || pg.width !== W || pg.height !== H) {
    pg = (p as any).createGraphics(W, H);
    pg.pixelDensity(1);
    pg.background(0);
    rotPhases = new Float32Array(BAND_COUNT);
    hueShift = 0;
    beatPulse = 0;
    wobblePulse = 0;
    petalOffset = 0;
    petalOffsetTTL = 0;
    lastBeatIndex = -1;
  }

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatPulse   = 1.0;
      wobblePulse = 1.0;
      hueShift = (hueShift + 35 + Math.random() * 25) % 360;
      // Snap petal offset: ±1 or ±2 loops for all bands simultaneously
      const sign  = Math.random() < 0.5 ? -1 : 1;
      petalOffset = sign * (1 + Math.floor(Math.random() * 2));
      petalOffsetTTL = 55 + Math.random() * 30; // hold ~1 second
    }
  }
  beatPulse   *= Math.pow(0.82, dt);
  wobblePulse *= Math.pow(0.88, dt);
  if (beatPulse < 0.001)   beatPulse = 0;
  if (wobblePulse < 0.001) wobblePulse = 0;

  // Decay petal offset back to 0 after TTL
  petalOffsetTTL = Math.max(0, petalOffsetTTL - dt);
  if (petalOffsetTTL <= 0) petalOffset = 0;

  // ── Overall audio energy ───────────────────────────────────────────────────
  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  // ── Advance rotation phases (each band at a slightly different rate) ────────
  // High glow → rotate slower (let patterns accumulate); high energy → faster
  const baseSpeed = 0.0012 + (1 - glowSlider) * 0.0015;
  for (let b = 0; b < BAND_COUNT; b++) {
    const bandSpeed = baseSpeed * (1 + b * 0.07) * (1 + energy * 0.55);
    rotPhases[b] = (rotPhases[b] + bandSpeed * dt) % TWO_PI;
  }

  // ── Fade trail buffer ──────────────────────────────────────────────────────
  // High glow → slow fade (low overlay alpha); low glow → fast fade
  const fadeAlpha = Math.round(8 + (1 - glowSlider) * 44); // 8 – 52
  pg.noStroke();
  pg.fill(0, 0, 0, fadeAlpha);
  pg.rect(0, 0, W, H);

  // ── Draw each hypotrochoid curve ───────────────────────────────────────────
  (pg as any).colorMode((pg as any)['HSB'] ?? 'hsb', 360, 100, 100, 100);
  pg.noFill();

  const R = Math.min(W, H) * 0.43;
  const N = isMobile ? 80 : 200; // segments per curve

  // Base petal count from slider (3–8), plus transient beat offset
  const sliderBase = 3 + Math.round(petalSlider * 5); // 3–8

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b] ?? 0;
    if (amp < 0.015) continue; // skip near-silent bands

    // Petal count: each band gets progressively more petals (3+0 … 8+6=14)
    const petals = Math.max(3, sliderBase + petalOffset + b);

    // Hypotrochoid params: rolling circle radius r rolling inside fixed circle R
    const r = R / petals;
    // Pen distance d driven by amplitude and bloom slider
    const dMax = r * bloomSlider * (1 + wobblePulse * 0.22);
    const d    = amp * dMax;
    if (d < 1.0) continue; // skip if nearly collapsed

    const hue      = ((BAND_HUES[b] + hueShift) % 360 + 360) % 360;
    const sat      = 65 + amp * 35;
    const bri      = 32 + amp * 55 + beatPulse * 18;
    const baseAlph = 22 + amp * 55 + beatPulse * 22;
    const sw       = 0.7 + amp * 1.8;

    // Pre-compute rotated curve points
    const xs = new Float32Array(N + 1);
    const ys = new Float32Array(N + 1);
    const cosR = Math.cos(rotPhases[b]);
    const sinR = Math.sin(rotPhases[b]);
    const k = petals - 1; // = R/r - 1

    for (let i = 0; i <= N; i++) {
      const t  = (i / N) * TWO_PI;
      // Standard hypotrochoid:
      //   x = (R-r)·cos(t) + d·cos(k·t)
      //   y = (R-r)·sin(t) − d·sin(k·t)
      const hx = (R - r) * Math.cos(t) + d * Math.cos(k * t);
      const hy = (R - r) * Math.sin(t) - d * Math.sin(k * t);
      // Rigid rotation by rotPhases[b]
      xs[i] = cx + hx * cosR - hy * sinR;
      ys[i] = cy + hx * sinR + hy * cosR;
    }

    // Outer glow (skipped on mobile)
    if (!isMobile) {
      (pg as any).stroke(hue, sat * 0.38, bri, baseAlph * 0.22);
      (pg as any).strokeWeight(sw * 5.5);
      pg.beginShape();
      for (let i = 0; i <= N; i++) pg.vertex(xs[i], ys[i]);
      pg.endShape();
    }

    // Mid glow
    (pg as any).stroke(hue, sat * 0.70, bri, baseAlph * 0.48);
    (pg as any).strokeWeight(sw * 2.5);
    pg.beginShape();
    for (let i = 0; i <= N; i++) pg.vertex(xs[i], ys[i]);
    pg.endShape();

    // Core bright line
    (pg as any).stroke(hue, sat, Math.min(100, bri + 14), Math.min(100, baseAlph + 14));
    (pg as any).strokeWeight(sw);
    pg.beginShape();
    for (let i = 0; i <= N; i++) pg.vertex(xs[i], ys[i]);
    pg.endShape();
  }

  (pg as any).colorMode((pg as any)['RGB'] ?? 'rgb', 255);

  // ── Composite buffer onto main canvas ─────────────────────────────────────
  p.background(0);
  p.image(pg, 0, 0);

  // Beat flash
  if (beatPulse > 0.28) {
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
    (p as any).noStroke();
    (p as any).fill((hueShift + 120) % 360, 22, 100, beatPulse * 16);
    p.rect(0, 0, W, H);
    (p as any).colorMode(p['RGB'], 255);
  }
}
