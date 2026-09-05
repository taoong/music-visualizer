/**
 * Chromatic — Holographic diffraction grating visualization.
 *
 * Seven grating layers (one per freq band) at evenly distributed angles
 * produce pure ROYGBIV rainbow stripe patterns. Their additive superposition
 * creates holographic iridescence — vivid compound colors where bands
 * intersect, like a real diffraction grating on holographic foil.
 *
 * Inspired by Felipe Pantone's "Chromadynamism" series (2016–present,
 * https://www.felipepantone.com/chromadynamica) — kinetic op-art works
 * that combine full-spectrum gradients, geometric precision, and neon
 * intensity to evoke the sensation of light refracting through a
 * holographic surface.
 *
 * Rendering: offscreen pixel buffer at ¼ res (⅛ mobile).
 * Beat fires a hue-palette jump + grating phase shuffle.
 *
 * Sliders
 *   Density  — grating stripe count (sparse wide bands → fine dense mesh)
 *   Spin     — rotation speed (slow drift → fast orbit)
 *   Shimmer  — brightness / iridescence intensity
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;
const TWO_PI = Math.PI * 2;
const RAD2DEG = 360 / TWO_PI;

// Evenly distribute base grating angles over [0, π)
const BASE_ANGLES: readonly number[] = Array.from(
  { length: BAND_COUNT },
  (_, i) => (i * Math.PI) / BAND_COUNT
);

// Per-band hue bias: sub-bass = violet (270°), brilliance = red (0°)
const BAND_HUE_BIAS: readonly number[] = [270, 240, 180, 120, 60, 30, 0];

// Per-band drift multiplier — higher bands animate faster
const DRIFT_MULT: readonly number[] = [1.00, 1.09, 1.19, 1.30, 1.42, 1.55, 1.70];

// Module state
let _time = 0;
let _hueOffset = 0;
let _lastBeat = -1;
let _beatFlash = 0;

// Per-band grating angles (accumulate rotation over time)
let _angles: Float64Array = new Float64Array(BAND_COUNT).map((_, i) => BASE_ANGLES[i]);
// Per-band phases (drift independently)
let _phases: Float64Array = new Float64Array(BAND_COUNT).map((_, i) => i * 0.9);

// Offscreen pixel buffer
let _offscreen: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _imgData: ImageData | null = null;
let _buf: Uint8ClampedArray | null = null;
let _rw = 0;
let _rh = 0;

function initOffscreen(w: number, h: number): void {
  _rw = Math.max(1, Math.floor(w / PIXEL_SCALE));
  _rh = Math.max(1, Math.floor(h / PIXEL_SCALE));
  _offscreen = document.createElement('canvas');
  _offscreen.width = _rw;
  _offscreen.height = _rh;
  _ctx = _offscreen.getContext('2d')!;
  _imgData = _ctx.createImageData(_rw, _rh);
  _buf = _imgData.data;
}

/** Pure-spectrum hue → [r, g, b] in [0, 1] (saturation = 1, value = 1). */
function hueToRGB(h: number): [number, number, number] {
  const h6 = (((h % 360) + 360) % 360) / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  switch (i) {
    case 0:  return [1,   f,   0  ];
    case 1:  return [1-f, 1,   0  ];
    case 2:  return [0,   1,   f  ];
    case 3:  return [0,   1-f, 1  ];
    case 4:  return [f,   0,   1  ];
    default: return [1,   0,   1-f];
  }
}

export function resetChromatic(): void {
  _time      = 0;
  _hueOffset = 0;
  _lastBeat  = -1;
  _beatFlash = 0;
  _angles    = new Float64Array(BASE_ANGLES);
  _phases    = new Float64Array(BAND_COUNT).map((_, i) => i * 0.9);
  _offscreen = null;
  _ctx       = null;
  _imgData   = null;
  _buf       = null;
}

