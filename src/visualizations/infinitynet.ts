/**
 * Infinity Net — Audio-reactive arc-net inspired by Yayoi Kusama's
 * "Infinity Net" paintings (1958–ongoing). Dense semicircular arcs fill
 * the canvas in a hex-offset grid; 7 concentric radial zones map to the
 * 7 frequency bands (sub-bass at centre → brilliance at edge). Amplitude
 * pulses arc size. Beat fires an expanding ripple ring that blooms every
 * arc it crosses. Palette morphs from Kusama's iconic white-on-black
 * monochrome to a full per-band chromatic spectrum.
 *
 * https://www.sothebys.com/en/articles/hypnotic-and-alluring-yayoi-kusamas-infinity-nets
 *
 * Sliders
 *   infinitynetScale   — arc spacing (dense ↔ sparse)
 *   infinitynetBreathe — amplitude → arc-size pulse (0 = static, 1 = full swell)
 *   infinitynetPalette — colour (0 = Kusama monochrome, 1 = chromatic per band)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: violet → pink-red → orange → yellow → green → cyan → blue
const BAND_HUES: readonly number[] = [275, 338, 22, 52, 138, 195, 245];

// ── Module state ──────────────────────────────────────────────────────────────
let rippleRadius = 0;
let rippleStrength = 0;
let globalHueShift = 0;
let lastBeatIndex = -1;
let phase = 0;

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawInfinityNet(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  // Arc grid spacing driven by Scale slider
  const baseSpacing = isMobile
    ? 36 + config.infinitynetScale * 24   // 36–60 px on mobile
    : 24 + config.infinitynetScale * 36;  // 24–60 px on desktop
  const breathe = config.infinitynetBreathe;
  const palette  = config.infinitynetPalette;

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      rippleRadius = 0;
      rippleStrength = 1.0;
      globalHueShift = (globalHueShift + 25) % 360;
    }
  }

  // ── Animate state ───────────────────────────────────────────────────────────
  rippleRadius += 4.5 * dt;
  rippleStrength *= Math.pow(0.93, dt);
  if (rippleStrength < 0.004) rippleStrength = 0;
  if (state.isPlaying) {
    phase += 0.010 * dt;
    globalHueShift = (globalHueShift + 0.025 * dt) % 360;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  p.background(8);   // near-black, drawn before HSB mode switch
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  const arcBase  = baseSpacing * 0.60;   // arc radius ≈ 60 % of grid step
  const colStep  = baseSpacing;
  const rowStep  = baseSpacing * 0.52;   // tight rows — arcs from adjacent rows overlap
  const rippleW  = baseSpacing * 3.5;    // ripple ring width

  let colIdx = 0;
  for (let hx = -baseSpacing; hx < w + baseSpacing; hx += colStep) {
    const rowShift = colIdx % 2 === 0 ? 0 : rowStep * 0.5;
    for (let hy = -arcBase + rowShift; hy < h + arcBase; hy += rowStep) {
      const dx = hx - cx;
      const dy = hy - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Map radial distance to one of 7 frequency bands
      const bandIdx = Math.min(6, Math.floor((dist / maxDist) * 7));
      const amp = amps[bandIdx];

      // Beat ripple contribution: bell-shaped pulse expanding from centre
      let ripple = 0;
      if (rippleStrength > 0.004) {
        const gap = Math.abs(dist - rippleRadius);
        if (gap < rippleW) ripple = rippleStrength * (1 - gap / rippleW);
      }

      // Slow radial breathing wave independent of beats
      const wave = Math.sin(phase + dist * 0.022) * 0.05;
      const totalAmp = Math.min(1, amp + ripple + Math.max(0, wave));

      // Arc radius: Breathe slider controls how much amplitude swells the arc.
      // At breathe=0 arcs are always at 55 % of arcBase (static Kusama carpet).
      // At breathe=1 arcs collapse to near-zero when quiet and bloom fully on hits.
      const minFrac = 0.55 - breathe * 0.45;            // 0.55 → 0.10
      const arcR    = arcBase * (minFrac + (1 - minFrac) * totalAmp);
      if (arcR < 2) continue;

      // Colour: Palette=0 → white on black (Kusama monochrome); Palette=1 → chromatic
      const hue = (BAND_HUES[bandIdx] + globalHueShift) % 360;
      const sat = palette * 82;
      const bri = 55 + totalAmp * 40;   // 55–95 % brightness
      const alp = 65 + totalAmp * 35;   // 65–100 % alpha

      (p as any).fill(hue, sat, bri, alp);
      // Upper semicircle: from 9-o'clock → 12-o'clock → 3-o'clock (arch ∩ shape)
      (p as any).arc(hx, hy, arcR * 2, arcR * 2, Math.PI, Math.PI * 2);
    }
    colIdx++;
  }

  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
export function resetInfinityNet(): void {
  rippleRadius = 0;
  rippleStrength = 0;
  globalHueShift = 0;
  lastBeatIndex = -1;
  phase = 0;
}
