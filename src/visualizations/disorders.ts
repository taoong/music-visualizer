/**
 * Disorders — audio-reactive lattice of perturbed ink strokes.
 *
 * Inspired by Vera Molnár's "(Des)Ordres" (1974) and "Interruptions"
 * (1968–69). Molnár — celebrated since her death in 2023 at age 99 in major
 * retrospectives as the "grandmother of generative art" — began both series
 * with a dense grid of identical parallel lines, then used algorithmic
 * random rotation ("disorder") and erased sections of the lattice
 * ("interruptions") to let an emergent order surface from apparent chaos.
 * https://www.artsy.net/article/artsy-editorial-vera-molnar-mother-computer-art-pioneered-future-abstraction
 *
 * A grid of short ink strokes starts perfectly aligned along one shared
 * diagonal. Seven vertical zones map to the seven frequency bands
 * (sub-bass on the left → brilliance on the right); each band's amplitude
 * rotates its zone's strokes away from the shared baseline toward each
 * stroke's own fixed random angle — louder bands "disorder" their slice of
 * the lattice. Beats fire expanding circular "interruption" waves that
 * erase a ring of strokes as they sweep past and reseed their angles,
 * echoing Molnár's literal voids cut into the grid.
 *
 * Sliders
 *   Grid      — lattice density (rows/cols)
 *   Disorder  — baseline rotational chaos (0 = a single ordered hatch,
 *               1 = every stroke at its own random angle)
 *   Interrupt — strength/spread of beat-triggered erasure waves
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Shared "ordered" stroke angle — every cell aligns here at Disorder = 0
const BASE_ANGLE = Math.PI / 4;

const MAX_GRID = isMobile ? 20 : 32;
const MAX_INTERRUPTIONS = 4;

interface Interruption {
  cx: number;
  cy: number;
  radius: number;
  id: number;
}

// ── Module state ────────────────────────────────────────────────────────────
let _cols = 0;
let _rows = 0;
let _seedAngle: Float32Array | null = null;
let _seedLen: Float32Array | null = null;
let _curAngle: Float32Array | null = null;
let _curAlpha: Float32Array | null = null;
let _hitId: Int32Array | null = null;
let _bandIdx: Uint8Array | null = null;

let _interruptions: Interruption[] = [];
let _nextWaveId = 0;
let _lastBeatIdx = -1;
let _beatFlash = 0;

export function resetDisorders(): void {
  _cols = 0;
  _rows = 0;
  _seedAngle = null;
  _seedLen = null;
  _curAngle = null;
  _curAlpha = null;
  _hitId = null;
  _bandIdx = null;
  _interruptions = [];
  _nextWaveId = 0;
  _lastBeatIdx = -1;
  _beatFlash = 0;
}

function regenerate(cols: number, rows: number): void {
  _cols = cols;
  _rows = rows;
  const n = cols * rows;
  _seedAngle = new Float32Array(n);
  _seedLen = new Float32Array(n);
  _curAngle = new Float32Array(n);
  _curAlpha = new Float32Array(n);
  _hitId = new Int32Array(n).fill(-1);
  _bandIdx = new Uint8Array(n);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      // Lines have 180° symmetry, so [0, π) covers every distinct orientation
      _seedAngle[i] = Math.random() * Math.PI;
      _seedLen[i] = 0.65 + Math.random() * 0.6;
      _curAngle[i] = BASE_ANGLE;
      _curAlpha[i] = 1;
      _bandIdx[i] = Math.min(BAND_COUNT - 1, Math.floor((col / cols) * BAND_COUNT));
    }
  }
}

export function drawDisorders(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const cols = Math.max(4, Math.min(MAX_GRID, Math.round(config.disordersGrid)));
  const rows = Math.max(4, Math.round(cols * (p.height / p.width)));
  if (cols !== _cols || rows !== _rows || !_seedAngle) regenerate(cols, rows);

  const chaos = config.disordersChaos;
  const interrupt = config.disordersInterrupt;

  // ── beat: spawn expanding "interruption" erasure waves ──────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeatIdx) {
      _lastBeatIdx = bi;
      _beatFlash = 1;
      const waveCount = 1 + Math.floor(interrupt * 2);
      for (let w = 0; w < waveCount; w++) {
        _interruptions.push({ cx: Math.random() * cols, cy: Math.random() * rows, radius: 0, id: _nextWaveId++ });
      }
      while (_interruptions.length > MAX_INTERRUPTIONS) _interruptions.shift();
    }
  }
  _beatFlash *= Math.pow(0.9, dt);

  const growSpeed = 0.04 + interrupt * 0.18;
  const bandWidth = 1.2 + interrupt * 2.8;
  const maxR = Math.sqrt(cols * cols + rows * rows) + bandWidth;
  for (const wv of _interruptions) wv.radius += growSpeed * dt;
  _interruptions = _interruptions.filter(wv => wv.radius < maxR);

  // ── background: cool ink-on-paper, hue drifting with spectral centroid ──
  (p as any).colorMode(p['HSB'], 360, 100, 100, 1);
  const bgHue = (210 + audioState.smoothedCentroid * 60) % 360;
  p.background(bgHue, 18, 5 + _beatFlash * 4);

  const W = p.width;
  const H = p.height;
  const margin = Math.min(W, H) * 0.03;
  const cellSize = Math.min((W - margin * 2) / cols, (H - margin * 2) / rows);
  const gx0 = (W - cellSize * cols) / 2;
  const gy0 = (H - cellSize * rows) / 2;

  const easeT = 1 - Math.pow(0.85, dt);
  const baseWeight = isMobile ? 1.0 : 1.3;
  const lineHue = (bgHue + 25) % 360;
  const sat = 5 + (1 - chaos) * 5;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const band = _bandIdx![i];
      const amp = amps[band];

      // ── disorder: blend from the shared baseline toward this cell's
      // own random angle, driven by the slider plus its band's loudness
      const disorderAmt = Math.min(1, chaos + amp * 0.6);
      const targetAngle = BASE_ANGLE + (_seedAngle![i] - BASE_ANGLE) * disorderAmt;
      _curAngle![i] += (targetAngle - _curAngle![i]) * easeT;

      // ── interruption: erase + reseed strokes caught in a passing wave ──
      let erase = 0;
      for (const wv of _interruptions) {
        const dx = col + 0.5 - wv.cx;
        const dy = row + 0.5 - wv.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const gap = wv.radius - dist;
        if (gap >= 0 && gap < bandWidth) {
          erase = Math.max(erase, 1 - gap / bandWidth);
          if (_hitId![i] !== wv.id) {
            _hitId![i] = wv.id;
            _seedAngle![i] = Math.random() * Math.PI;
          }
        }
      }
      const targetAlpha = 1 - erase * 0.92;
      _curAlpha![i] += (targetAlpha - _curAlpha![i]) * easeT;
      const alpha = _curAlpha![i];

      const len = cellSize * (0.36 + amp * 0.3) * _seedLen![i];
      const halfLen = len * 0.5;
      const ang = _curAngle![i];
      const dxh = Math.cos(ang) * halfLen;
      const dyh = Math.sin(ang) * halfLen;

      const ccx = gx0 + (col + 0.5) * cellSize;
      const ccy = gy0 + (row + 0.5) * cellSize;

      const bri = Math.min(100, (38 + amp * 50 + _beatFlash * 25) * alpha);
      const weight = (baseWeight + amp * 1.6 + Math.max(0, transients[band] - 1) * 2.5) * (0.3 + 0.7 * alpha);

      p.stroke(lineHue, sat, bri, Math.max(0.04, alpha));
      p.strokeWeight(weight);
      p.line(ccx - dxh, ccy - dyh, ccx + dxh, ccy + dyh);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