export function drawChromatic(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Init / resize offscreen buffer
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!_offscreen || needW !== _rw || needH !== _rh) {
    initOffscreen(p.width, p.height);
  }

  // Beat detection → hue jump + phase shuffle
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeat) {
      _lastBeat   = bi;
      _hueOffset += 40 + Math.random() * 80;
      _beatFlash  = 1.0;
      // Shuffle all grating phases
      for (let b = 0; b < BAND_COUNT; b++) {
        _phases[b] += (Math.random() - 0.5) * Math.PI * 3;
      }
    }
  }
  _beatFlash *= Math.pow(0.85, dt);

  // Advance time and rotate angles
  const spinBase  = 0.0004 + config.chromaticSpin * 0.006;
  _time          += 0.01 * dt;
  for (let b = 0; b < BAND_COUNT; b++) {
    // Each band slowly drifts from its base angle; audio amplitude warps it slightly
    const audioWarp = (amps[b] - 0.3) * 0.015;
    _angles[b] += (spinBase * DRIFT_MULT[b] + audioWarp) * dt;
    // Advance phase by time + amplitude
    _phases[b] += (spinBase * 0.5 * DRIFT_MULT[b] + amps[b] * 0.003) * dt;
  }

  // Precompute per-band grating parameters
  const densityVal = 3.0 + config.chromaticDensity * 22.0; // stripe cycles across image width
  const shimmerVal = 0.4 + config.chromaticShimmer * 1.2;
  const flashBoost = 1.0 + _beatFlash * 0.7;

  // Normalised pixel coords (−1…+1 on the short axis)
  const aspect = _rw / _rh;

  const cosA    = new Float64Array(BAND_COUNT);
  const sinA    = new Float64Array(BAND_COUNT);
  const phBias  = new Float64Array(BAND_COUNT);
  const weights = new Float64Array(BAND_COUNT);

  let totalAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    cosA[b]    = Math.cos(_angles[b]);
    sinA[b]    = Math.sin(_angles[b]);
    phBias[b]  = _phases[b] * RAD2DEG + BAND_HUE_BIAS[b] + _hueOffset;
    weights[b] = 0.08 + amps[b] * 0.92;
    totalAmp  += amps[b];
  }
  totalAmp = Math.min(1, (totalAmp / BAND_COUNT) * 1.6);

  // Normalise weights (prevents output from washing to white at all-loud)
  let wSum = 0;
  for (let b = 0; b < BAND_COUNT; b++) wSum += weights[b];
  const wInv = 1 / (wSum || 1);

  // The global brightness: quiet music → dim, loud → full shimmer
  const brightness = (0.3 + totalAmp * 0.7) * shimmerVal * flashBoost;

  const buf = _buf!;

  for (let py = 0; py < _rh; py++) {
    const ny = (py / _rh - 0.5) * 2; // −1…+1

    for (let px = 0; px < _rw; px++) {
      const nx = (px / _rw - 0.5) * 2 * aspect; // aspect-corrected −a…+a

      let R = 0, G = 0, B = 0;

      for (let b = 0; b < BAND_COUNT; b++) {
        // Projection onto grating axis (dimensionless, ≈ 0…densityVal cycles)
        const proj = (nx * cosA[b] + ny * sinA[b]) * densityVal;
        // Map projection → hue via linear sweep (full ROYGBIV per stripe)
        const hue  = proj * 180 + phBias[b]; // ×180: half-turn = 180° hue shift
        const [r, g, bv] = hueToRGB(hue);
        const w = weights[b] * wInv;
        R += r * w;
        G += g * w;
        B += bv * w;
      }

      // Scale to desired brightness
      const mx = Math.max(R, G, B);
      const scale = mx > 0 ? brightness / mx : 0;
      const cR = Math.min(255, (R * scale * 255 + 0.5) | 0);
      const cG = Math.min(255, (G * scale * 255 + 0.5) | 0);
      const cB = Math.min(255, (B * scale * 255 + 0.5) | 0);

      const off  = (py * _rw + px) * 4;
      buf[off    ] = cR;
      buf[off + 1] = cG;
      buf[off + 2] = cB;
      buf[off + 3] = 255;
    }
  }

  // Upload pixel buffer and stretch to canvas
  _ctx!.putImageData(_imgData!, 0, 0);
  (p as any).drawingContext.imageSmoothingEnabled = true;
  (p as any).drawingContext.drawImage(
    _offscreen!,
    0, 0, _rw, _rh,
    0, 0, p.width, p.height
  );
}
