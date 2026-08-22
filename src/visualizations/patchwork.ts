/**
 * Patchwork — Audio-reactive quilt visualization.
 *
 * Inspired by Emily Xie's "Interwoven" (2023, LACMA x Cactoid Labs,
 * https://verse.works/series/interwoven-by-emily-xie), a generative art
 * series that meditates on the computational and handmade by algorithmically
 * reinterpreting a 1986 Bullseye Quilt in LACMA's collection. Here a full-canvas
 * grid of square quilt blocks — each sporting one of five classic patchwork
 * patterns (Log Cabin, Half-Square Triangle, Pinwheel, Four-Patch, Rail Fence)
 * — throbs with the music: 7 vertical column zones map sub-bass (left) through
 * brilliance (right) to block brightness; transients flash individual blocks
 * white; every detected beat fires an expanding ring that sweeps pattern shuffles
 * outward from the canvas centre, re-seeding the quilt block by block.
 *
 * Sliders
 *   patchworkGrid    — cell density: 0 = large fabric squares, 1 = fine patchwork
 *   patchworkPalette — 0 = warm folk quilt (reds/golds), 1 = cool graphic (teals/indigo)
 *   patchworkMotion  — 0 = static patterns, 1 = animated breathing/rotation
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Five classic quilt block pattern types
const LOG_CABIN     = 0;
const HST           = 1; // Half-Square Triangle
const PINWHEEL      = 2;
const FOUR_PATCH    = 3;
const RAIL_FENCE    = 4;
const PATTERN_COUNT = 5;

// Per-band hue anchors for warm vs. cool palettes (7 bands)
const WARM_HUES = [0,   15,  40,  55,  80,  100, 130]; // red→yellow-green
const COOL_HUES = [260, 230, 200, 180, 170, 155, 140]; // indigo→teal

interface Cell {
  pattern: number;
  rotation: number; // 0 | 90 | 180 | 270
}

let cells: Cell[]     = [];
let gridW             = 0;
let gridH             = 0;
let cellSize          = 0;
let time              = 0;
let hueShift          = 0;
let beatRingR         = -1;
let beatRingSpeed     = 0;
let lastBeatIndex     = -1;

function buildGrid(w: number, h: number, sz: number): void {
  gridW = Math.ceil(w / sz) + 1;
  gridH = Math.ceil(h / sz) + 1;
  cells = [];
  for (let i = 0; i < gridW * gridH; i++) {
    cells.push({
      pattern: Math.floor(Math.random() * PATTERN_COUNT),
      rotation: Math.floor(Math.random() * 4) * 90,
    });
  }
}

// Shuffle cells whose centres lie within the annular ring [r1, r2]
function shuffleRing(cx: number, cy: number, r1: number, r2: number): void {
  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const px = col * cellSize + cellSize * 0.5;
      const py = row * cellSize + cellSize * 0.5;
      const d  = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      if (d >= r1 && d < r2) {
        const c = cells[row * gridW + col];
        if (c) {
          c.pattern  = Math.floor(Math.random() * PATTERN_COUNT);
          c.rotation = Math.floor(Math.random() * 4) * 90;
        }
      }
    }
  }
}

// Draw one quilt block centred at (0,0); half-width = `half`
function drawBlock(
  p: P5Instance,
  half: number,
  pattern: number,
  fgH: number, fgS: number, fgB: number,
  acH: number, acS: number, acB: number,
  bgH: number, bgS: number, bgB: number,
  motion: number,
  phase: number,
): void {
  const inn = half * 0.94; // inner half-width (tiny seam gap)

  // Solid background
  (p as any).fill(bgH, bgS, bgB);
  p.noStroke();
  p.rect(-inn, -inn, inn * 2, inn * 2);

  switch (pattern) {
    case LOG_CABIN: {
      const steps = isMobile ? 3 : 4;
      for (let i = steps; i >= 0; i--) {
        const r = (inn * (i + 1)) / (steps + 1);
        const pulse = i === 0 ? motion * Math.sin(phase) * half * 0.07 : 0;
        if (i % 2 === 0) (p as any).fill(fgH, fgS, fgB);
        else             (p as any).fill(acH, acS, acB);
        p.noStroke();
        const rp = Math.max(1, r + pulse);
        p.rect(-rp, -rp, rp * 2, rp * 2);
      }
      break;
    }

    case HST: {
      // Two right triangles splitting diagonally
      const sway = motion * Math.sin(phase) * half * 0.05;
      (p as any).fill(fgH, fgS, fgB);
      p.noStroke();
      p.triangle(-inn + sway, -inn,  inn, -inn,  -inn + sway, inn);
      (p as any).fill(acH, acS, acB);
      p.triangle(inn, -inn,  inn, inn,  -inn + sway, inn);
      break;
    }

    case PINWHEEL: {
      // Four right-triangle blades from centre, optionally rotating
      const rot = motion * phase * 0.15;
      p.push();
      p.rotate(rot);
      for (let i = 0; i < 4; i++) {
        p.push();
        p.rotate((i * Math.PI) / 2);
        if (i % 2 === 0) (p as any).fill(fgH, fgS, fgB);
        else             (p as any).fill(acH, acS, acB);
        p.noStroke();
        p.triangle(0, 0,  -inn, -inn,  inn, -inn);
        p.pop();
      }
      p.pop();
      break;
    }

    case FOUR_PATCH: {
      // 2×2 grid of squares, breathing gently
      const scale = 1 + motion * Math.sin(phase) * 0.06;
      const q     = inn * scale * 0.47;
      const gap   = Math.max(1, half * 0.03);
      (p as any).fill(fgH, fgS, fgB);
      p.noStroke();
      p.rect(-q - gap, -q - gap, q * 2, q * 2);
      p.rect( gap,     -q - gap, q * 2, q * 2);
      (p as any).fill(acH, acS, acB);
      p.rect(-q - gap,  gap,     q * 2, q * 2);
      p.rect( gap,      gap,     q * 2, q * 2);
      break;
    }

    case RAIL_FENCE: {
      // Three vertical stripes (classic Rail Fence), middle one shifts with audio
      const sw = (inn * 2) / 3;
      const sh = motion * Math.sin(phase) * half * 0.04;
      for (let i = 0; i < 3; i++) {
        const sx = -inn + i * sw + (i === 1 ? sh : 0);
        if (i === 1) (p as any).fill(acH, acS, acB);
        else         (p as any).fill(fgH, fgS, fgB);
        p.noStroke();
        p.rect(sx, -inn, sw, inn * 2);
      }
      break;
    }
  }

  // Thin seam outline
  p.noFill();
  (p as any).stroke(0, 0, 7);
  p.strokeWeight(Math.max(1, half * 0.04));
  p.rect(-inn, -inn, inn * 2, inn * 2);
}

export function drawPatchwork(p: P5Instance, dt: number): void {
  const { patchworkGrid, patchworkPalette, patchworkMotion } = store.config;
  const { state } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Cell size: slider 0 → 80px (coarse), 1 → 20px (fine); mobile: floor at 36
  const minSz    = isMobile ? 36 : 20;
  const maxSz    = 80;
  const targetSz = Math.round(maxSz - patchworkGrid * (maxSz - minSz));

  if (cells.length === 0 || targetSz !== cellSize) {
    cellSize      = targetSz;
    buildGrid(w, h, cellSize);
    beatRingR     = -1;
    lastBeatIndex = -1;
  }

  time += dt * (0.4 + patchworkMotion * 0.6);

  // Beat detection
  if (state.beatIntervalSec > 0) {
    const pos     = audioEngine.getPlaybackPosition() - state.beatOffset;
    const beatIdx = pos >= 0 ? Math.floor(pos / state.beatIntervalSec) : -1;
    if (beatIdx !== lastBeatIndex && beatIdx >= 0) {
      lastBeatIndex = beatIdx;
      hueShift      = (hueShift + 43) % 360;
      beatRingR     = 0;
      beatRingSpeed = cellSize * 8;
    }
  }

  // Advance beat ring and shuffle blocks in annular wavefront
  if (beatRingR >= 0) {
    const prevR   = beatRingR;
    beatRingR    += dt * beatRingSpeed;
    shuffleRing(w * 0.5, h * 0.5, prevR, beatRingR);
    if (beatRingR > Math.sqrt(w * w + h * h) * 0.5) beatRingR = -1;
  }

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.background(0, 0, 5);

  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const cell = cells[row * gridW + col];
      if (!cell) continue;

      const half = cellSize * 0.5;

      // Map column to frequency band (7 zones)
      const bandIdx  = Math.min(BAND_COUNT - 1, Math.floor((col / gridW) * BAND_COUNT));
      const amp      = amps[bandIdx] ?? 0;
      const transient = transients[bandIdx] ?? 1;
      const flash    = transient > 1.5;

      // Hue: interpolate between warm and cool palettes
      const warmH = (hueShift + (WARM_HUES[bandIdx] ?? 0)) % 360;
      const coolH = (hueShift + (COOL_HUES[bandIdx] ?? 0)) % 360;
      const hue   = warmH + (coolH - warmH) * patchworkPalette;
      const acHue = (hue + 150) % 360;

      const bri   = flash ? 95 : 18 + amp * 72;
      const sat   = 30 + patchworkPalette * 55;
      const bgBri = Math.max(5, bri * 0.12);

      const fgH = flash ? 0 : hue;
      const fgS = flash ? 0 : sat;
      const fgB = flash ? 95 : bri;
      const acH = flash ? 0 : acHue;
      const acS = flash ? 0 : sat * 0.8;
      const acB = flash ? 88 : bri * 0.85;
      const bgH = hue;
      const bgS = sat * 0.3;
      const bgB = bgBri;

      const phase = time * 0.5 + col * 0.31 + row * 0.23;

      p.push();
      p.translate(col * cellSize + half, row * cellSize + half);
      p.rotate((cell.rotation * Math.PI) / 180);
      drawBlock(p, half, cell.pattern,
        fgH, fgS, fgB, acH, acS, acB, bgH, bgS, bgB,
        patchworkMotion, phase);
      p.pop();
    }
  }

  (p as any).colorMode(p['RGB']);
}

export function resetPatchwork(): void {
  cells         = [];
  gridW         = 0;
  gridH         = 0;
  cellSize      = 0;
  time          = 0;
  hueShift      = 0;
  beatRingR     = -1;
  lastBeatIndex = -1;
}
