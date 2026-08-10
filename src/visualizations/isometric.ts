/**
 * Isometric City — audio-reactive axonometric cityscape.
 *
 * A grid of buildings rendered in classic 2:1 isometric projection. The grid
 * is divided into 7 concentric radial zones (sub-bass at the centre →
 * brilliance at the outer ring); each zone's amplitude drives the height of
 * buildings in that ring. Beat events send a height-wave ripple outward from
 * the canvas centre and shift the hue palette. The Palette slider morphs from
 * neon cyberpunk night to warm daylight pastels.
 *
 * Inspired by teamLab "Living Digital Space and Future Parks" (2014–2024,
 * https://www.teamlab.art/e/planet/) and Santiago Torres' isometric generative
 * illustration style. The connection between visual rhythm and architecture also
 * draws on Refik Anadol's "Living Architecture" data sculptures (2021).
 *
 * Sliders
 *   isometricDensity — city zoom: 0 = close-up towers, 1 = wide skyline view
 *   isometricHeight  — max building height / amplitude sensitivity (0–1)
 *   isometricPalette — 0 = neon cyberpunk night, 1 = warm daylight pastels
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band hues: sub-bass=violet → bass=magenta → lo-mid=red → mid=amber → hi-mid=chartreuse → presence=cyan → brilliance=azure
const BAND_HUES: readonly number[] = [270, 315, 8, 45, 108, 185, 240];

const GRID_DESKTOP = 14;
const GRID_MOBILE  = 8;

// ── Module state ──────────────────────────────────────────────────────────────
let lastBeatIndex = -1;
let rippleRadius   = 0;
let rippleStrength = 0;
let hueShift       = 0;
/** Per-tile smoothed height value in [0, 1]. Indexed [row][col]. */
let buildingH: Float32Array[] = [];
let gridInitSize   = 0;

