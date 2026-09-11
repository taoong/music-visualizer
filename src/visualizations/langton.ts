/**
 * Langton's Ant — Emergent cellular automaton trail painting.
 *
 * Seven "ants" (one per frequency band) walk on a shared grid following
 * Langton's Ant rule: on a white cell turn right, flip to black, step forward;
 * on a black cell turn left, flip to white, step forward. After ~10,000 steps
 * per ant this deterministic rule spontaneously produces a diagonal "highway"
 * — an endlessly repeating structure that emerges unbidden from pure local
 * behavior. Multiple ants interfere with each other's cell states, creating
 * complex multi-colored tapestries of intersecting highways and organic chaos.
 *
 * Band amplitude drives step count per frame so loud passages make ants race
 * across the canvas leaving dense colored trails; quiet passages slow them to
 * a crawl. Beat events scatter all ants to fresh positions and shift the hue
 * palette, triggering new bouts of pattern formation.
 *
 * Inspired by Casey Reas' "Process" series (2004, https://reas.com/texts/)
 * — simple autonomous behavioral rules producing globally complex visual
 * systems — and by Christopher Langton's foundational "Computation at the
 * Edge of Chaos" research (1990) on emergence in cellular automata.
 * https://en.wikipedia.org/wiki/Langton%27s_ant
 *
 * Sliders
 *   Speed  — base step rate per frame (slow drift vs. fast highway building)
 *   Chaos  — probability of random turn instead of Langton rule (0 = pure
 *             deterministic emergence, 1 = Brownian noise walk)
 *   Trail  — persistence of trail buffer (0 = fast fade, 1 = permanent)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=indigo, lowMid=teal, mid=green,
//               upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [270, 220, 175, 120, 60, 25, 0];

// Pixel size of each grid cell
const CELL_PX = isMobile ? 6 : 4;

type Ant = {
  gx: number;  // grid column
  gy: number;  // grid row
  dir: number; // 0=up, 1=right, 2=down, 3=left
  band: number;
};

let grid: Uint8Array | null = null; // 0=white, 1=black per cell
let gridW = 0;
let gridH = 0;
let ants: Ant[] = [];
let lastBeatIndex = -1;
let globalHue = 0;

let trailCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let trailCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
let trailW = 0;
let trailH = 0;
let initialized = false;

function ensureBuffers(W: number, H: number): void {
  const gW = Math.floor(W / CELL_PX);
  const gH = Math.floor(H / CELL_PX);
  if (trailCanvas && trailW === W && trailH === H && gridW === gW && gridH === gH) return;

  gridW = gW;
  gridH = gH;
  grid = new Uint8Array(gW * gH);

  trailW = W;
  trailH = H;

  if (typeof OffscreenCanvas !== 'undefined') {
    trailCanvas = new OffscreenCanvas(W, H);
  } else {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    trailCanvas = c;
  }
  trailCtx = trailCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  if (trailCtx) {
    trailCtx.fillStyle = '#060010';
    trailCtx.fillRect(0, 0, W, H);
  }

  spawnAnts();
  initialized = true;
}

function spawnAnts(): void {
  ants = [];
  for (let b = 0; b < BAND_COUNT; b++) {
    ants.push({
      gx: Math.floor(gridW * (b + 1) / (BAND_COUNT + 1)),
      gy: Math.floor(gridH / 2) + Math.floor(Math.random() * 10) - 5,
      dir: b % 4,
      band: b,
    });
  }
}

function scatterAnts(): void {
  for (const ant of ants) {
    ant.gx = 5 + Math.floor(Math.random() * Math.max(1, gridW - 10));
    ant.gy = 5 + Math.floor(Math.random() * Math.max(1, gridH - 10));
    ant.dir = Math.floor(Math.random() * 4);
  }
}

function stepAnt(ant: Ant, chaos: number): void {
  if (!grid) return;
  const idx = ant.gy * gridW + ant.gx;
  const cell = grid[idx];

  if (Math.random() < chaos) {
    ant.dir = Math.floor(Math.random() * 4);
  } else {
    // White (0) → turn right (+1 mod 4); black (1) → turn left (+3 ≡ −1 mod 4)
    ant.dir = (ant.dir + (cell === 0 ? 1 : 3)) & 3;
  }

  grid[idx] ^= 1;

  // Move forward
  if      (ant.dir === 0) ant.gy = (ant.gy - 1 + gridH) % gridH;
  else if (ant.dir === 1) ant.gx = (ant.gx + 1) % gridW;
  else if (ant.dir === 2) ant.gy = (ant.gy + 1) % gridH;
  else                   ant.gx = (ant.gx - 1 + gridW) % gridW;
}

export function resetLangton(): void {
  grid = null;
  gridW = 0;
  gridH = 0;
  ants = [];
  lastBeatIndex = -1;
  globalHue = 0;
  trailCanvas = null;
  trailCtx = null;
  trailW = 0;
  trailH = 0;
  initialized = false;
}

export function drawLangton(p: P5Instance, dt: number): void {
  const { config, state } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const W = p.width;
  const H = p.height;

  ensureBuffers(W, H);
  if (!trailCtx || !initialized) return;

  const speed  = 0.4 + config.langtonSpeed * 3.6;   // 0.4–4.0× multiplier
  const chaos  = config.langtonChaos ** 2;            // squared for fine low-end control
  const trail  = config.langtonTrail;

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
      lastBeatIndex = beatIndex;
      onBeat = true;
    }
  }

  if (onBeat) {
    scatterAnts();
    globalHue = (globalHue + 47) % 360;
    // Beat flash: briefly brighten the trail buffer
    trailCtx.fillStyle = 'rgba(255,255,255,0.04)';
    trailCtx.fillRect(0, 0, W, H);
  }

  // Fade trail buffer toward dark background
  const fadeAlpha = p.map(trail, 0, 1, 0.22, 0.012);
  trailCtx.fillStyle = `rgba(6,0,16,${fadeAlpha.toFixed(4)})`;
  trailCtx.fillRect(0, 0, W, H);

  // Step each ant and paint trails
  for (let b = 0; b < BAND_COUNT; b++) {
    const ant = ants[b];
    const amp  = Math.min(1, amps[b] * 1.5);
    const steps = Math.max(1, Math.round(speed * (0.4 + amp * 1.6) * dt));
    const hue   = (BAND_HUES[b] + globalHue) % 360;

    for (let s = 0; s < steps; s++) {
      stepAnt(ant, chaos);
      const px = ant.gx * CELL_PX;
      const py = ant.gy * CELL_PX;
      const bright = 40 + amp * 45;

      // 3-pass glow: outer halo → mid bloom → bright core
      trailCtx.fillStyle = `hsla(${hue},75%,${bright}%,0.10)`;
      trailCtx.fillRect(px - CELL_PX, py - CELL_PX, CELL_PX * 3, CELL_PX * 3);

      trailCtx.fillStyle = `hsla(${hue},85%,${bright + 15}%,0.32)`;
      trailCtx.fillRect(px, py, CELL_PX, CELL_PX);

      trailCtx.fillStyle = `hsla(${hue},60%,92%,0.65)`;
      const inset = CELL_PX * 0.18;
      trailCtx.fillRect(px + inset, py + inset, CELL_PX - inset * 2, CELL_PX - inset * 2);
    }
  }

  // Blit trail canvas to p5 main canvas
  const mainCtx = p.drawingContext as CanvasRenderingContext2D;
  mainCtx.drawImage(trailCanvas!, 0, 0, W, H);

  // Draw current ant positions as bright glowing dots
  for (let b = 0; b < BAND_COUNT; b++) {
    const ant = ants[b];
    const amp  = Math.min(1, amps[b] * 1.5);
    const hue  = (BAND_HUES[b] + globalHue) % 360;
    const cx   = ant.gx * CELL_PX + CELL_PX * 0.5;
    const cy   = ant.gy * CELL_PX + CELL_PX * 0.5;
    const r    = CELL_PX * (1.0 + amp * 1.8);

    // Outer glow
    mainCtx.beginPath();
    mainCtx.arc(cx, cy, r * 2.5, 0, Math.PI * 2);
    mainCtx.fillStyle = `hsla(${hue},80%,65%,0.15)`;
    mainCtx.fill();

    // Mid glow
    mainCtx.beginPath();
    mainCtx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
    mainCtx.fillStyle = `hsla(${hue},85%,80%,0.35)`;
    mainCtx.fill();

    // Bright core
    mainCtx.beginPath();
    mainCtx.arc(cx, cy, r, 0, Math.PI * 2);
    mainCtx.fillStyle = `hsla(${hue},70%,95%,0.85)`;
    mainCtx.fill();
  }
}
