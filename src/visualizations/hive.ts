/**
 * Hive — Audio-reactive honeycomb grid.
 *
 * The canvas is filled with flat-top hexagons laid out in a honeycomb grid.
 * Hexes are sorted into 7 concentric radial zones, each mapped to one of the
 * 7 frequency bands (sub-bass at the centre, brilliance at the outer edge).
 * Amplitude drives brightness and glow. On each detected beat an expanding
 * ripple ring sweeps outward from the centre, briefly brightening every hex
 * it passes through, and the palette drifts a step around the hue wheel.
 *
 * Sliders
 *   hiveHexSize  — hex radius (density of the grid, 15–60 px)
 *   hiveGlow     — bloom intensity of the outer glow ellipses (0–1)
 *   hiveRipple   — beat ripple strength (0–1)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band (HSB 0-360): violet → pink-red → orange → yellow → green → cyan → blue
const BAND_HUES: readonly number[] = [275, 338, 22, 52, 138, 195, 245];

// ── Module state ──────────────────────────────────────────────────────────────
let rippleRadius = 0;
let rippleStrength = 0;
let globalHueShift = 0;
let lastBeatIndex = -1;

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawHive(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Slider-driven hex radius — mobile enforces a larger minimum for performance
  const hexR = isMobile
    ? 25 + config.hiveHexSize * 30  // 25–55 px on mobile
    : 15 + config.hiveHexSize * 45; // 15–60 px on desktop

  const glowStr = config.hiveGlow;   // 0–1
  const rippleStr = config.hiveRipple; // 0–1

  const sqrt3 = Math.sqrt(3);
  // Flat-top hex tiling: horizontal pitch = 1.5 R, vertical pitch = √3 R
  const colStep = hexR * 1.5;
  const rowStep = hexR * sqrt3;

  const cx = w * 0.5;
  const cy = h * 0.5;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      rippleRadius = 0;
      rippleStrength = 1.0;
      // Nudge the palette on every beat
      globalHueShift = (globalHueShift + 18) % 360;
    }
  }

  // ── Update ripple (5 px per 60 fps reference frame) ────────────────────────
  rippleRadius += 5 * dt;
  rippleStrength *= Math.pow(0.93, dt);
  if (rippleStrength < 0.005) rippleStrength = 0;

  // Slow continuous hue drift while playing
  if (state.isPlaying) {
    globalHueShift = (globalHueShift + 0.04 * dt) % 360;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  const rippleWidth = hexR * 3 + 40; // wave spread radius in px

  // Flat-top hex grid — iterate columns then rows
  let colIdx = 0;
  for (let hx = -hexR * 2; hx < w + hexR * 2; hx += colStep) {
    // Odd columns are shifted down by half a row
    const rowShift = colIdx % 2 === 0 ? 0 : rowStep * 0.5;
    for (let hy = -hexR * 2 + rowShift; hy < h + hexR * 2; hy += rowStep) {
      const dx = hx - cx;
      const dy = hy - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Map radial distance to one of 7 frequency bands
      const bandIdx = Math.min(6, Math.floor((dist / maxDist) * 7));
      const amp = amps[bandIdx];

      // Ripple contribution: bell-shaped pulse centred on the expanding ring
      let rippleContrib = 0;
      if (rippleStrength > 0.005 && rippleStr > 0.005) {
        const gap = Math.abs(dist - rippleRadius);
        if (gap < rippleWidth) {
          rippleContrib = rippleStrength * rippleStr * (1 - gap / rippleWidth);
        }
      }

      const totalAmp = Math.min(1, amp + rippleContrib);
      if (totalAmp < 0.025) continue; // skip hexes too dim to see

      const hue = (BAND_HUES[bandIdx] + globalHueShift) % 360;
      const sat = 65 + totalAmp * 35;   // 65–100 %
      const bri = 8 + totalAmp * 88;    // 8–96 %
      const alp = 30 + totalAmp * 70;   // 30–100 %

      // Outer glow — a large semi-transparent ellipse creates bloom
      if (glowStr > 0.02 && totalAmp > 0.05) {
        const glowR = hexR * (1.6 + totalAmp * 0.7);
        const glowAlpha = totalAmp * 40 * glowStr;
        (p as any).fill(hue, sat * 0.7, bri, glowAlpha);
        p.ellipse(hx, hy, glowR * 2, glowR * 2);
      }

      // Core hex — slightly inset (87 %) so inter-hex gaps remain visible
      const coreR = hexR * 0.87;
      (p as any).fill(hue, sat, bri, alp);
      p.beginShape();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i; // 0°, 60°, 120°, 180°, 240°, 300° (flat-top)
        p.vertex(hx + coreR * Math.cos(a), hy + coreR * Math.sin(a));
      }
      (p as any).endShape(p['CLOSE']);
    }
    colIdx++;
  }

  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
export function resetHive(): void {
  rippleRadius = 0;
  rippleStrength = 0;
  globalHueShift = 0;
  lastBeatIndex = -1;
}