// ── Reset ─────────────────────────────────────────────────────────────────────
export function resetIsometric(): void {
  lastBeatIndex  = -1;
  rippleRadius   = 0;
  rippleStrength = 0;
  hueShift       = 0;
  buildingH      = [];
  gridInitSize   = 0;
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawIsometric(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const GRID = isMobile ? GRID_MOBILE : GRID_DESKTOP;

  // (Re-)initialise height arrays when grid size changes
  if (gridInitSize !== GRID) {
    buildingH    = Array.from({ length: GRID }, () => new Float32Array(GRID));
    gridInitSize = GRID;
  }

  // Slider values
  const density    = config.isometricDensity;  // 0 = close/large tiles, 1 = wide/small tiles
  const heightSens = config.isometricHeight;   // 0–1 amplitude sensitivity
  const palette    = config.isometricPalette;  // 0 = night, 1 = day

  // Tile width: density=0 → larger tiles (zoomed in), density=1 → smaller (zoomed out)
  const TILE_W  = (p.width / GRID) * (1.35 - density * 0.60);
  const TILE_H  = TILE_W * 0.5;  // 2:1 isometric ratio
  const MAX_H   = TILE_W * (0.4 + heightSens * 3.8);

  // Canvas anchor — grid centre maps here, slightly below canvas centre for headroom
  const cx = p.width  * 0.50;
  const cy = p.height * 0.54;

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex  = beatIdx;
      rippleRadius   = 0;
      rippleStrength = 1.0;
      hueShift       = (hueShift + 37) % 360;
    }
  }

  // Advance and decay ripple
  rippleRadius   += dt * 0.20;
  rippleStrength *= Math.pow(0.88, dt);

  // ── Background ──────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100);

  // Night: near-black navy; Day: bright sky blue
  const bgSat    = 65 - palette * 25;
  const bgBright = 4  + palette * 86;
  p.background(220, bgSat, bgBright);

  p.noStroke();

  // ── Grid constants ──────────────────────────────────────────────────────────
  const gcx     = (GRID - 1) * 0.5;  // grid centre x
  const gcy     = (GRID - 1) * 0.5;  // grid centre y
  const maxDist = gcx * Math.SQRT2;  // max distance from centre corner to corner

  // ── Painter's algorithm: draw tiles sorted by (row + col) ascending ─────────
  for (let diag = 0; diag < 2 * GRID - 1; diag++) {
    const rowMin = Math.max(0, diag - GRID + 1);
    const rowMax = Math.min(diag, GRID - 1);

    for (let row = rowMin; row <= rowMax; row++) {
      const col = diag - row;

      // Screen position of tile centre (at ground level)
      const isoX = cx + (col - row)              * TILE_W * 0.5;
      const isoY = cy + (col + row - (GRID - 1)) * TILE_H * 0.25;

      // Rough visibility culling
      if (isoX + TILE_W    <  0       || isoX - TILE_W    > p.width)  continue;
      if (isoY - MAX_H - TILE_H < -TILE_H || isoY + TILE_H  > p.height + MAX_H) continue;

      // Radial zone (0 = sub-bass at centre, 6 = brilliance at outer ring)
      const dx       = col - gcx;
      const dy       = row - gcy;
      const rawDist  = Math.sqrt(dx * dx + dy * dy);
      const normDist = Math.min(rawDist / maxDist, 0.9999);
      const zone     = Math.min(6, Math.floor(normDist * 7));

      // Frequency amplitude for this zone
      const amp = amps[zone] ?? 0;

      // Ripple boost: a ring of extra height radiates outward from canvas centre
      const rippleDelta = Math.abs(rippleRadius - rawDist);
      const rippleBoost = rippleStrength * Math.max(0, 1 - rippleDelta * 1.1) * 0.40;

      // Target height in [0, 1]
      const target = Math.min(1, amp * 0.88 + rippleBoost);

      // Smooth height toward target (attack/release)
      const lerpK = Math.min(1, 0.09 * dt);
      buildingH[row][col] += (target - buildingH[row][col]) * lerpK;

      // Minimum height: even silent buildings show as a low platform
      const h = Math.max(2, buildingH[row][col] * MAX_H);

      // ── Colours ─────────────────────────────────────────────────────────────
      const baseHue = (BAND_HUES[zone] + hueShift) % 360;

      // Night: vivid + amplitude-boosted brightness; Day: muted pastel
      const sat        = 88 - palette * 48;
      const topBright  = (15 + amp * 85) * (1 - palette) + (72 + amp * 22) * palette;
      const leftBright  = topBright * 0.65;
      const rightBright = topBright * 0.42;

      // ── Isometric vertices ───────────────────────────────────────────────────
      // Roof (at height h above ground)
      const RN_x = isoX,              RN_y = isoY - h - TILE_H * 0.25;
      const RE_x = isoX + TILE_W * 0.5, RE_y = isoY - h;
      const RS_x = isoX,              RS_y = isoY - h + TILE_H * 0.25;
      const RW_x = isoX - TILE_W * 0.5, RW_y = isoY - h;

      // Ground corners (base of building walls)
      const BS_x = isoX,              BS_y = isoY + TILE_H * 0.25;
      const BW_x = isoX - TILE_W * 0.5, BW_y = isoY;
      const BE_x = isoX + TILE_W * 0.5, BE_y = isoY;

      // Neon glow for night mode on active buildings
      if (palette < 0.6 && amp > 0.15) {
        const glowAmount = (1 - palette / 0.6) * amp * 16;
        p.drawingContext.shadowBlur  = glowAmount;
        p.drawingContext.shadowColor = `hsl(${baseHue}, 100%, 65%)`;
      } else {
        p.drawingContext.shadowBlur = 0;
      }

      // Right wall (south-east face, viewer's right) — darkest
      p.fill(baseHue, sat, rightBright);
      p.quad(RE_x, RE_y, RS_x, RS_y, BS_x, BS_y, BE_x, BE_y);

      // Left wall (south-west face, viewer's left) — medium
      p.fill(baseHue, sat, leftBright);
      p.quad(RW_x, RW_y, RS_x, RS_y, BS_x, BS_y, BW_x, BW_y);

      // Roof (top face) — lightest, drawn last
      p.fill(baseHue, sat, topBright);
      p.quad(RN_x, RN_y, RE_x, RE_y, RS_x, RS_y, RW_x, RW_y);

      p.drawingContext.shadowBlur = 0;
    }
  }

  // Reset colour mode for subsequent renders
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
