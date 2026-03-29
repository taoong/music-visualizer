/**
 * Cymatics — Chladni plate particle simulation.
 *
 * Sand particles drift toward nodal lines of vibrating plate modes.
 * Each of 7 frequency bands excites a different standing wave mode (m,n).
 * Beats scatter particles; they reform into new patterns as amplitudes shift.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { isMobile } from '../utils/constants';

// ── Chladni mode numbers per band ────────────────────────────────────────────
// Z(x,y) = A * cos(m*π*x/W) * cos(n*π*y/H)
const MODES: [number, number][] = [
  [1, 1], // Sub
  [2, 1], // Bass
  [2, 2], // Low-Mid
  [3, 2], // Mid
  [3, 3], // Upper-Mid
  [4, 3], // Presence
  [5, 4], // Brilliance
];

// ── Color palette: blue (low freq dominant) → gold (high freq dominant) ──────
const BAND_HUES = [220, 200, 170, 140, 60, 40, 30]; // blue→gold

// ── Module state ─────────────────────────────────────────────────────────────
const PARTICLE_COUNT = isMobile ? 1500 : 3000;

let initialized = false;
let canvasW = 0;
let canvasH = 0;

// SoA particle arrays
let px: Float32Array;
let py: Float32Array;
let vx: Float32Array;
let vy: Float32Array;

// Precomputed mode wavenumbers
let mPiOverW: Float64Array;
let nPiOverH: Float64Array;

// Beat / visual state
let lastBeatIndex = -1;
let transientGlow = 0;
let baseHue = 200;

// ── Initialization ───────────────────────────────────────────────────────────

function init(w: number, h: number): void {
  canvasW = w;
  canvasH = h;

  // Precompute wavenumbers
  mPiOverW = new Float64Array(7);
  nPiOverH = new Float64Array(7);
  for (let b = 0; b < 7; b++) {
    mPiOverW[b] = MODES[b][0] * Math.PI / w;
    nPiOverH[b] = MODES[b][1] * Math.PI / h;
  }

  // Initialize particles randomly
  px = new Float32Array(PARTICLE_COUNT);
  py = new Float32Array(PARTICLE_COUNT);
  vx = new Float32Array(PARTICLE_COUNT);
  vy = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    px[i] = Math.random() * w;
    py[i] = Math.random() * h;
    vx[i] = 0;
    vy[i] = 0;
  }

  lastBeatIndex = -1;
  transientGlow = 0;

  initialized = true;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawCymatics(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  // Init / resize
  if (!initialized || p.width !== canvasW || p.height !== canvasH) {
    init(p.width, p.height);
  }

  // Audio data
  const { amps, transients } = getBandAverages(bandCount);
  const scale = config.spikeScale;

  // Weighted amplitudes (clamped)
  const wAmps = new Float64Array(7);
  for (let b = 0; b < Math.min(bandCount, 7); b++) {
    wAmps[b] = Math.min(amps[b] * scale, 1.0);
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      baseHue = (baseHue + 25) % 360;

      // Scatter particles with random velocity
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 4;
        vx[i] += Math.cos(angle) * speed;
        vy[i] += Math.sin(angle) * speed;
      }
    }
  }

  // Transient glow from max transient
  let maxTransient = 0;
  for (let b = 0; b < bandCount; b++) {
    if (transients[b] > maxTransient) maxTransient = transients[b];
  }
  transientGlow = Math.max(transientGlow * Math.pow(0.9, dt), (maxTransient - 1.0) * 0.5);

  // ── Physics step ───────────────────────────────────────────────────────────
  const damping = Math.pow(0.92, dt);
  const forceScale = 0.15 * dt;
  const speedClamp = 8.0;
  const w = canvasW;
  const h = canvasH;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = px[i];
    const y = py[i];

    // Compute Z and gradients from superposition of modes
    let fx = 0;
    let fy = 0;

    for (let b = 0; b < Math.min(bandCount, 7); b++) {
      if (wAmps[b] < 0.001) continue;

      const mw = mPiOverW[b];
      const nh = nPiOverH[b];

      const cosX = Math.cos(mw * x);
      const cosY = Math.cos(nh * y);
      const sinX = Math.sin(mw * x);
      const sinY = Math.sin(nh * y);

      const Z = wAmps[b] * cosX * cosY;
      const dZdx = -wAmps[b] * mw * sinX * cosY;
      const dZdy = -wAmps[b] * nh * cosX * sinY;

      // Force = -2 * Z * gradient(Z) = gradient of -Z²
      fx += -2 * Z * dZdx;
      fy += -2 * Z * dZdy;
    }

    // Apply force with damping
    vx[i] = (vx[i] + fx * forceScale) * damping;
    vy[i] = (vy[i] + fy * forceScale) * damping;

    // Speed clamp
    const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    if (speed > speedClamp) {
      const inv = speedClamp / speed;
      vx[i] *= inv;
      vy[i] *= inv;
    }

    // Update position
    px[i] += vx[i] * dt;
    py[i] += vy[i] * dt;

    // Reflective boundaries
    if (px[i] < 0) { px[i] = -px[i]; vx[i] = Math.abs(vx[i]); }
    if (px[i] > w) { px[i] = 2 * w - px[i]; vx[i] = -Math.abs(vx[i]); }
    if (py[i] < 0) { py[i] = -py[i]; vy[i] = Math.abs(vy[i]); }
    if (py[i] > h) { py[i] = 2 * h - py[i]; vy[i] = -Math.abs(vy[i]); }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;

  // Semi-transparent black overlay for motion trails
  pAny.colorMode(p['RGB'], 255);
  pAny.background(0, 0, 0, 30);

  pAny.colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = px[i];
    const y = py[i];
    const spd = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);

    // Determine dominant band at this particle location
    let maxVal = 0;
    let domBand = 0;
    for (let b = 0; b < Math.min(bandCount, 7); b++) {
      if (wAmps[b] < 0.001) continue;
      const Z = Math.abs(wAmps[b] * Math.cos(mPiOverW[b] * x) * Math.cos(nPiOverH[b] * y));
      if (Z > maxVal) {
        maxVal = Z;
        domBand = b;
      }
    }

    // Hue: band-based + rotating base
    const hue = (BAND_HUES[domBand] + baseHue) % 360;

    // Settled particles (low speed) glow brighter
    const settledBrightness = Math.max(0, 1 - spd * 0.3);
    const brightness = 40 + settledBrightness * 55 + transientGlow * 30;
    const saturation = 60 + settledBrightness * 30;

    // Particle size: slightly larger when settled
    const size = 1.5 + settledBrightness * 1.5;
    const alpha = 60 + settledBrightness * 35;

    pAny.fill(hue, saturation, Math.min(brightness, 100), alpha);
    pAny.ellipse(x, y, size, size);
  }

  // Reset color mode
  pAny.colorMode(p['RGB'], 255);
}

// ── Reset ────────────────────────────────────────────────────────────────────

export function resetCymatics(): void {
  initialized = false;
  lastBeatIndex = -1;
  transientGlow = 0;
  baseHue = 200;
}
