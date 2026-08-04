/**
 * Morphogenesis — Multi-Scale Turing Pattern visualization.
 *
 * Implements a variant of Jonathan McCabe's multi-scale morphogenesis algorithm
 * (2010), itself a generalization of Alan Turing's reaction-diffusion model
 * ("The Chemical Basis of Morphogenesis", 1952). A single scalar field is
 * updated each frame: for each of 7 spatial scales — one per audio frequency
 * band — every cell compares its small-neighborhood average (activator) to its
 * large-neighborhood average (inhibitor). When activator exceeds inhibitor the
 * field grows; otherwise it shrinks. The interplay of multiple scales produces
 * the layered organic textures seen in leopard fur, coral polyps, and lichen —
 * structures that literally look like they are "sounding" at different spatial
 * frequencies.
 *
 * Audio reactivity
 *   Each of the 7 freq bands drives one spatial scale: sub-bass creates large
 *   macro-structures, brilliance creates fine surface grain. The amplitude of
 *   each band weights how strongly its scale contributes each frame — the
 *   pattern's spatial character changes organically with the music.
 *   Beat → injects a burst of random noise to shift pattern topology and
 *   prevent stagnation; louder beats inject larger perturbations.
 *   Transient → brief brightness flash.
 *
 * Rendering: field normalized globally → color via one of three palettes
 *   (biological / ocean / lava, blended via Palette slider).
 *   ¼-res pixel buffer on desktop (⅙ on mobile). Integral image (summed area
 *   table) gives O(1) box-filter lookups, keeping the algorithm real-time.
 *
 * Sliders
 *   Scales  — active frequency-band count (1–7); more = richer fractal detail
 *   Speed   — field evolution rate (slow drift → fast writhing)
 *   Palette — colour map: 0 = biological (McCabe green-violet), 0.5 = ocean,
 *             1 = lava
 *
 * Inspired by Jonathan McCabe "Cyclic Symmetric Multi-Scale Turing Patterns"
 * (2010) https://www.jonathanmccabe.com/Cyclic_Symmetric_Multi-Scale_Turing_Patterns.pdf
 * and his generative works at https://www.jonathanmccabe.com/
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const PIXEL_SCALE = isMobile ? 6 : 4;

// Activation radii as fraction of grid height; inhibitor radius = 2× each
const RADII_FRAC = [0.100, 0.068, 0.046, 0.030, 0.020, 0.013, 0.009] as const;

// Three-stop color palettes: [dark, mid, bright] each as [R, G, B] 0-255
const PAL_ORGANIC: readonly (readonly [number, number, number])[] = [
  [12, 4, 30],    // deep violet-black
  [20, 140, 110], // teal-green mid
  [230, 220, 80], // pale gold
];
const PAL_OCEAN: readonly (readonly [number, number, number])[] = [
  [4, 10, 55],    // deep navy
  [15, 120, 190], // cerulean
  [195, 240, 255],// near-white blue
];
const PAL_LAVA: readonly (readonly [number, number, number])[] = [
  [4, 0, 0],      // black
  [190, 28, 0],   // deep red
  [255, 200, 60], // orange-gold
];

// ── Module state ──────────────────────────────────────────────────────────────

let gW = 0;
let gH = 0;
let field0: Float32Array = new Float32Array(0);
let field1: Float32Array = new Float32Array(0);
let sat: Float32Array = new Float32Array(0);   // summed area table built from field0

let buf: P5Graphics | null = null;
let lastBeatIndex = -1;
let normMin = -1.0;
let normMax = 1.0;
let transientFlash = 0.0;

// ── Summed area table helpers ─────────────────────────────────────────────────

/** Build integral image from field0. O(W×H). */
function buildSAT(): void {
  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const i = y * gW + x;
      const left   = x > 0             ? sat[i - 1]      : 0;
      const top    = y > 0             ? sat[i - gW]      : 0;
      const topLeft = (x > 0 && y > 0) ? sat[i - gW - 1] : 0;
      sat[i] = field0[i] + left + top - topLeft;
    }
  }
}

/** Box average centred at (cx, cy) with integer half-width r. O(1). */
function boxAvg(cx: number, cy: number, r: number): number {
  const x1 = Math.max(0, cx - r);
  const y1 = Math.max(0, cy - r);
  const x2 = Math.min(gW - 1, cx + r);
  const y2 = Math.min(gH - 1, cy + r);
  const s22 = sat[y2 * gW + x2];
  const s12 = x1 > 0 ? sat[y2 * gW + (x1 - 1)] : 0;
  const s21 = y1 > 0 ? sat[(y1 - 1) * gW + x2] : 0;
  const s11 = (x1 > 0 && y1 > 0) ? sat[(y1 - 1) * gW + (x1 - 1)] : 0;
  const area = (x2 - x1 + 1) * (y2 - y1 + 1);
  return (s22 - s12 - s21 + s11) / area;
}

// ── Grid lifecycle ────────────────────────────────────────────────────────────

function ensureGrid(p: P5Instance): void {
  const w = Math.max(4, (p.width  / PIXEL_SCALE) | 0);
  const h = Math.max(4, (p.height / PIXEL_SCALE) | 0);
  if (w === gW && h === gH && field0.length === w * h) return;

  gW = w; gH = h;
  const n = w * h;
  field0 = new Float32Array(n);
  field1 = new Float32Array(n);
  sat    = new Float32Array(n);

  // Seed with low-amplitude random noise so patterns emerge quickly
  for (let i = 0; i < n; i++) field0[i] = (Math.random() - 0.5) * 0.4;

  if (buf) { buf.remove(); }
  buf = p.createGraphics(w, h);
  buf.noSmooth();
  normMin = -0.5; normMax = 0.5;
}

