/**
 * Marbling — full-screen psychedelic plasma pattern driven by audio.
 *
 * 7 frequency bands each modulate a sinusoidal wave component whose
 * x-frequency, y-frequency, and animation speed are uniquely tuned.
 * All waves superpose into a value that maps to a hue, producing
 * smoothly shifting tie-dye / marble-paper colour fields.
 * Beat detection triggers hue-phase jumps and brightness flashes.
 *
 * Rendering: offscreen HTMLCanvasElement pixel buffer at 1/4 resolution
 * (1/8 on mobile), scaled up with imageSmoothingEnabled for a soft look.
 *
 * Sliders
 *   Hue Shift  — offset for the entire colour palette (0 → 360°)
 *   Zoom       — spatial density: low = large blobs, high = fine weave
 *   Speed      — animation flow rate: slow drift to frantic churn
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Pixels per sample point — lower = higher quality, more CPU
const PIXEL_SCALE = isMobile ? 8 : 4;

// Per-band wave parameters: [x-frequency, y-frequency, time-speed-multiplier]
// Low bands → lower frequencies / slower motion; high bands → fast, fine detail
const BAND_WAVES: ReadonlyArray<readonly [number, number, number]> = [
  [1.3, 0.7, 0.75],   // sub-bass
  [2.1, 1.4, 0.95],   // bass
  [0.9, 2.5, 1.15],   // low-mid
  [3.1, 1.1, 1.35],   // mid
  [1.7, 3.3, 1.55],   // upper-mid
  [3.7, 2.0, 1.85],   // presence
  [2.4, 4.1, 2.25],   // brilliance
] as const;

// ── Module state ──────────────────────────────────────────────────────────────
let time = 0;
let huePhase = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let renderWidth = 0;
let renderHeight = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function initOffscreen(canvasW: number, canvasH: number): void {
  renderWidth = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
}

/** HSV → RGBA write into a Uint8ClampedArray at byte offset `off`. */
function hsv2rgba(
  h: number, s: number, v: number,
  pixels: Uint8ClampedArray, off: number
): void {
  const h6 = ((h % 360) + 360) % 360 / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  const p  = v * (1 - s);
  const q  = v * (1 - s * f);
  const uv = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (i) {
    case 0:  r = v;  g = uv; b = p;  break;
    case 1:  r = q;  g = v;  b = p;  break;
    case 2:  r = p;  g = v;  b = uv; break;
    case 3:  r = p;  g = q;  b = v;  break;
    case 4:  r = uv; g = p;  b = v;  break;
    default: r = v;  g = p;  b = q;  break;
  }
  pixels[off]     = (r * 255 + 0.5) | 0;
  pixels[off + 1] = (g * 255 + 0.5) | 0;
  pixels[off + 2] = (b * 255 + 0.5) | 0;
  pixels[off + 3] = 255;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMarbling(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Init / resize check
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!offscreenCanvas || needW !== renderWidth || needH !== renderHeight) {
    initOffscreen(p.width, p.height);
  }

  // Beat detection — hue jump + flash
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      huePhase += 55 + Math.random() * 70;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.87, dt);

  // Advance animation time
  const speed = 0.005 + config.marblingSpeed * 0.025;
  time += speed * dt;

  // Zoom: maps slider [0,1] → spatial scale [0.4, 3.2]
  const zs = 0.4 + config.marblingZoom * 2.8;

  // Global hue base: slider shifts the palette + accumulated beat jumps
  const hueBase = config.marblingHue * 360 + huePhase;

  // Per-frame averages (constant inside the pixel loop)
  let avgAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) avgAmp += amps[b];
  avgAmp /= BAND_COUNT;

  // Pre-weight band amplitudes so the hot loop avoids repeated multiplications
  const ampW = new Float64Array(BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) {
    ampW[b] = 0.14 + amps[b] * 1.7;
  }

  // Global saturation / brightness — constant per frame
  const sat = Math.min(1.0, 0.65 + avgAmp * 0.32 + beatFlash * 0.06);
  const bri = Math.min(1.0, Math.max(0.15, 0.40 + avgAmp * 0.30 + beatFlash * 0.14));

  const TWO_PI    = Math.PI * 2;
  const imageData = offscreenCtx!.createImageData(renderWidth, renderHeight);
  const pixels    = imageData.data;

  for (let py = 0; py < renderHeight; py++) {
    const ny     = (py / renderHeight) * TWO_PI * zs;
    const rowOff = py * renderWidth;

    for (let px = 0; px < renderWidth; px++) {
      const nx = (px / renderWidth) * TWO_PI * zs;

      // Three base plasma waves — always active, produce pattern at silence
      let v = Math.sin(nx        +         time)        * 0.55
            + Math.sin(ny * 1.05 + time * 1.18)         * 0.55
            + Math.sin(nx * 1.3  + ny * 0.9 + time * 0.88) * 0.65;

      // Seven audio-reactive band waves
      for (let b = 0; b < BAND_COUNT; b++) {
        const [fx, fy, sm] = BAND_WAVES[b];
        v += ampW[b] * Math.sin(nx * fx + ny * fy + time * sm);
      }

      // Map v → hue: 25° per unit gives several visible colour bands
      const hue = ((v * 25 + hueBase) % 360 + 360) % 360;

      hsv2rgba(hue, sat, bri, pixels, (rowOff + px) << 2);
    }
  }

  offscreenCtx!.putImageData(imageData, 0, 0);

  // Scale pixel buffer up to full canvas size
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetMarbling(): void {
  // Force canvas reinit on next draw (handles resize)
  offscreenCanvas = null;
  offscreenCtx    = null;
  renderWidth     = 0;
  renderHeight    = 0;
  lastBeatIndex   = -1;
  beatFlash       = 0;
  // time and huePhase intentionally preserved across resize for seamless experience
}
