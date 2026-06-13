/**
 * Origami — audio-reactive faceted pleat tessellation.
 *
 * Inspired by "132 5. ISSEY MIYAKE" (launched 2010) — Miyake's Reality Lab,
 * working with computer scientist Jun Mitani, computes flat geometric crease
 * patterns that fold a single piece of cloth into sharp three-dimensional
 * polyhedral forms, their facets catching the light like sheets of colored
 * foil.
 * https://www.dezeen.com/2010/10/05/132-5-by-issey-miyake/
 *
 * A grid of parallelogram facets is displaced into a Miura-ori-style
 * herringbone pleat: alternating "peak" and "valley" grid points rise and
 * fall along a per-column fold depth, warping the whole sheet. Seven
 * columnar zones map sub-bass (left) through brilliance (right) to the
 * seven frequency bands — louder bands fold their zone deeper. Each facet's
 * brightness comes from a simple per-triangle normal/light calculation
 * against the live height field, so steeper folds catch sharper highlights
 * and shadows. Beats fire a diagonal "fold wave" that ripples once across
 * the sheet, briefly deepening every pleat as it passes.
 *
 * Sliders
 *   Fold — base pleat depth (0 = nearly flat sheet with faint creases,
 *          1 = deep dramatic accordion folds)
 *   Grid — tessellation density (6–24 columns)
 *   Wave — speed and reach of the beat-triggered fold wave
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const MIN_COLS = 6;
const MAX_COLS = isMobile ? 16 : 24;
const MAX_ROWS = isMobile ? 24 : 32;

// Hue per columnar zone: sub-bass (left) → brilliance (right), foil-like jewel tones
const BAND_HUES: readonly number[] = [275, 235, 195, 150, 95, 40, 350];

// Unit-ish light direction used for per-facet shading
const LIGHT_X = -0.45;
const LIGHT_Y = -0.72;
const LIGHT_Z = 0.54;

// Screen-space displacement scale per unit of fold height (relative to cell size)
const DISPLACE_X = 0.08;
const DISPLACE_Y = 0.20;

// Reusable buffers sized for the largest possible grid — no per-frame allocation
const GRID_BUF_SIZE = (MAX_COLS + 1) * (MAX_ROWS + 1);
const _H  = new Float32Array(GRID_BUF_SIZE);
const _PX = new Float32Array(GRID_BUF_SIZE);
const _PY = new Float32Array(GRID_BUF_SIZE);

let _time = 0;
let _lastBeatIdx = -1;
let _beatFlash = 0;
let _waveTime = 10; // start past the sweep range so no wave plays before the first beat

export function resetOrigami(): void {
  _time = 0;
  _lastBeatIdx = -1;
  _beatFlash = 0;
  _waveTime = 10;
}

export function drawOrigami(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round(config.origamiGrid)));
  const W = p.width;
  const H = p.height;
  const rows = Math.max(4, Math.min(MAX_ROWS, Math.round(cols * (H / W))));

  const fold = config.origamiFold;
  const wave = config.origamiWave;

  // ── beat: restart the diagonal fold wave ──────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeatIdx) {
      _lastBeatIdx = bi;
      _beatFlash = 1;
      _waveTime = 0;
    }
  }
  _beatFlash *= Math.pow(0.9, dt);
  _time += dt * 0.01;
  _waveTime += dt * (0.012 + wave * 0.05);

  const baseFold  = 0.12 + fold * 0.7;
  const waveWidth = 0.10 + wave * 0.12;
  const waveAmp   = (0.5 + wave * 1.5) * _beatFlash;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 1);
  p.background(255, 28, 6);

  const margin   = Math.min(W, H) * 0.05;
  const cellSize = Math.min((W - margin * 2) / cols, (H - margin * 2) / rows);
  const gx0 = (W - cellSize * cols) / 2;
  const gy0 = (H - cellSize * rows) / 2;
  const stride = cols + 1;

  // ── height field: herringbone pleat depth + travelling fold wave ─────────
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const zone = Math.min(BAND_COUNT - 1, Math.floor((i / cols) * BAND_COUNT));
      const drift = 0.85 + 0.3 * p.noise(i * 0.25, j * 0.15, _time);
      const colFold = baseFold * (0.35 + amps[zone] * 1.4) * drift;

      const diag = (i + j) / (cols + rows);
      const waveDist = Math.abs(diag - _waveTime);
      const wAmt = waveDist < waveWidth ? (1 - waveDist / waveWidth) * waveAmp : 0;

      const parity = (i + j) % 2 === 0 ? 1 : -1;
      const h = parity * (colFold + wAmt);

      const idx = j * stride + i;
      _H[idx]  = h;
      _PX[idx] = gx0 + i * cellSize + h * cellSize * DISPLACE_X;
      _PY[idx] = gy0 + j * cellSize + h * cellSize * DISPLACE_Y;
    }
  }

  // ── render: 2 shaded facets per cell ──────────────────────────────────────
  p.strokeWeight(1);
  const driftHue = (_time * 6) % 360;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const i00 = j * stride + i;
      const i10 = j * stride + i + 1;
      const i11 = (j + 1) * stride + i + 1;
      const i01 = (j + 1) * stride + i;

      const h0 = _H[i00], h1 = _H[i10], h2 = _H[i11], h3 = _H[i01];
      const x0 = _PX[i00], y0 = _PY[i00];
      const x1 = _PX[i10], y1 = _PY[i10];
      const x2 = _PX[i11], y2 = _PY[i11];
      const x3 = _PX[i01], y3 = _PY[i01];

      const zone = Math.min(BAND_COUNT - 1, Math.floor((i / cols) * BAND_COUNT));
      const amp = amps[zone];
      const hue = (BAND_HUES[zone] + driftHue) % 360;
      const sat = 60 + amp * 25;
      const baseBri = 22 + amp * 45 + _beatFlash * 18;

      // Facet A-B-D: normal = (h0-h1, h0-h3, 1)
      let nx = h0 - h1, ny = h0 - h3;
      let lum = (nx * LIGHT_X + ny * LIGHT_Y + LIGHT_Z) / Math.sqrt(nx * nx + ny * ny + 1);
      let shade = Math.max(0.12, Math.min(1.15, 0.55 + lum * 0.6));
      let bri = Math.min(100, baseBri * shade);
      p.fill(hue, sat, bri);
      p.stroke(hue, sat * 0.5, bri * 0.55, 0.6);
      p.triangle(x0, y0, x1, y1, x3, y3);

      // Facet B-C-D: normal = (h3-h1, h1-h2, 1)
      nx = h3 - h1; ny = h1 - h2;
      lum = (nx * LIGHT_X + ny * LIGHT_Y + LIGHT_Z) / Math.sqrt(nx * nx + ny * ny + 1);
      shade = Math.max(0.12, Math.min(1.15, 0.55 + lum * 0.6));
      bri = Math.min(100, baseBri * shade);
      p.fill(hue, sat, bri);
      p.stroke(hue, sat * 0.5, bri * 0.55, 0.6);
      p.triangle(x1, y1, x2, y2, x3, y3);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
