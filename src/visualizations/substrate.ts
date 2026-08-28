/**
 * Substrate — Crystalline growth lines.
 *
 * Inspired by Jared Tarbell's "Substrate" (2003)
 * http://www.complexification.net/gallery/machines/substrate/
 * Lines grow from seeds and branch perpendicularly when they expire,
 * creating emergent city-block / mineral-crystal formations.
 * 7 freq bands drive growth activity in horizontal zones (sub-bass=left →
 * brilliance=right). Beat fires a radial burst of new crystal seeds from
 * canvas centre and shifts the hue palette. 3-pass neon glow; persistent
 * trail buffer with configurable fade.
 *
 * Sliders
 *   Density — branching rate and tip population (sparse ↔ dense crystal web)
 *   Speed   — growth velocity and line length
 *   Glow    — neon bloom brightness and trail persistence
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub=violet, bass=indigo, lowMid=teal, mid=green, upperMid=yellow, presence=orange, brilliance=magenta
const BAND_HUES: readonly number[] = [270, 220, 175, 120, 60, 25, 300];

const MAX_TIPS = isMobile ? 120 : 350;
const BASE_STEP = 2; // pixels per growth step (before speed scaling)

type Tip = {
  x: number;
  y: number;
  ax: number; // unit direction x
  ay: number; // unit direction y
  hue: number;
  band: number;
  life: number;
  maxLife: number;
};

let tips: Tip[] = [];
let lastBeatIndex = -1;
let globalHueShift = 0;
let beatFlash = 0;

let trailCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let trailCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
let trailW = 0;
let trailH = 0;
let initialized = false;

// Simple value noise for gentle direction drift
function valueNoise(x: number, y: number, t: number): number {
  const ix = Math.floor(x * 0.02 + t * 0.3);
  const iy = Math.floor(y * 0.02 + t * 0.17);
  const h = ((ix * 1619 + iy * 31337) ^ (ix * 31337 + iy * 1619)) & 0xffff;
  return (h / 0xffff - 0.5) * 2;
}

let noiseT = 0;

function ensureTrailBuffer(w: number, h: number): void {
  if (trailCanvas && trailW === w && trailH === h) return;
  trailW = w;
  trailH = h;
  if (typeof OffscreenCanvas !== 'undefined') {
    trailCanvas = new OffscreenCanvas(w, h);
  } else {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    trailCanvas = c;
  }
  trailCtx = trailCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  if (trailCtx) {
    trailCtx.fillStyle = '#000';
    trailCtx.fillRect(0, 0, w, h);
  }
}

function getBandForX(x: number, width: number): number {
  return Math.min(BAND_COUNT - 1, Math.floor((x / width) * BAND_COUNT));
}

function spawnTip(
  x: number,
  y: number,
  angle: number,
  hue: number,
  band: number,
  w: number,
  h: number,
  maxLife: number,
): void {
  if (tips.length >= MAX_TIPS) return;
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  tips.push({
    x, y,
    ax: Math.cos(angle),
    ay: Math.sin(angle),
    hue,
    band,
    life: 0,
    maxLife,
  });
}

export function resetSubstrate(): void {
  tips = [];
  lastBeatIndex = -1;
  globalHueShift = 0;
  beatFlash = 0;
  noiseT = 0;
  trailCanvas = null;
  trailCtx = null;
  trailW = 0;
  trailH = 0;
  initialized = false;
}

export function drawSubstrate(p: P5Instance, dt: number): void {
  const { config, state } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);
  const W = p.width;
  const H = p.height;

  const density = config.substrateDensity; // 0–1
  const speed = 0.6 + config.substrateSpeed * 2.4; // 0.6–3.0 px/step
  const glow = config.substrateGlow; // 0–1

  ensureTrailBuffer(W, H);
  const ctx = trailCtx!;
  const mainCtx = p.drawingContext as CanvasRenderingContext2D;

  // First-frame clear
  if (!initialized) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    mainCtx.fillStyle = '#000';
    mainCtx.fillRect(0, 0, W, H);
    initialized = true;
  }

  noiseT += dt * 0.01;

  // ── Beat detection ─────────────────────────────────────────────────────────
  let beatFired = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFired = true;
    }
  }
  if (beatFired) {
    globalHueShift = (globalHueShift + 43 + Math.random() * 30) % 360;
    beatFlash = 1.0;

    // Burst of seeds from canvas centre
    const cx = W / 2;
    const cy = H / 2;
    const numSeeds = Math.floor(6 + density * 14);
    for (let i = 0; i < numSeeds; i++) {
      const angle = (i / numSeeds) * Math.PI * 2 + Math.random() * 0.4;
      // Cardinal snap: round angle to nearest 90° but add small jitter
      const snapped = Math.round(angle / (Math.PI * 0.5)) * (Math.PI * 0.5) + (Math.random() - 0.5) * 0.25;
      const band = getBandForX(cx + Math.cos(snapped) * 80, W);
      const hue = (BAND_HUES[band] + globalHueShift) % 360;
      const life = 60 + density * 120 + Math.random() * 80;
      spawnTip(cx, cy, snapped, hue, band, W, H, life);
    }
  }

  beatFlash = Math.max(0, beatFlash - dt * 0.08);

  // ── Seed new tips from frequency-band activity ─────────────────────────────
  const maxActive = Math.floor(10 + density * (MAX_TIPS - 10));
  for (let b = 0; b < BAND_COUNT && tips.length < maxActive; b++) {
    const amp = amps[b];
    const trans = transients[b];
    const prob = (amp * amp * 0.4 + trans * 0.15) * density * dt * 0.6;
    if (Math.random() < prob) {
      const zoneW = W / BAND_COUNT;
      const x = b * zoneW + Math.random() * zoneW;
      const y = Math.random() * H;
      // Snap to nearest cardinal direction + small jitter
      const baseAngle = Math.round(Math.random() * 4) * (Math.PI * 0.5);
      const angle = baseAngle + (Math.random() - 0.5) * 0.2;
      const hue = (BAND_HUES[b] + globalHueShift) % 360;
      const life = 40 + density * 100 + amp * 80 + Math.random() * 60;
      spawnTip(x, y, angle, hue, b, W, H, life);
    }
  }

  // ── Fade trail buffer ──────────────────────────────────────────────────────
  // Higher glow = slower fade (trails persist longer)
  const fadeAlpha = (0.012 + (1 - glow) * 0.03) * dt;
  ctx.fillStyle = `rgba(0,0,0,${Math.min(0.25, fadeAlpha)})`;
  ctx.fillRect(0, 0, W, H);

  // ── Grow tips ──────────────────────────────────────────────────────────────
  const nextTips: Tip[] = [];
  const deadTips: Tip[] = [];
  const stepSize = BASE_STEP * speed;

  ctx.save();
  for (const tip of tips) {
    const amp = amps[tip.band];
    const stepsF = (0.5 + amp) * stepSize * dt;
    const steps = Math.max(1, Math.round(stepsF));

    let alive = true;
    for (let s = 0; s < steps; s++) {
      // Gentle Perlin jitter in direction
      const jitter = valueNoise(tip.x, tip.y, noiseT) * 0.04;
      const nx = tip.x + tip.ax * stepSize + (-tip.ay) * jitter;
      const ny = tip.y + tip.ay * stepSize + tip.ax * jitter;

      if (nx < 0 || nx >= W || ny < 0 || ny >= H) {
        alive = false;
        break;
      }

      const progress = tip.life / tip.maxLife;
      const brightness = 55 + amp * 45;
      const saturation = 60 + amp * 30;
      const alpha = (1 - progress * 0.6) * (0.5 + glow * 0.5);

      // Core line (bright)
      ctx.strokeStyle = `hsla(${tip.hue},${saturation}%,${brightness}%,${alpha})`;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      // Soft outer glow pass (wider, dimmer)
      const glowAlpha = alpha * 0.25 * glow;
      const glowWidth = 1 + glow * 3;
      ctx.strokeStyle = `hsla(${tip.hue},${saturation * 0.8}%,${brightness * 0.7}%,${glowAlpha})`;
      ctx.lineWidth = glowWidth;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      tip.x = nx;
      tip.y = ny;
      tip.life++;

      if (tip.life >= tip.maxLife) {
        alive = false;
        break;
      }
    }

    if (alive) {
      nextTips.push(tip);
    } else {
      deadTips.push(tip);
    }
  }
  ctx.restore();

  tips = nextTips;

  // ── Branch from dead tips ──────────────────────────────────────────────────
  const branchProb = 0.25 + density * 0.55;
  for (const tip of deadTips) {
    if (Math.random() > branchProb) continue;
    const numBranches = Math.random() < (density * 0.7) ? 2 : 1;
    for (let i = 0; i < numBranches; i++) {
      // Spawn perpendicular from a random point back along the tip's path
      const backSteps = Math.random() * tip.maxLife;
      const bx = tip.x - tip.ax * backSteps * BASE_STEP * speed * 0.1;
      const by = tip.y - tip.ay * backSteps * BASE_STEP * speed * 0.1;
      const perpAngle = Math.atan2(tip.ay, tip.ax) + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
      const finalAngle = perpAngle + (Math.random() - 0.5) * 0.15;

      const band = getBandForX(bx, W);
      const hue = (BAND_HUES[band] + globalHueShift) % 360;
      const life = 40 + density * 80 + Math.random() * 60;
      spawnTip(bx, by, finalAngle, hue, band, W, H, life);
    }
  }

  // ── Composite trail buffer onto main canvas ────────────────────────────────
  mainCtx.save();
  mainCtx.globalCompositeOperation = 'source-over';
  if (trailCanvas) mainCtx.drawImage(trailCanvas as CanvasImageSource, 0, 0);

  // Beat flash overlay
  if (beatFlash > 0.01) {
    mainCtx.fillStyle = `rgba(180,160,255,${beatFlash * 0.08})`;
    mainCtx.fillRect(0, 0, W, H);
  }

  // Bright tip markers with neon glow on main canvas
  const glowR = 1.5 + glow * 5;
  for (const tip of tips) {
    const amp = amps[tip.band];
    if (amp < 0.05) continue;
    const h = tip.hue;
    const brightness = 60 + amp * 40;

    // Outer glow
    const grad = mainCtx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, glowR * 2.5);
    grad.addColorStop(0, `hsla(${h},80%,${brightness}%,${0.7 * glow * amp})`);
    grad.addColorStop(1, `hsla(${h},60%,${brightness * 0.5}%,0)`);
    mainCtx.fillStyle = grad;
    mainCtx.beginPath();
    mainCtx.arc(tip.x, tip.y, glowR * 2.5, 0, Math.PI * 2);
    mainCtx.fill();

    // Core dot
    mainCtx.fillStyle = `hsla(${h},40%,100%,${0.8 * amp})`;
    mainCtx.beginPath();
    mainCtx.arc(tip.x, tip.y, glowR * 0.4, 0, Math.PI * 2);
    mainCtx.fill();
  }
  mainCtx.restore();
}
