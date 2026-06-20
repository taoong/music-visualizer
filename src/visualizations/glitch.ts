/**
 * Glitch — Audio-reactive analog/VHS glitch art.
 *
 * Inspired by Nam June Paik's pioneering video art, specifically his
 * magnetic CRT distortions in "Global Groove" (1973) and "Magnet TV"
 * (1965), where audio and magnetic fields warped television signals into
 * expressive, living abstractions. Also draws from the contemporary
 * glitch-art movement (Rosa Menkman, Phillip Stearns).
 *
 * Seven vertical color bars (one per frequency band) form a base signal
 * reminiscent of SMPTE test patterns. Audio-driven distortion effects
 * corrupt the signal: bass bends scanlines horizontally, mid-range
 * splits RGB channels, treble injects static grain, and beats trigger
 * dramatic tracking-loss bars and displaced block artifacts.
 *
 * Rendering: offscreen pixel buffer at ⅓ res (⅕ mobile).
 * Beat: tracking bar flash + block displacement.
 *
 * Sliders
 *   Distort — horizontal scanline displacement intensity
 *   Split   — RGB chromatic aberration separation
 *   Noise   — analog static grain density
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 5 : 3;

const BAND_HUES: readonly number[] = [310, 350, 25, 55, 175, 225, 275];

let lastBeatIndex = -1;
let hueShift = 0;
let time = 0;
let buf: P5Graphics | null = null;
let bufW = 0;
let bufH = 0;

let trackBarY = -1;
let trackBarStr = 0;

type GlitchBlock = {
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  life: number;
};
let blocks: GlitchBlock[] = [];

let baseR: Uint8Array | null = null;
let baseG: Uint8Array | null = null;
let baseB: Uint8Array | null = null;

export function resetGlitch(): void {
  lastBeatIndex = -1;
  hueShift = 0;
  time = 0;
  trackBarY = -1;
  trackBarStr = 0;
  blocks = [];
  baseR = baseG = baseB = null;
  buf?.remove();
  buf = null;
  bufW = bufH = 0;
}

function hsbToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  v /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) =>
    v * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

export function drawGlitch(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const gW = Math.ceil(W / PIXEL_SCALE);
  const gH = Math.ceil(H / PIXEL_SCALE);

  if (!buf || bufW !== gW || bufH !== gH) {
    buf?.remove();
    buf = p.createGraphics(gW, gH);
    buf.noSmooth();
    bufW = gW;
    bufH = gH;
    const sz = gW * gH;
    baseR = new Uint8Array(sz);
    baseG = new Uint8Array(sz);
    baseB = new Uint8Array(sz);
  }

  time += dt * 0.008;

  const distort = config.glitchDistort;
  const split = config.glitchSplit;
  const noise = config.glitchNoise;

  let avgAmp = 0;
  for (let i = 0; i < BAND_COUNT; i++) avgAmp += amps[i];
  avgAmp /= BAND_COUNT;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx =
      adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 25) % 360;
      trackBarY = Math.random();
      trackBarStr = 1.0;
      const numBlocks = 1 + Math.floor(Math.random() * 3 * distort);
      for (let k = 0; k < numBlocks; k++) {
        blocks.push({
          x: Math.random() * 0.6,
          y: Math.random(),
          w: 0.1 + Math.random() * 0.25,
          h: 0.01 + Math.random() * 0.06,
          dx: (Math.random() - 0.5) * 0.35,
          life: 1.0,
        });
      }
    }
  }

  // Decay beat effects
  trackBarStr *= Math.pow(0.87, dt);
  if (trackBarStr < 0.01) trackBarStr = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    blocks[i].life *= Math.pow(0.84, dt);
    if (blocks[i].life < 0.02) blocks.splice(i, 1);
  }

  // Precompute band colors at full brightness
  const bandRgb: [number, number, number][] = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    bandRgb.push(hsbToRgb((BAND_HUES[i] + hueShift) % 360, 82, 100));
  }

  // --- Pass 1: generate base image (vertical color bars) ---
  const colW = 1 / BAND_COUNT;
  for (let gy = 0; gy < gH; gy++) {
    const fy = gy / gH;
    const vGrad = 1 - 0.25 * Math.pow((fy - 0.5) * 2, 2);
    const rowOfs = gy * gW;

    for (let gx = 0; gx < gW; gx++) {
      const fx = gx / gW;
      const bandF = fx / colW;
      const band = Math.min(Math.floor(bandF), BAND_COUNT - 1);
      const frac = bandF - band;

      const ripple =
        0.88 + 0.12 * Math.sin(fx * 18 + fy * 5 + time * (0.4 + band * 0.12));
      const amp0 = amps[band];
      const scale0 = (0.10 + amp0 * 0.80) * vGrad * ripple;
      let r = bandRgb[band][0] * scale0;
      let g = bandRgb[band][1] * scale0;
      let b = bandRgb[band][2] * scale0;

      // Smooth blend at column edges
      const edge = 0.18;
      if (frac > 1 - edge && band < BAND_COUNT - 1) {
        const next = band + 1;
        const blend = (frac - (1 - edge)) / edge;
        const scale1 = (0.10 + amps[next] * 0.80) * vGrad * ripple;
        r = r * (1 - blend) + bandRgb[next][0] * scale1 * blend;
        g = g * (1 - blend) + bandRgb[next][1] * scale1 * blend;
        b = b * (1 - blend) + bandRgb[next][2] * scale1 * blend;
      }

      const idx = rowOfs + gx;
      baseR![idx] = Math.min(255, r) | 0;
      baseG![idx] = Math.min(255, g) | 0;
      baseB![idx] = Math.min(255, b) | 0;
    }
  }

  // --- Pass 2: apply distortion, write to pixel buffer ---
  const splitPx = split * (0.15 + avgAmp * 0.85) * gW * 0.04;

  buf.loadPixels();
  const px = buf.pixels;

  for (let gy = 0; gy < gH; gy++) {
    const fy = gy / gH;

    // Scanline displacement (bass-driven horizontal bending)
    let rowDisp = 0;
    rowDisp += Math.sin(fy * 4.5 + time * 0.55) * amps[0] * 0.08;
    rowDisp += Math.sin(fy * 11 + time * 1.3) * amps[1] * 0.05;
    rowDisp += Math.sin(fy * 23 + time * 2.7) * amps[2] * 0.025;

    // Tracking bar displacement
    if (trackBarStr > 0) {
      const d = Math.abs(fy - trackBarY);
      if (d < 0.07) {
        const inf = (1 - d / 0.07) * trackBarStr;
        rowDisp += inf * (0.18 + Math.sin(gy * 0.9) * 0.08);
      }
    }

    const rowDispPx = rowDisp * distort * gW * 8;

    // Find block affecting this row
    let blkOff = 0;
    let blkXMin = 0;
    let blkXMax = 0;
    let hasBlock = false;
    for (const bl of blocks) {
      if (fy >= bl.y && fy < bl.y + bl.h) {
        blkOff = bl.dx * bl.life * gW;
        blkXMin = bl.x;
        blkXMax = bl.x + bl.w;
        hasBlock = true;
        break;
      }
    }

    const scanDim = gy & 1 ? 0.82 : 1.0;
    const rowBase = gy * gW;

    for (let gx = 0; gx < gW; gx++) {
      const fx = gx / gW;
      const pixOff =
        rowDispPx +
        (hasBlock && fx >= blkXMin && fx < blkXMax ? blkOff : 0);

      // Sample RGB channels at offset positions (chromatic aberration)
      const sxR = ((Math.round(gx + pixOff + splitPx) % gW) + gW) % gW;
      const sxG = ((Math.round(gx + pixOff) % gW) + gW) % gW;
      const sxB = ((Math.round(gx + pixOff - splitPx) % gW) + gW) % gW;

      let r = baseR![rowBase + sxR] * scanDim;
      let g = baseG![rowBase + sxG] * scanDim;
      let b = baseB![rowBase + sxB] * scanDim;

      // Tracking bar flash
      if (trackBarStr > 0) {
        const d = Math.abs(fy - trackBarY);
        if (d < 0.03) {
          const flash = (1 - d / 0.03) * trackBarStr * 0.65;
          r = Math.min(255, r + flash * 230);
          g = Math.min(255, g + flash * 230);
          b = Math.min(255, b + flash * 230);
        }
      }

      // Static noise (treble-driven)
      if (
        noise > 0.05 &&
        Math.random() < noise * (amps[5] * 0.35 + amps[6] * 0.65) * 0.5
      ) {
        const nv = Math.random() * 200 * noise;
        r = Math.min(255, r * 0.55 + nv);
        g = Math.min(255, g * 0.55 + nv);
        b = Math.min(255, b * 0.55 + nv);
      }

      const pi = (rowBase + gx) * 4;
      px[pi] = r;
      px[pi + 1] = g;
      px[pi + 2] = b;
      px[pi + 3] = 255;
    }
  }

  buf.updatePixels();
  p.background(0);
  p.noSmooth();
  p.image(buf as unknown as P5Image, 0, 0, W, H);
  p.smooth();
}
