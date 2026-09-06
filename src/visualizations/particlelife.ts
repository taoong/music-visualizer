/**
 * Particle Life — self-organizing micro-organisms from attraction/repulsion rules.
 *
 * 7 particle species (one per frequency band) interact through an asymmetric 7×7 force
 * matrix: positive = attraction, negative = repulsion. The interplay of simple rules
 * produces "organisms" — clusters that chase, orbit, spiral, and chain — that shift as
 * music drives force mutations on every beat. Inspired by Jeffrey Ventrella's "Clusters"
 * artificial life simulation (1994–2022, https://ventrella.com/Clusters/).
 *
 * Sliders
 *   Population — total particle count (sparse orbiting blobs → dense heaving swarm)
 *   Force      — interaction strength (gentle drift → violent snap)
 *   Range      — interaction radius (tight local clusters → long-range global order)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

const MAX_TOTAL = isMobile ? 350 : 900;
const MIN_TOTAL = isMobile ? 70 : 140;

type Particle = { x: number; y: number; vx: number; vy: number; s: number };

let forceMatrix: number[][] = []; // [s_from][s_to] ∈ [-1, 1]
let particles: Particle[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let trailG: P5Graphics | null = null;
let cW = 0, cH = 0;

// Spatial hash — cells sized to interaction range
let gridCells: number[][] = [];
let gridDivX = 0, gridDivY = 0, cellSize = 0;

function rndForce(): number {
  const sign = Math.random() < 0.55 ? 1 : -1;
  return sign * (0.1 + Math.random() * 0.9);
}

function initForces(): void {
  forceMatrix = Array.from({ length: BAND_COUNT }, (_, i) =>
    Array.from({ length: BAND_COUNT }, (_x, j) => {
      const f = rndForce();
      // Self-interaction always repulsive so species don't collapse to a point
      return i === j ? Math.min(f, -0.05) : f;
    })
  );
}

function mutateForces(): void {
  for (let i = 0; i < BAND_COUNT; i++) {
    for (let j = 0; j < BAND_COUNT; j++) {
      if (Math.random() < 0.25) {
        forceMatrix[i][j] = forceMatrix[i][j] * 0.65 + rndForce() * 0.35;
        forceMatrix[i][j] = Math.max(-1, Math.min(1, forceMatrix[i][j]));
        if (i === j) forceMatrix[i][j] = Math.min(forceMatrix[i][j], -0.05);
      }
    }
  }
}

function spawnParticles(total: number, w: number, h: number): void {
  particles = Array.from({ length: total }, (_, i) => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: 0,
    vy: 0,
    s: i % BAND_COUNT,
  }));
}

function buildGrid(w: number, h: number, range: number): void {
  cellSize = range;
  gridDivX = Math.max(1, Math.ceil(w / cellSize));
  gridDivY = Math.max(1, Math.ceil(h / cellSize));
  const n = gridDivX * gridDivY;
  // Reuse or reallocate grid arrays
  while (gridCells.length < n) gridCells.push([]);
  for (let k = 0; k < n; k++) gridCells[k].length = 0;
  for (let i = 0; i < particles.length; i++) {
    const pi = particles[i];
    const cx = Math.max(0, Math.min(gridDivX - 1, Math.floor(pi.x / cellSize)));
    const cy = Math.max(0, Math.min(gridDivY - 1, Math.floor(pi.y / cellSize)));
    gridCells[cy * gridDivX + cx].push(i);
  }
}

export function drawParticlelife(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  const popParam = config.particlelifePopulation ?? 0.5;
  const forceParam = config.particlelifeForce ?? 0.5;
  const rangeParam = config.particlelifeRange ?? 0.4;
  const targetTotal = Math.round(MIN_TOTAL + popParam * (MAX_TOTAL - MIN_TOTAL));
  const range = 60 + rangeParam * 190; // 60–250px

  // Init / resize
  if (!trailG || cW !== W || cH !== H) {
    trailG?.remove();
    trailG = p.createGraphics(W, H);
    (trailG as any).colorMode(p['HSB'], 360, 100, 100, 1.0);
    trailG.background(0, 0, 0);
    cW = W; cH = H;
    initForces();
    spawnParticles(targetTotal, W, H);
    lastBeatIndex = -1;
    hueShift = 0;
  }

  // Adjust population dynamically when slider changes
  if (particles.length < targetTotal) {
    const add = targetTotal - particles.length;
    for (let k = 0; k < add; k++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: 0, vy: 0,
        s: Math.floor(Math.random() * BAND_COUNT),
      });
    }
  } else if (particles.length > targetTotal + BAND_COUNT) {
    particles.length = targetTotal;
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 30 + Math.floor(Math.random() * 20)) % 360;
      mutateForces();
      // Radial scatter burst from canvas centre
      const cx = W * 0.5, cy = H * 0.5;
      const impulse = 3 + amps[0] * 8;
      for (const pt of particles) {
        const ddx = pt.x - cx, ddy = pt.y - cy;
        const d = Math.sqrt(ddx * ddx + ddy * ddy) + 1;
        pt.vx += (ddx / d) * impulse * 0.12;
        pt.vy += (ddy / d) * impulse * 0.12;
      }
    }
  }

  const forceStrength = (0.06 + forceParam * 0.22) * dt;
  // Friction: half-life ~6 frames so structures form without flying off
  const friction = Math.pow(0.88, dt);

  // Build spatial hash for this frame
  buildGrid(W, H, range);

  // Physics update
  for (let i = 0; i < particles.length; i++) {
    const pi = particles[i];
    const si = pi.s;

    const cx = Math.max(0, Math.min(gridDivX - 1, Math.floor(pi.x / cellSize)));
    const cy = Math.max(0, Math.min(gridDivY - 1, Math.floor(pi.y / cellSize)));

    let ax = 0, ay = 0;

    for (let dy = -1; dy <= 1; dy++) {
      const cyy = cy + dy;
      if (cyy < 0 || cyy >= gridDivY) continue;
      for (let ddx2 = -1; ddx2 <= 1; ddx2++) {
        const cxx = cx + ddx2;
        if (cxx < 0 || cxx >= gridDivX) continue;
        const cell = gridCells[cyy * gridDivX + cxx];
        for (let ki = 0; ki < cell.length; ki++) {
          const j = cell[ki];
          if (j === i) continue;
          const pj = particles[j];

          // Shortest path with wrap-around
          let rx = pj.x - pi.x;
          let ry = pj.y - pi.y;
          if (rx > W * 0.5) rx -= W; else if (rx < -W * 0.5) rx += W;
          if (ry > H * 0.5) ry -= H; else if (ry < -H * 0.5) ry += H;

          const d2 = rx * rx + ry * ry;
          if (d2 < 0.5 || d2 > range * range) continue;
          const d = Math.sqrt(d2);
          const norm = d / range;

          // Two-zone particle life force:
          //   Inner zone (norm < 0.3): strong repulsion — collision avoidance
          //   Outer zone: attraction/repulsion from asymmetric matrix
          let f: number;
          if (norm < 0.3) {
            f = norm / 0.3 - 1.0; // -1 at d=0, 0 at d=0.3*range
          } else {
            f = forceMatrix[si][pj.s] * (1.0 - norm);
          }

          // Scale by the target species' amplitude — loud bands pull harder
          f *= 0.5 + amps[pj.s] * 1.5;

          const inv = f / d;
          ax += rx * inv;
          ay += ry * inv;
        }
      }
    }

    pi.vx = (pi.vx + ax * forceStrength) * friction;
    pi.vy = (pi.vy + ay * forceStrength) * friction;

    pi.x += pi.vx * dt;
    pi.y += pi.vy * dt;

    // Toroidal wrap
    if (pi.x < 0) pi.x += W; else if (pi.x >= W) pi.x -= W;
    if (pi.y < 0) pi.y += H; else if (pi.y >= H) pi.y -= H;
  }

  // Render to trail buffer
  // Fade existing content with semi-transparent black
  (trailG as any).fill(0, 0, 0, 0.06 * dt);
  (trailG as any).noStroke();
  (trailG as any).rect(0, 0, W, H);

  // Draw particles as luminous dots
  (trailG as any).noStroke();
  for (let i = 0; i < particles.length; i++) {
    const pt = particles[i];
    const amp = amps[pt.s];
    const hue = (BAND_HUES[pt.s] + hueShift) % 360;
    const sat = 65 + amp * 35;
    const bri = 70 + amp * 30;
    const radius = 1.5 + amp * 3;
    // Soft outer halo
    (trailG as any).fill(hue, sat * 0.5, bri, 0.3);
    (trailG as any).circle(pt.x, pt.y, radius * 4);
    // Bright core
    (trailG as any).fill(hue, sat, bri, 0.9);
    (trailG as any).circle(pt.x, pt.y, radius * 2);
  }

  // Composite to main canvas
  p.background(0);
  p.image(trailG as any, 0, 0);
}

export function resetParticlelife(): void {
  particles = [];
  forceMatrix = [];
  gridCells = [];
  gridDivX = 0; gridDivY = 0; cellSize = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  trailG?.remove();
  trailG = null;
  cW = 0; cH = 0;
}
