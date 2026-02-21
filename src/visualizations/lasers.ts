/**
 * Lasers visualization — concert laser light show effect
 * Beams sweep and pulse to music; pattern changes on every detected beat.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';

interface LaserBeam {
  srcX: number;
  srcY: number;
  angle: number;
  hue: number;
  sweepSpeed: number;
  sweepAmp: number;
}

let lastBeatIndex = -1;
let beatFlash = 0;
let sweepT = 0;
let currentBeams: LaserBeam[] = [];

/**
 * Trace beam from (x,y) at given angle until it hits a canvas edge.
 */
function traceToEdge(x: number, y: number, angle: number, w: number, h: number): [number, number] {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let t = Infinity;

  if (dx > 0) t = Math.min(t, (w - x) / dx);
  else if (dx < 0) t = Math.min(t, -x / dx);

  if (dy > 0) t = Math.min(t, (h - y) / dy);
  else if (dy < 0) t = Math.min(t, -y / dy);

  return [x + t * dx, y + t * dy];
}

/**
 * Draw one laser beam with multi-pass glow.
 * Assumes HSB color mode is already set to (360, 100, 100).
 */
function drawBeam(
  p: P5Instance,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  hue: number,
  intensity: number
): void {
  const passes = [
    { weight: 20, alpha: 8 * intensity, sat: 80 },
    { weight: 12, alpha: 20 * intensity, sat: 85 },
    { weight: 5, alpha: 45 * intensity, sat: 90 },
    { weight: 2, alpha: 80 * intensity, sat: 95 },
    { weight: 0.8, alpha: 100 * intensity, sat: 15 },
  ];

  for (const pass of passes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).stroke(hue, pass.sat, 100, pass.alpha);
    p.strokeWeight(pass.weight);
    p.line(x1, y1, x2, y2);
  }
}

// --- Pattern generators ---

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function makeCenterFan(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const pairCount = Math.floor(rand(3, 7)); // 3–6 pairs
  for (let i = 0; i < pairCount; i++) {
    const spread = rand(Math.PI / 12, (5 * Math.PI) / 12); // 15°–75°
    for (const sign of [-1, 1]) {
      beams.push({
        srcX: w / 2,
        srcY: h,
        angle: -Math.PI / 2 + sign * spread * ((i + 1) / pairCount),
        hue: 0,
        sweepSpeed: rand(0.3, 1.2),
        sweepAmp: rand(0.02, 0.12),
      });
    }
  }
  return beams;
}

function makeDualFan(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const pairCount = Math.floor(rand(3, 6)); // 3–5 beams per source
  const sources = [
    { x: 0.2 * w, y: 0.9 * h },
    { x: 0.8 * w, y: 0.9 * h },
  ];
  for (const src of sources) {
    for (let i = 0; i < pairCount; i++) {
      const t = i / (pairCount - 1);
      const angle = -Math.PI + t * Math.PI; // span full upper half
      beams.push({
        srcX: src.x,
        srcY: src.y,
        angle,
        hue: 0,
        sweepSpeed: rand(0.3, 1.2),
        sweepAmp: rand(0.02, 0.12),
      });
    }
  }
  return beams;
}

function makeRadialBurst(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const counts = [8, 10, 12, 16];
  const count = counts[Math.floor(Math.random() * counts.length)];
  for (let i = 0; i < count; i++) {
    beams.push({
      srcX: w / 2,
      srcY: h / 2,
      angle: (i / count) * Math.PI * 2,
      hue: 0,
      sweepSpeed: rand(0.3, 1.2),
      sweepAmp: rand(0.02, 0.12),
    });
  }
  return beams;
}

function makeParallelSlash(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const angles = [30, 45, 60, 120, 135, 150].map(a => (a * Math.PI) / 180);
  const angle = angles[Math.floor(Math.random() * angles.length)];
  const count = Math.floor(rand(4, 9)); // 4–8 lines
  const perpAngle = angle + Math.PI / 2;
  const spacing = Math.min(w, h) / (count + 1);
  for (let i = 0; i < count; i++) {
    const t = (i - (count - 1) / 2) * spacing;
    beams.push({
      srcX: w / 2 + Math.cos(perpAngle) * t,
      srcY: h / 2 + Math.sin(perpAngle) * t,
      angle,
      hue: 0,
      sweepSpeed: rand(0.3, 1.2),
      sweepAmp: rand(0.02, 0.12),
    });
  }
  return beams;
}

function makeEdgeConverge(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const pairCount = Math.floor(rand(3, 6)); // 3–5 pairs
  const vanishX = w / 2;
  const vanishY = h * 0.2;
  for (let i = 0; i < pairCount; i++) {
    const t = (i + 1) / (pairCount + 1);
    for (const sign of [-1, 1]) {
      const srcX = w / 2 + sign * t * w * 0.45;
      const srcY = h;
      const angle = Math.atan2(vanishY - srcY, vanishX - srcX);
      beams.push({
        srcX,
        srcY,
        angle,
        hue: 0,
        sweepSpeed: rand(0.3, 1.2),
        sweepAmp: rand(0.02, 0.12),
      });
    }
  }
  return beams;
}

