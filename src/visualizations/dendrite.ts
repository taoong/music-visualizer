/**
 * Dendrite — Diffusion-Limited Aggregation crystal growth.
 *
 * Inspired by Étienne Jacob's "Necessary Disorder" generative art series
 * (https://necessarydisorder.tumblr.com/) and the DLA fractal process first
 * described by Witten & Sander (Physical Review Letters, 1981).
 * Random walkers drift inward, stick to a growing crystal cluster, and
 * gradually build branching dendritic structures that resemble frost on glass,
 * coral, lightning, or snowflakes. The seven frequency bands color seven
 * successive generation depths — sub-bass at the roots, brilliance at the
 * finest tips — so the crystal glows brightest where its coloring band is loudest.
 *
 * Rendering: incremental additive offscreen p5.Graphics; only newly stuck
 * particles are drawn each frame, so cost scales with growth rate, not cluster size.
 * Beat: spawns a new seed point displaced from centre + hue-palette shift.
 * Mobile guard: 5× pixel scale (vs 3× desktop) and 80-walker cap.
 *
 * Sliders
 *   Growth — walker spawn rate (more walkers = faster crystal growth)
 *   Glow   — neon bloom radius / phosphor brightness
 *   Chaos  — 0 = walkers biased toward centre (tight columns); 1 = pure random walk (wide fractal arms)
 */

import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Pixel scale: each grid cell = SCALE canvas pixels
const SCALE = isMobile ? 5 : 3;
// Max walkers alive simultaneously
const MAX_WALKERS = isMobile ? 80 : 300;
// Random-walk sub-steps per walker per frame (higher = faster sticking, more CPU)
const STEPS_PER_WALKER = isMobile ? 4 : 8;
// Clear cluster when particle count exceeds this (prevents memory bloat + restarts the art)
const MAX_CLUSTER = isMobile ? 8_000 : 30_000;

// Hue per band depth: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=gold, presence=orange, brilliance=magenta
const BAND_HUES: readonly number[] = [270, 220, 170, 120, 55, 28, 300];

type Walker = { x: number; y: number };
type ClusterPt = { gx: number; gy: number; gen: number };

// Grid dimensions (updated on resize)
let cols = 0;
let rows = 0;

// 1-bit cluster occupancy map (index = gy * cols + gx)
let clusterMap = new Uint8Array(0);
// Generation depth per occupied cell
let genMap = new Uint16Array(0);
// Ordered list of stuck particles (for size tracking)
let cluster: ClusterPt[] = [];
// Particles that stuck this frame (incremental render)
let pending: ClusterPt[] = [];
// Active walkers
let walkers: Walker[] = [];

// Beat tracking
let lastBeatIdx = -1;
let hueOffset = 0;

// Offscreen render buffer (accumulates the crystal image)
let buf: P5Graphics | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gridIndex(gx: number, gy: number): number {
  return gy * cols + gx;
}

function seedAt(gx: number, gy: number): void {
  const gx2 = Math.round(Math.max(0, Math.min(cols - 1, gx)));
  const gy2 = Math.round(Math.max(0, Math.min(rows - 1, gy)));
  const idx = gridIndex(gx2, gy2);
  if (!clusterMap[idx]) {
    clusterMap[idx] = 1;
    genMap[idx] = 0;
    const pt: ClusterPt = { gx: gx2, gy: gy2, gen: 0 };
    cluster.push(pt);
    pending.push(pt);
  }
}

function resetState(p: P5Instance): void {
  cols = Math.ceil(p.width / SCALE);
  rows = Math.ceil(p.height / SCALE);
  const size = cols * rows;
  clusterMap = new Uint8Array(size);
  genMap = new Uint16Array(size);
  cluster = [];
  pending = [];
  walkers = [];
  lastBeatIdx = -1;
  hueOffset = 0;

  // Seed centre
  seedAt(cols / 2, rows / 2);

  if (buf) { buf.remove(); buf = null; }
  buf = p.createGraphics(p.width, p.height);
  (buf as any).background(0);
}

function spawnWalker(): Walker {
  const side = (Math.random() * 4) | 0;
  switch (side) {
    case 0:  return { x: Math.random() * cols, y: 0 };
    case 1:  return { x: Math.random() * cols, y: rows - 1 };
    case 2:  return { x: 0,           y: Math.random() * rows };
    default: return { x: cols - 1,    y: Math.random() * rows };
  }
}

