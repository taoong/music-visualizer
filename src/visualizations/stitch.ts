/**
 * Stitch — audio-reactive cross-stitch embroidery visualization.
 *
 * Inspired by "Dear Data" by Giorgia Lupi & Stefanie Posavec (2016),
 * https://www.dear-data.com/ — a year-long hand-illustrated data postcard
 * exchange using an embroidery-like visual language; now part of the MoMA
 * permanent collection. Each audio frame is treated as a row of embroidery
 * thread: cross-stitch X marks accumulate on a dark "Aida cloth" canvas as
 * frequency bands activate their column zones, gradually weaving a luminous
 * tapestry from the music. Beats fire an expanding radial wave of fresh
 * stitches from the canvas centre, like a needle jumping across the fabric.
 *
 * Sliders
 *   Grid  — stitch cell size / density (8 px = dense fine needlework,
 *            40 px = sparse bold cross-stitch)
 *   Trail — thread persistence (fast fade → permanent tapestry)
 *   Glow  — phosphor bloom halo around each stitch
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band embroidery thread hues (HSB): violet→blue→teal→green→yellow→orange→magenta
const BAND_HUES: readonly number[] = [270, 220, 175, 120, 55, 25, 300];

// ── Module state ────────────────────────────────────────────────────────────
let _cols = 0;
let _rows = 0;
let _brightness: Float32Array | null = null; // per-cell brightness [0,1]
let _bandIdx: Uint8Array | null = null;       // per-cell freq-band index

interface StitchWave {
  radius: number;  // in cells
  maxRadius: number;
}

let _waves: StitchWave[] = [];
let _lastBeatIdx = -1;
let _pg: any = null; // offscreen graphics buffer

// ── Grid init ───────────────────────────────────────────────────────────────
function initGrid(cols: number, rows: number): void {
  _cols = cols;
  _rows = rows;
  const n = cols * rows;
  _brightness = new Float32Array(n);
  _bandIdx = new Uint8Array(n);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      _bandIdx[row * cols + col] = Math.min(
        BAND_COUNT - 1,
        Math.floor((col / cols) * BAND_COUNT)
      );
    }
  }
}

export function resetStitch(): void {
  _cols = 0;
  _rows = 0;
  _brightness = null;
  _bandIdx = null;
  _waves = [];
  _lastBeatIdx = -1;
  _pg = null;
}

export function drawStitch(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Mobile guard: cap cell size to keep grid manageable on small screens
  const maxCell = isMobile ? 24 : 40;
  const cellSize = Math.max(8, Math.min(maxCell, Math.round(config.stitchGrid)));
  const trail = config.stitchTrail;   // 0 = fast fade, 1 = persistent
  const glow = config.stitchGlow;     // 0 = no bloom, 1 = heavy halo

  const cols = Math.ceil(p.width / cellSize);
  const rows = Math.ceil(p.height / cellSize);

  if (cols !== _cols || rows !== _rows || !_brightness) {
    initGrid(cols, rows);
  }

  if (!_pg || _pg.width !== p.width || _pg.height !== p.height) {
    _pg = p.createGraphics(p.width, p.height);
    (_pg as any).colorMode((p as any)['HSB'], 360, 100, 100, 100);
    _waves = [];
  }

  // ── Beat detection ──────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeatIdx) {
      _lastBeatIdx = bi;
      const diagCells = Math.sqrt(cols * cols + rows * rows) / 2;
      _waves.push({ radius: 0, maxRadius: diagCells + 4 });
    }
  }

  // Advance beat waves (cells/frame)
  const waveSpeed = isMobile ? 1.8 : 2.5;
  for (const w of _waves) {
    w.radius += waveSpeed * dt;
  }
  _waves = _waves.filter(w => w.radius < w.maxRadius);

  // ── Decay cell brightness ───────────────────────────────────────────────
  // Higher trail → slower decay
  const decayPerFrame = p.map(trail, 0, 1, 0.07, 0.003) * dt;
  for (let i = 0; i < _brightness!.length; i++) {
    _brightness![i] = Math.max(0, _brightness![i] - decayPerFrame);
  }

  // ── Activate cells ──────────────────────────────────────────────────────
  const halfCols = cols * 0.5;
  const halfRows = rows * 0.5;
  // Scale activation density by mobile to keep performance OK
  const activationScale = isMobile ? 0.55 : 1.0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * _cols + col;
      const band = _bandIdx![i];
      const amp = amps[band];

      // Quadratic amplitude → stitch probability (more dramatic range)
      let prob = amp * amp * 0.3 * activationScale * dt;

      // Wave ring contribution
      if (_waves.length > 0) {
        const dc = col - halfCols;
        const dr = row - halfRows;
        const dist = Math.sqrt(dc * dc + dr * dr);
        for (const w of _waves) {
          const ringWidth = 2.5;
          const diff = Math.abs(dist - w.radius);
          if (diff < ringWidth) {
            prob += (1 - diff / ringWidth) * 0.85;
          }
        }
      }

      if (prob > 0 && Math.random() < prob) {
        _brightness![i] = Math.min(1, _brightness![i] + 0.45 + amp * 0.55);
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  (_pg as any).colorMode((p as any)['HSB'], 360, 100, 100, 100);
  _pg.background(0, 0, 6);
  _pg.noFill();
  _pg.strokeCap(p.ROUND);

  const arm = cellSize * 0.38;
  const coreStroke = Math.max(1.2, cellSize * 0.11);
  const glowStroke = coreStroke + glow * cellSize * 0.32;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * _cols + col;
      const brt = _brightness![i];
      if (brt < 0.025) continue;

      const cx = (col + 0.5) * cellSize;
      const cy = (row + 0.5) * cellSize;
      const hue = BAND_HUES[_bandIdx![i]];
      const alpha = brt * 100;
      const sat = 60 + brt * 35;
      const brightness = 50 + brt * 48;

      // Outer glow pass
      if (glow > 0.08) {
        _pg.strokeWeight(glowStroke);
        _pg.stroke(hue, sat * 0.6, brightness, alpha * glow * 0.22);
        _drawX(_pg, cx, cy, arm);
      }

      // Mid glow pass
      if (glow > 0.25) {
        _pg.strokeWeight(coreStroke + glow * cellSize * 0.15);
        _pg.stroke(hue, sat * 0.8, brightness, alpha * glow * 0.4);
        _drawX(_pg, cx, cy, arm);
      }

      // Core X stitch
      _pg.strokeWeight(coreStroke);
      _pg.stroke(hue, sat, brightness, alpha);
      _drawX(_pg, cx, cy, arm);
    }
  }

  // Subtle grid guide dots at cell corners (very dim, fabric weave effect)
  if (cellSize >= 14) {
    _pg.stroke(0, 0, 22, 18);
    _pg.strokeWeight(1);
    for (let row = 0; row <= rows; row++) {
      for (let col = 0; col <= cols; col++) {
        _pg.point(col * cellSize, row * cellSize);
      }
    }
  }

  p.background(0, 0, 6);
  p.image(_pg, 0, 0);
}

function _drawX(g: any, cx: number, cy: number, arm: number): void {
  g.line(cx - arm, cy - arm, cx + arm, cy + arm);
  g.line(cx + arm, cy - arm, cx - arm, cy + arm);
}
