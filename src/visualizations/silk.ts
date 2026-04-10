/**
 * Silk Flow — 7 neon silk ribbons, one per frequency band, flowing
 * continuously across the canvas as audio-reactive sine waves.
 *
 * Each ribbon flows from left to right with a sinusoidal shape whose
 * amplitude is driven by its frequency band's energy. Multiple glow
 * passes create a soft neon light effect. Beat hits send a surge
 * through every ribbon simultaneously. Ribbons flow at different
 * speeds and wavelengths for visual variety.
 *
 * Sliders:
 *   silkWaveSpeed   — how fast the ribbons animate (phase advance rate)
 *   silkRibbonWidth — thickness of each ribbon (controls boldness)
 *   silkGlow        — glow/bloom intensity (outer halo strength)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';

// HSB hues per band: sub=purple, bass=blue, lowMid=cyan, mid=green,
// upperMid=yellow-green, presence=orange, brilliance=red
const BAND_HUES = [270, 220, 180, 120, 70, 30, 0];

// Number of full sine-wave cycles each ribbon spans across the canvas width
const BAND_WAVE_CYCLES = [1.5, 2.0, 2.5, 3.0, 2.5, 2.0, 1.5];

// Per-ribbon phase advance multipliers — subtle speed differences add visual depth
const BAND_PHASE_MULTS = [0.70, 0.90, 1.10, 1.00, 0.80, 0.95, 0.85];

// Number of curve segments per ribbon (higher = smoother, more expensive)
const SEGMENTS = 80;

// ── Module state ─────────────────────────────────────────────────────────────
let phases: number[] = [];
let beatPulse = 0;
let lastBeatIndex = -1;

export function resetSilk(): void {
  // Stagger starting phases so ribbons aren't all in sync on load
  phases = Array.from({ length: BAND_COUNT }, (_, i) => (i / BAND_COUNT) * Math.PI * 2);
  beatPulse = 0;
  lastBeatIndex = -1;
}

export function drawSilk(p: P5Instance, dt: number): void {
  if (phases.length === 0) resetSilk();
  const { state, config } = store;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
      lastBeatIndex = beatIndex;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.88, dt);
  if (beatPulse < 0.001) beatPulse = 0;

  const waveSpeed = config.silkWaveSpeed;
  const ribbonWidth = config.silkRibbonWidth;
  const glowStrength = config.silkGlow;

  // ── Advance phases ────────────────────────────────────────────────────────
  for (let r = 0; r < BAND_COUNT; r++) {
    phases[r] += waveSpeed * BAND_PHASE_MULTS[r] * 0.025 * dt;
  }

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const { amps, transients } = getBandAverages(BAND_COUNT);
  const ribbonSpacing = p.height / (BAND_COUNT + 1);

  // ── Draw each ribbon ──────────────────────────────────────────────────────
  for (let r = 0; r < BAND_COUNT; r++) {
    const amp = Math.min(1, amps[r] * config.spikeScale);
    const tMult = transients[r];

    const centerY = ribbonSpacing * (r + 1);
    const hue = BAND_HUES[r];
    const phase = phases[r];
    const cycles = BAND_WAVE_CYCLES[r];

    // Wave amplitude: audio-driven + beat surge, bounded to ribbon spacing
    const maxAmp = ribbonSpacing * 0.82;
    const waveAmp = Math.min(maxAmp, (amp * Math.min(tMult, 2.5) * 0.75 + beatPulse * 0.25) * maxAmp);

    // Build curve point array (reused across glow passes)
    const pts: Array<[number, number]> = new Array(SEGMENTS + 1);
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const x = t * p.width;
      // Primary sine + subtle second harmonic for organic, silk-like shape
      const y =
        centerY +
        Math.sin(t * Math.PI * 2 * cycles + phase) * waveAmp +
        Math.sin(t * Math.PI * 2 * cycles * 0.5 + phase * 1.3) * waveAmp * 0.22;
      pts[i] = [x, y];
    }

    // ── Outer glow pass (widest, most transparent) ────────────────────────
    if (glowStrength > 0.01) {
      (p as any).stroke(hue, 65, 100, glowStrength * 24);
      p.strokeWeight(ribbonWidth * (3.5 + glowStrength * 3.5));
      (p as any).noFill();
      drawRibbon(p, pts);

      // ── Mid glow pass ───────────────────────────────────────────────────
      (p as any).stroke(hue, 78, 100, glowStrength * 52);
      p.strokeWeight(ribbonWidth * (1.6 + glowStrength * 1.2));
      drawRibbon(p, pts);
    }

    // ── Core ribbon ───────────────────────────────────────────────────────
    (p as any).stroke(hue, 50, 100, 94);
    p.strokeWeight(ribbonWidth * 0.45);
    drawRibbon(p, pts);

    // ── Transient highlight: bright white-ish flash on sharp hits ─────────
    if (tMult > 1.3) {
      const flashAlpha = Math.min(80, (tMult - 1.3) * 75);
      (p as any).stroke(hue, 15, 100, flashAlpha);
      p.strokeWeight(ribbonWidth * 0.18);
      drawRibbon(p, pts);
    }
  }

  // ── Beat flash overlay ────────────────────────────────────────────────────
  if (beatPulse > 0.12) {
    (p as any).colorMode(p['RGB'], 255);
    (p as any).noStroke();
    (p as any).fill(255, 255, 255, beatPulse * 11);
    p.rect(0, 0, p.width, p.height);
  }

  (p as any).colorMode(p['RGB'], 255);
}

/**
 * Draw a smooth Catmull-Rom spline through the point array.
 * Endpoint duplication gives well-behaved boundary conditions.
 */
function drawRibbon(p: P5Instance, pts: Array<[number, number]>): void {
  p.beginShape();
  p.curveVertex(pts[0][0], pts[0][1]);
  for (const [x, y] of pts) {
    p.curveVertex(x, y);
  }
  p.curveVertex(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  p.endShape();
}
