/**
 * Dendron — Diffusion-Limited Aggregation crystal growth.
 *
 * Random walkers drift via Brownian motion until they touch the growing
 * cluster and freeze, producing fractal dendritic structures that echo
 * snowflake formation, electrochemical copper deposition, and mineral
 * crystal growth (Widmanstätten patterns in iron meteorites).
 *
 * Inspired by Andy Lomas' "Aggregation" series (2005–present), in which
 * DLA and similar stochastic-aggregation algorithms grow intricate
 * crystal-like 3D forms that blur the boundary between digital and
 * biological morphogenesis.
 * https://www.andylomas.com/morphogenicCreations.html
 *
 * 7 colonies (one per freq band) nucleate at positions spread across the
 * canvas; amplitude scales the active walker count; beats inject fresh
 * nucleation seeds so new crystal arms erupt on every kick.
 *
 * Sliders:
 *   Walkers (dendronWalkers) — growth density: 0=sparse needle, 1=dense thicket
 *   Stick   (dendronStick)   — capture radius: 0=fine needles, 1=thick branches
 *   Glow    (dendronGlow)    — crystal luminosity + outer halo brightness
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_WALKERS  = isMobile ? 80 : 280;
const MAX_CLUSTER  = isMobile ? 700 : 2200;  // points per colony
const WALK_STEP    = 2.8;                     // px per frame-unit
const CELL_SIZE    = 6;                       // spatial-hash cell (px)

// Hue per band: violet → blue → cyan → teal → green → yellow → red
const BAND_HUES = [272, 246, 210, 182, 138, 78, 14] as const;
const OUTER_CSS  = BAND_HUES.map(h => `hsl(${h},100%,72%)`);
const CORE_CSS   = BAND_HUES.map(h => `hsl(${h}, 80%,97%)`);

// ── Per-colony cluster data ────────────────────────────────────────────────────

let clX:   Float32Array[];   // clX[b][i]  = x-position of cluster point i
let clY:   Float32Array[];   // clY[b][i]  = y-position
let clPar: Int32Array[];     // clPar[b][i]= parent index (-1 for root seeds)
let clSz:  number[];         // clSz[b]    = number of cluster points currently

// Spatial hash: Map<cellKey, number[]> per colony
let spatHash: Map<number, number[]>[];
let gridRows = 1;            // number of grid rows (gridH)

// ── Walker arrays ──────────────────────────────────────────────────────────────

let wX:    Float32Array;
let wY:    Float32Array;
let wBand: Uint8Array;
let wLive: Uint8Array;       // 1 = active walker, 0 = free slot
let wLiveCount = 0;          // number currently active
let wSlots     = 0;          // total slots allocated

// ── Module state ───────────────────────────────────────────────────────────────

let initialized  = false;
let canvasW      = 0;
let canvasH      = 0;
let lastBeatIdx  = -1;

// Permanent offscreen canvas accumulates crystal lines; never cleared on its own
let crystalCanvas: HTMLCanvasElement | null = null;
let crystalCtx:    CanvasRenderingContext2D | null = null;

// ── Spatial-hash helpers ───────────────────────────────────────────────────────

function cellKey(gx: number, gy: number): number { return gx * gridRows + gy; }

function hashAdd(b: number, idx: number, x: number, y: number): void {
  const gx  = Math.floor(x / CELL_SIZE);
  const gy  = Math.floor(y / CELL_SIZE);
  const key = cellKey(gx, gy);
  let arr   = spatHash[b].get(key);
  if (!arr) { arr = []; spatHash[b].set(key, arr); }
  arr.push(idx);
}

/** Returns index of first cluster point of band b within `radius` px of (x,y), or -1. */
function nearestIn(b: number, x: number, y: number, radius: number): number {
  const r2   = radius * radius;
  const gx0  = Math.max(0, Math.floor((x - radius) / CELL_SIZE));
  const gy0  = Math.max(0, Math.floor((y - radius) / CELL_SIZE));
  const gx1  = Math.ceil((x  + radius) / CELL_SIZE);
  const gy1  = Math.ceil((y  + radius) / CELL_SIZE);

  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const arr = spatHash[b].get(cellKey(gx, gy));
      if (!arr) continue;
      for (const idx of arr) {
        const dx = clX[b][idx] - x;
        const dy = clY[b][idx] - y;
        if (dx * dx + dy * dy <= r2) return idx;
      }
    }
  }
  return -1;
}

// ── Cluster helpers ────────────────────────────────────────────────────────────

