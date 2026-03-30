/**
 * Pendulum Wave — classic physics exhibit synced to music.
 *
 * 21 pendulums (15 mobile) with incrementally different natural frequencies
 * create traveling waves, standing waves, and chaos before re-syncing.
 * Audio drives swing amplitude; beats inject energy to all pendulums.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────
const PENDULUM_COUNT = isMobile ? 15 : 21;
const TRAIL_LENGTH = isMobile ? 25 : 40;
const BAND_HUES = [220, 200, 170, 50, 30, 10, 350]; // blue (sub) → red (brilliance)

// Physics
const BASE_FREQ = Math.PI; // ~2s period
const FREQ_STEP = (2 * Math.PI) / 45; // full wave pattern repeats ~45s
const DAMPING_BASE = 0.97;
const BEAT_ENERGY = 0.3;

// ── Module state ─────────────────────────────────────────────────────────────
let initialized = false;
let canvasW = 0;
let canvasH = 0;
let lastBeatIndex = -1;
let transientGlow = 0;

// Per-pendulum arrays
let phases: Float64Array;
let amplitudes: Float64Array;
let naturalFreqs: Float64Array;
let stringLengths: Float64Array;

// Trail circular buffers
let trailsX: Float64Array[]; // [pendulum][trailSlot]
let trailsY: Float64Array[];
let trailIdx = 0;
let trailCount = 0; // how many trail slots are filled (up to TRAIL_LENGTH)

// ── Initialization ───────────────────────────────────────────────────────────

function init(w: number, h: number): void {
  canvasW = w;
  canvasH = h;

  phases = new Float64Array(PENDULUM_COUNT);
  amplitudes = new Float64Array(PENDULUM_COUNT);
  naturalFreqs = new Float64Array(PENDULUM_COUNT);
  stringLengths = new Float64Array(PENDULUM_COUNT);

  // String lengths: shorter = faster (matching real physics intuition)
  // Longest at index 0, shortest at last index
  const maxLen = h * 0.55;
  const minLen = h * 0.25;

  for (let i = 0; i < PENDULUM_COUNT; i++) {
    naturalFreqs[i] = BASE_FREQ + i * FREQ_STEP;
    phases[i] = 0;
    amplitudes[i] = 0.3;
    // Shorter string = higher frequency
    const t = i / (PENDULUM_COUNT - 1);
    stringLengths[i] = maxLen - t * (maxLen - minLen);
  }

  // Init trails
  trailsX = [];
  trailsY = [];
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    trailsX.push(new Float64Array(TRAIL_LENGTH));
    trailsY.push(new Float64Array(TRAIL_LENGTH));
  }
  trailIdx = 0;
  trailCount = 0;

  lastBeatIndex = -1;
  transientGlow = 0;
  initialized = true;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawPendulumWave(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  // Init / resize
  if (!initialized || p.width !== canvasW || p.height !== canvasH) {
    init(p.width, p.height);
  }

  // Audio data
  const { amps, transients } = getBandAverages(bandCount);

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      // Inject energy to all pendulums
      for (let i = 0; i < PENDULUM_COUNT; i++) {
        amplitudes[i] = Math.min(amplitudes[i] + BEAT_ENERGY, 1.2);
      }
    }
  }

  // ── Transient glow ──────────────────────────────────────────────────────────
  let maxTransient = 0;
  for (let b = 0; b < bandCount; b++) {
    if (transients[b] > maxTransient) maxTransient = transients[b];
  }
  transientGlow = Math.max(transientGlow * Math.pow(0.9, dt), (maxTransient - 1.0) * 0.5);

  // ── Update amplitudes & phases ──────────────────────────────────────────────
  const damping = Math.pow(DAMPING_BASE, dt);
  const bandsUsed = Math.min(bandCount, 7);

  for (let i = 0; i < PENDULUM_COUNT; i++) {
    // Map pendulum to frequency band
    const bandIdx = Math.floor((i / PENDULUM_COUNT) * bandsUsed);
    const targetAmp = amps[bandIdx] * config.spikeScale * 1.5;

    // Blend toward audio-driven target, apply damping
    amplitudes[i] = amplitudes[i] * damping + targetAmp * 0.05 * dt;
    amplitudes[i] = Math.min(amplitudes[i], 1.5);

    // Update phase
    phases[i] += naturalFreqs[i] * dt / 60;
  }

  // ── Compute bob positions ───────────────────────────────────────────────────
  const barY = canvasH * 0.08;
  const spacing = canvasW / (PENDULUM_COUNT + 1);

  const bobX = new Float64Array(PENDULUM_COUNT);
  const bobY = new Float64Array(PENDULUM_COUNT);

  for (let i = 0; i < PENDULUM_COUNT; i++) {
    const pivotX = spacing * (i + 1);
    const len = stringLengths[i];
    const angle = amplitudes[i] * Math.sin(phases[i]) * 0.6; // max ~34°

    bobX[i] = pivotX + len * Math.sin(angle);
    bobY[i] = barY + len * Math.cos(angle);
  }

  // ── Store trail positions ───────────────────────────────────────────────────
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    trailsX[i][trailIdx] = bobX[i];
    trailsY[i][trailIdx] = bobY[i];
  }
  trailIdx = (trailIdx + 1) % TRAIL_LENGTH;
  if (trailCount < TRAIL_LENGTH) trailCount++;

  // ── Rendering ───────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;

  // Background
  pAny.colorMode(p['RGB'], 255);
  pAny.background(10, 12, 18);

  // ── Grid lines (physics-lab aesthetic) ──────────────────────────────────────
  p.stroke(30, 35, 45);
  p.strokeWeight(1);
  const gridSpacing = canvasH / 10;
  for (let y = gridSpacing; y < canvasH; y += gridSpacing) {
    p.line(0, y, canvasW, y);
  }

  // Switch to HSB for colored elements
  pAny.colorMode(p['HSB'], 360, 100, 100, 100);

  // ── Pivot bar ───────────────────────────────────────────────────────────────
  p.noStroke();
  // Metallic bar gradient effect
  pAny.fill(30, 5, 50, 90);
  pAny.rect(spacing * 0.3, barY - 6, canvasW - spacing * 0.6, 12, 4);
  pAny.fill(40, 8, 65, 80);
  pAny.rect(spacing * 0.3, barY - 4, canvasW - spacing * 0.6, 6, 3);

  // ── Trails ──────────────────────────────────────────────────────────────────
  p.noStroke();
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    const bandIdx = Math.floor((i / PENDULUM_COUNT) * bandsUsed);
    const hue = BAND_HUES[Math.min(bandIdx, 6)];
    const bobSize = 12 + amplitudes[i] * 8;

    for (let t = 0; t < trailCount; t++) {
      // Read from oldest to newest
      const idx = (trailIdx - trailCount + t + TRAIL_LENGTH) % TRAIL_LENGTH;
      const age = t / trailCount; // 0 = oldest, 1 = newest
      const alpha = age * 25; // fade from transparent to semi-visible
      const size = bobSize * 0.3 * age;

      pAny.fill(hue, 60, 70, alpha);
      pAny.ellipse(trailsX[i][idx], trailsY[i][idx], size, size);
    }
  }

  // ── Ghost envelope (curve connecting all current bob positions) ─────────────
  p.noFill();
  p.strokeWeight(2);
  pAny.stroke(200, 30, 80, 25);
  p.beginShape();
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    pAny.curveVertex(bobX[i], bobY[i]);
  }
  // Duplicate first and last for curveVertex
  if (PENDULUM_COUNT > 0) {
    pAny.curveVertex(bobX[0], bobY[0]);
    pAny.curveVertex(bobX[PENDULUM_COUNT - 1], bobY[PENDULUM_COUNT - 1]);
  }
  p.endShape();

  // ── Strings and bobs ───────────────────────────────────────────────────────
  for (let i = 0; i < PENDULUM_COUNT; i++) {
    const pivotX = spacing * (i + 1);
    const bandIdx = Math.floor((i / PENDULUM_COUNT) * bandsUsed);
    const hue = BAND_HUES[Math.min(bandIdx, 6)];

    // String
    p.strokeWeight(1.5);
    pAny.stroke(0, 0, 45, 70);
    p.line(pivotX, barY, bobX[i], bobY[i]);

    // Pivot point
    p.noStroke();
    pAny.fill(0, 0, 60, 80);
    pAny.ellipse(pivotX, barY, 6, 6);

    // Bob glow (intensifies on transients)
    const glowSize = 28 + amplitudes[i] * 20 + transientGlow * 30;
    pAny.fill(hue, 50, 80, 12 + transientGlow * 15);
    pAny.ellipse(bobX[i], bobY[i], glowSize, glowSize);

    // Bob
    const bobSize = 12 + amplitudes[i] * 8;
    const brightness = 70 + amplitudes[i] * 25 + transientGlow * 20;
    pAny.fill(hue, 70, Math.min(brightness, 100), 90);
    pAny.ellipse(bobX[i], bobY[i], bobSize, bobSize);

    // Bob highlight
    pAny.fill(hue, 30, 100, 40);
    pAny.ellipse(bobX[i] - bobSize * 0.15, bobY[i] - bobSize * 0.15, bobSize * 0.35, bobSize * 0.35);
  }

  // Reset color mode
  pAny.colorMode(p['RGB'], 255);
}

// ── Reset ────────────────────────────────────────────────────────────────────

export function resetPendulumWave(): void {
  initialized = false;
  lastBeatIndex = -1;
  transientGlow = 0;
}