function makeCornerSweep(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const fanSize = Math.floor(rand(4, 7)); // 4–6 beams per corner
  const corners = [
    { x: 0, y: h },
    { x: w, y: h },
  ];
  for (const corner of corners) {
    for (let i = 0; i < fanSize; i++) {
      const t = i / (fanSize - 1);
      const angle = -Math.PI + t * Math.PI; // sweep upper half
      beams.push({
        srcX: corner.x,
        srcY: corner.y,
        angle,
        hue: 0,
        sweepSpeed: rand(0.3, 1.2),
        sweepAmp: rand(0.02, 0.12),
      });
    }
  }
  return beams;
}

function makeCrossGrid(w: number, h: number): LaserBeam[] {
  const beams: LaserBeam[] = [];
  const count = Math.floor(rand(4, 7)); // lines per direction
  const spacing = Math.min(w, h) / (count + 1);
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const perpAngle = angle + Math.PI / 2;
    for (let i = 0; i < count; i++) {
      const t = (i - (count - 1) / 2) * spacing;
      beams.push({
        srcX: w / 2 + Math.cos(perpAngle) * t,
        srcY: h / 2 + Math.sin(perpAngle) * t,
        angle,
        hue: 0,
        sweepSpeed: rand(0.3, 1.2),
        sweepAmp: rand(0.02, 0.12),
      });
    }
  }
  return beams;
}

/**
 * Assign hues to beams using one of 4 color schemes.
 */
function applyColorScheme(beams: LaserBeam[]): void {
  const scheme = Math.floor(Math.random() * 4);
  const baseHue = rand(0, 360);

  for (let i = 0; i < beams.length; i++) {
    switch (scheme) {
      case 0: // Monochrome
        beams[i].hue = (baseHue + rand(-15, 15) + 360) % 360;
        break;
      case 1: // Complementary
        beams[i].hue = i % 2 === 0 ? baseHue : (baseHue + 180) % 360;
        break;
      case 2: // Analogous — spread over 90°
        beams[i].hue = (baseHue + (i / Math.max(beams.length - 1, 1)) * 90) % 360;
        break;
      case 3: // Rainbow
        beams[i].hue = (i / Math.max(beams.length - 1, 1)) * 360;
        break;
    }
  }
}

/**
 * Generate a new random beam pattern.
 */
function generatePattern(w: number, h: number): LaserBeam[] {
  const makers = [
    makeCenterFan,
    makeDualFan,
    makeRadialBurst,
    makeParallelSlash,
    makeEdgeConverge,
    makeCornerSweep,
    makeCrossGrid,
  ];
  const idx = Math.floor(Math.random() * makers.length);
  const beams = makers[idx](w, h);
  applyColorScheme(beams);
  return beams;
}

export function drawLasers(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;
  const w = p.width;
  const h = p.height;

  // Dark translucent trail
  p.noStroke();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(0, 0, 0, 180);
  p.rect(0, 0, w, h);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100);

  // Audio data (bass band = index 1)
  const bassAmp = audioState.smoothedBands[1]
    ? Array.from(audioState.smoothedBands[1]).reduce((s, v) => s + v, 0) /
      audioState.smoothedBands[1].length
    : 0;
  const transient = audioState.transientValues[1] ?? 1;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      beatFlash = 1.0;
      currentBeams = generatePattern(w, h);
      lastBeatIndex = currentBeatIndex;
    }
  }

  // Generate initial pattern if none exists
  if (currentBeams.length === 0) {
    currentBeams = generatePattern(w, h);
  }

  // Advance animation
  beatFlash *= Math.pow(0.80, dt);
  sweepT += dt * 0.016667;

  // Draw beams
  p.noFill();
  for (const beam of currentBeams) {
    const swept = beam.angle + beam.sweepAmp * Math.sin(sweepT * beam.sweepSpeed);
    const [ex, ey] = traceToEdge(beam.srcX, beam.srcY, swept, w, h);
    const rawIntensity = Math.max(0.1, bassAmp * config.spikeScale) * (1 + beatFlash) * (1 + transient * 0.4);
    const intensity = Math.min(rawIntensity, 1.0);
    drawBeam(p, beam.srcX, beam.srcY, ex, ey, beam.hue, intensity);
  }

  // Reset color mode
  p.colorMode(p['RGB'], 255);
}

export function resetLasers(): void {
  lastBeatIndex = -1;
  beatFlash = 0;
  sweepT = 0;
  currentBeams = [];
}
