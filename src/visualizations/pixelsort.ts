/**
 * Pixel Sort — glitch-art column pixel sorting driven by audio.
 *
 * Inspired by Kim Asendorf's "Mountain Tour" pixel-sorting technique (2010,
 * kimasendorf.com/mountain-tour/), later open-sourced in Processing (2012).
 * A synthetic plasma colour field (7 freq-band hue zones) is generated each
 * frame, then each column is scanned for contiguous "runs" of pixels whose
 * luminance exceeds a dynamic threshold.  Each run is sorted ascending by
 * brightness, producing the characteristic upward-bleeding streaks and glitchy
 * gradient columns of pixel-sort / databending art.
 *
 * Audio reactivity
 *   Bass amplitude lowers the effective sort threshold — heavier bass means
 *   longer sorted runs across the whole image.  Beat transients inject a
 *   "sort surge" that briefly forces near-full-column sorting.  Each of the 7
 *   frequency bands colours one vertical stripe of the source plasma field so
 *   sorted columns carry distinct band-specific hues.
 *
 * Rendering: offscreen HTMLCanvasElement at ⅓ resolution (⅙ on mobile),
 * blitted with imageSmoothingEnabled=false for a crisp pixel-art glitch look.
 *
 * Sliders
 *   Threshold  — luminance level above which pixels enter a sortable run.
 *                Low = everything gets sorted (maximally glitchy).
 *                High = only the brightest peaks get sorted (subtle shimmer).
 *   Span       — maximum length of a sorted run (buffer pixels).
 *                Short = tight isolated banding; long = sweeping column streaks.
 *   Hue        — palette rotation across all 7 band colour zones.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// 1 screen pixel → PIXEL_SCALE buffer pixels (lower = sharper but heavier)
const PIXEL_SCALE = isMobile ? 6 : 3;

// Base hue per freq band (sub=blue → brilliance=violet, wrapping rainbow)
const BAND_HUES: ReadonlyArray<number> = [240, 195, 160, 100, 55, 20, 300];

// ── Module-scoped state ────────────────────────────────────────────────────────
let time         = 0;
let lastBeatIdx  = -1;
let sortSurge    = 0;  // decaying threshold boost fired on each beat

let offCanvas:   HTMLCanvasElement | null = null;
let offCtx:      CanvasRenderingContext2D | null = null;
let rW           = 0;
let rH           = 0;
// Pre-allocated packed work buffer for per-column sort (avoids GC pressure)
let workPacked:  Uint32Array | null = null;

// ── Buffer initialisation ──────────────────────────────────────────────────────

function initBuffers(canvasW: number, canvasH: number): void {
  rW = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  rH = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offCanvas        = document.createElement('canvas');
  offCanvas.width  = rW;
  offCanvas.height = rH;
  offCtx           = offCanvas.getContext('2d')!;
  workPacked       = new Uint32Array(rH);
}

// ── HSV → 0xRRGGBB packed helper ──────────────────────────────────────────────

function hsvPacked(h: number, s: number, v: number): number {
  h = ((h % 360) + 360) % 360;
  const h6 = h / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  const p  = v * (1 - s);
  const q  = v * (1 - s * f);
  const t  = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (i) {
    case 0:  r = v; g = t; b = p; break;
    case 1:  r = q; g = v; b = p; break;
    case 2:  r = p; g = v; b = t; break;
    case 3:  r = p; g = q; b = v; break;
    case 4:  r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  // Bitwise OR on signed 32-bit ints; extracted later with >>> (unsigned shift)
  return ((r * 255 + 0.5) | 0) << 16 | ((g * 255 + 0.5) | 0) << 8 | ((b * 255 + 0.5) | 0);
}

// ── Draw ──────────────────────────────────────────────────────────────────────

export function drawPixelsort(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Resize / first-run
  const needW = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!offCanvas || needW !== rW || needH !== rH) {
    initBuffers(p.width, p.height);
  }

  // Beat detection → sort surge
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      sortSurge   = 1.0;
    }
  }
  sortSurge *= Math.pow(0.82, dt);

  time += 0.006 * dt;

  // ── Step 1: generate plasma source field ─────────────────────────────────
  const hueBase = config.pixelsortHue * 360;
  const imgData = offCtx!.createImageData(rW, rH);
  const pixels  = imgData.data;

  for (let px = 0; px < rW; px++) {
    // Map column to freq band
    const bandIdx = Math.min(BAND_COUNT - 1, Math.floor((px / rW) * BAND_COUNT));
    const amp     = amps[bandIdx];
    const baseHue = BAND_HUES[bandIdx] + hueBase;
    const sat     = Math.min(1.0, 0.58 + amp * 0.42);

    for (let py = 0; py < rH; py++) {
      const ny = py / rH;

      // Multi-harmonic brightness wave — creates horizontal stripes that sort beautifully
      const luma = Math.max(0.03, Math.min(0.96,
          0.18
        + 0.28 * Math.sin(ny * 7.0  + time * 0.65 + bandIdx * 0.70)
        + 0.20 * Math.sin(ny * 3.0  + time * 1.15)
        + 0.12 * Math.sin(ny * 15.0 + time * 2.30 + bandIdx * 1.40)
        + amp * 0.38
      ));

      const hue    = (baseHue + time * 12 + py * 0.4) % 360;
      const packed = hsvPacked(hue, sat, luma);
      const off    = (py * rW + px) * 4;
      pixels[off]     = (packed >>> 16) & 0xff;
      pixels[off + 1] = (packed >>>  8) & 0xff;
      pixels[off + 2] =  packed & 0xff;
      pixels[off + 3] = 255;
    }
  }

  // ── Step 2: column pixel sorting ─────────────────────────────────────────
  // Clamp to >=2 AFTER the min() — at very small canvas heights (e.g. during
  // an aggressive window resize) rH-1 can be 0, which would leave the inner
  // "collect run" loop unable to advance py and spin the outer while forever.
  const maxSpan = Math.max(2, Math.min(rH - 1, Math.floor(10 + config.pixelsortSpan * 390)));
  if (rH < 2) return; // Nothing to sort in a 1-pixel-tall buffer

  // Effective threshold: base value lowered by bass energy and beat surge
  const bassAmp       = amps[1];
  const dynamicThresh = Math.max(0.03,
    config.pixelsortThreshold - bassAmp * 0.38 - sortSurge * 0.44
  );
  const threshLuma = (dynamicThresh * 255) | 0;

  const wp = workPacked!;

  for (let px = 0; px < rW; px++) {
    let py = 0;
    while (py < rH) {
      const off0 = (py * rW + px) * 4;
      // Quick luminance check (BT.601 integer approx)
      const l0 = (pixels[off0] * 77 + pixels[off0 + 1] * 150 + pixels[off0 + 2] * 29) >> 8;

      if (l0 <= threshLuma) { py++; continue; }

      // Collect the run of above-threshold pixels (bounded by maxSpan)
      const runStart = py;
      let   runLen   = 0;
      while (py < rH && runLen < maxSpan) {
        const off = (py * rW + px) * 4;
        const l   = (pixels[off] * 77 + pixels[off + 1] * 150 + pixels[off + 2] * 29) >> 8;
        if (l <= threshLuma) break;
        // Pack: luma in top byte, R/G/B in lower 3 bytes.
        // Uint32Array sort is unsigned-ascending, so luma drives the primary order.
        wp[runLen] = (l << 24) | (pixels[off] << 16) | (pixels[off + 1] << 8) | pixels[off + 2];
        runLen++;
        py++;
      }

      if (runLen < 2) continue;

      // Sort by luma (top byte) — Uint32Array.sort() treats values as unsigned 32-bit
      wp.subarray(0, runLen).sort();

      // Write back: dark pixels at top of run, bright at bottom (classic pixel-sort look)
      for (let i = 0; i < runLen; i++) {
        const off = ((runStart + i) * rW + px) * 4;
        const v   = wp[i];
        pixels[off]     = (v >>> 16) & 0xff;
        pixels[off + 1] = (v >>>  8) & 0xff;
        pixels[off + 2] =  v & 0xff;
        // alpha already 255
      }
    }
  }

  offCtx!.putImageData(imgData, 0, 0);

  // Blit to main canvas — no smoothing for crisp glitch aesthetic
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offCanvas!, 0, 0, p.width, p.height);
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export function resetPixelsort(): void {
  offCanvas  = null;
  offCtx     = null;
  rW         = 0;
  rH         = 0;
  workPacked = null;
  lastBeatIdx = -1;
  sortSurge   = 0;
  // time preserved intentionally — seamless across resize / track switch
}
