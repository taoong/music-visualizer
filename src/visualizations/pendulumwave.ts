/**
 * Pendulum Wave — Science museum exhibit simulation.
 *
 * A row of pendulums with incrementally different lengths create mesmerizing
 * wave patterns as they drift in and out of phase. Beats inject energy;
 * frequency bands modulate groups of pendulums.
 *
 * Sliders: Gravity (swing speed), Spread (period difference between adjacent pendulums).
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────
const PENDULUM_COUNT = 24;
const BOB_RADIUS = 12;
const MAX_ANGLE = Math.PI / 3; // 60° max swing

// ── Color palette — warm science-museum glow ────────────────────────────────
function pendulumColor(index: number, total: number): [number, number, number] {
  const t = index / (total - 1);
  // Cyan → Gold gradient
  const r = Math.round(30 + t * 225);
  const g = Math.round(200 - t * 40);
  const b = Math.round(255 - t * 220);
  return [r, g, b];
}

// ── Module state ─────────────────────────────────────────────────────────────
interface Pendulum {
  angle: number;      // current angle (radians)
  angularVel: number; // angular velocity
  length: number;     // normalized length (0–1), set each frame based on spread
  energy: number;     // current energy level (decays over time)
  trail: { x: number; y: number }[];
}

let pendulums: Pendulum[] = [];
let initialized = false;
let lastBeatIndex = -1;
let beatFlash = 0;

// ── Initialization ──────────────────────────────────────────────────────────

function init(): void {
  pendulums = [];
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    pendulums.push({
      angle: 0,
      angularVel: 0,
      length: 0,
      energy: 0.3,
      trail: [],
    });
  }
  initialized = true;
}

// ── Draw ────────────────────────────────────────────────────────────────────

export function drawPendulumWave(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  if (!initialized) init();

  // Config-driven controls
  const gravity = 0.2 + config.pendulumGravity * 4.8;    // 0.2–5.0
  const spread = 0.01 + config.pendulumSpread * 0.14;     // 0.01–0.15 period increment

  // Audio data
  const { amps, transients } = getBandAverages(bandCount);

  // Beat detection — inject energy on beat
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatFlash = 1.0;
      // Kick all pendulums with energy burst
      for (let i = 0; i < PENDULUM_COUNT; i++) {
        pendulums[i].energy = Math.min(pendulums[i].energy + 0.5, 1.0);
      }
    }
  }

  // Decay beat flash
  beatFlash *= Math.pow(0.9, dt);

  // Layout
  const pivotY = p.height * 0.08;
  const maxLen = p.height * 0.75;
  const minLen = p.height * 0.25;
  const spacing = p.width / (PENDULUM_COUNT + 1);

  // Physics + rendering
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvas = (p as any).drawingContext as CanvasRenderingContext2D;

  // Draw pivot bar
  canvas.save();
  canvas.strokeStyle = `rgba(120, 130, 140, ${0.6 + beatFlash * 0.4})`;
  canvas.lineWidth = 4;
  canvas.beginPath();
  canvas.moveTo(spacing * 0.5, pivotY);
  canvas.lineTo(p.width - spacing * 0.5, pivotY);
  canvas.stroke();
  canvas.restore();

  for (let i = 0; i < PENDULUM_COUNT; i++) {
    const pend = pendulums[i];
    const pivotX = spacing * (i + 1);

    // Compute length: base + spread offset
    const baseLen = 0.4; // normalized base
    const lengthNorm = baseLen + i * spread;
    pend.length = lengthNorm;
    const rodLen = minLen + (maxLen - minLen) * Math.min(lengthNorm, 1.0);

    // Map pendulum to frequency band and boost energy from audio
    const bandIdx = Math.floor((i / PENDULUM_COUNT) * bandCount);
    const amp = amps[Math.min(bandIdx, bandCount - 1)];
    const transient = transients[Math.min(bandIdx, bandCount - 1)];

    // Audio-driven energy injection
    pend.energy = Math.max(pend.energy, amp * 0.6);
    if (transient > 1.2) {
      pend.energy = Math.min(pend.energy + (transient - 1.0) * 0.3, 1.0);
    }

    // Simple pendulum physics: α = -(g/L) * sin(θ)
    // g is our gravity slider, L is the normalized length
    const angularAccel = -(gravity / Math.max(lengthNorm, 0.1)) * Math.sin(pend.angle);

    // Light damping so pendulums slowly lose energy
    const damping = 0.998;
    pend.angularVel += angularAccel * dt * 0.016;
    pend.angularVel *= Math.pow(damping, dt);
    pend.angle += pend.angularVel * dt * 0.016;

    // Keep energy feeding into amplitude
    // If pendulum is nearly still but has energy, give it a nudge
    if (Math.abs(pend.angularVel) < 0.01 && pend.energy > 0.1) {
      pend.angle = pend.energy * MAX_ANGLE * 0.5;
      pend.angularVel = 0;
    }

    // Decay energy
    pend.energy *= Math.pow(0.995, dt);

    // Clamp angle
    pend.angle = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, pend.angle));

    // Bob position
    const bobX = pivotX + Math.sin(pend.angle) * rodLen;
    const bobY = pivotY + Math.cos(pend.angle) * rodLen;

    // Trail
    pend.trail.push({ x: bobX, y: bobY });
    if (pend.trail.length > 30) pend.trail.shift();

    // Colors
    const [cr, cg, cb] = pendulumColor(i, PENDULUM_COUNT);
    const brightness = 0.5 + pend.energy * 0.5;

    // Draw trail
    if (pend.trail.length > 2) {
      canvas.save();
      for (let t = 1; t < pend.trail.length; t++) {
        const alpha = (t / pend.trail.length) * 0.3 * brightness;
        canvas.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`;
        canvas.lineWidth = 2;
        canvas.beginPath();
        canvas.moveTo(pend.trail[t - 1].x, pend.trail[t - 1].y);
        canvas.lineTo(pend.trail[t].x, pend.trail[t].y);
        canvas.stroke();
      }
      canvas.restore();
    }

    // Draw rod
    canvas.save();
    canvas.strokeStyle = `rgba(180, 185, 190, ${0.3 + brightness * 0.3})`;
    canvas.lineWidth = 1.5;
    canvas.beginPath();
    canvas.moveTo(pivotX, pivotY);
    canvas.lineTo(bobX, bobY);
    canvas.stroke();
    canvas.restore();

    // Draw bob with glow
    const glowRadius = BOB_RADIUS * (1 + pend.energy * 0.8 + beatFlash * 0.5);
    canvas.save();

    // Glow
    const glow = canvas.createRadialGradient(bobX, bobY, 0, bobX, bobY, glowRadius * 3);
    glow.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.4 * brightness})`);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    canvas.fillStyle = glow;
    canvas.beginPath();
    canvas.arc(bobX, bobY, glowRadius * 3, 0, Math.PI * 2);
    canvas.fill();

    // Solid bob
    canvas.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.7 + brightness * 0.3})`;
    canvas.beginPath();
    canvas.arc(bobX, bobY, glowRadius, 0, Math.PI * 2);
    canvas.fill();

    // Bright center
    canvas.fillStyle = `rgba(255, 255, 255, ${0.3 + pend.energy * 0.5})`;
    canvas.beginPath();
    canvas.arc(bobX, bobY, glowRadius * 0.35, 0, Math.PI * 2);
    canvas.fill();

    canvas.restore();
  }

  // Draw wave guide line connecting all bobs (the emergent wave pattern)
  canvas.save();
  canvas.strokeStyle = `rgba(255, 255, 255, ${0.08 + beatFlash * 0.12})`;
  canvas.lineWidth = 1.5;
  canvas.beginPath();
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    const pend = pendulums[i];
    const trail = pend.trail;
    if (trail.length === 0) continue;
    const pt = trail[trail.length - 1];
    if (i === 0) canvas.moveTo(pt.x, pt.y);
    else canvas.lineTo(pt.x, pt.y);
  }
  canvas.stroke();
  canvas.restore();

  // Subtle floor reflection
  canvas.save();
  const floorY = p.height * 0.92;
  const floorGrad = canvas.createLinearGradient(0, floorY - 20, 0, floorY + 20);
  floorGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  floorGrad.addColorStop(0.5, `rgba(80, 120, 160, ${0.03 + beatFlash * 0.04})`);
  floorGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  canvas.fillStyle = floorGrad;
  canvas.fillRect(0, floorY - 20, p.width, 40);
  canvas.restore();
}

// ── Reset ───────────────────────────────────────────────────────────────────

export function resetPendulumWave(): void {
  initialized = false;
  lastBeatIndex = -1;
  beatFlash = 0;
  pendulums = [];
}
