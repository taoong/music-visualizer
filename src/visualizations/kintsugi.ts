/**
 * Kintsugi: audio-reactive Japanese ceramic repair art
 *
 * A network of fractal cracks spreads across a dark ceramic-like canvas;
 * 7 frequency bands breathe life into glowing gold veins that fill each crack —
 * sub-bass anchors the leftmost fissures in deep amber while brilliance drives
 * fine rightward capillaries to near-white; beat hits flash all veins to brilliant
 * gold before settling back; every 8 beats the crack pattern shatters and reforms.
 *
 * Inspired by Yee Sookyung's "Translated Vase" series (2006–present,
 * https://www.leegallery.co.kr/artists/yee-sookyung) and Bouke de Vries'
 * "War and Pieces" ceramic damage installation (2012,
 * https://www.boukedevries.com/) — celebrating beauty in imperfection.
 *
 * Sliders
 *   kintsugiCracks — crack network density (0 = sparse, 1 = dense)
 *   kintsugiGlow   — gold vein brightness (0 = dim bronze, 1 = blazing gold)
 *   kintsugiFlow   — how quickly gold flows in response to audio (0 = slow, 1 = instant)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Module state ──────────────────────────────────────────────────────────────
interface Crack {
  x1: number; y1: number;
  x2: number; y2: number;
  band: number;
  goldLevel: number;  // 0 = dark void, 1 = fully flooded with gold
}

let cracks: Crack[] = [];
let lastBeatIndex = -1;
let needsRegen = true;
let cvW = 0;
let cvH = 0;

// ── Crack network generation ──────────────────────────────────────────────────
function generateCracks(w: number, h: number, densitySlider: number): void {
  cracks = [];

  const numImpacts = isMobile
    ? 2 + Math.round(densitySlider * 5)
    : 4 + Math.round(densitySlider * 10);
  const maxCracks = isMobile ? 80 : 220;

  const queue: Array<{ x: number; y: number; angle: number; len: number; depth: number }> = [];

  for (let i = 0; i < numImpacts; i++) {
    const cx = w * (0.07 + Math.random() * 0.86);
    const cy = h * (0.07 + Math.random() * 0.86);
    const numRays = 3 + Math.floor(Math.random() * 4);

    for (let j = 0; j < numRays; j++) {
      const angle = (j / numRays) * Math.PI * 2 + (Math.random() - 0.5) * 0.9;
      const len = w * (0.07 + Math.random() * 0.2);
      queue.push({ x: cx, y: cy, angle, len, depth: 2 });
    }
  }

  while (queue.length > 0 && cracks.length < maxCracks) {
    const seg = queue.shift()!;
    const jitter = (Math.random() - 0.5) * 0.56;
    const a = seg.angle + jitter;
    const x2 = seg.x + Math.cos(a) * seg.len;
    const y2 = seg.y + Math.sin(a) * seg.len;

    if (x2 < -w * 0.12 || x2 > w * 1.12 || y2 < -h * 0.12 || y2 > h * 1.12) continue;

    const midX = (seg.x + x2) * 0.5;
    const band = Math.min(6, Math.floor((midX / w) * 7));
    cracks.push({ x1: seg.x, y1: seg.y, x2, y2, band, goldLevel: 0.04 + Math.random() * 0.14 });

    if (seg.depth > 0 && cracks.length < maxCracks) {
      // Continue crack forward
      if (Math.random() < 0.80) {
        queue.push({ x: x2, y: y2, angle: a, len: seg.len * 0.75, depth: seg.depth - 1 });
      }
      // Branch off at an angle
      if (Math.random() < 0.55) {
        const branchDir = Math.random() < 0.5 ? 1 : -1;
        const branchAngle = a + branchDir * (Math.PI * 0.2 + Math.random() * Math.PI * 0.45);
        const branchLen = seg.len * (0.35 + Math.random() * 0.4);
        queue.push({ x: x2, y: y2, angle: branchAngle, len: branchLen, depth: seg.depth - 1 });
      }
    }
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawKintsugi(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Regen crack network on first call, canvas resize, or after reset
  if (needsRegen || p.width !== cvW || p.height !== cvH) {
    cvW = p.width;
    cvH = p.height;
    generateCracks(cvW, cvH, config.kintsugiCracks);
    needsRegen = false;
  }

  // ── Beat detection ─────────────────────────────────────────────────────────
  let isBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      isBeat = true;
      // Every 8 beats: shatter and reform the crack pattern
      if (beatIdx % 8 === 0 && beatIdx > 0) {
        generateCracks(cvW, cvH, config.kintsugiCracks);
      }
    }
  }

  const avgAmp = amps.reduce((a, b) => a + b, 0) / BAND_COUNT;
  const flowRate = 0.5 + config.kintsugiFlow * 3.5;
  const glowStr = config.kintsugiGlow;

  // ── Update gold levels ─────────────────────────────────────────────────────
  for (const crack of cracks) {
    const bandAmp = amps[crack.band] ?? avgAmp;
    const target = 0.12 + bandAmp * 0.88;
    const diff = target - crack.goldLevel;
    // Attack faster than release for snappy feel
    const rate = diff > 0 ? flowRate * 0.05 : flowRate * 0.025;
    crack.goldLevel += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);

    // Beat: flash gold based on transient multiplier
    if (isBeat) {
      const tMult = transients[crack.band] ?? 1;
      crack.goldLevel = Math.min(1.0, crack.goldLevel + 0.42 + Math.max(0, tMult - 1) * 0.18);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  // Dark ceramic background — warm near-black
  (p as any).colorMode(p['RGB'], 255);
  p.background(16, 11, 13);

  p.noFill();
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  // === Pass 0: Hairline dark crack void (always visible) ====================
  p.stroke(30, 20, 16, 55);
  p.strokeWeight(1.2);
  for (const crack of cracks) {
    p.line(crack.x1, crack.y1, crack.x2, crack.y2);
  }

  // === Pass 1: Wide outer amber glow ========================================
  for (const crack of cracks) {
    const g = crack.goldLevel * glowStr;
    if (g < 0.05) continue;
    const bandAmp = amps[crack.band] ?? avgAmp;
    p.stroke(36, 65, 58 * g, 11 * g);
    p.strokeWeight(14 + bandAmp * 10);
    p.line(crack.x1, crack.y1, crack.x2, crack.y2);
  }

  // === Pass 2: Mid gold glow ================================================
  for (const crack of cracks) {
    const g = crack.goldLevel * glowStr;
    if (g < 0.05) continue;
    const bandAmp = amps[crack.band] ?? avgAmp;
    p.stroke(42, 74, 80 * g, 30 * g);
    p.strokeWeight(5 + bandAmp * 4);
    p.line(crack.x1, crack.y1, crack.x2, crack.y2);
  }

  // === Pass 3: Bright core (white-hot at peak) ==============================
  for (const crack of cracks) {
    const level = crack.goldLevel;
    if (level < 0.05) continue;
    const bandAmp = amps[crack.band] ?? avgAmp;
    // Hue drifts toward warm orange at high amplitude; saturation drops near white at peak
    const hue = 43 + bandAmp * 9;
    const sat = Math.max(15, 80 - level * 26 - bandAmp * 34);
    const bri = Math.min(100, 72 + level * 28 + bandAmp * 18);
    p.stroke(hue, sat * glowStr, bri * glowStr, 84 * level);
    p.strokeWeight(0.8 + level * 1.6);
    p.line(crack.x1, crack.y1, crack.x2, crack.y2);
  }

  // === Endpoint sparkles (luminous dots at crack tips) ======================
  p.noStroke();
  for (const crack of cracks) {
    const level = crack.goldLevel;
    if (level < 0.28) continue;
    const bandAmp = amps[crack.band] ?? avgAmp;
    const g = level * glowStr;
    p.fill(44, 52, 96 * g, 20 * level);
    const r = 3 + bandAmp * 7 + level * 3;
    p.ellipse(crack.x2, crack.y2, r, r);
  }

  // === Beat flash: warm gold wash ===========================================
  if (isBeat) {
    p.noStroke();
    p.fill(42, 48, 100, 6);
    p.rect(0, 0, cvW, cvH);
  }

  (p as any).colorMode(p['RGB'], 255);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
export function resetKintsugi(): void {
  needsRegen = true;
  lastBeatIndex = -1;
}
