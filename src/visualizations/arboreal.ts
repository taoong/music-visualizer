/**
 * Arboreal — L-system botanical branching visualization.
 *
 * Recursive string-rewriting L-system (Axiom "F", Rule F→F[+F][-F]) generates
 * self-similar branching coral/tree geometry. Each recursion depth level maps
 * to a frequency band: sub-bass drives the thick trunk, brilliance animates the
 * finest tips. Bass-heavy music builds towering trunks; treble-rich passages
 * proliferate delicate canopy detail. The whole structure breathes and shimmers
 * in real-time, never repeating the same shape twice.
 *
 * Inspired by Prusinkiewicz & Lindenmayer "The Algorithmic Beauty of Plants"
 * (1990, http://algorithmicbotany.org/papers/abop/abop.pdf) — the founding
 * text of L-system plant simulation — and Robert Hodgin's "Growth v02"
 * generative series (fxhash, https://www.fxhash.xyz/generative/27022), which
 * reinterprets road-network growth as flowing Art-Nouveau botanical forms.
 *
 * Sliders:
 *   Depth  (arbDepth)  — L-system recursion depth 2–6; 2=sparse, 6=dense fractal coral
 *   Spread (arbSpread) — branching angle 12°–55°; low=columnar spire, high=spreading bush
 *   Glow   (arbGlow)   — neon bloom intensity and trail persistence
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── L-system generation ────────────────────────────────────────────────────────
// Rule: F → F[+F][-F]  (symmetric branching at every segment)
function generateLS(depth: number): string {
  let s = 'F';
  for (let i = 0; i < depth; i++) {
    let next = '';
    for (const c of s) {
      next += c === 'F' ? 'F[+F][-F]' : c;
    }
    s = next;
  }
  return s;
}

// ── Neon botanical palette: warm trunk (crimson) → cool tips (violet) ──────────
const BAND_HUES = [10, 38, 80, 155, 200, 245, 278] as const;

// ── Precomputed segment data ────────────────────────────────────────────────────
interface Seg { x1: number; y1: number; x2: number; y2: number; band: number }

function collectSegs(
  ls: string,
  amps: readonly number[],
  baseL: number,
  lengthRatio: number,
  spread: number,
  midMod: number,
): Seg[] {
  const segs: Seg[] = [];
  type Frame = { x: number; y: number; a: number; d: number };
  const stack: Frame[] = [];
  let x = 0, y = 0;
  let a = -Math.PI / 2; // pointing straight up
  let d = 0;            // stack depth (= frequency band index)

  for (const c of ls) {
    if (c === 'F') {
      const band = Math.min(d, BAND_COUNT - 1);
      // Scale length: full base length × ratio^depth × audio amplitude
      // Minimum ~6% so the tree skeleton remains visible even at silence
      const amp = Math.max(0.06, amps[band] as number);
      const len = baseL * Math.pow(lengthRatio, d) * amp;
      const nx = x + Math.cos(a) * len;
      const ny = y + Math.sin(a) * len;
      segs.push({ x1: x, y1: y, x2: nx, y2: ny, band });
      x = nx;
      y = ny;
    } else if (c === '+') {
      // Mid-band energy widens the spread slightly for a more organic feel
      a += spread * (1 + midMod * 0.28);
    } else if (c === '-') {
      a -= spread * (1 + midMod * 0.28);
    } else if (c === '[') {
      stack.push({ x, y, a, d });
      d++;
    } else if (c === ']') {
      const f = stack.pop();
      if (f) { x = f.x; y = f.y; a = f.a; d = f.d; }
    }
  }
  return segs;
}

// ── Module state ────────────────────────────────────────────────────────────────
let lsStr = '';
let curDepth = -1;
let pg: any = null;
let ch = 0;
let lastBeat = -1;
let hueShift = 0;
let beatFlash = 0; // decays after beat for a brightness burst

const LENGTH_RATIO = 0.66; // branch-length ratio per recursion level
const MAX_DEPTH = isMobile ? 5 : 6;

// ── Reset ────────────────────────────────────────────────────────────────────────
export function resetArboreal(): void {
  lsStr = '';
  curDepth = -1;
  if (pg) { pg.remove(); pg = null; }
  ch = 0;
  lastBeat = -1;
  hueShift = 0;
  beatFlash = 0;
}

// ── Draw ─────────────────────────────────────────────────────────────────────────
export function drawArboreal(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // ── Beat detection ──────────────────────────────────────────────────────────
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeat) {
      lastBeat = idx;
      onBeat = true;
    }
  }
  if (onBeat) {
    hueShift = (hueShift + 47) % 360;
    beatFlash = 1.0;
  }
  beatFlash *= Math.pow(0.80, dt);

  // ── Config ──────────────────────────────────────────────────────────────────
  const depth = Math.max(2, Math.min(MAX_DEPTH, Math.round(2 + config.arbDepth * (MAX_DEPTH - 2))));
  const spread = ((12 + config.arbSpread * 43) * Math.PI) / 180; // 12°–55° in radians
  const glowLevel = config.arbGlow;

  // Regenerate L-string only when depth changes (expensive string rewrite)
  if (depth !== curDepth) {
    lsStr = generateLS(depth);
    curDepth = depth;
  }

  // ── Offscreen buffer (trail persistence) ────────────────────────────────────
  if (!pg || pg.width !== p.width || pg.height !== p.height) {
    if (pg) pg.remove();
    pg = (p as any).createGraphics(p.width, p.height);
    pg.pixelDensity(1);
    pg.background(0);
    ch = p.height;
  }

  // ── Trail fade ──────────────────────────────────────────────────────────────
  (pg as any).colorMode(pg['HSB'], 360, 100, 100, 100);
  pg.blendMode(pg['BLEND']);
  // Higher glow → slower fade (longer trail); lower → crisp, fast-clearing
  const fadeAlpha = isMobile ? 14 : (4 + (1 - glowLevel) * 28);
  pg.noStroke();
  pg.fill(0, 0, 5, fadeAlpha);
  pg.rect(0, 0, pg.width, pg.height);

  // ── Branch length: sized so full-amplitude tree fills ~88% of canvas ────────
  // Geometric series sum: baseL * (1 - r^depth) / (1 - r) ≈ 0.88 * ch
  const geoSum = (1 - Math.pow(LENGTH_RATIO, depth)) / (1 - LENGTH_RATIO);
  const baseL = (ch * 0.88) / geoSum;

  // Mid-band modulation of branching angle
  const midMod = Math.max(0, (amps[3] + amps[4]) * 0.5);

  // ── Collect all segments (single parse of L-string) ─────────────────────────
  const segs = collectSegs(lsStr, amps, baseL, LENGTH_RATIO, spread, midMod);

  // ── Draw 3-pass neon glow onto buffer ────────────────────────────────────────
  pg.noFill();
  pg.blendMode(pg['ADD']);
  pg.push();
  pg.translate(pg.width * 0.5, pg.height); // root at bottom-center

  const scalePx = p.width / 900; // normalize stroke weight to reference canvas

  for (const { x1, y1, x2, y2, band } of segs) {
    const hue = (BAND_HUES[band] + hueShift) % 360;
    const amp = Math.max(0.08, amps[band] as number);
    const bright = 55 + amp * 42 + beatFlash * 38;
    const sat = 75 + amp * 22;
    const alpha = 45 + amp * 40 + beatFlash * 15;

    // Stroke weight: trunk (band 0) is thickest, tips (band 6) finest
    const baseWeight = scalePx * Math.max(0.4, 5.0 - band * 0.65);

    // Pass 1 — wide outer halo (adds atmospheric glow in ADD mode)
    pg.strokeWeight(baseWeight * (5.5 + glowLevel * 4));
    pg.stroke(hue, sat, bright, alpha * 0.05 * (0.5 + glowLevel * 0.8));
    pg.line(x1, y1, x2, y2);

    // Pass 2 — medium mid-glow
    pg.strokeWeight(baseWeight * 2.2);
    pg.stroke(hue, sat * 0.82, Math.min(100, bright * 1.1), alpha * 0.22);
    pg.line(x1, y1, x2, y2);

    // Pass 3 — bright core (slightly shifted hue for iridescence)
    pg.strokeWeight(Math.max(0.3, baseWeight * 0.7));
    pg.stroke((hue + 22) % 360, sat * 0.45, Math.min(100, bright * 1.25 + 10), alpha * 0.72);
    pg.line(x1, y1, x2, y2);
  }

  pg.pop();

  // Reset pg blend/color state before blitting
  pg.blendMode(pg['BLEND']);
  (pg as any).colorMode(pg['RGB'], 255, 255, 255, 255);

  // ── Composite buffer onto main canvas ───────────────────────────────────────
  p.background(0);
  p.blendMode(p['ADD']);
  p.image(pg, 0, 0);
  p.blendMode(p['BLEND']);
}
