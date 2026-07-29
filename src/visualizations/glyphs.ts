/**
 * Glyphs — Audio-reactive typographic glyph field.
 *
 * Inspired by Ksawery Kirklewski's "Symphony in Acid" (2022), created for
 * Max Cooper's album of the same name (https://maxcooper.net/symphony-in-acid).
 * In that piece, fragments of Wittgenstein's Tractatus Logico-Philosophicus
 * explode across the screen as individual typographic units — letters scatter,
 * scale, rotate, and reassemble in sync with the music. Here, Greek letters,
 * math symbols, numerals, and Latin capitals drift across the canvas as
 * autonomous audio-reactive particles.
 *
 * Each glyph is assigned to one of 7 frequency bands by its current horizontal
 * canvas position. Band amplitude drives glyph size, brightness, and rotation
 * speed. Perlin noise steers each glyph's drift. Beats scatter all glyphs
 * outward from the canvas centre and shuffle ~40 % of their characters.
 *
 * Sliders
 *   Density — glyph count (sparse ↔ packed)
 *   Scale   — base glyph size and amplitude sensitivity
 *   Drift   — Perlin-noise drift speed / motion chaos
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: violet → blue → teal → green → yellow → orange → red
const BAND_HUES: readonly number[] = [280, 240, 180, 120, 60, 30, 0];

// Character pool: Greek, math, numerals, Latin capitals, symbols
const GLYPH_POOL: readonly string[] = [
  // Greek lowercase
  'α','β','γ','δ','ε','ζ','η','θ','κ','λ','μ','ν','ξ','π','ρ','σ','τ','υ','φ','χ','ψ','ω',
  // Mathematical
  '∂','∑','∫','∞','√','∆','Ω','∏','≈','≠','±','×','÷',
  // Numerals
  '0','1','2','3','4','5','6','7','8','9',
  // ASCII symbols
  '#','$','%','@','!','?','*','+','=','<','>','~','^',':',';','|',
  // Latin capitals
  'A','B','C','D','E','F','G','H','I','J','K','L','M',
  'N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
];

type Glyph = {
  char: string;
  x: number;        // normalized [0, 1]
  y: number;
  vx: number;
  vy: number;
  rotation: number; // radians
  vr: number;       // angular velocity rad/frame
  baseSize: number; // px at scale=0
  nox: number;      // Perlin noise X seed
  noy: number;      // Perlin noise Y seed
};

let glyphs: Glyph[] = [];
let globalHueShift = 0;
let lastBeatIndex = -1;
let noiseT = 0;
let beatFlash = 0;
let prevCount = 0;

function pickChar(): string {
  return GLYPH_POOL[Math.floor(Math.random() * GLYPH_POOL.length)];
}

function makeGlyph(): Glyph {
  return {
    char: pickChar(),
    x: Math.random(),
    y: Math.random(),
    vx: 0,
    vy: 0,
    rotation: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.02,
    baseSize: 12 + Math.random() * 22,
    nox: Math.random() * 200,
    noy: Math.random() * 200,
  };
}

export function resetGlyphs(): void {
  glyphs = [];
  globalHueShift = 0;
  lastBeatIndex = -1;
  noiseT = 0;
  beatFlash = 0;
  prevCount = 0;
}

export function drawGlyphs(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const w = p.width;
  const h = p.height;

  // Target count from density slider
  const targetCount = isMobile
    ? Math.round(60 + config.glyphsDensity * 140)
    : Math.round(100 + config.glyphsDensity * 400);

  // Grow or shrink pool as needed
  if (prevCount !== targetCount) {
    while (glyphs.length < targetCount) glyphs.push(makeGlyph());
    if (glyphs.length > targetCount) glyphs.length = targetCount;
    prevCount = targetCount;
  }

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx !== lastBeatIndex && beatIdx >= 0) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
      globalHueShift = (globalHueShift + 47 + Math.random() * 30) % 360;
      // Scatter outward from centre + shuffle characters
      for (const g of glyphs) {
        const dx = g.x - 0.5;
        const dy = g.y - 0.5;
        const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const str = 0.012 + Math.random() * 0.022;
        g.vx += (dx / len) * str;
        g.vy += (dy / len) * str;
        g.vr += (Math.random() - 0.5) * 0.08;
        if (Math.random() < 0.4) g.char = pickChar();
      }
    }
  }
  beatFlash *= Math.pow(0.88, dt);

  // Advance noise time
  const driftSpeed = 0.0003 + config.glyphsDrift * 0.002;
  noiseT += driftSpeed * dt;

  // Dark background
  p.background(8, 6, 18);

  // Per-glyph rendering via canvas2D (for shadowBlur glow + fast translate/rotate)
  const ctx = p.drawingContext;
  const sizeScale = (0.6 + config.glyphsScale * 2.0) * (isMobile ? 0.7 : 1.0);
  const glowFactor = isMobile ? 0 : 0.4 + config.glyphsScale * 0.6;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const g of glyphs) {
    // Perlin noise drift — two independent axes
    const nx = (p.noise(g.nox, noiseT) - 0.5) * 2;
    const ny = (p.noise(g.noy + 50, noiseT) - 0.5) * 2;

    g.vx += nx * driftSpeed * 0.8;
    g.vy += ny * driftSpeed * 0.8;
    g.vx *= 0.96;
    g.vy *= 0.96;
    g.vr *= 0.98;

    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.rotation += g.vr * dt;

    // Wrap at edges
    if (g.x < -0.06) g.x += 1.12;
    else if (g.x > 1.06) g.x -= 1.12;
    if (g.y < -0.06) g.y += 1.12;
    else if (g.y > 1.06) g.y -= 1.12;

    // Band from current horizontal position
    const band = Math.min(BAND_COUNT - 1, Math.floor(g.x * BAND_COUNT));
    const amp = amps[band];

    // Skip nearly-silent glyphs for performance
    if (amp < 0.02 && beatFlash < 0.05) continue;

    const sz = Math.max(6, Math.round(g.baseSize * sizeScale * (0.35 + 0.65 * amp + beatFlash * 0.45)));
    const hue = (BAND_HUES[band] + globalHueShift) % 360;
    const light = Math.round(12 + 52 * amp + beatFlash * 18);
    const sat = Math.round(55 + 45 * amp);
    const alpha = Math.min(1, 0.12 + 0.88 * amp + beatFlash * 0.25);

    ctx.save();
    ctx.translate(g.x * w, g.y * h);
    ctx.rotate(g.rotation);
    ctx.font = `${sz}px monospace`;
    ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
    ctx.globalAlpha = alpha;
    if (glowFactor > 0) {
      ctx.shadowColor = `hsl(${hue}, 70%, 60%)`;
      ctx.shadowBlur = Math.round(sz * glowFactor);
    }
    ctx.fillText(g.char, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
