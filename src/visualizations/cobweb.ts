/**
 * Cobweb — Audio-reactive spider-web visualization.
 *
 * Inspired by Tomas Saraceno's suspended web sculptures — specifically
 * "In Orbit" (2013, Kunstsammlung Nordrhein-Westfalen, Düsseldorf,
 * https://tomassaraceno.com/projects/in-orbit/) where visitors walked on
 * giant nets suspended 25 m above the ground. The geometry is radial:
 * N spokes radiate from a central anchor; M concentric rings thread between
 * them. 7 freq bands each govern one ring-zone (sub-bass at centre →
 * brilliance at rim), driving ring brightness and strand vibration. Dew-drop
 * nodes glow at spoke–ring intersections proportional to band amplitude.
 * Beat fires an expanding radial pulse wave and shifts the hue palette.
 * Sliders: Density (spoke/ring count), Dew (intersection glow), Tension
 * (vibration amplitude).
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

// Hue per frequency band: violet→blue→teal→green→yellow→orange→magenta
const BAND_HUES: number[] = [270, 220, 180, 140, 60, 30, 300];

// ── Module state ──────────────────────────────────────────────────────────
let lastBeatIndex = -1;
let beatFlash = 0;    // screen flash, decays to 0
let beatPulse = 0;    // 0→1 as pulse ring expands outward
let hueShift = 0;     // rotates hue palette on every beat
let bandPhases = new Float32Array(BAND_COUNT);  // per-band oscillation phase

// ── Draw ──────────────────────────────────────────────────────────────────
export function drawCobweb(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const density = config.cobwebDensity;
  const dewGlow = config.cobwebDew;
  const tension  = config.cobwebTension;

  // Mobile guard: fewer spokes → fewer segments and intersections
  const NUM_SPOKES = isMobile
    ? Math.round(6 + density * 10)
    : Math.round(8 + density * 16);
  const NUM_RINGS = Math.round(NUM_SPOKES * 0.6);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    if (adjusted >= 0) {
      const idx = Math.floor(adjusted / state.beatIntervalSec);
      if (idx !== lastBeatIndex) {
        lastBeatIndex = idx;
        beatFlash = 1.0;
        beatPulse  = 0.0;
        hueShift   = (hueShift + 47) % 360;
      }
    }
  }
  beatFlash *= Math.pow(0.88, dt);
  beatPulse  = Math.min(1.0, beatPulse + 0.034 * dt);

  // Advance per-band oscillation phases
  for (let b = 0; b < BAND_COUNT; b++) {
    bandPhases[b] += (0.003 + amps[b] * 0.018) * dt;
  }

  let energy = 0;
  for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
  energy /= BAND_COUNT;

  // Clear background (no trail — web is sharp)
  p.background(0, 0, 8);

  const cx = p.width  / 2;
  const cy = p.height / 2;
  const maxR = Math.min(p.width, p.height) * 0.44;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // ── Precompute intersection points ────────────────────────────────────
  // pts[s][r] = where spoke s meets ring r (r=0 innermost, r=NUM_RINGS-1 outermost)
  // Vibration baked in so both spoke and ring draws share the same positions.
  const pts: Array<Array<{ x: number; y: number }>> = [];

  for (let s = 0; s < NUM_SPOKES; s++) {
    const baseAngle = (s / NUM_SPOKES) * TWO_PI;
    const spkPts: Array<{ x: number; y: number }> = [];

    for (let r = 0; r < NUM_RINGS; r++) {
      const frac   = (r + 1) / NUM_RINGS;
      const bi     = Math.min(BAND_COUNT - 1, Math.floor(frac * BAND_COUNT));
      const amp    = amps[bi];

      // Radial displacement — breathes in/out along the spoke
      const radial = Math.sin(bandPhases[bi] * 2.1 + s * 0.73) * amp * tension * maxR * 0.07;

      // Angular displacement — slight tangential wobble
      const dAngle = Math.sin(bandPhases[bi] * 1.6 + r * 0.9 + s * 0.43) * amp * tension * 0.12;

      const rr = frac * maxR + radial;
      const aa = baseAngle + dAngle;

      spkPts.push({ x: cx + Math.cos(aa) * rr, y: cy + Math.sin(aa) * rr });
    }
    pts.push(spkPts);
  }

  // ── Draw spokes — radial threads from centre through ring nodes ────────
  (p as any).noFill();
  for (let s = 0; s < NUM_SPOKES; s++) {
    // 3 passes: outer halo → mid → bright core
    for (let pass = 0; pass < 3; pass++) {
      const sw        = [3.5, 1.5, 0.55][pass];
      const alphaBase = [7,  16,  55  ][pass];

      (p as any).stroke(200, 12, 85, Math.min(100, alphaBase * (0.4 + energy)));
      p.strokeWeight(sw * (1 + energy * 0.5));

      p.beginShape();
      // Catmull-Rom phantom: duplicate start point
      p.curveVertex(cx, cy);
      p.curveVertex(cx, cy);
      for (let r = 0; r < NUM_RINGS; r++) {
        p.curveVertex(pts[s][r].x, pts[s][r].y);
      }
      // Phantom: duplicate end point
      const last = pts[s][NUM_RINGS - 1];
      p.curveVertex(last.x, last.y);
      p.curveVertex(last.x, last.y);
      p.endShape();
    }
  }

  // ── Draw rings — closed Catmull-Rom curves through spoke intersections ─
  for (let r = 0; r < NUM_RINGS; r++) {
    const frac    = (r + 1) / NUM_RINGS;
    const bi      = Math.min(BAND_COUNT - 1, Math.floor(frac * BAND_COUNT));
    const amp     = amps[bi];
    const baseHue = (BAND_HUES[bi] + hueShift) % 360;

    // Pulse ring: bright flash at the expanding wavefront
    const pulseDist = Math.abs(frac - beatPulse);
    const pulse     = Math.max(0, 1 - pulseDist * 7) * beatFlash;

    for (let pass = 0; pass < 3; pass++) {
      const sw        = [5.0, 2.0, 0.8][pass];
      const alphaBase = [8,   22,  72  ][pass];
      const sat  = pass === 2 ? 25 + amp * 65 + pulse * 35 : 12 + pulse * 20;
      const bri  = 65 + amp * 30 + pulse * 30;
      const alpha = Math.min(100, alphaBase * (0.35 + amp + pulse * 0.8));

      (p as any).stroke(baseHue, sat, bri, alpha);
      p.strokeWeight(sw * (1 + amp * 1.5 + pulse));
      (p as any).noFill();

      // Closed Catmull-Rom: prepend last-2 and last-1 as phantom heads,
      // append first and second as phantom tails — yields a seamless loop.
      const sN2 = pts[NUM_SPOKES - 2][r];
      const sN1 = pts[NUM_SPOKES - 1][r];
      const s0  = pts[0][r];
      const s1  = pts[1 < NUM_SPOKES ? 1 : 0][r];

      p.beginShape();
      p.curveVertex(sN2.x, sN2.y);
      p.curveVertex(sN1.x, sN1.y);
      for (let s = 0; s < NUM_SPOKES; s++) {
        p.curveVertex(pts[s][r].x, pts[s][r].y);
      }
      p.curveVertex(s0.x, s0.y);
      p.curveVertex(s1.x, s1.y);
      p.endShape();
    }
  }

  // ── Dew droplets at ring–spoke intersections ──────────────────────────
  if (dewGlow > 0.02) {
    (p as any).noStroke();

    for (let r = 0; r < NUM_RINGS; r++) {
      const frac    = (r + 1) / NUM_RINGS;
      const bi      = Math.min(BAND_COUNT - 1, Math.floor(frac * BAND_COUNT));
      const amp     = amps[bi];
      const baseHue = (BAND_HUES[bi] + hueShift) % 360;

      const pulseDist = Math.abs(frac - beatPulse);
      const pulse     = Math.max(0, 1 - pulseDist * 7) * beatFlash;
      const dropAmp   = amp * dewGlow + pulse * dewGlow * 0.7;

      if (dropAmp < 0.04) continue;

      for (let s = 0; s < NUM_SPOKES; s++) {
        const { x: px, y: py } = pts[s][r];
        const dotSize = 3 + dropAmp * 14;

        // Outer glow halo
        (p as any).fill(baseHue, 35 + amp * 25, 80, dropAmp * 28 + pulse * 20);
        p.ellipse(px, py, dotSize * 2.4, dotSize * 2.4);

        // Bright core
        (p as any).fill(baseHue, 18, 98, dropAmp * 75 + pulse * 60);
        p.ellipse(px, py, dotSize * 0.65, dotSize * 0.65);
      }
    }
  }

  // ── Central anchor point ──────────────────────────────────────────────
  {
    (p as any).noStroke();
    const h = (BAND_HUES[0] + hueShift) % 360;
    // Soft glow
    (p as any).fill(h, 30, 80, 18 + energy * 35 + beatFlash * 20);
    p.ellipse(cx, cy, 28 + energy * 18, 28 + energy * 18);
    // Bright centre dot
    (p as any).fill(0, 0, 95, 65 + amps[0] * 30);
    p.ellipse(cx, cy, 6 + amps[0] * 5, 6 + amps[0] * 5);
  }

  // ── Beat screen flash ─────────────────────────────────────────────────
  if (beatFlash > 0.25) {
    (p as any).fill(0, 0, 100, beatFlash * 10);
    (p as any).noStroke();
    p.rect(0, 0, p.width, p.height);
  }

  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────
export function resetCobweb(): void {
  lastBeatIndex = -1;
  beatFlash     = 0;
  beatPulse     = 0;
  hueShift      = 0;
  bandPhases    = new Float32Array(BAND_COUNT);
}
