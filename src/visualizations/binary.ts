/**
 * Binary/ASCII "Matrix rain" visualization
 *
 * Grid of monospaced characters mapped to 7 frequency bands.
 * Characters cascade downward, cycling rapidly when their band spikes.
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// Character pool: binary digits + ASCII symbols
const CHARS = '01010101<>{}[]|/\\@#$%&*=+~^01010101';

// Grid state
const CELL_SIZE = 18;
let cols = 0;
let rows = 0;
let grid: string[] = [];          // flat array [row * cols + col]
let brightness: Float32Array = new Float32Array(0);
let cascadeOffset: Float32Array = new Float32Array(0); // per-column vertical offset
let flashTimer: Float32Array = new Float32Array(0);    // per-cell white flash countdown
// Ripples: fired per amplitude spike (any band's transient), not just on
// the beat grid — each gets its own random epicenter and expands outward
// as a circular brightness wavefront across the whole grid, independent
// of the column that band happens to live in.
interface Ripple {
  ox: number;        // origin column
  oy: number;        // origin row
  age: number;        // seconds since spawn
  maxRadius: number; // cells, beyond which the ripple is removed
}
let ripples: Ripple[] = [];
const spikeCooldown: Float32Array = new Float32Array(BAND_COUNT); // seconds remaining before that band can fire another ripple
const RIPPLE_SPEED = 26;       // cells/sec
const RIPPLE_BAND_WIDTH = 2.2; // cells — thickness of the bright wavefront
const MAX_RIPPLES = 14;

function initGrid(w: number, h: number): void {
  cols = Math.max(1, Math.floor(w / CELL_SIZE));
  rows = Math.max(1, Math.floor(h / CELL_SIZE));
  const total = cols * rows;
  grid = new Array(total);
  brightness = new Float32Array(total);
  flashTimer = new Float32Array(total);
  cascadeOffset = new Float32Array(cols);

  for (let i = 0; i < total; i++) {
    grid[i] = CHARS[Math.floor(Math.random() * CHARS.length)];
    brightness[i] = 0;
    flashTimer[i] = 0;
  }
  for (let c = 0; c < cols; c++) {
    cascadeOffset[c] = Math.random() * rows;
  }
}

function columnToBand(col: number): number {
  const bandCount = BAND_COUNT;
  return Math.min(Math.floor((col / cols) * bandCount), bandCount - 1);
}

export function drawBinary(p: P5Instance, dt: number): void {
  const { config } = store;
  const bandCount = BAND_COUNT;

  // Reinit grid if canvas size changed
  const needCols = Math.max(1, Math.floor(p.width / CELL_SIZE));
  const needRows = Math.max(1, Math.floor(p.height / CELL_SIZE));
  if (needCols !== cols || needRows !== rows) {
    initGrid(p.width, p.height);
  }

  // Get per-band audio data
  const { amps, transients, deltas } = getBandAverages(bandCount);

  // Overall energy for cascade speed
  let totalEnergy = 0;
  for (let b = 0; b < bandCount; b++) totalEnergy += amps[b];
  const avgEnergy = totalEnergy / bandCount;

  const dtSec = (dt * 16.667) / 1000;

  // Fire a ripple from a random epicenter whenever a band spikes — not tied
  // to the beat grid, so quiet tracks with no detected BPM still ripple on
  // every transient, and loud passages can have several ripples overlapping.
  for (let b = 0; b < bandCount; b++) {
    spikeCooldown[b] = Math.max(0, spikeCooldown[b] - dtSec);
    if (transients[b] > 1.5 && spikeCooldown[b] <= 0) {
      spikeCooldown[b] = 0.12;
      if (ripples.length < MAX_RIPPLES) {
        ripples.push({
          ox: Math.random() * cols,
          oy: Math.random() * rows,
          age: 0,
          maxRadius: Math.sqrt(cols * cols + rows * rows) * 0.75,
        });
      }
    }
  }
  for (const r of ripples) r.age += dtSec;
  ripples = ripples.filter(r => r.age * RIPPLE_SPEED < r.maxRadius);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;
  pAny.colorMode(p['HSB'], 360, 100, 100);
  pAny.textFont('monospace');
  pAny.textSize(CELL_SIZE * 0.85);
  pAny.textAlign(p['CENTER'], p['CENTER']);
  p.noStroke();

  const scale = config.spikeScale;

  for (let c = 0; c < cols; c++) {
    const band = columnToBand(c);
    const amp = Math.min(amps[band] * scale, 1);
    const tMult = transients[band];
    const delta = deltas[band];

    // Cascade: scroll offset downward, speed proportional to band amplitude
    const cascadeSpeed = (0.3 + amp * 2.5 + avgEnergy * 1.0) * dt;
    cascadeOffset[c] = (cascadeOffset[c] + cascadeSpeed) % rows;

    for (let r = 0; r < rows; r++) {
      const idx = r * cols + c;

      // Cascade row: shift row by offset to create downward motion
      const shiftedRow = (r + Math.floor(cascadeOffset[c])) % rows;
      const shiftedIdx = shiftedRow * cols + c;

      // Character cycling: high amplitude → rapid random cycling
      const cycleChance = amp * 0.6 + delta * 0.3;
      if (Math.random() < cycleChance * dt) {
        grid[shiftedIdx] = CHARS[Math.floor(Math.random() * CHARS.length)];
      }

      // Target brightness from amplitude + delta boost
      const targetBright = 20 + amp * 65 + delta * 15;
      // Smooth brightness with fast attack, slow release
      const current = brightness[idx];
      if (targetBright > current) {
        brightness[idx] += (targetBright - current) * 0.4 * dt;
      } else {
        brightness[idx] += (targetBright - current) * 0.08 * dt;
      }

      // Transient flash
      if (tMult > 1.5) {
        flashTimer[idx] = 0.15; // 150ms flash
      }
      flashTimer[idx] = Math.max(0, flashTimer[idx] - (dt * 16.667) / 1000);

      // Sum the brightness contribution from every active ripple whose
      // expanding circular wavefront currently passes near this cell.
      let waveBrightBoost = 0;
      for (const rp of ripples) {
        const cellDist = Math.sqrt((c - rp.ox) ** 2 + (r - rp.oy) ** 2);
        const waveRadius = rp.age * RIPPLE_SPEED;
        const distFromWave = Math.abs(cellDist - waveRadius);
        if (distFromWave < RIPPLE_BAND_WIDTH) {
          const fade = 1 - rp.age * RIPPLE_SPEED / rp.maxRadius; // dims as it expands
          waveBrightBoost += (1 - distFromWave / RIPPLE_BAND_WIDTH) * 55 * fade;
        }
      }

      // Color: green-tinted hue, shifted slightly by band
      const hue = 120 + band * 3; // 120 = green, slight variation
      const sat = 80 - amp * 20;  // desaturate slightly at high amplitude
      const brt = Math.min(brightness[idx] + waveBrightBoost, 100);

      if (flashTimer[idx] > 0) {
        // White flash during transient
        pAny.fill(120, 10, 100);
      } else {
        pAny.fill(hue, sat, brt);
      }

      // Slight scale-up on amplitude
      const charScale = 1 + amp * 0.15;
      const cx = c * CELL_SIZE + CELL_SIZE / 2;
      const cy = r * CELL_SIZE + CELL_SIZE / 2;

      if (charScale > 1.02) {
        p.push();
        p.translate(cx, cy);
        p.scale(charScale);
        pAny.text(grid[shiftedIdx], 0, 0);
        p.pop();
      } else {
        pAny.text(grid[shiftedIdx], cx, cy);
      }
    }
  }

  // Reset color mode
  p.colorMode(p['RGB'], 255);
}

export function resetBinary(): void {
  cols = 0;
  rows = 0;
  grid = [];
  brightness = new Float32Array(0);
  cascadeOffset = new Float32Array(0);
  flashTimer = new Float32Array(0);
  ripples = [];
  spikeCooldown.fill(0);
}
