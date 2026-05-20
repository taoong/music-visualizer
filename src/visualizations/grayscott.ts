/**
 * Gray-Scott Reaction-Diffusion — Turing pattern chemical simulation.
 *
 * Inspired by Jonathan McCabe's reaction-diffusion generative art and
 * Karl Sims' Gray-Scott tutorial (https://www.karlsims.com/rd.html).
 * Two virtual chemicals A (activator) and B (inhibitor) diffuse across
 * a 2-D grid and react: A is consumed by B² and replenished by feed;
 * B is produced by the same reaction and depleted by (F+K). The
 * interplay produces spots, stripes, mazes, and whorls depending on
 * the feed (F) and kill (K) parameters.
 *
 * Audio reactivity
 *   Sub-bass amplitude  → nudges F up each frame (+0.01 × amp)
 *   Brilliance amplitude → nudges K up each frame (+0.005 × amp)
 *   Any band transient > 1.5 → inject activator seed at random position
 *   Beat → large central injection + hue palette jump (+30°)
 *
 * Rendering: B concentration mapped to HSB colour; dark near-black
 *   background → vivid saturation at pattern peaks.
 *   Offscreen P5Graphics pixel buffer at ¼ res (⅙ mobile).
 *   Ping-pong Float32Array buffers — zero allocation in the hot path.
 *
 * Sliders
 *   Feed  — base feed rate F ∈ [0.010, 0.095]
 *   Kill  — base kill rate K ∈ [0.040, 0.075]
 *   Speed — simulation steps per frame (1–6; capped at 2 on mobile)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const PIXEL_SCALE = isMobile ? 6 : 4;
const MAX_STEPS_MOBILE = 2;

const DU = 1.0; // diffusion rate of A
const DV = 0.5; // diffusion rate of B
const DT_SIM = 1.0; // simulation time step per substep

const F_MIN = 0.010;
const F_MAX = 0.095;
const K_MIN = 0.040;
const K_MAX = 0.075;

const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

// ── Module state ──────────────────────────────────────────────────────────────

// Ping-pong grid buffers — flat 1D, indexed y*gW + x
let gridA0: Float32Array = new Float32Array(0);
let gridB0: Float32Array = new Float32Array(0);
let gridA1: Float32Array = new Float32Array(0);
let gridB1: Float32Array = new Float32Array(0);

let gW = 0;
let gH = 0;

let lastBeatIndex = -1;
let baseHue = 0;

let buf: P5Graphics | null = null;
let bufW = 0;
let bufH = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function seedCircle(cx: number, cy: number, radius: number, a: number, b: number): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(gW - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(gH - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx; const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const i = y * gW + x;
        gridA0[i] = a;
        gridB0[i] = b;
      }
    }
  }
}

function initGrid(): void {
  gridA0.fill(1.0);
  gridB0.fill(0.0);
  gridA1.fill(1.0);
  gridB1.fill(0.0);
  const seedCount = 30 + Math.floor(Math.random() * 21);
  const minR = Math.max(1, Math.floor(Math.min(gW, gH) * 0.03));
  const maxR = Math.max(2, Math.floor(Math.min(gW, gH) * 0.05));
  for (let i = 0; i < seedCount; i++) {
    const cx = Math.floor(Math.random() * gW);
    const cy = Math.floor(Math.random() * gH);
    const r = minR + Math.floor(Math.random() * (maxR - minR + 1));
    seedCircle(cx, cy, r, 0.0, 1.0);
  }
}

function allocGrid(w: number, h: number): void {
  gW = w; gH = h;
  const n = w * h;
  gridA0 = new Float32Array(n);
  gridB0 = new Float32Array(n);
  gridA1 = new Float32Array(n);
  gridB1 = new Float32Array(n);
  initGrid();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetGrayscott(): void {
  if (gW > 0 && gH > 0) initGrid();
  lastBeatIndex = -1;
  baseHue = 0;
  buf?.remove();
  buf = null;
  bufW = 0; bufH = 0;
  gW = 0; gH = 0;
}

export function drawGrayscott(p: P5Instance, _dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const newGW = Math.max(1, Math.ceil(W / PIXEL_SCALE));
  const newGH = Math.max(1, Math.ceil(H / PIXEL_SCALE));

  // Init / resize offscreen buffer
  if (!buf || bufW !== newGW || bufH !== newGH) {
    buf?.remove();
    buf = p.createGraphics(newGW, newGH);
    buf.noSmooth();
    bufW = newGW; bufH = newGH;
  }

  // Init / resize simulation grid
  if (gW !== newGW || gH !== newGH) allocGrid(newGW, newGH);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      baseHue = (baseHue + 30) % 360;
      seedCircle(gW * 0.5, gH * 0.5, Math.floor(gW * 0.08), 0.0, 1.0);
    }
  }

  // Transient-driven seed injection (one per frame max)
  for (let band = 0; band < BAND_COUNT; band++) {
    if (transients[band] > 1.5) {
      const r = Math.max(1, Math.floor(Math.min(gW, gH) * 0.05));
      seedCircle(Math.random() * gW, Math.random() * gH, r, 0.5, 1.0);
      break;
    }
  }

  // Audio-reactive F/K nudges (computed per frame, not stored)
  const F = Math.min(F_MAX + 0.005, F_MIN + config.grayscottFeed * (F_MAX - F_MIN) + amps[0] * 0.01);
  const K = Math.min(K_MAX + 0.003, K_MIN + config.grayscottKill * (K_MAX - K_MIN) + amps[6] * 0.005);

  // Simulation steps
  const rawSteps = Math.floor(1 + config.grayscottSpeed * 5);
  const steps = isMobile ? Math.min(rawSteps, MAX_STEPS_MOBILE) : rawSteps;

  const DU_DT = DU * DT_SIM;
  const DV_DT = DV * DT_SIM;
  const F_DT  = F  * DT_SIM;
  const FK_DT = (F + K) * DT_SIM;

  for (let step = 0; step < steps; step++) {
    for (let y = 0; y < gH; y++) {
      const yN = y === 0      ? 0      : y - 1;
      const yS = y === gH - 1 ? gH - 1 : y + 1;

      for (let x = 0; x < gW; x++) {
        const xW = x === 0      ? 0      : x - 1;
        const xE = x === gW - 1 ? gW - 1 : x + 1;

        const i  = y  * gW + x;
        const iN = yN * gW + x;
        const iS = yS * gW + x;
        const iW = y  * gW + xW;
        const iE = y  * gW + xE;

        const a = gridA0[i];
        const b = gridB0[i];

        const lapA = gridA0[iN] + gridA0[iS] + gridA0[iW] + gridA0[iE] - 4.0 * a;
        const lapB = gridB0[iN] + gridB0[iS] + gridB0[iW] + gridB0[iE] - 4.0 * b;

        const abb = a * b * b;

        let newA = a + DU_DT * lapA - abb + F_DT * (1.0 - a);
        let newB = b + DV_DT * lapB + abb - FK_DT * b;

        if (newA < 0.0) newA = 0.0; else if (newA > 1.0) newA = 1.0;
        if (newB < 0.0) newB = 0.0; else if (newB > 1.0) newB = 1.0;

        gridA1[i] = newA;
        gridB1[i] = newB;
      }
    }

    // Swap ping-pong buffers — zero allocation
    let tmp = gridA0; gridA0 = gridA1; gridA1 = tmp;
    tmp = gridB0; gridB0 = gridB1; gridB1 = tmp;
  }

  // Dominant band for hue
  let dominantBand = 0;
  let maxAmp = 0;
  for (let band = 0; band < BAND_COUNT; band++) {
    if (amps[band] > maxAmp) { maxAmp = amps[band]; dominantBand = band; }
  }
  const hue = (BAND_HUES[dominantBand] + baseHue) % 360;

  // Color mapping — gridB0 holds current B after the swaps
  buf.loadPixels();
  const px = buf.pixels;

  for (let y = 0; y < newGH; y++) {
    for (let x = 0; x < newGW; x++) {
      const i   = y * newGW + x;
      const bConc = gridB0[i];
      const idx = i * 4;

      if (bConc < 0.05) {
        px[idx] = 5; px[idx + 1] = 3; px[idx + 2] = 12; px[idx + 3] = 255;
      } else {
        const sat = 80 + Math.min(bConc, 1.0) * 10;
        const bri = Math.min(bConc, 1.0) * 100;
        const [r, g, bl] = hsbToRgb(hue, sat, bri);
        px[idx] = r; px[idx + 1] = g; px[idx + 2] = bl; px[idx + 3] = 255;
      }
    }
  }

  buf.updatePixels();
  p.background(5, 3, 12);
  p.noSmooth();
  p.image(buf as unknown as P5Image, 0, 0, W, H);
  p.smooth();
}
