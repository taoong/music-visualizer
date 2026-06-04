/**
 * Lasers — concert laser light show.
 *
 * Designed to look like a real rig: volumetric beams through haze,
 * reflective bounces off walls, moving scanner sources, and 10 distinct
 * show patterns that cycle on the beat. Each beam has a 6-pass glow that
 * creates the "cone of light in fog" look of professional laser equipment.
 *
 * Audio reactivity
 *   Bass amplitude    → beam brightness and sweep speed
 *   Each freq band    → drives one beam's sweep in fan/DJ-booth patterns
 *   Beat transient    → full-canvas white strobe flash
 *   Beat division     → how many beats between pattern changes
 *
 * Intensity slider scales overall brightness (works as dimmer).
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Beam {
  srcX: number;
  srcY: number;
  angle: number;         // base angle (radians)
  sweepAmp: number;      // max sweep deviation (radians)
  sweepSpeed: number;    // oscillation frequency
  sweepPhase: number;    // phase offset
  hue: number;
  bandIndex: number;     // which freq band drives this beam's sweep
  bounces: number;       // how many wall reflections (0–3)
}

// ── Module state ──────────────────────────────────────────────────────────────

let lastBeatIndex = -1;
let lastBeatGroupIndex = -1;
let beatFlash = 0;       // strobe: decays from 1 → 0
let sweepT = 0;          // global time accumulator for sweeps
let beams: Beam[] = [];
let patternIndex = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

/**
 * Trace a ray from (x,y) at angle until it hits a canvas boundary.
 * Returns the hit point and which edge was struck ('left'|'right'|'top'|'bottom').
 */
function traceToEdge(
  x: number, y: number, angle: number, w: number, h: number
): [number, number, 'left' | 'right' | 'top' | 'bottom'] {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let t = Infinity;
  let edge: 'left' | 'right' | 'top' | 'bottom' = 'right';

  if (dx > 1e-9)  { const tc = (w - x) / dx; if (tc < t) { t = tc; edge = 'right'; } }
  if (dx < -1e-9) { const tc = (0 - x) / dx; if (tc < t) { t = tc; edge = 'left'; } }
  if (dy > 1e-9)  { const tc = (h - y) / dy; if (tc < t) { t = tc; edge = 'bottom'; } }
  if (dy < -1e-9) { const tc = (0 - y) / dy; if (tc < t) { t = tc; edge = 'top'; } }

  return [x + t * dx, y + t * dy, edge];
}

/**
 * Build a list of (x1,y1)→(x2,y2) segments for a beam that bounces n times.
 */
function buildPath(
  srcX: number, srcY: number, angle: number, w: number, h: number, bounces: number
): Array<[number, number, number, number]> {
  const segments: Array<[number, number, number, number]> = [];
  let cx = srcX, cy = srcY, ca = angle;
  for (let b = 0; b <= bounces; b++) {
    const [ex, ey, edge] = traceToEdge(cx, cy, ca, w, h);
    segments.push([cx, cy, ex, ey]);
    if (b < bounces) {
      if (edge === 'left' || edge === 'right') ca = Math.PI - ca;
      else ca = -ca;
    }
    cx = ex; cy = ey;
  }
  return segments;
}

/**
 * Draw one beam segment with 6-pass volumetric glow.
 * Assumes HSB colorMode(360,100,100) is already set.
 */
function drawSegment(
  p: P5Instance, x1: number, y1: number, x2: number, y2: number,
  hue: number, brightness: number
): void {
  const b = Math.min(brightness, 1.0);
  // Passes: [strokeWeight, alpha%, saturation%]
  const passes: [number, number, number][] = [
    [60,  2 * b,  70],  // very wide outer haze
    [30,  5 * b,  80],  // wide soft glow
    [14,  14 * b, 87],  // mid glow
    [6,   35 * b, 92],  // bright body
    [2,   75 * b, 97],  // core
    [0.7, 100,    10],  // white-hot center
  ];
  for (const [sw, alpha, sat] of passes) {
    (p as any).stroke(hue, sat, 100, alpha);
    p.strokeWeight(sw);
    p.line(x1, y1, x2, y2);
  }
  // Bright dot at start point to simulate scanner aperture
  (p as any).fill(hue, 20, 100, Math.min(80 * b, 100));
  p.noStroke();
  p.ellipse(x1, y1, 6 + b * 4, 6 + b * 4);
  p.noFill();
}