function addSeed(b: number, x: number, y: number): void {
  if (clSz[b] >= MAX_CLUSTER) return;
  const idx     = clSz[b]++;
  clX[b][idx]   = x;
  clY[b][idx]   = y;
  clPar[b][idx] = -1;
  hashAdd(b, idx, x, y);

  // Draw initial seed dot onto crystal canvas
  if (crystalCtx) {
    const ctx = crystalCtx;
    const h   = BAND_HUES[b];
    const grad = ctx.createRadialGradient(x, y, 0, x, y, 5);
    grad.addColorStop(0, `hsla(${h},100%,98%,0.95)`);
    grad.addColorStop(1, `hsla(${h},100%,70%,0.00)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function appendPoint(b: number, x: number, y: number, parentIdx: number): void {
  if (clSz[b] >= MAX_CLUSTER) return;
  const idx     = clSz[b]++;
  clX[b][idx]   = x;
  clY[b][idx]   = y;
  clPar[b][idx] = parentIdx;
  hashAdd(b, idx, x, y);

  // Draw crystal segment on offscreen canvas
  drawCrystalSeg(b, x, y, clX[b][parentIdx], clY[b][parentIdx]);
}

function drawCrystalSeg(
  b: number,
  x2: number, y2: number,
  x1: number, y1: number,
): void {
  if (!crystalCtx) return;
  const ctx = crystalCtx;
  const hue = BAND_HUES[b];

  // Outer halo
  ctx.strokeStyle = `hsla(${hue},100%,68%,0.09)`;
  ctx.lineWidth   = 7;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  // Mid bloom
  ctx.strokeStyle = `hsla(${hue},90%,82%,0.22)`;
  ctx.lineWidth   = 2.2;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  // Core line
  ctx.strokeStyle = CORE_CSS[b];
  ctx.lineWidth   = 0.85;
  ctx.globalAlpha = 0.92;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.globalAlpha = 1.0;

  // Bright tip dot
  ctx.fillStyle   = CORE_CSS[b];
  ctx.globalAlpha = 0.80;
  ctx.beginPath(); ctx.arc(x2, y2, 1.0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1.0;
}

// ── Walker helpers ─────────────────────────────────────────────────────────────

function spawnWalker(b: number): void {
  // Find a free slot
  let slot = -1;
  for (let i = 0; i < wSlots; i++) {
    if (!wLive[i]) { slot = i; break; }
  }
  if (slot < 0 && wSlots < MAX_WALKERS) { slot = wSlots++; }
  if (slot < 0) return;

  wLive[slot] = 1;
  wBand[slot] = b;
  wLiveCount++;

  // Spawn on a random canvas edge (pure DLA) or occasionally interior
  if (Math.random() < 0.6) {
    const edge = (Math.random() * 4) | 0;
    switch (edge) {
      case 0: wX[slot] = Math.random() * canvasW; wY[slot] = 0; break;
      case 1: wX[slot] = canvasW - 1;             wY[slot] = Math.random() * canvasH; break;
      case 2: wX[slot] = Math.random() * canvasW; wY[slot] = canvasH - 1; break;
      default: wX[slot] = 0;                      wY[slot] = Math.random() * canvasH; break;
    }
  } else {
    // Interior spawn — ensures early activity near seed clusters
    wX[slot] = Math.random() * canvasW;
    wY[slot] = Math.random() * canvasH;
  }
}

// ── Init / Reset ───────────────────────────────────────────────────────────────

function init(w: number, h: number): void {
  gridRows = Math.ceil(h / CELL_SIZE) + 2;

  clX   = []; clY = []; clPar = []; clSz = []; spatHash = [];
  for (let b = 0; b < BAND_COUNT; b++) {
    clX[b]    = new Float32Array(MAX_CLUSTER);
    clY[b]    = new Float32Array(MAX_CLUSTER);
    clPar[b]  = new Int32Array(MAX_CLUSTER);
    clSz[b]   = 0;
    spatHash[b] = new Map();
  }

  wX     = new Float32Array(MAX_WALKERS);
  wY     = new Float32Array(MAX_WALKERS);
  wBand  = new Uint8Array(MAX_WALKERS);
  wLive  = new Uint8Array(MAX_WALKERS);
  wSlots = 0;
  wLiveCount = 0;

  // Create or reset offscreen crystal canvas
  if (!crystalCanvas) {
    crystalCanvas = document.createElement('canvas');
    crystalCtx    = crystalCanvas.getContext('2d', { alpha: true })!;
  }
  crystalCanvas.width  = w;
  crystalCanvas.height = h;
  crystalCtx!.clearRect(0, 0, w, h);
  crystalCtx!.lineCap  = 'round';
  crystalCtx!.lineJoin = 'round';

  // Place 7 colony seeds in a ring + center
  const cx  = w / 2;
  const cy  = h / 2;
  const rad = Math.min(w, h) * 0.28;
  for (let b = 0; b < BAND_COUNT; b++) {
    const angle = b === 0 ? 0 : ((b - 1) / (BAND_COUNT - 1)) * Math.PI * 2;
    const sx    = b === 0 ? cx : cx + Math.cos(angle) * rad;
    const sy    = b === 0 ? cy : cy + Math.sin(angle) * rad;
    addSeed(b, sx, sy);
    // Small 4-point cross to reduce initial ramp-up
    const d = 2;
    addSeed(b, sx + d, sy);
    addSeed(b, sx - d, sy);
    addSeed(b, sx, sy + d);
    addSeed(b, sx, sy - d);
  }

  // Pre-seed walkers (half interior for immediate early growth)
  const startCount = Math.floor(MAX_WALKERS * 0.25);
  for (let i = 0; i < startCount; i++) {
    spawnWalker(i % BAND_COUNT);
  }

  canvasW     = w;
  canvasH     = h;
  lastBeatIdx = -1;
  initialized = true;
}

export function resetDendron(): void {
  initialized = false;
  if (crystalCanvas && crystalCtx) {
    crystalCtx.clearRect(0, 0, crystalCanvas.width, crystalCanvas.height);
  }
  lastBeatIdx = -1;
  wLiveCount  = 0;
}

// ── Draw ───────────────────────────────────────────────────────────────────────

export function drawDendron(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps }          = getBandAverages(BAND_COUNT);
  const w = p.width;
  const h = p.height;

  if (!initialized || canvasW !== w || canvasH !== h) init(w, h);

  // Slider → working values
  const glowAlpha  = 0.30 + config.dendronGlow    * 0.70;   // 0.30–1.0
  const stickR     = 1.5  + config.dendronStick   * 7.5;    // 1.5–9 px
  const walkTarget = Math.round((0.08 + config.dendronWalkers * 0.92) * MAX_WALKERS);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      // Inject a fresh seed for the loudest band at a random canvas position
      let loudestB = 0;
      for (let b = 1; b < BAND_COUNT; b++) {
        if (amps[b] > amps[loudestB]) loudestB = b;
      }
      const ax = Math.random() * w;
      const ay = Math.random() * h;
      addSeed(loudestB, ax, ay);
    }
  }

  // ── Walker spawning ────────────────────────────────────────────────────────
  const overallAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;
  const ampScale   = 0.25 + overallAmp * 0.75;  // 0.25–1.0
  const target     = Math.round(walkTarget * ampScale);
  const toSpawn    = Math.min(8, Math.max(0, target - wLiveCount));  // ≤8 per frame
  for (let s = 0; s < toSpawn; s++) {
    // Pick band weighted by amplitude
    const r = Math.random();
    let cumulative = 0;
    let b = 0;
    const total = amps.reduce((a, v) => a + v, 0) || 1;
    for (let i = 0; i < BAND_COUNT; i++) {
      cumulative += amps[i] / total;
      if (r <= cumulative) { b = i; break; }
    }
    spawnWalker(b);
  }

  // ── Move walkers ────────────────────────────────────────────────────────────
  const step = WALK_STEP * Math.max(0.5, dt);
  for (let i = 0; i < wSlots; i++) {
    if (!wLive[i]) continue;
    const b = wBand[i];

    // Brownian random walk
    const angle = Math.random() * 6.2832;
    wX[i] += Math.cos(angle) * step;
    wY[i] += Math.sin(angle) * step;

    // Soft wrap / reflect at canvas boundary
    if (wX[i] < 0)    wX[i] += w;
    else if (wX[i] >= w) wX[i] -= w;
    if (wY[i] < 0)    wY[i] += h;
    else if (wY[i] >= h) wY[i] -= h;

    // Check proximity to cluster
    if (clSz[b] > 0) {
      const nearIdx = nearestIn(b, wX[i], wY[i], stickR);
      if (nearIdx >= 0) {
        // Walker sticks — becomes a new cluster point
        appendPoint(b, wX[i], wY[i], nearIdx);
        // Release this walker slot
        wLive[i] = 0;
        wLiveCount--;
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  // Solid dark background (no trail — crystal canvas accumulates everything)
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;
  ctx.fillStyle   = '#00000a';
  ctx.fillRect(0, 0, w, h);

  // Blit crystal canvas with additive blending + glow scale
  if (crystalCanvas) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = glowAlpha;
    ctx.drawImage(crystalCanvas, 0, 0);
    // Second pass for extra bloom at high glow
    if (config.dendronGlow > 0.5) {
      ctx.globalAlpha = (config.dendronGlow - 0.5) * 0.6;
      ctx.drawImage(crystalCanvas, 0, 0);
    }
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Draw active walkers as tiny dim colored sparks
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < wSlots; i++) {
    if (!wLive[i]) continue;
    const b = wBand[i];
    ctx.globalAlpha = 0.18 + amps[b] * 0.22;
    ctx.fillStyle   = OUTER_CSS[b];
    ctx.beginPath();
    ctx.arc(wX[i], wY[i], 1.4, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha              = 1.0;
  ctx.globalCompositeOperation = 'source-over';
}
