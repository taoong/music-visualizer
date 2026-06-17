/**
 * Nebula — Cosmic gas cloud visualization.
 *
 * Inspired by Refik Anadol's "Machine Memoirs: Space" (2020,
 * https://refikanadol.com/works/machine-memoirs-space/) where millions
 * of NASA satellite/telescope images are fed through ML algorithms to
 * produce swirling, luminous cosmic landscapes — data reimagined as
 * interstellar nebulae.
 *
 * 7 gas cloud sources (one per freq band) orbit a luminous core;
 * each cloud's brightness and radius pulse with its band's amplitude;
 * additive blending in the pixel buffer creates ethereal color mixing;
 * a twinkling star field drifts behind the gas; beat fires an expanding
 * light ring from the core and shifts the cosmic palette.
 *
 * Rendering: offscreen pixel buffer at ¼ res (⅙ mobile).
 *
 * Sliders
 *   Density — gas cloud opacity / thickness
 *   Drift   — cosmic wind speed / animation rate
 *   Stars   — star brightness and density
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PIXEL_SCALE = isMobile ? 6 : 4;
const STAR_COUNT = isMobile ? 120 : 300;

const BAND_HUES: readonly number[] = [270, 220, 190, 160, 50, 30, 320];

interface GasCloud {
  baseAngle: number;
  baseRadius: number;
  nx: number;
  ny: number;
}

interface Star {
  x: number;
  y: number;
  brightness: number;
  twinklePhase: number;
  twinkleSpeed: number;
  size: number;
}

let clouds: GasCloud[] = [];
let stars: Star[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let beatRing = 0;
let beatRingRadius = 0;
let buf: P5Graphics | null = null;
let bufW = 0;
let bufH = 0;
let time = 0;

export function resetNebula(): void {
  clouds = [];
  stars = [];
  lastBeatIndex = -1;
  hueShift = 0;
  beatRing = 0;
  beatRingRadius = 0;
  buf?.remove();
  buf = null;
  bufW = 0;
  bufH = 0;
  time = 0;
}

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s /= 100; b /= 100;
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => b * (1 - s * Math.max(0, Math.min(1, Math.min(k(n), 4 - k(n)))));
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

export function drawNebula(p: P5Instance, dt: number): void {
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
    bufW = gW; bufH = gH;
  }

  if (clouds.length === 0) {
    for (let i = 0; i < BAND_COUNT; i++) {
      clouds.push({
        baseAngle: (i / BAND_COUNT) * Math.PI * 2,
        baseRadius: 0.12 + (i / BAND_COUNT) * 0.22,
        nx: Math.random() * 1000,
        ny: Math.random() * 1000,
      });
    }
  }

  if (stars.length === 0) {
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        brightness: 0.3 + Math.random() * 0.7,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.5 + Math.random() * 2.0,
        size: Math.random() < 0.1 ? 2 : 1,
      });
    }
  }

  const density = config.nebulaDensity;
  const drift = config.nebulaDrift * 0.8 + 0.1;
  const starBrightness = config.nebulaStars;

  time += dt * 0.001 * drift;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      hueShift = (hueShift + 15) % 360;
      beatRing = 1.0;
      beatRingRadius = 0;
    }
  }

  // Update beat ring
  if (beatRing > 0) {
    beatRingRadius += dt * 0.03;
    beatRing *= Math.pow(0.92, dt);
    if (beatRing < 0.01) beatRing = 0;
  }

  // Overall energy
  let totalAmp = 0;
  for (let i = 0; i < BAND_COUNT; i++) totalAmp += amps[i];
  totalAmp /= BAND_COUNT;

  // Compute cloud positions (normalized 0-1)
  const cloudX: number[] = [];
  const cloudY: number[] = [];
  const cloudRadius: number[] = [];
  const cloudBright: number[] = [];

  for (let i = 0; i < BAND_COUNT; i++) {
    const c = clouds[i];
    const angle = c.baseAngle + Math.sin(time * 0.7 + c.nx) * 0.5;
    const radius = c.baseRadius + Math.sin(time * 0.4 + c.ny) * 0.06;
    const amp = amps[i];

    cloudX.push(0.5 + Math.cos(angle) * radius);
    cloudY.push(0.5 + Math.sin(angle) * radius);
    cloudRadius.push(0.08 + amp * 0.18 + totalAmp * 0.05);
    cloudBright.push(0.15 + amp * 0.85);
  }

  // Render pixel buffer
  buf.loadPixels();
  const px = buf.pixels;

  for (let gy = 0; gy < gH; gy++) {
    const fy = gy / gH;
    for (let gx = 0; gx < gW; gx++) {
      const fx = gx / gW;
      const idx = (gy * gW + gx) * 4;

      // Deep space background
      let rr = 3, gg = 2, bb = 8;

      // Core glow
      const cdx = fx - 0.5;
      const cdy = fy - 0.5;
      const cDist = Math.sqrt(cdx * cdx + cdy * cdy);
      const coreGlow = Math.exp(-cDist * cDist * 30) * (0.3 + totalAmp * 0.7) * density;
      rr += coreGlow * 200;
      gg += coreGlow * 180;
      bb += coreGlow * 220;

      // Gas clouds (additive blending)
      for (let i = 0; i < BAND_COUNT; i++) {
        const dx = fx - cloudX[i];
        const dy = fy - cloudY[i];
        const d2 = dx * dx + dy * dy;
        const r = cloudRadius[i];
        const falloff = Math.exp(-d2 / (r * r * 0.5));

        // Add wispy perturbation using cheap sin-based noise
        const wisp = 0.7 + 0.3 * Math.sin(fx * 23.7 + fy * 17.3 + time * 2 + i * 5.1)
          * Math.sin(fx * 11.1 - fy * 19.9 + time * 1.3 + i * 3.7);

        const intensity = falloff * cloudBright[i] * density * wisp;
        if (intensity < 0.005) continue;

        const hue = (BAND_HUES[i] + hueShift) % 360;
        const [cr, cg, cb] = hsbToRgb(hue, 60 + amps[i] * 30, 100);
        rr += cr * intensity * 0.7;
        gg += cg * intensity * 0.7;
        bb += cb * intensity * 0.7;
      }

      // Beat ring
      if (beatRing > 0.01) {
        const ringDist = Math.abs(cDist - beatRingRadius * 0.6);
        const ringWidth = 0.015 + beatRing * 0.02;
        const ringGlow = Math.exp(-ringDist * ringDist / (ringWidth * ringWidth)) * beatRing * 0.8;
        const ringHue = (200 + hueShift) % 360;
        const [rh, gh, bh] = hsbToRgb(ringHue, 40, 100);
        rr += rh * ringGlow;
        gg += gh * ringGlow;
        bb += bh * ringGlow;
      }

      px[idx] = Math.min(rr, 255) | 0;
      px[idx + 1] = Math.min(gg, 255) | 0;
      px[idx + 2] = Math.min(bb, 255) | 0;
      px[idx + 3] = 255;
    }
  }

  buf.updatePixels();
  p.background(3, 2, 8);
  p.noSmooth();
  p.image(buf as unknown as P5Image, 0, 0, W, H);
  p.smooth();

  // Draw stars on top
  if (starBrightness > 0.05) {
    p.noStroke();
    const frameTime = p.frameCount * 0.05;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const twinkle = 0.5 + 0.5 * Math.sin(frameTime * s.twinkleSpeed + s.twinklePhase);
      const bandIdx = i % BAND_COUNT;
      const audioBoost = 0.5 + amps[bandIdx] * 0.5;
      const alpha = s.brightness * twinkle * starBrightness * audioBoost * 255;
      if (alpha < 10) continue;

      const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
      const [sr, sg, sb] = hsbToRgb(hue, 15 + twinkle * 20, 100);
      p.fill(sr, sg, sb, Math.min(alpha, 255));

      const sx = s.x * W;
      const sy = s.y * H;
      const sz = s.size * (0.8 + twinkle * 0.4);

      if (s.size > 1) {
        // Larger stars get a cross-shaped glow
        p.fill(sr, sg, sb, Math.min(alpha * 0.3, 255));
        p.ellipse(sx, sy, sz * 4, sz * 1.5);
        p.ellipse(sx, sy, sz * 1.5, sz * 4);
        p.fill(sr, sg, sb, Math.min(alpha, 255));
      }
      p.ellipse(sx, sy, sz * 2, sz * 2);
    }
  }
}
