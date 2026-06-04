/**
 * Circuit — PCB-trace neon routing visualization
 *
 * N nodes scatter across the canvas; smooth L-shaped bezier traces
 * connect nearby nodes and glow with per-band neon colors. Signal
 * pulses animate along each trace; beats cascade a burst of pulses
 * from random nodes while incrementally shifting the hue palette.
 *
 * Inspired by Joshua Davis — "Praystation" generative circuit-board
 * design system (2001–2003)   https://joshuadavis.com
 *
 * Sliders
 *   Nodes — connection-point count (10–60)
 *   Speed — signal pulse travel speed (slow → fast)
 *   Glow  — trace neon glow intensity (dim → bright)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Per-band hues: violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES = [280, 240, 175, 130, 75, 35, 320];

const MIN_NODES = 10;
const MAX_NODES = isMobile ? 30 : 60;
const CONN_MIN = 80;   // px — minimum trace length
const CONN_MAX = 240;  // px — maximum trace length
const MAX_CONN = 3;    // max connections per node
const MAX_PULSES = isMobile ? 50 : 100;

interface Node { x: number; y: number; band: number }
interface Trace {
  a: number; b: number; band: number;
  cp1x: number; cp1y: number;
  cp2x: number; cp2y: number;
  len: number; // approx arc length in px
}
interface Pulse { tr: number; t: number; dir: 1 | -1 }

let nodes: Node[] = [];
let traces: Trace[] = [];
let pulses: Pulse[] = [];
let nodeTraces: number[][] = []; // trace indices per node
let bandTraces: number[][] = []; // trace indices per band
let initialized = false;
let prevW = 0, prevH = 0, prevN = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let hueShift = 0;

// Evaluate cubic bezier at t → [x, y]
function bezierPt(
  t: number,
  x0: number, y0: number,
  cx1: number, cy1: number,
  cx2: number, cy2: number,
  x3: number, y3: number,
): [number, number] {
  const m = 1 - t, m2 = m * m, m3 = m2 * m;
  const t2 = t * t, t3 = t2 * t;
  return [
    m3 * x0 + 3 * m2 * t * cx1 + 3 * m * t2 * cx2 + t3 * x3,
    m3 * y0 + 3 * m2 * t * cy1 + 3 * m * t2 * cy2 + t3 * y3,
  ];
}

// Approximate bezier arc length via 12-segment chord sum
function bezierLen(
  x0: number, y0: number,
  cx1: number, cy1: number,
  cx2: number, cy2: number,
  x3: number, y3: number,
): number {
  let len = 0, px = x0, py = y0;
  for (let i = 1; i <= 12; i++) {
    const [nx, ny] = bezierPt(i / 12, x0, y0, cx1, cy1, cx2, cy2, x3, y3);
    len += Math.hypot(nx - px, ny - py);
    px = nx; py = ny;
  }
  return Math.max(len, 1);
}

// Build graph of nodes and L-shaped bezier traces
function build(w: number, h: number, n: number): void {
  nodes = []; traces = []; pulses = [];

  const mg = 60;
  for (let i = 0; i < n; i++) {
    const x = mg + Math.random() * (w - 2 * mg);
    const y = mg + Math.random() * (h - 2 * mg);
    nodes.push({ x, y, band: Math.min(Math.floor((x / w) * BAND_COUNT), BAND_COUNT - 1) });
  }

  const seen = new Set<string>();
  const cnt = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    // Collect candidates sorted by proximity
    const nbrs: [number, number][] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (d >= CONN_MIN && d <= CONN_MAX) nbrs.push([j, d]);
    }
    nbrs.sort((a, b) => a[1] - b[1]);

    for (const [j] of nbrs) {
      if (cnt[i] >= MAX_CONN) break;
      if (cnt[j] >= MAX_CONN) continue;
      const key = `${Math.min(i, j)}_${Math.max(i, j)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const ax = nodes[i].x, ay = nodes[i].y;
      const bx = nodes[j].x, by = nodes[j].y;
      const dx = bx - ax, dy = by - ay;

      // PCB L-shape: travel predominantly horizontal then vertical (or vice versa)
      let cp1x: number, cp1y: number, cp2x: number, cp2y: number;
      if (Math.abs(dx) >= Math.abs(dy)) {
        cp1x = ax + dx * 0.72; cp1y = ay;
        cp2x = bx;             cp2y = by - dy * 0.28;
      } else {
        cp1x = ax;              cp1y = ay + dy * 0.72;
        cp2x = bx - dx * 0.28; cp2y = by;
      }

      const band = Math.min(Math.floor(((ax + bx) / 2 / w) * BAND_COUNT), BAND_COUNT - 1);
      traces.push({
        a: i, b: j, band,
        cp1x, cp1y, cp2x, cp2y,
        len: bezierLen(ax, ay, cp1x, cp1y, cp2x, cp2y, bx, by),
      });
      cnt[i]++; cnt[j]++;
    }
  }

  // Precompute per-node and per-band trace index lists
  nodeTraces = Array.from({ length: n }, () => []);
  bandTraces = Array.from({ length: BAND_COUNT }, () => []);
  for (let ti = 0; ti < traces.length; ti++) {
    nodeTraces[traces[ti].a].push(ti);
    nodeTraces[traces[ti].b].push(ti);
    bandTraces[traces[ti].band].push(ti);
  }

  initialized = true;
  prevW = w; prevH = h; prevN = n;
}

function spawnPulse(ti: number, fromA = true): void {
  if (pulses.length >= MAX_PULSES) return;
  pulses.push({ tr: ti, t: fromA ? 0 : 1, dir: fromA ? 1 : -1 });
}

export function drawCircuit(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w = p.width, h = p.height;
  const nodeCount = Math.round(MIN_NODES + config.circuitNodes * (MAX_NODES - MIN_NODES));
  // Speed: 80–400 px/s, normalized to per-frame at 60 fps
  const speedPxF = (80 + config.circuitSpeed * 320) / 60;
  const glowAmt = 0.3 + config.circuitGlow * 0.7;

  if (!initialized || w !== prevW || h !== prevH || nodeCount !== prevN) {
    build(w, h, nodeCount);
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
      hueShift = (hueShift + 20) % 360;
      // Burst pulses from 3–6 random nodes
      const burst = 3 + Math.floor(Math.random() * 4);
      for (let k = 0; k < burst; k++) {
        const ni = Math.floor(Math.random() * nodes.length);
        for (const ti of nodeTraces[ni]) {
          spawnPulse(ti, traces[ti].a === ni);
        }
      }
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  // Transient-driven auto-spawn (light trickle between beats)
  for (let b = 0; b < BAND_COUNT; b++) {
    if ((transients[b] || 1) > 1.4 && Math.random() < 0.05 * dt && bandTraces[b].length > 0) {
      const tl = bandTraces[b];
      spawnPulse(tl[Math.floor(Math.random() * tl.length)], Math.random() < 0.5);
    }
  }

  // ── Background ────────────────────────────────────────────────────────────
  p.background(4, 7, 18);
  if (beatFlash > 0.01) {
    p.noStroke();
    p.fill(255, 255, 255, Math.round(beatFlash * 18));
    p.rect(0, 0, w, h);
  }

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── Traces ────────────────────────────────────────────────────────────────
  p.noFill();
  for (let ti = 0; ti < traces.length; ti++) {
    const tr = traces[ti];
    const na = nodes[tr.a], nb = nodes[tr.b];
    const amp = amps[tr.band] || 0;
    const hue = (BAND_HUES[tr.band] + hueShift) % 360;

    // Outer glow pass
    p.strokeWeight(5 + amp * 5);
    p.stroke(hue, 65, 75, (8 + amp * 35) * glowAmt);
    p.beginShape();
    (p as any).vertex(na.x, na.y);
    (p as any).bezierVertex(tr.cp1x, tr.cp1y, tr.cp2x, tr.cp2y, nb.x, nb.y);
    p.endShape();

    // Bright core line
    p.strokeWeight(1.2);
    p.stroke(hue, 40, 100, (25 + amp * 55) * glowAmt);
    p.beginShape();
    (p as any).vertex(na.x, na.y);
    (p as any).bezierVertex(tr.cp1x, tr.cp1y, tr.cp2x, tr.cp2y, nb.x, nb.y);
    p.endShape();
  }

  // ── Signal pulses ─────────────────────────────────────────────────────────
  p.noStroke();
  for (let i = pulses.length - 1; i >= 0; i--) {
    const pulse = pulses[i];
    const tr = traces[pulse.tr];
    if (!tr) { pulses.splice(i, 1); continue; }

    pulse.t += pulse.dir * (speedPxF * dt) / tr.len;
    if (pulse.t < 0 || pulse.t > 1) { pulses.splice(i, 1); continue; }

    const na = nodes[tr.a], nb = nodes[tr.b];
    const [px, py] = bezierPt(pulse.t, na.x, na.y, tr.cp1x, tr.cp1y, tr.cp2x, tr.cp2y, nb.x, nb.y);
    const hue = (BAND_HUES[tr.band] + hueShift) % 360;

    // Glow halo → bright core → white hot center
    p.fill(hue, 50, 90, 25 * glowAmt);
    p.ellipse(px, py, 16, 16);
    p.fill(hue, 20, 100, 80 * glowAmt);
    p.ellipse(px, py, 7, 7);
    p.fill(0, 0, 100, 95);
    p.ellipse(px, py, 2.5, 2.5);
  }

  // ── Nodes (via pads) ──────────────────────────────────────────────────────
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    const amp = amps[nd.band] || 0;
    const hue = (BAND_HUES[nd.band] + hueShift) % 360;
    const sz = 3 + amp * 7;

    p.noStroke();
    p.fill(hue, 70, 80, (8 + amp * 28) * glowAmt);
    p.ellipse(nd.x, nd.y, sz * 3.5, sz * 3.5);

    p.fill(hue, 50, 100, (40 + amp * 50) * glowAmt);
    p.ellipse(nd.x, nd.y, sz, sz);

    p.fill(0, 0, 100, 90);
    p.ellipse(nd.x, nd.y, 2, 2);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetCircuit(): void {
  nodes = []; traces = []; pulses = [];
  nodeTraces = []; bandTraces = [];
  initialized = false;
  prevW = 0; prevH = 0; prevN = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  hueShift = 0;
}
