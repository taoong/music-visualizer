/**
 * Lens Flare — audio-reactive anamorphic lens flare field.
 *
 * 7 chromatic light sources (one per frequency band) are arranged in a
 * slow-drifting ring. Each source emits cinematographic lens-flare
 * artifacts: a soft central bloom, four-point diffraction spikes, a
 * horizontal anamorphic streak, and ghosted bokeh circles along the
 * axis from the source through the canvas centre. Sources blend
 * additively — where multiple bands peak simultaneously their colours
 * mix to near-white, recreating the moment a bright light overwhelms a
 * camera lens. The "sculpture" is the colour itself: no material object,
 * only the ordered arrangement of chromatic light through space.
 *
 * Inspired by teamLab "Chromatic Existence" (2026, Light Sculpture – Flow
 * Zone, teamLab Borderless, Azabudai Hills Tokyo) — an artwork where
 * colour pours through space and its order becomes the sculpture, with no
 * surface, no edges, nothing to walk around.
 * https://www.businesswire.com/news/home/20260807256066/en/teamLab-Unveils-New-Series-from-Light-Sculpture---Flow-at-teamLab-Borderless
 *
 * Sliders:
 *   Streak (lensflareStreak) — anamorphic horizontal streak length; 0 = none, 1 = full-width
 *   Ghosts (lensflareGhosts) — ghost bokeh count and intensity along flare axis; 0 = none, 1 = vivid
 *   Bloom  (lensflareBloom)  — central glow radius; 0 = tight bright dot, 1 = large diffuse cloud
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────

// Per-band hue (HSL): violet → blue → cyan → green → yellow → orange → red
const BAND_HUES = [275, 240, 195, 130, 60, 25, 0] as const;

// Four diffraction spike angles (each also has a 180° counterpart)
const SPIKE_ANGLES = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4] as const;

// Source positions: evenly distributed on an ellipse around canvas centre
// computed lazily so they adapt to canvas size
interface Source {
  baseAngle: number; // fixed angle on the ring
  driftAngle: number; // slow drift offset
  driftSpeed: number; // drift speed multiplier
}

// ── Module state ─────────────────────────────────────────────────────────────
let sources: Source[] = [];
let lastBeatIndex = -1;
let beatFlash = 0;
let hueShift = 0;
let time = 0;

// Pre-allocated RGB cache (avoid per-frame object alloc)
const rgbCache: { r: number; g: number; b: number }[] = Array.from(
  { length: BAND_COUNT },
  () => ({ r: 0, g: 0, b: 0 })
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** HSL (h:0-360, s:0-100, l:0-100) → {r,g,b} 0-255 */
function hslToRgb(h: number, s: number, l: number, out: { r: number; g: number; b: number }): void {
  const S = s / 100;
  const L = l / 100;
  const C = (1 - Math.abs(2 * L - 1)) * S;
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - C / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = C; g = X; b = 0; }
  else if (h < 120) { r = X; g = C; b = 0; }
  else if (h < 180) { r = 0; g = C; b = X; }
  else if (h < 240) { r = 0; g = X; b = C; }
  else if (h < 300) { r = X; g = 0; b = C; }
  else              { r = C; g = 0; b = X; }
  out.r = Math.round((r + m) * 255);
  out.g = Math.round((g + m) * 255);
  out.b = Math.round((b + m) * 255);
}

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// ── Init ─────────────────────────────────────────────────────────────────────

function ensureInit(): void {
  if (sources.length === BAND_COUNT) return;
  sources = Array.from({ length: BAND_COUNT }, (_, b) => ({
    baseAngle: (b / BAND_COUNT) * Math.PI * 2,
    driftAngle: 0,
    driftSpeed: 0.2 + Math.random() * 0.6,
  }));
}

// ── Reset ────────────────────────────────────────────────────────────────────

