/**
 * Boogie Woogie — Audio-reactive Mondrian grid.
 *
 * Inspired by Piet Mondrian "Broadway Boogie Woogie" (1942-43, MoMA,
 * https://www.moma.org/collection/works/78682). Mondrian painted the jazz
 * rhythm of NYC's numbered avenues as a vibrating yellow grid with scattered
 * red and blue squares — an abstract score for a city in motion. Here the 7
 * frequency bands (sub-bass = left → brilliance = right) drive the brightness
 * of coloured city-block cells, while small "boogies" — coloured squares —
 * race outward along the golden streets on every detected beat like taxis
 * flying away from Times Square. The Palette slider morphs from Mondrian's
 * primary-colour oil-on-canvas to a dark neon riff on the same structure.
 *
 * Sliders
 *   boogieGrid    — grid density: coarse city blocks → fine Manhattan grid
 *   boogiePulse   — beat-pulse strength: boogies spawned per beat burst
 *   boogiePalette — 0 = classic Mondrian (warm light), 1 = dark neon
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Classic Mondrian primary hues per band (red, red-orange, yellow, yellow, blue, blue, cream)
const CLASSIC_HUES = [0, 12, 50, 52, 210, 218, 55];
const CLASSIC_SATS = [92, 86, 98, 90, 92, 86, 24];

// Dark neon mode hues per band
const NEON_HUES = [290, 340, 55, 148, 200, 255, 310];

interface Boogie {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number;
  size: number;
  alpha: number;
}

let boogies: Boogie[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let colorMap: Int8Array = new Int8Array(0); // -1 = plain, 0-6 = band index
let mapDivs = -1;

function buildColorMap(divs: number): void {
  if (divs === mapDivs) return;
  mapDivs = divs;
  colorMap = new Int8Array(divs * divs).fill(-1);
  for (let r = 0; r < divs; r++) {
    for (let c = 0; c < divs; c++) {
      // ~22 % of cells become coloured city blocks (deterministic hash)
      const hash = (c * 179 + r * 83 + c * r * 23) % 100;
      if (hash < 22) {
        colorMap[r * divs + c] = Math.floor((c / divs) * BAND_COUNT);
      }
    }
  }
  // Guarantee at least one coloured cell per frequency band column
  const seen = new Array<boolean>(BAND_COUNT).fill(false);
  for (let i = 0; i < colorMap.length; i++) {
    const b = colorMap[i]; if (b >= 0) seen[b] = true;
  }
  for (let b = 0; b < BAND_COUNT; b++) {
    if (seen[b]) continue;
    const colStart = Math.floor((b / BAND_COUNT) * divs);
    const colEnd   = Math.floor(((b + 1) / BAND_COUNT) * divs);
    const col = Math.floor((colStart + colEnd) / 2);
    colorMap[Math.floor(divs / 2) * divs + col] = b;
  }
}

export function resetBoogie(): void {
  boogies = [];
  lastBeatIndex = -1;
  hueShift = 0;
  colorMap = new Int8Array(0);
  mapDivs = -1;
}

export function drawBoogie(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const gridParam    = config.boogieGrid;    // 0–1
  const pulseParam   = config.boogiePulse;   // 0–1
  const paletteParam = config.boogiePalette; // 0–1

  const maxDivs = isMobile ? 12 : 20;
  const divs  = Math.round(6 + gridParam * (maxDivs - 6));
  const W = p.width, H = p.height;
  const cellW = W / divs, cellH = H / divs;
  const lineW = Math.max(3, Math.min(cellW, cellH) * 0.15);
  const cellAvg = (cellW + cellH) / 2;

  buildColorMap(divs);

  // ── Background: warm cream → near-black ────────────────────────────────────
  p.background(
    Math.round(252 - paletteParam * 240),
    Math.round(248 - paletteParam * 236),
    Math.round(236 - paletteParam * 218)
  );

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  // ── City blocks ────────────────────────────────────────────────────────────
  for (let r = 0; r < divs; r++) {
    for (let c = 0; c < divs; c++) {
      const bandIdx = colorMap[r * divs + c];
      if (bandIdx < 0) continue;
      const amp  = amps[bandIdx];
      const hueC = CLASSIC_HUES[bandIdx];
      const satC = CLASSIC_SATS[bandIdx];
      const hueN = (NEON_HUES[bandIdx] + hueShift) % 360;

      const bx = c * cellW + lineW * 0.5;
      const by = r * cellH + lineW * 0.5;
      const bw = cellW - lineW;
      const bh = cellH - lineW;

      if (paletteParam <= 0.5) {
        // Classic → hybrid: bold primary colours on warm white
        const t   = paletteParam * 2;               // 0–1
        const hue = hueC + (hueN - hueC) * t;
        const sat = satC + amp * 10;
        const bri = 100 - (1 - amp) * 28;
        const alpha = 30 + amp * 70;
        p.fill(hue % 360, Math.min(100, sat), Math.min(100, bri), alpha);
      } else {
        // Dark neon: glowing bands on dark canvas
        const t   = (paletteParam - 0.5) * 2;       // 0–1
        const hue = (hueN * t + hueC * (1 - t)) % 360;
        p.fill(hue, 72 + amp * 28, 12 + amp * 88, 22 + amp * 78);
      }
      p.rect(bx, by, bw, bh);
    }
  }

  // ── Streets (grid lines) ───────────────────────────────────────────────────
  // Classic: golden Mondrian yellow. Dark: very dark charcoal.
  const stSat = paletteParam < 0.5 ? 90 - paletteParam * 50 : 5;
  const stBri = paletteParam < 0.5 ? 100 : 10 + paletteParam * 5;
  p.fill(52, stSat, stBri, 100);
  for (let r = 0; r <= divs; r++) p.rect(0,         r * cellH - lineW * 0.5, W, lineW);
  for (let c = 0; c <= divs; c++) p.rect(c * cellW - lineW * 0.5, 0,         lineW, H);

  // Thin black outlines on streets (fade out as palette goes dark)
  if (paletteParam < 0.65) {
    const outA = (1 - paletteParam / 0.65) * 85;
    const outW = Math.max(1, lineW * 0.07);
    p.fill(0, 0, 0, outA);
    for (let r = 0; r <= divs; r++) {
      const sy = r * cellH - lineW * 0.5;
      p.rect(0, sy,           W, outW);
      p.rect(0, sy + lineW - outW, W, outW);
    }
    for (let c = 0; c <= divs; c++) {
      const sx = c * cellW - lineW * 0.5;
      p.rect(sx,           0, outW, H);
      p.rect(sx + lineW - outW, 0, outW, H);
    }
  }

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 30) % 360;

      const nLines  = Math.ceil(2 + pulseParam * 7);
      const bSize   = Math.max(lineW * 0.55, 5);
      const spd     = cellAvg * 0.12;
      const cx      = (divs >> 1) * cellW;
      const cy      = (divs >> 1) * cellH;
      const step    = Math.max(1, Math.floor(divs / nLines));

      // Horizontal boogies — travel left and right along every nth row line
      for (let r = 0; r <= divs; r += step) {
        const sy   = r * cellH;
        const band = r % BAND_COUNT;
        const hue  = paletteParam < 0.5
          ? CLASSIC_HUES[band]
          : (NEON_HUES[band] + hueShift) % 360;
        boogies.push({ x: cx, y: sy, vx:  spd, vy: 0, hue, size: bSize, alpha: 100 });
        boogies.push({ x: cx, y: sy, vx: -spd, vy: 0, hue, size: bSize, alpha: 100 });
      }
      // Vertical boogies — travel up and down along every nth column line
      for (let c = 0; c <= divs; c += step) {
        const sx   = c * cellW;
        const band = c % BAND_COUNT;
        const hue  = paletteParam < 0.5
          ? CLASSIC_HUES[band]
          : (NEON_HUES[band] + hueShift) % 360;
        boogies.push({ x: sx, y: cy, vx: 0, vy:  spd, hue, size: bSize, alpha: 100 });
        boogies.push({ x: sx, y: cy, vx: 0, vy: -spd, hue, size: bSize, alpha: 100 });
      }
    }
  }

  // ── Boogies ────────────────────────────────────────────────────────────────
  const margin = 20;
  for (let i = boogies.length - 1; i >= 0; i--) {
    const b = boogies[i];
    b.x    += b.vx * dt;
    b.y    += b.vy * dt;
    b.alpha -= 0.65 * dt;

    if (
      b.alpha <= 0 ||
      b.x < -margin || b.x > W + margin ||
      b.y < -margin || b.y > H + margin
    ) {
      boogies.splice(i, 1);
      continue;
    }

    // Glow halo in dark neon mode
    if (paletteParam > 0.15) {
      const ga = b.alpha * paletteParam * 0.35;
      p.fill(b.hue, 65, 100, ga);
      const gs = b.size * 1.8;
      p.rect(b.x - gs, b.y - gs, gs * 2, gs * 2);
    }
    const sat = paletteParam < 0.5 ? 96 : 82;
    p.fill(b.hue, sat, 100, b.alpha);
    p.rect(b.x - b.size * 0.5, b.y - b.size * 0.5, b.size, b.size);
  }

  // Keep pool bounded
  if (boogies.length > 500) boogies.splice(0, boogies.length - 500);

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
