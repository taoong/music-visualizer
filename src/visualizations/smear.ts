/**
 * Smear — audio-reactive squeegee painting inspired by Gerhard Richter's
 * "Abstraktes Bild" series (1980s–present).
 *
 * A persistent pixel buffer accumulates layers of colour that are
 * horizontally displaced each frame by audio energy. Seven vertical
 * colour zones (one per frequency band) bleed into each other through
 * repeated smearing, producing the layered depth and unpredictable
 * colour mixing of Richter's squeegee technique. Beats trigger dramatic
 * full-canvas sweeps in alternating directions plus a palette-hue shift.
 *
 * Rendering: offscreen HTMLCanvasElement pixel buffer at 1/4 resolution
 * (1/8 on mobile), upscaled with image smoothing.
 *
 * Sliders
 *   Sweep   — displacement magnitude (subtle texture → aggressive smearing)
 *   Blend   — trail persistence (ghostly wash → dense impasto)
 *   Palette — colour saturation (muted grey → vivid Richter hues)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 8 : 4;

const BAND_HUES = [5, 30, 52, 150, 215, 275, 328];

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let rW = 0;
let rH = 0;
let pixelBuf: Uint8ClampedArray | null = null;
let tempRow: Uint8ClampedArray | null = null;
let cachedImageData: ImageData | null = null;

let time = 0;
let hueOffset = 0;
let wavePhase = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let sweepDir = 1;
let sweepMomentum = 0;

function initBuffers(canvasW: number, canvasH: number): void {
  rW = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  rH = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = rW;
  offscreenCanvas.height = rH;
  offscreenCtx = offscreenCanvas.getContext('2d')!;
  pixelBuf = new Uint8ClampedArray(rW * rH * 4);
  tempRow = new Uint8ClampedArray(rW * 4);
  cachedImageData = offscreenCtx.createImageData(rW, rH);
  for (let i = 0; i < pixelBuf.length; i += 4) {
    pixelBuf[i] = 12; pixelBuf[i + 1] = 10; pixelBuf[i + 2] = 8; pixelBuf[i + 3] = 255;
  }
}

function hsvToRgb(h: number, s: number, v: number, out: Uint8ClampedArray, off: number): void {
  h = ((h % 360) + 360) % 360 / 60;
  const i = h | 0;
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (i) {
    case 0:  r = v; g = t; b = p; break;
    case 1:  r = q; g = v; b = p; break;
    case 2:  r = p; g = v; b = t; break;
    case 3:  r = p; g = q; b = v; break;
    case 4:  r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  out[off]     = (r * 255 + 0.5) | 0;
  out[off + 1] = (g * 255 + 0.5) | 0;
  out[off + 2] = (b * 255 + 0.5) | 0;
}

export function drawSmear(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const sweep   = config.smearSweep;
  const blend   = config.smearBlend;
  const palette = config.smearPalette;

  const needW = Math.max(1, Math.floor(p.width / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!offscreenCanvas || needW !== rW || needH !== rH) {
    initBuffers(p.width, p.height);
  }

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      hueOffset += 20 + Math.random() * 40;
      wavePhase += Math.PI * (0.4 + Math.random() * 1.2);
      sweepDir *= -1;
      sweepMomentum = 1.0;
      beatFlash = 1.0;
    }
  }

  beatFlash *= Math.pow(0.84, dt);
  sweepMomentum *= Math.pow(0.86, dt);
  time += 0.012 * dt;

  let totalAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) totalAmp += amps[b];
  totalAmp /= BAND_COUNT;

  const fadeRate = 0.96 + blend * 0.038;
  const maxDisp  = 1 + sweep * (isMobile ? 8 : 14);
  const PI = Math.PI;

  const bandRgb = new Uint8ClampedArray(BAND_COUNT * 3);
  const bandAlphas = new Float64Array(BAND_COUNT);
  const sat = 0.12 + palette * 0.78;
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    const hue = (BAND_HUES[b] + hueOffset) % 360;
    const val = Math.min(1.0, 0.35 + amp * 0.6 + beatFlash * 0.1);
    hsvToRgb(hue, sat, val, bandRgb, b * 3);
    bandAlphas[b] = amp > 0.01 ? 0.04 + amp * 0.14 + beatFlash * 0.08 : 0;
  }

  const buf = pixelBuf!;
  const tmp = tempRow!;
  const invBandCount = 1 / rW;

  for (let y = 0; y < rH; y++) {
    const yNorm   = y / rH;
    const rowBand = Math.min(BAND_COUNT - 1, (yNorm * BAND_COUNT) | 0);
    const rowAmp  = amps[rowBand];

    const wave1 = Math.sin(yNorm * PI * 4.7 + wavePhase + time * 0.6);
    const wave2 = Math.sin(yNorm * PI * 11.3 + wavePhase * 1.7 + time * 0.3) * 0.35;
    const contDisp = rowAmp * (2.5 + totalAmp * 2) * (wave1 + wave2);
    const beatDisp = sweepMomentum * maxDisp * 3 * sweepDir;
    const rawDisp  = contDisp * sweep + beatDisp;
    const disp     = Math.round(rawDisp);

    const rowStart = y * rW * 4;
    tmp.set(buf.subarray(rowStart, rowStart + rW * 4));

    for (let x = 0; x < rW; x++) {
      const srcX   = x - disp;
      const dstOff = rowStart + x * 4;
      let r: number, g: number, b2: number;

      if (srcX >= 0 && srcX < rW) {
        const srcOff = srcX * 4;
        r  = (tmp[srcOff]     * fadeRate) | 0;
        g  = (tmp[srcOff + 1] * fadeRate) | 0;
        b2 = (tmp[srcOff + 2] * fadeRate) | 0;
      } else {
        r = 12; g = 10; b2 = 8;
      }

      const bIdx = Math.min(BAND_COUNT - 1, (x * BAND_COUNT * invBandCount) | 0);
      const alpha = bandAlphas[bIdx];
      if (alpha > 0) {
        const ia  = 1 - alpha;
        const bo  = bIdx * 3;
        r  = Math.min(255, (r  * ia + bandRgb[bo]     * alpha) | 0);
        g  = Math.min(255, (g  * ia + bandRgb[bo + 1] * alpha) | 0);
        b2 = Math.min(255, (b2 * ia + bandRgb[bo + 2] * alpha) | 0);
      }

      if (beatFlash > 0.05) {
        const fa = beatFlash * 0.06;
        const fi = 1 - fa;
        r  = Math.min(255, (r  * fi + 240 * fa) | 0);
        g  = Math.min(255, (g  * fi + 230 * fa) | 0);
        b2 = Math.min(255, (b2 * fi + 220 * fa) | 0);
      }

      buf[dstOff]     = r;
      buf[dstOff + 1] = g;
      buf[dstOff + 2] = b2;
      buf[dstOff + 3] = 255;
    }
  }

  cachedImageData!.data.set(buf);
  offscreenCtx!.putImageData(cachedImageData!, 0, 0);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);
}

export function resetSmear(): void {
  offscreenCanvas  = null;
  offscreenCtx     = null;
  rW = 0;
  rH = 0;
  pixelBuf         = null;
  tempRow          = null;
  cachedImageData  = null;
  lastBeatIndex    = -1;
  beatFlash        = 0;
  sweepMomentum    = 0;
}
