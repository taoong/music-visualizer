/**
 * Nebula — audio-reactive domain-warped fBM cloudscape
 * inspired by Inigo Quilez's domain warping technique
 * (https://iquilezles.org/articles/warp/).
 *
 * Nested fractal Brownian motion layers where one noise field warps
 * another, producing organic billowing painterly forms like alien
 * nebulae or oil paint swirling in water.
 *
 * 7 freq bands modulate warp vectors at different octaves:
 * bass drives large-scale displacement, treble drives fine detail.
 * Beats trigger sudden warp-direction shifts + hue jump.
 *
 * Offscreen pixel buffer at ¼ res (⅛ mobile).
 *
 * Sliders:
 *   Warp     — domain warp magnitude (subtle drift → extreme distortion)
 *   Drift    — animation speed
 *   Palette  — hue rotation for the colour scheme
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;

// ── Permutation table for gradient noise ──────────────────────────────────────
const PERM = new Uint8Array(512);
const GRAD = new Float32Array(512 * 2);
(function initPerm() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Deterministic Fisher-Yates using simple LCG
  let seed = 42;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) {
    PERM[i] = p[i & 255];
    const angle = (PERM[i] / 256) * Math.PI * 2;
    GRAD[i * 2] = Math.cos(angle);
    GRAD[i * 2 + 1] = Math.sin(angle);
  }
})();

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function noise2d(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);

  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi];
  const bb = PERM[PERM[xi + 1] + yi + 1];

  const g00 = GRAD[aa * 2] * xf + GRAD[aa * 2 + 1] * yf;
  const g10 = GRAD[ba * 2] * (xf - 1) + GRAD[ba * 2 + 1] * yf;
  const g01 = GRAD[ab * 2] * xf + GRAD[ab * 2 + 1] * (yf - 1);
  const g11 = GRAD[bb * 2] * (xf - 1) + GRAD[bb * 2 + 1] * (yf - 1);

  const nx0 = g00 + u * (g10 - g00);
  const nx1 = g01 + u * (g11 - g01);
  return nx0 + v * (nx1 - nx0);
}

function fbm(x: number, y: number, octaves: number): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    value += amp * noise2d(x * freq, y * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return value;
}

// ── Module state ──────────────────────────────────────────────────────────────
let time = 0;
let huePhase = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let warpAngle = 0;

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let renderWidth = 0;
let renderHeight = 0;

function initOffscreen(canvasW: number, canvasH: number): void {
  renderWidth = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
}

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

// Per-band warp parameters: [scale, speed-mult, warp-weight]
// Low bands → large slow warps; high bands → fine fast detail
const BAND_WARP: ReadonlyArray<readonly [number, number, number]> = [
  [0.8,  0.4, 1.8],   // sub-bass: large slow billows
  [1.2,  0.6, 1.4],   // bass
  [1.8,  0.9, 1.1],   // low-mid
  [2.5,  1.2, 0.9],   // mid
  [3.2,  1.5, 0.7],   // upper-mid
  [4.0,  1.8, 0.5],   // presence
  [5.5,  2.2, 0.35],  // brilliance: fine fast ripples
] as const;

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawNebula(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const needW = Math.max(1, Math.floor(p.width / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!offscreenCanvas || needW !== renderWidth || needH !== renderHeight) {
    initOffscreen(p.width, p.height);
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      huePhase += 40 + 60 * Math.sin(bi * 1.618);
      beatFlash = 1.0;
      warpAngle += 0.8 + 1.2 * Math.abs(Math.sin(bi * 0.7));
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  const speed = 0.003 + config.nebulaDrift * 0.02;
  time += speed * dt;

  const warpMag = 0.3 + config.nebulaWarp * 3.5;
  const hueBase = config.nebulaPalette * 360 + huePhase;

  let avgAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) avgAmp += amps[b];
  avgAmp /= BAND_COUNT;

  const cosWA = Math.cos(warpAngle);
  const sinWA = Math.sin(warpAngle);

  const imageData = offscreenCtx!.createImageData(renderWidth, renderHeight);
  const pixels = imageData.data;

  for (let py = 0; py < renderHeight; py++) {
    const ny = (py / renderHeight) * 4.0;
    const rowOff = py * renderWidth;

    for (let px = 0; px < renderWidth; px++) {
      const nx = (px / renderWidth) * 4.0;

      // First domain warp layer: fbm displaces coordinates
      const warp1x = fbm(nx + time * 0.3, ny + time * 0.2, 4);
      const warp1y = fbm(nx + 5.2 + time * 0.25, ny + 1.3 + time * 0.15, 4);

      // Audio-reactive warp: each band adds displacement at its own scale
      let audioWarpX = 0;
      let audioWarpY = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const [scale, sm, weight] = BAND_WARP[b];
        const amp = amps[b] * weight;
        audioWarpX += amp * noise2d(nx * scale + time * sm, ny * scale + 3.7);
        audioWarpY += amp * noise2d(nx * scale + 7.1, ny * scale + time * sm);
      }

      // Combine warps with rotation from beats
      const totalWarpX = (warp1x + audioWarpX * 0.6) * warpMag;
      const totalWarpY = (warp1y + audioWarpY * 0.6) * warpMag;
      const rotWarpX = totalWarpX * cosWA - totalWarpY * sinWA;
      const rotWarpY = totalWarpX * sinWA + totalWarpY * cosWA;

      // Second domain warp layer: warp the warped coordinates
      const wx = nx + rotWarpX;
      const wy = ny + rotWarpY;
      const warp2x = fbm(wx + time * 0.15, wy - time * 0.1, 3);
      const warp2y = fbm(wx + 8.3 - time * 0.12, wy + 2.8 + time * 0.08, 3);

      // Final noise value from doubly-warped coordinates
      const fx = wx + warp2x * warpMag * 0.4;
      const fy = wy + warp2y * warpMag * 0.4;
      const v = fbm(fx, fy, 5);

      // Map value to colour
      const hue = ((v * 120 + hueBase) % 360 + 360) % 360;
      const sat = Math.min(1.0, 0.55 + avgAmp * 0.3 + Math.abs(v) * 0.25);
      const bri = Math.min(1.0, Math.max(0.08,
        0.35 + avgAmp * 0.35 + Math.abs(v) * 0.3 + beatFlash * 0.15
      ));

      hsv2rgba(hue, sat, bri, pixels, (rowOff + px) << 2);
    }
  }

  offscreenCtx!.putImageData(imageData, 0, 0);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetNebula(): void {
  offscreenCanvas = null;
  offscreenCtx = null;
  renderWidth = 0;
  renderHeight = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
}
