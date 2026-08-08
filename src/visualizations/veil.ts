/**
 * Veil — Luminous Thread Sculpture.
 *
 * Inspired by teamLab "Light Sculpture – Flow"
 * (teamLab Borderless, Azabudai Hills, Tokyo, 2024)
 * https://www.teamlab.art/w/lightsculpture-flow/
 *
 * Countless thin luminous filaments drift through the canvas, collectively
 * forming emergent sculptural shapes that exist only through their combined
 * behaviour — no individual thread carries the form; only the whole reveals
 * it. At silence threads wander freely like smoke in Perlin noise; at peak
 * amplitude they crystallise around 7 frequency-band vortex attractors,
 * orbiting in alternating directions to produce braided, ever-shifting
 * light sculptures. Vortex centres slowly orbit the canvas at individually
 * tuned rates so the emergent shape continuously transforms.
 *
 * Rendering: additive-blend segments to a ½-res (⅓ mobile) offscreen
 * trail canvas; trail is faded each frame with a semi-transparent overlay.
 *
 * Beat: global hue shift + temporary crystallisation surge.
 *
 * Sliders:
 *   Threads (veilThreads) — filament count (100 – 1200 desktop / 60 – 400 mobile)
 *   Order   (veilOrder)   — crystallisation vs. noise drift (0 = pure smoke, 1 = tight vortex)
 *   Trail   (veilTrail)   — trail persistence (0 = short, 1 = long)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_N = isMobile ? 60  : 100;
const MAX_N = isMobile ? 400 : 1200;

// Hue per band: violet → blue → teal → green → lime → orange → magenta
const BAND_HUES = [280, 220, 178, 128, 72, 28, 308] as const;

// Alternating rotation sign per vortex: CW / CCW
const VORTEX_SIGN = [1, -1, 1, -1, 1, -1, 1] as const;

// Vortex orbital drift rates (multipliers on global phase)
const ORBIT_RATE = [1.00, 0.94, 1.07, 0.89, 1.12, 0.96, 1.04] as const;

// Vortex orbital radii (fraction of min canvas dim)
const VORTEX_RADIUS = 0.29;

// ── Module state ───────────────────────────────────────────────────────────────

let n = 0;                   // current thread count
let threadX:    Float32Array; // current positions
let threadY:    Float32Array;
let prevX:      Float32Array; // positions from last frame
let prevY:      Float32Array;
let threadDirX: Float32Array; // current unit direction vectors
let threadDirY: Float32Array;
let threadBand: Uint8Array;   // fixed band assignment (0–6)

let vortexX: Float32Array;   // 7 vortex x positions (recomputed each frame)
let vortexY: Float32Array;

let phase    = 0;
let hueShift = 0;
let lastBeat = -1;
let beatFlash = 0;
let canvasW  = 0;
let canvasH  = 0;

// Offscreen trail buffer
let trail:    HTMLCanvasElement | null = null;
let trailCtx: CanvasRenderingContext2D | null = null;
let trailW   = 0;
let trailH   = 0;

// ── Perlin value noise ─────────────────────────────────────────────────────────

function hashNoise(n: number): number {
  let x = ((n >> 13) ^ n) & 0xffff;
  x = (x * (x * x * 60493 + 19990303) + 1376312589) & 0x7fffffff;
  return (x & 0xffff) / 0xffff;
}

function noise2D(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u  = xf * xf * (3 - 2 * xf);
  const v  = yf * yf * (3 - 2 * yf);
  const a  = hashNoise((xi     + yi * 57) & 0xffff);
  const b  = hashNoise((xi + 1 + yi * 57) & 0xffff);
  const c  = hashNoise((xi     + (yi + 1) * 57) & 0xffff);
  const d  = hashNoise((xi + 1 + (yi + 1) * 57) & 0xffff);
  return a + u * (b - a) + v * (c - a) + u * v * (a - b - c + d);
}

// ── Initialisation helpers ─────────────────────────────────────────────────────

function ensureTrail(w: number, h: number): void {
  const scale = isMobile ? 0.33 : 0.5;
  const tw    = Math.floor(w * scale);
  const th    = Math.floor(h * scale);
  if (trail && trailW === tw && trailH === th) return;
  trailW = tw; trailH = th;
  trail = document.createElement('canvas');
  trail.width  = tw;
  trail.height = th;
  trailCtx = trail.getContext('2d')!;
  trailCtx.fillStyle = '#000';
  trailCtx.fillRect(0, 0, tw, th);
}

function spawnThreads(count: number, w: number, h: number): void {
  n          = count;
  threadX    = new Float32Array(count);
  threadY    = new Float32Array(count);
  prevX      = new Float32Array(count);
  prevY      = new Float32Array(count);
  threadDirX = new Float32Array(count);
  threadDirY = new Float32Array(count);
  threadBand = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    // Scatter across canvas with slight centre bias
    const r = Math.sqrt(Math.random()) * Math.min(w, h) * 0.5;
    const a = Math.random() * Math.PI * 2;
    threadX[i] = w * 0.5 + Math.cos(a) * r;
    threadY[i] = h * 0.5 + Math.sin(a) * r;
    prevX[i]   = threadX[i];
    prevY[i]   = threadY[i];
    const da = Math.random() * Math.PI * 2;
    threadDirX[i] = Math.cos(da);
    threadDirY[i] = Math.sin(da);
    threadBand[i] = (i % BAND_COUNT) as unknown as number;
  }
}

// ── Main draw ──────────────────────────────────────────────────────────────────

export function drawVeil(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  // Reinitialise on canvas resize
  if (canvasW !== w || canvasH !== h) {
    canvasW = w; canvasH = h;
    vortexX = new Float32Array(BAND_COUNT);
    vortexY = new Float32Array(BAND_COUNT);
    const desiredN = Math.round(MIN_N + config.veilThreads * (MAX_N - MIN_N));
    spawnThreads(desiredN, w, h);
  }
  ensureTrail(w, h);
  if (!trailCtx || !trail) return;

  // Thread count can be adjusted live by slider
  const desiredN = Math.round(MIN_N + config.veilThreads * (MAX_N - MIN_N));
  if (desiredN !== n) spawnThreads(desiredN, w, h);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const adjusted = audioEngine.getPlaybackPosition() - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeat) {
      lastBeat  = beatIdx;
      beatFlash = 1.0;
      hueShift  = (hueShift + 25 + Math.floor(Math.random() * 20)) % 360;
    }
  }

  phase     += 0.004 * dt;
  beatFlash *= Math.pow(0.87, dt);

  // Overall amplitude
  let totalAmp = 0;
  for (let b = 0; b < BAND_COUNT; b++) totalAmp += amps[b];
  totalAmp = Math.min(1, totalAmp / BAND_COUNT);

  const orderBase       = config.veilOrder;
  const crystalStrength = Math.min(1, orderBase * 0.6 + totalAmp * 0.8 + beatFlash * 0.4);
  const noiseStrength   = Math.max(0, 1.2 - crystalStrength);
  const speed           = (1.8 + totalAmp * 3.5 + beatFlash * 2.5) * dt;

  // Fade rate from trail slider: lower veilTrail → faster fade
  const fadeAlpha = isMobile
    ? 0.12 + (1 - config.veilTrail) * 0.25
    : 0.06 + (1 - config.veilTrail) * 0.18;

  // Update vortex positions (slow orbit)
  const cx = w * 0.5;
  const cy = h * 0.5;
  const orbitR = Math.min(w, h) * VORTEX_RADIUS;
  for (let b = 0; b < BAND_COUNT; b++) {
    const angle = (b / BAND_COUNT) * Math.PI * 2 + phase * ORBIT_RATE[b] * 0.05;
    vortexX[b] = cx + Math.cos(angle) * orbitR;
    vortexY[b] = cy + Math.sin(angle) * orbitR;
  }

  const ctx   = trailCtx;
  const scale = trailW / w;

  // ── 1. Fade trail ────────────────────────────────────────────────────────────
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = fadeAlpha;
  ctx.fillStyle   = '#00000a';
  ctx.fillRect(0, 0, trailW, trailH);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = isMobile ? 0.8 : 1.0;

  // ── 2. Update threads & batch-draw by band ───────────────────────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    const bAmp = amps[b];
    const hue  = (BAND_HUES[b] + hueShift) % 360;
    const alpha = Math.min(1, 0.28 + bAmp * 0.55 + beatFlash * 0.15);
    ctx.strokeStyle = `hsla(${hue},92%,70%,${alpha.toFixed(2)})`;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      if (threadBand[i] !== b) continue;

      const ox = threadX[i];
      const oy = threadY[i];
      prevX[i] = ox;
      prevY[i] = oy;

      // Accumulate force from all 7 vortices
      let fx = 0;
      let fy = 0;

      for (let v = 0; v < BAND_COUNT; v++) {
        const va = amps[v];
        if (va < 0.015) continue;
        const dx   = vortexX[v] - ox;
        const dy   = vortexY[v] - oy;
        const dist = Math.sqrt(dx * dx + dy * dy) + 1;
        const ux   = dx / dist;
        const uy   = dy / dist;
        // Tangential (spin) + gentle inward pull
        const sign = VORTEX_SIGN[v];
        const tx   = -uy * sign;
        const ty   =  ux * sign;
        const falloff  = 1 / (1 + dist * 0.0025);
        const spinW    = va * (0.55 + orderBase * 0.35) * falloff;
        const pullW    = va * 0.12 * orderBase * falloff;
        fx += tx * spinW + ux * pullW;
        fy += ty * spinW + uy * pullW;
      }

      // Perlin noise drift (dominant when quiet)
      const ns = noiseStrength * 0.45;
      if (ns > 0.01) {
        const nx = noise2D(ox * 0.0035 + phase,       oy * 0.0035);
        const ny = noise2D(ox * 0.0035,               oy * 0.0035 + phase + 11.7);
        fx += (nx - 0.5) * 2 * ns;
        fy += (ny - 0.5) * 2 * ns;
      }

      // Blend with momentum for smooth steering
      const mom = 0.72;
      let dx2 = threadDirX[i] * mom + fx * (1 - mom);
      let dy2 = threadDirY[i] * mom + fy * (1 - mom);
      const len = Math.sqrt(dx2 * dx2 + dy2 * dy2) + 0.0001;
      dx2 /= len; dy2 /= len;
      threadDirX[i] = dx2;
      threadDirY[i] = dy2;

      let nx2 = ox + dx2 * speed;
      let ny2 = oy + dy2 * speed;

      // Toroidal wrap
      nx2 = ((nx2 % w) + w) % w;
      ny2 = ((ny2 % h) + h) % h;
      threadX[i] = nx2;
      threadY[i] = ny2;

      // Skip segments that cross the wrap boundary
      if (Math.abs(nx2 - ox) > w * 0.35 || Math.abs(ny2 - oy) > h * 0.35) continue;

      ctx.moveTo(ox * scale, oy * scale);
      ctx.lineTo(nx2 * scale, ny2 * scale);
    }

    ctx.stroke();
  }

  // ── 3. Draw vortex core glows (subtle) ──────────────────────────────────────
  ctx.globalCompositeOperation = 'lighter';
  for (let b = 0; b < BAND_COUNT; b++) {
    const a = amps[b];
    if (a < 0.05) continue;
    const hue = (BAND_HUES[b] + hueShift) % 360;
    const gx  = vortexX[b] * scale;
    const gy  = vortexY[b] * scale;
    const rad = (8 + a * 28 + beatFlash * 14) * scale;
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
    grad.addColorStop(0, `hsla(${hue},100%,90%,${(a * 0.5 + beatFlash * 0.3).toFixed(2)})`);
    grad.addColorStop(1, `hsla(${hue},100%,60%,0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx, gy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 4. Blit to main canvas ───────────────────────────────────────────────────
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  const pCtx = (p as unknown as { drawingContext?: CanvasRenderingContext2D }).drawingContext;
  if (pCtx) {
    p.background(0);
    pCtx.save();
    pCtx.drawImage(trail, 0, 0, w, h);
    pCtx.restore();
  } else {
    p.background(0);
  }
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export function resetVeil(): void {
  n      = 0;
  phase  = 0;
  hueShift  = 0;
  lastBeat  = -1;
  beatFlash = 0;
  canvasW   = 0;
  canvasH   = 0;
  trail     = null;
  trailCtx  = null;
  trailW    = 0;
  trailH    = 0;
}
