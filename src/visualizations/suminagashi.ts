/**
 * Suminagashi — Japanese floating-ink water marbling.
 *
 * Suminagashi (墨流し, "ink floating") is an ancient Japanese art form
 * (Heian period, 794–1185 CE) in which drops of coloured ink are released
 * onto a water surface; each drop spreads into concentric rings that
 * overlap and intermingle into abstract, never-repeating compositions
 * captured on paper. Contemporary practitioners include Hiromi Katayama
 * and the artisans at Suminagashi Studio (https://suminagashi.com/).
 *
 * Seven luminous ink sources (one per frequency band) drift slowly across
 * a dark canvas via Perlin-noise navigation. Amplitude drives the rate at
 * which each source "drops" a new expanding ring. Rings spread outward
 * from their spawn origin and fade as they grow; where rings from different
 * sources cross, their colours blend additively — the same iridescent
 * interference that gives real ink-on-water its shimmering hue mix. Beats
 * fire a gentle radial breath from canvas centre, pushing sources outward
 * and jumping the hue palette.
 *
 * Sliders
 *   Rings  — ring spawn rate per band  (0 = slow drip, 1 = rapid cascade)
 *   Drift  — Perlin-noise navigation speed for ink sources
 *   Bloom  — glow halo width and trail persistence
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// HSL hue per band: violet → blue → teal → green → gold → orange → crimson
const BAND_HUES: readonly number[] = [280, 225, 175, 130, 55, 28, 355];

// Mobile guard: fewer simultaneous rings to keep framerate up
const MAX_RINGS_PER_SOURCE = isMobile ? 6 : 14;

// Ring expansion: fraction of short canvas dimension per second
const RING_EXPAND_RATE = 0.20;

type InkRing = {
  ox: number; // spawn origin x, normalised [0, 1]
  oy: number; // spawn origin y, normalised [0, 1]
  r: number;  // current radius in pixels
  maxR: number;
  hue: number;
};

type InkSource = {
  x: number; y: number;
  vx: number; vy: number;
  nx: number; ny: number; // Perlin-noise seed offsets
  rings: InkRing[];
  timer: number; // countdown until next ring drop (0 = spawn)
};

let sources: InkSource[] = [];
let lastBeatIndex = -1;
let hueShift = 0;
let trailBuf: OffscreenCanvas | HTMLCanvasElement | null = null;
let trailCtx: CanvasRenderingContext2D | null = null;
let trailW = 0;
let trailH = 0;

// ---- Minimal deterministic value noise (no external deps) ----
function vn(x: number, y: number): number {
  const xi = x | 0; const yi = y | 0;
  const xt = x - xi; const yt = y - yi;
  const u = xt * xt * (3 - 2 * xt);
  const v = yt * yt * (3 - 2 * yt);
  const h = (n: number) => {
    let t = ((n ^ (n >> 13)) * 0x45d9f3b) & 0x7fffffff;
    t = ((t ^ (t >> 17)) * 0x165667b1) & 0x7fffffff;
    return (t & 0xffff) / 0xffff;
  };
  const a = h(xi       + yi       * 57);
  const b = h(xi + 1   + yi       * 57);
  const c = h(xi       + (yi + 1) * 57);
  const d = h(xi + 1   + (yi + 1) * 57);
  return a + u * (b - a) + v * ((c - a) + u * (a - b - c + d));
}

function ensureTrail(w: number, h: number): void {
  if (trailBuf && trailW === w && trailH === h) return;
  trailW = w;
  trailH = h;
  if (typeof OffscreenCanvas !== 'undefined') {
    trailBuf = new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement;
  } else {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    trailBuf = c;
  }
  trailCtx = (trailBuf as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null;
  if (trailCtx) { trailCtx.fillStyle = '#000'; trailCtx.fillRect(0, 0, w, h); }
}

export function resetSuminagashi(): void {
  sources = [];
  lastBeatIndex = -1;
  hueShift = 0;
  // Clear trail to black so old rings don't linger across track changes
  if (trailCtx) { trailCtx.fillStyle = '#000'; trailCtx.fillRect(0, 0, trailW, trailH); }
}

export function drawSuminagashi(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const W = p.width;
  const H = p.height;
  const diag = Math.min(W, H);

  ensureTrail(W, H);
  if (!trailCtx) return;

  // ---- Initialise ink sources ----
  if (sources.length === 0) {
    for (let i = 0; i < BAND_COUNT; i++) {
      sources.push({
        x: 0.1 + Math.random() * 0.8,
        y: 0.1 + Math.random() * 0.8,
        vx: 0, vy: 0,
        nx: i * 173.7 + 100,
        ny: i * 291.3 + 200,
        rings: [],
        timer: Math.random(), // stagger initial drops
      });
    }
  }

  // ---- Beat detection ----
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeatIndex) {
      lastBeatIndex = idx;
      hueShift = (hueShift + 37) % 360;
      // Gentle radial breath from canvas centre
      for (const src of sources) {
        const dx = src.x - 0.5;
        const dy = src.y - 0.5;
        const len = Math.sqrt(dx * dx + dy * dy) + 0.001;
        src.vx += (dx / len) * 0.014;
        src.vy += (dy / len) * 0.014;
      }
    }
  }

  const driftSpeed  = 0.08 + config.suminagashiDrift * 0.55;
  const ringsPerSec = 0.35 + config.suminagashiRings * 3.2;
  const bloom       = config.suminagashiBloom;
  const glowW       = 2 + bloom * 14;

  // Phase advances with frameCount for Perlin navigation
  const phase = p.frameCount * 0.003;

  // ---- Update each ink source and spawn rings ----
  for (let i = 0; i < BAND_COUNT; i++) {
    const src = sources[i];

    // Perlin-noise drift (value noise as a simple substitute)
    const nx = vn(src.nx + phase * driftSpeed, 0.0);
    const ny = vn(src.ny + phase * driftSpeed, 50.0);
    src.vx += (nx * 2 - 1) * 0.00045 * driftSpeed * dt;
    src.vy += (ny * 2 - 1) * 0.00045 * driftSpeed * dt;
    src.vx *= Math.pow(0.91, dt);
    src.vy *= Math.pow(0.91, dt);
    src.x  += src.vx * dt;
    src.y  += src.vy * dt;

    // Bounce off canvas margins
    if (src.x < 0.05) { src.x = 0.05;  src.vx =  Math.abs(src.vx); }
    if (src.x > 0.95) { src.x = 0.95;  src.vx = -Math.abs(src.vx); }
    if (src.y < 0.05) { src.y = 0.05;  src.vy =  Math.abs(src.vy); }
    if (src.y > 0.95) { src.y = 0.95;  src.vy = -Math.abs(src.vy); }

    // Spawn: timer counts down proportionally to band amplitude
    src.timer -= amps[i] * ringsPerSec * dt / 60;
    if (src.timer <= 0 && src.rings.length < MAX_RINGS_PER_SOURCE) {
      src.rings.push({
        ox: src.x, oy: src.y,
        r:    2,
        maxR: diag * 1.35,
        hue:  (BAND_HUES[i] + hueShift) % 360,
      });
      src.timer = 1.0;
    }

    // Expand rings; cull when they cross maxR
    const pxPerDt = RING_EXPAND_RATE * diag * dt / 60;
    src.rings = src.rings.filter(ring => {
      ring.r += pxPerDt;
      return ring.r < ring.maxR;
    });
  }

  // ---- Draw into trail buffer ----
  const ctx = trailCtx;

  // Fade old content — bloom slider controls persistence
  const fadeAlpha = 0.025 + (1 - bloom) * 0.085;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(0, 0, 0, ${fadeAlpha})`;
  ctx.fillRect(0, 0, trailW, trailH);

  // Additive blending so overlapping rings produce luminous colour mixes
  ctx.globalCompositeOperation = 'lighter';

  for (let i = 0; i < BAND_COUNT; i++) {
    for (const ring of sources[i].rings) {
      const cx = ring.ox * W;
      const cy = ring.oy * H;
      const { r, hue, maxR } = ring;

      // Quadratic alpha fade: bright when small, gone at maxR
      const progress = r / maxR;
      const alpha = 0.88 * (1 - progress * progress);
      if (alpha < 0.008) continue;

      const sat = 80;
      const lum = 55;

      // Pass 1 — outer halo: wide, very translucent
      ctx.lineWidth = glowW;
      ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${lum}%, ${alpha * 0.12})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Pass 2 — mid ring: moderate width, half-bright
      ctx.lineWidth = Math.max(1, glowW * 0.38);
      ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${lum + 8}%, ${alpha * 0.42})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Pass 3 — bright core: thin, fully saturated
      ctx.lineWidth = Math.max(0.5, glowW * 0.11);
      ctx.strokeStyle = `hsla(${hue}, ${sat - 5}%, ${Math.min(88, lum + 22)}%, ${alpha * 0.82})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.globalCompositeOperation = 'source-over';

  // ---- Composite to main canvas ----
  // Dark water-surface background
  p.background(3, 2, 8);

  const pCtx = (p as unknown as { drawingContext: CanvasRenderingContext2D }).drawingContext;
  if (pCtx && trailBuf) {
    pCtx.save();
    pCtx.drawImage(trailBuf as unknown as HTMLCanvasElement, 0, 0, W, H);
    pCtx.restore();
  }
}