// ── Laser color palettes ──────────────────────────────────────────────────────

const PALETTES: Array<() => number[]> = [
  () => [120, 120, 120],                       // neon green mono
  () => [0, 0, 0],                             // red mono
  () => [180, 180, 180],                       // cyan mono
  () => [270, 270, 270],                       // violet mono
  () => [0, 120, 0, 120],                      // red + green
  () => [180, 0, 180, 0],                      // cyan + red alternating
  () => [0, 60, 120, 180, 240, 300],           // rainbow
  () => [120, 60, 0, 300, 240, 180],           // reverse rainbow
  () => [90, 90, 150, 150, 210, 210],          // green + blue pairs
];

function pickHues(count: number): number[] {
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)]();
  const hues: number[] = [];
  for (let i = 0; i < count; i++) {
    hues.push((palette[i % palette.length] + rand(-8, 8) + 360) % 360);
  }
  return hues;
}

// ── Pattern generators ────────────────────────────────────────────────────────

function makeCenterFan(w: number, h: number): Beam[] {
  const count = randInt(isMobile ? 4 : 6, isMobile ? 8 : 14);
  const spread = rand(Math.PI * 0.3, Math.PI * 0.8);
  const hues = pickHues(count);
  return Array.from({ length: count }, (_, i) => ({
    srcX: w * 0.5,
    srcY: h + 2,
    angle: -Math.PI / 2 - spread / 2 + (i / (count - 1)) * spread,
    sweepAmp: rand(0.02, 0.08),
    sweepSpeed: rand(0.4, 1.4),
    sweepPhase: rand(0, Math.PI * 2),
    hue: hues[i],
    bandIndex: i % BAND_COUNT,
    bounces: randInt(0, 2),
  }));
}

function makeDJBooth(w: number, h: number): Beam[] {
  const perSide = randInt(isMobile ? 3 : 5, isMobile ? 5 : 9);
  const spread = rand(Math.PI * 0.5, Math.PI * 0.9);
  const hues = pickHues(perSide * 2);
  const beams: Beam[] = [];
  for (const [sx, baseAngle] of [[w * 0.08, -Math.PI * 0.1], [w * 0.92, -Math.PI * 0.9]] as [number, number][]) {
    for (let i = 0; i < perSide; i++) {
      beams.push({
        srcX: sx,
        srcY: h * rand(0.7, 0.95),
        angle: baseAngle - (i / (perSide - 1)) * spread + spread / 2,
        sweepAmp: rand(0.03, 0.1),
        sweepSpeed: rand(0.5, 1.8),
        sweepPhase: rand(0, Math.PI * 2),
        hue: hues[beams.length],
        bandIndex: beams.length % BAND_COUNT,
        bounces: randInt(0, 1),
      });
    }
  }
  return beams;
}

function makeRadialBurst(w: number, h: number): Beam[] {
  const count = isMobile ? randInt(6, 10) : randInt(10, 18);
  const hues = pickHues(count);
  const cx = rand(w * 0.3, w * 0.7);
  const cy = rand(h * 0.2, h * 0.5);
  return Array.from({ length: count }, (_, i) => ({
    srcX: cx,
    srcY: cy,
    angle: (i / count) * Math.PI * 2,
    sweepAmp: rand(0.01, 0.06),
    sweepSpeed: rand(0.2, 0.8),
    sweepPhase: (i / count) * Math.PI * 2,
    hue: hues[i],
    bandIndex: i % BAND_COUNT,
    bounces: randInt(0, 3),
  }));
}

