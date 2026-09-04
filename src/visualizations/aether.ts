/**
 * Aether — domain-warped noise field creating organic cosmic nebulae.
 *
 * Inspired by Refik Anadol's "Unsupervised" (MoMA NYC, 2022–23,
 * https://www.moma.org/calendar/exhibitions/5535) — large-scale machine
 * learning data sculptures that turn MoMA's 200-year collection into
 * a living dream. The aesthetic: deep darkness punctuated by pools of
 * luminous color that form, flow, and dissolve as though the data itself
 * is thinking. This visualization approximates that look through
 * layered domain-warped noise (Inigo Quilez's "warping" technique,
 * https://iquilezles.org/articles/warp/), where the coordinate space
 * itself is bent by a noise field before sampling, creating complex
 * swirling tendrils and whorls impossible with simple wave superposition.
 *
 * 7 frequency bands each occupy a distinct hue zone in the noise field;
 * their amplitudes modulate the brightness of their respective regions so
 * the nebula breathes with the music. Loud passages produce vivid luminous
 * clouds; quiet passages let the field settle into deep monochromes.
 * Beats fire a hue palette jump and a brief brightness surge.
 *
 * Rendering: pixel buffer at ¼ res (⅛ mobile) via HTMLCanvasElement.
 *
 * Sliders
 *   Turbulence — warp intensity (0 = smooth gradient clouds → 1 = complex swirling tendrils)
 *   Flow       — animation speed (0 = near-static → 1 = fast-churning)
 *   Palette    — colour saturation (0 = monochrome nebula → 1 = full chromatic neon)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;

// Hue per band: sub-bass=violet, bass=blue, lowMid=teal, mid=green,
//               upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 170, 120, 60, 30, 0];

// ── Module state ──────────────────────────────────────────────────────────────
let time = 0;
let huePhase = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let imgData: ImageData | null = null;
let renderWidth = 0;
let renderHeight = 0;

// ── Fast value noise ──────────────────────────────────────────────────────────

function wangHash(n: number): number {
  n = (((n ^ 61) ^ (n >>> 16)) >>> 0);
  n = ((n + (n << 3)) >>> 0);
  n = ((n ^ (n >>> 4)) >>> 0);
  n = (Math.imul(n, 0x27d4eb2d) >>> 0);
  n = ((n ^ (n >>> 15)) >>> 0);
  return (n & 0xffff) / 65535;
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x) & 0xfff;
  const iy = Math.floor(y) & 0xfff;
  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = ix + iy * 4096;
  const a = wangHash(h);
  const b = wangHash(h + 1);
  const c = wangHash(h + 4096);
  const d = wangHash(h + 4097);
  return a + ux * (b - a) + uy * (c - a) + ux * uy * (a - b - c + d);
}

// Two-octave fractional Brownian motion
function fbm(x: number, y: number): number {
  return valueNoise(x, y) * 0.67 + valueNoise(x * 2.13, y * 2.13) * 0.33;
}

// ── Offscreen canvas setup ───────────────────────────────────────────────────

function initOffscreen(w: number, h: number): void {
  renderWidth  = Math.max(1, Math.floor(w / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(h / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width  = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
  imgData = offscreenCtx.createImageData(renderWidth, renderHeight);
}

// ── HSV → pixel write ────────────────────────────────────────────────────────

function hsv2pixel(
  h: number, s: number, v: number,
  pixels: Uint8ClampedArray, off: number,
): void {
  h = ((h % 360) + 360) % 360;
  const h6 = h / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  const p  = v * (1 - s);
  const q  = v * (1 - s * f);
  const u  = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (i) {
    case 0:  r = v; g = u; b = p; break;
    case 1:  r = q; g = v; b = p; break;
    case 2:  r = p; g = v; b = u; break;
    case 3:  r = p; g = q; b = v; break;
    case 4:  r = u; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  pixels[off    ] = (r * 255 + 0.5) | 0;
  pixels[off + 1] = (g * 255 + 0.5) | 0;
  pixels[off + 2] = (b * 255 + 0.5) | 0;
  pixels[off + 3] = 255;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawAether(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const w = p.width;
  const h = p.height;

  if (!offscreenCanvas || renderWidth !== Math.floor(w / PIXEL_SCALE)) {
    initOffscreen(w, h);
  }
  if (!offscreenCtx || !imgData) return;

  const turbulence = config.aetherTurbulence; // 0–1
  const flow       = config.aetherFlow;       // 0–1
  const palette    = config.aetherPalette;    // 0–1

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos  = audioEngine.getPlaybackPosition();
    const adj  = pos - state.beatOffset;
    const bi   = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      huePhase  += 45 + Math.random() * 90;
      beatFlash  = 0.5;
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  // Advance time
  const speedScale = 0.0008 + flow * 0.004;
  time += dt * speedScale;

  // Average amplitude and dominant hue
  let totalAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) totalAmp += amps[b];
  totalAmp /= BAND_COUNT;

  // Warp strength: turbulence slider + audio reactivity
  const warpStr = turbulence * (0.6 + totalAmp * 1.4) * 2.0;

  const pixels = imgData.data;

  for (let py = 0; py < renderHeight; py++) {
    const ny = py / renderHeight;
    for (let px = 0; px < renderWidth; px++) {
      const nx = px / renderWidth;

      // Domain warp layer 1: displace coordinates by fbm
      const d1x = fbm(nx * 3.1 + time * 0.55, ny * 3.1 + 1.13) * 2 - 1;
      const d1y = fbm(nx * 3.1 + 2.34, ny * 3.1 + time * 0.38) * 2 - 1;
      const wx1 = nx * 4.0 + d1x * warpStr;
      const wy1 = ny * 4.0 + d1y * warpStr;

      // Domain warp layer 2: warp the already-warped coordinates
      const d2x = fbm(wx1 * 0.93 + time * 0.18, wy1 * 0.93 + 5.71) * 2 - 1;
      const d2y = fbm(wx1 * 0.93 + 3.82, wy1 * 0.93 + time * 0.14) * 2 - 1;
      const wx2 = wx1 + d2x * warpStr * 0.45;
      const wy2 = wy1 + d2y * warpStr * 0.45;

      // Final pattern value at doubly-warped position
      const val = fbm(wx2 + time * 0.28, wy2 + time * 0.19);

      // val ∈ [0,1] maps linearly to band index 0–6
      const bandF  = val * (BAND_COUNT - 1);
      const bandLo = bandF | 0;
      const bandHi = Math.min(bandLo + 1, BAND_COUNT - 1);
      const bandMix = bandF - bandLo;

      // Interpolate hue across adjacent band hues
      const h1 = BAND_HUES[bandLo];
      const h2 = BAND_HUES[bandHi];
      let hueDiff = h2 - h1;
      if (hueDiff > 180) hueDiff -= 360;
      if (hueDiff < -180) hueDiff += 360;
      const hue = h1 + hueDiff * bandMix + huePhase;

      // Per-pixel amplitude from the two straddled bands
      const localAmp = amps[bandLo] * (1 - bandMix) + amps[bandHi] * bandMix;

      // Brightness: dark background unless audio activates this zone
      const brightness = Math.min(1,
        (0.08 + localAmp * 0.75 + val * 0.12) * (1 + beatFlash * 0.6),
      );

      const off = (py * renderWidth + px) * 4;
      hsv2pixel(hue, palette, brightness, pixels, off);
    }
  }

  offscreenCtx.putImageData(imgData, 0, 0);

  (p.drawingContext as CanvasRenderingContext2D).imageSmoothingEnabled = true;
  p.image(offscreenCanvas as unknown as P5Image, 0, 0, w, h);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetAether(): void {
  time           = 0;
  huePhase       = 0;
  lastBeatIndex  = -1;
  beatFlash      = 0;
  offscreenCanvas = null;
  offscreenCtx   = null;
  imgData        = null;
  renderWidth    = 0;
  renderHeight   = 0;
}
