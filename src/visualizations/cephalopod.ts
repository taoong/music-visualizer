/**
 * Cephalopod — Audio-reactive chromatophore skin simulation.
 *
 * Inspired by the dynamic skin patterning of cuttlefish (Sepia officinalis)
 * documented in the 2025 eLife computational pipeline:
 * "A computational pipeline to track chromatophores and analyze their dynamics"
 * (https://elifesciences.org/articles/106509) and the art-science synthesis
 * "Cephalopods Between Science, Art, and Engineering: A Contemporary Synthesis"
 * (Frontiers in Communication, 2018,
 *  https://www.frontiersin.org/articles/10.3389/fcomm.2018.00020/full).
 *
 * The canvas is covered with organic, slightly irregular cells representing
 * cephalopod skin. Each cell holds a chromatophore pigment sac: contracted it
 * is a near-invisible speck; expanded it becomes a vivid disc filling the cell
 * territory. Seven frequency-band columns (sub-bass left → brilliance right)
 * drive each zone's expansion. Beat-triggered ripple waves sweep radially from
 * the canvas centre, producing the rapid cascading colour-change seen in
 * threatened cuttlefish.
 *
 * Sliders
 *   Density  — cell count: sparse large cells → dense fine skin texture
 *   Pigment  — colour vividness: natural warm ambers/blues → vivid neon + iridophore shimmer
 *   Ripple   — beat-wave propagation speed
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Natural cephalopod pigment palette:
//   sub-bass → warm amber; bass → rust; lowMid → sienna;
//   mid → olive tan; upperMid → teal; presence → steel blue; brilliance → indigo
const BAND_HUES: readonly number[] = [38, 22, 15, 42, 175, 210, 240];
const BAND_SATS: readonly number[] = [80, 82, 78, 35, 72, 70, 75];
const BAND_BRTS: readonly number[] = [65, 60, 52, 70, 55, 62, 55];

type Cell = {
  x: number;
  y: number;
  r: number;       // territory radius
  bandIdx: number; // 0-6
  expand: number;  // current expansion 0-1, smoothed
  phase: number;   // per-cell noise phase for organic drift
};

// ── Module state ──────────────────────────────────────────────────────────────
let cells: Cell[] = [];
let waveRadius = -1;
let waveStrength = 0;
let lastBeatIdx = -1;
let hueShift = 0;
let noiseT = 0;
let cw = 0;
let ch = 0;
let lastDensityParam = -1;

// ── Grid construction ─────────────────────────────────────────────────────────
function buildGrid(w: number, h: number, density: number): void {
  const minCells = isMobile ? 100 : 220;
  const maxCells = isMobile ? 380 : 900;
  const targetCells = Math.round(minCells + density * (maxCells - minCells));

  const aspect = w / h;
  const rows = Math.max(4, Math.round(Math.sqrt(targetCells / aspect)));
  const cols = Math.max(4, Math.round(targetCells / rows));

  const cellW = w / cols;
  const cellH = h / rows;
  const r = Math.min(cellW, cellH) * 0.42; // ~42% of smaller dim → organic gap

  cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Hex-offset alternating rows for denser organic packing
      const xOff = row % 2 === 0 ? 0 : cellW * 0.5;
      const jx = (Math.random() - 0.5) * cellW * 0.38;
      const jy = (Math.random() - 0.5) * cellH * 0.38;
      const cx = (col + 0.5) * cellW + xOff + jx;
      const cy = (row + 0.5) * cellH + jy;
      if (cx < 0 || cx > w || cy < 0 || cy > h) continue;
      const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((cx / w) * BAND_COUNT));
      cells.push({ x: cx, y: cy, r, bandIdx, expand: 0, phase: Math.random() * Math.PI * 2 });
    }
  }

  cw = w;
  ch = h;
  lastDensityParam = density;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export function resetCephalopod(): void {
  cells = [];
  waveRadius = -1;
  waveStrength = 0;
  lastBeatIdx = -1;
  hueShift = 0;
  noiseT = 0;
  cw = 0;
  ch = 0;
  lastDensityParam = -1;
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawCephalopod(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  if (cells.length === 0 || cw !== w || ch !== h || lastDensityParam !== config.cephalopodDensity) {
    buildGrid(w, h, config.cephalopodDensity);
  }

  const chromaStr  = config.cephalopodChroma; // 0-1: natural → vivid/neon
  const waveSpeedN = config.cephalopodWave;   // 0-1: slow ripple → fast cascade

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      waveRadius  = 0;
      waveStrength = 0.80 + chromaStr * 0.20;
      hueShift = (hueShift + 20 + Math.random() * 30) % 360;
    }
  }

  // ── Wave propagation ──────────────────────────────────────────────────────
  const maxDim = Math.hypot(w, h);
  if (waveStrength > 0.01 && waveRadius >= 0) {
    const waveSpeedPx = (80 + waveSpeedN * 380) * dt;
    waveRadius  += waveSpeedPx;
    waveStrength *= Math.pow(0.88, dt);
    if (waveRadius > maxDim * 1.25) {
      waveRadius  = -1;
      waveStrength = 0;
    }
  }

  noiseT += 0.011 * dt;

  // ── Background: deep ocean/tank darkness ─────────────────────────────────
  p.background(7, 9, 13);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  const cx0 = w * 0.5;
  const cy0 = h * 0.5;

  // ── Draw cells ────────────────────────────────────────────────────────────
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const amp = Math.min(1, amps[cell.bandIdx] ?? 0);

    // Wave boost: swell as wavefront sweeps past
    let waveBoost = 0;
    if (waveStrength > 0.01 && waveRadius > 0) {
      const dx = cell.x - cx0;
      const dy = cell.y - cy0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const waveWidth = 55 + waveRadius * 0.10;
      const frontDist = Math.abs(dist - waveRadius);
      if (frontDist < waveWidth) {
        waveBoost = waveStrength * (1 - frontDist / waveWidth);
      }
    }

    // Organic breathing drift via Perlin noise (each cell has unique phase)
    const driftMod =
      ((p as any).noise(cell.x * 0.0038 + noiseT, cell.y * 0.0038 + noiseT * 0.67 + cell.phase) - 0.5) * 0.10;

    const targetExpand = Math.min(1, Math.max(0, amp + waveBoost + driftMod));

    // Smooth expansion: faster attack (chromatophore opens quickly) than release
    const attackRate  = Math.min(1, 0.28 * dt);
    const releaseRate = Math.min(1, 0.06 * dt);
    if (targetExpand > cell.expand) {
      cell.expand += (targetExpand - cell.expand) * attackRate;
    } else {
      cell.expand += (targetExpand - cell.expand) * releaseRate;
    }

    const ex = cell.expand;
    const r  = cell.r;

    // Color: band hue + beat-driven shift
    const baseHue = BAND_HUES[cell.bandIdx];
    const hue     = (baseHue + hueShift) % 360;

    // Natural sat/brt boosted by Pigment (chroma) slider
    const baseSat = BAND_SATS[cell.bandIdx];
    const baseBrt = BAND_BRTS[cell.bandIdx];
    const sat = baseSat + chromaStr * (100 - baseSat) * 0.55;
    const brt = baseBrt + chromaStr * (96  - baseBrt) * 0.30;

    // ── Cell territory background (very dim skin tone) ──────────────────
    const skinBrt = 10 + ex * 8;
    p.fill((hue + 8) % 360, 7, skinBrt, 82);
    p.circle(cell.x, cell.y, r * 2.18);

    // ── Chromatophore pigment sac ────────────────────────────────────────
    if (ex > 0.012) {
      const dotR = r * 0.88 * ex;

      // Outer soft bloom (appears above 35 % expansion)
      if (ex > 0.35) {
        const glowAmt = (ex - 0.35) / 0.65;
        p.fill(hue, sat * 0.60, brt, glowAmt * 26);
        p.circle(cell.x, cell.y, dotR * 2.6);
      }

      // Main pigment body
      p.fill(hue, sat, brt, 86 + chromaStr * 14);
      p.circle(cell.x, cell.y, dotR * 2.0);

      // 3D dome highlight: bright off-centre spot (simulates convex sac)
      if (ex > 0.20) {
        const hlOff = dotR * 0.22;
        const hlR   = dotR * 0.26;
        p.fill(hue, sat * 0.14, Math.min(100, brt + 36), 52);
        p.circle(cell.x - hlOff, cell.y - hlOff, hlR * 2);
      }
    }

    // ── Iridophore shimmer (structural blue-green) ───────────────────────
    // Real cuttlefish iridophores produce thin-film interference colours
    // between contracted chromatophores. Rendered here as a subtle cyan
    // sheen that intensifies when Pigment is high.
    if (chromaStr > 0.35 && ex < 0.72) {
      const iridAlpha = (1 - ex / 0.72) * ((chromaStr - 0.35) / 0.65) * 20;
      if (iridAlpha > 0.4) {
        const iridHue = (178 + Math.sin(noiseT * 1.4 + cell.phase) * 28) % 360;
        p.fill(iridHue, 58, 74, iridAlpha);
        p.circle(cell.x, cell.y, r * 1.72);
      }
    }
  }

  // ── Restore RGB colour mode ───────────────────────────────────────────────
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
