/**
 * Synthwave — retro 80s perspective grid visualization.
 *
 * A cyan-magenta perspective grid floor scrolls toward the viewer beneath a
 * horizon with a striped glowing sun and audio-reactive mountain silhouette.
 * Seven freq bands drive mountain peak heights; beats pulse the sun and flash
 * the scene pink. All neon glow uses ADD blendMode.
 *
 * Sliders: Speed (scroll rate), Horizon (horizon height), Glow (neon intensity)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

let scrollOffset = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let sunPulse = 0;

export function resetSynthwave(): void {
  scrollOffset = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  sunPulse = 0;
}

export function interactSynthwave(event: import('../types').InteractionEvent): void {
  const { type } = event;
  if (type === 'tap' || type === 'key') {
    beatFlash = 1.0;
    sunPulse = 1.0;
  } else if (type === 'drag' || type === 'dragstart') {
    const dx = event.dx ?? 0;
    scrollOffset += dx * 200;
  }
}

// Cosine-interpolated mountain height at normalized x position (0–1)
function getMountainY(xNorm: number, horizonY: number, amps: number[], maxH: number): number {
  const t = xNorm * (BAND_COUNT - 1);
  const b0 = Math.min(Math.floor(t), BAND_COUNT - 2);
  const b1 = b0 + 1;
  const frac = t - b0;
  const cos_t = (1 - Math.cos(frac * Math.PI)) * 0.5;
  const amp = amps[b0] * (1 - cos_t) + amps[b1] * cos_t;
  return horizonY - amp * maxH;
}

export function drawSynthwave(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const idx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeatIndex) {
      lastBeatIndex = idx;
      beatFlash = 1.0;
      sunPulse = 1.0;
    }
  }
  beatFlash *= Math.pow(0.80, dt);
  sunPulse *= Math.pow(0.88, dt);

  scrollOffset += dt * config.synthwaveSpeed * 0.018;

  const cx = p.width * 0.5;
  const horizonY = p.height * config.synthwaveHorizon;
  const nearEdge = p.height;
  const focalLength = nearEdge - horizonY;
  const glow = config.synthwaveGlow;

  // --- Background ---
  // Sky: vertical gradient dark purple → near-black at horizon
  p.noStroke();
  for (let y = 0; y < horizonY; y += 4) {
    const t = y / horizonY;
    p.fill(6 + t * 14, 2 + t * 4, 18 + t * 10);
    p.rect(0, y, p.width, 4);
  }
  // Floor: flat very dark
  p.fill(4, 1, 14);
  p.rect(0, horizonY, p.width, nearEdge - horizonY);

  // --- Sun ---
  const avgAmp = amps.reduce((a, b) => a + b, 0) / BAND_COUNT;
  const sunRadius = Math.min(p.width * 0.12, focalLength * 0.48) * (1 + avgAmp * 0.3 + sunPulse * 0.28);

  // Sun glow halos (ADD)
  p.blendMode(p['ADD']);
  p.noStroke();
  p.fill(90, 18, 75, 7 * glow);
  p.ellipse(cx, horizonY, sunRadius * 5.2, sunRadius * 3.2);
  p.fill(130, 28, 105, 13 * glow);
  p.ellipse(cx, horizonY, sunRadius * 3.6, sunRadius * 2.3);
  p.fill(175, 55, 135, 24 * glow);
  p.ellipse(cx, horizonY, sunRadius * 2.3, sunRadius * 1.6);
  p.blendMode(p['BLEND']);

  // Sun body: horizontal gradient stripes, upper half only
  const stripeH = Math.max(2, sunRadius * 0.06);
  p.noStroke();
  for (let sy = Math.max(0, horizonY - sunRadius); sy <= horizonY; sy += stripeH) {
    const t = (horizonY - sy) / sunRadius; // 0 at horizon edge, 1 at sun top
    const dy = sy - horizonY;
    const dx = Math.sqrt(Math.max(0, sunRadius * sunRadius - dy * dy));
    // Yellow-white at top → orange → hot pink at horizon
    p.fill(255, 195 * t, 255 * (1 - t * 0.55));
    p.rect(cx - dx, sy, dx * 2, stripeH + 0.5);
  }

  // --- Mountain range ---
  const mountainMaxH = focalLength * 0.55 * (1 + avgAmp * 0.18);
  const MSTEPS = 80;

  // Glow outline (ADD, draw before fill so fill occludes halo bleed)
  p.blendMode(p['ADD']);
  p.noFill();
  const glowPasses: [number, number][] = [
    [14 * glow, 28],
    [6  * glow, 60],
    [2  * glow, 130],
  ];
  for (const [sw, sa] of glowPasses) {
    p.stroke(155, 40, 255, sa * glow);
    p.strokeWeight(sw);
    p.beginShape();
    p.curveVertex(-20, horizonY);
    p.curveVertex(-20, horizonY);
    for (let i = 0; i < BAND_COUNT; i++) {
      p.curveVertex(p.width * (i + 1) / (BAND_COUNT + 1), horizonY - amps[i] * mountainMaxH);
    }
    p.curveVertex(p.width + 20, horizonY);
    p.curveVertex(p.width + 20, horizonY);
    p.endShape();
  }
  p.blendMode(p['BLEND']);

  // Dark filled silhouette — polygon from horizon up over mountain profile and back to top corners
  // This hides whatever is behind the mountain peaks (sun, sky)
  p.noStroke();
  p.fill(5, 1, 15, 255);
  p.beginShape();
  p.vertex(-2, -2);
  p.vertex(p.width + 2, -2);
  // Mountain profile traced right→left
  for (let step = MSTEPS; step >= 0; step--) {
    const xNorm = step / MSTEPS;
    p.vertex(xNorm * p.width, getMountainY(xNorm, horizonY, amps, mountainMaxH));
  }
  p.endShape(p['CLOSE']);

  // --- Horizon glow line ---
  p.blendMode(p['ADD']);
  p.noFill();
  p.stroke(255, 90, 235, 55 * glow);
  p.strokeWeight(7);
  p.line(0, horizonY, p.width, horizonY);
  p.stroke(255, 150, 245, 130 * glow);
  p.strokeWeight(1.5);
  p.line(0, horizonY, p.width, horizonY);

  // --- Grid floor ---
  const NUM_H = 26; // horizontal scrolling lines
  const NUM_V = 19; // vertical fan lines per side (total = NUM_V*2+1)

  // Horizontal lines — scrolling toward viewer via t² perspective bunching
  for (let n = 0; n < NUM_H; n++) {
    const t = ((n / NUM_H) + scrollOffset) % 1;
    if (t < 0.006) continue;
    const screenY = horizonY + focalLength * t * t;
    if (screenY > nearEdge + 1) continue;

    const amp = amps[n % BAND_COUNT];
    const alpha = t; // brighter/wider near viewer
    const lineA = (30 + amp * 120) * alpha * glow;

    // Cyan lines with glow layering
    p.stroke(20 + amp * 70, 205 + amp * 50, 255, lineA * 0.45);
    p.strokeWeight(1.5 + t * 2.5);
    p.line(0, screenY, p.width, screenY);

    p.stroke(10, 228, 255, lineA);
    p.strokeWeight(Math.max(0.4, t * 1.5));
    p.line(0, screenY, p.width, screenY);
  }

  // Vertical fan lines — all converge to vanishing point at (cx, horizonY)
  const totalV = NUM_V * 2 + 1;
  for (let v = 0; v <= totalV; v++) {
    const xBottom = (v / totalV) * p.width;
    const edgeFactor = Math.abs(v / totalV - 0.5) * 2; // 0 center, 1 edges
    const bandIdx = Math.min(Math.floor(edgeFactor * BAND_COUNT), BAND_COUNT - 1);
    const amp = amps[bandIdx];
    const lineA = (22 + amp * 95) * glow;

    // Hot pink/magenta lines
    p.stroke(255, 25 + amp * 75, 200, lineA * 0.42);
    p.strokeWeight(1.8);
    p.line(xBottom, nearEdge, cx, horizonY);

    p.stroke(255, 18, 182, lineA);
    p.strokeWeight(0.55);
    p.line(xBottom, nearEdge, cx, horizonY);
  }

  p.blendMode(p['BLEND']);
  p.noStroke();

  // --- Beat flash overlay ---
  if (beatFlash > 0.01) {
    p.fill(215, 25, 195, beatFlash * 22);
    p.rect(0, 0, p.width, p.height);
  }
}
