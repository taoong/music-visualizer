/**
 * Hilbert — Audio-reactive Hilbert space-filling curve labyrinth.
 *
 * Inspired by Vera Molnár's "Labyrinth" computer plotter series (1973–2007,
 * https://www.hernando.es/artfairs/artissima/artissima2022/vera-molnar-labyrinths).
 * Molnár was a pioneer of computational art who used the plotter as her brush,
 * exploring mathematical curves and systematic deviations from geometric order.
 * This visualization realizes her labyrinthine aesthetic in music-reactive neon.
 *
 * A Hilbert space-filling curve recursively subdivides the canvas into a single
 * winding path that visits every cell in a 2ⁿ × 2ⁿ grid. Seven sinusoidal
 * standing waves (one per frequency band, at Fibonacci spatial frequencies
 * 1,2,3,5,8,13,21) displace each point perpendicular to its local tangent —
 * quiet passages hold a pristine geometric maze while loud sections make the
 * labyrinth writhe and breathe. The 7 curve sections are colored by frequency
 * band (violet→blue→teal→green→yellow→orange→red). Beat events snap the hue
 * palette by 53° and trigger a vivid color shift.
 *
 * Sliders
 *   Order — recursion depth 2–6: higher = finer labyrinth, more segments
 *   Warp  — audio displacement amplitude: 0 = pure geometry, 1 = full writhing
 *   Glow  — neon phosphor bloom intensity
 *   Trail — afterglow persistence: 0 = instant clear, 1 = long ghost trails
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

// Fibonacci spatial frequencies — creates rich harmonic interactions along the curve
const SPATIAL_FREQS: readonly number[] = [1, 2, 3, 5, 8, 13, 21];

// Each band's standing wave phase drifts at a distinct rate
const PHASE_SPEEDS: readonly number[] = [0.30, 0.45, 0.60, 0.80, 1.00, 1.30, 1.70];

type Pt = { x: number; y: number };

let pts: Pt[] = [];
let currentOrder = -1;
let animT = 0;
let hueBase = 0;
let lastBeatIndex = -1;

/** Convert Hilbert curve index d → normalised (x,y) in [0,1] */
function buildHilbert(order: number): Pt[] {
  const n = 1 << order;        // 2^order grid side length
  const count = n * n;
  const side = n - 1;          // denominator for normalisation
  const result: Pt[] = new Array(count) as Pt[];
  for (let d = 0; d < count; d++) {
    let x = 0, y = 0, t = d;
    for (let s = 1; s < n; s <<= 1) {
      const rx = 1 & (t >> 1);
      const ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        const tmp = x; x = y; y = tmp;
      }
      x += s * rx;
      y += s * ry;
      t >>= 2;
    }
    result[d] = { x: x / side, y: y / side };
  }
  return result;
}

export function resetHilbert(): void {
  animT = 0;
  hueBase = 0;
  lastBeatIndex = -1;
  currentOrder = -1; // force curve rebuild on next draw
}

export function drawHilbert(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const cfgOrder  = Math.round(config.hilbertOrder);
  const warpVal   = config.hilbertWarp;
  const glowVal   = config.hilbertGlow;
  const trailVal  = config.hilbertTrail;

  const maxOrder = isMobile ? 4 : 6;
  const order = Math.min(Math.max(2, cfgOrder), maxOrder);

  if (order !== currentOrder) {
    currentOrder = order;
    pts = buildHilbert(order);
  }

  const W = p.width, H = p.height;
  const margin = Math.min(W, H) * 0.06;
  const availW = W - margin * 2;
  const availH = H - margin * 2;
  const N = pts.length;

  // Frame-rate-independent time
  animT += dt * 0.015;

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      onBeat = true;
    }
  }
  if (onBeat) {
    // Rotate palette by 53° (prime step cycles through all hue positions)
    hueBase = (hueBase + 53) % 360;
  }

  // Cell size in pixels (used to scale warp amplitude)
  const cellSize = availW / ((1 << order) - 1);
  const warpAmp  = warpVal * cellSize * 0.5;

  // Pre-compute displaced screen positions
  const dxArr = new Float32Array(N);
  const dyArr = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const pt = pts[i];
    const sx = margin + pt.x * availW;
    const sy = margin + pt.y * availH;

    // Smooth tangent: look ±2 points (clamped at endpoints)
    const iA = Math.max(0, i - 2);
    const iB = Math.min(N - 1, i + 2);
    const tx = pts[iB].x - pts[iA].x;
    const ty = pts[iB].y - pts[iA].y;
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    // Perpendicular (normal)
    const nx = -ty / len;
    const ny =  tx / len;

    // Sum sinusoidal waves from all 7 bands
    const tParam = i / (N - 1);
    let disp = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      disp += amps[b] * Math.sin(2 * Math.PI * SPATIAL_FREQS[b] * tParam + animT * PHASE_SPEEDS[b]);
    }
    disp *= warpAmp;

    dxArr[i] = sx + nx * disp;
    dyArr[i] = sy + ny * disp;
  }

  // ── Trail fade (BLEND mode, RGB space) ──────────────────────────────────
  p.push();
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255);
  p.noStroke();
  // alpha: high trailVal = slow fade (small alpha = less black each frame)
  const fadeAlpha = (1 - trailVal) * 38 + 5;
  p.fill(0, 0, 0, fadeAlpha);
  p.rect(0, 0, W, H);
  p.pop();

  // ── Draw neon labyrinth (ADD blend, HSB space) ───────────────────────────
  p.push();
  p.blendMode(p['ADD']);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noFill();

  // 3 glow passes: outer halo → mid glow → bright core
  const passes = [
    { wt: 8 + glowVal * 10, al: 15 + glowVal * 20 },
    { wt: 3 + glowVal * 4,  al: 45 + glowVal * 25 },
    { wt: 1.5,               al: 100 },
  ];

  const segPerBand = (N - 1) / BAND_COUNT;

  for (const pass of passes) {
    for (let b = 0; b < BAND_COUNT; b++) {
      const startI = Math.floor(b * segPerBand);
      const endI   = Math.min(N - 1, Math.floor((b + 1) * segPerBand) + 1);

      const hue = (BAND_HUES[b] + hueBase) % 360;
      const sat = 80 + amps[b] * 15;
      const bri = 55 + amps[b] * 40;

      p.stroke(hue, sat, Math.min(100, bri), pass.al);
      p.strokeWeight(pass.wt * (1 + amps[b] * 0.3));

      (p as any).beginShape();
      for (let i = startI; i <= endI; i++) {
        (p as any).vertex(dxArr[i], dyArr[i]);
      }
      (p as any).endShape();
    }
  }

  p.pop();
}
