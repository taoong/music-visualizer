/**
 * Topography — Audio-reactive topographic contour map.
 *
 * Inspired by Tyler Hobbs' "Meridian" series (2022): his generative art
 * uses flow fields and quasi-parallel lines to evoke cartographic depth
 * and landscape quality (https://tylerxhobbs.com/essays/2020/flow-fields).
 * That same visual language — iso-elevation lines reading as terrain — is
 * applied here to live audio data so the spectrum becomes a living map.
 *
 * Seven frequency bands each drive the "elevation" of a horizontal stripe
 * across the canvas (sub-bass on left → brilliance on right). Perlin noise
 * provides an organic base terrain that drifts over time. Marching squares
 * extracts iso-contour lines at configurable elevation levels; each level
 * is hue-mapped to its nearest frequency band and drawn in two passes
 * (wide glow halo + bright core). Beats radiate a circular elevation surge
 * from the canvas centre.
 *
 * Sliders: Resolution (grid density), Levels (contour count), Speed (animation rate)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// Hue per band: blue→cyan→teal→green→yellow→orange→red (altitude-map palette)
const BAND_HUES = [240, 200, 160, 120, 80, 40, 0];

// Marching squares iso-line lookup table.
// Bit convention: TL=bit0, TR=bit1, BR=bit2, BL=bit3.
// Edge indices: 0=top, 1=right, 2=bottom, 3=left.
// Each entry: pairs [ea, eb] — draw line from edge ea midpoint to edge eb midpoint.
const MS_LINES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [],                    // 0:  0000  nothing
  [[3, 0]],              // 1:  0001  TL
  [[0, 1]],              // 2:  0010  TR
  [[3, 1]],              // 3:  0011  TL+TR
  [[1, 2]],              // 4:  0100  BR
  [[3, 2], [0, 1]],      // 5:  0101  TL+BR  (saddle A)
  [[0, 2]],              // 6:  0110  TR+BR
  [[3, 2]],              // 7:  0111  TL+TR+BR
  [[2, 3]],              // 8:  1000  BL
  [[0, 2]],              // 9:  1001  TL+BL
  [[0, 3], [1, 2]],      // 10: 1010  TR+BL  (saddle B)
  [[1, 2]],              // 11: 1011  TL+TR+BL
  [[1, 3]],              // 12: 1100  BR+BL
  [[0, 1]],              // 13: 1101  TL+BR+BL
  [[0, 3]],              // 14: 1110  TR+BR+BL
  [],                    // 15: 1111  all
];

// Reusable edge-point buffer — avoids per-frame GC in inner loop
const _ep: [[number, number], [number, number], [number, number], [number, number]] = [
  [0, 0], [0, 0], [0, 0], [0, 0],
];

// Module state
let _field: Float32Array | null = null;
let _gridW = 0;
let _gridH = 0;
let _noiseT = 0;
let _lastBeat = -1;
let _surgeAmp = 0;  // 0–1 beat-surge amplitude, decays each frame
let _surgeR = 0;    // 0–2 beat-surge radius, expands each frame

export function resetTopography(): void {
  _field = null;
  _gridW = 0;
  _gridH = 0;
  _noiseT = 0;
  _lastBeat = -1;
  _surgeAmp = 0;
  _surgeR = 0;
}

export function drawTopography(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const cols = Math.round(config.topographyResolution);
  const levels = Math.round(config.topographyLevels);
  const speed = config.topographySpeed;

  // Keep grid aspect ratio aligned to canvas
  const rows = Math.max(4, Math.round(cols * (p.height / p.width)));

  if (_gridW !== cols || _gridH !== rows) {
    _gridW = cols;
    _gridH = rows;
    _field = new Float32Array(cols * rows);
    for (let j = 0; j < _gridH; j++) {
      for (let i = 0; i < _gridW; i++) {
        _field[j * _gridW + i] = (p as any).noise(i * 0.15, j * 0.15, _noiseT) as number;
      }
    }
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeat) {
      _lastBeat = bi;
      _surgeAmp = 0.85;
      _surgeR = 0;
    }
  }

  _surgeR = Math.min(2.0, _surgeR + 0.032 * dt);
  _surgeAmp *= Math.pow(0.935, dt);
  _noiseT += speed * 0.003 * dt;

  // Build height field
  for (let j = 0; j < _gridH; j++) {
    for (let i = 0; i < _gridW; i++) {
      const nx = i / (_gridW - 1);
      const ny = j / (_gridH - 1);

      // Perlin base terrain — slow organic drift
      const base = (p as any).noise(nx * 2.5 + 0.3, ny * 2.5 + 0.7, _noiseT) as number;

      // Audio: each band heats up its horizontal stripe via Gaussian weighting
      let audio = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const bx = (b + 0.5) / BAND_COUNT;
        const d = (nx - bx) * BAND_COUNT;
        audio += amps[b] * Math.exp(-d * d * 1.8);
      }
      audio = Math.min(1.3, audio * 0.65);

      // Beat: circular elevation surge from canvas centre
      const dx = nx - 0.5;
      const dy = ny - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const surgeArg = (dist - _surgeR * 0.65) ** 2;
      const surge = _surgeAmp * Math.exp(-surgeArg * 85);

      _field![j * _gridW + i] = base * 0.28 + audio + surge;
    }
  }

  // Normalize height to [0, 1] so thresholds are stable
  let maxH = 1e-6;
  for (let k = 0, len = _gridW * _gridH; k < len; k++) {
    if (_field![k] > maxH) maxH = _field![k];
  }
  const invMax = 1 / maxH;

  const cellW = p.width / (_gridW - 1);
  const cellH = p.height / (_gridH - 1);

  p.background(2, 5, 20);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noFill();

  // Global energy for brightness modulation
  let gAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) gAmp += amps[b];
  gAmp = Math.min(1, gAmp / BAND_COUNT * 1.8);

  for (let lv = 0; lv < levels; lv++) {
    // Even distribution of thresholds in [0.06, 0.94]
    const thresh = 0.06 + (lv + 1) / (levels + 1) * 0.88;

    // Map this level to an interpolated band hue
    const frac = lv / Math.max(1, levels - 1);
    const bPos = frac * (BAND_COUNT - 1);
    const bLo = Math.floor(bPos);
    const bHi = Math.min(BAND_COUNT - 1, bLo + 1);
    const bf = bPos - bLo;

    const hue = BAND_HUES[bLo] + bf * (BAND_HUES[bHi] - BAND_HUES[bLo]);
    const lvAmp = amps[bLo] * (1 - bf) + amps[bHi] * bf;

    const sat = 55 + lvAmp * 45;
    const bri = 42 + lvAmp * 58 + _surgeAmp * 22 + gAmp * 8;

    // Glow pass: wide, low alpha
    p.strokeWeight(3.2 + lvAmp * 3.5);
    p.stroke(hue, sat * 0.5, bri * 0.75, 16 + lvAmp * 24);
    marchContour(p, thresh, invMax, cellW, cellH);

    // Core pass: thin, bright
    p.strokeWeight(0.85 + lvAmp * 1.0);
    p.stroke(hue, sat, Math.min(100, bri), 65 + lvAmp * 35);
    marchContour(p, thresh, invMax, cellW, cellH);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

function marchContour(
  p: P5Instance,
  thresh: number,
  invMax: number,
  cellW: number,
  cellH: number,
): void {
  if (!_field) return;

  for (let j = 0; j < _gridH - 1; j++) {
    for (let i = 0; i < _gridW - 1; i++) {
      const tl = _field[j * _gridW + i] * invMax;
      const tr = _field[j * _gridW + (i + 1)] * invMax;
      const br = _field[(j + 1) * _gridW + (i + 1)] * invMax;
      const bl = _field[(j + 1) * _gridW + i] * invMax;

      const c = (tl > thresh ? 1 : 0)
              | (tr > thresh ? 2 : 0)
              | (br > thresh ? 4 : 0)
              | (bl > thresh ? 8 : 0);

      const segs = MS_LINES[c];
      if (segs.length === 0) continue;

      const x0 = i * cellW;
      const y0 = j * cellH;

      // Linear interpolation along each edge for sub-cell precision
      const s0 = Math.max(0, Math.min(1, (thresh - tl) / (tr - tl + 1e-12)));
      const s1 = Math.max(0, Math.min(1, (thresh - tr) / (br - tr + 1e-12)));
      const s2 = Math.max(0, Math.min(1, (thresh - br) / (bl - br + 1e-12)));
      const s3 = Math.max(0, Math.min(1, (thresh - bl) / (tl - bl + 1e-12)));

      // Edge midpoints (top, right, bottom, left)
      _ep[0][0] = x0 + s0 * cellW;          _ep[0][1] = y0;
      _ep[1][0] = x0 + cellW;               _ep[1][1] = y0 + s1 * cellH;
      _ep[2][0] = x0 + (1 - s2) * cellW;    _ep[2][1] = y0 + cellH;
      _ep[3][0] = x0;                        _ep[3][1] = y0 + (1 - s3) * cellH;

      for (let si = 0; si < segs.length; si++) {
        const [ea, eb] = segs[si];
        p.line(_ep[ea][0], _ep[ea][1], _ep[eb][0], _ep[eb][1]);
      }
    }
  }
}
