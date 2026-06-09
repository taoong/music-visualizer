/**
 * Aurora — audio-reactive aurora borealis light curtains
 *
 * N vertical curtains of luminous color span the canvas from top to bottom;
 * each curtain is driven by a frequency band.  Perlin noise sways the curtain
 * laterally and wrinkles its edges.  A vertical gradient creates the aurora
 * "crown" — bright near the top, fading to transparent at the bottom.
 * Screen-blend compositing lets overlapping curtains accumulate brightness
 * naturally, just as real auroras do when multiple emission bands coincide.
 * Beats fire a whole-sky brightness pulse.
 *
 * Inspired by Helen Frankenthaler's Color Field painting "Mountains and Sea"
 * (1952) — translucent stained washes of color that breathe on raw canvas —
 * and Maotik (Mathieu Le Sourd) "IRIDESCENT" (2018), a real-time data-driven
 * light environment with flowing luminous ribbons.
 * https://maotik.com/iridescent
 *
 * Sliders
 *   Curtains — number of visible aurora bands (1–7)
 *   Wave     — ripple and lateral turbulence (0 = glassy calm, 1 = storm)
 *   Hue      — palette: 0 = classic green aurora, 1 = violet/crimson aurora
 */

import { store }          from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine }     from '../audio/engine';

// Vertical slices per curtain (determines smoothness of the wavy edge)
const SLICES  = isMobile ? 40 : 80;
// Faint star field particle count
const N_STARS = isMobile ? 100 : 250;

// Per-band hue offsets relative to the palette centre.
// Spread the bands across ~80° so each curtain has a distinguishable tint.
const BAND_HUE_OFFSETS = [-40, -20, 0, 20, 35, 18, -8];

// Pre-allocated edge buffers — no heap allocation in the hot path
const _lx = new Float32Array(SLICES + 1);
const _rx = new Float32Array(SLICES + 1);

// Star positions (re-randomised on reset)
const _starX = new Float32Array(N_STARS);
const _starY = new Float32Array(N_STARS);

// Module state
let _time        = 0;
let _lastBeatIdx = -1;
let _beatFlash   = 0;   // 0–1, decays after each beat

// ── helpers ──────────────────────────────────────────────────────────────────

/** Converts HSB (0–360, 0–100, 0–100) + alpha (0–1) to CSS rgba string. */
function hsba(h: number, s: number, b: number, a: number): string {
  const sn = s / 100;
  const bn = b / 100;
  const c  = bn * sn;
  const hh = ((h % 360) + 360) % 360;
  const x  = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m  = bn - c;
  let r = 0, g = 0, bv = 0;
  if      (hh <  60) { r = c;  g = x;  bv = 0; }
  else if (hh < 120) { r = x;  g = c;  bv = 0; }
  else if (hh < 180) { r = 0;  g = c;  bv = x; }
  else if (hh < 240) { r = 0;  g = x;  bv = c; }
  else if (hh < 300) { r = x;  g = 0;  bv = c; }
  else               { r = c;  g = 0;  bv = x; }
  return `rgba(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((bv + m) * 255)},${a.toFixed(3)})`;
}

// ── reset ────────────────────────────────────────────────────────────────────

export function resetAurora(): void {
  _time        = 0;
  _lastBeatIdx = -1;
  _beatFlash   = 0;
  for (let i = 0; i < N_STARS; i++) {
    _starX[i] = Math.random();
    _starY[i] = Math.random() * 0.85; // stars only in upper portion of sky
  }
}

// ── draw ─────────────────────────────────────────────────────────────────────

