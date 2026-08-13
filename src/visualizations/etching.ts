/**
 * Etching — audio-reactive engraving visualization.
 *
 * Inspired by Albrecht Dürer's copper-plate engravings (c. 1507–1528) and the
 * generative pen-plotter work of Tyler Hobbs, whose "Fidenza" (2021) series
 * pioneered hatching-line density as an expressive medium in computational art.
 * The canvas is divided into 7 vertical zones (sub-bass at the left through
 * brilliance at the right). Each zone is filled with sinusoidally oscillating
 * horizontal strokes: denser, more agitated lines indicate higher amplitude in
 * that frequency band. Colors follow the violet→blue→teal→green→yellow→orange
 * →magenta rainbow palette. A beat fires a synchronised phase-jump that snaps
 * all zones to new oscillation angles simultaneously, imitating the moment a
 * new copper plate takes over from the last.
 *
 * Sliders
 *   Lines — horizontal line density (3–20 strokes per zone)
 *   Wave  — spatial oscillation frequency (0 = gentle undulation, 1 = tight scribble)
 *   Glow  — stroke brightness and additive halo width
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per frequency band: violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES = [270, 230, 185, 130, 70, 28, 300] as const;

let animTime = 0;
let lastBeatIdx = -1;
let beatFlash = 0;
let phaseShift = 0; // accumulated jump on each beat

export function resetEtching(): void {
  animTime = 0;
  lastBeatIdx = -1;
  beatFlash = 0;
  phaseShift = 0;
}

export function drawEtching(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const W = p.width;
  const H = p.height;
  const ctx = p.drawingContext as CanvasRenderingContext2D;

  // Slider-driven parameters
  const maxLines   = Math.max(3, Math.min(isMobile ? 12 : 20, Math.round(config.etchingLines)));
  const waveT      = config.etchingWave;  // 0–1
  const glow       = config.etchingGlow;  // 0–1

  // Spatial oscillation: high waveT = many cycles per zone
  const zoneW      = W / BAND_COUNT;
  const wavePeriod = zoneW / (0.6 + waveT * 3.4); // pixels per full cycle

  // Maximum vertical deviation of each line
  const maxDeviation = H * (0.022 + waveT * 0.015);

  animTime += dt * 0.006;

  // Beat detection
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeatIdx) {
      lastBeatIdx = idx;
      onBeat = true;
    }
  }
  if (onBeat) {
    beatFlash  = 0.55;
    phaseShift += Math.PI * (0.6 + (animTime % 1) * 0.8); // pseudo-random shift driven by time
  }
  beatFlash *= Math.pow(0.86, dt);

  // Background
  ctx.fillStyle = '#040508';
  ctx.fillRect(0, 0, W, H);

  const step = isMobile ? 3 : 2; // pixel step for path sub-sampling

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.008) continue;

    const hue      = BAND_HUES[b];
    const zoneLeft = b * zoneW;

    // Clip to zone so oscillating lines don't bleed into adjacent zones
    ctx.save();
    ctx.beginPath();
    ctx.rect(zoneLeft, 0, zoneW, H);
    ctx.clip();

    const bandPhase = b * 0.91 + animTime + phaseShift;

    for (let l = 0; l < maxLines; l++) {
      const yBase   = (l + 1) / (maxLines + 1) * H;
      const lPhase  = bandPhase + l * 0.44;

      // Lines near the vertical centre are brighter; edges dim out
      const center  = 1 - Math.abs((l / (maxLines - 1)) - 0.5) * 2;
      const alpha   = amp * (0.22 + center * 0.65) * (0.45 + glow * 0.55);
      if (alpha < 0.018) continue;

      const devScale = amp * maxDeviation;

      // ── Glow pass (wide, additive) ─────────────────────────────────────────
      if (glow > 0.08 && !isMobile) {
        ctx.beginPath();
        for (let xi = 0; xi <= zoneW; xi += step) {
          const x = zoneLeft + xi;
          const y = yBase + devScale * Math.sin(xi / wavePeriod * Math.PI * 2 + lPhase);
          xi === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${hue},70%,65%,${alpha * glow * 0.28})`;
        ctx.lineWidth   = 3.5 + glow * 4 + amp * 2;
        ctx.stroke();
      }

      // ── Core stroke ────────────────────────────────────────────────────────
      ctx.beginPath();
      for (let xi = 0; xi <= zoneW; xi += step) {
        const x = zoneLeft + xi;
        const y = yBase + devScale * Math.sin(xi / wavePeriod * Math.PI * 2 + lPhase);
        xi === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      const lightness = 38 + amp * 32;
      ctx.strokeStyle = `hsla(${hue},68%,${lightness}%,${alpha})`;
      ctx.lineWidth   = 0.55 + amp * 0.7 + glow * 0.35;
      ctx.stroke();
    }

    ctx.restore();
  }

  // Beat flash
  if (beatFlash > 0.01) {
    ctx.fillStyle = `rgba(255,255,255,${beatFlash * 0.07})`;
    ctx.fillRect(0, 0, W, H);
  }
}
