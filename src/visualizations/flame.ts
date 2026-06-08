/**
 * Fractal Flame — audio-reactive iterated function system "chaos game".
 *
 * Inspired by Scott Draves' Fractal Flame algorithm (1992) and his
 * Electric Sheep collaborative screensaver (1999–), which evolves flames
 * via a genetic algorithm and renders them with logarithmic-density tone
 * mapping for their signature luminous, organic glow:
 *   https://en.wikipedia.org/wiki/Fractal_flame
 *   https://en.wikipedia.org/wiki/Electric_Sheep
 *
 * A single point repeatedly jumps between 7 affine "transforms" — one per
 * frequency band — each blending its linear map with a nonlinear "variation"
 * (sinusoidal, swirl, spherical, horseshoe, polar). Thousands of these jumps
 * per frame accumulate into a density + hue buffer rendered with exponential
 * tone-mapping. Band amplitude both warps each transform's geometry and
 * weights how often the chaos game lands on it, so loud frequencies visibly
 * dominate the bloom; transient punches flare their lobe brighter. Beats
 * trigger small random "mutations" of the transform genes — an homage to
 * Electric Sheep's genetic evolution of flames — so the attractor's shape
 * organically reshapes itself in time with the music.
 *
 * Rendering: offscreen pixel buffer at 1/4 resolution (1/8 mobile),
 * persistent density accumulation with frame-rate-independent decay.
 *
 * Sliders
 *   Density   — chaos-game iterations per frame: sparse wisps → dense glowing nebula
 *   Glow      — tone-mapping brightness/saturation: dim embers → blazing radiant bloom
 *   Mutation  — magnitude of beat-triggered gene mutation: stable form → constantly reshaping organism
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;
const NUM_VARIATIONS = 6;
const TWO_PI = Math.PI * 2;

// One affine "gene" per frequency band: rotation/scale/translation + variation blend
interface Gene {
  scale: number;
  angle: number;
  angleSpeed: number;
  tx: number;
  ty: number;
  blend: number;
}

function makeGenes(): Gene[] {
  const genes: Gene[] = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    const a0 = (i / BAND_COUNT) * TWO_PI;
    genes.push({
      scale: 0.42 + (i % 3) * 0.06,
      angle: a0,
      angleSpeed: 0.05 + i * 0.03,
      tx: Math.cos(a0) * 0.42,
      ty: Math.sin(a0) * 0.42,
      blend: 0.45 + (i % 4) * 0.08,
    });
  }
  return genes;
}

// ── Module state ──────────────────────────────────────────────────────────────
let genes = makeGenes();
let time = 0;
let huePhase = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let chaosX = 0.05;
let chaosY = -0.03;

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let renderWidth = 0;
let renderHeight = 0;
let densityBuf: Float32Array | null = null;
let accRBuf: Float32Array | null = null;
let accGBuf: Float32Array | null = null;
let accBBuf: Float32Array | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function initOffscreen(canvasW: number, canvasH: number): void {
  renderWidth = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
  const cellCount = renderWidth * renderHeight;
  densityBuf = new Float32Array(cellCount);
  accRBuf = new Float32Array(cellCount);
  accGBuf = new Float32Array(cellCount);
  accBBuf = new Float32Array(cellCount);
}

/** HSV → RGB as floats in [0, 1] — used to precompute each band's accent color. */
function hsv2rgb(h: number, s: number, v: number): readonly [number, number, number] {
  const h6 = ((h % 360) + 360) % 360 / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  const pp = v * (1 - s);
  const q  = v * (1 - s * f);
  const uv = v * (1 - s * (1 - f));
  switch (i) {
    case 0:  return [v, uv, pp];
    case 1:  return [q, v, pp];
    case 2:  return [pp, v, uv];
    case 3:  return [pp, q, v];
    case 4:  return [uv, pp, v];
    default: return [v, pp, q];
  }
}

