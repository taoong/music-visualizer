/**
 * Marathon Runners visualization — side-scrolling infinite marathon of stick-figure runners
 *
 * Multiple runners at 3 depth layers scroll left-to-right continuously.
 * On each detected beat: instant 7× speed burst for 180 ms, then instant snap back.
 * No attack, no release — pure square-wave time burst.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { isMobile } from '../utils/constants';
import { getBandAverages } from './helpers';

// ── Types ──────────────────────────────────────────────────────────────────

interface Runner {
  x: number;
  y: number;
  speed: number;
  runPhase: number;
  runRate: number;
  scale: number;
  hue: number;
  layer: number;
  alpha: number;
  band: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const BEAT_BURST_MS = 180;
const FORWARD_LEAN    = 0.18;   // radians
const THIGH_SWING     = 0.80;
const SHIN_FACTOR     = 0.35;
const ARM_SWING       = 0.55;

// Layer config: [count_desktop, count_mobile, scaleMin, scaleMax, speedMin, speedMax, alpha, yMin_ratio, yMax_ratio]
const LAYER_CONFIG = [
  { countFull: 4, countMobile: 2, scaleMin: 4,  scaleMax: 6,  speedMin: 0.6, speedMax: 1.0, alpha: 50,  yMin: 0.38, yMax: 0.52 }, // far
  { countFull: 4, countMobile: 2, scaleMin: 8,  scaleMax: 12, speedMin: 1.4, speedMax: 2.0, alpha: 70,  yMin: 0.56, yMax: 0.68 }, // mid
  { countFull: 3, countMobile: 2, scaleMin: 14, scaleMax: 20, speedMin: 2.2, speedMax: 3.2, alpha: 95,  yMin: 0.72, yMax: 0.83 }, // near
] as const;

const BAND_HUES = [200, 270, 130, 30, 300, 160, 50] as const;

// ── Module state ───────────────────────────────────────────────────────────

let runners: Runner[] = [];
let speedMult = 1.0;
let burstTimer = 0;          // ms remaining in burst
let lastBeatIndex = -1;
let lastBeatGroupIndex = -1;
let initialized = false;

// ── Initialization ─────────────────────────────────────────────────────────

function initRunners(p: P5Instance): void {
  runners = [];

  for (let layer = 0; layer < LAYER_CONFIG.length; layer++) {
    const cfg = LAYER_CONFIG[layer];
    const count = isMobile ? cfg.countMobile : cfg.countFull;

    for (let i = 0; i < count; i++) {
      const scale = cfg.scaleMin + Math.random() * (cfg.scaleMax - cfg.scaleMin);
      const speed = cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);
      const band = Math.floor(Math.random() * 7);

      runners.push({
        x: Math.random() * p.width,
        y: (cfg.yMin + Math.random() * (cfg.yMax - cfg.yMin)) * p.height,
        speed,
        runPhase: Math.random() * Math.PI * 2,
        runRate: 0.08 + Math.random() * 0.04,
        scale,
        hue: BAND_HUES[band],
        layer,
        alpha: cfg.alpha,
        band,
      });
    }
  }

  speedMult = 1.0;
  burstTimer = 0;
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
  initialized = true;
}

// ── Drawing ────────────────────────────────────────────────────────────────

function drawOneRunner(
  p: P5Instance,
  runner: Runner,
  avgAmp: number,
  isBursting: boolean
): void {
  const { scale, runPhase, alpha, hue } = runner;

  const torsoLen  = scale * 3.0;
  const headR     = scale * 2.0;
  const thighLen  = scale * 2.8;
  const shinLen   = scale * 2.4;
  const armLen    = scale * 2.2;

  const headY     = -(torsoLen + scale * 1.0);
  const shoulderY = -torsoLen;

  // Left leg angles (thigh swings, shin follows at 35%)
  const lThighAngle = Math.sin(runPhase) * THIGH_SWING;
  const lShinAngle  = lThighAngle * SHIN_FACTOR;

  // Right leg: opposite phase
  const rThighAngle = Math.sin(runPhase + Math.PI) * THIGH_SWING;
  const rShinAngle  = rThighAngle * SHIN_FACTOR;

  // Arms opposite to legs
  const lArmAngle = Math.sin(runPhase + Math.PI) * ARM_SWING;
  const rArmAngle = Math.sin(runPhase) * ARM_SWING;

  // Brightness modulated by amplitude
  const brightness = Math.min(100, 70 + avgAmp * 30);

  p.push();
  p.translate(runner.x, runner.y);
  p.rotate(-FORWARD_LEAN);

  // Motion streak during burst
  if (isBursting) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(hue, 60, 90, 15);
    p.noStroke();
    p.rect(-scale * 18, shoulderY * 1.5, scale * 18, torsoLen * 2);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(hue, 70, brightness, alpha);
  p.strokeWeight(Math.max(1, scale * 0.35));
  p.noFill();

  // Head
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).fill(hue, 60, brightness, alpha);
  p.noStroke();
  p.ellipse(0, headY, headR, headR);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).stroke(hue, 70, brightness, alpha);
  p.noFill();

  // Torso
  p.line(0, 0, 0, shoulderY);

  // Left arm
  p.push();
  p.translate(0, shoulderY);
  p.rotate(lArmAngle);
  p.line(0, 0, 0, armLen);
  p.pop();

  // Right arm
  p.push();
  p.translate(0, shoulderY);
  p.rotate(rArmAngle);
  p.line(0, 0, 0, armLen);
  p.pop();

  // Left leg (thigh + shin)
  p.push();
  p.rotate(lThighAngle);
  p.line(0, 0, 0, thighLen);
  p.translate(0, thighLen);
  // relative shin rotation = shinAngle - thighAngle (since we're already rotated)
  p.rotate(lShinAngle - lThighAngle);
  p.line(0, 0, 0, shinLen);
  p.pop();

  // Right leg (thigh + shin)
  p.push();
  p.rotate(rThighAngle);
  p.line(0, 0, 0, thighLen);
  p.translate(0, thighLen);
  p.rotate(rShinAngle - rThighAngle);
  p.line(0, 0, 0, shinLen);
  p.pop();

  p.pop();
}

// ── Main draw ──────────────────────────────────────────────────────────────

export function drawRunners(p: P5Instance, dt: number): void {
  if (!initialized) initRunners(p);

  // HSB + alpha
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Beat detection — instant square wave, no attack/release
  // intensity knob (0–2) scales burst speed: at 0 → 1×, at 1 → 7×, at 2 → 13×
  // beatDivision knob gates which beat groups trigger a burst (same as lasers/text)
  const { state, config } = store;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      const beatsPerBurst = Math.pow(2, config.beatDivision - 1);
      const currentGroup = Math.floor(currentBeatIndex / beatsPerBurst);
      if (currentGroup !== lastBeatGroupIndex) {
        lastBeatGroupIndex = currentGroup;
        speedMult = 1 + config.intensity * 6;
        burstTimer = BEAT_BURST_MS;
      }
    }
  }

  // Countdown burst timer — instant snap back when expired
  if (burstTimer > 0) {
    burstTimer -= p.deltaTime;
    if (burstTimer <= 0) {
      burstTimer = 0;
      speedMult = 1.0;
    }
  }

  const isBursting = burstTimer > 0;

  // Get band averages for brightness reactivity
  const { amps } = getBandAverages(7);

  // Draw back-to-front (layer 0 = far, layer 2 = near)
  for (let layer = 0; layer < 3; layer++) {
    for (const runner of runners) {
      if (runner.layer !== layer) continue;

      // Advance position and run phase
      runner.x += runner.speed * speedMult * dt;
      runner.runPhase += runner.runRate * speedMult * dt;

      // Wrap: when runner exits right edge, re-enter from left with fresh Y and phase
      if (runner.x > p.width + runner.scale * 25) {
        const cfg = LAYER_CONFIG[runner.layer];
        runner.x = -runner.scale * 5;
        runner.y = (cfg.yMin + Math.random() * (cfg.yMax - cfg.yMin)) * p.height;
        runner.runPhase = Math.random() * Math.PI * 2;
      }

      const avgAmp = amps[runner.band] ?? 0;
      drawOneRunner(p, runner, avgAmp, isBursting);
    }
  }

  // Reset color mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────

export function resetRunners(): void {
  initialized = false;
  runners = [];
  speedMult = 1.0;
  burstTimer = 0;
  lastBeatIndex = -1;
  lastBeatGroupIndex = -1;
}
