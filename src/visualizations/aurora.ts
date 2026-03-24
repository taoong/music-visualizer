/**
 * Aurora Borealis visualization
 *
 * Layered curtains of light driven by 7 frequency bands.
 * Perlin noise shapes the curtain waves; beats trigger upward pulse sweeps.
 * Background stars twinkle, modulated by high-frequency energy.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// --- Stars ---
interface Star {
  x: number;
  y: number;
  baseBrightness: number;
  twinklePhase: number;
  twinkleSpeed: number;
}

let stars: Star[] = [];
const STAR_COUNT = 120;

// --- Beat pulse ---
let beatPulseY = -1;       // normalized 0..1, -1 = inactive
let beatPulseAlpha = 0;
let lastBeatIndex = -1;

// --- Animation ---
let noiseOffset = 0;
let horizonGlowHue = 160;  // teal default

// --- Canvas size cache ---
let prevW = 0;
let prevH = 0;

function initStars(w: number, h: number): void {
  stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h * 0.75, // upper 75% of screen
      baseBrightness: 30 + Math.random() * 50,
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.5 + Math.random() * 2.0,
    });
  }
}

export function drawAurora(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  // Re-init stars on resize
  if (p.width !== prevW || p.height !== prevH) {
    prevW = p.width;
    prevH = p.height;
    initStars(p.width, p.height);
  }
  if (stars.length === 0) {
    initStars(p.width, p.height);
  }

  const { amps, transients } = getBandAverages(bandCount);

  // Overall energy
  let totalEnergy = 0;
  for (let b = 0; b < bandCount; b++) totalEnergy += amps[b];
  const avgEnergy = totalEnergy / bandCount;

  // High-freq energy for star modulation
  const highEnergy = isFreqMode
    ? (amps[Math.min(5, bandCount - 1)] + amps[Math.min(6, bandCount - 1)]) / 2
    : amps[Math.min(4, bandCount - 1)];

  // Max transient
  let maxTransient = 1.0;
  for (let b = 0; b < bandCount; b++) {
    if (transients[b] > maxTransient) maxTransient = transients[b];
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatPulseY = 1.0;  // start at bottom
      beatPulseAlpha = 1.0;
    }
  }

  // Advance beat pulse upward
  if (beatPulseY >= 0) {
    beatPulseY -= 1.2 * dt * 0.016667; // sweep speed
    beatPulseAlpha *= Math.pow(0.92, dt);
    if (beatPulseY < -0.2 || beatPulseAlpha < 0.01) {
      beatPulseY = -1;
      beatPulseAlpha = 0;
    }
  }

  // Advance noise
  noiseOffset += 0.003 * dt * (1 + avgEnergy * 2);

  // Update horizon hue from centroid
  const centroid = store.audioState.smoothedCentroid;
  horizonGlowHue += ((120 + centroid * 180) - horizonGlowHue) * 0.05 * dt;

  const scale = config.spikeScale;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;
  pAny.colorMode(p['HSB'], 360, 100, 100, 1.0);
  p.noStroke();

  // --- Background: solid black already drawn by main.ts ---

  // --- Stars ---
  for (const star of stars) {
    star.twinklePhase += star.twinkleSpeed * dt * 0.05;
    const twinkle = Math.sin(star.twinklePhase) * 0.5 + 0.5;
    const highBoost = highEnergy * 40;
    const beatFlash = beatPulseAlpha * 20;
    const brightness = Math.min(star.baseBrightness + twinkle * 25 + highBoost + beatFlash, 100);
    pAny.fill(220, 10, brightness, 0.8);
    p.ellipse(star.x, star.y, 2, 2);
  }

  // --- Aurora curtains ---
  const curtainCount = Math.min(bandCount, 7);
  // Hue range: green(140) → purple/magenta(300)
  const hueStart = 140;
  const hueEnd = 300;

  for (let b = 0; b < curtainCount; b++) {
    const amp = Math.min(amps[b] * scale, 1.0);
    const tMult = transients[b];

    // Curtain hue
    const hue = hueStart + (b / (curtainCount - 1 || 1)) * (hueEnd - hueStart);
    // Base vertical position: lower bands near bottom, higher bands higher up
    const baseY = p.height * (0.75 - (b / curtainCount) * 0.35);
    // Curtain height driven by amplitude
    const curtainHeight = p.height * (0.15 + amp * 0.35);

    // Transient brightness boost
    const transientBoost = tMult > 1.5 ? (tMult - 1) * 30 : 0;

    // Beat pulse interaction
    let beatBoost = 0;
    if (beatPulseY >= 0) {
      const pulseWorldY = p.height * beatPulseY;
      const distToPulse = Math.abs(baseY - pulseWorldY);
      if (distToPulse < p.height * 0.15) {
        beatBoost = (1 - distToPulse / (p.height * 0.15)) * beatPulseAlpha * 40;
      }
    }

    // Draw curtain as a series of vertical strips with noise-driven wave
    const stripWidth = 6;
    const numStrips = Math.ceil(p.width / stripWidth) + 1;

    for (let s = 0; s < numStrips; s++) {
      const x = s * stripWidth;
      // Perlin noise for wave shape — each band has offset layer
      const nx = x * 0.003 + noiseOffset + b * 10;
      const ny = b * 50 + noiseOffset * 0.5;
      const noiseVal = pAny.noise(nx, ny);

      // Wave displacement
      const wave = (noiseVal - 0.5) * 2 * curtainHeight * 0.6;
      const topY = baseY - curtainHeight + wave;
      const bottomY = baseY + wave * 0.3;

      // Vertical gradient: bright at bottom, transparent at top
      const saturation = 60 + amp * 30;
      const baseBright = 30 + amp * 50 + transientBoost + beatBoost;
      const bright = Math.min(baseBright, 100);
      const alphaBottom = Math.min(0.15 + amp * 0.4, 0.55);
      const alphaTop = 0;

      // Draw gradient strip with 3 segments
      const midY = topY + (bottomY - topY) * 0.5;
      const alphaMid = alphaBottom * 0.4;

      // Bottom segment (brightest)
      pAny.fill(hue, saturation, bright, alphaBottom);
      p.rect(x, midY, stripWidth, bottomY - midY);

      // Top segment (fading)
      pAny.fill(hue, saturation, bright * 0.7, alphaMid);
      p.rect(x, topY, stripWidth, midY - topY);

      // Very top wisp
      const wispH = curtainHeight * 0.2;
      pAny.fill(hue, saturation * 0.5, bright * 0.4, alphaTop + 0.02);
      p.rect(x, topY - wispH, stripWidth, wispH);
    }
  }

  // --- Beat pulse horizontal band ---
  if (beatPulseY >= 0) {
    const pulseWorldY = p.height * beatPulseY;
    const bandHeight = 40;
    for (let i = 0; i < 3; i++) {
      const spread = i * bandHeight;
      const alpha = beatPulseAlpha * (0.3 - i * 0.1);
      pAny.fill(180, 30, 100, Math.max(alpha, 0));
      p.rect(0, pulseWorldY - spread / 2, p.width, spread || 2);
    }
  }

  // --- Horizon glow ---
  const glowHeight = 80 + avgEnergy * 60;
  const glowY = p.height - glowHeight;
  for (let i = 0; i < 5; i++) {
    const frac = i / 5;
    const y = glowY + frac * glowHeight;
    const h = glowHeight / 5;
    const alpha = (1 - frac) * (0.08 + avgEnergy * 0.15);
    pAny.fill(horizonGlowHue, 50, 80 + avgEnergy * 20, alpha);
    p.rect(0, y, p.width, h);
  }

  // --- Transient flash overlay ---
  if (maxTransient > 1.5) {
    const flashAlpha = Math.min((maxTransient - 1.5) * 0.08, 0.15);
    pAny.fill(180, 20, 100, flashAlpha);
    p.rect(0, 0, p.width, p.height);
  }

  // Reset color mode
  p.colorMode(p['RGB'], 255);
}

export function resetAurora(): void {
  stars = [];
  beatPulseY = -1;
  beatPulseAlpha = 0;
  lastBeatIndex = -1;
  noiseOffset = 0;
  horizonGlowHue = 160;
  prevW = 0;
  prevH = 0;
}