export function resetMorpho(): void {
  gW = 0; gH = 0;
  field0 = new Float32Array(0);
  field1 = new Float32Array(0);
  sat    = new Float32Array(0);
  if (buf) { buf.remove(); buf = null; }
  lastBeatIndex = -1;
  normMin = -1.0; normMax = 1.0;
  transientFlash = 0.0;
}

// ── Color mapping ─────────────────────────────────────────────────────────────

/** Linear interpolation of two three-stop palettes at field value t∈[0,1]. */
function valueToRgb(
  t: number,
  palA: readonly (readonly [number, number, number])[],
  palB: readonly (readonly [number, number, number])[],
  mix: number,
): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  const lo = u < 0.5 ? 0 : 1;
  const hi = lo + 1;
  const f = u < 0.5 ? u * 2 : (u - 0.5) * 2;

  const rA = palA[lo][0] + (palA[hi][0] - palA[lo][0]) * f;
  const gA = palA[lo][1] + (palA[hi][1] - palA[lo][1]) * f;
  const bA = palA[lo][2] + (palA[hi][2] - palA[lo][2]) * f;

  const rB = palB[lo][0] + (palB[hi][0] - palB[lo][0]) * f;
  const gB = palB[lo][1] + (palB[hi][1] - palB[lo][1]) * f;
  const bB = palB[lo][2] + (palB[hi][2] - palB[lo][2]) * f;

  return [rA + (rB - rA) * mix, gA + (gB - gA) * mix, bA + (bB - bA) * mix];
}

function mapPalette(t: number, palette: number): [number, number, number] {
  if (palette <= 0.5) {
    return valueToRgb(t, PAL_ORGANIC, PAL_OCEAN, palette * 2);
  }
  return valueToRgb(t, PAL_OCEAN, PAL_LAVA, (palette - 0.5) * 2);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawMorpho(p: P5Instance, dt: number): void {
  ensureGrid(p);

  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const nScales = Math.max(1, Math.min(BAND_COUNT, Math.round(config.morphoScales)));
  const baseStep = 0.0015 + config.morphoSpeed * 0.048; // 0.0015 … 0.050
  const palette  = config.morphoPalette;

  // ── Beat detection ──────────────────────────────────────────────────────────
  let isBeat = false;
  if (state.beatIntervalSec > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) isBeat = true;
      lastBeatIndex = beatIdx;
    }
  }

  // ── Transient flash ─────────────────────────────────────────────────────────
  const maxTransient = Math.max(...transients);
  if (maxTransient > 1.5) transientFlash = Math.min(1.0, transientFlash + (maxTransient - 1.5) * 0.3);
  transientFlash *= Math.pow(0.88, dt); // frame-rate-independent decay

  // ── Build summed area table ─────────────────────────────────────────────────
  buildSAT();

  // ── Update field (McCabe multi-scale Turing step) ───────────────────────────
  const dtScale = Math.min(3.0, dt); // clamp to avoid huge jumps after tab-switch
  let localMin = Infinity;
  let localMax = -Infinity;

  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const i = y * gW + x;
      let delta = 0;

      for (let b = 0; b < nScales; b++) {
        const ra   = Math.max(1, (RADII_FRAC[b] * gH) | 0);
        const ri   = ra * 2;
        const avgA = boxAvg(x, y, ra);
        const avgI = boxAvg(x, y, ri);
        // Each band's amplitude weights its scale; even silent bands contribute
        // a small base nudge so patterns are never completely frozen
        const bandWeight = 0.15 + 0.85 * Math.max(0, Math.min(1, amps[b]));
        const step = baseStep * bandWeight * dtScale / nScales;
        delta += avgA > avgI ? step : -step;
      }

      field1[i] = field0[i] + delta;
      if (field1[i] < localMin) localMin = field1[i];
      if (field1[i] > localMax) localMax = field1[i];
    }
  }

  // Ping-pong buffers
  const tmp = field0; field0 = field1; field1 = tmp;

  // ── Rolling normalization (smooth) ──────────────────────────────────────────
  const normAlpha = 0.025;
  normMin += (localMin - normMin) * normAlpha;
  normMax += (localMax - normMax) * normAlpha;
  const range = Math.max(1e-6, normMax - normMin);

  // ── Beat: inject random noise to perturb topology ───────────────────────────
  if (isBeat) {
    const strength  = 0.3 + amps[0] * 0.7;          // louder bass = bigger kick
    const nInject   = ((gW * gH * 0.04) | 0);
    for (let k = 0; k < nInject; k++) {
      const idx = (Math.random() * gW * gH) | 0;
      field0[idx] += (Math.random() - 0.5) * range * strength;
    }
  }

  // ── Render pixel buffer ─────────────────────────────────────────────────────
  buf!.loadPixels();
  const pd     = buf!.pixels;
  const bright = 1.0 + transientFlash * 0.7;

  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const i  = y * gW + x;
      const t  = (field0[i] - normMin) / range; // [0, 1]
      const [r, g, b] = mapPalette(t, palette);
      const pi = i * 4;
      pd[pi]     = Math.min(255, r * bright) | 0;
      pd[pi + 1] = Math.min(255, g * bright) | 0;
      pd[pi + 2] = Math.min(255, b * bright) | 0;
      pd[pi + 3] = 255;
    }
  }
  buf!.updatePixels();

  p.image(buf! as unknown as P5Image, 0, 0, p.width, p.height);
}
