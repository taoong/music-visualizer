/**
 * Ferrofluid — Audio-reactive ferrofluid spike field.
 *
 * Simulates the Rosensweig instability of ferrofluid — a colloidal magnetic
 * liquid that self-organises into hexagonally-packed spike formations when
 * exposed to a magnetic field. Audio amplitude plays the role of the field:
 * quiet passages leave the surface glassy and dark; loud passages cause
 * hundreds of chrome spikes to erupt in a close-packed metallic forest.
 *
 * Each spike is rendered as an off-axis sphere-shading gradient (bright
 * specular highlight upper-left, dark body lower-right) that gives the
 * impression of a three-dimensional chrome surface in a 2-D canvas.
 * A dark concave meniscus ring surrounds each spike base, echoing the
 * characteristic liquid collar visible in real ferrofluid photographs.
 *
 * Inspired by Sachiko Kodama's ferrofluid sculptures
 * "Protrude, Flow" (2001) and "Morpho Towers — Two Standing Spirals" (2005).
 * https://www.kodama.hc.uec.ac.jp/
 *
 * Sliders:
 *   Spikes  (ferrofluidSpikes)  — node density; 0 = sparse, 1 = dense grid
 *   Sheen   (ferrofluidSheen)   — metallic reflectivity; 0 = matte, 1 = mirror
 *   Surface (ferrofluidSurface) — viscosity; 0 = free-drifting fluid, 1 = rigid grid
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

// Target node count (grid is built to approximate this; actual count varies with canvas aspect ratio)
const TARGET_NODES = isMobile ? 54 : 110;

// Metallic hue per band: violet → blue → teal → green → gold → orange → crimson
const BAND_HUES: readonly number[] = [280, 220, 180, 140, 50, 25, 350];

// ── Types ─────────────────────────────────────────────────────────────────────

interface Node {
  /** Home (grid) position */
  gx: number;
  gy: number;
  /** Current position */
  x: number;
  y: number;
  /** Velocity */
  vx: number;
  vy: number;
  /** Independent Perlin noise offset so nodes drift asynchronously */
  nox: number;
  noy: number;
  /** Which of the 7 frequency bands drives this node */
  band: number;
  /** Smoothed amplitude for rendering (0–1) */
  amp: number;
}

// ── Module state ──────────────────────────────────────────────────────────────

let nodes: Node[] = [];
let lastW = 0;
let lastH = 0;
let beatPulse = 0;
let lastBeatIndex = -1;
let noiseT = 0;

// ── Grid construction ─────────────────────────────────────────────────────────

