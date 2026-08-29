/**
 * Ferrofluid — Audio-reactive magnetic liquid spike field.
 *
 * Inspired by Sachiko Kodama's "Protrude, Flow" (2001, SIGGRAPH Art Gallery),
 * in which ferrofluid controlled by electromagnetic coils reacts to ambient
 * sound by forming organic Rosensweig instability spike patterns.
 * https://www.sachikokodama.com/en/biography-en/
 *
 * A hexagonally-packed grid of spike emitters rises and falls with 7 frequency
 * bands (sub-bass at the left/centre → brilliance at the outer edge); each
 * spike is rendered with a stacked-ellipse technique that creates an illusion
 * of volumetric 3-D depth without WebGL. Iridescent thin-film sheen colours
 * the tips. Beats fire an expanding radial pressure wave that temporarily
 * boosts all spikes it crosses and shifts the global hue phase.
 *
 * Sliders
 *   Density     — hex grid spacing (coarse = few tall spikes → fine = many small)
 *   Height      — amplitude sensitivity and maximum spike extension
 *   Iridescence — 0 = dark monochrome ferrofluid, 1 = vivid rainbow shimmer
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ─── constants ───────────────────────────────────────────────────────────────

// Hue per band (violet → magenta palette matching other vizzes)
const BAND_HUES: readonly number[] = [270, 220, 175, 120, 60, 25, 300];

// Base hex grid spacing in pixels (modulated by Density slider)
const MIN_SPACING = isMobile ? 22 : 18;
const MAX_SPACING = isMobile ? 80 : 100;

// ─── module state ────────────────────────────────────────────────────────────

type PressureRing = { r: number; maxR: number; strength: number };

let lastBeatIndex = -1;
let globalHueShift = 0;
let pressureRings: PressureRing[] = [];
let noiseT = 0;

// Spike grid (rebuilt on resize or spacing change)
type Spike = {
  x: number;
  y: number;
  band: number;       // freq band (0–6) driving this spike
  noiseOff: number;   // per-spike phase for organic drift
  height: number;     // current normalised height [0, 1]
};

let spikes: Spike[] = [];
let gridW = 0;
let gridH = 0;
let gridSpacing = 0;

// ─── helpers ─────────────────────────────────────────────────────────────────

function valueNoise(x: number, y: number, t: number): number {
  const ix = Math.floor(x * 0.03 + t * 0.2);
  const iy = Math.floor(y * 0.03 + t * 0.13);
  const h = ((ix * 1619 + iy * 31337) ^ (ix * 31337 + iy * 1619)) & 0xffff;
  return h / 0xffff;
}

/** Map a spike's canvas x-position to a frequency band index (0–6). */
function bandForX(x: number, w: number): number {
  return Math.min(BAND_COUNT - 1, Math.floor((x / w) * BAND_COUNT));
}

