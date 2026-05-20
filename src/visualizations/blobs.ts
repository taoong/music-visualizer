/**
 * Blobs — Audio-reactive metaball field.
 *
 * Inspired by Zachary Lieberman's "Circles, Blobs, Ripples" exhibition at
 * Unit London (Feb–Mar 2024, https://unitlondon.com/exhibitions/zachary-lieberman-circles-blobs-ripples/)
 * — biomorphic forms that push and pull like liquid, circles dissipating
 * into ripple-like patterns driven by code and sound.
 *
 * Seven metaballs (one per frequency band) drift through the canvas via
 * Perlin noise. Each ball's charge scales with its band's amplitude, so
 * quiet passages yield small scattered orbs while loud moments merge
 * everything into a single heaving mass. The classic 1/r² metaball scalar
 * field is sampled at every pixel and thresholded to produce seamless
 * organic fusion.
 *
 * Rendering: offscreen pixel buffer at ¼ res (⅙ mobile).
 * Beat: all blobs burst radially outward from the canvas center.
 *
 * Sliders
 *   Viscosity — threshold where blobs fuse (low = always merged, high = stay separate)
 *   Drift     — Perlin-noise animation speed
 *   Glow      — edge glow radius and intensity
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 4;

// Hue per band: sub=violet, bass=blue, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=red
const BAND_HUES: readonly number[] = [280, 230, 180, 120, 60, 30, 0];

type Blob = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  nx: number;
  ny: number;
};

let blobs: Blob[] = [];
let beatVx: number[] = [];
let beatVy: number[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let buf: P5Graphics | null = null;
let bufW = 0;
let bufH = 0;

export function resetBlobs(): void {
  blobs = [];
  beatVx = [];
  beatVy = [];
  lastBeatIndex = -1;
  hueShift = 0;
  buf?.remove();
  buf = null;
  bufW = 0;
  bufH = 0;
}

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function drawBlobs(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const gW = Math.ceil(W / PIXEL_SCALE);
  const gH = Math.ceil(H / PIXEL_SCALE);

  // Init / resize buffer
  if (!buf || bufW !== gW || bufH !== gH) {
    buf?.remove();
    buf = p.createGraphics(gW, gH);
    buf.noSmooth();
    bufW = gW; bufH = gH;
  }

  // Init blobs
  if (blobs.length === 0) {
    for (let i = 0; i < BAND_COUNT; i++) {
      blobs.push({
        x: 0.15 + 0.7 * Math.random(),
        y: 0.15 + 0.7 * Math.random(),
        vx: 0,
        vy: 0,
        nx: Math.random() * 1000,
        ny: Math.random() * 1000,
      });
      beatVx.push(0);
      beatVy.push(0);
    }
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 18) % 360;
      for (let i = 0; i < BAND_COUNT; i++) {
        const dx = blobs[i].x - 0.5;
        const dy = blobs[i].y - 0.5;
        const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const str = 0.018 + amps[0] * 0.025;
        beatVx[i] = (dx / len) * str;
        beatVy[i] = (dy / len) * str;
      }
    }
  }

  const drift = config.blobsDrift * 0.8 + 0.1;
  // Map viscosity [0,1] → threshold [0.55, 0.12]: high viscosity = high threshold = blobs stay separate
  const threshold = 0.55 - config.blobsViscosity * 0.43;
  const glow = config.blobsGlow;

  // Update blob positions via Perlin noise + beat impulse
  const t = p.frameCount * 0.002 * drift;
  for (let i = 0; i < BAND_COUNT; i++) {
    const b = blobs[i];
    b.vx += (p.noise(b.nx + t, 0) * 2 - 1) * 0.0004 * drift * dt;
    b.vy += (p.noise(b.ny + t, 10) * 2 - 1) * 0.0004 * drift * dt;
    b.vx += beatVx[i] * dt;
    b.vy += beatVy[i] * dt;
    beatVx[i] *= Math.pow(0.88, dt);
    beatVy[i] *= Math.pow(0.88, dt);
    b.vx *= Math.pow(0.94, dt);
    b.vy *= Math.pow(0.94, dt);
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < 0.08) { b.x = 0.08; b.vx = Math.abs(b.vx) * 0.6; }
    if (b.x > 0.92) { b.x = 0.92; b.vx = -Math.abs(b.vx) * 0.6; }
    if (b.y < 0.08) { b.y = 0.08; b.vy = Math.abs(b.vy) * 0.6; }
    if (b.y > 0.92) { b.y = 0.92; b.vy = -Math.abs(b.vy) * 0.6; }
  }

  // Render metaball scalar field into pixel buffer
  buf.loadPixels();
  const px = buf.pixels;
  const glowMin = threshold * (1 - Math.min(glow * 0.75, 0.9));

  for (let gy = 0; gy < gH; gy++) {
    const fy = gy / gH;
    for (let gx = 0; gx < gW; gx++) {
      const fx = gx / gW;
      let field = 0;
      let dominantBand = 0;
      let dominantW = 0;

      for (let i = 0; i < BAND_COUNT; i++) {
        const dx = fx - blobs[i].x;
        const dy = fy - blobs[i].y;
        const r2 = dx * dx + dy * dy;
        const radius = 0.05 + amps[i] * 0.18;
        const w = (radius * radius) / (r2 + 0.0001);
        field += w;
        if (w > dominantW) { dominantW = w; dominantBand = i; }
      }

      const idx = (gy * gW + gx) * 4;
      const hue = (BAND_HUES[dominantBand] + hueShift) % 360;

      if (field >= threshold) {
        const excess = Math.min((field - threshold) / threshold, 1);
        const sat = 55 + amps[dominantBand] * 40;
        const bri = 48 + excess * 42;
        const [r, g, b] = hsbToRgb(hue, sat, Math.min(bri, 96));
        px[idx] = r; px[idx + 1] = g; px[idx + 2] = b; px[idx + 3] = 255;
      } else if (glow > 0.05 && field >= glowMin) {
        const t2 = (field - glowMin) / (threshold - glowMin);
        const [r, g, b] = hsbToRgb(hue, 75, t2 * 42);
        px[idx] = r; px[idx + 1] = g; px[idx + 2] = b; px[idx + 3] = 255;
      } else {
        px[idx] = 5; px[idx + 1] = 3; px[idx + 2] = 12; px[idx + 3] = 255;
      }
    }
  }

  buf.updatePixels();
  p.background(5, 3, 12);
  p.noSmooth();
  p.image(buf as unknown as P5Image, 0, 0, W, H);
  p.smooth();
}
