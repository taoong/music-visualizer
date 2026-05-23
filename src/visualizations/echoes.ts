/**
 * Echoes — polar slit-scan temporal mandala
 *
 * Each audio frame is captured as a snapshot of the 7 frequency-band amplitudes
 * and stored in a ring buffer. Every frame, the accumulated history is rendered
 * as concentric polar curves: the newest snapshot at the innermost radius,
 * older frames radiating outward. A "Twist" parameter rotates each successive
 * ring, morphing from a concentric mandala (twist=0) to a tight double-helix
 * spiral (twist=1). Beat hits shift the hue palette and flash all rings bright.
 *
 * Inspired by Golan Levin's slit-scan video-art catalog (flong.com/texts/lists/slit_scan/)
 * — specifically the radial/polar variants of temporal smearing where time is
 * encoded in the annular dimension rather than linearly across the image plane.
 *
 * Sliders
 *   Depth — ring history depth (20–150 past frames)
 *   Twist — rotation per ring: 0 = concentric rings, 1 = tight spiral
 *   Scale — amplitude-to-radius mapping: 0 = flat circles, 1 = dramatic spikes
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { audioEngine } from '../audio/engine';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-angle resolution: enough for smooth curves, light enough for 60fps
const ANGLE_STEPS = isMobile ? 90 : 180;
const MAX_DEPTH = 160;

// Hues for the 7 frequency bands (sub → brilliance): violet, blue, teal, green, yellow, orange, red
const BAND_HUES = [280, 220, 170, 110, 55, 25, 0];

// Ring buffer storing per-frame band amplitudes
let ringBuf: Float32Array[]; // [MAX_DEPTH][BAND_COUNT]
let writeHead = 0;
let filled = 0;      // frames captured so far, capped at MAX_DEPTH
let hueShift = 0;
let beatIdx = -1;
let flash = 0;       // 1.0 on beat, decays to 0

export function resetEchoes(): void {
  ringBuf = Array.from({ length: MAX_DEPTH }, () => new Float32Array(BAND_COUNT));
  writeHead = 0;
  filled = 0;
  hueShift = 0;
  beatIdx = -1;
  flash = 0;
}

resetEchoes();

export function drawEchoes(p: P5Instance, dt: number): void {
  const { amps } = getBandAverages(BAND_COUNT);
  const { state, config } = store;

  // Beat detection — hue palette jump + brightness flash
  if (state.isPlaying && state.detectedBPM > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const bi = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (bi !== beatIdx) {
      beatIdx = bi;
      flash = 1.0;
      hueShift = (hueShift + 30 + Math.random() * 20) % 360;
    }
  }
  flash = Math.max(0, flash - dt * 0.04);

  // Capture current frame into ring buffer
  const slot = writeHead % MAX_DEPTH;
  const frame = ringBuf[slot];
  for (let b = 0; b < BAND_COUNT; b++) frame[b] = amps[b];
  writeHead++;
  filled = Math.min(filled + 1, MAX_DEPTH);

  p.background(0);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noFill();

  const depth = Math.min(Math.round(config.echoesDepth), filled);
  const twistDeg = config.echoesTwist * 8.0; // 0–8 degrees per ring
  const scaleAmt = config.echoesScale;

  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const innerR = minDim * 0.04;
  const outerR = minDim * 0.47;
  const ampRange = outerR * 0.36; // maximum radius delta from audio

  const TAU = Math.PI * 2;

  for (let i = 0; i < depth; i++) {
    // i=0 is newest (innermost), i=depth-1 is oldest (outermost)
    const ri = ((writeHead - 1 - i) % MAX_DEPTH + MAX_DEPTH) % MAX_DEPTH;
    const rf = ringBuf[ri];

    const t = depth <= 1 ? 0 : i / (depth - 1);
    const baseR = innerR + t * (outerR - innerR);
    // Start rings at top (12 o'clock) by offsetting by -π/2
    const rotOff = (i * twistDeg * Math.PI) / 180 - Math.PI / 2;
    // Older rings fade out; flash briefly brightens everything
    const ageAlpha = (85 * (1 - t * 0.65) + flash * 15) | 0;

    for (let a = 0; a < ANGLE_STEPS; a++) {
      // Map angle step to frequency band, with smooth cross-fading at boundaries
      const bandFrac = (a / ANGLE_STEPS) * BAND_COUNT;
      const bIdx = Math.min(BAND_COUNT - 1, Math.floor(bandFrac));
      const bNext = Math.min(BAND_COUNT - 1, bIdx + 1);
      const bandT = bandFrac - bIdx;

      const bandFracNext = ((a + 1) / ANGLE_STEPS) * BAND_COUNT;
      const bIdxNext = Math.min(BAND_COUNT - 1, Math.floor(bandFracNext));

      // Interpolated amplitude at start and end of this segment
      const ampA = rf[bIdx] * (1 - bandT) + rf[bNext] * bandT;
      const ampB = rf[bIdxNext];

      const ang1 = (a / ANGLE_STEPS) * TAU + rotOff;
      const ang2 = ((a + 1) / ANGLE_STEPS) * TAU + rotOff;

      const r1 = baseR + ampA * scaleAmt * ampRange;
      const r2 = baseR + ampB * scaleAmt * ampRange;

      const x1 = cx + Math.cos(ang1) * r1;
      const y1 = cy + Math.sin(ang1) * r1;
      const x2 = cx + Math.cos(ang2) * r2;
      const y2 = cy + Math.sin(ang2) * r2;

      const h = (BAND_HUES[bIdx] + hueShift) % 360;
      const sat = 60 + rf[bIdx] * 40;
      const bri = 20 + rf[bIdx] * 80 + flash * 20;
      const sw = 0.8 + rf[bIdx] * 2.0;

      p.strokeWeight(sw);
      p.stroke(h, sat, bri, ageAlpha);
      p.line(x1, y1, x2, y2);
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