/** Rebuild the hex grid whenever canvas size or spacing changes. */
function buildGrid(w: number, h: number, spacing: number): void {
  spikes = [];
  const rowH = spacing * Math.sqrt(3) * 0.5;
  let row = 0;
  for (let cy = -rowH; cy < h + rowH * 2; cy += rowH) {
    const offset = (row % 2 === 0) ? 0 : spacing * 0.5;
    for (let cx = -spacing + offset; cx < w + spacing; cx += spacing) {
      const band = bandForX(cx, w);
      spikes.push({
        x: cx,
        y: cy,
        band,
        noiseOff: Math.random() * 1000,
        height: 0,
      });
    }
    row++;
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

export function resetFerrofluid(): void {
  lastBeatIndex = -1;
  globalHueShift = 0;
  pressureRings = [];
  noiseT = 0;
  spikes = [];
  gridW = 0;
  gridH = 0;
  gridSpacing = 0;
}

export function drawFerrofluid(p: any, dt: number): void {
  const { state, config } = store;

  const density     = (config as any).ferrofluidDensity     as number ?? 0.5;
  const heightScale = (config as any).ferrofluidHeight       as number ?? 0.5;
  const iridescence = (config as any).ferrofluidIridescence  as number ?? 0.5;

  const w = p.width  as number;
  const h = p.height as number;

  // ── rebuild grid on resize or density change ──
  const spacing = MIN_SPACING + (1 - density) * (MAX_SPACING - MIN_SPACING);
  if (w !== gridW || h !== gridH || Math.abs(spacing - gridSpacing) > 0.5) {
    gridW = w;
    gridH = h;
    gridSpacing = spacing;
    buildGrid(w, h, spacing);
  }

  // ── per-band amplitudes and transients ──
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // ── beat detection ──
  const pos      = audioEngine.getPlaybackPosition();
  const adjusted = pos - state.beatOffset;
  const beatIndex = state.beatIntervalSec > 0 && adjusted >= 0
    ? Math.floor(adjusted / state.beatIntervalSec)
    : -1;

  if (beatIndex >= 0 && beatIndex !== lastBeatIndex) {
    lastBeatIndex = beatIndex;
    globalHueShift = (globalHueShift + 47) % 360;
    const maxR = Math.sqrt(w * w + h * h) * 0.6;
    pressureRings.push({ r: 0, maxR, strength: 1 });
  }

  // ── advance pressure rings ──
  const ringSpeed = 120 * dt;
  for (const ring of pressureRings) ring.r += ringSpeed;
  pressureRings = pressureRings.filter(ring => ring.r < ring.maxR);

  noiseT += 0.008 * dt;

  // ── update spike heights ──
  const maxSpikeH = spacing * (1.6 + heightScale * 3.0);
  const cx = w * 0.5;
  const cy = h * 0.5;

  for (const sp of spikes) {
    const amp      = amps[sp.band] ?? 0;
    const transient = transients[sp.band] ?? 1;

    // Organic per-spike Perlin drift
    const n     = valueNoise(sp.x + sp.noiseOff, sp.y + sp.noiseOff, noiseT);
    const drift = (n - 0.5) * 0.15;

    // Pressure ring boost
    let ringBoost = 0;
    const dx   = sp.x - cx;
    const dy   = sp.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    for (const ring of pressureRings) {
      const delta = Math.abs(dist - ring.r);
      if (delta < ringSpeed * 8) {
        ringBoost += ring.strength * (1 - delta / (ringSpeed * 8));
      }
    }

    const transBoost = (transient - 1) * 0.3;
    const target = Math.max(0, Math.min(1, amp * (0.5 + heightScale) + drift + ringBoost * 0.6 + transBoost));
    const attack  = target > sp.height ? 0.18 * dt : 0.08 * dt;
    sp.height += (target - sp.height) * attack;
  }

  // ── draw background ──
  p.background(8, 10, 18); // deep navy-black

  // ── draw spikes ──
  // Sort back-to-front by y so overlapping spikes look correct
  const sorted = spikes.slice().sort((a, b) => a.y - b.y);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 1);

  for (const sp of sorted) {
    if (sp.height < 0.005) continue;

    const spikeH  = sp.height * maxSpikeH;
    const bandHue = (BAND_HUES[sp.band] + globalHueShift) % 360;
    const steps   = Math.max(4, Math.round(12 * sp.height));

    for (let i = 0; i <= steps; i++) {
      const t  = i / steps; // 0 = base, 1 = tip
      const eW = spacing * 0.42 * (1 - t * 0.92); // width narrows to tip
      const eH = eW * 0.35; // flatten for top-down foreshortening

      // Vertical offset for spike perspective
      const yOff = -spikeH * t;

      // Color: base = near-black, mid = dark iridescent, tip = bright
      const iriAmt = iridescence * t * t;
      const noiseHue = valueNoise(sp.x, sp.y, noiseT + t);
      const hue = (bandHue + (noiseHue - 0.5) * 60 * iridescence) % 360;
      const sat = 20 + iriAmt * 80;
      const bri = 8 + t * t * (30 + iridescence * 55);
      const alpha = 0.7 + t * 0.3;

      p.noStroke();
      p.fill(hue, sat, bri, alpha);
      p.ellipse(sp.x, sp.y + yOff, eW * 2, eH * 2);
    }

    // Tip glow (3-pass additive)
    const tipY    = sp.y - spikeH;
    const tipHue  = (BAND_HUES[sp.band] + globalHueShift + 15) % 360;
    const tipAlpha = sp.height * 0.9;
    const tipR    = spacing * 0.13 + sp.height * spacing * 0.1;

    p.noStroke();
    // Outer halo
    p.fill(tipHue, 60 * iridescence, 80, tipAlpha * 0.15);
    p.ellipse(sp.x, tipY, tipR * 6, tipR * 6);
    // Mid
    p.fill(tipHue, 80 * iridescence, 90, tipAlpha * 0.35);
    p.ellipse(sp.x, tipY, tipR * 3, tipR * 3);
    // Core
    p.fill((tipHue + 20) % 360, 40, 100, tipAlpha * 0.8);
    p.ellipse(sp.x, tipY, tipR * 1.2, tipR * 1.2);
  }

  // ── draw pressure ring ripple on the base surface ──
  p.noFill();
  for (const ring of pressureRings) {
    const fade = 1 - ring.r / ring.maxR;
    if (fade <= 0) continue;
    p.stroke((globalHueShift + 180) % 360, 30, 90, fade * 0.12);
    (p as any).strokeWeight(1.5);
    p.ellipse(cx, cy, ring.r * 2, ring.r * 2);
    p.stroke((globalHueShift + 180) % 360, 50, 100, fade * 0.06);
    (p as any).strokeWeight(4);
    p.ellipse(cx, cy, ring.r * 2, ring.r * 2);
  }

  // ── reset color mode ──
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  p.noStroke();
}