function buildGrid(p: P5Instance): void {
  const aspect = p.width / p.height;
  const cols = Math.max(4, Math.round(Math.sqrt(TARGET_NODES * aspect)));
  const rows = Math.max(3, Math.round(TARGET_NODES / cols));
  const cellW = p.width / cols;
  const cellH = p.height / rows;
  const jitter = cellW * 0.07;

  nodes = [];
  // Extend one cell beyond each edge so spikes fill the corners
  for (let row = -1; row <= rows + 1; row++) {
    for (let col = -1; col <= cols + 1; col++) {
      // Offset every other row by half a cell — hexagonal close-packed
      const gx = (col + (row & 1) * 0.5) * cellW + cellW * 0.5;
      const gy = row * cellH + cellH * 0.5;
      nodes.push({
        gx,
        gy,
        x: gx + (Math.random() - 0.5) * jitter,
        y: gy + (Math.random() - 0.5) * jitter,
        vx: 0,
        vy: 0,
        nox: Math.random() * 1000,
        noy: Math.random() * 1000,
        // Distribute bands so adjacent nodes rarely share a band
        band: ((Math.abs(row) * 3 + Math.abs(col) * 2 + row - col) % BAND_COUNT + BAND_COUNT) % BAND_COUNT,
        amp: 0,
      });
    }
  }

  lastW = p.width;
  lastH = p.height;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetFerrofluid(): void {
  nodes = [];
  lastW = 0;
  lastH = 0;
  beatPulse = 0;
  lastBeatIndex = -1;
  noiseT = 0;
}

export function drawFerrofluid(p: P5Instance, dt: number): void {
  const appState = store.state;
  const { ferrofluidSpikes, ferrofluidSheen, ferrofluidSurface } = store.config;
  const { amps } = getBandAverages(BAND_COUNT);

  // Rebuild grid on first call or canvas resize
  if (nodes.length === 0 || lastW !== p.width || lastH !== p.height) {
    buildGrid(p);
  }

  noiseT += 0.001 * dt;

  // ── Beat detection (BPM clock) ───────────────────────────────────────────
  let isBeat = false;
  if (appState.detectedBPM > 0 && appState.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - appState.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / appState.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      isBeat = true;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.88, dt);

  // ── Resolve active node count ────────────────────────────────────────────
  // Spikes slider: 0 → 20 % of nodes, 1 → 100 %
  const active = Math.max(6, Math.round((0.2 + ferrofluidSpikes * 0.8) * nodes.length));

  // ── Physics ──────────────────────────────────────────────────────────────
  const viscosity = ferrofluidSurface;
  const dampFactor = Math.pow(0.72 + viscosity * 0.23, dt);
  const driftStr   = (1.0 - viscosity) * 1.5;

  for (let i = 0; i < active; i++) {
    const n = nodes[i];

    // Spring back to grid home position
    const springK = (0.03 + viscosity * 0.12) * dt;
    n.vx += (n.gx - n.x) * springK;
    n.vy += (n.gy - n.y) * springK;

    // Perlin-noise drift (suppressed by viscosity)
    n.vx += (p.noise(n.nox, noiseT)      - 0.5) * driftStr;
    n.vy += (p.noise(n.noy, noiseT + 50) - 0.5) * driftStr;

    // Beat: radial impulse away from canvas centre
    if (isBeat) {
      const dx = n.x - p.width  * 0.5;
      const dy = n.y - p.height * 0.5;
      const d  = Math.sqrt(dx * dx + dy * dy) + 1;
      n.vx += (dx / d) * 22;
      n.vy += (dy / d) * 22;
    }

    // Damping
    n.vx *= dampFactor;
    n.vy *= dampFactor;

    n.x += n.vx * dt;
    n.y += n.vy * dt;
    n.nox += 0.0022 * dt;
    n.noy += 0.0022 * dt;

    // Smooth rendered amplitude: track band energy + beat surge
    const target = amps[n.band] + beatPulse * 0.38;
    n.amp += (target - n.amp) * Math.min(1, 0.11 * dt);
  }

  // ── Render ───────────────────────────────────────────────────────────────
  p.background(5, 8, 20);
  p.noStroke();

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // Base spike radius from grid density
  const cellR = (p.width / Math.sqrt(active)) * 0.58;

  // Sort ascending by amp so higher spikes composite on top
  const view = nodes.slice(0, active).sort((a, b) => a.amp - b.amp);

  for (const n of view) {
    if (n.amp < 0.015) continue;

    const a     = n.amp;
    const sheen = ferrofluidSheen;
    const r     = cellR * (0.48 + a * 0.52 * (0.5 + sheen * 0.5));
    const hue   = BAND_HUES[n.band];

    // Light position: upper-left of spike (fixed light direction)
    const hx = n.x - r * 0.27;
    const hy = n.y - r * 0.31;

    // ── Meniscus: dark concave collar at the spike base ──────────────────
    const mr    = r * 1.45;
    const mGrad = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, mr);
    mGrad.addColorStop(0,   `rgba(0,0,0,0)`);
    mGrad.addColorStop(0.4, `rgba(2,4,16,${Math.min(1, a * 0.55)})`);
    mGrad.addColorStop(1,   `rgba(0,0,0,0)`);
    ctx.fillStyle = mGrad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, mr, 0, Math.PI * 2);
    ctx.fill();

    // ── Spike body: off-axis sphere gradient (Phong-inspired) ────────────
    // Gradient origin = highlight position; outer = spike edge.
    // Sequence: bright highlight → coloured metallic body → dark shadow → transparent edge.
    const bGrad = ctx.createRadialGradient(hx, hy, 0, n.x, n.y, r);
    bGrad.addColorStop(0.00, `rgba(195,220,255,${Math.min(1, a * sheen * 0.92)})`);
    bGrad.addColorStop(0.17, `hsla(${hue},48%,52%,${Math.min(1, a * 0.88)})`);
    bGrad.addColorStop(0.46, `hsla(${hue},52%,16%,${Math.min(1, a * 0.85)})`);
    bGrad.addColorStop(0.78, `hsla(${hue},48%, 7%,${Math.min(1, a * 0.60)})`);
    bGrad.addColorStop(1.00, `rgba(0,0,0,0)`);
    ctx.fillStyle = bGrad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();

    // ── Specular core: tiny brilliant pinpoint at the highlight peak ──────
    if (a > 0.18 && sheen > 0.05) {
      const sr    = r * 0.13 * sheen;
      const sGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, sr * 2.2);
      sGrad.addColorStop(0,   `rgba(255,255,255,${Math.min(1, a * sheen * 0.96)})`);
      sGrad.addColorStop(0.5, `rgba(210,235,255,${Math.min(1, a * sheen * 0.38)})`);
      sGrad.addColorStop(1,   `rgba(0,0,0,0)`);
      ctx.fillStyle = sGrad;
      ctx.beginPath();
      ctx.arc(hx, hy, sr * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Beat flash: brief ambient luminescence ────────────────────────────────
  if (beatPulse > 0.15) {
    ctx.fillStyle = `rgba(55,85,170,${beatPulse * 0.065})`;
    ctx.fillRect(0, 0, p.width, p.height);
  }
}
