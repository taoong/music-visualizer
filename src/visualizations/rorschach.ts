/**
 * Rorschach — audio-reactive bilateral ink blot.
 *
 * Inspired by Andy Warhol's "Rorschach" series (1984–1986, The Broad / MoMA,
 * https://www.thebroad.org/art/andy-warhol/rorschach) — Warhol poured acrylic
 * paint onto large unprimed canvases and folded them vertically so the wet paint
 * transferred symmetrically to the other half, turning the clinical inkblot test
 * into a statement on pop-art seriality and projection. Here the same fold logic
 * is driven by audio: ink accumulates on cream paper with left-right bilateral
 * symmetry around a central fold line; 7 frequency bands spawn drops at
 * increasing distances from the fold (sub-bass near center → brilliance at
 * edges); amplitude controls density and size; beat fires a dramatic central
 * pour. Palette slides from Warhol's pure-black acrylic to full chromatic ink.
 *
 * Rendering: persistent HTMLCanvasElement at full res (½ res mobile) with a
 * slow fade back to cream so ink evolves across the arc of a track.
 *
 * Sliders
 *   Drip    — ink flow rate + drop size (sparse fine drops → heavy saturated pour)
 *   Spread  — ink feathering / bleed radius (crisp hard-edge → diffused soft halo)
 *   Palette — color: monochrome black on cream → full chromatic per-band hues
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band HSL hues: sub=violet, bass=blue, lowMid=teal, mid=green,
// upperMid=amber, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [270, 215, 175, 128, 48, 22, 355];

// Per-band layout: [xMinFrac, xMaxFrac, yCenter, yHalfSpread, baseRadius]
// xFrac: fraction of half-width measured from the fold line outward (0=fold, 1=edge)
// yCenter / yHalfSpread: fractions of canvas height
const BAND_LAYOUT: readonly (readonly [number, number, number, number, number])[] = [
  [0.02, 0.18, 0.50, 0.42, 22], // sub-bass: large, close to fold, any height
  [0.08, 0.24, 0.53, 0.38, 17], // bass
  [0.14, 0.30, 0.50, 0.40, 13], // low-mid
  [0.18, 0.34, 0.48, 0.41, 10], // mid
  [0.22, 0.38, 0.46, 0.42,  8], // upper-mid
  [0.27, 0.43, 0.48, 0.43,  6], // presence
  [0.32, 0.48, 0.50, 0.45,  4], // brilliance: small, furthest from fold
];

let trailCanvas: HTMLCanvasElement | null = null;
let trailCtx: CanvasRenderingContext2D | null = null;
let trailW = 0;
let trailH = 0;
let lastBeatIndex = -1;

function paperFill(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#f3ece0';
  ctx.fillRect(0, 0, w, h);
}

function inkColor(band: number, palette: number, alpha: number): string {
  if (palette < 0.02) {
    return `rgba(12,9,18,${alpha.toFixed(3)})`;
  }
  const hue = BAND_HUES[band];
  const sat = Math.round(palette * 82);
  const lig = Math.round(10 + palette * 15); // stays dark — reads as ink, not paint
  return `hsla(${hue},${sat}%,${lig}%,${alpha.toFixed(3)})`;
}

export function resetRorschach(): void {
  if (trailCtx && trailCanvas) {
    paperFill(trailCtx, trailCanvas.width, trailCanvas.height);
  }
  lastBeatIndex = -1;
}

export function drawRorschach(p: P5Instance, dt: number): void {
  const cfg      = store.config;
  const appState = store.state;

  const drip    = cfg.rorschachDrip;
  const spread  = cfg.rorschachSpread;
  const palette = cfg.rorschachPalette;

  const W = p.width;
  const H = p.height;
  const px = isMobile ? 0.5 : 1.0;
  const bW = Math.max(4, Math.floor(W * px));
  const bH = Math.max(4, Math.floor(H * px));

  // Initialize or resize the persistent ink buffer
  if (!trailCanvas || trailW !== bW || trailH !== bH) {
    if (!trailCanvas) trailCanvas = document.createElement('canvas');
    trailCanvas.width  = bW;
    trailCanvas.height = bH;
    trailCtx = trailCanvas.getContext('2d')!;
    trailW = bW;
    trailH = bH;
    paperFill(trailCtx, bW, bH);
  }

  const ctx = trailCtx!;
  const cx  = bW / 2; // fold-line x on the buffer

  // Gentle fade back toward paper — faster when Drip is low (ink evaporates)
  const fadeAlpha = 0.004 + (1 - drip) * 0.010;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(243,236,224,${fadeAlpha.toFixed(4)})`;
  ctx.fillRect(0, 0, bW, bH);

  const { amps } = getBandAverages(BAND_COUNT);
  const numBands = Math.min(amps.length, BAND_COUNT);

  // Beat detection via audioEngine
  const pos = audioEngine.getPlaybackPosition();
  const { beatIntervalSec, beatOffset, isPlaying } = appState;
  const adjusted  = pos - beatOffset;
  const beatIndex = beatIntervalSec > 0 && adjusted >= 0
    ? Math.floor(adjusted / beatIntervalSec)
    : -1;
  const newBeat = isPlaying && beatIndex >= 0 && beatIndex !== lastBeatIndex;
  if (newBeat) lastBeatIndex = beatIndex;

  // ── Ink drops per frequency band ──────────────────────────────────────────
  for (let b = 0; b < numBands; b++) {
    const amp = Math.max(0, amps[b]);
    if (amp < 0.015) continue;

    const [xMin, xMax, yCenter, yHalf, baseR] = BAND_LAYOUT[b];

    // Stochastic drop count — Poisson-sampled per frame
    const dropsPerFrame = amp * drip * 7 * dt;
    const numDrops =
      Math.floor(dropsPerFrame) +
      (Math.random() < dropsPerFrame - Math.floor(dropsPerFrame) ? 1 : 0);
    if (numDrops < 1) continue;

    const alpha = 0.14 + amp * 0.36;
    const color = inkColor(b, palette, alpha);
    const blur  = Math.max(0, spread * baseR * 2.5 * amp) * px;

    ctx.shadowColor = color;
    ctx.shadowBlur  = blur;
    ctx.fillStyle   = color;

    for (let d = 0; d < numDrops; d++) {
      const xFrac = xMin + Math.random() * (xMax - xMin);
      const xR    = cx + xFrac * cx;
      const yR    = (yCenter + (Math.random() - 0.5) * 2 * yHalf) * bH;
      const r     = Math.max(1,
        baseR * amp * (0.35 + Math.random() * 0.65) * px * (0.5 + drip * 0.5));

      // Right half
      ctx.beginPath();
      ctx.arc(xR, yR, r, 0, Math.PI * 2);
      ctx.fill();

      // Bilateral mirror — identical drop on left half
      ctx.beginPath();
      ctx.arc(bW - xR, yR, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
  }

  // ── Beat: dramatic central pour ────────────────────────────────────────────
  if (newBeat) {
    let ampSum = 0;
    for (let b = 0; b < numBands; b++) ampSum += amps[b];
    const avg       = ampSum / numBands;
    const pourCount = 5 + Math.floor(drip * 10);

    for (let i = 0; i < pourCount; i++) {
      // Bias toward lower bands for the main blot body
      const b = Math.floor(Math.random() * numBands * 0.7);
      const [xMin, xMax, yCenter, yHalf, baseR] = BAND_LAYOUT[b];

      // Concentrate toward the fold on beats
      const xFrac = xMin + Math.random() * (xMax - xMin) * 0.6;
      const xR    = cx + xFrac * cx * 0.75;
      const yR    = (yCenter + (Math.random() - 0.5) * yHalf * 1.2) * bH;
      const r     = Math.max(2,
        baseR * (1.8 + avg * 1.5) * (0.5 + Math.random() * 0.8) * px * (0.7 + drip * 0.3));

      const alpha = 0.45 + avg * 0.35;
      const color = inkColor(b, palette, alpha);

      ctx.shadowColor = color;
      ctx.shadowBlur  = r * spread * 2.5;
      ctx.fillStyle   = color;

      ctx.beginPath();
      ctx.arc(xR, yR, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(bW - xR, yR, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
  }

  // ── Composite to main canvas ───────────────────────────────────────────────
  p.background(243, 236, 224); // cream paper

  const mainCtx = p.drawingContext as CanvasRenderingContext2D;
  mainCtx.imageSmoothingEnabled = px < 1;
  mainCtx.imageSmoothingQuality = 'medium';
  mainCtx.drawImage(trailCanvas, 0, 0, W, H);

  // Subtle dashed fold mark — echoes the crease left by Warhol's folded canvas
  mainCtx.save();
  mainCtx.strokeStyle  = 'rgba(155,138,118,0.18)';
  mainCtx.lineWidth    = 0.8;
  mainCtx.setLineDash([3, 7]);
  mainCtx.lineDashOffset = 2;
  mainCtx.beginPath();
  mainCtx.moveTo(W / 2, 0);
  mainCtx.lineTo(W / 2, H);
  mainCtx.stroke();
  mainCtx.setLineDash([]);
  mainCtx.restore();
}
