/**
 * Magnetosphere — audio-reactive gravity-well particle orbits.
 *
 * Inspired by Robert Hodgin's "Magnetosphere" (2007), the iconic Apple
 * iTunes 8 default visualizer (https://roberthodgin.com/project/magnetosphere).
 * Built at The Barbarian Group, it drove live visuals for Peter Gabriel and
 * Aphex Twin. At its core: FFT-driven gravitational forces where each
 * frequency band is an attractor that pulls swarms of charged particles into
 * fluid orbital compositions.
 *
 * Seven frequency-band attractor nodes arrange themselves on a slowly rotating
 * heptagon ring. Each attractor's gravity scales with its band's amplitude —
 * a pounding kick drum pulls nearby particles into tight spirals, while
 * silence lets them drift freely. Particles leave luminous comet trails as
 * they orbit, accelerate, and slingshot between wells. Beats scatter all
 * attractors radially outward then ease them back, triggering a blooming
 * explosion-and-collapse.
 *
 * Sliders
 *   Particles — orbiting comet count (sparse wisps → dense swarm)
 *   Gravity   — attractor pull strength (free drift → tight vortex orbits)
 *   Trail     — comet tail persistence (instant fade → long luminous streaks)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES: readonly number[] = [270, 215, 170, 120, 60, 25, 310];

const MAX_PARTICLES = isMobile ? 700 : 2200;
const MIN_PARTICLES = isMobile ? 60 : 200;

// Particle state — SoA for cache efficiency
let px: Float32Array = new Float32Array(0);
let py: Float32Array = new Float32Array(0);
let pvx: Float32Array = new Float32Array(0);
let pvy: Float32Array = new Float32Array(0);
let pBand: Uint8Array = new Uint8Array(0);   // dominant attractor band
let pHue: Float32Array = new Float32Array(0);

// Attractor state (one per band)
const aBaseX = new Float32Array(BAND_COUNT); // ring position
const aBaseY = new Float32Array(BAND_COUNT);
const aX = new Float32Array(BAND_COUNT);     // actual (base + scatter)
const aY = new Float32Array(BAND_COUNT);
const aScatterX = new Float32Array(BAND_COUNT);
const aScatterY = new Float32Array(BAND_COUNT);

let lastBeatIndex = -1;
let hueShift = 0;
let ringAngle = 0;
let trailBuf: P5Graphics | null = null;
let initialized = false;
let prevWidth = 0;
let prevHeight = 0;
let activeCount = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function spawnParticle(i: number, w: number, h: number): void {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random() * Math.min(w, h) * 0.18;
  px[i] = w / 2 + Math.cos(angle) * r;
  py[i] = h / 2 + Math.sin(angle) * r;
  pvx[i] = (Math.random() - 0.5) * 1.8;
  pvy[i] = (Math.random() - 0.5) * 1.8;
  pBand[i] = Math.floor(Math.random() * BAND_COUNT) as number;
  pHue[i] = BAND_HUES[pBand[i]];
}

function initAll(w: number, h: number, count: number): void {
  px = new Float32Array(MAX_PARTICLES);
  py = new Float32Array(MAX_PARTICLES);
  pvx = new Float32Array(MAX_PARTICLES);
  pvy = new Float32Array(MAX_PARTICLES);
  pBand = new Uint8Array(MAX_PARTICLES);
  pHue = new Float32Array(MAX_PARTICLES);
  activeCount = Math.min(count, MAX_PARTICLES);
  for (let i = 0; i < activeCount; i++) spawnParticle(i, w, h);

  aScatterX.fill(0);
  aScatterY.fill(0);
  prevWidth = w;
  prevHeight = h;
  initialized = true;
}

function updateAttractorPositions(w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.27;
  for (let b = 0; b < BAND_COUNT; b++) {
    const a = ringAngle + (b / BAND_COUNT) * Math.PI * 2;
    aBaseX[b] = cx + Math.cos(a) * r;
    aBaseY[b] = cy + Math.sin(a) * r;
    aX[b] = aBaseX[b] + aScatterX[b];
    aY[b] = aBaseY[b] + aScatterY[b];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function resetMagnetosphere(): void {
  initialized = false;
  lastBeatIndex = -1;
  hueShift = 0;
  ringAngle = 0;
  trailBuf = null;
  prevWidth = 0;
  prevHeight = 0;
  activeCount = 0;
  aScatterX.fill(0);
  aScatterY.fill(0);
}

export function drawMagnetosphere(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const w = p.width;
  const h = p.height;

  const targetCount = Math.round(
    MIN_PARTICLES + config.magnetosphereParticles * (MAX_PARTICLES - MIN_PARTICLES)
  );
  // gravity: 0→0.04, 1→0.55
  const gravBase = 0.04 + config.magnetosphereGravity * 0.51;
  // trail: 0→fast fade (alpha 80), 1→slow fade (alpha 12)
  const fadeAlpha = Math.round(80 - config.magnetosphereTrail * 68);

  // Init or rebuild on resize
  if (!initialized || prevWidth !== w || prevHeight !== h) {
    initAll(w, h, targetCount);
    trailBuf = (p as any).createGraphics(w, h) as P5Graphics;
    trailBuf.background(0);
  }

  // Adjust active count dynamically
  if (targetCount > activeCount && activeCount < MAX_PARTICLES) {
    const add = Math.min(targetCount - activeCount, MAX_PARTICLES - activeCount);
    for (let i = activeCount; i < activeCount + add; i++) spawnParticle(i, w, h);
    activeCount += add;
  } else if (targetCount < activeCount) {
    activeCount = Math.max(MIN_PARTICLES, targetCount);
  }

  // Slow ring rotation
  ringAngle += 0.0005 * dt;
  updateAttractorPositions(w, h);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 24) % 360;
      const burst = 50 + amps[0] * 100;
      for (let b = 0; b < BAND_COUNT; b++) {
        const dx = aBaseX[b] - w / 2;
        const dy = aBaseY[b] - h / 2;
        const len = Math.sqrt(dx * dx + dy * dy) + 1;
        aScatterX[b] = (dx / len) * burst;
        aScatterY[b] = (dy / len) * burst;
      }
    }
  }

  // Ease scatter back
  for (let b = 0; b < BAND_COUNT; b++) {
    aScatterX[b] *= Math.pow(0.88, dt);
    aScatterY[b] *= Math.pow(0.88, dt);
  }

  // Overall energy
  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  // Update particles
  for (let i = 0; i < activeCount; i++) {
    let fx = 0;
    let fy = 0;
    let dominantBand = 0;
    let dominantScore = -1;

    for (let b = 0; b < BAND_COUNT; b++) {
      const dx = aX[b] - px[i];
      const dy = aY[b] - py[i];
      // soft min distance = 18px to avoid infinite force
      const distSq = dx * dx + dy * dy + 324;
      const dist = Math.sqrt(distSq);
      const amp = amps[b];

      // Score for dominant-band coloring (amp / dist)
      const score = amp / dist;
      if (score > dominantScore) {
        dominantScore = score;
        dominantBand = b;
      }

      // Gravity: F = G * amp / dist² (already divided by dist² via distSq)
      const grav = gravBase * amp / distSq;
      fx += dx * grav * dist; // = dx/dist * grav * dist² / dist = dx * gravBase * amp / dist
      fy += dy * grav * dist;
    }

    pvx[i] += fx * dt;
    pvy[i] += fy * dt;

    // Speed cap
    const spd = Math.sqrt(pvx[i] * pvx[i] + pvy[i] * pvy[i]);
    const maxSpd = 5.5 + energy * 3.5;
    if (spd > maxSpd) {
      pvx[i] = (pvx[i] / spd) * maxSpd;
      pvy[i] = (pvy[i] / spd) * maxSpd;
    }

    // Damping
    const damp = Math.pow(0.987, dt);
    pvx[i] *= damp;
    pvy[i] *= damp;

    px[i] += pvx[i] * dt;
    py[i] += pvy[i] * dt;

    // Respawn strays
    if (px[i] < -120 || px[i] > w + 120 || py[i] < -120 || py[i] > h + 120) {
      spawnParticle(i, w, h);
    }

    // Nudge hue toward dominant band
    pBand[i] = dominantBand;
    const targetHue = (BAND_HUES[dominantBand] + hueShift) % 360;
    let dh = ((targetHue - pHue[i] + 540) % 360) - 180;
    pHue[i] = (pHue[i] + dh * 0.04 * dt + 360) % 360;
  }

  // ── Trail buffer ────────────────────────────────────────────────────────
  if (trailBuf) {
    // Fade previous frame
    (trailBuf as any).noStroke();
    (trailBuf as any).fill(0, 0, 0, fadeAlpha);
    (trailBuf as any).rect(0, 0, w, h);

    // Draw particles onto trail
    (trailBuf as any).colorMode((p as any)['HSB'], 360, 100, 100, 100);
    (trailBuf as any).noStroke();
    for (let i = 0; i < activeCount; i++) {
      const amp = amps[pBand[i]];
      const bright = 65 + amp * 35;
      const sat = 72 + amp * 28;
      const alpha = 35 + amp * 55 + energy * 15;
      const sz = 1.2 + amp * 2.8;
      (trailBuf as any).fill(pHue[i], sat, bright, alpha);
      (trailBuf as any).ellipse(px[i], py[i], sz, sz);
    }

    // 3-pass glow for high-energy particles (sparse pass, every 4th)
    for (let i = 0; i < activeCount; i += 4) {
      const amp = amps[pBand[i]];
      if (amp < 0.25) continue;
      const alpha = amp * 18;
      (trailBuf as any).fill(pHue[i], 60, 100, alpha);
      (trailBuf as any).ellipse(px[i], py[i], amp * 12 + 4, amp * 12 + 4);
    }

    (trailBuf as any).colorMode((p as any)['RGB'], 255);
  }

  // ── Main canvas ─────────────────────────────────────────────────────────
  p.background(0);
  if (trailBuf) p.image(trailBuf as unknown as P5Image, 0, 0);

  // Draw attractor halos
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  (p as any).noStroke();
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.03) continue;
    const hue = (BAND_HUES[b] + hueShift) % 360;
    // Wide soft glow
    (p as any).fill(hue, 55, 85, amp * 22);
    p.ellipse(aX[b], aY[b], amp * 70 + 28, amp * 70 + 28);
    // Mid ring
    (p as any).fill(hue, 70, 95, amp * 50);
    p.ellipse(aX[b], aY[b], amp * 26 + 10, amp * 26 + 10);
    // Bright core
    (p as any).fill(hue, 30, 100, amp * 90);
    p.ellipse(aX[b], aY[b], amp * 10 + 3, amp * 10 + 3);
  }

  (p as any).colorMode(p['RGB'], 255);
}
