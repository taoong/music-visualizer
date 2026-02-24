/**
 * Aurora Borealis visualization — organic luminous curtains of light
 *
 * Layered sine-wave-driven ribbon polygons with multi-pass glow,
 * a starfield background, and a water reflection.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';
import { getBandAverages } from './helpers';

// ── Types ──────────────────────────────────────────────────────────────────

interface Star {
  x: number;
  y: number;
  twinklePhase: number;
  baseBrightness: number;
}

interface RibbonPoint {
  topY: number;
  bottomY: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const NUM_RIBBONS = 7;
const HORIZON_Y_RATIO = 0.58;
const RIBBON_BASE_HUES = [280, 240, 190, 130, 80, 330, 350] as const;
const STAR_COUNT = 150;
const RIBBON_STEP = isMobile ? 16 : 8;
const BEAT_SHIMMER_DECAY = 0.82;

// ── Module state ───────────────────────────────────────────────────────────

let waveTime = 0;
let phaseOffsets: number[] = [];
let ribbonDriftPhases: number[] = [];
let lastBeatIndex = -1;
let beatShimmer = 0;
let stars: Star[] = [];
let initialized = false;

// Fringe seeds: pre-generated, refreshed every 6 frames to avoid per-frame Math.random()
let fringeSeeds: Float32Array[] = [];
let fringeRefreshCounter = 0;

// ── Initialization ─────────────────────────────────────────────────────────

function initAurora(p: P5Instance): void {
  phaseOffsets = Array.from({ length: NUM_RIBBONS }, () => Math.random() * Math.PI * 2);
  ribbonDriftPhases = Array.from({ length: NUM_RIBBONS }, () => Math.random() * Math.PI * 2);

  const horizonY = p.height * HORIZON_Y_RATIO;
  stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * p.width,
      y: Math.random() * horizonY,
      twinklePhase: Math.random() * Math.PI * 2,
      baseBrightness: 60 + Math.random() * 40,
    });
  }

  // Approximate max points per ribbon
  const maxPoints = Math.ceil(p.width / RIBBON_STEP) + 1;
  fringeSeeds = Array.from({ length: NUM_RIBBONS }, () => {
    const arr = new Float32Array(maxPoints);
    for (let j = 0; j < maxPoints; j++) arr[j] = Math.random();
    return arr;
  });

  waveTime = 0;
  lastBeatIndex = -1;
  beatShimmer = 0;
  fringeRefreshCounter = 0;
  initialized = true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildRibbonPoints(
  p: P5Instance,
  baseY: number,
  height: number,
  speed: number,
  phase: number
): RibbonPoint[] {
  const points: RibbonPoint[] = [];
  const w = p.width;
  for (let x = 0; x <= w; x += RIBBON_STEP) {
    const xn = x / w;
    const waveY =
      Math.sin(xn * 4 + waveTime * speed + phase) * height * 0.35 +
      Math.sin(xn * 9 + waveTime * speed * 1.6 + phase * 0.7) * height * 0.15 +
      Math.sin(xn * 17 + waveTime * speed * 0.6 + phase * 1.3) * height * 0.06;
    points.push({
      topY: baseY + waveY - height * 0.5,
      bottomY: baseY + waveY + height * 0.5,
    });
  }
  return points;
}

// ── Main draw ──────────────────────────────────────────────────────────────

export function drawAurora(p: P5Instance, dt: number): void {
  if (!initialized) initAurora(p);

  const { state, config } = store;
  const horizonY = p.height * HORIZON_Y_RATIO;

  // ── 1. Background gradient (via drawingContext to keep HSB unaffected) ──
  const ctx = p.drawingContext;
  ctx.save();

  // Sky gradient: black at top → deep indigo near horizon
  const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
  skyGrad.addColorStop(0, '#000005');
  skyGrad.addColorStop(1, '#0a0620');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, p.width, horizonY);

  // Water gradient: dark teal near horizon → near black at bottom
  const waterGrad = ctx.createLinearGradient(0, horizonY, 0, p.height);
  waterGrad.addColorStop(0, '#050d15');
  waterGrad.addColorStop(1, '#020608');
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0, horizonY, p.width, p.height - horizonY);

  // Horizon accent line
  ctx.strokeStyle = 'rgba(80, 200, 220, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(p.width, horizonY);
  ctx.stroke();

  ctx.restore();

  // ── 2. Switch to HSB + alpha ──────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── 3. Get audio data ─────────────────────────────────────────────────
  const { amps, transients, deltas } = getBandAverages(NUM_RIBBONS);

  // Idle floor — keep ribbons softly pulsing even without audio
  for (let i = 0; i < NUM_RIBBONS; i++) {
    if (!state.isPlaying) {
      amps[i] = Math.max(0.05, amps[i]);
    }
  }

  // High-freq boost for stars
  const highFreqBoost = (amps[5] + amps[6]) * 0.5;

  // ── 4. Stars ──────────────────────────────────────────────────────────
  p.noStroke();
  for (const star of stars) {
    const twinkle = Math.sin(waveTime * 2 + star.twinklePhase) * 20 + highFreqBoost * 30;
    const brightness = Math.min(100, star.baseBrightness + twinkle);
    const alpha = Math.min(100, 60 + twinkle * 0.5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(220, 10, brightness, alpha);
    p.ellipse(star.x, star.y, 1.5, 1.5);
  }

  // ── 5. Beat detection ─────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      beatShimmer = 1.0;
      lastBeatIndex = currentBeatIndex;
    }
  }

  // ── 6. Decay & time ───────────────────────────────────────────────────
  beatShimmer *= Math.pow(BEAT_SHIMMER_DECAY, dt);
  waveTime += 0.016 * dt;

  // Refresh fringe seeds periodically
  fringeRefreshCounter++;
  if (fringeRefreshCounter >= 6) {
    fringeRefreshCounter = 0;
    const maxPoints = Math.ceil(p.width / RIBBON_STEP) + 1;
    for (let i = 0; i < NUM_RIBBONS; i++) {
      for (let j = 0; j < maxPoints; j++) {
        fringeSeeds[i][j] = Math.random();
      }
    }
  }

  // ── 7. Draw ribbons back-to-front ────────────────────────────────────
  for (let i = NUM_RIBBONS - 1; i >= 0; i--) {
    const hue = RIBBON_BASE_HUES[i];
    const ribbonHeight =
      (30 + amps[i] * config.spikeScale * 180 * transients[i]) * (1 + beatShimmer * 0.4);
    const waveSpeed = 0.4 + deltas[i] * 1.2;
    const baseY =
      (i + 1) * (horizonY / (NUM_RIBBONS + 1)) +
      Math.sin(waveTime * 0.3 + ribbonDriftPhases[i]) * 30;

    const pts = buildRibbonPoints(p, baseY, ribbonHeight, waveSpeed, phaseOffsets[i]);
    const n = pts.length;

    if (n < 2) continue;

    // ── Glow passes (3): thick→thin, low→high alpha ──────────────────
    const glowWeights = [14, 9, 4];
    const glowAlphas = [18, 46, 74];

    for (let g = 0; g < 3; g++) {
      p.noFill();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).stroke(hue, 80, 95, glowAlphas[g]);
      p.strokeWeight(glowWeights[g]);
      p.beginShape();
      // Ghost bookend (Catmull-Rom first control point)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).curveVertex(pts[0].topY > 0 ? 0 : 0, pts[0].topY);
      for (let j = 0; j < n; j++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).curveVertex(j * RIBBON_STEP, pts[j].topY);
      }
      // Ghost bookend (last control point)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).curveVertex((n - 1) * RIBBON_STEP, pts[n - 1].topY);
      p.endShape();
    }

    // ── Fill polygon ─────────────────────────────────────────────────
    p.noStroke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(hue, 70, 80, 18);
    p.beginShape();
    // Top edge left → right
    for (let j = 0; j < n; j++) {
      p.vertex(j * RIBBON_STEP, pts[j].topY);
    }
    // Bottom edge right → left
    for (let j = n - 1; j >= 0; j--) {
      p.vertex(j * RIBBON_STEP, pts[j].bottomY);
    }
    p.endShape(p['CLOSE']);

    // ── Curtain fringe ───────────────────────────────────────────────
    const amp = amps[i];
    for (let j = 0; j < n; j += 5) {
      if (fringeSeeds[i][j] < amp * 0.8) {
        const fringeLen = (fringeSeeds[i][j] / (amp * 0.8)) * ribbonHeight * 0.4;
        const fx = j * RIBBON_STEP;
        const fy = pts[j].bottomY;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).stroke(hue, 60, 90, 40);
        p.strokeWeight(1);
        p.line(fx, fy, fx, fy + fringeLen);
      }
    }

    // ── Reflection (skip on mobile) ──────────────────────────────────
    if (!isMobile) {
      // Map sky ribbon symmetrically around horizonY
      p.noStroke();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).fill(hue, 70, 60, 12);
      p.beginShape();
      for (let j = 0; j < n; j++) {
        const reflTop = horizonY + (horizonY - pts[j].topY);
        p.vertex(j * RIBBON_STEP, reflTop);
      }
      for (let j = n - 1; j >= 0; j--) {
        const reflBottom = horizonY + (horizonY - pts[j].bottomY);
        p.vertex(j * RIBBON_STEP, reflBottom);
      }
      p.endShape(p['CLOSE']);

      // One thin glow pass on reflection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).stroke(hue, 70, 80, 14);
      p.strokeWeight(3);
      p.noFill();
      p.beginShape();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).curveVertex(0, horizonY + (horizonY - pts[0].topY));
      for (let j = 0; j < n; j++) {
        const reflTop = horizonY + (horizonY - pts[j].topY);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p as any).curveVertex(j * RIBBON_STEP, reflTop);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p as any).curveVertex((n - 1) * RIBBON_STEP, horizonY + (horizonY - pts[n - 1].topY));
      p.endShape();
    }
  }

  // ── 8. Reset color mode ───────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────

export function resetAurora(): void {
  initialized = false;
  waveTime = 0;
  lastBeatIndex = -1;
  beatShimmer = 0;
  stars = [];
  phaseOffsets = [];
  ribbonDriftPhases = [];
  fringeSeeds = [];
  fringeRefreshCounter = 0;
}
