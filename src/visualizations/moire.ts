/**
 * Moire visualization — Bridget Riley / op-art inspired.
 *
 * Two layered fields of concentric rings drift apart from each other, generating
 * moving moire interference bands. A third layer of radial spokes rotates with
 * upper-mid-driven speed. On every detected beat the palette flips through
 * Riley-style dual-hue combos with a hue-tinted flash.
 *
 * Distinct from `interference.ts` (Ryoji Ikeda barcode-stripes at 7 angles) —
 * this is Bridget Riley concentric-ring op-art with radial spokes and dual
 * high-contrast palettes.
 *
 * Inspired by: Bridget Riley, "Blaze" (1964) and "Current" (1964)
 * — https://www.tate.org.uk/art/artworks/riley-blaze-l02135
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandData } from './helpers';
import { BAND_COUNT, SPIKES_PER_BAND } from '../utils/constants';

// Riley-style dual-hue palettes (each entry: [hue, sat, brightness]).
const PALETTES: [number, number, number][] = [
  [0, 0, 100],     // pure white (mono)
  [340, 85, 100],  // magenta
  [200, 90, 100],  // cyan
  [45, 90, 100],   // amber
  [280, 80, 100],  // violet
];

let paletteIdx = 0;
let paletteBlend = 1;
let ringPhase = 0;
let spokePhase = 0;
let beatFlash = 0;

export function resetMoire(): void {
  paletteIdx = 0;
  paletteBlend = 1;
  ringPhase = 0;
  spokePhase = 0;
  beatFlash = 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hueLerp(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

export function drawMoire(p: P5Instance, dt: number): void {
  const { state, config } = store;

  // Beat detection: advance palette + flash
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const idx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== state.lastBeatIndex) {
      state.lastBeatIndex = idx;
      paletteIdx = (paletteIdx + 1) % PALETTES.length;
      paletteBlend = 0;
      beatFlash = 1;
    }
  }
  beatFlash = Math.max(0, beatFlash - 0.06 * dt);
  paletteBlend = Math.min(1, paletteBlend + 0.035 * dt);

  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const minDim = Math.min(W, H);

  // Per-band amplitudes
  const bandAmp: number[] = new Array(BAND_COUNT);
  const spikeIdx = Math.floor(SPIKES_PER_BAND / 2);
  let totalAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    const d = getBandData(b, spikeIdx);
    const amp = Math.min(1.5, d.amp * d.tMult);
    bandAmp[b] = amp;
    totalAmp += amp;
  }
  const avgAmp = totalAmp / BAND_COUNT;

  const rings = Math.max(4, Math.round(config.moireRings));
  const interference = config.moireInterference;
  const contrast = config.moireContrast;

  ringPhase += dt * (0.02 + interference * 0.05);
  const spokeSpeed = 0.008 + bandAmp[4] * 0.06 + interference * 0.01;
  spokePhase += dt * spokeSpeed;

  const driftScale = minDim * (0.10 + interference * 0.14);
  const cAx = cx + (bandAmp[0] - 0.25) * driftScale + Math.sin(ringPhase * 0.7) * driftScale * 0.35;
  const cAy = cy + (bandAmp[1] - 0.25) * driftScale + Math.cos(ringPhase * 0.6) * driftScale * 0.30;
  const cBx = cx - (bandAmp[2] - 0.25) * driftScale - Math.sin(ringPhase * 0.9) * driftScale * 0.35;
  const cBy = cy - (bandAmp[3] - 0.25) * driftScale - Math.cos(ringPhase * 0.75) * driftScale * 0.30;

  const pA = PALETTES[paletteIdx];
  const pB = PALETTES[(paletteIdx + 1) % PALETTES.length];
  const hue = hueLerp(pA[0], pB[0], paletteBlend);
  const satBase = lerp(pA[1], pB[1], paletteBlend);
  const sat = satBase * (0.35 + bandAmp[5] * 0.65);
  const bri = lerp(pA[2], pB[2], paletteBlend);
  const hueOpposite = (hue + 180) % 360;

  const ctx = p.drawingContext;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 1);
  p.noFill();

  const maxRadius = Math.hypot(W, H) * 0.55;
  const ringSpacing = maxRadius / rings;
  const strokeBase = contrast * 1.1;
  const beatBoost = 1 + beatFlash * 0.5;

  // Layer A: concentric rings from cA
  const alphaA = (0.5 + beatFlash * 0.3 + avgAmp * 0.15) * beatBoost;
  p.stroke(hue, sat * 0.55, bri, Math.min(1, alphaA));
  p.strokeWeight(strokeBase);
  for (let i = 1; i <= rings; i++) {
    const wob = Math.sin(ringPhase * 2 + i * 0.35) * ringSpacing * (0.05 + bandAmp[3] * 0.08);
    const r = i * ringSpacing + wob;
    p.ellipse(cAx, cAy, r * 2, r * 2);
  }

  // Layer B: concentric rings from cB, opposite hue for stark op-art contrast
  const alphaB = (0.5 + beatFlash * 0.3 + avgAmp * 0.15) * beatBoost;
  p.stroke(hueOpposite, sat * 0.55, bri, Math.min(1, alphaB));
  p.strokeWeight(strokeBase);
  for (let i = 1; i <= rings; i++) {
    const wob = Math.cos(ringPhase * 2.3 + i * 0.28) * ringSpacing * (0.05 + bandAmp[2] * 0.08);
    const r = i * ringSpacing + wob;
    p.ellipse(cBx, cBy, r * 2, r * 2);
  }

  // Layer C: radial spokes from screen centre, rotating
  const spokeCount = Math.max(24, Math.round(rings * 1.5)) + Math.floor(bandAmp[6] * 40);
  const spokeAlpha = Math.min(1, 0.25 + bandAmp[4] * 0.35 + beatFlash * 0.3);
  p.stroke(hue, sat * 0.7, bri, spokeAlpha);
  p.strokeWeight(strokeBase * 0.55);
  const spokeR = Math.hypot(W, H) * 0.6;
  for (let i = 0; i < spokeCount; i++) {
    const a = (i / spokeCount) * Math.PI * 2 + spokePhase;
    p.line(cx, cy, cx + Math.cos(a) * spokeR, cy + Math.sin(a) * spokeR);
  }

  ctx.globalCompositeOperation = 'source-over';

  // Beat flash — subtle hue-tinted overlay
  if (beatFlash > 0.01) {
    p.noStroke();
    p.fill(hue, 15, 100, beatFlash * 0.12 * (0.6 + avgAmp * 0.4));
    p.rect(0, 0, W, H);
  }

  ctx.restore();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['RGB'], 255);
}
