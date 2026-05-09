/**
 * Weave — audio-reactive tapestry of glowing threads.
 *
 * N horizontal (warp) threads and N vertical (weft) threads cross the full
 * canvas in a regular grid.  Each thread is assigned to one of the 7 frequency
 * bands; its glow intensity and vibration amplitude are driven by that band's
 * amplitude.  At every grid intersection a bright node lights up — its size is
 * proportional to the *product* of the two crossing bands' amplitudes, so hot
 * spots only appear where both contributing bands are simultaneously loud.
 * Beats send a radial shockwave ring outward from the canvas centre that
 * temporarily illuminates every thread and node it passes through.
 *
 * Sliders
 *   Threads — threads per axis (4–32)
 *   Glow    — stroke-weight / halo multiplier (0.2–3)
 *   Pulse   — beat shockwave intensity (0.2–2)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Persian-tapestry palette — two opinionated colour families plus a rare
// gold accent at intersection nodes. Hue stays locked; beat/amplitude
// only modulate brightness/saturation so the tapestry identity holds.
const WARP_HUES = [0, 6, 12, 18, 24, 14, 8];        // burgundy → rust spread
const WEFT_HUES = [200, 208, 215, 222, 230, 218, 205]; // navy → teal spread
const NODE_HUE = 45;                                  // gold accent

// Glow pass descriptors (outermost → core)
const THREAD_PASSES = [
  { wMult: 6.0, aScale: 0.12 },
  { wMult: 2.5, aScale: 0.38 },
  { wMult: 1.0, aScale: 1.0 },
] as const;

const CURVE_SAMPLES = 10; // sample points per wavy thread

// ── module-scoped state ──────────────────────────────────────────────────────
let lastBeatIndex = -1;
let beatPulse = 0;   // 1 on beat, decays to 0
let wavePhase = 0;   // wave-front radius expressed as fraction of maxR (0→1.4)
let time = 0;        // ever-increasing, drives thread oscillation

// ── reset ────────────────────────────────────────────────────────────────────
export function resetWeave(): void {
  lastBeatIndex = -1;
  beatPulse = 0;
  wavePhase = 0;
  time = 0;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawWeave(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beat = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beat >= 0 && beat !== lastBeatIndex) {
      lastBeatIndex = beat;
      beatPulse = 1.0;
      wavePhase = 0;
      // No hue jump — the warp/weft families stay locked. Beat = brightness.
    }
  }

  if (beatPulse > 0) {
    beatPulse *= Math.pow(0.86, dt);
    wavePhase += 0.046 * dt; // wave expands: reaches maxR in ~22 frames at dt=1
    if (beatPulse < 0.001) {
      beatPulse = 0;
      wavePhase = 0;
    }
  }

  time += 0.022 * dt;

  const N = Math.max(4, Math.min(32, Math.round(config.weaveThreads)));
  const glow = config.weaveGlow;
  const pulse = config.weavePulse;

  const w = p.width;
  const h = p.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  const waveFront = wavePhase * maxR;
  const waveSigma2 = (maxR * 0.13) ** 2; // squared Gaussian width for wave ring

  const cellW = w / (N + 1);
  const cellH = h / (N + 1);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── WARP THREADS (horizontal) ─────────────────────────────────────────────
  for (let i = 0; i < N; i++) {
    const yCen = (i + 1) * cellH;
    const bandIdx = i % BAND_COUNT;
    const amp = amps[bandIdx];
    const hue = WARP_HUES[bandIdx];
    // Burgundy/rust threads — sat range 50–85% keeps them earthy, not neon.
    const sat = 50 + amp * 35;

    // Wave gain: peaks when this thread's y-distance from centre ≈ waveFront
    const dy = Math.abs(yCen - cy);
    const waveGain =
      beatPulse > 0
        ? beatPulse * pulse * Math.exp(-((dy - waveFront) ** 2) / waveSigma2)
        : 0;

    const bri = Math.min(100, 30 + amp * 65 + waveGain * 28);
    const baseAlpha = 18 + amp * 38 + waveGain * 28;

    // Vibration: threads sway gently (amplitude scales with band energy)
    const vibeAmp = (2.5 + amp * 11) * glow;

    for (const pass of THREAD_PASSES) {
      const sw = Math.max(0.3, (1.2 + amp * 3.2 + waveGain * 1.8) * glow * pass.wMult);
      p.noFill();
      p.stroke(hue, sat, bri, Math.min(100, baseAlpha * pass.aScale));
      p.strokeWeight(sw);
      p.beginShape();
      for (let k = 0; k <= CURVE_SAMPLES; k++) {
        const px = (k / CURVE_SAMPLES) * w;
        const py = yCen + vibeAmp * Math.sin(px * 0.009 + time + i * 1.37);
        p.curveVertex(px, py);
      }
      p.endShape();
    }
  }

  // ── WEFT THREADS (vertical) ───────────────────────────────────────────────
  for (let j = 0; j < N; j++) {
    const xCen = (j + 1) * cellW;
    // Offset band mapping so the same band doesn't dominate both axes
    const bandIdx = (j + Math.floor(BAND_COUNT / 2)) % BAND_COUNT;
    const amp = amps[bandIdx];
    const hue = WEFT_HUES[bandIdx];
    // Navy/teal weft — slightly higher sat for visual depth against the warp.
    const sat = 55 + amp * 35;

    const dx = Math.abs(xCen - cx);
    const waveGain =
      beatPulse > 0
        ? beatPulse * pulse * Math.exp(-((dx - waveFront) ** 2) / waveSigma2)
        : 0;

    const bri = Math.min(100, 30 + amp * 65 + waveGain * 28);
    const baseAlpha = 18 + amp * 38 + waveGain * 28;

    const vibeAmp = (2.5 + amp * 11) * glow;

    for (const pass of THREAD_PASSES) {
      const sw = Math.max(0.3, (1.2 + amp * 3.2 + waveGain * 1.8) * glow * pass.wMult);
      p.noFill();
      p.stroke(hue, sat, bri, Math.min(100, baseAlpha * pass.aScale));
      p.strokeWeight(sw);
      p.beginShape();
      for (let k = 0; k <= CURVE_SAMPLES; k++) {
        const py = (k / CURVE_SAMPLES) * h;
        const px = xCen + vibeAmp * Math.sin(py * 0.009 + time + j * 2.71);
        p.curveVertex(px, py);
      }
      p.endShape();
    }
  }

  // ── INTERSECTION NODES ────────────────────────────────────────────────────
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const yCen = (i + 1) * cellH;
      const xCen = (j + 1) * cellW;

      const bH = i % BAND_COUNT;
      const bV = (j + Math.floor(BAND_COUNT / 2)) % BAND_COUNT;
      const nodePower = amps[bH] * amps[bV]; // only bright when BOTH bands are active

      if (nodePower < 0.004) continue;

      const ddx = xCen - cx;
      const ddy = yCen - cy;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      const waveGain =
        beatPulse > 0
          ? beatPulse * pulse * Math.exp(-((dist - waveFront) ** 2) / waveSigma2)
          : 0;

      // Intersection nodes are always gold — this is the only place a third
      // colour appears in the tapestry, and it's *earned*: nodes only light
      // up when both the warp band AND weft band crossing here are loud.
      const nodeBri = Math.min(100, 62 + nodePower * 38 + waveGain * 22);
      const nodeR = Math.max(1.5, (2.5 + nodePower * 9 + waveGain * 5.5) * glow);
      const nodeAlpha = Math.min(100, 42 + nodePower * 58 + waveGain * 38);

      p.noStroke();

      // Outer halo
      p.fill(NODE_HUE, 70, nodeBri, nodeAlpha * 0.22);
      p.ellipse(xCen, yCen, nodeR * 4.5, nodeR * 4.5);

      // Mid ring
      p.fill(NODE_HUE, 82, nodeBri, nodeAlpha * 0.52);
      p.ellipse(xCen, yCen, nodeR * 2.0, nodeR * 2.0);

      // Bright core — desaturated so the centre reads as warm white.
      p.fill(NODE_HUE, 25, 100, nodeAlpha * 0.88);
      p.ellipse(xCen, yCen, nodeR * 0.65, nodeR * 0.65);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
