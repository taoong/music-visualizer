/**
 * Color Map — Pixel-level audio-reactive color modulation.
 * User image (or rainbow gradient fallback) has its colors boosted
 * per-pixel based on which of the 7 frequency bands matches each pixel's hue.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImage, hasUserImage } from './userImage';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SIZE = 512;

// Band → hue range mapping (degrees)
const BAND_HUE_RANGES: [number, number][] = [
  [0, 30],     // 0 Sub       – Red
  [30, 60],    // 1 Bass      – Orange
  [60, 90],    // 2 Low-Mid   – Yellow
  [90, 180],   // 3 Mid       – Green
  [180, 240],  // 4 Upper-Mid – Cyan/Blue
  [240, 300],  // 5 Presence  – Blue/Indigo
  [300, 360],  // 6 Brilliance– Purple/Magenta
];

// ── Module state ──────────────────────────────────────────────────────────────

let initialized = false;
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let sourceImageData: ImageData | null = null;
let renderWidth = 0;
let renderHeight = 0;

// Precomputed hue → band lookup (360 entries)
const hueToBand = new Uint8Array(360);

// Beat flash state
let beatFlash = 0;
let lastBeatIndex = -1;

// Image change listener
let imageUnsub: (() => void) | null = null;

// ── Initialization ────────────────────────────────────────────────────────────

function buildHueLookup(): void {
  for (let h = 0; h < 360; h++) {
    for (let b = 0; b < BAND_HUE_RANGES.length; b++) {
      const [lo, hi] = BAND_HUE_RANGES[b];
      if (h >= lo && h < hi) {
        hueToBand[h] = b;
        break;
      }
    }
  }
}

function createOffscreen(w: number, h: number): void {
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = w;
  offscreenCanvas.height = h;
  offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true })!;
  renderWidth = w;
  renderHeight = h;
}

function loadSource(): void {
  if (!offscreenCtx) return;

  if (hasUserImage()) {
    const img = getUserImage();
    if (!img) return;

    // Downscale to fit MAX_SIZE
    const iw = img.width as number;
    const ih = img.height as number;
    const scale = Math.min(1, MAX_SIZE / Math.max(iw, ih));
    const w = Math.round(iw * scale);
    const h = Math.round(ih * scale);

    if (w !== renderWidth || h !== renderHeight) {
      createOffscreen(w, h);
    }

    // Draw p5 image to canvas via its underlying canvas element
    const srcCanvas = (img as any).canvas || (img as any).elt;
    if (srcCanvas) {
      offscreenCtx!.drawImage(srcCanvas, 0, 0, w, h);
    }
  } else {
    // Rainbow gradient fallback
    const w = MAX_SIZE;
    const h = Math.round(MAX_SIZE * 0.5625); // 16:9 aspect
    if (w !== renderWidth || h !== renderHeight) {
      createOffscreen(w, h);
    }
    drawRainbowGradient();
  }

  sourceImageData = offscreenCtx!.getImageData(0, 0, renderWidth, renderHeight);
}

function drawRainbowGradient(): void {
  if (!offscreenCtx) return;
  const w = renderWidth;
  const h = renderHeight;

  for (let x = 0; x < w; x++) {
    const hue = (x / w) * 360;
    offscreenCtx.fillStyle = `hsl(${hue}, 80%, 50%)`;
    offscreenCtx.fillRect(x, 0, 1, h);
  }
}

function init(): void {
  buildHueLookup();
  createOffscreen(MAX_SIZE, Math.round(MAX_SIZE * 0.5625));
  loadSource();

  imageUnsub = store.on('imageChange', () => {
    // Slight delay to let the image load
    setTimeout(() => loadSource(), 100);
  });

  initialized = true;
}

// ── Color conversion helpers ──────────────────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawColormap(p: P5Instance, dt: number): void {
  if (!initialized) init();
  if (!sourceImageData || !offscreenCtx || !offscreenCanvas) return;

  const { amps } = getBandAverages(7);
  const intensity = store.config.intensity ?? 1.0;

  // Beat detection
  const { state } = store;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex > lastBeatIndex) {
      beatFlash = 1.0;
      lastBeatIndex = beatIndex;
    }
  }

  // Decay beat flash
  beatFlash *= Math.pow(0.85, dt);
  if (beatFlash < 0.01) beatFlash = 0;

  // Process pixels
  const src = sourceImageData.data;
  const len = src.length;
  const working = new Uint8ClampedArray(len);

  for (let i = 0; i < len; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const a = src[i + 3];

    const [hue, sat, light] = rgbToHsl(r, g, b);
    const band = hueToBand[Math.floor(hue) % 360];
    const amp = amps[band] ?? 0;

    // Boost saturation and lightness based on band amplitude
    const boost = amp * intensity * 2.0;
    const newSat = Math.min(1, sat + boost * 0.5);
    const newLight = Math.min(1, light + boost * 0.3 + beatFlash * 0.15);

    const [nr, ng, nb] = hslToRgb(hue, newSat, newLight);
    working[i] = nr;
    working[i + 1] = ng;
    working[i + 2] = nb;
    working[i + 3] = a;
  }

  // Put processed pixels to offscreen canvas
  const outData = new ImageData(working, renderWidth, renderHeight);
  offscreenCtx.putImageData(outData, 0, 0);

  // Draw to main canvas scaled to fill
  const canvas = (p as any).drawingContext as CanvasRenderingContext2D;
  const cw = p.width;
  const ch = p.height;

  // Cover-fit: scale to fill while maintaining aspect ratio
  const srcAspect = renderWidth / renderHeight;
  const dstAspect = cw / ch;
  let drawW: number, drawH: number, drawX: number, drawY: number;

  if (srcAspect > dstAspect) {
    drawH = ch;
    drawW = ch * srcAspect;
    drawX = (cw - drawW) / 2;
    drawY = 0;
  } else {
    drawW = cw;
    drawH = cw / srcAspect;
    drawX = 0;
    drawY = (ch - drawH) / 2;
  }

  canvas.drawImage(offscreenCanvas, drawX, drawY, drawW, drawH);
}

export function resetColormap(): void {
  // Re-load source on resize (offscreen is fixed, but this ensures fresh state)
  if (initialized) {
    loadSource();
  }
}

export function disposeColormap(): void {
  if (imageUnsub) {
    imageUnsub();
    imageUnsub = null;
  }
  offscreenCanvas = null;
  offscreenCtx = null;
  sourceImageData = null;
  initialized = false;
  beatFlash = 0;
  lastBeatIndex = -1;
}
