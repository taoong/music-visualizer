/**
 * Optical — Audio-reactive Op-Art grid inspired by Victor Vasarely's "Vega-Nor" series (1969).
 *
 * A uniform NxN grid of circles fills the canvas. Each circle's size is modulated by a
 * superposition of 7 audio-band sinusoidal waves (one per frequency band at increasing
 * spatial frequencies) plus a central Vasarely dome illusion, making the flat grid
 * appear to bulge and ripple in three dimensions. Beat fires a radial shockwave from
 * canvas centre that briefly swells every circle it passes through. The Color slider
 * morphs from pure monochrome (classic Vasarely) to full HSB chromatic mode.
 *
 * Sliders
 *   opticalGrid  — grid density (sparse large circles → dense small circles)
 *   opticalBulge — distortion amplitude (subtle ripple → extreme warp)
 *   opticalColor — palette: 0 = black/white, 1 = full chromatic
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band hue (violet → magenta → red → orange → yellow → teal → sky)
const BAND_HUES: readonly number[] = [270, 300, 10, 35, 60, 170, 210];

// ── Module state ──────────────────────────────────────────────────────────────
let lastBeatIndex = -1;
let shockRadius = 0;
let shockStrength = 0;
let globalHueShift = 0;
let time = 0;

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawOptical(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Sliders
  const gridSlider  = config.opticalGrid;   // 0–1
  const bulgeSlider = config.opticalBulge;  // 0–1
  const colorSlider = config.opticalColor;  // 0–1

  // Grid density: 6 on mobile to keep 60 fps
  const maxCells = isMobile ? 20 : 32;
  const N = Math.round(6 + gridSlider * (maxCells - 6));
  const cellW = w / N;
  const cellH = h / N;
  // Maximum inscribed circle radius (leave a 10 % gap between circles)
  const cellR = Math.min(cellW, cellH) * 0.45;

  time += dt * 0.016;  // ~1 unit/sec at 60 fps

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      shockRadius = 0;
      shockStrength = 1.0;
      globalHueShift = (globalHueShift + 37) % 360;
    }
  }

  // Shockwave decay (expands ~400 px/s, fades over ~0.8 s)
  shockRadius += 400 * dt * 0.016;
  shockStrength *= Math.pow(0.92, dt);
  if (shockStrength < 0.004) shockStrength = 0;

  // ── Background ─────────────────────────────────────────────────────────────
  (p as any).colorMode(p['RGB'], 255);
  p.background(0);
  p.noStroke();

  const halfW = w * 0.5;
  const halfH = h * 0.5;
  const shockBandPx = cellR * 3 + 30;

  // ── Draw grid ──────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const cx = (gx + 0.5) * cellW;
      const cy = (gy + 0.5) * cellH;

      // Normalised position [-1, 1]
      const nx = (cx / w) * 2 - 1;
      const ny = (cy / h) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);  // 0..~1.41

      // ── Vasarely dome illusion ──────────────────────────────────────────
      // Circles swell toward the centre like a virtual convex sphere
      const dome = Math.max(0, 1 - r * 0.72);  // 1 at centre → 0 at corner

      // ── Per-band audio waves ────────────────────────────────────────────
      // Band b → spatial frequency (1 + b * 1.5) → b=0 is low-freq, b=6 is high-freq
      // This means bass creates large-scale undulations; treble creates fine shimmer
      let audioDistortion = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const amp = amps[b];
        if (amp < 0.004) continue;
        const sf = (1.0 + b * 1.5) * Math.PI;  // spatial frequency
        const phase = time * (0.18 + b * 0.07) + b * 1.1;
        // 2-D standing wave: axis rotated per band so patterns differ visually
        const angle = (b / BAND_COUNT) * Math.PI;
        const u = nx * Math.cos(angle) + ny * Math.sin(angle);
        const v = -nx * Math.sin(angle) + ny * Math.cos(angle);
        const wave = Math.sin(u * sf + phase) * Math.cos(v * sf * 0.75 + phase * 0.6);
        audioDistortion += amp * wave * (1.0 / BAND_COUNT);
      }

      // ── Shockwave ─────────────────────────────────────────────────────
      let shockContrib = 0;
      if (shockStrength > 0.004) {
        const dx = cx - halfW;
        const dy = cy - halfH;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const gap = Math.abs(dist - shockRadius);
        if (gap < shockBandPx) {
          const t01 = 1 - gap / shockBandPx;
          shockContrib = shockStrength * t01 * t01;
        }
      }

      // ── Combined distortion → circle radius ───────────────────────────
      const bulge = bulgeSlider;
      const distortion = dome * 0.55                        // base dome
                       + audioDistortion * bulge * 1.2     // audio waves
                       + shockContrib * bulge * 0.8;       // beat shockwave

      // Map [-∞…∞] to a radius: sigmoid-like, clamped to [0, 1]
      const t01 = Math.max(0, Math.min(1, distortion * 0.9 + 0.3));
      const radius = cellR * (0.06 + 0.94 * t01);

      if (radius < 1) continue;

      // ── Colour ─────────────────────────────────────────────────────────
      if (colorSlider < 0.01) {
        // Pure B&W: white circle on black bg
        (p as any).fill(0, 0, t01 > 0.35 ? 5 + t01 * 95 : 0);
      } else {
        // Find dominant band for hue
        let domBand = 0;
        let domAmp = 0;
        for (let b = 0; b < BAND_COUNT; b++) {
          if (amps[b] > domAmp) { domAmp = amps[b]; domBand = b; }
        }
        const baseHue = BAND_HUES[domBand];
        const hue = (baseHue + globalHueShift + t01 * 60 - 30) % 360;
        const sat = colorSlider * 100 * (0.3 + t01 * 0.7);
        const bri = 10 + t01 * 90;
        const alpha = 60 + t01 * 40;
        (p as any).fill((hue + 360) % 360, sat, bri, alpha);
      }

      p.ellipse(cx, cy, radius * 2, radius * 2);
    }
  }

  // Outer glow pass at high colour values (subtle bloom effect)
  if (colorSlider > 0.3) {
    let domBand = 0;
    let domAmp = 0;
    for (let b = 0; b < BAND_COUNT; b++) {
      if (amps[b] > domAmp) { domAmp = amps[b]; domBand = b; }
    }
    if (domAmp > 0.25) {
      const hue = (BAND_HUES[domBand] + globalHueShift) % 360;
      const glowAlpha = domAmp * colorSlider * 8;
      (p as any).fill(hue, 80, 100, glowAlpha);
      // paint a radial glow at the distortion peaks — draw a large soft circle at centre
      p.ellipse(halfW, halfH, Math.min(w, h) * 0.6, Math.min(w, h) * 0.6);
    }
  }

  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
export function resetOptical(): void {
  lastBeatIndex = -1;
  shockRadius = 0;
  shockStrength = 0;
  globalHueShift = 0;
  time = 0;
}
