/**
 * Ink Wash — audio-reactive sumi-e (墨絵) ink diffusion on parchment,
 * inspired by Andy Ye's generative ink wash experiments at NYU ITP
 * (https://wp.nyu.edu/andyhyperillion/2023/03/27/noc-project-a-generative-interactive-ink-wash/)
 * and the ancient Japanese art of suminagashi (墨流し, "floating ink").
 *
 * A grid-based diffusion simulation spreads ink organically across a warm
 * cream parchment canvas. Seven frequency bands each deposit ink at
 * distributed positions; amplitude drives concentration; beats trigger
 * bold splash blobs with a hue-palette shift. Diffusion is biased
 * slightly downward (gravity drip) and perturbed by sinusoidal wobble
 * for organic, feathered edges. Old ink slowly evaporates (dries).
 *
 * Rendering: ping-pong Float32Array concentration grid + fixed hue grid;
 * offscreen pixel buffer at ¼ res (⅙ mobile); warm parchment background
 * with dark tinted ink — a deliberately light-canvas aesthetic unique in
 * the collection.
 *
 * Sliders
 *   Flow    — diffusion speed (tight drops → wide bleeding)
 *   Ink     — drop density / concentration per audio event
 *   Dry     — evaporation rate (persistent stains → fast fading)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 4;

const BAND_HUES = [280, 230, 180, 120, 60, 30, 0];

const BG_R = 242;
const BG_G = 227;
const BG_B = 207;

let conc0: Float32Array = new Float32Array(0);
let conc1: Float32Array = new Float32Array(0);
let hueGrid: Float32Array = new Float32Array(0);
let gW = 0;
let gH = 0;

let lastBeatIndex = -1;
let baseHue = 0;
let time = 0;

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let rW = 0;
let rH = 0;
let cachedImageData: ImageData | null = null;

function initGrids(w: number, h: number): void {
  gW = w;
  gH = h;
  const size = gW * gH;
  conc0 = new Float32Array(size);
  conc1 = new Float32Array(size);
  hueGrid = new Float32Array(size);
}

function initCanvas(w: number, h: number): void {
  rW = w;
  rH = h;
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = rW;
  offscreenCanvas.height = rH;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
  cachedImageData = offscreenCtx.createImageData(rW, rH);
}

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100;
  b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function lerpHue(a: number, b: number, t: number): number {
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((a + diff * t) % 360 + 360) % 360;
}

function depositDisk(cx: number, cy: number, radius: number, amount: number, hue: number): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(gW - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(gH - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / radius;
      const dep = amount * falloff * falloff;
      const idx = y * gW + x;
      const oldC = conc0[idx];
      const newC = Math.min(1, oldC + dep);
      conc0[idx] = newC;
      if (oldC > 0.01) {
        hueGrid[idx] = lerpHue(hueGrid[idx], hue, dep / (oldC + dep));
      } else {
        hueGrid[idx] = hue;
      }
    }
  }
}

export function drawInk(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const config = store.config;
  const state = store.state;

  const newW = Math.max(1, Math.floor(W / PIXEL_SCALE));
  const newH = Math.max(1, Math.floor(H / PIXEL_SCALE));

  if (gW !== newW || gH !== newH) initGrids(newW, newH);
  if (rW !== newW || rH !== newH) initCanvas(newW, newH);
  if (!offscreenCtx || !cachedImageData) return;

  const { amps, transients } = getBandAverages(BAND_COUNT);

  const flow = 0.04 + config.inkFlow * 0.36;
  const density = 0.2 + config.inkDensity * 1.8;
  const dry = 0.0008 + config.inkDry * 0.012;

  const dtNorm = dt / 16.667;
  time += dtNorm * 0.02;

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      baseHue = (baseHue + 18) % 360;
      const sx = gW * 0.2 + Math.random() * gW * 0.6;
      const sy = gH * 0.15 + Math.random() * gH * 0.5;
      const sr = 3 + Math.random() * gW * 0.04;
      const sh = BAND_HUES[Math.floor(Math.random() * BAND_COUNT)];
      depositDisk(sx, sy, sr, 0.7, (sh + baseHue) % 360);
    }
  }

  const totalAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.04) continue;

    const bx = (b + 0.5) / BAND_COUNT * gW * 0.8 + gW * 0.1;
    const wobbleX = Math.sin(time * 3.1 + b * 2.1) * gW * 0.04;
    const wobbleY = Math.cos(time * 2.3 + b * 1.7) * gH * 0.06;
    const cx = bx + wobbleX;
    const cy = gH * 0.35 + wobbleY + Math.sin(time * 1.1 + b * 0.9) * gH * 0.15;

    const r = 1.5 + amp * 3;
    const amount = amp * density * 0.06;
    const hue = (BAND_HUES[b] + baseHue) % 360;
    depositDisk(cx, cy, r, amount, hue);

    if (transients[b] > 1.4) {
      const splashR = r * 1.5;
      depositDisk(cx + (Math.random() - 0.5) * 6, cy + (Math.random() - 0.5) * 6,
        splashR, amount * 0.5, hue);
    }
  }

  const gravBias = 0.06;
  const wUp = 1 - gravBias;
  const wDown = 1 + gravBias;
  const wSide = 1;
  const wTotal = wUp + wDown + wSide * 2;
  const evap = dry * dtNorm;

  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const idx = y * gW + x;
      const c = conc0[idx];

      const l = x > 0 ? conc0[idx - 1] : c;
      const r = x < gW - 1 ? conc0[idx + 1] : c;
      const u = y > 0 ? conc0[idx - gW] : c;
      const d = y < gH - 1 ? conc0[idx + gW] : c;

      const wobble = Math.sin(x * 0.3 + y * 0.2 + time * 5) * 0.015;
      const avg = (l * wSide + r * wSide + u * wUp + d * wDown) / wTotal;
      const diffused = c + (avg - c) * (flow + wobble) * dtNorm;

      conc1[idx] = Math.max(0, diffused - evap);
    }
  }

  const tmp = conc0;
  conc0 = conc1;
  conc1 = tmp;

  const px = cachedImageData.data;
  for (let i = 0; i < gW * gH; i++) {
    const c = conc0[i];
    const pi = i * 4;

    if (c < 0.003) {
      px[pi] = BG_R;
      px[pi + 1] = BG_G;
      px[pi + 2] = BG_B;
      px[pi + 3] = 255;
      continue;
    }

    const alpha = Math.min(1, c * 2.5);
    const h = hueGrid[i];
    const sat = 25 + totalAmp * 30;
    const bri = Math.max(8, 92 - c * 84);
    const [ir, ig, ib] = hsbToRgb(h, sat, bri);

    px[pi] = Math.round(BG_R + (ir - BG_R) * alpha);
    px[pi + 1] = Math.round(BG_G + (ig - BG_G) * alpha);
    px[pi + 2] = Math.round(BG_B + (ib - BG_B) * alpha);
    px[pi + 3] = 255;
  }

  offscreenCtx.putImageData(cachedImageData, 0, 0);

  p.background(BG_R, BG_G, BG_B);
  const img = offscreenCanvas as unknown as P5Image;
  p.noSmooth();
  p.image(img, 0, 0, W, H);
  p.smooth();
}

export function resetInk(): void {
  conc0 = new Float32Array(0);
  conc1 = new Float32Array(0);
  hueGrid = new Float32Array(0);
  gW = 0;
  gH = 0;
  lastBeatIndex = -1;
  baseHue = 0;
  time = 0;
  offscreenCanvas = null;
  offscreenCtx = null;
  rW = 0;
  rH = 0;
  cachedImageData = null;
}