function makeIris(w: number, h: number): Beam[] {
  // Beams from all four edges converging toward center
  const perEdge = isMobile ? 3 : randInt(4, 7);
  const hues = pickHues(perEdge * 4);
  const beams: Beam[] = [];
  const cx = w / 2, cy = h / 2;
  const edges: Array<() => [number, number]> = [
    () => [rand(w * 0.1, w * 0.9), -5],
    () => [rand(w * 0.1, w * 0.9), h + 5],
    () => [-5, rand(h * 0.1, h * 0.9)],
    () => [w + 5, rand(h * 0.1, h * 0.9)],
  ];
  for (const edgeFn of edges) {
    for (let i = 0; i < perEdge; i++) {
      const [sx, sy] = edgeFn();
      const baseAngle = Math.atan2(cy - sy, cx - sx);
      beams.push({
        srcX: sx, srcY: sy,
        angle: baseAngle,
        sweepAmp: rand(0.04, 0.15),
        sweepSpeed: rand(0.3, 1.0),
        sweepPhase: rand(0, Math.PI * 2),
        hue: hues[beams.length],
        bandIndex: beams.length % BAND_COUNT,
        bounces: 0,
      });
    }
  }
  return beams;
}

function makeParallelSweep(w: number, h: number): Beam[] {
  const angle = [30, 45, 60, 90, 120, 135, 150][randInt(0, 6)] * Math.PI / 180;
  const count = isMobile ? randInt(3, 6) : randInt(5, 11);
  const spacing = Math.min(w, h) / (count + 1);
  const perpAngle = angle + Math.PI / 2;
  const hues = pickHues(count);
  return Array.from({ length: count }, (_, i) => {
    const t = (i - (count - 1) / 2) * spacing;
    return {
      srcX: w / 2 + Math.cos(perpAngle) * t,
      srcY: h / 2 + Math.sin(perpAngle) * t,
      angle,
      sweepAmp: rand(0.05, 0.2),
      sweepSpeed: rand(0.3, 1.2),
      sweepPhase: (i / count) * Math.PI * 2,
      hue: hues[i],
      bandIndex: i % BAND_COUNT,
      bounces: randInt(0, 2),
    };
  });
}

function makeDiagonalX(w: number, h: number): Beam[] {
  const count = isMobile ? randInt(2, 4) : randInt(3, 6);
  const spacing = Math.min(w, h) / (count + 1);
  const hues = pickHues(count * 2);
  const beams: Beam[] = [];
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const perp = angle + Math.PI / 2;
    for (let i = 0; i < count; i++) {
      const t = (i - (count - 1) / 2) * spacing;
      beams.push({
        srcX: w / 2 + Math.cos(perp) * t,
        srcY: h / 2 + Math.sin(perp) * t,
        angle,
        sweepAmp: rand(0.02, 0.08),
        sweepSpeed: rand(0.4, 1.0),
        sweepPhase: rand(0, Math.PI * 2),
        hue: hues[beams.length],
        bandIndex: beams.length % BAND_COUNT,
        bounces: randInt(0, 2),
      });
    }
  }
  return beams;
}

function makeCornerSweep(w: number, h: number): Beam[] {
  const fanSize = isMobile ? randInt(3, 5) : randInt(5, 9);
  const hues = pickHues(fanSize * 2);
  const beams: Beam[] = [];
  for (const [cx, cy] of [[0, h], [w, h]] as [number, number][]) {
    for (let i = 0; i < fanSize; i++) {
      const t = i / (fanSize - 1);
      const angle = -Math.PI + t * Math.PI;
      beams.push({
        srcX: cx, srcY: cy,
        angle,
        sweepAmp: rand(0.03, 0.1),
        sweepSpeed: rand(0.5, 1.5),
        sweepPhase: rand(0, Math.PI * 2),
        hue: hues[beams.length],
        bandIndex: beams.length % BAND_COUNT,
        bounces: randInt(0, 1),
      });
    }
  }
  return beams;
}

function makeSpiral(w: number, h: number): Beam[] {
  // Fan from center bottom that slowly rotates as a unit — simulate with offset phases
  const count = isMobile ? randInt(5, 8) : randInt(8, 16);
  const spread = rand(Math.PI * 0.6, Math.PI * 1.2);
  const hues = pickHues(count);
  return Array.from({ length: count }, (_, i) => ({
    srcX: w / 2 + rand(-20, 20),
    srcY: h * 0.92,
    angle: -Math.PI / 2 - spread / 2 + (i / (count - 1)) * spread,
    sweepAmp: rand(0.15, 0.35),
    sweepSpeed: 0.6,
    sweepPhase: (i / count) * Math.PI * 2,  // staggered — creates rotational feel
    hue: hues[i],
    bandIndex: i % BAND_COUNT,
    bounces: randInt(0, 2),
  }));
}

