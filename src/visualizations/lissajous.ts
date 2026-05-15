/**
 * Lissajous — Oscilloscope-style Lissajous figure visualization.
 *
 * Seven parametric curves (one per frequency band) drawn as glowing phosphor
 * lines on a dark background, inspired by Jerobeam Fenderson's oscilloscope
 * music (creativeapplications.net/project/oscilloscope-music-jerobeam-fenderson
 * -and-hansi-raber/). Each curve follows x = A·sin(a·t + φ), y = B·sin(b·t)
 * with a distinct coprime ratio a:b (1:1 → 5:6), forming closed mathematical
 * figures — ellipse, figure-8, three-lobe, four-lobe, etc. Band amplitude
 * drives size; phases drift at configurable speed and snap on beats.
 * An offscreen buffer preserves the phosphor afterglow trail.
 *
 * Sliders: Curves (1–7 shown), Glow (phosphor brightness), Drift (phase speed)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Coprime integer frequency ratios — each pair a:b defines a distinct closed shape.
// Sampled over [0, 2π], coprime pairs always produce a fully closed curve.
const RATIOS: [number, number][] = [
  [1, 1], // ellipse / circle
  [1, 2], // figure-8 / infinity
  [2, 3], // three-lobe clover
  [3, 4], // four-lobe
  [3, 5], // five-lobe star
  [4, 5], // dense five-petal
  [5, 6], // six-petal
];

// Phosphor-inspired palette cycling through warm greens → cyans → blues → violet → magenta → amber
const BAND_HUES = [120, 185, 240, 300, 15, 45, 80];

const N_SAMPLES = isMobile ? 150 : 300;

// ── module-scoped state ───────────────────────────────────────────────────────
let pg: any = null;
let phases: number[] = [];
let lastBeatIndex = -1;
let beatFlash = 0;
let time = 0;

// ── reset ─────────────────────────────────────────────────────────────────────
export function resetLissajous(): void {
  pg = null;
  phases = Array.from({ length: BAND_COUNT }, (_, i) => (i * Math.PI * 2) / BAND_COUNT);
  lastBeatIndex = -1;
  beatFlash = 0;
  time = 0;
}

// ── draw ──────────────────────────────────────────────────────────────────────
export function drawLissajous(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const curves = Math.round(Math.max(1, Math.min(7, config.lissajousCurves)));
  const glow = config.lissajousGlow;
  const drift = config.lissajousDrift;

  if (phases.length !== BAND_COUNT) {
    phases = Array.from({ length: BAND_COUNT }, (_, i) => (i * Math.PI * 2) / BAND_COUNT);
  }

  // Init / resize offscreen buffer
  if (!pg || pg.width !== p.width || pg.height !== p.height) {
    pg = (p as any).createGraphics(p.width, p.height);
    pg.pixelDensity(1);
    pg.background(0);
    phases = Array.from({ length: BAND_COUNT }, (_, i) => (i * Math.PI * 2) / BAND_COUNT);
    lastBeatIndex = -1;
    beatFlash = 0;
  }

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
      lastBeatIndex = beatIndex;
      onBeat = true;
    }
  }

  if (onBeat) {
    // Snap phases on beat — each band shifts by a different random angle
    for (let b = 0; b < BAND_COUNT; b++) {
      phases[b] += (Math.random() - 0.5) * Math.PI;
    }
    beatFlash = 1.0;
  }

  // Phase drift — alternating direction per band creates relative motion between curves
  for (let b = 0; b < BAND_COUNT; b++) {
    const sign = b % 2 === 0 ? 1 : -1;
    phases[b] += 0.003 * drift * dt * sign;
  }

  // Fade trail buffer — semi-transparent black overlay
  pg.fill(0, 0, 0, 24);
  pg.noStroke();
  pg.rect(0, 0, pg.width, pg.height);

  // Switch buffer to HSB for convenient hue control
  (pg as any).colorMode(pg['HSB'], 360, 100, 100, 100);
  pg.noFill();

  const cx = p.width / 2;
  const cy = p.height / 2;
  const baseR = Math.min(p.width, p.height) * 0.42;

  for (let b = 0; b < curves && b < BAND_COUNT; b++) {
    const [a, bFreq] = RATIOS[b];
    const amp = Math.max(0.04, amps[b]);
    const hue = BAND_HUES[b];
    const phase = phases[b];

    // Slow time-varying asymmetry between X and Y radii — keeps the figure organic
    const asymX = 1.0 + 0.14 * Math.sin(time * 0.04 + b * 0.9);
    const asymY = 1.0 + 0.14 * Math.cos(time * 0.04 + b * 0.7);
    const Rx = baseR * amp * asymX;
    const Ry = baseR * amp * asymY;

    // 3-pass phosphor glow: broad soft halo → mid → bright core line
    const passes = [
      { w: 6.5 * glow, s: 55, bri: 45, a: 20 },
      { w: 2.5 * glow, s: 78, bri: 78, a: 50 },
      { w: 1.3,        s: 92, bri: 100, a: 90 },
    ];

    for (const pass of passes) {
      pg.stroke(hue, pass.s, pass.bri, pass.a);
      pg.strokeWeight(pass.w);
      pg.beginShape();
      for (let i = 0; i <= N_SAMPLES; i++) {
        const t = (i / N_SAMPLES) * Math.PI * 2;
        const x = cx + Rx * Math.sin(a * t + phase);
        const y = cy + Ry * Math.sin(bFreq * t);
        pg.vertex(x, y);
      }
      pg.endShape();
    }
  }

  // Beat flash — white wash that fades quickly
  if (beatFlash > 0) {
    pg.fill(0, 0, 100, beatFlash * 22);
    pg.noStroke();
    pg.rect(0, 0, pg.width, pg.height);
    beatFlash *= Math.pow(0.82, dt);
    if (beatFlash < 0.01) beatFlash = 0;
  }

  // Restore RGB mode on buffer
  (pg as any).colorMode(pg['RGB'], 255);

  // Blit offscreen buffer to main canvas
  p.image(pg, 0, 0);

  time += dt;
}
