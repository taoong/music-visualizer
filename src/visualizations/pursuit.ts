/**
 * Pursuit — Curves of Pursuit visualization.
 *
 * Inspired by the classical "mice problem" (Pierre Bouguer, 1732;
 * popularized by Martin Gardner's "Mathematical Games" in Scientific
 * American) and the Genuary 2024 creative-coding challenge community
 * (https://genuary.art/) which revisited pursuit curves as a paradigm
 * of beauty-from-minimal-rules. N particles placed uniformly on a
 * regular N-gon each continuously chase the next in the cycle, tracing
 * congruent logarithmic spirals that converge to the centroid.
 *
 * Seven packs (one per frequency band) run simultaneously at
 * band-amplitude-driven speeds. Each pack's hue is mapped to its band
 * (violet → red). Trails accumulate on an additive-blend offscreen
 * buffer; long persistence builds dense mandala-like whorls, short
 * persistence shows only the live spiral arms. On convergence, each
 * pack relocates to a fresh Perlin-noise position and re-expands.
 * Beat fires all packs radially outward then lets them re-spiral.
 *
 * Sliders
 *   Symmetry — polygon order N (3–12); controls the number of spiral arms
 *   Speed    — pursuit velocity; slow = gentle elegant arcs, fast = tight coils
 *   Trail    — persistence; low = fleeting sparks, high = accumulated mandala
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

const TWO_PI = Math.PI * 2;

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

// Initial normalized (0–1) centre positions — spread across canvas
const INIT_CX = [0.25, 0.70, 0.15, 0.50, 0.80, 0.38, 0.62];
const INIT_CY = [0.30, 0.22, 0.65, 0.50, 0.68, 0.20, 0.78];

type Pack = {
  cx: number; cy: number;          // current centre, normalised [0,1]
  xs: Float32Array; ys: Float32Array; // particle canvas positions
  vx: Float32Array; vy: Float32Array; // burst velocity (px/frame)
  n: number;
};

let packs: Pack[] = [];
let lastN = 0;
let lastBeatIndex = -1;
let hueShift = 0;
let noiseT = 0;
let trailBuf: any = null;
let trailW = 0;
let trailH = 0;

function spawnPack(n: number, W: number, H: number, cx: number, cy: number, startAngle: number): Pack {
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const r = Math.min(W, H) * 0.16;
  for (let i = 0; i < n; i++) {
    const a = startAngle + (i / n) * TWO_PI;
    xs[i] = cx * W + Math.cos(a) * r;
    ys[i] = cy * H + Math.sin(a) * r;
  }
  return { cx, cy, xs, ys, vx, vy, n };
}

function rebuildPacks(n: number, W: number, H: number): void {
  for (let b = 0; b < BAND_COUNT; b++) {
    packs[b] = spawnPack(n, W, H, INIT_CX[b], INIT_CY[b], (b / BAND_COUNT) * TWO_PI * 0.7);
  }
  lastN = n;
}

export function resetPursuit(): void {
  packs = [];
  lastN = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  noiseT = 0;
  if (trailBuf) { trailBuf.remove(); trailBuf = null; }
  trailW = 0;
  trailH = 0;
}

export function drawPursuit(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const minDim = Math.min(W, H);

  // Slider-driven parameters
  const n = Math.max(3, Math.round(3 + (config.pursuitSymmetry ?? 0.5) * 9));   // 3–12
  const chaseStep = 0.008 + (config.pursuitSpeed ?? 0.4) * 0.072;               // fractional step per unit dt
  const persistence = 0.80 + (config.pursuitTrail ?? 0.5) * 0.18;               // 0.80–0.98

  // Init / resize trail buffer
  if (!trailBuf || trailW !== W || trailH !== H) {
    if (trailBuf) trailBuf.remove();
    trailBuf = p.createGraphics(W, H);
    (trailBuf as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
    trailBuf.background(0, 0, 4);
    trailW = W;
    trailH = H;
    packs = [];
    lastN = 0;
  }

  // Rebuild packs when N changes or first run
  if (packs.length !== BAND_COUNT || lastN !== n) {
    rebuildPacks(n, W, H);
  }

  // Beat detection
  let beatFired = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 51) % 360;
      beatFired = true;
    }
  }

  noiseT += 0.0004 * dt;

  // On beat: fire all packs radially outward from their centroid
  if (beatFired) {
    for (let b = 0; b < BAND_COUNT; b++) {
      const pack = packs[b];
      let centX = 0, centY = 0;
      for (let i = 0; i < pack.n; i++) { centX += pack.xs[i]; centY += pack.ys[i]; }
      centX /= pack.n; centY /= pack.n;
      const str = minDim * (0.007 + amps[b] * 0.010);
      for (let i = 0; i < pack.n; i++) {
        const dx = pack.xs[i] - centX;
        const dy = pack.ys[i] - centY;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        pack.vx[i] = (dx / len) * str;
        pack.vy[i] = (dy / len) * str;
      }
    }
  }

  // ── Trail buffer: fade + draw ───────────────────────────────────────────

  const fadeAlpha = (1 - persistence) * 0.25 * dt;
  (trailBuf as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  (trailBuf as any).blendMode(p['BLEND']);
  trailBuf.noStroke();
  trailBuf.fill(0, 0, 4, Math.min(1, fadeAlpha));
  trailBuf.rect(0, 0, W, H);

  (trailBuf as any).blendMode(p['ADD']);

  for (let b = 0; b < BAND_COUNT; b++) {
    const pack = packs[b];
    const amp = amps[b];
    const hue = (BAND_HUES[b] + hueShift) % 360;
    const step = chaseStep * (0.08 + amp * 0.92) * dt;

    // Apply burst velocity with exponential decay
    for (let i = 0; i < pack.n; i++) {
      pack.xs[i] += pack.vx[i];
      pack.ys[i] += pack.vy[i];
      pack.vx[i] *= Math.pow(0.88, dt);
      pack.vy[i] *= Math.pow(0.88, dt);
    }

    // Pursuit step: each particle moves toward the next
    for (let i = 0; i < pack.n; i++) {
      const t = (i + 1) % pack.n;
      const dx = pack.xs[t] - pack.xs[i];
      const dy = pack.ys[t] - pack.ys[i];
      pack.xs[i] += dx * step;
      pack.ys[i] += dy * step;
    }

    // Check convergence: all particles near their mutual centroid
    let centX = 0, centY = 0;
    for (let i = 0; i < pack.n; i++) { centX += pack.xs[i]; centY += pack.ys[i]; }
    centX /= pack.n; centY /= pack.n;
    let maxSq = 0;
    for (let i = 0; i < pack.n; i++) {
      const dx = pack.xs[i] - centX;
      const dy = pack.ys[i] - centY;
      const sq = dx * dx + dy * dy;
      if (sq > maxSq) maxSq = sq;
    }
    if (maxSq < minDim * minDim * 0.00009) {
      // Converged — re-seed at a new Perlin-noise position
      const newCx = 0.12 + (p as any).noise(noiseT + b * 4.7, 10) * 0.76;
      const newCy = 0.12 + (p as any).noise(10, noiseT + b * 4.7) * 0.76;
      const newAngle = (p as any).noise(noiseT * 1.5 + b * 2.3) * TWO_PI * 3;
      const newR = minDim * (0.08 + amp * 0.10 + 0.05);
      pack.cx = newCx;
      pack.cy = newCy;
      for (let i = 0; i < pack.n; i++) {
        const a = newAngle + (i / pack.n) * TWO_PI;
        pack.xs[i] = newCx * W + Math.cos(a) * newR;
        pack.ys[i] = newCy * H + Math.sin(a) * newR;
        pack.vx[i] = 0;
        pack.vy[i] = 0;
      }
    }

    // 3-pass additive glow — outer halo / mid / bright core
    const brt = 55 + amp * 45;
    const sat = 65 + amp * 35;
    const passes = [
      { radius: 5.0, alpha: 0.10 },
      { radius: 2.5, alpha: 0.35 },
      { radius: 1.2, alpha: 0.90 },
    ];
    for (const pass of passes) {
      trailBuf.fill(hue, sat, brt, pass.alpha);
      for (let i = 0; i < pack.n; i++) {
        trailBuf.circle(pack.xs[i], pack.ys[i], pass.radius * 2);
      }
    }
  }

  (trailBuf as any).blendMode(p['BLEND']);

  // ── Composite to main canvas ────────────────────────────────────────────

  (p as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
  p.background(0, 0, 4);
  (p as any).blendMode(p['ADD']);
  p.image(trailBuf, 0, 0);
  (p as any).blendMode(p['BLEND']);

  // Bright current-position dots on top
  p.noStroke();
  for (let b = 0; b < BAND_COUNT; b++) {
    const pack = packs[b];
    const amp = amps[b];
    const hue = (BAND_HUES[b] + hueShift) % 360;
    p.fill(hue, 30, 100);
    const dotR = (3 + amp * 5) * 0.5;
    for (let i = 0; i < pack.n; i++) {
      p.circle(pack.xs[i], pack.ys[i], dotR * 2);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255);
}
