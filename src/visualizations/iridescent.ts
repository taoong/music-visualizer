/**
 * Iridescent — audio-reactive thin-film interference color field.
 *
 * Inspired by Refik Anadol's "Unsupervised" (MoMA, 2022–2023,
 * https://refikanadol.com/works/unsupervised/), which renders luminous,
 * iridescent forms that shift through the colour spectrum like soap films,
 * butterfly wings, and opalescent minerals responding to data.
 *
 * Algorithm: per-pixel film thickness d (nm) is computed from a slow-drifting
 * sine-based noise field plus 7 audio-band sinusoidal waves (each at a unique
 * spatial frequency and angle). Thickness is converted to RGB via the
 * thin-film interference equations — the same physics that makes soap bubbles
 * rainbow-coloured: for each wavelength λ, intensity = 0.5 + 0.5·cos(4πnd/λ)
 * where n = 1.35 (soap-film refractive index). A saturation boost removes the
 * grey baseline so the palette stays vivid. Beat events fire expanding circular
 * ripples that add a bright "wash" of shifted colour across the canvas.
 *
 * Rendering: offscreen HTMLCanvasElement pixel buffer at ¼ res (⅙ mobile),
 * smoothly scaled up for a soft, painterly finish.
 *
 * Sliders
 *   Film   — thickness scale: low = vivid first-order soap colours;
 *             high = denser multi-order pattern (peacock-tail effect)
 *   Ripple — how strongly the 7 frequency bands modulate the colour field
 *   Speed  — base drift animation rate
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 4;

// Thin-film physics constants
const N_IDX = 1.35; // soap-film refractive index
const WL_R  = 680;  // red wavelength (nm)
const WL_G  = 540;  // green wavelength (nm)
const WL_B  = 460;  // blue wavelength (nm)
const TWO_PI = Math.PI * 2;

// Per-band spatial parameters: [spatialFrequency, angle (radians), timeSpeed]
// Lower bands → larger, slower waves; higher bands → finer, faster ripples
const BAND_FREQ:   readonly number[] = [1.4, 2.2, 3.0, 4.1, 5.2, 6.4, 7.8];
const BAND_ANGLE:  readonly number[] = [0.000, 0.449, 0.898, 1.347, 1.796, 2.245, 2.694]; // π/7 steps
const BAND_TSPEED: readonly number[] = [0.28, 0.45, 0.65, 0.85, 1.10, 1.38, 1.72];

// ── Module state ──────────────────────────────────────────────────────────────
let t          = 0;       // animation clock
let hueOffset  = 0;       // accumulated beat-triggered palette shift (nm)
let lastBeatIndex = -1;
let beatFlash  = 0;

type Ripple = { r: number; str: number };
let beatRipples: Ripple[] = [];

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx:    CanvasRenderingContext2D | null = null;
let renderWidth  = 0;
let renderHeight = 0;

// Precomputed per-band dot-product coefficients for the inner loop
const cosBand = new Float64Array(BAND_COUNT);
const sinBand = new Float64Array(BAND_COUNT);
for (let b = 0; b < BAND_COUNT; b++) {
  cosBand[b] = Math.cos(BAND_ANGLE[b]);
  sinBand[b] = Math.sin(BAND_ANGLE[b]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initOffscreen(w: number, h: number): void {
  renderWidth  = Math.max(1, Math.floor(w / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(h / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width  = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
}

/** Sine-based turbulence noise — returns roughly [-1, 1]. */
function baseField(nx: number, ny: number, time: number): number {
  return (
    Math.sin(nx * 1.7 + ny * 1.2 + time * 0.38) * 0.35 +
    Math.sin(nx * 2.8 - ny * 1.9 + time * 0.53) * 0.35 +
    Math.sin(nx * 0.9 + ny * 3.1 + time * 0.29) * 0.30
  );
}

/**
 * Write thin-film interference RGB to pixels[off…off+3].
 * d = film thickness in nm; brightness ∈ [0,1].
 * Saturation boost strips the grey floor so colours stay vivid.
 */
