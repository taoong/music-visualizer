/**
 * Neon Ring Tunnel visualization
 *
 * First-person flight through a tunnel of concentric neon polygon rings.
 * Rings mapped to 7 frequency bands with aurora-inspired colors (teal → magenta).
 * Beats trigger zoom punches, camera shake, shockwaves, and full-screen flashes.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// --- Ring tunnel ---
const RING_COUNT = isMobile ? 18 : 36;
const MAX_Z = 1800;
const FOCAL_LENGTH = 400;

interface Ring {
  z: number;
  band: number;
}

let rings: Ring[] = [];

// --- Camera state ---
let zoomPunch = 0;
let shakeX = 0;
let shakeY = 0;
let rollAngle = 0;
let rollImpulse = 0;
let driftX = 0;
let driftY = 0;
let noiseOffset = 0;

// --- Beat state ---
let lastBeatIndex = -1;
let beatFlash = 0;
let beatCount = 0;
let polygonSides = 6;

// --- Shockwaves ---
interface Shockwave {
  radius: number;
  alpha: number;
  hue: number;
}
const MAX_SHOCKWAVES = 4;
let shockwaves: Shockwave[] = [];

// --- Particles ---
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}
const MAX_PARTICLES = isMobile ? 60 : 150;
let particles: Particle[] = [];

// --- Palette ---
const HUE_START = 160; // teal
const HUE_END = 310;   // magenta

function initRings(): void {
  rings = [];
  for (let i = 0; i < RING_COUNT; i++) {
    rings.push({
      z: (i / RING_COUNT) * MAX_Z,
      band: i % 7,
    });
  }
}

function spawnParticles(count: number, highVelocity: boolean): void {
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = highVelocity ? 4 + Math.random() * 6 : 1 + Math.random() * 3;
    particles.push({
      x: 0,
      y: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 40 + Math.random() * 40,
      size: 1.5 + Math.random() * 2.5,
    });
  }
}

function drawPolygon(p: P5Instance, cx: number, cy: number, radius: number, sides: number): void {
  p.beginShape();
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).vertex(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  p.endShape(p['CLOSE']);
}

export function drawAurora(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  if (rings.length === 0) initRings();

  const { amps, transients } = getBandAverages(bandCount);

  // Derived signals
  let totalEnergy = 0;
  for (let b = 0; b < bandCount; b++) totalEnergy += amps[b];
  const avgEnergy = totalEnergy / bandCount;

  const bassEnergy = isFreqMode
    ? (amps[0] + amps[1]) / 2
    : amps[0];
  const highEnergy = isFreqMode
    ? (amps[Math.min(5, bandCount - 1)] + amps[Math.min(6, bandCount - 1)]) / 2
    : amps[Math.min(4, bandCount - 1)];

  const centroid = store.audioState.smoothedCentroid;
  const hueShift = centroid * 40; // shift palette by centroid

  // --- Beat detection ---
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatCount++;

      // Zoom punch
      zoomPunch = 0.15;
      // Camera shake
      shakeX = (Math.random() - 0.5) * 30;
      shakeY = (Math.random() - 0.5) * 30;
      // Roll impulse
      rollImpulse += (Math.random() - 0.5) * 0.12;
      // Beat flash
      beatFlash = 1.0;
      // Shockwave
      if (shockwaves.length < MAX_SHOCKWAVES) {
        shockwaves.push({ radius: 10, alpha: 1.0, hue: HUE_START + Math.random() * (HUE_END - HUE_START) });
      }
      // Burst particles
      spawnParticles(25, true);
      // Geometry morph every 4th beat
      if (beatCount % 4 === 0) {
        polygonSides = polygonSides === 6 ? 8 : 6;
      }
    }
  }

  // --- Decay camera effects ---
  zoomPunch *= Math.pow(0.82, dt);
  shakeX *= Math.pow(0.78, dt);
  shakeY *= Math.pow(0.78, dt);
  rollImpulse *= Math.pow(0.85, dt);
  beatFlash *= Math.pow(0.75, dt);
  if (beatFlash < 0.01) beatFlash = 0;

  // --- Camera drift (Perlin noise) ---
  noiseOffset += 0.005 * dt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;
  driftX += (((pAny.noise(noiseOffset, 0) - 0.5) * 40) - driftX) * 0.03 * dt;
  driftY += (((pAny.noise(0, noiseOffset) - 0.5) * 30) - driftY) * 0.03 * dt;

  // --- Continuous roll ---
  rollAngle += (0.003 + rollImpulse) * dt;

  // --- Flight: advance rings toward camera ---
  const flightSpeed = (3.0 + bassEnergy * 8.0) * dt;
  for (const ring of rings) {
    ring.z -= flightSpeed;
    if (ring.z < -50) {
      ring.z += MAX_Z;
      ring.band = Math.floor(Math.random() * 7);
    }
  }

  // --- Update shockwaves ---
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    shockwaves[i].radius += 8 * dt;
    shockwaves[i].alpha *= Math.pow(0.9, dt);
    if (shockwaves[i].alpha < 0.01) shockwaves.splice(i, 1);
  }

  // --- Update particles ---
  // Continuous spawn based on energy
  const spawnRate = Math.floor(1 + avgEnergy * 3 + highEnergy * 2);
  spawnParticles(Math.min(spawnRate, 5), false);

  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    const speedMult = 1 + bassEnergy * 2;
    pt.x += pt.vx * speedMult * dt;
    pt.y += pt.vy * speedMult * dt;
    pt.life += dt;
    if (pt.life >= pt.maxLife) {
      particles.splice(i, 1);
    }
  }

  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const intensity = config.intensity;
  const scale = config.spikeScale;

  // --- Set HSB color mode ---
  pAny.colorMode(p['HSB'], 360, 100, 100, 1.0);

  // --- Center glow ---
  p.noStroke();
  const glowHue = (HUE_START + hueShift) % 360;
  for (let i = 2; i >= 0; i--) {
    const r = (80 + i * 60 + avgEnergy * 80) * (minDim / 800);
    const alpha = (0.04 + avgEnergy * 0.06) * (1 - i * 0.25) * intensity;
    pAny.fill(glowHue, 60, 60, Math.min(alpha, 0.3));
    p.ellipse(cx + driftX, cy + driftY, r * 2, r * 2);
  }

  // --- Camera transform ---
  p.push();
  p.translate(cx + driftX + shakeX, cy + driftY + shakeY);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).scale(1 + zoomPunch);
  (p as any).rotate(rollAngle);
  p.translate(-cx, -cy);

  // --- Draw rings (back to front, sorted by Z descending) ---
  const sortedRings = rings.slice().sort((a, b) => b.z - a.z);
  p.noFill();

  for (const ring of sortedRings) {
    if (ring.z < 0) continue;
    const projScale = FOCAL_LENGTH / (FOCAL_LENGTH + ring.z);
    const bandIdx = ring.band % bandCount;
    const amp = amps[bandIdx] || 0;
    const tMult = transients[bandIdx] || 1;

    // Ring radius: base + amplitude-driven expansion
    const baseRadius = minDim * 0.35;
    const expansion = amp * scale * 0.6;
    const radius = (baseRadius + baseRadius * expansion) * projScale;

    // Hue mapped to band with centroid shift
    const bandT = ring.band / 6;
    const hue = (HUE_START + bandT * (HUE_END - HUE_START) + hueShift) % 360;

    // Brightness from amplitude + transient boost
    const baseBright = 40 + amp * 50;
    const transientBoost = tMult > 1.5 ? (tMult - 1) * 30 : 0;
    const bright = Math.min(baseBright + transientBoost, 100);
    const sat = 70 + amp * 20;

    // Fade at Z extremes
    const zFade = ring.z < 100 ? ring.z / 100 : ring.z > MAX_Z - 200 ? (MAX_Z - ring.z) / 200 : 1;
    const baseAlpha = zFade * (0.3 + amp * 0.5) * intensity;

    // Projected center
    const px = cx + (driftX * 0.3 * projScale);
    const py = cy + (driftY * 0.3 * projScale);

    // Multi-pass glow rendering
    // Pass 1: thick faint glow
    p.strokeWeight(Math.max((4 + amp * 3) * projScale, 0.5));
    pAny.stroke(hue, sat * 0.7, bright * 0.7, baseAlpha * 0.4);
    drawPolygon(p, px, py, radius, polygonSides);

    // Pass 2: thin bright core
    p.strokeWeight(Math.max((1.5 + amp * 1) * projScale, 0.3));
    pAny.stroke(hue, sat, bright, baseAlpha * 0.9);
    drawPolygon(p, px, py, radius, polygonSides);
  }

  // --- Draw shockwaves ---
  p.noFill();
  for (const sw of shockwaves) {
    const weight = Math.max(3 - sw.radius * 0.005, 0.5);
    p.strokeWeight(weight);
    pAny.stroke(sw.hue, 60, 100, sw.alpha * 0.7 * intensity);
    p.ellipse(cx, cy, sw.radius * 2, sw.radius * 2);
  }

  // --- Draw particles ---
  p.noStroke();
  for (const pt of particles) {
    const lifeT = pt.life / pt.maxLife;
    const alpha = (1 - lifeT) * 0.8;
    const hue = (HUE_START + hueShift + Math.random() * 20) % 360;
    pAny.fill(hue, 15, 100, alpha);
    p.ellipse(cx + pt.x, cy + pt.y, pt.size, pt.size);
  }

  p.pop();

  // --- Beat flash overlay (outside camera transform) ---
  if (beatFlash > 0.01) {
    pAny.fill(0, 0, 100, beatFlash * 0.35);
    p.noStroke();
    p.rect(0, 0, p.width, p.height);
  }

  // Reset color mode
  p.colorMode(p['RGB'], 255);
}

export function interactAurora(event: import('../types').InteractionEvent): void {
  const { type } = event;
  if (type === 'tap' || type === 'key') {
    zoomPunch = Math.max(zoomPunch, 0.18);
    shakeX = (Math.random() - 0.5) * 30;
    shakeY = (Math.random() - 0.5) * 30;
    rollImpulse += (Math.random() - 0.5) * 0.12;
    beatFlash = 1.0;
    if (shockwaves.length < MAX_SHOCKWAVES) {
      shockwaves.push({ radius: 10, alpha: 1.0, hue: HUE_START + Math.random() * (HUE_END - HUE_START) });
    }
    spawnParticles(20, true);
  } else if (type === 'hold') {
    polygonSides = polygonSides === 6 ? 8 : 6;
  }
}

export function resetAurora(): void {
  rings = [];
  zoomPunch = 0;
  shakeX = 0;
  shakeY = 0;
  rollAngle = 0;
  rollImpulse = 0;
  driftX = 0;
  driftY = 0;
  noiseOffset = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  beatCount = 0;
  polygonSides = 6;
  shockwaves = [];
  particles = [];
}