function makeGateScanner(_w: number, h: number): Beam[] {
  // Horizontal scanlines sweeping downward — like a security/concert scanner
  const count = isMobile ? randInt(3, 5) : randInt(5, 9);
  const hues = pickHues(count);
  return Array.from({ length: count }, (_, i) => ({
    srcX: 0,
    srcY: h * (0.1 + (i / (count - 1)) * 0.8),
    angle: 0,
    sweepAmp: rand(0.1, 0.4),
    sweepSpeed: rand(0.4, 1.2),
    sweepPhase: (i / count) * Math.PI * 2,
    hue: hues[i],
    bandIndex: i % BAND_COUNT,
    bounces: randInt(1, 3),
  }));
}

function makePyramid(w: number, h: number): Beam[] {
  // Classic concert pyramid: beams from bottom that form a triangle shape
  const count = isMobile ? randInt(4, 7) : randInt(6, 12);
  const hues = pickHues(count);
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return {
      srcX: w * (0.1 + t * 0.8),
      srcY: h,
      angle: Math.atan2(-(h * 0.15), w * 0.5 - w * (0.1 + t * 0.8)) + rand(-0.05, 0.05),
      sweepAmp: rand(0.04, 0.14),
      sweepSpeed: rand(0.4, 1.4),
      sweepPhase: rand(0, Math.PI * 2),
      hue: hues[i],
      bandIndex: i % BAND_COUNT,
      bounces: randInt(0, 2),
    };
  });
}

const PATTERNS = [
  makeCenterFan, makeDJBooth, makeRadialBurst, makeIris,
  makeParallelSweep, makeDiagonalX, makeCornerSweep,
  makeSpiral, makeGateScanner, makePyramid,
];

function generatePattern(w: number, h: number): Beam[] {
  const idx = patternIndex % PATTERNS.length;
  patternIndex++;
  return PATTERNS[idx](w, h);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetLasers(): void {
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
  beatFlash = 0;
  sweepT = 0;
  beams = [];
  patternIndex = 0;
}

export function drawLasers(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const w = p.width;
  const h = p.height;

  // ── Background: dark smoke/haze layer ─────────────────────────────────────
  (p as any).colorMode(p['RGB'], 255);
  // Slightly colored haze tint based on current beams (if any)
  const hazeAlpha = 160;
  (p as any).fill(0, 0, 4, hazeAlpha);
  p.noStroke();
  p.rect(0, 0, w, h);

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      beatFlash = 1.0;
      lastBeatIndex = beatIdx;
      const groupSize = Math.pow(2, config.beatDivision - 1);
      const group = Math.floor(beatIdx / groupSize);
      if (group !== lastBeatGroupIndex) {
        beams = generatePattern(w, h);
        lastBeatGroupIndex = group;
      }
    }
  }

  if (beams.length === 0) beams = generatePattern(w, h);

  // ── Advance time ───────────────────────────────────────────────────────────
  sweepT += dt * 0.016667;
  beatFlash *= Math.pow(0.75, dt);

  // Beat strobe: white flash
  if (beatFlash > 0.05) {
    (p as any).fill(255, 255, 255, beatFlash * 35);
    p.noStroke();
    p.rect(0, 0, w, h);
  }

  // ── Draw beams ─────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100);
  p.noFill();

  // Overall energy for brightness
  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  for (const beam of beams) {
    // Each beam's sweep driven by its assigned band
    const bandAmp = amps[beam.bandIndex] ?? energy;
    const sweepDrive = 0.3 + bandAmp * 1.4;
    const swept = beam.angle +
      beam.sweepAmp * Math.sin(sweepT * beam.sweepSpeed * sweepDrive + beam.sweepPhase);

    const segments = buildPath(beam.srcX, beam.srcY, swept, w, h, beam.bounces);
    const brightness = Math.max(0.05, energy * config.intensity) * (1 + beatFlash * 0.8);

    for (const [x1, y1, x2, y2] of segments) {
      drawSegment(p, x1, y1, x2, y2, beam.hue, brightness);
    }
  }

  (p as any).colorMode(p['RGB'], 255);
}
