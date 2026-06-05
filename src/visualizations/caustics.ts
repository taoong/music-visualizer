/**
 * Caustics — audio-reactive water light caustic patterns.
 *
 * Inspired by Jason Bruges Studio's architectural light-caustic installations
 * and Izabela Pluta's "Like folds in water (caustic network)" (2024,
 * https://www.izabelapluta.net/caustic-network) — an exploration of diving,
 * underwater light behaviour, and the shimmering refractive focus patterns that
 * form on pool floors in sunlight. Seven frequency bands each contribute a
 * traveling sinusoidal wave layer at a distinct angle and spatial scale; where
 * waves constructively interfere, light focuses into bright caustic clusters.
 * The result is an organic, shifting network of luminous lines on a deep-water
 * background that breathes and ripples with the music.
 *
 * Rendering: ¼-res offscreen pixel buffer (⅛ mobile) bilinearly upscaled.
 * Deep navy background fades through aquamarine into white-gold focal points.
 * A subtle radial vignette darkens the periphery ("looking up from the pool
 * floor"). Beat fires a brightness surge and incremental hue shift.
 *
 * Sliders
 *   Wave Scale — spatial scale of the wave grid (large sparse glows ↔ fine dense mesh)
 *   Speed      — drift rate (slow ocean shimmer ↔ rapid flash)
 *   Brightness — sharpness of caustic peaks (diffuse glow ↔ razor focal lines)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;

// Seven wave directions distributed evenly over [0, π)
const WAVE_ANGLES: readonly number[] = Array.from(
  { length: BAND_COUNT },
  (_, i) => (i / BAND_COUNT) * Math.PI
);

// Spatial frequency per band: sub-bass → long gentle swells; brilliance → fine ripples
const BASE_FREQ: readonly number[] = [0.9, 1.3, 1.8, 2.5, 3.4, 4.6, 6.1];

// Time drift multiplier per band — differential shimmer between frequency layers
const DRIFT_MULT: readonly number[] = [0.60, 0.75, 0.91, 1.07, 1.25, 1.46, 1.70];

// Module state
let _offscreen: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _rw = 0;
let _rh = 0;
let _time = 0;
let _beatFlash = 0;
let _lastBeat = -1;
let _huePhase = 0;

function initOffscreen(w: number, h: number): void {
  _rw = Math.max(1, Math.floor(w / PIXEL_SCALE));
  _rh = Math.max(1, Math.floor(h / PIXEL_SCALE));
  _offscreen = document.createElement('canvas');
  _offscreen.width  = _rw;
  _offscreen.height = _rh;
  _ctx = _offscreen.getContext('2d')!;
}

/** HSV → RGBA written directly into a Uint8ClampedArray at byte offset `off`. */
function hsv2rgba(
  h: number, s: number, v: number,
  pixels: Uint8ClampedArray, off: number
): void {
  const h6 = ((h % 360) + 360) % 360 / 60;
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
  pixels[off]     = (r * 255 + 0.5) | 0;
  pixels[off + 1] = (g * 255 + 0.5) | 0;
  pixels[off + 2] = (b * 255 + 0.5) | 0;
  pixels[off + 3] = 255;
}

