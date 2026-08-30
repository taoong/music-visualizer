/**
 * Cataract — Bridget Riley op-art wave bands
 *
 * N horizontal sinusoidal boundary curves divide the canvas into filled bands.
 * Adjacent bands alternate dark/light in Riley's signature style. A fixed
 * per-curve phase offset creates the diagonal "cataract" optical-flow illusion:
 * when the eye follows the bands horizontally, the whole canvas appears to
 * cascade downward. Seven frequency zones (left → right) drive local wave
 * amplitude so the spectrum is "painted" spatially — bass bends the left-side
 * curves, brilliance the right. Beat fires a half-cycle phase-flip that
 * reverses the apparent flow direction. Palette slider morphs from Riley's
 * monochrome to full chromatic band-hue mode.
 *
 * Inspired by Bridget Riley "Cataract 3" (1967, British Council Collection)
 * https://artuk.org/discover/artworks/cataract-3-219038
 *
 * Sliders:
 *   Lines   — wave-band count (5–40)
 *   Wave    — amplitude sensitivity (flat curves → deeply carved)
 *   Palette — monochrome (Riley white/black) → chromatic (band hues)
 */

import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Horizontal sample resolution per boundary curve
const SEGS = isMobile ? 120 : 280;

// Maximum supported band count
const N_MAX = 40;

// Per-band hues: violet → blue → teal → green → yellow → orange → magenta
const BAND_HUES: readonly number[] = [280, 230, 170, 120, 60, 30, 320];

// Preallocated curve buffer: (N_MAX+1) rows × (SEGS+1) columns
const curveY = new Float32Array((N_MAX + 1) * (SEGS + 1));

let time = 0;
let lastBeatIndex = -1;
let beatFlipPhase = 0;   // toggles 0 ↔ Math.PI on each beat
let hueShift = 0;        // accumulates +43° per beat

export function resetCataract(): void {
  time = 0;
  lastBeatIndex = -1;
  beatFlipPhase = 0;
  hueShift = 0;
}

export function drawCataract(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const N = Math.max(5, Math.min(N_MAX, Math.round(config.cataractLines)));
  const waveAmp = config.cataractWave;     // 0–1
  const palette  = config.cataractPalette; // 0=mono, 1=chromatic

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatFlipPhase = beatFlipPhase === 0 ? Math.PI : 0;
      hueShift = (hueShift + 43) % 360;
    }
  }

  // Slow continuous animation, slightly audio-reactive speed
  const avgAmp = amps.reduce((s, a) => s + a, 0) / BAND_COUNT;
  time += dt * (0.004 + avgAmp * 0.003);

  const W = p.width;
  const H = p.height;
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;

  // Dark near-black background
  ctx.fillStyle = 'rgb(6,6,8)';
  ctx.fillRect(0, 0, W, H);

  const step = W / SEGS;

  // Maximum vertical deviation: cap at 45% of one band height so curves
  // never visually cross at the default wave amplitude.
  const maxDev = (H / N) * 0.45;

  // Precompute (N+1) boundary curve y-values.
  // Phase stagger of 6π across all N curves ≈ 3 visual "ripple" cycles in
  // the flow direction — the source of the cataract waterfall illusion.
  for (let i = 0; i <= N; i++) {
    const baseY = (i / N) * H;
    const phaseOff = (i / N) * Math.PI * 6;
    const row = i * (SEGS + 1);

    for (let j = 0; j <= SEGS; j++) {
      const x = j * step;
      // Map x position to the 7 frequency bands (left=bass, right=brilliance)
      const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((x / W) * BAND_COUNT));
      const amp = amps[bandIdx];

      // Single sinusoidal cycle across the canvas width, staggered per curve
      const dev = amp * waveAmp * maxDev
                * Math.sin((x / W) * Math.PI * 2 + phaseOff + time + beatFlipPhase);
      curveY[row + j] = baseY + dev;
    }
  }

  // Draw N filled bands between adjacent boundary curves
  for (let i = 0; i < N; i++) {
    const isLight = i % 2 === 0;
    const topBase = i * (SEGS + 1);
    const botBase = (i + 1) * (SEGS + 1);

    if (palette < 0.015) {
      // Pure Riley monochrome
      ctx.fillStyle = isLight ? 'rgb(222,226,240)' : 'rgb(8,8,12)';
    } else {
      // Chromatic: horizontal gradient through the 7 band hues.
      // Each stop's brightness is live-driven by that band's amplitude so the
      // spectrum "lights up" inside the wave pattern.
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      for (let b = 0; b < BAND_COUNT; b++) {
        const t = b / (BAND_COUNT - 1);
        const amp = amps[b];
        const hue = (BAND_HUES[b] + hueShift) % 360;
        const s = isLight
          ? 18 + palette * (72 + amp * 18)
          : 12 + palette * (52 + amp * 22);
        const l = isLight
          ? 62 + amp * 28
          : 4 + amp * 20;
        grad.addColorStop(t, `hsl(${hue},${s.toFixed(1)}%,${l.toFixed(1)}%)`);
      }
      ctx.fillStyle = grad;
    }

    // Polygon: walk forward along top boundary curve then backward along bottom
    ctx.beginPath();
    ctx.moveTo(0, curveY[topBase]);
    for (let j = 1; j <= SEGS; j++) {
      ctx.lineTo(j * step, curveY[topBase + j]);
    }
    for (let j = SEGS; j >= 0; j--) {
      ctx.lineTo(j * step, curveY[botBase + j]);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Restore p5.js fill state
  ctx.fillStyle = '#000000';
}
