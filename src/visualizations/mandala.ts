/**
 * Mandala — Concentric rotating shapes visualization.
 *
 * Several 2D shapes overlaid concentrically, each smaller than the last.
 * Bottom layer is a rotating grid. All shapes spin continuously with
 * rotation speeds that spike momentarily on each beat.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// ── Module state ────────────────────────────────────────────────────────────
let gridAngle = 0;
let hexAngle = 0;
let squareAngle = 0;
let triAngle = 0;
let circleAngle = 0;

let lastBeatIndex = -1;
let beatBoost = 0;

// ── Shape hue offsets (spread across spectrum) ──────────────────────────────
const SHAPE_HUE_OFFSETS = [200, 280, 40, 120, 320]; // grid, hex, square, tri, circle

export function drawMandala(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const cx = p.width / 2;
  const cy = p.height / 2;
  const baseSize = Math.min(p.width, p.height) * 0.42;

  // ── Beat detection ──────────────────────────────────────────────────────
  const beatFreq = Math.max(1, Math.round(config.mandalaBeatFreq));

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;

    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      if (currentBeatIndex % beatFreq === 0) {
        beatBoost = 1.0;
      }
    }
  }

  // Decay beat boost
  beatBoost *= Math.pow(0.92, dt);
  if (beatBoost < 0.001) beatBoost = 0;

  // ── Update angles ───────────────────────────────────────────────────────
  const boostMultiplier = 1.0 + beatBoost * 3.0;
  gridAngle   += config.mandalaGridSpeed   * 0.06 * dt * boostMultiplier;
  hexAngle    += config.mandalaHexSpeed    * 0.09 * dt * boostMultiplier;
  squareAngle += config.mandalaSquareSpeed * 0.075 * dt * boostMultiplier;
  triAngle    += config.mandalaTriSpeed    * 0.105 * dt * boostMultiplier;
  circleAngle += config.mandalaCircleSpeed * 0.09 * dt * boostMultiplier;

  // ── Overall audio energy for glow intensity ─────────────────────────────
  let energy = 0;
  for (let i = 0; i < amps.length; i++) energy += amps[i];
  energy /= amps.length;

  // ── Setup HSB color mode ────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── 1. Grid (bottom, largest) ───────────────────────────────────────────
  const gridSize = baseSize * 1.1;
  const gridLines = 12;
  const gridSpacing = (gridSize * 2) / gridLines;
  const gridHue = (SHAPE_HUE_OFFSETS[0] + amps[0] * 60) % 360;
  const gridAlpha = 30 + energy * 40;
  const gridWeight = 1 + amps[0] * 2;

  p.push();
  p.translate(cx, cy);
  p.rotate(gridAngle);
  (p as any).stroke(gridHue, 70, 50 + amps[0] * 40, gridAlpha);
  p.strokeWeight(gridWeight);
  (p as any).noFill();
  for (let i = 0; i <= gridLines; i++) {
    const pos = -gridSize + i * gridSpacing;
    p.line(pos, -gridSize, pos, gridSize);
    p.line(-gridSize, pos, gridSize, pos);
  }
  p.pop();

  // ── 2. Hexagon ──────────────────────────────────────────────────────────
  const hexSize = baseSize * 0.85;
  const hexHue = (SHAPE_HUE_OFFSETS[1] + amps[1] * 60) % 360;
  const hexBright = 60 + amps[1] * 40;
  const hexWeight = 2 + amps[1] * 3;

  p.push();
  p.translate(cx, cy);
  p.rotate(hexAngle);
  (p as any).stroke(hexHue, 80, hexBright, 70 + energy * 20);
  p.strokeWeight(hexWeight);
  (p as any).noFill();
  drawPolygon(p, 0, 0, hexSize, 6);
  (p as any).stroke(hexHue, 60, hexBright, 15 + beatBoost * 20);
  p.strokeWeight(hexWeight + 4 + beatBoost * 6);
  drawPolygon(p, 0, 0, hexSize, 6);
  p.pop();

  // ── 3. Square (diamond) ─────────────────────────────────────────────────
  const sqSize = baseSize * 0.65;
  const sqHue = (SHAPE_HUE_OFFSETS[2] + amps[2] * 60) % 360;
  const sqBright = 60 + amps[3] * 40;
  const sqWeight = 2 + amps[3] * 3;

  p.push();
  p.translate(cx, cy);
  p.rotate(squareAngle);
  (p as any).stroke(sqHue, 80, sqBright, 70 + energy * 20);
  p.strokeWeight(sqWeight);
  (p as any).noFill();
  drawPolygon(p, 0, 0, sqSize, 4);
  (p as any).stroke(sqHue, 60, sqBright, 15 + beatBoost * 20);
  p.strokeWeight(sqWeight + 4 + beatBoost * 6);
  drawPolygon(p, 0, 0, sqSize, 4);
  p.pop();

  // ── 4. Triangle ─────────────────────────────────────────────────────────
  const triSize = baseSize * 0.45;
  const triHue = (SHAPE_HUE_OFFSETS[3] + amps[4] * 60) % 360;
  const triBright = 60 + amps[4] * 40;
  const triWeight = 2.5 + amps[4] * 3;

  p.push();
  p.translate(cx, cy);
  p.rotate(triAngle);
  (p as any).stroke(triHue, 80, triBright, 70 + energy * 20);
  p.strokeWeight(triWeight);
  (p as any).noFill();
  drawPolygon(p, 0, 0, triSize, 3);
  (p as any).stroke(triHue, 60, triBright, 15 + beatBoost * 20);
  p.strokeWeight(triWeight + 4 + beatBoost * 6);
  drawPolygon(p, 0, 0, triSize, 3);
  p.pop();

  // ── 5. Circle (top, smallest) ───────────────────────────────────────────
  const circSize = baseSize * 0.28;
  const circHue = (SHAPE_HUE_OFFSETS[4] + amps[5] * 60) % 360;
  const circBright = 60 + amps[6] * 40;
  const circWeight = 2 + amps[6] * 3;

  p.push();
  p.translate(cx, cy);
  p.rotate(circleAngle);
  (p as any).stroke(circHue, 80, circBright, 70 + energy * 20);
  p.strokeWeight(circWeight);
  (p as any).noFill();
  p.ellipse(0, 0, circSize * 2, circSize * 2);
  (p as any).stroke(circHue, 60, circBright, 15 + beatBoost * 20);
  p.strokeWeight(circWeight + 4 + beatBoost * 6);
  p.ellipse(0, 0, circSize * 2, circSize * 2);
  p.pop();

  // ── Beat flash overlay ──────────────────────────────────────────────────
  if (beatBoost > 0.3) {
    (p as any).colorMode(p['RGB'], 255);
    (p as any).noStroke();
    (p as any).fill(255, 255, 255, beatBoost * 15);
    p.rect(0, 0, p.width, p.height);
    (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  }

  // Reset color mode
  (p as any).colorMode(p['RGB'], 255);
}

function drawPolygon(p: P5Instance, x: number, y: number, radius: number, sides: number): void {
  p.beginShape();
  for (let i = 0; i < sides; i++) {
    const angle = (Math.PI * 2 / sides) * i - Math.PI / 2;
    (p as any).vertex(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  }
  p.endShape(p['CLOSE']);
}

export function resetMandala(): void {
  gridAngle = 0;
  hexAngle = 0;
  squareAngle = 0;
  triAngle = 0;
  circleAngle = 0;
  lastBeatIndex = -1;
  beatBoost = 0;
}
