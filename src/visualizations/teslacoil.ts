/**
 * Tesla Coil visualization — science museum tesla coil with fractal lightning
 *
 * A central electrode fires branching lightning arcs that dance to the music.
 * 7 primary arcs map to frequency bands; beats trigger massive discharge events.
 * Fractal midpoint displacement creates realistic lightning with 3-pass glow.
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Types ───────────────────────────────────────────────────────────────────

interface LightningSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  brightness: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const RECURSION_DEPTH = 5; // 2^5 = 32 segments per arc
const FLICKER_FRAMES = 3;
const MAX_SPARKS = isMobile ? 30 : 60;
const BEAT_DURATION_MS = 200;
const ARC_ANGLES = [-90, -75, -60, -105, -45, -120, -30]; // degrees, fan upward
const ARC_HUES = [190, 200, 210, 220, 240, 260, 280]; // cyan → blue → violet

// ── Module state ────────────────────────────────────────────────────────────

let initialized = false;
let canvasW = 0;
let canvasH = 0;
let frameCount = 0;
let lastBeatIndex = -1;
let beatFlash = 0; // decays from 1 to 0 over ~200ms
let beatDischarge = false;

// Cached lightning paths per arc (re-randomized every FLICKER_FRAMES)
let arcPaths: LightningSegment[][] = [];
let branchPaths: LightningSegment[][][] = []; // [arcIndex][branchIndex][]

let sparks: Spark[] = [];

// ── Public API ──────────────────────────────────────────────────────────────

export function drawTeslaCoil(p: P5Instance, dt: number): void {
  if (!initialized || canvasW !== p.width || canvasH !== p.height) {
    canvasW = p.width;
    canvasH = p.height;
    if (!initialized) {
      arcPaths = [];
      branchPaths = [];
      sparks = [];
      lastBeatIndex = -1;
      beatFlash = 0;
      beatDischarge = false;
      frameCount = 0;
    }
    initialized = true;
  }

  const voltage = store.config.teslaVoltage;
  const branching = store.config.teslaBranching;

  const { amps } = getBandAverages(BAND_COUNT);

  // Electrode position: bottom center
  const electrodeX = canvasW / 2;
  const electrodeY = canvasH * 0.85;
  const toroidRadius = Math.min(canvasW, canvasH) * 0.06;
  const coilHeight = toroidRadius * 2.5;

  // Beat detection
  detectBeat();

  // Decay beat flash
  beatFlash = Math.max(0, beatFlash - (dt * 16.667) / BEAT_DURATION_MS);
  if (beatFlash <= 0) beatDischarge = false;

  // Re-randomize lightning paths every FLICKER_FRAMES
  frameCount++;
  if (frameCount % FLICKER_FRAMES === 0 || arcPaths.length === 0) {
    regenerateArcs(electrodeX, electrodeY - toroidRadius, amps, voltage, branching);
  }

  // ── Background ──────────────────────────────────────────────────────────
  p.background('#05050f');

  // ── Draw electrode (RGB mode) ───────────────────────────────────────────
  drawElectrode(p, electrodeX, electrodeY, toroidRadius, coilHeight);

  // ── Switch to HSB for arcs ──────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);

  // ── Draw arcs ───────────────────────────────────────────────────────────
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  for (let i = 0; i < Math.min(arcPaths.length, 7); i++) {
    const amp = i < amps.length ? amps[i] : 0;
    const effectiveAmp = beatDischarge ? Math.max(amp, 0.9) : amp;
    if (effectiveAmp < 0.05) continue;

    const hue = ARC_HUES[i];
    const alpha = Math.min(255, effectiveAmp * 255 * 1.5);

    // 3-pass glow rendering
    const passes = [
      { width: 8, sat: 20, bri: 60, aMult: 0.25 },  // outer glow
      { width: 3, sat: 40, bri: 80, aMult: 0.6 },    // body
      { width: 1, sat: 10, bri: 100, aMult: 1.0 },   // white-hot core
    ];

    // Shadow glow
    ctx.save();
    ctx.shadowColor = `hsla(${hue}, 80%, 60%, ${effectiveAmp * 0.6})`;
    ctx.shadowBlur = 15 + effectiveAmp * 25;

    for (const pass of passes) {
      (p as any).stroke(hue, pass.sat, pass.bri, alpha * pass.aMult);
      p.strokeWeight(pass.width * (0.5 + effectiveAmp * 0.5));
      p.noFill();

      // Main arc
      const segments = arcPaths[i];
      if (segments) {
        for (const seg of segments) {
          p.line(seg.x1, seg.y1, seg.x2, seg.y2);
        }
      }

      // Branches
      if (branchPaths[i]) {
        for (const branch of branchPaths[i]) {
          p.strokeWeight(pass.width * 0.5 * (0.3 + effectiveAmp * 0.5));
          for (const seg of branch) {
            p.line(seg.x1, seg.y1, seg.x2, seg.y2);
          }
        }
      }
    }

    ctx.restore();
  }

  // ── Sparks ──────────────────────────────────────────────────────────────
  updateAndDrawSparks(p, dt, electrodeX, electrodeY - toroidRadius);

  // ── Beat screen flash ───────────────────────────────────────────────────
  if (beatFlash > 0) {
    p.noStroke();
    (p as any).fill(220, 20, 100, beatFlash * 40);
    p.rect(0, 0, canvasW, canvasH);
  }

  // Toroid glow on beat
  if (beatFlash > 0) {
    p.noStroke();
    (p as any).fill(220, 30, 100, beatFlash * 120);
    p.ellipse(electrodeX, electrodeY - toroidRadius, toroidRadius * 3, toroidRadius * 1.5);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetTeslaCoil(): void {
  arcPaths = [];
  branchPaths = [];
  sparks = [];
  lastBeatIndex = -1;
  initialized = false;
  beatFlash = 0;
  beatDischarge = false;
  frameCount = 0;
}

// ── Lightning generation ────────────────────────────────────────────────────

function regenerateArcs(
  originX: number,
  originY: number,
  amps: number[],
  voltage: number,
  branching: number,
): void {
  arcPaths = [];
  branchPaths = [];

  const maxReach = Math.min(canvasW, canvasH) * 0.4 * voltage;

  for (let i = 0; i < 7; i++) {
    const amp = i < amps.length ? amps[i] : 0;
    const effectiveAmp = beatDischarge ? Math.max(amp, 0.9) : amp;
    const reach = maxReach * (0.3 + effectiveAmp * 0.7);

    const angleDeg = ARC_ANGLES[i];
    const angleRad = (angleDeg * Math.PI) / 180;
    const targetX = originX + Math.cos(angleRad) * reach;
    const targetY = originY + Math.sin(angleRad) * reach;

    // Generate main arc via midpoint displacement
    const displacement = reach * 0.15;
    const segments = midpointDisplacement(originX, originY, targetX, targetY, RECURSION_DEPTH, displacement);
    arcPaths.push(segments);

    // Generate sub-branches
    const branchCount = Math.floor((2 + effectiveAmp * 3) * branching);
    const branches: LightningSegment[][] = [];

    for (let b = 0; b < branchCount && segments.length > 2; b++) {
      // Pick a random point along the arc to branch from
      const segIdx = Math.floor(Math.random() * segments.length);
      const seg = segments[segIdx];
      const branchLen = reach * (0.1 + Math.random() * 0.2);

      // Branch angle: perpendicular-ish with some randomness
      const mainAngle = Math.atan2(seg.y2 - seg.y1, seg.x2 - seg.x1);
      const branchAngle = mainAngle + (Math.random() - 0.5) * Math.PI * 0.8;

      const bx = seg.x1 + Math.cos(branchAngle) * branchLen;
      const by = seg.y1 + Math.sin(branchAngle) * branchLen;

      branches.push(midpointDisplacement(seg.x1, seg.y1, bx, by, 3, branchLen * 0.15));
    }

    branchPaths.push(branches);
  }
}

function midpointDisplacement(
  x1: number, y1: number,
  x2: number, y2: number,
  depth: number,
  displacement: number,
): LightningSegment[] {
  if (depth <= 0) {
    return [{ x1, y1, x2, y2 }];
  }

  // Midpoint
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Perpendicular displacement
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return [{ x1, y1, x2, y2 }];

  const nx = -dy / len;
  const ny = dx / len;
  const offset = (Math.random() - 0.5) * displacement;

  const newX = mx + nx * offset;
  const newY = my + ny * offset;

  const left = midpointDisplacement(x1, y1, newX, newY, depth - 1, displacement * 0.5);
  const right = midpointDisplacement(newX, newY, x2, y2, depth - 1, displacement * 0.5);

  return left.concat(right);
}

// ── Beat detection ──────────────────────────────────────────────────────────

function detectBeat(): void {
  const { state } = store;
  if (state.beatIntervalSec <= 0) return;

  const playbackPos = state.isPlaying
    ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
    : state.startOffset;
  const beatIndex = Math.floor((playbackPos - state.beatOffset) / state.beatIntervalSec);

  if (beatIndex > lastBeatIndex && lastBeatIndex >= 0) {
    beatFlash = 1.0;
    beatDischarge = true;

    // Spawn extra sparks on beat
    for (let i = 0; i < 8; i++) {
      spawnSpark(canvasW / 2, canvasH * 0.85 - Math.min(canvasW, canvasH) * 0.06);
    }
  }
  lastBeatIndex = beatIndex;
}

// ── Electrode rendering ─────────────────────────────────────────────────────

function drawElectrode(p: P5Instance, x: number, y: number, toroidR: number, coilH: number): void {
  // Coil body (stack of rings)
  const coilW = toroidR * 0.7;
  const rings = 12;
  for (let i = 0; i < rings; i++) {
    const frac = i / rings;
    const ry = y + frac * coilH;
    const bright = 80 + Math.sin(frac * Math.PI) * 50;
    p.stroke(bright, bright * 0.7, bright * 0.5);
    p.strokeWeight(2);
    p.noFill();
    p.ellipse(x, ry, coilW * 2, coilW * 0.4);
  }

  // Toroid (metallic donut on top)
  const gradient = 6;
  for (let i = gradient; i >= 0; i--) {
    const frac = i / gradient;
    const bright = 120 + (1 - frac) * 100;
    p.fill(bright, bright * 0.85, bright * 0.7, 200);
    p.noStroke();
    p.ellipse(x, y - toroidR, toroidR * 2 * (1 + frac * 0.15), toroidR * 0.8 * (1 + frac * 0.15));
  }

  // Bright highlight on toroid
  p.fill(255, 255, 240, 60);
  p.noStroke();
  p.ellipse(x - toroidR * 0.3, y - toroidR - toroidR * 0.1, toroidR * 0.6, toroidR * 0.25);
}

// ── Sparks ──────────────────────────────────────────────────────────────────

function spawnSpark(x: number, y: number): void {
  if (sparks.length >= MAX_SPARKS) return;

  const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
  const speed = 1 + Math.random() * 3;
  const life = 30 + Math.random() * 40;

  sparks.push({
    x: x + (Math.random() - 0.5) * 20,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life,
    maxLife: life,
    brightness: 70 + Math.random() * 30,
  });
}

function updateAndDrawSparks(p: P5Instance, dt: number, originX: number, originY: number): void {
  // Spawn a few background sparks each frame
  if (sparks.length < MAX_SPARKS && Math.random() < 0.3 * dt) {
    spawnSpark(originX, originY);
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy -= 0.05 * dt; // slight upward drift
    s.life -= dt;

    if (s.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }

    const lifeFrac = s.life / s.maxLife;
    const alpha = lifeFrac * 200;
    const size = 1 + lifeFrac * 2;

    // Spark glow
    (p as any).fill(210, 30, s.brightness, alpha * 0.5);
    p.noStroke();
    p.ellipse(s.x, s.y, size * 3, size * 3);

    // Spark core
    (p as any).fill(220, 10, 100, alpha);
    p.ellipse(s.x, s.y, size, size);
  }
}