export function resetLensflare(): void {
  sources = [];
  lastBeatIndex = -1;
  beatFlash = 0;
  hueShift = 0;
  time = 0;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawLensflare(p: P5Instance, dt: number): void {
  ensureInit();

  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const cx = W * 0.5;
  const cy = H * 0.5;
  const diag = Math.hypot(W, H);

  // Advance time
  time += dt * 0.008;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatFlash = 1.0;
      hueShift = (hueShift + 51) % 360;
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  // ── Slider → usable ranges ────────────────────────────────────────────────
  const streakLevel = config.lensflareStreak; // 0–1
  const ghostLevel  = config.lensflareGhosts; // 0–1
  const bloomLevel  = config.lensflareBloom;  // 0–1

  const ringRx = W * (isMobile ? 0.28 : 0.32);
  const ringRy = H * (isMobile ? 0.28 : 0.32);
  const maxBloomR = diag * (0.06 + bloomLevel * 0.24); // 6%–30% of diagonal
  const ghostCount = isMobile ? 3 : Math.round(2 + ghostLevel * 4); // 2–6

  // ── Draw ──────────────────────────────────────────────────────────────────
  p.background(0);

  const ctx = (p as unknown as { drawingContext: CanvasRenderingContext2D }).drawingContext;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (let b = 0; b < BAND_COUNT; b++) {
    const raw = amps[b];
    const amp = Math.min(1, raw + beatFlash * 0.25);
    if (amp < 0.015) continue;

    // Slowly drift source position around the ring
    const src = sources[b];
    src.driftAngle += dt * 0.0003 * src.driftSpeed;
    const angle = src.baseAngle + src.driftAngle;
    const sx = cx + ringRx * Math.cos(angle);
    const sy = cy + ringRy * Math.sin(angle);

    // Colour for this band
    const hue = ((BAND_HUES[b] + hueShift) % 360 + 360) % 360;
    hslToRgb(hue, 90, 65, rgbCache[b]);
    const { r, g, b: bv } = rgbCache[b];

    const bloomR = maxBloomR * amp;

    // 1. Central bloom glow ──────────────────────────────────────────────────
    if (bloomR > 2) {
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, bloomR);
      grad.addColorStop(0,    `rgba(255,255,255,${Math.min(1, amp * 1.6).toFixed(3)})`);
      grad.addColorStop(0.12, rgba(r, g, bv, amp * 0.95));
      grad.addColorStop(0.45, rgba(r, g, bv, amp * 0.35));
      grad.addColorStop(1,    'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, bloomR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Diffraction spikes ──────────────────────────────────────────────────
    const spikeLen = bloomR * (1.8 + streakLevel * 1.2);
    const spikeAlpha = amp * 0.8;
    ctx.lineWidth = isMobile ? 1.5 : 2;
    for (const sa of SPIKE_ANGLES) {
      drawSpike(ctx, sx, sy, sa,           spikeLen, r, g, bv, spikeAlpha);
      drawSpike(ctx, sx, sy, sa + Math.PI, spikeLen, r, g, bv, spikeAlpha);
    }

    // 3. Anamorphic horizontal streak ────────────────────────────────────────
    if (streakLevel > 0.04 && amp > 0.08) {
      const reach = W * (0.2 + streakLevel * 0.8) * amp;
      const halfH = Math.max(1.5, 4 * amp);
      const alpha = amp * streakLevel * 0.65;

      // Left arm
      const leftGrad = ctx.createLinearGradient(sx, sy, sx - reach, sy);
      leftGrad.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
      leftGrad.addColorStop(0.3, rgba(r, g, bv, alpha * 0.5));
      leftGrad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = leftGrad;
      ctx.fillRect(sx - reach, sy - halfH, reach, halfH * 2);

      // Right arm
      const rightGrad = ctx.createLinearGradient(sx, sy, sx + reach, sy);
      rightGrad.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
      rightGrad.addColorStop(0.3, rgba(r, g, bv, alpha * 0.5));
      rightGrad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.fillStyle = rightGrad;
      ctx.fillRect(sx, sy - halfH, reach, halfH * 2);
    }

    // 4. Ghost bokeh along flare axis ────────────────────────────────────────
    if (ghostLevel > 0.04 && ghostCount > 0) {
      const dxAxis = cx - sx;
      const dyAxis = cy - sy;
      const overshoot = 1.0 + ghostLevel * 0.6; // ghosts extend beyond centre

      for (let g2 = 0; g2 < ghostCount; g2++) {
        const t = (g2 + 1) / (ghostCount + 1) * overshoot;
        const gx = sx + dxAxis * t;
        const gy = sy + dyAxis * t;
        const gSize = bloomR * (0.08 + (1 - t / overshoot) * 0.22) * (1 + ghostLevel);
        const gAlpha = amp * ghostLevel * (0.3 + (1 - t / overshoot) * 0.45);

        if (gSize < 1.5 || gAlpha < 0.01) continue;

        // Alternate between solid and ring ghosts for variety
        if (g2 % 2 === 0) {
          const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gSize);
          gg.addColorStop(0,   rgba(r, g, bv, gAlpha));
          gg.addColorStop(0.5, rgba(r, g, bv, gAlpha * 0.4));
          gg.addColorStop(1,   'rgba(0,0,0,0)');
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.arc(gx, gy, gSize, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Ring ghost (annular)
          const gg = ctx.createRadialGradient(gx, gy, gSize * 0.55, gx, gy, gSize);
          gg.addColorStop(0,   'rgba(0,0,0,0)');
          gg.addColorStop(0.4, rgba(r, g, bv, gAlpha * 0.6));
          gg.addColorStop(0.7, rgba(r, g, bv, gAlpha * 0.9));
          gg.addColorStop(1,   'rgba(0,0,0,0)');
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.arc(gx, gy, gSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ── Beat flash ────────────────────────────────────────────────────────────
  if (beatFlash > 0.02) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = beatFlash * 0.12;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

// ── Spike helper ─────────────────────────────────────────────────────────────

function drawSpike(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  angle: number,
  length: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  const ex = ox + Math.cos(angle) * length;
  const ey = oy + Math.sin(angle) * length;

  const grad = ctx.createLinearGradient(ox, oy, ex, ey);
  grad.addColorStop(0,   `rgba(255,255,255,${alpha.toFixed(3)})`);
  grad.addColorStop(0.2, rgba(r, g, b, alpha * 0.75));
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.strokeStyle = grad;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
}
