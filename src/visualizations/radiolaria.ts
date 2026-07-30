/**
 * Radiolaria — Audio-reactive Haeckelian biological skeleton.
 *
 * Inspired by Ernst Haeckel, "Kunstformen der Natur" (1904), Plate 1 (Radiolaria):
 * https://en.wikipedia.org/wiki/Kunstformen_der_Natur
 * Single-celled marine protists build silica skeletons with perfect N-fold radial
 * symmetry: main spines branch hierarchically, and concentric lattice rings connect
 * adjacent nodes at each radial level — recreating Haeckel's intricate biological
 * geometry in luminous bioluminescent colour. A glowing core pulses with sub-bass;
 * higher-frequency bands illuminate outer branches; beats fire an outward spawning
 * flash; the whole form rotates slowly with audio energy. Violet→teal palette drifts.
 *
 * Desktop: up to 4 levels of branching (31 segments per arm).
 * Mobile:  capped at 2 levels for performance.
 *
 * Sliders: Arms (radial symmetry 4–12), Complexity (branch depth 1–4), Glow (neon intensity)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Module state ───────────────────────────────────────────────────────────────

let phase       = 0;      // global rotation angle (radians)
let beatFlash   = 0;      // beat-triggered brightness flash (1 → 0, exponential decay)
let beatScale   = 1.0;    // beat-triggered radial scale burst
let hueShift    = 0;      // cumulative palette offset (degrees)
let lastBeatIndex = -1;

export function resetRadiolaria(): void {
  phase         = 0;
  beatFlash     = 0;
  beatScale     = 1.0;
  hueShift      = 0;
  lastBeatIndex = -1;
}

// ── 3-pass neon glow line ──────────────────────────────────────────────────────

function neonLine(
  p: P5Instance,
  x1: number, y1: number,
  x2: number, y2: number,
  hue: number, sat: number, bri: number, alpha: number,
  glowStr: number,
  w: number,
): void {
  // Outer wide halo
  p.strokeWeight(w * 5.5 * glowStr);
  p.stroke(hue, sat, bri, alpha * 0.07 * glowStr);
  p.line(x1, y1, x2, y2);
  // Mid pass
  p.strokeWeight(w * 2.0);
  p.stroke(hue, Math.max(0, sat - 20), bri, alpha * 0.28);
  p.line(x1, y1, x2, y2);
  // Bright iridescent core
  p.strokeWeight(Math.max(0.4, w * 0.5));
  p.stroke((hue + 20) % 360, Math.max(0, sat - 45), 100, alpha * 0.88);
  p.line(x1, y1, x2, y2);
}

// ── Recursive branching spine ──────────────────────────────────────────────────
// depth=0 is the root segment emanating from the centre; maxDepth is the leaf level.

function drawSpine(
  p: P5Instance,
  fromX: number, fromY: number,
  angle: number,
  length: number,
  depth: number,
  maxDepth: number,
  hue: number,
  alpha: number,
  glowStr: number,
  branchAmt: number,  // 0–1: audio-driven branch extension
): void {
  if (length < 1.5) return;

  const toX = fromX + Math.cos(angle) * length;
  const toY = fromY + Math.sin(angle) * length;

  // Stroke weight tapers as depth increases
  const w = Math.max(0.5, 2.1 - depth * 0.42);
  neonLine(p, fromX, fromY, toX, toY, hue, 78, 88, alpha, glowStr, w);

  // Glowing node at segment tip
  const nr = Math.max(0.8, (3.2 - depth * 0.58) * glowStr);
  p.noStroke();
  p.fill(hue, 55, 100, alpha * 0.42 * glowStr);
  p.circle(toX, toY, nr * 4.5);
  p.fill((hue + 18) % 360, 28, 100, alpha * 0.75);
  p.circle(toX, toY, nr * 1.5);
  p.noFill();

  if (depth < maxDepth) {
    // Two sub-branches diverge at ± spread angle
    const spread  = Math.PI * 0.30 + branchAmt * Math.PI * 0.07;
    const nextLen = length * 0.50 * (0.78 + branchAmt * 0.42);
    const nextHue = (hue + 16) % 360;
    const nextA   = alpha * 0.70;

    drawSpine(p, toX, toY, angle + spread, nextLen, depth + 1, maxDepth, nextHue, nextA, glowStr, branchAmt);
    drawSpine(p, toX, toY, angle - spread, nextLen, depth + 1, maxDepth, nextHue, nextA, glowStr, branchAmt);
  }
}

// ── Main draw ──────────────────────────────────────────────────────────────────

export function drawRadiolaria(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const nArms    = Math.round(config.radiolariaArms);
  const maxDepth = Math.round(
    isMobile ? Math.min(2, config.radiolariaComplexity) : config.radiolariaComplexity,
  );
  const glowStr = config.radiolariaGlow;

  // ── Beat detection ─────────────────────────────────────────────────────────
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos  = audioEngine.getPlaybackPosition();
    const adj  = pos - state.beatOffset;
    const bidx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bidx >= 0 && bidx !== lastBeatIndex) {
      lastBeatIndex = bidx;
      onBeat        = true;
    }
  }

  if (onBeat) {
    beatFlash = 1.0;
    beatScale = 1.20;
    hueShift  = (hueShift + 44) % 360;
  }

  // Exponential decay of beat effects
  beatFlash = beatFlash  * Math.pow(0.81, dt);
  beatScale = 1.0 + (beatScale - 1.0) * Math.pow(0.87, dt);

  // Slow rotation, audio energy nudges speed
  const avgAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;
  phase += (0.0015 + avgAmp * 0.0022) * dt;

  // ── Clear ──────────────────────────────────────────────────────────────────
  p.background(0);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.blendMode(p['ADD']);
  p.noFill();

  const cx   = p.width  * 0.5;
  const cy   = p.height * 0.5;
  const half = Math.min(p.width, p.height) * 0.5;
  const maxR = half * 0.80 * beatScale;

  // ── Lattice rings — Haeckel's concentric silica cage ──────────────────────
  // Rings connect adjacent arm nodes at each radial fraction
  const nRings = 2 + maxDepth;
  for (let r = 0; r < nRings; r++) {
    const frac    = (r + 1) / (nRings + 1);
    const bandIdx = Math.round(frac * (BAND_COUNT - 1));
    const bAmp    = amps[bandIdx];
    const ringR   = maxR * frac * (0.72 + bAmp * 0.28);
    const ringHue = (215 + r * 20 + hueShift) % 360;
    const ringA   = 12 + bAmp * 30 + beatFlash * 18;

    for (let k = 0; k < nArms; k++) {
      const a1 = phase + (Math.PI * 2 * k)       / nArms;
      const a2 = phase + (Math.PI * 2 * (k + 1)) / nArms;
      const x1 = cx + Math.cos(a1) * ringR;
      const y1 = cy + Math.sin(a1) * ringR;
      const x2 = cx + Math.cos(a2) * ringR;
      const y2 = cy + Math.sin(a2) * ringR;
      neonLine(p, x1, y1, x2, y2, ringHue, 65, 78, ringA, glowStr * 0.52, 0.80);
    }
  }

  // ── Radial arms — the primary spicules ────────────────────────────────────
  for (let k = 0; k < nArms; k++) {
    const angle    = phase + (Math.PI * 2 * k) / nArms;
    const bandIdx  = k % BAND_COUNT;
    const bAmp     = amps[bandIdx];
    const tMult    = Math.min(2, transients[bandIdx]);
    const armLen   = maxR * (0.62 + bAmp * 0.40 + (tMult - 1) * 0.08);
    // Palette: violet (210°) → teal (280° wrap-around)
    const armHue   = (210 + (k / nArms) * 85 + hueShift) % 360;
    const armAlpha = 40 + bAmp * 45 + beatFlash * 22;

    drawSpine(
      p, cx, cy,
      angle, armLen,
      0, maxDepth,
      armHue, armAlpha, glowStr,
      bAmp,
    );
  }

  // ── Central luminous body ─────────────────────────────────────────────────
  const subBass = amps[0];
  const coreR   = (10 + subBass * 18 + beatFlash * 10) * (half / 400);
  const cHue    = (210 + hueShift) % 360;

  p.noStroke();
  // Deep outer aura
  p.fill(cHue, 90, 75, 9 * glowStr);
  p.circle(cx, cy, coreR * 8 * glowStr);
  // Inner glow
  p.fill(cHue, 65, 88, 20);
  p.circle(cx, cy, coreR * 3.2);
  // Bright core
  p.fill(cHue, 28, 100, 82);
  p.circle(cx, cy, coreR * 1.5);
  // Specular white centre
  p.fill(0, 0, 100, 68);
  p.circle(cx, cy, coreR * 0.55);

  // ── Beat radial flash ─────────────────────────────────────────────────────
  if (beatFlash > 0.04) {
    p.fill(cHue, 60, 100, beatFlash * 14);
    p.circle(cx, cy, half * 1.9);
  }

  // ── Restore defaults ──────────────────────────────────────────────────────
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
