/**
 * Wood Mirror — Audio-reactive mechanical-pixel relief.
 *
 * Inspired by Daniel Rozin's "Wooden Mirror" (1999) and his ongoing series
 * of kinetic mechanical mirrors (bitforms gallery,
 * https://www.bitforms.art/artist/daniel-rozin), where a grid of
 * motor-tilted, non-reflective wooden pixels catches a single light source
 * and reassembles a live image purely through shading — no pixel is ever
 * "lit" directly, only angled toward or away from the light.
 *
 * A grid of wooden tiles holds a relief height per cell. Seven frequency
 * bands drive the target relief of their column zone via Gaussian
 * weighting (sub-bass on the left, brilliance on the right); Perlin noise
 * adds organic drift so neighboring tiles never move in lockstep. Each
 * tile's surface normal is derived from the height gradient to its
 * neighbors and lit by a single fixed light source, exactly like Rozin's
 * motorized panels — the audio never "is" a color, it only tilts wood.
 * Beats send a circular wave of motion across the grid, as if a hand had
 * passed in front of the piece.
 *
 * Sliders
 *   Density — grid resolution (coarse pixels to fine mosaic)
 *   Depth   — relief amplitude (flat sheen to dramatic light/shadow)
 *   Speed   — motor response speed (slow settle to fast snap)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const WOOD_HUE = 32;
const HILITE_HUE = 46;

// Fixed light source direction (upper-left), pre-normalized.
const LX = -0.5;
const LY = -0.62;
const LZ = 0.6;
const L_LEN = Math.sqrt(LX * LX + LY * LY + LZ * LZ);
const LXN = LX / L_LEN;
const LYN = LY / L_LEN;
const LZN = LZ / L_LEN;

let _cols = 0;
let _rows = 0;
let _height: Float32Array | null = null;
let _noiseT = 0;
let _lastBeat = -1;
let _surgeAmp = 0;
let _surgeR = 0;

export function resetWoodMirror(): void {
  _cols = 0;
  _rows = 0;
  _height = null;
  _noiseT = 0;
  _lastBeat = -1;
  _surgeAmp = 0;
  _surgeR = 0;
}

export function drawWoodMirror(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const density = config.woodmirrorDensity;
  const depth = config.woodmirrorDepth;
  const speed = config.woodmirrorSpeed;

  const maxCols = isMobile ? 32 : 64;
  const cols = Math.max(14, Math.round(14 + density * (maxCols - 14)));
  const rows = Math.max(8, Math.round(cols * (p.height / p.width)));

  if (_cols !== cols || _rows !== rows || !_height) {
    _cols = cols;
    _rows = rows;
    _height = new Float32Array(cols * rows);
  }

  // Beat detection — fires a ring of motion across the grid
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== _lastBeat) {
      _lastBeat = beatIdx;
      _surgeAmp = 1.0;
      _surgeR = 0;
    }
  }

  const pace = 0.3 + speed * 1.4;
  _surgeR = Math.min(1.8, _surgeR + 0.034 * pace * dt);
  _surgeAmp *= Math.pow(0.93, dt);
  _noiseT += 0.0026 * pace * dt;

  const respRate = Math.min(1, (0.05 + speed * 0.3) * dt);

  for (let j = 0; j < rows; j++) {
    const ny = j / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const nx = i / (cols - 1);
      const idx = j * cols + i;

      const base = ((p as any).noise(nx * 3.1, ny * 3.1, _noiseT) as number) - 0.5;

      let audio = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const bx = (b + 0.5) / BAND_COUNT;
        const d = (nx - bx) * BAND_COUNT;
        audio += amps[b] * Math.exp(-d * d * 1.6);
      }
      audio = Math.min(1.4, audio * 0.85);

      const dx = nx - 0.5;
      const dy = ny - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const surgeArg = (dist - _surgeR * 0.7) ** 2;
      const surge = _surgeAmp * Math.exp(-surgeArg * 70);

      const target = base * 0.32 + audio * 0.9 + surge * 1.1;
      _height![idx] += (target - _height![idx]) * respRate;
    }
  }

  p.background(12, 9, 6);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  const depthScale = 1.4 + depth * 8.0;
  const cellW = p.width / cols;
  const cellH = p.height / rows;
  const gap = 0.86;
  const padX = (cellW * (1 - gap)) / 2;
  const padY = (cellH * (1 - gap)) / 2;
  const wCell = cellW * gap;
  const hCell = cellH * gap;

  for (let j = 0; j < rows; j++) {
    const jL = j > 0 ? j - 1 : j;
    const jR = j < rows - 1 ? j + 1 : j;
    for (let i = 0; i < cols; i++) {
      const iL = i > 0 ? i - 1 : i;
      const iR = i < cols - 1 ? i + 1 : i;
      const idx = j * cols + i;

      const hL = _height![j * cols + iL];
      const hR = _height![j * cols + iR];
      const hU = _height![jL * cols + i];
      const hD = _height![jR * cols + i];

      const dHdx = (hR - hL) * 0.5 * depthScale;
      const dHdy = (hD - hU) * 0.5 * depthScale;

      let nrmX = -dHdx;
      let nrmY = -dHdy;
      let nrmZ = 1;
      const nLen = Math.sqrt(nrmX * nrmX + nrmY * nrmY + nrmZ * nrmZ);
      nrmX /= nLen;
      nrmY /= nLen;
      nrmZ /= nLen;

      const diffuse = Math.max(0, nrmX * LXN + nrmY * LYN + nrmZ * LZN);
      const raised = Math.max(0, _height![idx]) * 0.1;
      const val = Math.min(1, 0.14 + diffuse * 0.92 + raised);

      const hue = WOOD_HUE + (HILITE_HUE - WOOD_HUE) * Math.min(1, val * 1.1);
      const sat = 42 - val * 16;
      const bri = val * 100;

      p.fill(hue, sat, bri);
      p.rect(i * cellW + padX, j * cellH + padY, wCell, hCell);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
