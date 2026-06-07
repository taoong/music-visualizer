/**
 * Voronoi Stained Glass — audio-reactive stained glass window.
 *
 * N seed points define a Voronoi tessellation; each cell is assigned to one of
 * 7 frequency bands and lit in that band's jewel-tone hue:
 *   amethyst → sapphire → aquamarine → emerald → topaz → amber → ruby
 * Cell brightness and saturation surge with band amplitude; 1-px dark lead
 * lines run between adjacent cells at buffer resolution (≈4 px on screen).
 * Beat detection fires a warm flash across the full window; the Shatter slider
 * scatters seeds on every beat then eases them back home, reorganising the
 * mosaic like a kaleidoscope click.
 *
 * Rendering: offscreen HTMLCanvasElement pixel buffer at ¼ res (⅛ mobile),
 * scaled up with bilinear smoothing. The Voronoi ownership map (pixel → nearest
 * seed index) is cached and only rebuilt when seeds change position.
 *
 * Inspired by Nervous System Studio's "Corollaria" collection (2019) by Jessica
 * Rosenkrantz and Jesse Louis-Rosenberg — organic centroidal Voronoi structures
 * that mirror the cellular organisation of botanical tissue.
 * https://n-e-r-v-o-u-s.com/blog/?p=7465
 *
 * Sliders
 *   Cells   — Voronoi seed count (10–80)
 *   Glow    — inner light intensity multiplier (0.2–3.0)
 *   Shatter — beat-scatter magnitude; 0 = stable window, 2 = chaotic crack (0–2)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;

// Jewel-tone hue (HSV degrees) for each frequency band
// amethyst  sapphire  aquamarine  emerald  topaz  amber  ruby
const BAND_HUES: readonly number[] = [270, 240, 195, 150, 60, 25, 345];

interface Seed {
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  scatterX: number;
  scatterY: number;
  bandIndex: number;
}

// ── Module state ───────────────────────────────────────────────────────────────
let seeds: Seed[] = [];
let voronoiMap: Int32Array | null = null;
let mapW = 0;
let mapH = 0;
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let renderWidth = 0;
let renderHeight = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let shatterDecay = 0;
let lastCellCount = -1;
let needsMapRebuild = false;

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildSeeds(count: number): void {
  // Near-uniform grid placement with jitter to avoid regularity
  const ar = 16 / 9;
  const cols = Math.max(1, Math.round(Math.sqrt(count * ar)));
  const rows = Math.max(1, Math.ceil(count / cols));
  seeds = [];
  let bi = 0;
  for (let r = 0; r < rows && seeds.length < count; r++) {
    for (let c = 0; c < cols && seeds.length < count; c++) {
      const jx = (Math.random() - 0.5) * 0.6 / cols;
      const jy = (Math.random() - 0.5) * 0.6 / rows;
      const hx = Math.max(0.02, Math.min(0.98, (c + 0.5) / cols + jx));
      const hy = Math.max(0.02, Math.min(0.98, (r + 0.5) / rows + jy));
      // Round-robin band assignment for even colour distribution
      const bandIndex = bi % BAND_COUNT;
      bi++;
      seeds.push({ homeX: hx, homeY: hy, x: hx, y: hy, scatterX: 0, scatterY: 0, bandIndex });
    }
  }
  needsMapRebuild = true;
}

function rebuildVoronoiMap(): void {
  if (!seeds.length) return;
  if (!voronoiMap || mapW !== renderWidth || mapH !== renderHeight) {
    voronoiMap = new Int32Array(renderWidth * renderHeight);
    mapW = renderWidth;
    mapH = renderHeight;
  }
  const map = voronoiMap;
  const W = renderWidth;
  const H = renderHeight;
  const n = seeds.length;
  // Typed arrays for inner-loop performance
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  for (let i = 0; i < n; i++) { sx[i] = seeds[i].x; sy[i] = seeds[i].y; }
  for (let py = 0; py < H; py++) {
    const ny = py / H;
    const rowOff = py * W;
    for (let px = 0; px < W; px++) {
      const nx = px / W;
      let minD = Infinity;
      let minI = 0;
      for (let i = 0; i < n; i++) {
        const dx = nx - sx[i];
        const dy = ny - sy[i];
        const d = dx * dx + dy * dy;
        if (d < minD) { minD = d; minI = i; }
      }
      map[rowOff + px] = minI;
    }
  }
  needsMapRebuild = false;
}

function initOffscreen(canvasW: number, canvasH: number): void {
  renderWidth  = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width  = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
  voronoiMap = null;
  mapW = 0;
  mapH = 0;
  needsMapRebuild = true;
}

/** HSV (h in degrees, s/v in [0,1]) → write RGBA into Uint8ClampedArray at byte offset. */
function hsv2rgba(h: number, s: number, v: number, px: Uint8ClampedArray, off: number): void {
  const h6 = ((h % 360) + 360) % 360 / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  const p  = v * (1 - s);
  const q  = v * (1 - s * f);
  const uv = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (i) {
    case 0:  r = v;  g = uv; b = p;  break;
    case 1:  r = q;  g = v;  b = p;  break;
    case 2:  r = p;  g = v;  b = uv; break;
    case 3:  r = p;  g = q;  b = v;  break;
    case 4:  r = uv; g = p;  b = v;  break;
    default: r = v;  g = p;  b = q;  break;
  }
  px[off]     = (r * 255 + 0.5) | 0;
  px[off + 1] = (g * 255 + 0.5) | 0;
  px[off + 2] = (b * 255 + 0.5) | 0;
  px[off + 3] = 255;
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawVoronoi(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const cellCount = Math.max(10, Math.min(isMobile ? 30 : 80, Math.round(config.voronoiCells)));
  const glow    = config.voronoiGlow;
  const shatter = config.voronoiShatter;

  // Init / resize check
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  const sizeChanged  = needW !== renderWidth || needH !== renderHeight;
  const countChanged = cellCount !== lastCellCount;

  if (!offscreenCanvas || sizeChanged) {
    initOffscreen(p.width, p.height);
  }

  if (countChanged) {
    lastCellCount = cellCount;
    buildSeeds(cellCount);
  }

  // Beat detection — flash + optional scatter
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatFlash = 1.0;
      if (shatter > 0 && seeds.length > 0) {
        const mag = shatter * 0.055;
        for (const seed of seeds) {
          seed.scatterX = (Math.random() - 0.5) * 2 * mag;
          seed.scatterY = (Math.random() - 0.5) * 2 * mag;
          seed.x = Math.max(0.01, Math.min(0.99, seed.homeX + seed.scatterX));
          seed.y = Math.max(0.01, Math.min(0.99, seed.homeY + seed.scatterY));
        }
        shatterDecay = 1.0;
        needsMapRebuild = true;
      }
    }
  }
  beatFlash *= Math.pow(0.84, dt);

  // Seeds ease back to home positions after scatter
  if (shatterDecay > 0) {
    shatterDecay = Math.max(0, shatterDecay - dt * 0.06);
    for (const seed of seeds) {
      seed.x = Math.max(0.01, Math.min(0.99, seed.homeX + seed.scatterX * shatterDecay));
      seed.y = Math.max(0.01, Math.min(0.99, seed.homeY + seed.scatterY * shatterDecay));
    }
    needsMapRebuild = true;
  }

  if (needsMapRebuild || !voronoiMap) {
    rebuildVoronoiMap();
  }

  // ── Pixel rendering ──
  const imageData = offscreenCtx!.createImageData(renderWidth, renderHeight);
  const pixels    = imageData.data;
  const W = renderWidth;
  const H = renderHeight;
  const map = voronoiMap!;

  // Pre-compute per-seed brightness/saturation for the hot loop
  const n = seeds.length;
  const seedSat = new Float32Array(n);
  const seedBri = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const amp  = amps[seeds[i].bandIndex];
    seedSat[i] = Math.min(1.0, 0.70 + amp * 0.30 + beatFlash * 0.12);
    seedBri[i] = Math.min(1.0, (0.12 + amp * 0.72) * glow + beatFlash * 0.28);
  }

  for (let py = 0; py < H; py++) {
    const rowOff = py * W;
    for (let px = 0; px < W; px++) {
      const idx = rowOff + px;
      const si  = map[idx];
      const off = idx * 4;
      // Lead line: 1-buffer-pixel-wide border between cells (~4 px on screen)
      const isEdge =
        (px < W - 1 && map[idx + 1] !== si) ||
        (py < H - 1 && map[idx + W] !== si);
      if (isEdge) {
        pixels[off]     = 8;
        pixels[off + 1] = 6;
        pixels[off + 2] = 10;
        pixels[off + 3] = 255;
      } else {
        hsv2rgba(BAND_HUES[seeds[si].bandIndex], seedSat[si], seedBri[si], pixels, off);
      }
    }
  }

  offscreenCtx!.putImageData(imageData, 0, 0);

  // Scale buffer up to full canvas
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function interactVoronoi(event: import('../types').InteractionEvent): void {
  const { type, x, y } = event;
  if (type === 'tap' || type === 'dragstart') {
    beatFlash = 1.0;
    if (seeds.length > 0) {
      // Shatter strength falls off with distance from tap point (in normalized coords)
      const mag = 0.06;
      for (const seed of seeds) {
        const sdx = seed.homeX - x;
        const sdy = seed.homeY - y;
        const dist = Math.sqrt(sdx * sdx + sdy * sdy);
        const falloff = Math.max(0, 1 - dist * 1.4);
        seed.scatterX = (Math.random() - 0.5) * 2 * mag * (0.3 + falloff);
        seed.scatterY = (Math.random() - 0.5) * 2 * mag * (0.3 + falloff);
        seed.x = Math.max(0.01, Math.min(0.99, seed.homeX + seed.scatterX));
        seed.y = Math.max(0.01, Math.min(0.99, seed.homeY + seed.scatterY));
      }
      shatterDecay = 1.0;
      needsMapRebuild = true;
    }
  }
}

export function resetVoronoi(): void {
  offscreenCanvas = null;
  offscreenCtx    = null;
  renderWidth     = 0;
  renderHeight    = 0;
  voronoiMap      = null;
  mapW            = 0;
  mapH            = 0;
  lastBeatIndex   = -1;
  beatFlash       = 0;
  shatterDecay    = 0;
  lastCellCount   = -1;
  needsMapRebuild = false;
  seeds           = [];
}
