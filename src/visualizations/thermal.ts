/**
 * Thermal — Audio-reactive heat diffusion simulation.
 *
 * Inspired by Olafur Eliasson's "The Weather Project" (2003, Tate Modern Turbine
 * Hall, London, https://olafureliasson.net/artwork/the-weather-project-2003/),
 * where a single artificial sun flooded the hall with warm infrared-orange light
 * that cooled to deep blue-violet at the periphery — recreating the visual
 * signature of a thermal camera. Here that physical phenomenon is simulated:
 * 7 heat emitters (one per frequency band) drift via Perlin noise and inject
 * energy into a 2D diffusion grid; heat spreads to neighboring cells each frame
 * via a Laplacian kernel and cools passively. Beats fire a radial heat surge
 * from the canvas center. The grid is mapped to color via three interchangeable
 * thermal palettes.
 *
 * Rendering: ¼-res pixel buffer (⅙ mobile) with linear upscale.
 * Mobile guard: larger grid cells and simplified diffusion step.
 *
 * Sliders
 *   Diffuse  — heat spread rate (slow diffusion = sharp hotspots, fast = soft halos)
 *   Intensity — emitter temperature multiplier
 *   Palette  — 0 = FLIR thermal (purple→blue→cyan→green→yellow→red→white),
 *               0.5 = lava (black→red→orange→yellow→white),
 *               1 = arctic ice (black→navy→cyan→white)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 3;

// One emitter per freq band; position driven by Perlin noise seed offsets
const EMITTER_NX: number[] = [];
const EMITTER_NY: number[] = [];

for (let i = 0; i < BAND_COUNT; i++) {
  EMITTER_NX.push(i * 137.508 + 11.0);
  EMITTER_NY.push(i * 97.333 + 55.0);
}

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green,
//               upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

let grid: Float32Array | null = null;
let gW = 0;
let gH = 0;
let imgData: ImageData | null = null;
let offCanvas: HTMLCanvasElement | null = null;
let offCtx: CanvasRenderingContext2D | null = null;

let t = 0;          // Perlin noise time
let hueShift = 0;   // cumulative hue shift on beats
let lastBeatIndex = -1;

export function resetThermal(): void {
  grid = null;
  gW = 0;
  gH = 0;
  imgData = null;
  offCanvas = null;
  offCtx = null;
  t = 0;
  hueShift = 0;
  lastBeatIndex = -1;
}

// --- colour mapping ---

// 5-stop gradient control points: [temperature, r, g, b]
const PALETTE_THERMAL: readonly [number, number, number, number][] = [
  [0.00,   0,   0,   0],
  [0.12,  60,   0,  80],   // deep violet
  [0.28,   0,   0, 180],   // royal blue
  [0.45,   0, 200, 200],   // cyan
  [0.60,   0, 200,  50],   // green
  [0.72, 200, 200,   0],   // yellow
  [0.84, 255,  80,   0],   // orange
  [0.93, 255,   0,   0],   // red
  [1.00, 255, 255, 255],   // white hot
];

const PALETTE_LAVA: readonly [number, number, number, number][] = [
  [0.00,   0,   0,   0],
  [0.25,  80,   0,   0],
  [0.50, 200,  40,   0],
  [0.70, 255, 140,   0],
  [0.85, 255, 220,  80],
  [1.00, 255, 255, 255],
];

const PALETTE_ICE: readonly [number, number, number, number][] = [
  [0.00,   0,   0,   0],
  [0.20,   0,   0,  80],
  [0.45,   0,  60, 200],
  [0.65,   0, 200, 255],
  [0.82,  80, 230, 255],
  [1.00, 255, 255, 255],
];

function sampleGradient(
  stops: readonly [number, number, number, number][],
  t: number,
): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const [t0, r0, g0, b0] = stops[i - 1];
    const [t1, r1, g1, b1] = stops[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

function tempToColor(temp: number, palette: number): [number, number, number] {
  if (palette < 0.5) {
    const [tr, tg, tb] = sampleGradient(PALETTE_THERMAL, temp);
    const [lr, lg, lb] = sampleGradient(PALETTE_LAVA, temp);
    const f = palette * 2;
    return [tr + f * (lr - tr), tg + f * (lg - tg), tb + f * (lb - tb)];
  } else {
    const [lr, lg, lb] = sampleGradient(PALETTE_LAVA, temp);
    const [ir, ig, ib] = sampleGradient(PALETTE_ICE, temp);
    const f = (palette - 0.5) * 2;
    return [lr + f * (ir - lr), lg + f * (ig - lg), lb + f * (ib - lb)];
  }
}

export function drawThermal(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const newGW = Math.max(1, Math.floor(W / PIXEL_SCALE));
  const newGH = Math.max(1, Math.floor(H / PIXEL_SCALE));

  // Initialise / resize grid + pixel buffer
  if (grid === null || newGW !== gW || newGH !== gH) {
    gW = newGW;
    gH = newGH;
    grid = new Float32Array(gW * gH);
    offCanvas = document.createElement('canvas');
    offCanvas.width = gW;
    offCanvas.height = gH;
    offCtx = offCanvas.getContext('2d')!;
    imgData = offCtx.createImageData(gW, gH);
  }

  const diffuseBase = config.thermalDiffuse;
  const intensity   = config.thermalIntensity;
  const palette     = config.thermalPalette;

  // dt-normalised time step (60fps baseline)
  const step = dt / 16.667;

  // --- Beat detection ---
  const { lastBeatIndex: beatIdx } = state;
  const beatFired = beatIdx !== lastBeatIndex && beatIdx >= 0;
  if (beatFired) {
    lastBeatIndex = beatIdx;
    hueShift = (hueShift + 47) % 360;
    // Inject radial heat burst from canvas center
    const cx = gW >> 1;
    const cy = gH >> 1;
    const burstR = Math.min(gW, gH) * 0.35;
    for (let y = 0; y < gH; y++) {
      for (let x = 0; x < gW; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < burstR) {
          const heat = (1 - d / burstR) * 0.65 * intensity;
          grid[y * gW + x] = Math.min(1, grid[y * gW + x] + heat);
        }
      }
    }
  }

  // --- Advance Perlin noise time ---
  t += 0.0006 * step;

  // --- Inject emitter heat ---
  const emitRadius = Math.max(3, Math.min(gW, gH) * 0.12);
  const emitRadiusSq = emitRadius * emitRadius;

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    const tMult = transients[b];
    if (amp < 0.01) continue;

    // Drift emitter position via Perlin noise
    const nx = EMITTER_NX[b];
    const ny = EMITTER_NY[b];
    const ex = (p.noise(nx, t * 0.8) * 0.78 + 0.11) * gW;
    const ey = (p.noise(ny, t * 0.8 + 50) * 0.78 + 0.11) * gH;

    const heatValue = amp * intensity * tMult * 0.12 * step;

    // Splat heat in a disc around emitter
    const x0 = Math.max(0, Math.floor(ex - emitRadius));
    const x1 = Math.min(gW - 1, Math.ceil(ex + emitRadius));
    const y0 = Math.max(0, Math.floor(ey - emitRadius));
    const y1 = Math.min(gH - 1, Math.ceil(ey + emitRadius));

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx - ex;
        const dy = gy - ey;
        const dsq = dx * dx + dy * dy;
        if (dsq < emitRadiusSq) {
          const falloff = 1 - dsq / emitRadiusSq;
          grid[gy * gW + gx] = Math.min(1, grid[gy * gW + gx] + heatValue * falloff * falloff);
        }
      }
    }
  }

  // --- Diffusion pass (simple 5-point Laplacian, in-place approximation) ---
  // Coefficient scales with slider: 0 → no spread, 1 → fast spread
  const k = 0.08 + diffuseBase * 0.20;  // kernel weight [0.08 .. 0.28]
  const kStep = k * step;

  // Horizontal pass (read grid, accumulate delta)
  // We do a simplified separable approximation to avoid a second buffer:
  // just do one Jacobi-style step with neighbour average.
  const next = new Float32Array(gW * gH);

  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const idx = y * gW + x;
      const v = grid[idx];
      const left  = x > 0       ? grid[idx - 1]  : v;
      const right = x < gW - 1  ? grid[idx + 1]  : v;
      const up    = y > 0       ? grid[idx - gW]  : v;
      const down  = y < gH - 1  ? grid[idx + gW]  : v;
      const laplacian = left + right + up + down - 4 * v;
      next[idx] = v + kStep * laplacian;
    }
  }

  // --- Cooling ---
  const coolRate = 0.004 + (1 - diffuseBase) * 0.008; // more cooling when diffuse is low
  const coolFactor = 1 - coolRate * step;

  for (let i = 0, len = gW * gH; i < len; i++) {
    grid[i] = Math.max(0, next[i] * coolFactor);
  }

  // --- Render to pixel buffer ---
  const imd = imgData!;
  const pb = imd.data;
  for (let y = 0; y < gH; y++) {
    for (let x = 0; x < gW; x++) {
      const temp = grid[y * gW + x];
      const [r, g, b] = tempToColor(temp, palette);
      const pi = (y * gW + x) * 4;
      pb[pi]     = r;
      pb[pi + 1] = g;
      pb[pi + 2] = b;
      pb[pi + 3] = 255;
    }
  }

  offCtx!.putImageData(imd, 0, 0);

  // Upscale to full canvas with bilinear smoothing
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.drawImage(offCanvas!, 0, 0, gW, gH, 0, 0, W, H);

  // Band hue markers — faint dots at each emitter showing band mapping
  p.noStroke();
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.05) continue;
    const nx = EMITTER_NX[b];
    const ny = EMITTER_NY[b];
    const ex = (p.noise(nx, t * 0.8) * 0.78 + 0.11) * W;
    const ey = (p.noise(ny, t * 0.8 + 50) * 0.78 + 0.11) * H;
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
    p.fill((BAND_HUES[b] + hueShift) % 360, 80, 100, amp * 60);
    p.ellipse(ex, ey, 6, 6);
    p.ellipse(ex, ey, 14, 14);
    (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  }
}
