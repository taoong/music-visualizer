/**
 * Murmuration — Audio-reactive boid flocking visualization.
 *
 * Thousands of abstract "birds" exhibit emergent flocking behaviour (separation,
 * alignment, cohesion) and are colored by their velocity direction: hue cycles
 * through the rainbow as birds turn, producing electric swirls of color against
 * a void-black background. A persistent trail buffer accumulates each frame so
 * the flock leaves a glowing memory of its motion — tight spirals become
 * rainbow mandalas; explosions leave radiant afterimages.
 *
 * Inspired by Universal Everything's "Future Self" (2012) — streaming light-
 * particle figures that blur the boundary between individual and collective
 * motion, and by Craig Reynolds' Boids algorithm (1987) which first showed
 * that three simple local rules produce the breathtaking group intelligence
 * seen in starling murmurations.
 * https://universaleverything.com/future-self
 *
 * Audio reactivity
 *   Sub-bass amp   → separation radius (heavy hits scatter the flock outward)
 *   Bass amp       → cohesion × Cohesion slider (pull birds together)
 *   Mid amp        → alignment strength (birds lock into shared heading)
 *   Presence amp   → max flight speed
 *   Beat transient → "predator" event: flock swerves away from a random canvas
 *                    edge point + global hue palette jump (+47° per beat)
 *
 * Sliders
 *   Birds    — flock population (100–3000; capped at 400 on mobile)
 *   Cohesion — how tightly birds cluster (0 = diffuse cloud, 1 = tight ball)
 *   Trail    — motion trail persistence (0 = instant fade, 1 = long history)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const CELL_SIZE      = 80;   // perception radius == spatial-grid cell size (px)
const MOBILE_CAP     = 400;  // max birds on mobile
const MIN_SPEED      = 1.0;
const BASE_MAX_SPEED = 3.5;
const TWO_PI         = Math.PI * 2;

// ── Module state — SoA layout for cache efficiency ────────────────────────────

let bx: Float32Array    = new Float32Array(0);
let by: Float32Array    = new Float32Array(0);
let bvx: Float32Array   = new Float32Array(0);
let bvy: Float32Array   = new Float32Array(0);
let forceX: Float32Array = new Float32Array(0);  // temp, reused each frame
let forceY: Float32Array = new Float32Array(0);
let birdsCount = 0;

// Spatial hash grid
let gridCells: number[][] = [];
let gridW = 0;
let gridH = 0;

// Offscreen trail buffer
let pg: any   = null;
let pgW = 0;
let pgH = 0;

// Animation / beat state
let lastBeatIndex = -1;
let hueShift      = 0;      // global hue offset; shifts on each beat
let predActive    = false;
let predX         = 0;
let predY         = 0;
let predTimer     = 0.0;    // seconds remaining

// ── Helpers ───────────────────────────────────────────────────────────────────

function allocBirds(count: number, w: number, h: number): void {
  bx     = new Float32Array(count);
  by     = new Float32Array(count);
  bvx    = new Float32Array(count);
  bvy    = new Float32Array(count);
  forceX = new Float32Array(count);
  forceY = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    bx[i]  = Math.random() * w;
    by[i]  = Math.random() * h;
    const a = Math.random() * TWO_PI;
    const s = MIN_SPEED + Math.random() * 1.5;
    bvx[i] = Math.cos(a) * s;
    bvy[i] = Math.sin(a) * s;
  }
  birdsCount = count;
}

function resizeBirds(target: number, w: number, h: number): void {
  if (birdsCount === target) return;
  const newBx  = new Float32Array(target);
  const newBy  = new Float32Array(target);
  const newBvx = new Float32Array(target);
  const newBvy = new Float32Array(target);
  const copy   = Math.min(birdsCount, target);
  newBx.set( bx.subarray(0, copy));
  newBy.set( by.subarray(0, copy));
  newBvx.set(bvx.subarray(0, copy));
  newBvy.set(bvy.subarray(0, copy));
  for (let i = copy; i < target; i++) {
    newBx[i]  = Math.random() * w;
    newBy[i]  = Math.random() * h;
    const a   = Math.random() * TWO_PI;
    newBvx[i] = Math.cos(a) * (MIN_SPEED + Math.random());
    newBvy[i] = Math.sin(a) * (MIN_SPEED + Math.random());
  }
  bx = newBx; by = newBy; bvx = newBvx; bvy = newBvy;
  forceX = new Float32Array(target);
  forceY = new Float32Array(target);
  birdsCount = target;
}

function initGrid(w: number, h: number): void {
  gridW     = Math.ceil(w / CELL_SIZE) + 1;
  gridH     = Math.ceil(h / CELL_SIZE) + 1;
  gridCells = Array.from({ length: gridW * gridH }, () => []);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetMurmuration(): void {
  bx = new Float32Array(0); by = new Float32Array(0);
  bvx = new Float32Array(0); bvy = new Float32Array(0);
  forceX = new Float32Array(0); forceY = new Float32Array(0);
  birdsCount    = 0;
  gridCells     = []; gridW = 0; gridH = 0;
  pg?.remove(); pg = null; pgW = 0; pgH = 0;
  lastBeatIndex = -1;
  hueShift      = 0;
  predActive    = false;
  predTimer     = 0;
}

export function drawMurmuration(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  const rawCount    = Math.round(config.murmuBirds);
  const targetCount = isMobile ? Math.min(MOBILE_CAP, rawCount) : rawCount;

  // Init or resize boid arrays
  if (birdsCount === 0) {
    allocBirds(targetCount, W, H);
    initGrid(W, H);
  } else if (birdsCount !== targetCount) {
    resizeBirds(targetCount, W, H);
  }

  // Init or resize offscreen trail buffer
  if (!pg || pgW !== W || pgH !== H) {
    pg?.remove();
    pg  = (p as any).createGraphics(W, H);
    pg.pixelDensity(1);
    pg.background(0);
    pgW = W; pgH = H;
    initGrid(W, H);
  }

  // ── Beat detection ────────────────────────────────────────────────────────

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift      = (hueShift + 47 + Math.random() * 30) % 360;
      // Spawn predator on a random canvas edge
      const side = Math.floor(Math.random() * 4);
      predX = side === 0 ? 0        : side === 1 ? W        : Math.random() * W;
      predY = side === 2 ? 0        : side === 3 ? H        : Math.random() * H;
      predActive = true;
      predTimer  = 0.55;
    }
  }
  predTimer = Math.max(0, predTimer - 0.01667 * dt);
  if (predTimer <= 0) predActive = false;

  // ── Audio parameters ──────────────────────────────────────────────────────

  const sub        = amps[0];
  const bass       = amps[1];
  const mid        = amps[3];
  const presence   = amps[5];
  const brilliance = amps[6];

  const cohesionScale   = config.murmuCohesion;
  const separationRadius = CELL_SIZE * (0.35 + sub  * 0.55);
  const alignStrength    = (0.015 + mid  * 0.045) * dt;
  const cohesionStrength = cohesionScale * (0.004 + bass * 0.013) * dt;
  const sepStrength      = 0.07 * dt;
  const maxSpeed         = BASE_MAX_SPEED + presence * 2.5 + brilliance * 1.5;
  const minSpd           = MIN_SPEED + bass * 0.5;
  const predStr          = predActive ? (4.0 + sub * 5.0) * dt : 0;

  // ── Rebuild spatial hash grid ─────────────────────────────────────────────

  for (let i = 0; i < gridCells.length; i++) gridCells[i].length = 0;
  for (let i = 0; i < birdsCount; i++) {
    const cx = Math.floor(bx[i] / CELL_SIZE);
    const cy = Math.floor(by[i] / CELL_SIZE);
    if (cx >= 0 && cx < gridW && cy >= 0 && cy < gridH) {
      gridCells[cx + cy * gridW].push(i);
    }
  }

  // ── Compute boid forces ───────────────────────────────────────────────────

  forceX.fill(0);
  forceY.fill(0);

  const r2   = CELL_SIZE * CELL_SIZE;
  const sep2 = separationRadius * separationRadius;

  for (let i = 0; i < birdsCount; i++) {
    const xi  = bx[i];
    const yi  = by[i];
    const cxi = Math.floor(xi / CELL_SIZE);
    const cyi = Math.floor(yi / CELL_SIZE);

    let sepFx = 0, sepFy = 0;
    let alignFx = 0, alignFy = 0;
    let cohFx = 0, cohFy = 0;
    let neighborCount = 0;

    for (let dx = -1; dx <= 1; dx++) {
      const ncx = cxi + dx;
      if (ncx < 0 || ncx >= gridW) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ncy = cyi + dy;
        if (ncy < 0 || ncy >= gridH) continue;
        const cell = gridCells[ncx + ncy * gridW];
        for (let k = 0; k < cell.length; k++) {
          const j = cell[k];
          if (j === i) continue;
          const ddx = xi - bx[j];
          const ddy = yi - by[j];
          const d2  = ddx * ddx + ddy * ddy;
          if (d2 >= r2 || d2 < 0.001) continue;

          neighborCount++;
          alignFx += bvx[j];
          alignFy += bvy[j];
          cohFx   += bx[j];
          cohFy   += by[j];

          if (d2 < sep2) {
            const d      = Math.sqrt(d2);
            const weight = 1.0 - d / separationRadius;
            sepFx += (ddx / d) * weight;
            sepFy += (ddy / d) * weight;
          }
        }
      }
    }

    if (neighborCount > 0) {
      const inv = 1.0 / neighborCount;
      forceX[i] += (alignFx * inv - bvx[i]) * alignStrength;
      forceY[i] += (alignFy * inv - bvy[i]) * alignStrength;
      forceX[i] += (cohFx * inv - xi) * cohesionStrength;
      forceY[i] += (cohFy * inv - yi) * cohesionStrength;
    }
    forceX[i] += sepFx * sepStrength;
    forceY[i] += sepFy * sepStrength;

    // Predator avoidance — all birds flee away from predator position
    if (predActive) {
      const ddx  = xi - predX;
      const ddy  = yi - predY;
      const d2   = ddx * ddx + ddy * ddy;
      const d    = Math.sqrt(Math.max(d2, 1.0));
      const infl = Math.max(0, 1.0 - d / (Math.max(W, H) * 0.65));
      forceX[i] += (ddx / d) * infl * predStr;
      forceY[i] += (ddy / d) * infl * predStr;
    }

    // Soft boundary — gradually steer birds back toward canvas interior
    const margin = 110;
    if (xi < margin)     forceX[i] += (margin - xi)      * 0.04 * dt;
    if (xi > W - margin) forceX[i] -= (xi - (W - margin)) * 0.04 * dt;
    if (yi < margin)     forceY[i] += (margin - yi)      * 0.04 * dt;
    if (yi > H - margin) forceY[i] -= (yi - (H - margin)) * 0.04 * dt;
  }

  // ── Apply forces, clamp speed, integrate positions ────────────────────────

  for (let i = 0; i < birdsCount; i++) {
    bvx[i] += forceX[i];
    bvy[i] += forceY[i];

    const spd = Math.sqrt(bvx[i] * bvx[i] + bvy[i] * bvy[i]);
    if (spd > maxSpeed) {
      const inv = maxSpeed / spd;
      bvx[i] *= inv; bvy[i] *= inv;
    } else if (spd < minSpd && spd > 0.001) {
      const inv = minSpd / spd;
      bvx[i] *= inv; bvy[i] *= inv;
    }

    bx[i] += bvx[i] * dt;
    by[i] += bvy[i] * dt;

    // Toroidal wrap once a bird wanders well off-canvas
    if (bx[i] < -20)    bx[i] += W + 40;
    if (bx[i] > W + 20) bx[i] -= W + 40;
    if (by[i] < -20)    by[i] += H + 40;
    if (by[i] > H + 20) by[i] -= H + 40;
  }

  // ── Render into trail buffer ───────────────────────────────────────────────

  const trailFade = config.murmuTrail;
  // Higher trail → slower fade; range: alpha 8 (long) to 100 (short)
  const fadeAlpha = Math.round(8 + (1.0 - trailFade) * 92);

  // Fade existing trail with semi-transparent black rect
  pg.colorMode(p['RGB'], 255);
  pg.noStroke();
  pg.fill(0, 0, 0, fadeAlpha);
  pg.rect(0, 0, W, H);

  // Draw birds as short velocity-direction dashes, hue = heading angle
  const energy     = (amps[0] + amps[1] + amps[2] + amps[3]) * 0.25;
  const brightness = 55 + energy * 45;
  const saturation = 75 + energy * 25;

  pg.colorMode(p['HSB'], 360, 100, 100, 255);
  pg.strokeWeight(isMobile ? 1.2 : 1.5);

  for (let i = 0; i < birdsCount; i++) {
    const vxi = bvx[i];
    const vyi = bvy[i];
    const spd = Math.sqrt(vxi * vxi + vyi * vyi);
    if (spd < 0.01) continue;

    const tailLen = 2.5 + spd * 1.3;
    const x2 = bx[i] - (vxi / spd) * tailLen;
    const y2 = by[i] - (vyi / spd) * tailLen;

    // Velocity direction → rainbow hue; birds turn → colors shift
    const angle = Math.atan2(vyi, vxi);               // –π … +π
    const hue   = ((angle / Math.PI * 180) + 180 + hueShift) % 360;

    pg.stroke(hue, saturation, brightness, 200);
    pg.line(bx[i], by[i], x2, y2);
  }

  // ── Blit trail buffer to main canvas ─────────────────────────────────────

  p.background(0);
  p.image(pg, 0, 0);

  // Restore main canvas to default color mode
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
