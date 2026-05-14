/**
 * Flow Field — Perlin-noise vector field guiding colored brushstroke ribbons.
 *
 * Inspired by Tyler Hobbs' "Fidenza" (2021) — long-form generative art where
 * flow fields steer thick curved shapes across the canvas, producing results
 * that feel hand-painted yet algorithmically precise.
 *
 * Each ribbon is assigned to one of the 7 frequency bands. The band's
 * amplitude drives the ribbon's speed, stroke weight, and color brightness.
 * Sub-bass turbulence bends the field spatially; bass adds a large-scale
 * curl; beats burst fresh ribbons in from the canvas edges. An ADD blendMode
 * offscreen buffer accumulates glowing trails that fade at a rate set by the
 * Trail slider.
 *
 * Sliders: Turbulence (field chaos), Trail (persistence), Width (stroke weight)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band HSB hues: sub → bass → low-mid → mid → upper-mid → presence → brilliance
const BAND_HUES = [270, 215, 180, 120, 55, 22, 340];

interface Ribbon {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  angle: number;
  speed: number;
  band: number;
  life: number;
  maxLife: number;
  weight: number;
}

const MAX_RIBBONS = isMobile ? 130 : 300;
const FIELD_RES = 18; // pixels per flow-field grid cell

let ribbons: Ribbon[] = [];
let pg: any = null;
let flowField: Float32Array | null = null;
let fieldCols = 0;
let fieldRows = 0;
let lastBeatIndex = -1;
let globalT = 0;

export function resetFlowField(): void {
  ribbons = [];
  pg = null;
  flowField = null;
  fieldCols = 0;
  fieldRows = 0;
  lastBeatIndex = -1;
  globalT = 0;
}

export function drawFlowField(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const turbulence = config.flowfieldTurbulence; // 0–1
  const trail = config.flowfieldTrail;           // 0–1
  const widthScale = config.flowfieldWidth;      // 0–1

  // Init / resize offscreen buffer
  if (!pg || pg.width !== p.width || pg.height !== p.height) {
    pg = (p as any).createGraphics(p.width, p.height);
    pg.pixelDensity(1);
    pg.background(0);
    ribbons = [];
    lastBeatIndex = -1;
  }

  // Init / resize flow field grid
  const cols = Math.ceil(p.width / FIELD_RES) + 2;
  const rows = Math.ceil(p.height / FIELD_RES) + 2;
  if (!flowField || fieldCols !== cols || fieldRows !== rows) {
    fieldCols = cols;
    fieldRows = rows;
    flowField = new Float32Array(cols * rows);
  }

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

  globalT += 0.0025 * dt;

  // Compute flow field from Perlin noise
  // noiseScale: low turbulence → small scale → smooth laminar flow
  //             high turbulence → large scale → chaotic eddies
  const noiseScale = 0.012 + turbulence * 0.11;
  const sub = amps[0];
  const bass = amps[1];

  for (let row = 0; row < fieldRows; row++) {
    for (let col = 0; col < fieldCols; col++) {
      const nx = col * noiseScale + sub * 0.4;
      const ny = row * noiseScale + bass * 0.25;
      // Primary octave + harmonic for richer curl
      const n1 = (p as any).noise(nx, ny, globalT) * 2 - 1;
      const n2 = ((p as any).noise(nx * 2.1 + 5.3, ny * 2.1 + 3.7, globalT * 1.6) * 2 - 1) * 0.45;
      flowField[row * fieldCols + col] = (n1 + n2) * Math.PI * 2;
    }
  }

  // Maintain ribbon population proportional to average energy
  const avgAmp = (amps.reduce((a, b) => a + b, 0) / BAND_COUNT) || 0.15;
  const targetCount = Math.round(MAX_RIBBONS * Math.max(0.25, avgAmp * 0.85 + 0.15));
  while (ribbons.length < targetCount) {
    spawnRibbon(p, amps, false);
  }

  // Beat → burst of edge-spawned ribbons
  if (onBeat) {
    const burst = Math.round(8 + sub * 25);
    for (let i = 0; i < burst && ribbons.length < MAX_RIBBONS; i++) {
      spawnRibbon(p, amps, true);
    }
  }

  // Draw to offscreen buffer
  (pg as any).colorMode(pg['HSB'], 360, 100, 100, 100);
  pg.blendMode(pg['BLEND']);

  // Trail fade: high trail → low alpha → slow fade
  const fadeAlpha = (1 - trail) * 22 + 0.6;
  pg.noStroke();
  pg.fill(0, 0, 0, fadeAlpha);
  pg.rect(0, 0, pg.width, pg.height);

  pg.noFill();
  pg.blendMode(pg['ADD']);

  const alive: Ribbon[] = [];

  for (const r of ribbons) {
    r.life -= dt;
    if (r.life <= 0) continue;

    // Look up field angle at current position
    const cellX = Math.max(0, Math.min(fieldCols - 1, Math.floor(r.x / FIELD_RES)));
    const cellY = Math.max(0, Math.min(fieldRows - 1, Math.floor(r.y / FIELD_RES)));
    const targetAngle = flowField[cellY * fieldCols + cellX];

    // Smooth angle steering (angular inertia makes curves feel like brushstrokes)
    let diff = targetAngle - r.angle;
    diff = ((diff + Math.PI * 3) % (Math.PI * 2)) - Math.PI; // wrap to [-π, π]
    r.angle += diff * 0.10 * dt;

    r.prevX = r.x;
    r.prevY = r.y;

    const amp = Math.min(1, amps[r.band]);
    r.x += Math.cos(r.angle) * r.speed * (1 + amp * 2.2) * dt;
    r.y += Math.sin(r.angle) * r.speed * (1 + amp * 2.2) * dt;

    // Kill out-of-bounds
    const margin = 12;
    if (r.x < -margin || r.x > p.width + margin || r.y < -margin || r.y > p.height + margin) {
      continue;
    }

    const lifeFrac = r.life / r.maxLife;
    const hue = BAND_HUES[r.band];
    const sat = 65 + amp * 35;
    const bri = 50 + amp * 50;
    const baseAlpha = lifeFrac * 70 + 8;

    const strokeW = r.weight * (0.4 + widthScale * 1.8) * (0.65 + amp * 0.5);

    // 3-pass glow: outer halo → mid → bright core
    pg.strokeWeight(strokeW * 5);
    pg.stroke(hue, sat * 0.5, bri * 0.75, baseAlpha * 0.12);
    pg.line(r.prevX, r.prevY, r.x, r.y);

    pg.strokeWeight(strokeW * 2);
    pg.stroke(hue, sat * 0.8, bri, baseAlpha * 0.45);
    pg.line(r.prevX, r.prevY, r.x, r.y);

    pg.strokeWeight(strokeW);
    pg.stroke(hue, sat, Math.min(100, bri * 1.15), baseAlpha);
    pg.line(r.prevX, r.prevY, r.x, r.y);

    alive.push(r);
  }

  ribbons = alive;

  pg.blendMode(pg['BLEND']);
  (pg as any).colorMode(pg['RGB'], 255, 255, 255, 255);

  // Composite onto main canvas
  p.background(0);
  p.blendMode(p['ADD']);
  p.image(pg, 0, 0);
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

function spawnRibbon(p: P5Instance, amps: number[], fromEdge: boolean): void {
  const band = Math.floor(Math.random() * BAND_COUNT);
  const amp = Math.min(1, amps[band]);

  let x: number, y: number;
  if (fromEdge) {
    const edge = Math.floor(Math.random() * 4);
    if (edge === 0)      { x = Math.random() * p.width;  y = 0; }
    else if (edge === 1) { x = p.width;                  y = Math.random() * p.height; }
    else if (edge === 2) { x = Math.random() * p.width;  y = p.height; }
    else                 { x = 0;                         y = Math.random() * p.height; }
  } else {
    x = Math.random() * p.width;
    y = Math.random() * p.height;
  }

  const maxLife = 70 + amp * 110 + Math.random() * 60;

  ribbons.push({
    x,
    y,
    prevX: x,
    prevY: y,
    angle: Math.random() * Math.PI * 2,
    speed: 1.0 + Math.random() * 2.0 + amp * 1.8,
    band,
    life: maxLife,
    maxLife,
    weight: 2.5 + Math.random() * 5 + amp * 3,
  });
}
