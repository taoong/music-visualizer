/**
 * Growth — Differential Growth visualization
 *
 * Inspired by Nervous System's Floraform (2014) — differential growth
 * algorithms that simulate how biological surfaces grow: coral, brain-fold
 * sulci, leaf margins. https://n-e-r-v-o-u-s.com/projects/albums/floraform/
 *
 * Seven closed curves (one per frequency band) each start as a small circle
 * and grow by inserting midpoint nodes on edges that exceed a length threshold.
 * Repulsion between all nodes forces curves to fold back on themselves, creating
 * complex organic forms. Each curve's growth speed and glow are driven by its
 * band amplitude. Beat-synced new seed curves sprout from the canvas center.
 *
 * Sliders
 *   Growth    — edge-split threshold; higher = faster, denser folding
 *   Tension   — spring stiffness; higher = tighter, more compact folds
 *   Repulsion — repulsion radius; higher = curves spread apart more
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

type P5Instance = any;

const MAX_NODES = isMobile ? 70 : 130;
// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 220, 170, 120, 60, 30, 0];

interface GNode { x: number; y: number; }
interface GCurve { nodes: GNode[]; band: number; }

let curves: GCurve[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let beatCount = 0;

export function resetGrowth(): void {
  curves = [];
  lastBeatIndex = -1;
  hueShift = 0;
  beatCount = 0;
}

function makeSeed(cx: number, cy: number, r: number, band: number): GCurve {
  const N = 10;
  const nodes: GNode[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    nodes.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return { nodes, band };
}

function physicsStep(
  amps: number[],
  W: number, H: number,
  speed: number, tension: number, repulsion: number,
  dt: number
): void {
  // Derive all physics constants from slider values so ratios stay consistent
  const repRadius = 10 + repulsion * 22;        // 10–32 px
  const springRest = repRadius * 0.38;          // equilibrium edge length ≈ 38% of repulsion radius
  const maxEdge = repRadius * 0.65 * (1 - speed * 0.38); // split threshold (shorter → faster growth)
  const springK = 0.025 + tension * 0.18;       // 0.025–0.205
  const repK = 0.8 + repulsion * 2.2;           // 0.8–3.0
  const stepScale = Math.min(dt, 2.0) * 0.38;  // stability cap

  // Flatten all curve nodes into typed arrays for cache-friendly access
  let total = 0;
  const starts: number[] = [];
  for (const c of curves) { starts.push(total); total += c.nodes.length; }

  const ax = new Float32Array(total);
  const ay = new Float32Array(total);
  const fx = new Float32Array(total);
  const fy = new Float32Array(total);

  let g = 0;
  for (const c of curves) {
    for (const n of c.nodes) { ax[g] = n.x; ay[g] = n.y; g++; }
  }

  // Spatial hash for O(n) repulsion lookups
  const cols = Math.ceil(W / repRadius) + 1;
  const hash = new Map<number, number[]>();
  for (let i = 0; i < total; i++) {
    const k = Math.floor(ay[i] / repRadius) * cols + Math.floor(ax[i] / repRadius);
    const cell = hash.get(k);
    if (cell) cell.push(i); else hash.set(k, [i]);
  }

  // Repulsion forces — symmetric pairwise to avoid double-counting
  for (let i = 0; i < total; i++) {
    const cr = Math.floor(ax[i] / repRadius);
    const rw = Math.floor(ay[i] / repRadius);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const cell = hash.get((rw + dr) * cols + (cr + dc));
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const dx = ax[i] - ax[j];
          const dy = ay[i] - ay[j];
          const d2 = dx * dx + dy * dy;
          if (d2 < repRadius * repRadius && d2 > 0.1) {
            const d = Math.sqrt(d2);
            const f = repK * (1.0 - d / repRadius) / d;
            fx[i] += dx * f;  fy[i] += dy * f;
            fx[j] -= dx * f;  fy[j] -= dy * f;
          }
        }
      }
    }
  }

  // Spring forces — each node pulled toward its two along-curve neighbours
  for (let ci = 0; ci < curves.length; ci++) {
    const c = curves[ci];
    const start = starts[ci];
    const n = c.nodes.length;
    for (let ni = 0; ni < n; ni++) {
      const gi = start + ni;
      for (const adjNi of [(ni - 1 + n) % n, (ni + 1) % n]) {
        const gj = start + adjNi;
        const dx = ax[gj] - ax[gi];
        const dy = ay[gj] - ay[gi];
        const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const f = springK * (d - springRest);
        fx[gi] += (dx / d) * f;
        fy[gi] += (dy / d) * f;
      }
    }
  }

  // Apply forces and write back, clamped to canvas interior
  g = 0;
  for (const c of curves) {
    for (const n of c.nodes) {
      n.x = Math.max(4, Math.min(W - 4, n.x + fx[g] * stepScale));
      n.y = Math.max(4, Math.min(H - 4, n.y + fy[g] * stepScale));
      g++;
    }
  }

  // Growth — insert a midpoint node on every edge that exceeds the length threshold
  for (const c of curves) {
    if (c.nodes.length >= MAX_NODES) continue;
    const amp = amps[c.band];
    // Amplitude lowers threshold → more splits → faster growth when loud
    const threshold = Math.max(springRest + 1, maxEdge * (1.0 - amp * speed * 0.55));
    const next: GNode[] = [];
    const n = c.nodes.length;
    for (let ni = 0; ni < n; ni++) {
      const curr = c.nodes[ni];
      const nxt  = c.nodes[(ni + 1) % n];
      next.push(curr);
      const dx = nxt.x - curr.x;
      const dy = nxt.y - curr.y;
      if (Math.sqrt(dx * dx + dy * dy) > threshold && next.length < MAX_NODES) {
        // Tiny random jitter breaks the symmetry so curves fold rather than collapse
        next.push({
          x: (curr.x + nxt.x) * 0.5 + (Math.random() - 0.5) * 0.8,
          y: (curr.y + nxt.y) * 0.5 + (Math.random() - 0.5) * 0.8,
        });
      }
    }
    c.nodes = next;
  }
}

// Closed Catmull-Rom spline via p5's curveVertex
function drawSpline(p: P5Instance, nodes: GNode[]): void {
  const n = nodes.length;
  if (n < 3) return;
  p.beginShape();
  // Duplicate the last and second nodes to close the curve seamlessly
  p.curveVertex(nodes[n - 1].x, nodes[n - 1].y);
  for (const nd of nodes) p.curveVertex(nd.x, nd.y);
  p.curveVertex(nodes[0].x, nodes[0].y);
  p.curveVertex(nodes[1].x, nodes[1].y);
  p.endShape();
}

export function drawGrowth(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const speed     = (config as any).growthSpeed     ?? 0.5;
  const tension   = (config as any).growthTension   ?? 0.5;
  const repulsion = (config as any).growthRepulsion ?? 0.5;

  const W = p.width;
  const H = p.height;

  // Seed 7 curves in a ring at startup
  if (curves.length === 0) {
    const ringR = Math.min(W, H) * 0.13;
    const seedR = Math.max(10, (10 + repulsion * 22) * 0.45); // half the repulsion radius
    for (let i = 0; i < BAND_COUNT; i++) {
      const angle = (i / BAND_COUNT) * Math.PI * 2;
      curves.push(makeSeed(
        W / 2 + Math.cos(angle) * ringR,
        H / 2 + Math.sin(angle) * ringR,
        seedR, i
      ));
    }
  }

  // Beat detection — sprout new seed curves and shift the global hue
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatCount++;
      hueShift = (hueShift + 18) % 360;
      // Every other beat: sprout a new organism near the center
      if (beatCount % 2 === 0 && curves.length < 14) {
        const loudest = amps.indexOf(Math.max(...amps));
        const a = Math.random() * Math.PI * 2;
        const d = Math.min(W, H) * (0.04 + Math.random() * 0.2);
        const seedR = Math.max(10, (10 + repulsion * 22) * 0.45);
        curves.push(makeSeed(
          W / 2 + Math.cos(a) * d,
          H / 2 + Math.sin(a) * d,
          seedR, loudest
        ));
      }
      // Retire the oldest extra curve once we have too many
      if (curves.length > 14) curves.shift();
    }
  }

  // Physics update
  physicsStep(amps, W, H, speed, tension, repulsion, dt);

  // Render
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.background(0, 0, 0, 18); // soft trail fade
  p.noFill();

  for (const c of curves) {
    const amp   = amps[c.band];
    const trans = transients[c.band] ?? 1.0;
    const hue   = (BAND_HUES[c.band] + hueShift) % 360;
    const sat   = 72 + amp * 28;
    // Transient multiplier briefly whitens and brightens the curve
    const bright = Math.min(100, 40 + amp * 55 + (trans - 1.0) * 18);
    const sw    = 0.7 + amp * 2.2;

    // Three-pass glow: outer halo → mid body → bright core
    p.strokeWeight(sw * 5);
    p.stroke(hue, sat * 0.5, bright, 10 + amp * 18);
    drawSpline(p, c.nodes);

    p.strokeWeight(sw * 2.2);
    p.stroke(hue, sat * 0.75, bright, 28 + amp * 28);
    drawSpline(p, c.nodes);

    p.strokeWeight(sw);
    p.stroke(hue, sat * 0.35, 100, 62 + amp * 38);
    drawSpline(p, c.nodes);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