export function drawCaustics(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Init / resize offscreen buffer
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!_offscreen || needW !== _rw || needH !== _rh) {
    initOffscreen(p.width, p.height);
  }

  // Beat detection → brightness surge + incremental hue shift
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeat) {
      _lastBeat  = bi;
      _beatFlash = 1.0;
      _huePhase += 22 + Math.random() * 30;
    }
  }
  _beatFlash *= Math.pow(0.86, dt);

  // Advance time
  _time += (0.0015 + config.causticsSpeed * 0.028) * dt;

  // Wave Scale slider → spatial frequency of wave grid
  const freqMul = 0.6 + config.causticsWaveScale * 7.0;

  // Brightness slider → sharpening exponent for constructive-interference peaks
  const exponent = 3.5 + config.causticsBrightness * 19.5;

  // Precompute per-band wave vectors (kx, ky), time phases, and amplitude weights
  const kx    = new Float64Array(BAND_COUNT);
  const ky    = new Float64Array(BAND_COUNT);
  const phase = new Float64Array(BAND_COUNT);
  const wgt   = new Float64Array(BAND_COUNT);
  let wgtSum  = 0;

  for (let b = 0; b < BAND_COUNT; b++) {
    const angle = WAVE_ANGLES[b];
    const fq    = BASE_FREQ[b] * freqMul;
    kx[b]    = fq * Math.cos(angle);
    ky[b]    = fq * Math.sin(angle);
    phase[b] = _time * DRIFT_MULT[b] + amps[b] * 2.1;
    // Small base weight ensures ambient caustics even at silence
    wgt[b]   = 0.18 + amps[b] * 0.82;
    wgtSum  += wgt[b];
  }
  const wgtInv = 1.0 / wgtSum;

  // Beat flash brightness boost
  const flashBoost = _beatFlash * 0.38;

  const imageData = _ctx!.createImageData(_rw, _rh);
  const pixels    = imageData.data;

  for (let py = 0; py < _rh; py++) {
    const yn     = py / _rh;
    const rowOff = py * _rw;

    // Radial vignette — darker at periphery, like looking up from pool floor
    const cy = yn - 0.5;

    // Precompute y-contribution per band to avoid redundant multiply in x-loop
    const yC = new Float64Array(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) yC[b] = ky[b] * yn + phase[b];

    for (let px = 0; px < _rw; px++) {
      const xn = px / _rw;

      // Weighted sum of sinusoidal wave layers; normalised to [-1, 1]
      let h = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        h += wgt[b] * Math.sin(kx[b] * xn + yC[b]);
      }
      h *= wgtInv;

      // Map to [0, 1]; peaks (h ≈ 1) are caustic focal points
      const t = (h + 1) * 0.5;

      // Power-law sharpening: concentrates brightness into narrow bright streaks
      const causticBase = Math.pow(t, exponent);

      // Vignette: slightly darker at corners (pool-depth effect)
      const cx = xn - 0.5;
      const vign = 1.0 - (cx * cx + cy * cy) * 0.55;
      const caustic = Math.min(1, (causticBase + flashBoost) * vign);

      // Color map: deep navy → aquamarine → bright white-gold
      // Divided into three brightness zones for natural underwater light feel
      let hue: number, sat: number, val: number;
      if (caustic < 0.25) {
        // Dark deep-water zone: near-black navy
        const f = caustic / 0.25;
        hue = 215 + (_huePhase % 360) * 0.08;
        sat = 0.88 - f * 0.08;
        val = f * 0.25;
      } else if (caustic < 0.72) {
        // Mid-water caustic body: teal to bright cyan
        const f = (caustic - 0.25) / 0.47;
        hue = (215 - f * 40 + (_huePhase % 360) * 0.08);
        sat = 0.80 - f * 0.28;
        val = 0.25 + f * 0.58;
      } else {
        // Focal-point crown: cyan fading to white-gold
        const f = (caustic - 0.72) / 0.28;
        hue = (175 - f * 130 + (_huePhase % 360) * 0.08);
        sat = 0.52 - f * 0.45;
        val = 0.83 + f * 0.17;
      }

      hsv2rgba(
        ((hue % 360) + 360) % 360,
        Math.max(0, Math.min(1, sat)),
        Math.max(0, Math.min(1, val)),
        pixels,
        (rowOff + px) << 2
      );
    }
  }

  _ctx!.putImageData(imageData, 0, 0);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(_offscreen!, 0, 0, p.width, p.height);
}

export function resetCaustics(): void {
  _offscreen = null;
  _ctx       = null;
  _rw        = 0;
  _rh        = 0;
  _lastBeat  = -1;
  _beatFlash = 0;
  // _time and _huePhase preserved across resize for seamless continuity
}
