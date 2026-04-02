/**
 * Strange Attractor visualization — Lorenz attractor chaos theory simulation
 *
 * Particles trace paths through the Lorenz dynamical system, creating the
 * iconic butterfly-shaped attractor. Like a chaos theory exhibit at a science
 * museum, synced to audio: frequency bands spawn colored particle groups,
 * amplitudes warp the attractor parameters, and beats jolt the system.
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Types ───────────────────────────────────────────────────────────────────

interface AttractorParticle {
  x: number;
  y: number;
  z: number;
  trail: { sx: number; sy: number }[];  // screen-space trail
  band: number;
  hue: number;
  life: number;
  maxLife: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_PARTICLES = isMobile ? 60 : 120;
const SPAWN_THRESHOLD = 0.12;
const BG_COLOR = '#06060e';
// Classic Lorenz base parameters
const BASE_SIGMA = 10;
const BASE_BETA = 8 / 3;
const INTEGRATION_DT = 0.005;   // Lorenz integration timestep (fixed, not frame dt)
const STEPS_PER_FRAME = isMobile ? 3 : 5;
// Band hues: sub→brilliance, warm→cool→warm
const BAND_HUES = [300, 260, 200, 160, 50, 30, 350];

// ── Module state ────────────────────────────────────────────────────────────

let particles: AttractorParticle[] = [];
let initialized = false;
let canvasW = 0;
let canvasH = 0;
let lastBeatIndex = -1;
let flashAlpha = 0;
let camAngle = 0;        // slowly orbiting camera
let rhoJolt = 0;         // beat-induced rho spike, decays

// ── Public API ──────────────────────────────────────────────────────────────

export function drawAttractor(p: P5Instance, dt: number): void {
  if (!initialized || canvasW !== p.width || canvasH !== p.height) {
    canvasW = p.width;
    canvasH = p.height;
    if (!initialized) {
      particles = [];
      lastBeatIndex = -1;
      flashAlpha = 0;
      camAngle = 0;
      rhoJolt = 0;
    }
    initialized = true;
  }

  const chaos = store.config.attractorChaos;           // 0–1
  const trailLen = store.config.attractorTrailLength;   // 0–1

  const maxTrail = Math.floor(5 + trailLen * (isMobile ? 75 : 195)); // 5–200

  // Lorenz parameters, modulated by chaos slider and audio
  const { amps, transients } = getBandAverages(BAND_COUNT);
  const avgAmp = amps.reduce((s, v) => s + v, 0) / amps.length;

  // Rho is the key chaos parameter: slider sets base, audio modulates
  const rho = 10 + chaos * 30 + avgAmp * 8 + rhoJolt; // 10–48+ range
  const sigma = BASE_SIGMA + avgAmp * 3;
  const beta = BASE_BETA;

  // Beat detection
  detectBeat(amps);

  // Continuous spawning from audio bands
  spawnFromAudio(amps, dt, maxTrail);

  // Integrate and build trails
  for (const part of particles) {
    for (let s = 0; s < STEPS_PER_FRAME; s++) {
      lorenzStep(part, sigma, rho, beta);
    }
    // Project 3D → 2D and add to trail
    const [sx, sy] = project(part.x, part.y, part.z);
    part.trail.push({ sx, sy });
    if (part.trail.length > maxTrail) {
      part.trail.splice(0, part.trail.length - maxTrail);
    }
    part.life -= dt;
  }

  // Remove dead particles
  particles = particles.filter(part => part.life > 0);

  // Slowly orbit camera
  camAngle += 0.003 * dt;

  // Decay beat jolt
  rhoJolt *= Math.pow(0.9, dt);
  if (Math.abs(rhoJolt) < 0.05) rhoJolt = 0;

  // ── Render ────────────────────────────────────────────────────────────────

  p.background(BG_COLOR);

  // Beat flash
  if (flashAlpha > 0) {
    p.noStroke();
    p.fill(255, 255, 255, flashAlpha);
    p.rect(0, 0, canvasW, canvasH);
    flashAlpha = Math.max(0, flashAlpha - 5 * dt);
  }

  (p as any).colorMode(p['HSB'], 360, 100, 100, 255);

  // Render particle trails
  for (const part of particles) {
    renderTrail(p, part);
  }

  // Render particle heads
  for (const part of particles) {
    renderHead(p, part, transients);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetAttractor(): void {
  particles = [];
  initialized = false;
  lastBeatIndex = -1;
  flashAlpha = 0;
  camAngle = 0;
  rhoJolt = 0;
}

// ── Spawning ────────────────────────────────────────────────────────────────

function spawnFromAudio(amps: number[], dt: number, _maxTrail: number): void {
  for (let b = 0; b < Math.min(amps.length, 7); b++) {
    if (amps[b] < SPAWN_THRESHOLD) continue;
    const prob = (amps[b] - SPAWN_THRESHOLD) * 1.2 * dt;
    if (Math.random() < prob && particles.length < MAX_PARTICLES) {
      particles.push(createParticle(b));
    }
  }
}

function detectBeat(_amps: number[]): void {
  const { state } = store;
  if (state.beatIntervalSec <= 0) return;

  const playbackPos = state.isPlaying
    ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
    : state.startOffset;
  const beatIndex = Math.floor((playbackPos - state.beatOffset) / state.beatIntervalSec);

  if (beatIndex > lastBeatIndex && lastBeatIndex >= 0) {
    // Jolt the rho parameter — shifts the attractor shape
    rhoJolt = 6 + Math.random() * 4;
    flashAlpha = 20;

    // Spawn burst of particles
    const burstCount = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < burstCount && particles.length < MAX_PARTICLES; i++) {
      const band = Math.floor(Math.random() * 7);
      particles.push(createParticle(band));
    }

    // Perturb existing particles slightly
    for (const part of particles) {
      part.x += (Math.random() - 0.5) * 2;
      part.y += (Math.random() - 0.5) * 2;
      part.z += (Math.random() - 0.5) * 2;
    }
  }
  lastBeatIndex = beatIndex;
}

function createParticle(band: number): AttractorParticle {
  // Start near one of the attractor's two lobes with some randomness
  const lobe = Math.random() < 0.5 ? -1 : 1;
  const x = lobe * (8 + Math.random() * 4) + (Math.random() - 0.5) * 3;
  const y = lobe * (8 + Math.random() * 4) + (Math.random() - 0.5) * 3;
  const z = 20 + Math.random() * 15 + (Math.random() - 0.5) * 5;
  const life = 200 + Math.random() * 300; // frames

  return {
    x, y, z,
    trail: [],
    band,
    hue: BAND_HUES[band],
    life,
    maxLife: life,
  };
}

// ── Lorenz system ───────────────────────────────────────────────────────────

function lorenzStep(p: AttractorParticle, sigma: number, rho: number, beta: number): void {
  const dx = sigma * (p.y - p.x);
  const dy = p.x * (rho - p.z) - p.y;
  const dz = p.x * p.y - beta * p.z;
  p.x += dx * INTEGRATION_DT;
  p.y += dy * INTEGRATION_DT;
  p.z += dz * INTEGRATION_DT;
}

// ── 3D → 2D Projection ─────────────────────────────────────────────────────

function project(x: number, y: number, z: number): [number, number] {
  // Rotate around Y axis (orbiting camera)
  const cosA = Math.cos(camAngle);
  const sinA = Math.sin(camAngle);
  const rx = x * cosA - y * sinA;
  const ry = x * sinA + y * cosA;
  const rz = z;

  // Simple perspective projection
  const scale = Math.min(canvasW, canvasH) * 0.014;
  // Tilt slightly to see the butterfly from an angle
  const viewY = ry * 0.7 - (rz - 25) * 0.7;
  const sx = canvasW / 2 + rx * scale;
  const sy = canvasH / 2 - viewY * scale;

  return [sx, sy];
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderTrail(p: P5Instance, part: AttractorParticle): void {
  const trail = part.trail;
  if (trail.length < 2) return;

  const lifeFrac = Math.max(0, part.life / part.maxLife);
  p.noFill();

  // Two-pass glow rendering
  for (let pass = 0; pass < 2; pass++) {
    const isGlow = pass === 0;
    const widthMult = isGlow ? 3.5 : 1.0;
    const alphaMult = isGlow ? 0.12 : 0.55;

    for (let i = 1; i < trail.length; i++) {
      const frac = i / trail.length;
      const edgeFade = Math.min(frac * 4, 1.0);
      const alpha = edgeFade * lifeFrac * alphaMult * 255;
      const weight = (isGlow ? 2.5 : 1.0) * widthMult * frac;
      const sat = isGlow ? 40 : 75;
      const bright = isGlow ? 50 : 85;

      (p as any).stroke(part.hue, sat, bright, alpha);
      p.strokeWeight(weight);
      p.line(trail[i - 1].sx, trail[i - 1].sy, trail[i].sx, trail[i].sy);
    }
  }
}

function renderHead(p: P5Instance, part: AttractorParticle, transients: number[]): void {
  if (part.trail.length < 1) return;

  const lifeFrac = Math.max(0, part.life / part.maxLife);
  const last = part.trail[part.trail.length - 1];
  const transientBoost = transients[part.band] > 1.3 ? 1.5 : 1.0;

  // Glow
  const glowSize = (4 + transientBoost * 4) * lifeFrac;
  p.noStroke();
  (p as any).fill(part.hue, 30, 90, 40 * lifeFrac);
  p.ellipse(last.sx, last.sy, glowSize * 3, glowSize * 3);

  // Core
  (p as any).fill(part.hue, 20, 100, 200 * lifeFrac);
  p.ellipse(last.sx, last.sy, glowSize, glowSize);
}