function writeFilmColor(
  d: number,
  brightness: number,
  pixels: Uint8ClampedArray,
  off: number
): void {
  // Interference intensity for each colour channel
  const kd2 = TWO_PI * 2 * N_IDX * d;
  let r = 0.5 + 0.5 * Math.cos(kd2 / WL_R + Math.PI);
  let g = 0.5 + 0.5 * Math.cos(kd2 / WL_G + Math.PI);
  let b = 0.5 + 0.5 * Math.cos(kd2 / WL_B + Math.PI);

  // Saturation boost: subtract common grey floor (pushes toward vivid primaries)
  const floor = Math.min(r, g, b) * 0.85;
  r -= floor;
  g -= floor;
  b -= floor;

  // Normalise to brightest channel and apply amplitude brightness
  const maxC = Math.max(r, g, b, 0.001);
  const sc   = brightness / maxC;
  pixels[off]     = Math.min(255, (r * sc * 255 + 0.5)) | 0;
  pixels[off + 1] = Math.min(255, (g * sc * 255 + 0.5)) | 0;
  pixels[off + 2] = Math.min(255, (b * sc * 255 + 0.5)) | 0;
  pixels[off + 3] = 255;
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawIridescent(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Init / resize
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!offscreenCanvas || needW !== renderWidth || needH !== renderHeight) {
    initOffscreen(p.width, p.height);
  }

  // Beat detection — palette jump + ripple ring
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      hueOffset  = (hueOffset + 90 + Math.random() * 140);
      beatFlash  = 1.0;
      beatRipples.push({ r: 0, str: 1.0 });
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  // Advance animation clock
  const speed = 0.003 + config.iridSpeed * 0.018;
  t += speed * dt;

  // Update ripple rings
  for (const rip of beatRipples) {
    rip.r   += dt * 0.009;
    rip.str *= Math.pow(0.972, dt);
  }
  beatRipples = beatRipples.filter(rip => rip.r < 1.6 && rip.str > 0.01);

  // Overall amplitude → brightness
  let avgAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) avgAmp += amps[b];
  avgAmp /= BAND_COUNT;
  const brightness = Math.min(1.0, 0.48 + avgAmp * 0.42 + beatFlash * 0.12);

  // Pre-compute per-band temporal phases
  const bandPhase = new Float64Array(BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) {
    bandPhase[b] = t * BAND_TSPEED[b];
  }

  // Film thickness parameters (nm)
  // dBase is the centre of the vivid first-order range, plus beat-shifted offset
  const dBase  = 200 + (hueOffset % 2000) * 0.12;
  // dRange scales with Film slider: 1.0 → ±250nm variation, 0.1 → ±25nm (very smooth)
  const dRange = 250 * config.iridFilm;

  const imageData = offscreenCtx!.createImageData(renderWidth, renderHeight);
  const pixels    = imageData.data;

  const CX = 0.5; // ripple centre x (normalised)
  const CY = 0.5; // ripple centre y (normalised)

  for (let py = 0; py < renderHeight; py++) {
    const ny     = py / renderHeight;
    const rowOff = py * renderWidth;

    for (let px = 0; px < renderWidth; px++) {
      const nx = px / renderWidth;

      // Base animating field (independent of audio)
      let field = baseField(nx * TWO_PI, ny * TWO_PI, t);

      // Audio-band sinusoidal contributions
      const ripStrength = config.iridRipple;
      for (let b = 0; b < BAND_COUNT; b++) {
        const proj = nx * cosBand[b] + ny * sinBand[b];
        field += amps[b] * Math.sin(proj * BAND_FREQ[b] * TWO_PI + bandPhase[b]) * ripStrength * 0.7;
      }

      // Beat ripple rings
      for (const rip of beatRipples) {
        const dx   = nx - CX;
        const dy   = ny - CY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const dlt  = dist - rip.r;
        const w    = 0.05;
        field += Math.exp(-(dlt * dlt) / (w * w)) * rip.str * 0.9 * ripStrength;
      }

      // Soft-compress to keep colours in the vivid first-order range
      // tanh provides gentle saturation: large audio spikes don't blow out to grey
      const d = dBase + Math.tanh(field * 0.55) * dRange;

      writeFilmColor(d, brightness, pixels, (rowOff + px) << 2);
    }
  }

  offscreenCtx!.putImageData(imageData, 0, 0);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetIridescent(): void {
  offscreenCanvas = null;
  offscreenCtx    = null;
  renderWidth     = 0;
  renderHeight    = 0;
  lastBeatIndex   = -1;
  beatFlash       = 0;
  beatRipples     = [];
  // t and hueOffset preserved for seamless transitions
}
