/**
 * Kaleidoscope visualization
 *
 * Audio-reactive kaleidoscope: 7 frequency bands drive concentric arcs and radial
 * spokes within a wedge that is rotated and mirror-flipped to fill the screen.
 * Beats shift the hue palette and trigger zoom pulses. The result is a constantly
 * morphing crystal / gem pattern that reacts to every element of the music.
 *
 * Sliders: Segments (symmetry), Zoom, Speed
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// --- Module-scoped state ---
let baseRotation = 0;
let hueOffset = 0;
let zoomPulse = 0;
let beatFlash = 0;
let lastBeatIndex = -1;
let noiseT = 0;

export function drawKaleidoscope(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  const { amps, transients } = getBandAverages(bandCount);

  // --- Beat detection ---
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatFlash = 1.0;
      hueOffset = (hueOffset + 20 + Math.random() * 20) % 360;
      zoomPulse = 0.12;
    }
  }

  // --- Decay ---
  beatFlash *= Math.pow(0.78, dt);
  zoomPulse *= Math.pow(0.84, dt);
  if (beatFlash < 0.005) beatFlash = 0;

  const segments = Math.max(3, Math.min(16, Math.round(config.kaleidoscopeSegments)));
  const zoom = config.kaleidoscopeZoom;
  const speed = config.kaleidoscopeSpeed;

  noiseT += 0.004 * dt;
  baseRotation += 0.003 * speed * dt;

  const cx = p.width / 2;
  const cy = p.height / 2;
  const maxR = Math.min(p.width, p.height) * 0.48 * zoom * (1 + zoomPulse);
  const wedgeAngle = (Math.PI * 2) / segments;

  // Total energy
  let avgEnergy = 0;
  for (let b = 0; b < bandCount; b++) avgEnergy += amps[b];
  avgEnergy /= bandCount;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pAny = p as any;
  pAny.colorMode(p['HSB'], 360, 100, 100, 1.0);

  // --- Center glow ---
  p.noStroke();
  const glowHue = hueOffset % 360;
  for (let g = 3; g >= 0; g--) {
    const r = maxR * (0.12 + avgEnergy * 0.18) * (1 + g * 0.5);
    const alpha = (0.04 + avgEnergy * 0.07) * (1 - g * 0.2);
    pAny.fill(glowHue, 70, 100, Math.min(alpha, 0.35));
    p.ellipse(cx, cy, r * 2, r * 2);
  }

  // --- Kaleidoscope pattern ---
  p.push();
  p.translate(cx, cy);
  pAny.rotate(baseRotation);

  for (let seg = 0; seg < segments; seg++) {
    p.push();
    pAny.rotate(seg * wedgeAngle);
    // Mirror alternate segments for true kaleidoscope reflection
    if (seg % 2 === 1) pAny.scale(1, -1);
    drawWedge(p, pAny, amps, transients, bandCount, maxR, wedgeAngle, hueOffset, noiseT, avgEnergy);
    p.pop();
  }

  p.pop();

  // --- Beat flash overlay ---
  if (beatFlash > 0.005) {
    pAny.fill((hueOffset + 30) % 360, 30, 100, beatFlash * 0.22);
    p.noStroke();
    p.rect(0, 0, p.width, p.height);
  }

  p.colorMode(p['RGB'], 255);
}

function drawWedge(
  p: P5Instance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pAny: any,
  amps: number[],
  transients: number[],
  bandCount: number,
  maxR: number,
  wedgeAngle: number,
  hueOffset: number,
  noiseT: number,
  avgEnergy: number
): void {
  const useBands = Math.min(bandCount, 7);

  // --- Phase 1: transparent filled wedge slices (create crystal-facet depth) ---
  for (let b = 0; b < useBands; b++) {
    const amp = amps[b] || 0;
    const bFrac = b / Math.max(useBands - 1, 1);
    const hue = (hueOffset + bFrac * 260) % 360;

    const noiseVal = (pAny.noise(b * 0.5 + noiseT, noiseT * 0.7) - 0.5) * 0.12;
    const arcR = maxR * (0.13 + bFrac * 0.72 + amp * 0.22 + noiseVal);

    pAny.fill(hue, 60, 90, 0.04 + amp * 0.05);
    p.noStroke();
    p.arc(0, 0, arcR * 2, arcR * 2, 0, wedgeAngle, p['PIE'] as number);
  }

  // --- Phase 2: arc strokes with multi-pass glow ---
  p.noFill();
  for (let b = 0; b < useBands; b++) {
    const amp = amps[b] || 0;
    const tMult = transients[b] || 1;
    const bFrac = b / Math.max(useBands - 1, 1);
    const hue = (hueOffset + bFrac * 260) % 360;
    const sat = 65 + amp * 25;
    const bright = 70 + amp * 30;

    const noiseVal = (pAny.noise(b * 0.5 + noiseT, noiseT * 0.7) - 0.5) * 0.12;
    const arcR = maxR * (0.13 + bFrac * 0.72 + amp * 0.22 + noiseVal);

    const strokeBase = 1.5 + amp * 5 + (tMult > 1.5 ? (tMult - 1.5) * 4 : 0);

    // Outer glow
    pAny.stroke(hue, sat * 0.6, bright, 0.08 + avgEnergy * 0.05);
    p.strokeWeight(strokeBase * 3.5);
    p.arc(0, 0, arcR * 2, arcR * 2, 0, wedgeAngle);

    // Mid glow
    pAny.stroke(hue, sat, bright, 0.22 + amp * 0.18);
    p.strokeWeight(strokeBase * 1.6);
    p.arc(0, 0, arcR * 2, arcR * 2, 0, wedgeAngle);

    // Bright core
    pAny.stroke(hue, sat, 100, 0.65 + amp * 0.35);
    p.strokeWeight(Math.max(strokeBase * 0.5, 0.5));
    p.arc(0, 0, arcR * 2, arcR * 2, 0, wedgeAngle);
  }

  // --- Phase 3: radial spokes (gem facets) ---
  const totalEnergy = amps.slice(0, useBands).reduce((s, v) => s + v, 0) / useBands;
  for (let b = 0; b < useBands; b++) {
    const amp = amps[b] || 0;
    const bFrac = b / Math.max(useBands - 1, 1);
    const hue = (hueOffset + bFrac * 260) % 360;

    // Spoke at the angle dividing each sub-band's "slice" of the wedge
    const spokeAngle = wedgeAngle * (b + 0.5) / useBands;
    const noiseVal = (pAny.noise(b * 0.5 + noiseT, noiseT * 0.7) - 0.5) * 0.12;
    const spokeLen = maxR * (0.13 + bFrac * 0.72 + amp * 0.22 + noiseVal) * 0.92;
    const sx = Math.cos(spokeAngle) * spokeLen;
    const sy = Math.sin(spokeAngle) * spokeLen;

    pAny.stroke(hue, 55, 100, 0.18 + totalEnergy * 0.15 + amp * 0.2);
    p.strokeWeight(0.5 + amp * 1.8);
    p.noFill();
    p.line(0, 0, sx, sy);

    // Transient accent dot at spoke tip
    if (transients[b] > 1.25) {
      const tMult = transients[b];
      const dotSize = 2.5 + (tMult - 1) * 9;
      const alpha = Math.min((tMult - 1) * 0.7, 0.9);
      pAny.fill(hue, 45, 100, alpha);
      p.noStroke();
      p.ellipse(sx, sy, dotSize, dotSize);
    }
  }

  // --- Phase 4: wedge boundary line (subtle) ---
  pAny.stroke((hueOffset + 180) % 360, 30, 100, 0.08 + totalEnergy * 0.06);
  p.strokeWeight(0.4);
  p.noFill();
  p.line(0, 0, maxR * 0.95, 0);
}

export function resetKaleidoscope(): void {
  baseRotation = 0;
  hueOffset = 0;
  zoomPulse = 0;
  beatFlash = 0;
  lastBeatIndex = -1;
  noiseT = 0;
}
