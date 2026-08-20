/**
 * Frost — Audio-reactive ice-crystal dendritic growth.
 *
 * Inspired by Alexey Kljatov's macro snowflake photography
 * (https://chaoticmind75.blogspot.com/) and Tokujin Yoshioka's "VENUS –
 * Crystal Nature" installation (2022, Kyushu National Museum), in which
 * bismuth crystals were grown directly on a sculptural form, blurring the
 * boundary between nature and design. Here the same boundary dissolves in
 * sound: each of 7 frequency bands steers a ring of growing branch tips
 * outward from one or more nucleation points; the tips fork at crystallographic
 * angles (60° for 6-fold ice symmetry, or configurable), producing fractal
 * dendritic patterns that accumulate on a persistent trail buffer — exactly
 * the slow, meditative coating of frost on a cold windowpane.
 *
 * Sliders: Symmetry (fold count 3–12), Growth (branch density / speed),
 *          Glow (bloom intensity and trail persistence)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

type P5Instance = any;

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_TIPS     = isMobile ? 350 : 1000;
const MAX_GEN      = isMobile ? 3 : 5;
const BASE_STEP    = isMobile ? 7 : 11;   // px per step at dt=1
const MAX_CRYSTALS = isMobile ? 2 : 4;

// Per-band hue offsets from the global palette hue, giving each arm a
// subtly distinct ice colour: pale violet → blue → teal
const BAND_HUE_OFFSET = [0, 15, 30, -15, -30, 20, -20];

// ── State ─────────────────────────────────────────────────────────────────

interface Tip {
  x: number; y: number;
  angle: number;
  cx: number; cy: number;   // crystal center
  band: number;
  gen: number;
  traveled: number;
  maxTravel: number;
}

interface Crystal {
  cx: number; cy: number;
  tips: Tip[];
}

let crystals: Crystal[]   = [];
let trail: P5Instance      = null;
let prevW                  = 0;
let prevH                  = 0;
let lastBeatIndex          = -1;
let globalHue              = 200;
let lastSymmetry           = 6;
let tipCount               = 0;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTip(
  x: number, y: number, angle: number,
  cx: number, cy: number,
  band: number, gen: number, maxTravel: number
): Tip {
  return { x, y, angle, cx, cy, band, gen, traveled: 0, maxTravel };
}

function newCrystal(cx: number, cy: number, sym: number, maxR: number): Crystal {
  const tips: Tip[] = [];
  for (let i = 0; i < sym; i++) {
    const angle = (i / sym) * Math.PI * 2;
    tips.push(makeTip(cx, cy, angle, cx, cy, i % BAND_COUNT, 0, maxR));
  }
  return { cx, cy, tips };
}

/**
 * Draw a line segment from (x0,y0) to (x1,y1), mirrored `sym` times
 * around the crystal center, with 3-pass neon glow.
 */
