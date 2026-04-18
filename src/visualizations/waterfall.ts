/**
 * Waterfall — Scrolling spectrogram.
 *
 * Each frame's spectrum becomes a thin vertical strip painted on the right
 * edge of an offscreen buffer; the buffer is shifted left each frame so
 * older frames trail away. Sustained tones form horizontal streaks;
 * transients form bright vertical bursts.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandData } from './helpers';
import { BAND_COUNT, SPIKES_PER_BAND } from '../utils/constants';

// ── Buffer state ─────────────────────────────────────────────────────────────
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let bufWidth = 0;
let bufHeight = 0;

let lastBeatIndex = -1;
let beatFlash = 0;

// ── Color LUT (256 × RGB) ────────────────────────────────────────────────────
const COLOR_LUT = new Uint8Array(256 * 3);
let currentHueShift = -1;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [
    Math.max(0, Math.min(255, Math.round((r + m) * 255))),
    Math.max(0, Math.min(255, Math.round((g + m) * 255))),
    Math.max(0, Math.min(255, Math.round((b + m) * 255))),
  ];
}

function buildLUT(hueShift: number): void {
  // Hue sweeps 210° downward from baseHue as amplitude climbs — low amp sits
  // near purple/blue, high amp pushes toward yellow-white.
  const baseHue = (270 + hueShift * 360) % 360;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const hue = ((baseHue - t * 210) % 360 + 360) % 360;
    const sat = 0.6 + t * 0.4;
    const light = t * t * 0.55 + t * 0.05;
    const [r, g, b] = hslToRgb(hue, sat, light);
    COLOR_LUT[i * 3] = r;
    COLOR_LUT[i * 3 + 1] = g;
    COLOR_LUT[i * 3 + 2] = b;
  }
  currentHueShift = hueShift;
}

// ── Buffer lifecycle ─────────────────────────────────────────────────────────
function ensureBuffer(w: number, h: number): void {
  if (offscreenCanvas && bufWidth === w && bufHeight === h) return;
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = w;
  offscreenCanvas.height = h;
  offscreenCtx = offscreenCanvas.getContext('2d');
  if (offscreenCtx) {
    offscreenCtx.fillStyle = '#000000';
    offscreenCtx.fillRect(0, 0, w, h);
  }
  bufWidth = w;
  bufHeight = h;
}

// ── Draw ─────────────────────────────────────────────────────────────────────
export function drawWaterfall(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const w = p.width;
  const h = p.height;

  ensureBuffer(w, h);
  if (!offscreenCtx || !offscreenCanvas) return;

  if (currentHueShift !== config.waterfallHue) {
    buildLUT(config.waterfallHue);
  }

  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;
  const totalBins = bandCount * SPIKES_PER_BAND;
  const binHeight = h / totalBins;

  const scrollPx = Math.max(1, Math.round(1 + config.waterfallScrollSpeed * 5));
  const gain = 0.5 + config.waterfallGain * 3.5;

  // Beat tracking — tick the beat accent when the index advances.
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.85, dt);
  if (beatFlash < 0.001) beatFlash = 0;

  // Shift the buffer left. drawImage from a canvas onto itself is spec-defined
  // via an implicit temp buffer, so source/dest overlap is handled correctly.
  offscreenCtx.drawImage(offscreenCanvas, -scrollPx, 0);

  // Clear and repaint the right edge column with the current spectrum.
  const xCol = w - scrollPx;
  offscreenCtx.fillStyle = '#000000';
  offscreenCtx.fillRect(xCol, 0, scrollPx, h);

  const binDrawH = Math.ceil(binHeight) + 1;
  for (let b = 0; b < bandCount; b++) {
    for (let i = 0; i < SPIKES_PER_BAND; i++) {
      const { amp, tMult, delta } = getBandData(b, i);
      const boosted = amp * tMult * gain + delta * 0.15;
      const intensity = Math.max(0, Math.min(1, boosted));
      if (intensity < 0.01) continue;

      const lutOff = Math.min(255, Math.round(intensity * 255)) * 3;
      offscreenCtx.fillStyle = `rgb(${COLOR_LUT[lutOff]},${COLOR_LUT[lutOff + 1]},${COLOR_LUT[lutOff + 2]})`;

      const binIdx = b * SPIKES_PER_BAND + i;
      const y = h - (binIdx + 1) * binHeight;
      offscreenCtx.fillRect(xCol, y, scrollPx, binDrawH);
    }
  }

  if (beatFlash > 0.1) {
    offscreenCtx.fillStyle = `rgba(255, 255, 255, ${beatFlash * 0.25})`;
    offscreenCtx.fillRect(xCol, 0, scrollPx, h);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainCtx = (p as any).drawingContext as CanvasRenderingContext2D;
  mainCtx.drawImage(offscreenCanvas, 0, 0);
}

export function resetWaterfall(): void {
  offscreenCanvas = null;
  offscreenCtx = null;
  bufWidth = 0;
  bufHeight = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
}
