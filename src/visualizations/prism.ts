/**
 * Prism — Thin-film iridescent light field.
 *
 * Inspired by Tokujin Yoshioka's "Rainbow Church" installation (Design
 * Miami, 2010, https://www.tokujin.com/work/rainbow) — 500 000 Swarovski
 * crystal prisms bathing visitors in a continuously shifting spectral
 * light field — and the soap-bubble photography of Fabian Oefner
 * ("Iridient" series, 2012).
 *
 * A field of "film-thickness" values drifts via Perlin noise and seven
 * audio band waves (one per frequency band, each at a higher spatial
 * frequency). The path-length difference 2·n·t at each pixel selects
 * which visible wavelengths constructively interfere — exactly as a soap
 * bubble or oil slick shows colour. A precomputed 512-entry thin-film
 * LUT converts thickness → physical RGB. Beats fire a radial thickness
 * shockwave and shift the palette phase.
 *
 * Sliders
 *   prismFilm    — base film thickness (0 = thin/monochrome, 1 = full spectral cycling)
 *   prismFlow    — Perlin drift speed + spatial density (0–1)
 *   prismShimmer — iridescence brightness / saturation (0–1)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const PIXEL_SCALE = isMobile ? 8 : 4;
const LUT_SIZE = 512;

// Physical parameters for thin-film iridescence
const SOAP_N = 1.33;            // soap-film refractive index
const MAX_THICK_NM = 1600;      // nm — covers ~3.5 spectral orders

// Per-band spatial wave frequencies: increasing from sub-bass to brilliance
// so bass drives large-scale blobs, treble drives fine shimmer
const BAND_FX = [0.55, 0.95, 1.55, 2.30, 3.20, 4.40, 5.80] as const;
const BAND_FY = [0.75, 1.25, 1.95, 2.80, 3.75, 5.10, 6.50] as const;

// ── Thin-film LUT ─────────────────────────────────────────────────────────────

let filmLUT: Float32Array | null = null;

/**
 * Precompute 512 RGB triples for soap-film interference colours.
 * Each entry maps a normalised thickness (0–1) to a physical spectral colour.
 */
function buildFilmLUT(): void {
  filmLUT = new Float32Array(LUT_SIZE * 3);
  // Simplified spectral-to-RGB via three Gaussian response curves
  // (matches human L/M/S cone peaks reasonably well at this level of approximation)
  const rPeak = 610, rSig = 60;
  const gPeak = 549, gSig = 48;
  const bPeak = 438, bSig = 45;
  const LAMBDA_STEPS = 48;

  for (let i = 0; i < LUT_SIZE; i++) {
    const tNm = (i / LUT_SIZE) * MAX_THICK_NM;
    let R = 0, G = 0, B = 0;
    let wR = 0, wG = 0, wB = 0;

    for (let j = 0; j < LAMBDA_STEPS; j++) {
      const lambda = 380 + (j / LAMBDA_STEPS) * 320; // 380–700 nm
      const phase  = (4 * Math.PI * SOAP_N * tNm) / lambda;
      const intens = (1 + Math.cos(phase)) / 2;

      const dr = (lambda - rPeak) / rSig;
      const dg = (lambda - gPeak) / gSig;
      const db = (lambda - bPeak) / bSig;
      const wr = Math.exp(-0.5 * dr * dr);
      const wg = Math.exp(-0.5 * dg * dg);
      const wb = Math.exp(-0.5 * db * db);

      R += intens * wr;  wR += wr;
      G += intens * wg;  wG += wg;
      B += intens * wb;  wB += wb;
    }
    filmLUT[i * 3]     = wR > 0 ? R / wR : 0;
    filmLUT[i * 3 + 1] = wG > 0 ? G / wG : 0;
    filmLUT[i * 3 + 2] = wB > 0 ? B / wB : 0;
  }
}

// ── Module state ──────────────────────────────────────────────────────────────

let phaseT       = 0;
let bandPhases   = new Float64Array(BAND_COUNT);
let lutShift     = 0;       // beat-accumulated hue shift (0–1)
let lastBeatIdx  = -1;
let beatShock    = 0;       // radial shockwave strength

let offCanvas:   HTMLCanvasElement | null = null;
let offCtx:      CanvasRenderingContext2D | null = null;
let renderW      = 0;
let renderH      = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function initOffscreen(w: number, h: number): void {
  renderW = Math.max(1, Math.floor(w / PIXEL_SCALE));
  renderH = Math.max(1, Math.floor(h / PIXEL_SCALE));
  offCanvas = document.createElement('canvas');
  offCanvas.width  = renderW;
  offCanvas.height = renderH;
  offCtx = offCanvas.getContext('2d')!;
}

/** Smooth value-noise hash — same kernel as aurora/marbling vizzes. */
function hashVal(n: number): number {
  let x = ((n >> 13) ^ n) & 0xffff;
  x = (x * (x * x * 60493 + 19990303) + 1376312589) & 0x7fffffff;
  return (x & 0xffff) / 65535;
}

