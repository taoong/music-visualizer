/**
 * Apollonian — Indra's Net of recursively nested tangent circles.
 *
 * Inspired by Jos Leys' mathematical art galleries (josleys.com) and
 * the concept of Indra's Net from Avatamsaka Buddhism — an infinite
 * lattice of jewels each reflecting all others — visualised through
 * the Apollonian gasket fractal. Starting from three mutually-tangent
 * circles inside a bounding circle, Descartes' Circle Theorem (1643)
 * identifies the unique fourth circle tangent to any mutually-tangent
 * triple; applying this recursively fills every gap with ever-smaller
 * circles, producing a fractal whose Hausdorff dimension ≈ 1.3057.
 *
 * Frequency bands are mapped to circle generations (depth):
 * sub-bass drives the outermost triad, brilliance the finest inner spirals.
 * Amplitude breathes circle radii; beats pulse white and shift the hue palette.
 *
 * Sliders
 *   Depth   — recursion generations (2–7); higher = more circles
 *   Glow    — phosphor neon bloom intensity
 *   Palette — global hue rotation across the colour spectrum
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

interface AGCircle {
  x: number;
  y: number;
  k: number;     // curvature = 1/radius
  depth: number; // generation level (0 = seed triad)
}

// ---- Apollonian gasket construction (Descartes' theorem) ----
// Starting with an outer circle (k=-1, center origin) and three equal
// mutually-tangent inner circles whose curvature and center distance
// satisfy the Descartes quadruple condition.
const K_INNER = (3 + 2 * Math.sqrt(3)) / 3; // ≈ 2.155
const D_CTR   = 4 - 2 * Math.sqrt(3);        // ≈ 0.536

const OUTER: AGCircle = { k: -1, x: 0, y: 0, depth: -1 };

function makeSeed(): [AGCircle, AGCircle, AGCircle] {
  const s3h = Math.sqrt(3) / 2;
  return [
    { k: K_INNER, x: 0,             y: D_CTR,        depth: 0 },
    { k: K_INNER, x: -D_CTR * s3h,  y: -D_CTR * 0.5, depth: 0 },
    { k: K_INNER, x:  D_CTR * s3h,  y: -D_CTR * 0.5, depth: 0 },
  ];
}

// Given three mutually-tangent circles (ca, cb, cc) forming a gap, and
// the known fourth circle (ck) already tangent to all three, produce
// the OTHER Soddy circle filling the opposite side of that gap:
//   k_new = 2*(ka+kb+kc) - kk
//   z_new = (2*(ka*za + kb*zb + kc*zc) - kk*zk) / k_new
function fillGap(
  ca: AGCircle, cb: AGCircle, cc: AGCircle, ck: AGCircle,
  depth: number, maxDepth: number, out: AGCircle[],
): void {
  if (depth > maxDepth) return;

  const kn = 2 * (ca.k + cb.k + cc.k) - ck.k;
  if (kn <= 0) return;

  const rn = 1 / kn;
  // Minimum radius in normalised coords (outer circle r=1)
  const minR = isMobile ? 0.004 : 0.002;
  if (rn < minR) return;

  const xn = (2 * (ca.k * ca.x + cb.k * cb.x + cc.k * cc.x) - ck.k * ck.x) / kn;
  const yn = (2 * (ca.k * ca.y + cb.k * cb.y + cc.k * cc.y) - ck.k * ck.y) / kn;

  // Discard circles that stray outside the bounding circle (numerical drift)
  if (Math.sqrt(xn * xn + yn * yn) + rn > 1.04) return;

  const cn: AGCircle = { k: kn, x: xn, y: yn, depth };
  out.push(cn);

  // Recurse into the 3 new gaps created by the new circle
  fillGap(cn, ca, cb, cc, depth + 1, maxDepth, out);
  fillGap(cn, cb, cc, ca, depth + 1, maxDepth, out);
  fillGap(cn, cc, ca, cb, depth + 1, maxDepth, out);
}

function buildGasket(maxDepth: number): AGCircle[] {
  const [c1, c2, c3] = makeSeed();
  const result: AGCircle[] = [c1, c2, c3];

  // Fill the 4 gaps of the initial Descartes quadruple (OUTER, c1, c2, c3)
  fillGap(OUTER, c1, c2, c3, 1, maxDepth, result); // outer-left-right → bottom gap
  fillGap(OUTER, c2, c3, c1, 1, maxDepth, result); // outer-right-top → left gap
  fillGap(OUTER, c3, c1, c2, 1, maxDepth, result); // outer-top-left → right gap
  fillGap(c1,    c2, c3, OUTER, 1, maxDepth, result); // central gap

  return result;
}

// ---- Module state ----
let circles: AGCircle[] = [];
let builtDepth = -1;
let globalAngle = 0;
let lastBeatIndex = -1;
let hueShift = 0;
let flashBright = 0;

export function resetApollonian(): void {
  circles = [];
  builtDepth = -1;
  globalAngle = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  flashBright = 0;
}

// ---- Colour palette ----
// Hue per band (sub-bass → brilliance): violet → blue → cyan → green → lime → orange → magenta
const BAND_HUES = [270, 220, 180, 130, 75, 30, 310];

export function drawApollonian(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const minDim = Math.min(W, H);

  const { amps: bands } = getBandAverages(BAND_COUNT);
  const totalAmp = bands.reduce((s, v) => s + v, 0) / BAND_COUNT;

  const cfg = store.config;
  const rawDepth  = cfg.apollonianDepth  ?? 6;
  const glowAmt   = cfg.apollonianGlow   ?? 0.6;
  const paletteOff = cfg.apollonianPalette ?? 0.0;

  const maxDepth = isMobile
    ? Math.min(Math.round(rawDepth), 5)
    : Math.round(rawDepth);

  // Rebuild gasket only when depth slider changes
  if (maxDepth !== builtDepth) {
    circles = buildGasket(maxDepth);
    builtDepth = maxDepth;
  }

  // Beat detection
  const { beatIntervalSec, beatOffset } = store.state;
  if (beatIntervalSec > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const beatIdx = Math.floor((pos - beatOffset) / beatIntervalSec);
    if (beatIdx !== lastBeatIndex && lastBeatIndex >= 0) {
      hueShift    = (hueShift + 53) % 360;
      flashBright = 1.0;
    }
    lastBeatIndex = beatIdx;
  }
  flashBright *= Math.pow(0.84, dt);

  // Slow global rotation driven by overall amplitude
  globalAngle += dt * 0.0025 * (0.25 + totalAmp * 0.75);

  // Background — deep space navy
  p.background(5, 7, 16);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  const outerR = minDim * 0.46; // outer gasket radius in pixels
  const paletteHueDeg = paletteOff * 360;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(globalAngle);

  // Outer bounding circle (faint rim)
  ctx.beginPath();
  ctx.arc(0, 0, outerR, 0, TWO_PI);
  ctx.strokeStyle = `rgba(80,110,180,${0.08 + totalAmp * 0.08})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Render all circles, front-sorted by depth (already ordered by construction)
  for (const c of circles) {
    const bandIdx = Math.min(c.depth, BAND_COUNT - 1);
    const amp = bands[bandIdx];

    const pxR = outerR / c.k; // pixel radius
    if (pxR < 0.6) continue;

    // Breathe: radius swells with band amplitude
    const br = pxR * (1 + amp * 0.13);
    const px = c.x * outerR;
    const py = c.y * outerR;

    const baseHue = (BAND_HUES[bandIdx] + hueShift + paletteHueDeg) % 360;
    const sat     = 60 + amp * 40;
    const coreLit = 40 + amp * 45 + flashBright * 18;
    const coreAlpha = 0.30 + amp * 0.50 + flashBright * 0.12;

    // Outer glow pass (wide, dim)
    if (glowAmt > 0.05 && pxR > 1.5) {
      const g1R = br * (1.5 + glowAmt * 0.8);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(br, g1R), 0, TWO_PI);
      ctx.strokeStyle = `hsla(${baseHue},${sat}%,68%,${glowAmt * coreAlpha * 0.10})`;
      ctx.lineWidth   = Math.max(0.4, pxR * 0.25);
      ctx.stroke();
    }

    // Mid glow pass
    if (glowAmt > 0.05 && pxR > 0.8) {
      const g2R = br * (1.15 + glowAmt * 0.3);
      ctx.beginPath();
      ctx.arc(px, py, g2R, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${baseHue},${sat}%,78%,${glowAmt * coreAlpha * 0.22})`;
      ctx.lineWidth   = Math.max(0.3, pxR * 0.12);
      ctx.stroke();
    }

    // Core circle stroke
    ctx.beginPath();
    ctx.arc(px, py, br, 0, TWO_PI);
    ctx.strokeStyle = `hsla(${baseHue},${sat}%,${Math.min(coreLit + 18, 94)}%,${coreAlpha})`;
    ctx.lineWidth   = Math.max(0.4, pxR * 0.045 + 0.4);
    ctx.stroke();

    // Interior fill for larger circles (depth 0-2)
    if (pxR > 10) {
      const fillA = amp * 0.13 + flashBright * 0.04;
      if (fillA > 0.006) {
        ctx.beginPath();
        ctx.arc(px, py, br * 0.88, 0, TWO_PI);
        ctx.fillStyle = `hsla(${baseHue},${sat}%,${coreLit}%,${fillA})`;
        ctx.fill();
      }
    }
  }

  // Beat flash overlay
  if (flashBright > 0.015) {
    ctx.fillStyle = `rgba(255,255,255,${(flashBright * 0.065).toFixed(3)})`;
    ctx.fillRect(-W / 2, -H / 2, W, H);
  }

  ctx.restore();
}