/** Classic fractal-flame nonlinear "variations" applied post-affine. */
function applyVariation(idx: number, x: number, y: number): readonly [number, number] {
  switch (idx) {
    case 0: // linear
      return [x, y];
    case 1: // sinusoidal
      return [Math.sin(x * Math.PI), Math.sin(y * Math.PI)];
    case 2: { // swirl
      const r2 = x * x + y * y;
      const s = Math.sin(r2);
      const c = Math.cos(r2);
      return [x * s - y * c, x * c + y * s];
    }
    case 3: { // spherical
      const r2 = x * x + y * y + 1e-6;
      return [x / r2, y / r2];
    }
    case 4: { // horseshoe
      const r = Math.sqrt(x * x + y * y) + 1e-6;
      return [((x - y) * (x + y)) / r, (2 * x * y) / r];
    }
    default: { // polar
      const r = Math.sqrt(x * x + y * y);
      const theta = Math.atan2(y, x);
      return [theta / Math.PI, r - 1];
    }
  }
}

/** Beat-triggered gene perturbation — homage to Electric Sheep's genetic evolution. */
function mutateGenes(strength: number): void {
  if (strength <= 0.002) return;
  const m = strength * 0.55;
  for (const g of genes) {
    g.angle += (Math.random() - 0.5) * m * 1.6;
    g.tx = Math.max(-0.85, Math.min(0.85, g.tx + (Math.random() - 0.5) * m * 0.7));
    g.ty = Math.max(-0.85, Math.min(0.85, g.ty + (Math.random() - 0.5) * m * 0.7));
    g.scale = Math.max(0.28, Math.min(0.74, g.scale + (Math.random() - 0.5) * m * 0.25));
    g.blend = Math.max(0.2, Math.min(0.85, g.blend + (Math.random() - 0.5) * m * 0.3));
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawFlame(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Init / resize check
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!offscreenCanvas || needW !== renderWidth || needH !== renderHeight) {
    initOffscreen(p.width, p.height);
  }
  const density = densityBuf!;
  const accR = accRBuf!;
  const accG = accGBuf!;
  const accB = accBBuf!;

  // Beat detection — mutate the IFS genes + hue jump + flash
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      mutateGenes(config.flameMutation);
      huePhase += 30 + Math.random() * 55;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.9, dt);

  time += 0.0085 * dt;

  // Frame-rate-independent fade of the persistent accumulation buffers
  const decay = Math.pow(0.965, dt);
  for (let i = 0; i < density.length; i++) {
    density[i] *= decay;
    accR[i] *= decay;
    accG[i] *= decay;
    accB[i] *= decay;
  }

  // Build live affine matrices + chaos-game selection weights for the 7 transforms
  const A = new Float64Array(BAND_COUNT);
  const B = new Float64Array(BAND_COUNT);
  const C = new Float64Array(BAND_COUNT);
  const D = new Float64Array(BAND_COUNT);
  const E = new Float64Array(BAND_COUNT);
  const F = new Float64Array(BAND_COUNT);
  const W = new Float64Array(BAND_COUNT);
  const BAND_R = new Float64Array(BAND_COUNT);
  const BAND_G = new Float64Array(BAND_COUNT);
  const BAND_B = new Float64Array(BAND_COUNT);
  let totalW = 0;
  let avgAmp = 0;
  for (let i = 0; i < BAND_COUNT; i++) {
    const g = genes[i];
    const amp = amps[i];
    avgAmp += amp;
    const liveScale = g.scale * (0.8 + amp * 0.55);
    const liveAngle = g.angle + time * g.angleSpeed;
    const ca = Math.cos(liveAngle);
    const sa = Math.sin(liveAngle);
    A[i] = liveScale * ca;  B[i] = -liveScale * sa;
    C[i] = liveScale * sa;  D[i] = liveScale * ca;
    E[i] = g.tx;            F[i] = g.ty;

    const punch = Math.max(0, transients[i] - 1);
    const w = 0.12 + amp * 1.6 + punch * 1.2;
    W[i] = w;
    totalW += w;

    // Precompute this band's accent color — accumulated per-pixel as a running
    // average so overlapping lobes blend smoothly into new hues (e.g. red+teal→white)
    // rather than the harsh last-write-wins flicker of storing one hue per pixel.
    const hue = ((i / BAND_COUNT) * 360 + huePhase) % 360;
    const [br, bg, bb] = hsv2rgb(hue, 0.8, 1.0);
    BAND_R[i] = br; BAND_G[i] = bg; BAND_B[i] = bb;
  }
  avgAmp /= BAND_COUNT;

  // Chaos-game iteration count: Density slider + overall loudness drive the bloom's fullness
  const baseIter = isMobile ? 650 : 1400;
  const maxIter  = isMobile ? 2000 : 5200;
  const iterCount = Math.round((baseIter + (maxIter - baseIter) * config.flameDensity) * (0.55 + avgAmp * 0.85));

  let cx = chaosX;
  let cy = chaosY;
  const w = renderWidth;
  const h = renderHeight;

  for (let k = 0; k < iterCount; k++) {
    // Weighted random transform pick — louder bands dominate the attractor
    let r = Math.random() * totalW;
    let idx = 0;
    for (; idx < BAND_COUNT - 1; idx++) {
      r -= W[idx];
      if (r <= 0) break;
    }

    const nx = A[idx] * cx + B[idx] * cy + E[idx];
    const ny = C[idx] * cx + D[idx] * cy + F[idx];
    const [vx, vy] = applyVariation(idx % NUM_VARIATIONS, nx, ny);
    const blend = genes[idx].blend;
    cx = nx * (1 - blend) + vx * blend;
    cy = ny * (1 - blend) + vy * blend;

    if (!isFinite(cx) || !isFinite(cy) || cx * cx + cy * cy > 6.25) {
      cx = (Math.random() - 0.5) * 0.3;
      cy = (Math.random() - 0.5) * 0.3;
      continue;
    }

    const px = ((cx * 0.34 + 0.5) * w) | 0;
    const py = ((cy * 0.34 + 0.5) * h) | 0;
    if (px < 0 || px >= w || py < 0 || py >= h) continue;

    const bi = py * w + px;
    density[bi] += 1;
    accR[bi] += BAND_R[idx];
    accG[bi] += BAND_G[idx];
    accB[bi] += BAND_B[idx];
  }

  chaosX = cx;
  chaosY = cy;

  // Render: tone-map accumulated hit-density into brightness via a log-density curve,
  // and blend each pixel's accumulated RGB into a running average accent color. This
  // averaged-color-by-density-weight approach (the classic flam3/Apophysis coloring
  // model) is what gives fractal flames their soft, graded, luminous-nebula glow —
  // overlapping lobes melt into new hues instead of producing hard per-pixel hue
  // boundaries between whichever transform last happened to land there.
  const glowFactor = (0.35 + config.flameGlow * 1.35) * 0.085;
  const imageData = offscreenCtx!.createImageData(renderWidth, renderHeight);
  const pixels = imageData.data;
  for (let i = 0; i < density.length; i++) {
    const off = i << 2;
    const d = density[i];
    if (d <= 0.03) {
      pixels[off] = 4; pixels[off + 1] = 2; pixels[off + 2] = 11; pixels[off + 3] = 255;
      continue;
    }
    const tone = 1 - Math.exp(-d * glowFactor);
    const bright = tone * (1 + beatFlash * 0.35);
    const inv = 1 / d;
    pixels[off]     = Math.min(255, (accR[i] * inv * bright * 255) | 0);
    pixels[off + 1] = Math.min(255, (accG[i] * inv * bright * 255) | 0);
    pixels[off + 2] = Math.min(255, (accB[i] * inv * bright * 255) | 0);
    pixels[off + 3] = 255;
  }

  offscreenCtx!.putImageData(imageData, 0, 0);

  // Scale pixel buffer up to full canvas size
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetFlame(): void {
  genes = makeGenes();
  time = 0;
  huePhase = Math.random() * 360;
  lastBeatIndex = -1;
  beatFlash = 0;
  chaosX = (Math.random() - 0.5) * 0.4;
  chaosY = (Math.random() - 0.5) * 0.4;
  // Force canvas + buffer reinit on next draw (handles resize)
  offscreenCanvas = null;
  offscreenCtx    = null;
  renderWidth     = 0;
  renderHeight    = 0;
  densityBuf      = null;
  accRBuf         = null;
  accGBuf         = null;
  accBBuf         = null;
}
