/**
 * Reticulae — Audio-reactive wire mesh sculpture.
 *
 * Inspired by Gego (Gertrude Goldschmidt) "Reticulárea" (1969–1982), her
 * suspended open wire-mesh installations that filled entire gallery spaces at
 * the Museo de Bellas Artes, Caracas and later the Guggenheim, New York
 * (https://www.guggenheim.org/audio/track/description-of-reticularea-installation-photographs).
 * Gego wove modular triangular units of steel and aluminum wire into net-like
 * structures that shifted subtly with air currents, projecting ever-changing
 * shadows across gallery walls.
 *
 * A roughly-regular triangulated mesh spans the canvas. Seven horizontal
 * frequency zones (sub-bass=left → brilliance=right) colour each wire
 * segment; band amplitude drives neon brightness and node oscillation. Beat
 * fires a radial pulse that ripples outward through the lattice like a
 * plucked string. 3-pass glow rendering per segment: wide outer halo, mid
 * bloom, crisp metallic core. Sliders: Density (grid resolution),
 * Vibration (node oscillation amplitude), Glow (neon bloom intensity).
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per freq band: violet→blue→teal→green→yellow→orange→magenta
const BAND_HUES = [270, 220, 175, 130, 60, 30, 310] as const;

interface MNode {
  x: number;   // current x
  y: number;   // current y
  bx: number;  // base (rest) x
  by: number;  // base (rest) y
  nx: number;  // perlin seed x
  ny: number;  // perlin seed y
  vx: number;  // velocity x
  vy: number;  // velocity y
}

interface MEdge {
  a: number;   // node index A
  b: number;   // node index B
  band: number; // freq band 0-6
}

// ── Module state ──────────────────────────────────────────────────────────
let nodes: MNode[] = [];
let edges: MEdge[] = [];
let lastDensityKey = -1;
let t = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let hueShift = 0;

function buildMesh(cols: number, rows: number, w: number, h: number): void {
  nodes = [];
  edges = [];

  const cellW = w / cols;
  const cellH = h / rows;

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const jx = (Math.random() - 0.5) * cellW * 0.42;
      const jy = (Math.random() - 0.5) * cellH * 0.42;
      const bx = col * cellW + jx;
      const by = row * cellH + jy;
      nodes.push({ x: bx, y: by, bx, by, nx: Math.random() * 1000, ny: Math.random() * 1000, vx: 0, vy: 0 });
    }
  }

  const numCols = cols + 1;

  const addEdge = (ai: number, bi: number): void => {
    const na = nodes[ai];
    const nb = nodes[bi];
    const midX = (na.bx + nb.bx) * 0.5;
    const band = Math.min(BAND_COUNT - 1, Math.floor((midX / w) * BAND_COUNT));
    edges.push({ a: ai, b: bi, band });
  };

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const i = row * numCols + col;
      // Horizontal edge
      if (col < cols) addEdge(i, i + 1);
      // Vertical edge
      if (row < rows) addEdge(i, i + numCols);
      // Diagonal — alternating direction creates organic triangulation
      if (col < cols && row < rows) {
        if ((row + col) % 2 === 0) {
          addEdge(i, i + numCols + 1);  // down-right
        } else {
          addEdge(i + 1, i + numCols);  // down-left (connects right node to node below)
        }
      }
    }
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────
export function drawReticulae(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const density   = config.reticulaeDensity;
  const vibration = config.reticulaeVibration;
  const glow      = config.reticulaeGlow;

  // Grid resolution: sparse (low density) → dense (high density)
  const maxCols = isMobile ? 13 : 22;
  const maxRows = isMobile ? 8  : 13;
  const minCols = isMobile ? 6  : 9;
  const minRows = isMobile ? 4  : 5;
  const cols = Math.round(minCols + density * (maxCols - minCols));
  const rows = Math.round(minRows + density * (maxRows - minRows));

  // Rebuild only when grid dimensions change
  const dk = cols * 100 + rows;
  if (dk !== lastDensityKey) {
    lastDensityKey = dk;
    buildMesh(cols, rows, p.width, p.height);
  }

  // ── Beat detection ────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    if (adj >= 0) {
      const idx = Math.floor(adj / state.beatIntervalSec);
      if (idx !== lastBeatIndex) {
        lastBeatIndex = idx;
        beatFlash = 1.0;
        hueShift = (hueShift + 43) % 360;
        // Radial pulse outward from canvas centre
        const cx = p.width  * 0.5;
        const cy = p.height * 0.5;
        for (const nd of nodes) {
          const dx = nd.bx - cx;
          const dy = nd.by - cy;
          const dist = Math.sqrt(dx * dx + dy * dy) + 1;
          const mag  = (8 + vibration * 14) * (80 / (dist + 80));
          nd.vx += (dx / dist) * mag;
          nd.vy += (dy / dist) * mag;
        }
      }
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  t += 0.0008 * dt;

  // ── Update node positions ─────────────────────────────────────────────
  for (const nd of nodes) {
    const bIdx    = Math.min(BAND_COUNT - 1, Math.floor((nd.bx / p.width) * BAND_COUNT));
    const bandAmp = amps[bIdx];

    // Perlin noise oscillation — magnitude scales with vibration and amplitude
    const noiseAmt = vibration * (6 + bandAmp * 22);
    const nx = (p.noise(nd.nx + t * 1.1) - 0.5) * noiseAmt;
    const ny = (p.noise(nd.ny + t * 0.85) - 0.5) * noiseAmt;

    // Spring toward base + noise target, with damping
    const tx = nd.bx + nx;
    const ty = nd.by + ny;
    nd.vx += (tx - nd.x) * 0.05 * dt;
    nd.vy += (ty - nd.y) * 0.05 * dt;
    nd.vx *= Math.pow(0.84, dt);
    nd.vy *= Math.pow(0.84, dt);
    nd.x  += nd.vx * dt;
    nd.y  += nd.vy * dt;
  }

  // ── Render ────────────────────────────────────────────────────────────
  p.background(3, 6, 15); // deep navy ground

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  (p as any).noFill();

  const bf  = beatFlash;
  const gm  = 0.3 + glow * 0.7; // glow multiplier

  // Pass 1: outer halo (wide, soft)
  for (const e of edges) {
    const na  = nodes[e.a];
    const nb  = nodes[e.b];
    const amp = amps[e.band];
    const hue = (BAND_HUES[e.band] + hueShift) % 360;
    const alpha = Math.min(100, (4 + amp * 16 + bf * 6) * gm);
    const sw    = (4.5 + amp * 7 + glow * 3) * (1 + bf * 0.35);
    (p as any).stroke(hue, 55, 60, alpha);
    p.strokeWeight(sw);
    p.line(na.x, na.y, nb.x, nb.y);
  }

  // Pass 2: mid bloom
  for (const e of edges) {
    const na  = nodes[e.a];
    const nb  = nodes[e.b];
    const amp = amps[e.band];
    const hue = (BAND_HUES[e.band] + hueShift) % 360;
    const alpha = Math.min(100, (10 + amp * 32 + bf * 14) * gm);
    const sw    = (1.5 + amp * 3.5 + glow * 1.5) * (1 + bf * 0.2);
    (p as any).stroke(hue, 65, 72, alpha);
    p.strokeWeight(sw);
    p.line(na.x, na.y, nb.x, nb.y);
  }

  // Pass 3: bright metallic core wire
  for (const e of edges) {
    const na  = nodes[e.a];
    const nb  = nodes[e.b];
    const amp = amps[e.band];
    const hue = (BAND_HUES[e.band] + hueShift) % 360;
    const sat  = 12 + amp * 68;
    const bri  = Math.min(100, 52 + amp * 42 + bf * 28);
    const alpha = Math.min(100, 50 + amp * 45 + bf * 20);
    p.strokeWeight(0.55 + amp * 1.0);
    (p as any).stroke(hue, sat, bri, alpha);
    p.line(na.x, na.y, nb.x, nb.y);
  }

  // ── Node intersection dots (appear only when band is active) ──────────
  (p as any).noStroke();
  for (const nd of nodes) {
    const bIdx = Math.min(BAND_COUNT - 1, Math.floor((nd.bx / p.width) * BAND_COUNT));
    const amp  = amps[bIdx];
    if (amp < 0.08) continue;
    const hue = (BAND_HUES[bIdx] + hueShift) % 360;
    const r   = (1 + amp * 3.5 + glow * 1.5) * gm;
    const a   = Math.min(100, 28 + amp * 58 + bf * 22);
    (p as any).fill(hue, 35, 92, a);
    p.circle(nd.x, nd.y, r * 2);
  }

  // Reset to RGB for next viz / p5 UI elements
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────
export function resetReticulae(): void {
  nodes        = [];
  edges        = [];
  lastDensityKey = -1;
  t            = 0;
  lastBeatIndex = -1;
  beatFlash    = 0;
  hueShift     = 0;
}
