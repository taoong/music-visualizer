/**
 * Phyllotaxis — audio-reactive golden-angle seed packing
 *
 * Inspired by John Edmark's kinetic "Blooms" sculptures (2014–present,
 * https://www.instructables.com/Blooms-Fibonacci-Zoetrope-Sculptures/) and the
 * mathematical phyllotaxis pattern found in sunflower seeds, pinecones, and
 * pineapple scales. Each seed is placed at successive multiples of the golden
 * angle (≈137.508°), producing the canonical Fibonacci spiral arrangement that
 * maximises packing efficiency. Here the whole lattice slowly rotates; at the
 * right speed, Fibonacci spiral arms emerge and dissolve — the same effect
 * that makes Edmark's strobe-lit sculptures appear to blossom. 7 concentric
 * radial zones map to frequency bands (sub-bass at core → brilliance at rim),
 * with band amplitude driving seed size and glow intensity. Beats scatter seeds
 * outward in a radial burst then ease them home.
 *
 * Sliders
 *   Seeds — total seed count (60–900)
 *   Spin  — rotation rate (slow drift → fast spiral-arm animation)
 *   Bloom — amplitude sensitivity (subtle pulse → dramatic blooming)
 */

import { audioEngine } from '../audio/engine';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { store } from '../state/store';
import { getBandAverages } from './helpers';

// Golden angle in radians
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad

const BAND_HUES: readonly number[] = [280, 240, 180, 120, 60, 30, 0];

// Per-seed scatter state
const MAX_SEEDS = isMobile ? 450 : 900;
const scatterVel = new Float32Array(MAX_SEEDS); // outward velocity (normalised)

let baseRotation = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let hueShift = 0;
let scatterDecay = 0; // 1 → 0 after a beat burst

export function resetPhyllotaxis(): void {
  baseRotation = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  hueShift = 0;
  scatterDecay = 0;
  scatterVel.fill(0);
}

export function drawPhyllotaxis(p: P5Instance, dt: number): void {
  const { amps, transients } = getBandAverages(BAND_COUNT);
  const { config, state } = store;

  const seedCount = Math.round(
    isMobile
      ? Math.min(config.phyllotaxisSeeds, isMobile ? 450 : 900)
      : config.phyllotaxisSeeds
  );
  const spin = config.phyllotaxisSpin;
  const bloom = config.phyllotaxisBloom;

  const W = p.width;
  const H = p.height;
  const cx = W * 0.5;
  const cy = H * 0.5;
  const maxR = Math.min(W, H) * 0.47;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      if (lastBeatIndex >= 0) {
        beatFlash = 1.0;
        hueShift = (hueShift + 51) % 360;
        scatterDecay = 1.0;
        // Give each seed an outward kick proportional to its index
        for (let i = 0; i < seedCount; i++) {
          scatterVel[i] = Math.sqrt(i / seedCount) * (0.25 + bloom * 0.4);
        }
      }
      lastBeatIndex = beatIdx;
    }
  }

  // Decay
  beatFlash *= Math.pow(0.88, dt);
  scatterDecay *= Math.pow(0.90, dt);
  for (let i = 0; i < seedCount; i++) {
    scatterVel[i] *= Math.pow(0.91, dt);
  }

  // Total energy for spin boost
  const totalAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;

  // Base rotation: slow ambient + amplitude boost + beat impulse
  const rotRate = (spin * 0.012 + totalAmp * 0.004 + beatFlash * 0.06) * dt;
  baseRotation += rotRate;

  // Background — opaque per frame (seeds carry their own trail via glow layers)
  p.blendMode(p['BLEND']);
  p.noStroke();
  p.fill(0, 0, 0, 34);
  p.rect(0, 0, W, H);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // Scale factor: sqrt(N) seeds fit in radius maxR with spacing ≈ maxR/sqrt(N)
  const scaleFactor = maxR / Math.sqrt(seedCount + 0.5);

  for (let i = 0; i < seedCount; i++) {
    // Phyllotaxis position (golden angle spiral)
    const theta = i * GOLDEN_ANGLE + baseRotation;
    const r = Math.sqrt(i + 0.5) * scaleFactor;

    // Scatter offset: push seed radially outward
    const scatter = scatterVel[i] * maxR;
    const rr = r + scatter;

    const x = cx + rr * Math.cos(theta);
    const y = cy + rr * Math.sin(theta);

    // Radial band index: inner = low freq, outer = high freq
    const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((r / maxR) * BAND_COUNT));
    const amp = amps[bandIdx];
    const tMult = transients[bandIdx];
    const transientBoost = Math.max(0, tMult - 1.0) * 0.3;

    // Size: smaller at low amp, larger when band is active
    const baseSize = isMobile ? 2.5 : 3.2;
    const size = baseSize * (0.4 + bloom * (amp * 2.8 + transientBoost));

    // Hue from band; brightness from amplitude
    const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
    const sat = 60 + amp * 40;
    const bri = Math.min(100, 20 + amp * 80 + beatFlash * 30 + transientBoost * 40);

    if (size < 0.4) continue; // skip invisible seeds

    // Three-pass additive glow
    p.blendMode(p['ADD']);
    // Outer halo
    p.noStroke();
    p.fill(hue, sat * 0.35, bri * 0.35, 30 + amp * 20);
    p.ellipse(x, y, size * 4.5, size * 4.5);
    // Mid bloom
    p.fill(hue, sat * 0.65, bri * 0.65, 55 + amp * 25);
    p.ellipse(x, y, size * 2.0, size * 2.0);
    // Bright core
    p.fill(hue, sat, Math.min(100, bri + 10), 70 + amp * 30);
    p.ellipse(x, y, size, size);
  }

  // Beat flash: soft white radial pulse fading outward
  if (beatFlash > 0.02) {
    p.blendMode(p['ADD']);
    for (let ring = 0; ring < 3; ring++) {
      const ringR = maxR * (0.15 + ring * 0.28) * (1 + beatFlash * 0.12);
      p.noFill();
      p.stroke(50, 20, 100, beatFlash * (35 - ring * 10));
      p.strokeWeight(3 + beatFlash * 8);
      p.ellipse(cx, cy, ringR * 2, ringR * 2);
    }
  }

  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