function mirrorLine(
  g: P5Instance,
  x0: number, y0: number,
  x1: number, y1: number,
  cx: number, cy: number,
  sym: number,
  hue: number, gen: number, glow: number, amp: number
): void {
  const dx0 = x0 - cx, dy0 = y0 - cy;
  const dx1 = x1 - cx, dy1 = y1 - cy;

  // Visual weight thins with each generation (finest at MAX_GEN)
  const thick = Math.max(0.5, 2.6 - gen * 0.38);
  // Saturation drops toward white as generation increases (realistic frost)
  const sat   = Math.max(5, 35 - gen * 5);
  const bri   = Math.min(100, 80 + amp * 20);

  for (let k = 0; k < sym; k++) {
    const ang = (k / sym) * Math.PI * 2;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);

    const sx0 = cx + dx0 * cos - dy0 * sin;
    const sy0 = cy + dx0 * sin + dy0 * cos;
    const sx1 = cx + dx1 * cos - dy1 * sin;
    const sy1 = cy + dx1 * sin + dy1 * cos;

    // Pass 1 – outer glow halo
    if (glow > 0.15) {
      g.stroke(hue, 65, 75, Math.min(50, glow * 28));
      g.strokeWeight(thick * 5.5 * glow);
      g.line(sx0, sy0, sx1, sy1);
    }
    // Pass 2 – mid bloom
    g.stroke(hue, 40, bri, 55);
    g.strokeWeight(thick * 2.2);
    g.line(sx0, sy0, sx1, sy1);
    // Pass 3 – crisp ice-white core
    g.stroke(hue, sat, 98, 92);
    g.strokeWeight(thick);
    g.line(sx0, sy0, sx1, sy1);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function resetFrost(): void {
  crystals      = [];
  trail         = null;
  prevW         = 0;
  prevH         = 0;
  lastBeatIndex = -1;
  globalHue     = 200;
  lastSymmetry  = 6;
  tipCount      = 0;
}

export function drawFrost(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps }          = getBandAverages(BAND_COUNT);

  const sym    = Math.round(config.frostSymmetry);
  const growth = config.frostGrowth;
  const glow   = config.frostGlow;
  const w      = p.width;
  const h      = p.height;
  const maxR   = Math.min(w, h) * 0.46;

  // ── Init / resize trail buffer ─────────────────────────────────────────
  if (!trail || prevW !== w || prevH !== h || lastSymmetry !== sym) {
    trail = (p as any).createGraphics(w, h);
    trail.colorMode((trail as any).HSB, 360, 100, 100, 100);
    trail.background(220, 30, 4);  // very dark icy navy
    prevW = w; prevH = h; lastSymmetry = sym;
    crystals = [newCrystal(w / 2, h / 2, sym, maxR)];
    tipCount = sym;
  }

  // ── Beat detection ─────────────────────────────────────────────────────
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      onBeat        = true;
    }
  }

  if (onBeat) {
    globalHue = (globalHue + 38 + Math.random() * 35) % 360;

    if (crystals.length < MAX_CRYSTALS && tipCount < MAX_TIPS * 0.55 && Math.random() < 0.55) {
      // Nucleate a satellite crystal near the canvas centre
      const ang = Math.random() * Math.PI * 2;
      const r   = maxR * (0.18 + Math.random() * 0.28);
      const nc  = newCrystal(w / 2 + Math.cos(ang) * r, h / 2 + Math.sin(ang) * r, sym, maxR * 0.52);
      crystals.push(nc);
      tipCount += nc.tips.length;
    } else if (Math.random() < 0.22) {
      // Occasional full thaw-and-refreeze
      trail.background(220, 30, 4);
      crystals = [newCrystal(w / 2, h / 2, sym, maxR)];
      tipCount = sym;
    }
  }

  // ── Fade trail (slow persistence, faster at lower Glow) ────────────────
  const fadeAlpha = Math.min(0.025, 0.006 * dt * (2.2 - glow * 0.6));
  const rawCtx    = (trail as any).drawingContext as CanvasRenderingContext2D;
  rawCtx.globalCompositeOperation = 'source-over';
  rawCtx.fillStyle = `rgba(0,2,12,${fadeAlpha})`;
  rawCtx.fillRect(0, 0, w, h);

  // ── Grow tips ──────────────────────────────────────────────────────────
  trail.colorMode((trail as any).HSB, 360, 100, 100, 100);
  trail.noFill();

  // Branch angle: 60° for ≥6-fold (ice), 90° for 4-fold (square crystal), 72° for 5-fold
  const branchAngle = sym >= 6 ? Math.PI / 3 : sym === 5 ? Math.PI * 0.4 : Math.PI / 2;
  const step        = BASE_STEP * growth * dt * 0.14;
  const branchProb  = growth * 0.007 * dt;

  for (const crystal of crystals) {
    const nextTips: Tip[] = [];

    for (const tip of crystal.tips) {
      const amp = amps[tip.band] ?? 0;
      const s   = step * (0.25 + amp * 2.8);
      if (s < 0.4) { nextTips.push(tip); continue; }

      const nx    = tip.x + Math.cos(tip.angle) * s;
      const ny    = tip.y + Math.sin(tip.angle) * s;
      const newTr = tip.traveled + s;

      // Discard tip if it ran out of energy or hit the radius cap
      if (newTr >= tip.maxTravel || tipCount >= MAX_TIPS) continue;

      const hue = (globalHue + BAND_HUE_OFFSET[tip.band] + 360) % 360;
      mirrorLine(trail, tip.x, tip.y, nx, ny,
        crystal.cx, crystal.cy, sym, hue, tip.gen, glow, amp);

      nextTips.push({ ...tip, x: nx, y: ny, traveled: newTr });

      // Branching
      if (tip.gen < MAX_GEN && tipCount + 2 <= MAX_TIPS && Math.random() < branchProb * (0.4 + amp)) {
        for (const da of [-branchAngle, branchAngle]) {
          nextTips.push(makeTip(nx, ny, tip.angle + da,
            crystal.cx, crystal.cy,
            (tip.band + 1) % BAND_COUNT, tip.gen + 1, tip.maxTravel * 0.52));
          tipCount++;
        }
      }
    }

    crystal.tips = nextTips;
  }

  tipCount = crystals.reduce((s, c) => s + c.tips.length, 0);

  // Remove exhausted crystals
  crystals = crystals.filter(c => c.tips.length > 0);

  // Full restart when all crystals are done
  if (crystals.length === 0) {
    trail.background(220, 30, 4);
    globalHue = (globalHue + 55) % 360;
    crystals  = [newCrystal(w / 2, h / 2, sym, maxR)];
    tipCount  = sym;
  }

  // ── Composite to main canvas ───────────────────────────────────────────
  p.image(trail, 0, 0, w, h);
}
