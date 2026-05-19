/**
 * Constellation — Living star field network visualization.
 *
 * Particles drift across the screen like stars. When close enough, they form
 * glowing connection lines creating a network graph. Frequency bands drive
 * star brightness/size by screen region. Beats trigger gravitational pulses
 * that push stars outward then pull them back.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ───────────────────────────────────────────────────────────────
const MAX_STARS = isMobile ? 200 : 400;
const MIN_STARS = 40;

// ── Palette: cold star field — deep cyan-white field, gold beat-flash accent ─
const STAR_HUE_BASE = 210; // deep cyan-blue
const STAR_HUE_JITTER = 14; // per-star tiny variation, stays in cool family
const FLASH_HUE = 45; // gold accent on beat

// ── Star data (SoA for cache friendliness) ──────────────────────────────────
let x: Float32Array;
let y: Float32Array;
let vx: Float32Array;
let vy: Float32Array;
let size: Float32Array;
let hue: Float32Array;
let flashGold: Float32Array; // per-star gold flash, decays each frame
let starCount = 0;

let lastBeatIndex = -1;
let beatPulse = 0; // decays from 1→0 on beat
let initialized = false;
let prevWidth = 0;
let prevHeight = 0;

// ── Init ────────────────────────────────────────────────────────────────────

function initStars(w: number, h: number, count: number): void {
  starCount = count;
  x = new Float32Array(MAX_STARS);
  y = new Float32Array(MAX_STARS);
  vx = new Float32Array(MAX_STARS);
  vy = new Float32Array(MAX_STARS);
  size = new Float32Array(MAX_STARS);
  hue = new Float32Array(MAX_STARS);
  flashGold = new Float32Array(MAX_STARS);

  for (let i = 0; i < starCount; i++) {
    x[i] = Math.random() * w;
    y[i] = Math.random() * h;
    vx[i] = (Math.random() - 0.5) * 0.8;
    vy[i] = (Math.random() - 0.5) * 0.8;
    size[i] = 1.5 + Math.random() * 3;
    hue[i] = STAR_HUE_BASE + (Math.random() - 0.5) * 2 * STAR_HUE_JITTER;
    flashGold[i] = 0;
  }

  prevWidth = w;
  prevHeight = h;
  initialized = true;
}

// ── Draw ────────────────────────────────────────────────────────────────────

export function drawConstellation(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Derive star count from slider (0–1 → MIN_STARS–MAX_STARS)
  const targetCount = Math.round(MIN_STARS + config.constellationStarCount * (MAX_STARS - MIN_STARS));
  const connRange = 60 + config.constellationConnRange * 240; // 60–300 px
  const driftSpeed = 0.1 + config.constellationDriftSpeed * 2.0; // 0.1–2.1

  // Init or resize
  if (!initialized || prevWidth !== w || prevHeight !== h) {
    initStars(w, h, targetCount);
  }

  // Adjust star count dynamically
  if (targetCount > starCount && starCount < MAX_STARS) {
    const add = Math.min(targetCount - starCount, MAX_STARS - starCount);
    for (let i = starCount; i < starCount + add; i++) {
      x[i] = Math.random() * w;
      y[i] = Math.random() * h;
      vx[i] = (Math.random() - 0.5) * 0.8;
      vy[i] = (Math.random() - 0.5) * 0.8;
      size[i] = 1.5 + Math.random() * 3;
      hue[i] = STAR_HUE_BASE + (Math.random() - 0.5) * 2 * STAR_HUE_JITTER;
      flashGold[i] = 0;
    }
    starCount += add;
  } else if (targetCount < starCount) {
    starCount = Math.max(MIN_STARS, targetCount);
  }

  // ── Beat detection ──────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatPulse = 1.0;
      // Light up a random subset of stars with a brief gold flash
      const flashCount = Math.max(3, Math.floor(starCount * 0.18));
      for (let k = 0; k < flashCount; k++) {
        flashGold[Math.floor(Math.random() * starCount)] = 1.0;
      }
    }
  }

  // Decay beat pulse
  beatPulse *= Math.pow(0.90, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  // ── Overall energy ────────────────────────────────────────────────────
  let energy = 0;
  for (let i = 0; i < amps.length; i++) energy += amps[i];
  energy /= amps.length;

  // ── Update star positions ─────────────────────────────────────────────
  const cx = w / 2;
  const cy = h / 2;

  for (let i = 0; i < starCount; i++) {
    // Map star to frequency band based on horizontal position
    const bandIdx = Math.min(6, Math.floor((x[i] / w) * 7));
    const bandAmp = amps[Math.max(0, bandIdx)];

    // Beat pulse: impulse push outward from center (single frame)
    if (beatPulse > 0.95) {
      const dx = x[i] - cx;
      const dy = y[i] - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) + 1;
      const pushStrength = 3.0 + bandAmp * 4.0;
      vx[i] += (dx / dist) * pushStrength;
      vy[i] += (dy / dist) * pushStrength;
    }

    // Amplitude-driven jitter: stars vibrate with their band's energy
    vx[i] += (Math.random() - 0.5) * bandAmp * 1.2 * dt;
    vy[i] += (Math.random() - 0.5) * bandAmp * 1.2 * dt;

    // Gentle pull toward center to keep stars on screen
    const dx = x[i] - cx;
    const dy = y[i] - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) + 1;
    const maxDist = Math.min(w, h) * 0.4;
    // Always a slight pull, stronger past maxDist
    const basePull = 0.003 * energy;
    const edgePull = dist > maxDist ? 0.05 * ((dist - maxDist) / maxDist) : 0;
    vx[i] -= (dx / dist) * (basePull + edgePull) * dt;
    vy[i] -= (dy / dist) * (basePull + edgePull) * dt;

    // Apply drift — amplitude boosts movement speed
    const ampBoost = 1.0 + bandAmp * 2.0 + beatPulse * 1.5;
    x[i] += vx[i] * driftSpeed * ampBoost * dt;
    y[i] += vy[i] * driftSpeed * ampBoost * dt;

    // Dampen velocity
    const dampen = Math.pow(0.96, dt);
    vx[i] *= dampen;
    vy[i] *= dampen;

    // Add subtle random drift
    vx[i] += (Math.random() - 0.5) * 0.05 * dt;
    vy[i] += (Math.random() - 0.5) * 0.05 * dt;

    // Wrap around edges with margin
    const margin = 20;
    if (x[i] < -margin) x[i] += w + margin * 2;
    if (x[i] > w + margin) x[i] -= w + margin * 2;
    if (y[i] < -margin) y[i] += h + margin * 2;
    if (y[i] > h + margin) y[i] -= h + margin * 2;

    // Audio-reactive size only — hue stays in the cool-blue family,
    // beats blend in a brief gold flash (decayed per-frame below).
    size[i] = 1.5 + bandAmp * 8 + beatPulse * 4;

    // Decay each star's gold flash. Fast decay keeps the accent brief.
    flashGold[i] *= Math.pow(0.82, dt);
    if (flashGold[i] < 0.01) flashGold[i] = 0;
  }

  // ── Render ────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Draw connections first (behind stars)
  const connRangeSq = connRange * connRange;
  for (let i = 0; i < starCount; i++) {
    for (let j = i + 1; j < starCount; j++) {
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      const distSq = dx * dx + dy * dy;

      if (distSq < connRangeSq) {
        const dist = Math.sqrt(distSq);
        const alpha = (1 - dist / connRange) * (20 + energy * 40 + beatPulse * 20);
        // Connections stay icy-blue with low sat — never tinted gold.
        const lineHue = (hue[i] + hue[j]) / 2;
        (p as any).stroke(lineHue, 25, 88 + energy * 12, alpha);
        p.strokeWeight(0.5 + energy * 1.5 + beatPulse);
        p.line(x[i], y[i], x[j], y[j]);
      }
    }
  }

  // Draw stars
  (p as any).noStroke();
  for (let i = 0; i < starCount; i++) {
    const s = size[i];
    const bright = 50 + energy * 40 + beatPulse * 10;
    const alpha = 60 + energy * 35;

    // Blend each star's resting cool-blue toward gold on flash. Hue lerp
    // is short-path (210°→45° goes through 360/0), so subtract 360 from
    // the blue endpoint when blending toward gold.
    const f = flashGold[i];
    const blueHue = hue[i] - 360; // pulls into negative so 45° lerp is short-path
    const flashHue = ((1 - f) * blueHue + f * FLASH_HUE + 360) % 360;
    const flashSat = 28 + f * 70; // resting cool stars are low-sat; flash is vivid
    const flashBright = bright + f * 30;

    // Glow layer
    (p as any).fill(flashHue, flashSat, flashBright, alpha * 0.3);
    p.ellipse(x[i], y[i], s * 3, s * 3);

    // Core
    (p as any).fill(flashHue, flashSat * 0.85, Math.min(100, flashBright + 20), alpha);
    p.ellipse(x[i], y[i], s, s);
  }

  // Beat flash
  if (beatPulse > 0.5) {
    (p as any).fill(0, 0, 100, beatPulse * 8);
    (p as any).noStroke();
    p.rect(0, 0, w, h);
  }

  // Reset color mode
  (p as any).colorMode(p['RGB'], 255);
}

export function resetConstellation(): void {
  initialized = false;
  lastBeatIndex = -1;
  beatPulse = 0;
  starCount = 0;
  prevWidth = 0;
  prevHeight = 0;
}