// ─── Main draw ───────────────────────────────────────────────────────────────

export function drawDendrite(p: P5Instance, _dt: number): void {
  const { config, state } = store;

  // Resize guard
  if (cols !== Math.ceil(p.width / SCALE) || rows !== Math.ceil(p.height / SCALE)) {
    resetState(p);
  }

  // If cluster is too large, restart with a fresh seed
  if (cluster.length >= MAX_CLUSTER) {
    resetState(p);
  }

  const { amps, transients } = getBandAverages(BAND_COUNT);
  const avgAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  const maxTransient = transients.reduce((m, t) => Math.max(m, t), 0);

  // ── Beat detection ───────────────────────────────────────────────────────
  const { beatIntervalSec } = state;
  const pos = (state as typeof state & { playbackPosition?: number }).playbackPosition ?? 0;
  const beatInterval = beatIntervalSec > 0 ? beatIntervalSec : 0.5;
  const beatIdx = Math.floor(pos / beatInterval);

  if (beatIdx !== lastBeatIdx && beatIdx > 0) {
    lastBeatIdx = beatIdx;
    hueOffset = (hueOffset + 43) % 360;
    // Plant a new off-centre seed so fresh arms can grow in new directions
    const angle = Math.random() * Math.PI * 2;
    const dist = (0.05 + Math.random() * 0.15) * Math.min(cols, rows);
    seedAt(cols / 2 + Math.cos(angle) * dist, rows / 2 + Math.sin(angle) * dist);
  }

  // Fallback for mic/interactive mode: use store beat state
  if (state.lastBeatIndex > lastBeatIdx) {
    lastBeatIdx = state.lastBeatIndex;
    hueOffset = (hueOffset + 43) % 360;
    seedAt(cols / 2, rows / 2);
  }

  // ── Spawn walkers ────────────────────────────────────────────────────────
  const growthFactor = config.dendriteGrowth ?? 0.5;
  const burstFromTransient = maxTransient > 1.2 ? Math.round((maxTransient - 1) * 8) : 0;
  const nSpawn = Math.round(avgAmp * growthFactor * 20 + burstFromTransient + growthFactor * 2);

  for (let i = 0; i < nSpawn && walkers.length < MAX_WALKERS; i++) {
    walkers.push(spawnWalker());
  }

  // ── Step walkers and check attachment ────────────────────────────────────
  const chaos = config.dendriteChaos ?? 0.4;
  const cx = cols / 2;
  const cy = rows / 2;

  const survived: Walker[] = [];

  for (const w of walkers) {
    let stuck = false;

    for (let step = 0; step < STEPS_PER_WALKER; step++) {
      // Random displacement (unit vector)
      const angle = Math.random() * Math.PI * 2;
      const rx = Math.cos(angle);
      const ry = Math.sin(angle);

      // Inward bias: strength = (1 - chaos) * 1.5
      const bias = (1 - chaos) * 1.5;
      const dx2 = w.x - cx;
      const dy2 = w.y - cy;
      const len = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 1e-6;
      const bx = -(dx2 / len) * bias;
      const by = -(dy2 / len) * bias;

      w.x = Math.max(0, Math.min(cols - 1, w.x + rx + bx));
      w.y = Math.max(0, Math.min(rows - 1, w.y + ry + by));

      const gx = Math.round(w.x);
      const gy = Math.round(w.y);

      // If walker landed on the cluster itself, backtrack one step then stick
      if (gx >= 0 && gx < cols && gy >= 0 && gy < rows && clusterMap[gridIndex(gx, gy)]) {
        w.x = Math.max(0, Math.min(cols - 1, w.x - rx - bx));
        w.y = Math.max(0, Math.min(rows - 1, w.y - ry - by));
        const gx2 = Math.round(w.x);
        const gy2 = Math.round(w.y);
        const idx2 = gridIndex(gx2, gy2);
        if (gx2 >= 0 && gx2 < cols && gy2 >= 0 && gy2 < rows && !clusterMap[idx2]) {
          let maxGen = 0;
          for (let dy3 = -1; dy3 <= 1; dy3++) {
            for (let dx3 = -1; dx3 <= 1; dx3++) {
              const nx = gx2 + dx3; const ny = gy2 + dy3;
              if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
                const ni = gridIndex(nx, ny);
                if (clusterMap[ni] && genMap[ni] > maxGen) maxGen = genMap[ni];
              }
            }
          }
          clusterMap[idx2] = 1;
          const gen = maxGen + 1;
          genMap[idx2] = gen;
          const pt: ClusterPt = { gx: gx2, gy: gy2, gen };
          cluster.push(pt);
          pending.push(pt);
        }
        stuck = true;
        break;
      }

      // Check 8-neighbourhood for cluster contact
      let touched = false;
      let maxNeighbourGen = 0;
      for (let dy3 = -1; dy3 <= 1 && !touched; dy3++) {
        for (let dx3 = -1; dx3 <= 1 && !touched; dx3++) {
          if (dx3 === 0 && dy3 === 0) continue;
          const nx = gx + dx3; const ny = gy + dy3;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
            const ni = gridIndex(nx, ny);
            if (clusterMap[ni]) {
              touched = true;
              if (genMap[ni] > maxNeighbourGen) maxNeighbourGen = genMap[ni];
            }
          }
        }
      }

      if (touched) {
        const idx = gridIndex(gx, gy);
        if (gx >= 0 && gx < cols && gy >= 0 && gy < rows && !clusterMap[idx]) {
          clusterMap[idx] = 1;
          const gen = maxNeighbourGen + 1;
          genMap[idx] = gen;
          const pt: ClusterPt = { gx, gy, gen };
          cluster.push(pt);
          pending.push(pt);
        }
        stuck = true;
        break;
      }
    }

    if (!stuck) survived.push(w);
  }
  walkers = survived;

  // ── Render new particles to offscreen buffer ──────────────────────────────
  if (buf !== null && pending.length > 0) {
    const glowFactor = config.dendriteGlow ?? 0.5;
    const outerR = SCALE * (0.8 + glowFactor * 4);
    const midR   = SCALE * (0.6 + glowFactor * 2);
    const coreR  = SCALE * 0.8;

    (buf as any).noStroke();
    (buf as any).colorMode((buf as any)['HSB'], 360, 100, 100, 100);

    for (const pt of pending) {
      const bandIdx = pt.gen % BAND_COUNT;
      const hue = (BAND_HUES[bandIdx] + hueOffset) % 360;
      const bandAmp = amps[bandIdx];
      const brightness = 55 + bandAmp * 40;
      const px = pt.gx * SCALE + SCALE / 2;
      const py = pt.gy * SCALE + SCALE / 2;

      // Outer glow halo
      (buf as any).fill(hue, 60, brightness * 0.35, 18 + glowFactor * 22);
      (buf as any).ellipse(px, py, outerR * 2, outerR * 2);
      // Mid glow
      (buf as any).fill(hue, 75, brightness * 0.65, 40 + glowFactor * 25);
      (buf as any).ellipse(px, py, midR * 2, midR * 2);
      // Core dot
      (buf as any).fill(hue, 55, 100, 100);
      (buf as any).ellipse(px, py, coreR * 2, coreR * 2);
    }

    pending = [];
  }

  // ── Composite buffer + live energy pulse overlay ──────────────────────────
  p.background(0);
  if (buf !== null) p.image(buf as unknown as P5Image, 0, 0);

  if (avgAmp > 0.05) {
    const glowFactor = config.dendriteGlow ?? 0.5;
    const pulseR = Math.min(p.width, p.height) * 0.25 * avgAmp;
    const dominantBand = amps.indexOf(Math.max(...amps));
    const pulseHue = (BAND_HUES[dominantBand] + hueOffset) % 360;
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
    p.noStroke();
    p.fill(pulseHue, 70, 90, 8 + avgAmp * 12 * glowFactor);
    p.ellipse(p.width / 2, p.height / 2, pulseR * 2, pulseR * 2);
    (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  }
}

// ─── Reset ───────────────────────────────────────────────────────────────────

export function resetDendrite(p?: P5Instance): void {
  if (p) {
    resetState(p);
  } else {
    cols = 0;
    rows = 0;
    if (buf) { buf.remove(); buf = null; }
    cluster = [];
    pending = [];
    walkers = [];
    lastBeatIdx = -1;
    hueOffset = 0;
  }
}
