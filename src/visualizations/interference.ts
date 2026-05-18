/**
 * Interference — Audio-reactive moiré / interference-pattern visualizer.
 *
 * Inspired by Ryoji Ikeda's "test pattern" series (2008–present,
 * https://www.ryojiikeda.com/project/testpattern/) — large-scale
 * installations that convert raw data streams into rapidly scrolling
 * barcode-like patterns, creating hypnotic interference at the boundary
 * of human perception. Seven frequency bands each drive a standing-wave
 * layer at an evenly distributed angle (0°–154°). Their superposition
 * produces shifting moiré-like fringes that tilt, breathe, and shimmer
 * in lock-step with the music.
 *
 * Rendering: offscreen pixel buffer at ¼ resolution (⅙ mobile) with
 * imageSmoothingEnabled for soft gradients. Saturation scales with
 * amplitude so silence renders as near-monochrome barcode stripes while
 * loud passages burst into full colour. Beat detection fires a hue jump
 * and a brief brightness flash.
 *
 * Sliders
 *   Frequency — spatial wave density (sparse large fringes → dense fine mesh)
 *   Twist     — how far audio bends each layer's angle (subtle ↔ dramatic)
 *   Drift     — base animation speed at silence
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 4;

// Evenly distribute base angles over [0, π) — 7 bands → 0° … ~154°
const BASE_ANGLES: readonly number[] = Array.from(
  { length: BAND_COUNT },
  (_, i) => (i * Math.PI) / BAND_COUNT
);

// Per-band drift multiplier: high bands animate slightly faster
const DRIFT_MULT: readonly number[] = [1.00, 1.08, 1.17, 1.26, 1.36, 1.47, 1.59];

// Hue bias per band (sub-bass = warm red, brilliance = cool violet)
const BAND_HUE_BIAS = [0, 15, 40, 80, 160, 220, 270];

// Module state
let _time = 0;
let _baseAngle = 0;      // very slow global rotation
let _huePhase = 0;
let _lastBeat = -1;
let _beatFlash = 0;

let _offscreen: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _rw = 0;
let _rh = 0;

function initOffscreen(w: number, h: number): void {
  _rw = Math.max(1, Math.floor(w / PIXEL_SCALE));
  _rh = Math.max(1, Math.floor(h / PIXEL_SCALE));
  _offscreen = document.createElement('canvas');
  _offscreen.width = _rw;
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
  const uv = v * (1 - s * (1 - f));
  let r: number, g: number, bl: number;
  switch (i) {
    case 0:  r = v;  g = uv; bl = p;  break;
    case 1:  r = q;  g = v;  bl = p;  break;
    case 2:  r = p;  g = v;  bl = uv; break;
    case 3:  r = p;  g = q;  bl = v;  break;
    case 4:  r = uv; g = p;  bl = v;  break;
    default: r = v;  g = p;  bl = q;  break;
  }
  pixels[off]     = (r * 255 + 0.5) | 0;
  pixels[off + 1] = (g * 255 + 0.5) | 0;
  pixels[off + 2] = (bl * 255 + 0.5) | 0;
  pixels[off + 3] = 255;
}

export function drawInterference(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Init / resize
  const needW = Math.max(1, Math.floor(p.width / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!_offscreen || needW !== _rw || needH !== _rh) {
    initOffscreen(p.width, p.height);
  }

  // Beat detection → hue jump + brightness flash
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeat) {
      _lastBeat = bi;
      _huePhase += 45 + Math.random() * 65;
      _beatFlash = 1.0;
    }
  }
  _beatFlash *= Math.pow(0.88, dt);

  // Advance time
  const driftBase = 0.003 + config.interferenceDrift * 0.028;
  _time       += driftBase * dt;
  _baseAngle  += 0.00025 * dt;   // imperceptibly slow global rotation

  // Frequency slider → wave count
  const nWaves = 2.5 + config.interferenceFrequency * 16.5;

  // Twist slider → max additional angle deviation driven by audio
  const maxTwist = 0.018 + config.interferenceTwist * 0.42;

  // Per-band angles, phases, weights
  const cosA  = new Float64Array(BAND_COUNT);
  const sinA  = new Float64Array(BAND_COUNT);
  const phase = new Float64Array(BAND_COUNT);
  const wgt   = new Float64Array(BAND_COUNT);

  let totalAmp = 0;
  let domBand  = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    totalAmp += amps[b];
    if (amps[b] > amps[domBand]) domBand = b;

    // Audio nudges each band's angle by up to ±maxTwist
    const audioTwist = (amps[b] - 0.35) * maxTwist * 2.2;
    const angle = _baseAngle + BASE_ANGLES[b] + audioTwist;
    cosA[b]  = Math.cos(angle);
    sinA[b]  = Math.sin(angle);

    // Phase: time-drift + audio-driven offset
    phase[b] = _time * DRIFT_MULT[b] + amps[b] * Math.PI * 0.7;

    // Weight: constant base + amplitude scaling
    wgt[b]   = 0.12 + amps[b] * 0.88;
  }
  totalAmp = Math.min(1, (totalAmp / BAND_COUNT) * 1.6);

  // Normalise weights so they sum to 1 (avoids output saturation)
  let wgtSum = 0;
  for (let b = 0; b < BAND_COUNT; b++) wgtSum += wgt[b];
  const wgtInv = 1 / (wgtSum || 1);

  // Frame-constant colour parameters
  const hueBase = _huePhase + BAND_HUE_BIAS[domBand];
  const sat     = Math.min(1, 0.22 + totalAmp * 1.05);
  const flashBri = _beatFlash * 0.14;

  const TWO_PI = Math.PI * 2;
  const scale  = TWO_PI * nWaves;

  const imageData = _ctx!.createImageData(_rw, _rh);
  const pixels    = imageData.data;

  for (let py = 0; py < _rh; py++) {
    const yn     = py / _rh;
    const rowOff = py * _rw;

    // Pre-compute y-contribution for each band (avoids division inside x-loop)
    const yContrib = new Float64Array(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      yContrib[b] = scale * yn * sinA[b] + phase[b];
    }

    for (let px = 0; px < _rw; px++) {
      const xn = px / _rw;

      let v = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        v += wgt[b] * Math.sin(scale * xn * cosA[b] + yContrib[b]);
      }
      v *= wgtInv;  // normalised to roughly [-1, 1]

      // t in [0,1]: 0 = destructive (dark), 1 = constructive (bright)
      const t = (v + 1) * 0.5;

      // Hue arcs 90° across the fringe → complementary tones between peak/trough
      const hue = ((hueBase + t * 90) % 360 + 360) % 360;

      // Brightness: dark troughs, bright peaks, with beat flash
      const bri = Math.min(1, 0.04 + t * 0.88 + flashBri);

      hsv2rgba(hue, sat, bri, pixels, (rowOff + px) << 2);
    }
  }

  _ctx!.putImageData(imageData, 0, 0);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(_offscreen!, 0, 0, p.width, p.height);
}

export function resetInterference(): void {
  _offscreen = null;
  _ctx       = null;
  _rw        = 0;
  _rh        = 0;
  _lastBeat  = -1;
  _beatFlash = 0;
  // _time, _baseAngle, _huePhase preserved across resize for seamless experience
}
