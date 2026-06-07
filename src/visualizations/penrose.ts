/**
 * Penrose — audio-reactive aperiodic rhombus tiling.
 *
 * Inspired by the 2023 discovery of "the hat" and "the spectre" — the first
 * true aperiodic monotiles, found by David Smith, Craig Kaplan, Joseph Myers
 * and Chaim Goodman-Strauss after a half-century search mathematicians had
 * largely given up on. Their breakthrough sent a wave of renewed fascination
 * — across architecture, design and generative art — back to the discovery
 * that started the search: Roger Penrose's 1974 two-tile aperiodic rhombus
 * tilings, whose patterns radiate outward in dazzling, never-repeating order.
 * https://cs.uwaterloo.ca/~csk/hat/
 *
 * A "sun" of ten golden triangles recursively deflates — the classic
 * Robinson-triangle substitution behind Penrose's P3 rhombus tiling
 * (see Preshing, "Penrose Tiling Explained", 2011) — into a radiating
 * lattice of thin and thick rhombi. The whole tessellation rotates slowly
 * about the canvas centre like a living mandala. Seven concentric radial
 * zones map distance-from-centre to the seven frequency bands (sub-bass at
 * the core → brilliance at the rim); each tile's hue and brightness pulse
 * with its band's amplitude. Beats fire an outward "deflation wave" that
 * flashes tiles brighter as it sweeps past and nudges the palette forward.
 *
 * Sliders
 *   Density — recursion depth (3–7): low = a few bold radiating wedges,
 *             high = a fine lace-like lattice of thousands of tiny rhombi
 *   Spin    — rotation speed of the whole tessellation
 *   Glow    — brightness / ambient bloom intensity of tiles and beat flashes
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const PHI = (1 + Math.sqrt(5)) / 2;
const INV_PHI = 1 / PHI;
const TWO_PI = Math.PI * 2;

const MIN_DEPTH = 3;
const MAX_DEPTH = isMobile ? 6 : 7;

// Hue per radial zone: sub-bass (core) → brilliance (rim)
const BAND_HUES: readonly number[] = [262, 302, 344, 22, 52, 102, 188];

interface RawTriangle {
  type: 0 | 1; // 0 = acute "thin" golden triangle (red), 1 = obtuse "thick" (blue)
  ax: number; ay: number;
  bx: number; by: number;
  cx: number; cy: number;
}

// ── Module state ──────────────────────────────────────────────────────────
let tileType: Uint8Array = new Uint8Array(0);
let tileAX: Float32Array = new Float32Array(0);
let tileAY: Float32Array = new Float32Array(0);
let tileBX: Float32Array = new Float32Array(0);
let tileBY: Float32Array = new Float32Array(0);
let tileCX: Float32Array = new Float32Array(0);
let tileCY: Float32Array = new Float32Array(0);
let tileDist: Float32Array = new Float32Array(0);
let tileCount = 0;
let maxTileDist = 1;
let generatedDepth = -1;

let rotationAngle = 0;
let lastBeatIndex = -1;
let hueShift = 0;
let flashBrightness = 0;
let rippleRadius = 0;
let rippleStrength = 0;

function lerpPoint(ax: number, ay: number, bx: number, by: number, t: number): [number, number] {
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

// Robinson-triangle deflation: an acute "thin" golden triangle (36° apex)
// splits into one acute + one obtuse child; an obtuse "thick" golden triangle
// (108° apex) splits into two obtuse + one acute child. Recursing this rule
// is exactly the substitution system that generates Penrose's P3 tiling.
function deflate(triangles: RawTriangle[]): RawTriangle[] {
  const out: RawTriangle[] = [];
  for (const t of triangles) {
    const { type, ax, ay, bx, by, cx, cy } = t;
    if (type === 0) {
      const [px, py] = lerpPoint(ax, ay, bx, by, INV_PHI);
      out.push({ type: 0, ax: cx, ay: cy, bx: px, by: py, cx: bx, cy: by });
      out.push({ type: 1, ax: px, ay: py, bx: cx, by: cy, cx: ax, cy: ay });
    } else {
      const [qx, qy] = lerpPoint(bx, by, ax, ay, INV_PHI);
      const [rx, ry] = lerpPoint(bx, by, cx, cy, INV_PHI);
      out.push({ type: 1, ax: rx, ay: ry, bx: cx, by: cy, cx: ax, cy: ay });
      out.push({ type: 1, ax: qx, ay: qy, bx: rx, by: ry, cx: bx, cy: by });
      out.push({ type: 0, ax: rx, ay: ry, bx: qx, by: qy, cx: ax, cy: ay });
    }
  }
  return out;
}

// Seed patch: a "sun" of ten acute golden triangles fanning out from the
// origin — the canonical radially-symmetric starting point for a Penrose
// deflation, guaranteeing 10-fold symmetry at every recursion depth.
function seedSun(): RawTriangle[] {
  const triangles: RawTriangle[] = [];
  for (let i = 0; i < 10; i++) {
    const angleB = ((2 * i - 1) * Math.PI) / 10;
    const angleC = ((2 * i + 1) * Math.PI) / 10;
    let bx = Math.cos(angleB);
    let by = Math.sin(angleB);
    let cx = Math.cos(angleC);
    let cy = Math.sin(angleC);
    if (i % 2 === 0) {
      const tx = bx, ty = by;
      bx = cx; by = cy;
      cx = tx; cy = ty;
    }
    triangles.push({ type: 0, ax: 0, ay: 0, bx, by, cx, cy });
  }
  return triangles;
}

function regenerate(depth: number): void {
  let triangles = seedSun();
  for (let d = 0; d < depth; d++) triangles = deflate(triangles);

  const n = triangles.length;
  tileType = new Uint8Array(n);
  tileAX = new Float32Array(n);
  tileAY = new Float32Array(n);
  tileBX = new Float32Array(n);
  tileBY = new Float32Array(n);
  tileCX = new Float32Array(n);
  tileCY = new Float32Array(n);
  tileDist = new Float32Array(n);

  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    const t = triangles[i];
    tileType[i] = t.type;
    tileAX[i] = t.ax; tileAY[i] = t.ay;
    tileBX[i] = t.bx; tileBY[i] = t.by;
    tileCX[i] = t.cx; tileCY[i] = t.cy;
    const ccx = (t.ax + t.bx + t.cx) / 3;
    const ccy = (t.ay + t.by + t.cy) / 3;
    const dist = Math.sqrt(ccx * ccx + ccy * ccy);
    tileDist[i] = dist;
    if (dist > maxDist) maxDist = dist;
  }
  tileCount = n;
  maxTileDist = maxDist || 1;
  generatedDepth = depth;
}

export function resetPenrose(): void {
  generatedDepth = -1; // forces regeneration on next draw
  rotationAngle = 0;
  lastBeatIndex = -1;
  hueShift = 0;
  flashBrightness = 0;
  rippleRadius = 0;
  rippleStrength = 0;
}

export function drawPenrose(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Density slider [0,1] → recursion depth [MIN_DEPTH, MAX_DEPTH]
  const depth = Math.round(MIN_DEPTH + config.penroseDensity * (MAX_DEPTH - MIN_DEPTH));
  if (depth !== generatedDepth) regenerate(depth);

  const W = p.width;
  const H = p.height;
  const cx = W * 0.5;
  const cy = H * 0.5;
  const scale = Math.min(W, H) * 0.485;
  const glow = config.penroseGlow;

  // ── Beat: fire an outward deflation wave ────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      rippleRadius = 0;
      rippleStrength = 1.0;
      hueShift = (hueShift + 33) % 360;
      flashBrightness = 1.0;
    }
  }
  rippleRadius += 0.022 * dt;
  rippleStrength *= Math.pow(0.92, dt);
  if (rippleStrength < 0.004) rippleStrength = 0;
  flashBrightness *= Math.pow(0.88, dt);

  // ── Spin: the whole tessellation rotates like a slow living mandala ─────
  rotationAngle = (rotationAngle + (0.0015 + config.penroseSpin * 0.014) * dt) % TWO_PI;
  const cosA = Math.cos(rotationAngle);
  const sinA = Math.sin(rotationAngle);

  p.background(7, 7, 15);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 1);
  p.strokeWeight(1);

  const rippleW = 0.16;
  const briFactor = 0.45 + glow * 0.45;

  for (let i = 0; i < tileCount; i++) {
    const dist = tileDist[i];
    const norm = dist / maxTileDist;
    const bandIdx = Math.min(6, Math.floor(norm * 7));
    const amp = amps[bandIdx];

    let ripple = 0;
    if (rippleStrength > 0) {
      const gap = Math.abs(norm - rippleRadius);
      if (gap < rippleW) ripple = rippleStrength * (1 - gap / rippleW);
    }

    const totalAmp = Math.min(1, amp * 0.85 + ripple);
    const hue = (BAND_HUES[bandIdx] + hueShift) % 360;
    // Thin (acute) rhombus halves run a touch brighter than thick (obtuse)
    // halves, giving the classic two-tone Penrose contrast within each band.
    const typeShift = tileType[i] === 0 ? 11 : -9;
    const sat = Math.min(100, 50 + totalAmp * 40);
    const bri = Math.min(100, (15 + totalAmp * 58 + typeShift + flashBrightness * 24) * briFactor);

    p.fill(hue, sat, bri, 0.9);
    p.stroke((hue + 16) % 360, sat * 0.55, Math.min(100, bri * 1.3 + 6), 0.45 + glow * 0.18);

    const ax = tileAX[i], ay = tileAY[i];
    const bx = tileBX[i], by = tileBY[i];
    const tcx = tileCX[i], tcy = tileCY[i];

    const x1 = cx + (ax * cosA - ay * sinA) * scale;
    const y1 = cy + (ax * sinA + ay * cosA) * scale;
    const x2 = cx + (bx * cosA - by * sinA) * scale;
    const y2 = cy + (bx * sinA + by * cosA) * scale;
    const x3 = cx + (tcx * cosA - tcy * sinA) * scale;
    const y3 = cy + (tcx * sinA + tcy * cosA) * scale;

    p.triangle(x1, y1, x2, y2, x3, y3);
  }

  // Ambient bloom: a single soft radial wash, tinted by the current core hue
  // and composited additively, so the whole lattice seems lit from within.
  if (glow > 0.04) {
    let energy = 0;
    for (let i = 0; i < BAND_COUNT; i++) energy += amps[i];
    energy /= BAND_COUNT;

    (p as any).blendMode(p['ADD']);
    p.noStroke();
    const haloHue = (BAND_HUES[0] + hueShift) % 360;
    const haloR = scale * (1.1 + energy * 0.4 + flashBrightness * 0.15);
    p.fill(haloHue, 42, 30 * glow * (0.4 + energy * 0.6 + flashBrightness * 0.5), 0.05 + glow * 0.045);
    p.ellipse(cx, cy, haloR * 2, haloR * 2);
    (p as any).blendMode(p['BLEND']);
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