export function drawAurora(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const curtainCount = Math.max(1, Math.min(7, Math.round(config.auroraCurtains)));
  const wave         = config.auroraWave;   // 0–1
  const hueShift     = config.auroraHue;    // 0–1

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== _lastBeatIdx) {
      _lastBeatIdx = bi;
      _beatFlash   = 0.9;
    }
  }

  _time      += dt * 0.005;
  _beatFlash *= Math.pow(0.88, dt);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  const W   = p.width;
  const H   = p.height;

  // ── background: slow fade to deep-space indigo ───────────────────────────
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(0,2,18,0.09)';
  ctx.fillRect(0, 0, W, H);

  // ── faint star field ─────────────────────────────────────────────────────
  const starAlpha = Math.max(0, 0.5 - _beatFlash * 0.4);
  if (starAlpha > 0.01) {
    ctx.beginPath();
    for (let i = 0; i < N_STARS; i++) {
      const sx = Math.round(_starX[i] * W);
      const sy = Math.round(_starY[i] * H);
      ctx.rect(sx, sy, 1, 1);
    }
    ctx.fillStyle = `rgba(210,225,255,${starAlpha.toFixed(3)})`;
    ctx.fill();
  }

  // ── whole-sky beat pulse ──────────────────────────────────────────────────
  if (_beatFlash > 0.04) {
    ctx.fillStyle = `rgba(130,255,210,${(_beatFlash * 0.055).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // ── palette centre hue: green (140) → violet/crimson (340) ───────────────
  const centerHue = 140 + hueShift * 200;

  // ── aurora curtains (screen-blend: overlaps accumulate like real aurora) ──
  ctx.globalCompositeOperation = 'screen';

  for (let ci = 0; ci < curtainCount; ci++) {
    // Map curtain index to nearest frequency band
    const bIdx = curtainCount === 1
      ? 3  // mid band for a single curtain
      : Math.round(ci * (BAND_COUNT - 1) / (curtainCount - 1));
    const amp = amps[bIdx];

    // Hue for this curtain
    const hue0 = ((centerHue + BAND_HUE_OFFSETS[bIdx]) % 360 + 360) % 360;

    // Horizontal centre: evenly spaced + slow noise drift
    const tPos  = curtainCount === 1 ? 0.5 : ci / (curtainCount - 1);
    const drift = (p.noise(ci * 3.17 + 10, _time * 0.35) - 0.5) * 0.07;
    const cx    = W * Math.max(0.05, Math.min(0.95, 0.10 + tPos * 0.80 + drift));

    // Half-width: base + amplitude swell + beat boost
    const halfW = W * (0.035 + wave * 0.055) * (0.55 + amp * 0.90 + _beatFlash * 0.45);

    // ── build wavy edge arrays (top to bottom) ────────────────────────────
    for (let s = 0; s <= SLICES; s++) {
      const t = s / SLICES;

      // Primary low-frequency sway via Perlin noise
      const nv   = p.noise(t * (1.1 + wave * 2.8) + ci * 6.31, _time);
      const dispX = (nv - 0.5) * 2 * W * (0.028 + wave * 0.075) * (0.4 + amp * 0.6);

      // Fine sinusoidal ripple on the curtain edge
      const ripple = Math.sin(t * Math.PI * (3 + wave * 9) + _time * 3.2 + ci * 2.17)
                     * W * 0.006 * wave * (0.6 + amp * 1.2);

      _lx[s] = cx - halfW + dispX + ripple;
      _rx[s] = cx + halfW + dispX + ripple;
    }

    // ── 3-pass glow: outer halo → mid body → bright core ─────────────────
    const bright = Math.min(1.0, 0.35 + amp * 0.85 + _beatFlash * 0.45);

    // [widthMultiplier, alphaScale, hueOffset]
    const passes: [number, number, number][] = [
      [3.0, 0.09, 25],
      [1.8, 0.23, 12],
      [1.0, 0.55,  0],
    ];

    for (const [wm, alphaScale, hOff] of passes) {
      const ha  = ((hue0 + hOff) % 360 + 360) % 360;
      const al  = bright * alphaScale;
      const ex  = halfW * (wm - 1); // extra width for this glow pass

      // Vertical gradient: crown bright at top (~8–18 %), fading to void
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0.00, hsba(ha,       70, 80,  al * 0.15));
      grad.addColorStop(0.05, hsba(ha,       80, 95,  al * 0.65));
      grad.addColorStop(0.13, hsba(ha,       88, 100, al));
      grad.addColorStop(0.30, hsba(ha + 15,  78, 82,  al * 0.55));
      grad.addColorStop(0.55, hsba(ha + 28,  65, 60,  al * 0.22));
      grad.addColorStop(0.80, hsba(ha + 42,  50, 38,  al * 0.06));
      grad.addColorStop(1.00, hsba(ha + 50,  40, 25,  0));

      ctx.fillStyle = grad;

      // Polygon: left edge top→bottom, right edge bottom→top
      ctx.beginPath();
      ctx.moveTo(_lx[0] - ex, 0);
      for (let s = 1; s <= SLICES; s++) {
        ctx.lineTo(_lx[s] - ex, (s / SLICES) * H);
      }
      for (let s = SLICES; s >= 0; s--) {
        ctx.lineTo(_rx[s] + ex, (s / SLICES) * H);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // ── restore canvas state ──────────────────────────────────────────────────
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
}