/** 2D value noise, C1-continuous via smoothstep blending. */
function noise2d(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u  = xf * xf * (3 - 2 * xf);
  const v  = yf * yf * (3 - 2 * yf);
  const a  = hashVal((xi     + yi     * 57) & 0xffff);
  const b  = hashVal((xi + 1 + yi     * 57) & 0xffff);
  const c  = hashVal((xi     + (yi+1) * 57) & 0xffff);
  const d  = hashVal((xi + 1 + (yi+1) * 57) & 0xffff);
  return a + u*(b-a) + v*(c-a) + u*v*(a-b-c+d);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawPrism(p: P5Instance, dt: number): void {
  if (!filmLUT) buildFilmLUT();

  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  const needW = Math.max(1, Math.floor(w / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(h / PIXEL_SCALE));
  if (!offCanvas || needW !== renderW || needH !== renderH) {
    initOffscreen(w, h);
  }

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      beatShock   = 1.0;
      lutShift    = (lutShift + 0.13) % 1.0; // shift ~47° in the spectral order
    }
  }
  beatShock *= Math.pow(0.88, dt);

  // ── Advance animation time ────────────────────────────────────────────────
  const flowSpeed = 0.003 + config.prismFlow * 0.014;
  phaseT += flowSpeed * dt;
  for (let b = 0; b < BAND_COUNT; b++) {
    bandPhases[b] += (0.006 + b * 0.002) * dt;
  }

  // ── Overall amplitude for brightness scaling ──────────────────────────────
  let avgAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) avgAmp += amps[b];
  avgAmp = Math.min(1, avgAmp / BAND_COUNT + 0.18); // keep some brightness at silence

  const shimmer  = 0.35 + config.prismShimmer * 0.65;
  const baseFilm = config.prismFilm; // 0–1 → position in LUT space

  // Spatial density: higher prismFlow → finer grain
  const nScale = 1.8 + config.prismFlow * 2.5;

  const TWO_PI = Math.PI * 2;
  const cx = renderW * 0.5;
  const cy = renderH * 0.5;

  const imageData = offCtx!.createImageData(renderW, renderH);
  const px8       = imageData.data;
  const lut       = filmLUT!;

  for (let py = 0; py < renderH; py++) {
    const ny = py / renderH;
    const rowOff = py * renderW;

    for (let qx = 0; qx < renderW; qx++) {
      const nx = qx / renderW;

      // Perlin-noise base for organic slow drift
      const noiseVal = noise2d(nx * nScale + phaseT * 0.25, ny * nScale + phaseT * 0.18);

      // Sum of 7 band waves — each band at a different spatial frequency
      let waveSum = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const amp = amps[b] * (0.6 + b * 0.06); // higher bands add finer detail
        waveSum += amp * Math.sin(TWO_PI * (BAND_FX[b] * nx + BAND_FY[b] * ny) + bandPhases[b]);
      }

      // Beat shockwave: radial cosine ring expanding from canvas centre
      if (beatShock > 0.01) {
        const ddx = (qx - cx) / renderW;
        const ddy = (py - cy) / renderH;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        waveSum += beatShock * Math.cos(dist * 14 - phaseT * 7) * Math.exp(-dist * 3.5);
      }

      // Combine into normalised thickness ∈ [0, 1] with wrap
      let thick = baseFilm + (noiseVal - 0.5) * 0.35 + waveSum * 0.22;
      thick = ((thick % 1) + 1) % 1;

      // Shift into LUT space, incorporating beat hue shift
      const lutIdx = (Math.floor(((thick + lutShift) % 1.0) * LUT_SIZE) + LUT_SIZE) % LUT_SIZE;
      const lo = lutIdx * 3;

      // Scale spectral RGB by overall amplitude and shimmer
      const bright = shimmer * avgAmp;
      const off8 = (rowOff + qx) << 2;
      px8[off8]     = Math.min(255, (lut[lo]     * bright * 255 + 0.5) | 0);
      px8[off8 + 1] = Math.min(255, (lut[lo + 1] * bright * 255 + 0.5) | 0);
      px8[off8 + 2] = Math.min(255, (lut[lo + 2] * bright * 255 + 0.5) | 0);
      px8[off8 + 3] = 255;
    }
  }

  offCtx!.putImageData(imageData, 0, 0);

  const ctx = (p as unknown as { drawingContext: CanvasRenderingContext2D }).drawingContext;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offCanvas!, 0, 0, w, h);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetPrism(): void {
  offCanvas   = null;
  offCtx      = null;
  renderW     = 0;
  renderH     = 0;
  lastBeatIdx = -1;
  beatShock   = 0;
  phaseT      = 0;
  lutShift    = 0;
  bandPhases  = new Float64Array(BAND_COUNT);
}
