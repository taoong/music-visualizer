/**
 * Gravity Wells — Cosmic particle system visualization.
 *
 * 7 frequency bands become gravitational attractors in a rotating ring.
 * Hundreds of particles orbit with fading trails and constellation lines.
 * Beats trigger explosive particle bursts from the loudest attractor.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { isMobile } from '../utils/constants';

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_PARTICLES = isMobile ? 150 : 300;
const MAX_BURST = isMobile ? 15 : 25;
const CONNECT_DIST = isMobile ? 60 : 80;
const MAX_LINES = isMobile ? 200 : 500;
const BAND_HUES = [270, 240, 200, 170, 320, 340, 30]; // violet, blue, cyan, teal, magenta, pink, gold
const PARTICLE_LIFE = 8; // seconds
const BURST_LIFE = 1.5; // seconds
const GRID_CELL = CONNECT_DIST; // spatial hash cell size

// ── Types ────────────────────────────────────────────────────────────────────
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 1.0 → 0.0
  hue: number;
  size: number;
  isBurst: boolean;
}

// ── Module state ─────────────────────────────────────────────────────────────
let particles: Particle[] = [];
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let lastBeatIndex = -1;
let beatFlashTimer = 0;
let globalRotation = 0;
let lastWidth = 0;
let lastHeight = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function getAttractorPositions(w: number, h: number, count: number): { x: number; y: number }[] {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.28;
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2 + globalRotation;
    positions.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  }
  return positions;
}

function spawnParticle(ax: number, ay: number, hue: number, isBurst: boolean, burstAngle?: number): Particle {
  if (isBurst) {
    const angle = burstAngle ?? Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 4;
    return {
      x: ax + (Math.random() - 0.5) * 10,
      y: ay + (Math.random() - 0.5) * 10,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      hue,
      size: 4 + Math.random() * 2,
      isBurst: true,
    };
  }
  // Ambient: spawn near attractor with tangential velocity
  const dist = 80 + Math.random() * 120;
  const angle = Math.random() * Math.PI * 2;
  const px = ax + Math.cos(angle) * dist;
  const py = ay + Math.sin(angle) * dist;
  // Tangential velocity (perpendicular to radial)
  const tangentAngle = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.5;
  const speed = 0.3 + Math.random() * 0.7;
  return {
    x: px,
    y: py,
    vx: Math.cos(tangentAngle) * speed,
    vy: Math.sin(tangentAngle) * speed,
    life: 1.0,
    hue,
    size: 2 + Math.random() * 2,
    isBurst: false,
  };
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawGravityWells(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;
  const w = p.width;
  const h = p.height;

  // Init / resize check
  if (!offscreenCanvas || w !== lastWidth || h !== lastHeight) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
    offscreenCtx = offscreenCanvas.getContext('2d')!;
    // Fill black on init
    offscreenCtx.fillStyle = '#000';
    offscreenCtx.fillRect(0, 0, w, h);
    lastWidth = w;
    lastHeight = h;
  }

  // Audio data
  const { amps, transients } = getBandAverages(bandCount);
  const scale = config.spikeScale;

  // Rotate attractor ring
  globalRotation += config.rotationSpeed * 0.002 * dt;
  const attractors = getAttractorPositions(w, h, bandCount);

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatFlashTimer = 1.0;
      // Find loudest attractor
      let maxAmp = 0;
      let maxIdx = 0;
      for (let i = 0; i < bandCount; i++) {
        if (amps[i] > maxAmp) {
          maxAmp = amps[i];
          maxIdx = i;
        }
      }
      // Burst particles from loudest
      const a = attractors[maxIdx];
      const hue = BAND_HUES[maxIdx % BAND_HUES.length];
      for (let i = 0; i < MAX_BURST; i++) {
        if (particles.length >= MAX_PARTICLES + MAX_BURST) break;
        const angle = (i / MAX_BURST) * Math.PI * 2 + Math.random() * 0.3;
        particles.push(spawnParticle(a.x, a.y, hue, true, angle));
      }
    }
  }

  // Ambient spawning
  if (particles.length < MAX_PARTICLES) {
    const spawnCount = Math.min(2, MAX_PARTICLES - particles.length);
    for (let s = 0; s < spawnCount; s++) {
      const idx = Math.floor(Math.random() * bandCount);
      const a = attractors[idx];
      particles.push(spawnParticle(a.x, a.y, BAND_HUES[idx % BAND_HUES.length], false));
    }
  }

  // Physics update
  const dtSec = (dt * 16.667) / 1000;
  for (let i = particles.length - 1; i >= 0; i--) {
    const part = particles[i];

    // Gravity from all attractors
    for (let b = 0; b < bandCount; b++) {
      const a = attractors[b];
      const dx = a.x - part.x;
      const dy = a.y - part.y;
      const distSq = dx * dx + dy * dy;
      const force = (amps[b] * scale * 800) / Math.max(distSq, 2500);
      const dist = Math.sqrt(Math.max(distSq, 2500));
      part.vx += (dx / dist) * force * dt;
      part.vy += (dy / dist) * force * dt;
    }

    // Damping
    const damping = Math.pow(0.997, dt);
    part.vx *= damping;
    part.vy *= damping;

    // Move
    part.x += part.vx * dt;
    part.y += part.vy * dt;

    // Wrap bounds
    if (part.x < -100) part.x += w + 200;
    else if (part.x > w + 100) part.x -= w + 200;
    if (part.y < -100) part.y += h + 200;
    else if (part.y > h + 100) part.y -= h + 200;

    // Life decay
    const maxLife = part.isBurst ? BURST_LIFE : PARTICLE_LIFE;
    part.life -= dtSec / maxLife;

    // Shrink burst particles
    if (part.isBurst) {
      part.size = (4 + 2) * Math.max(part.life, 0);
    }

    if (part.life <= 0) {
      particles.splice(i, 1);
    }
  }

  // Decay beat flash
  beatFlashTimer *= Math.pow(0.9, dt);
  if (beatFlashTimer < 0.01) beatFlashTimer = 0;

  // ── Render to offscreen canvas ──────────────────────────────────────────
  const ctx = offscreenCtx!;

  // Trail fade
  const fadeAlpha = 0.06 + beatFlashTimer * 0.08;
  ctx.globalAlpha = fadeAlpha;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1.0;

  // Spatial hash for constellation lines
  const gridW = Math.ceil(w / GRID_CELL) + 1;
  const gridH = Math.ceil(h / GRID_CELL) + 1;
  const grid: number[][] = new Array(gridW * gridH);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

  for (let i = 0; i < particles.length; i++) {
    const part = particles[i];
    const gx = Math.floor(part.x / GRID_CELL);
    const gy = Math.floor(part.y / GRID_CELL);
    if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
      grid[gy * gridW + gx].push(i);
    }
  }

  // Draw constellation lines
  let lineCount = 0;
  const connectDistSq = CONNECT_DIST * CONNECT_DIST;
  ctx.lineWidth = 0.5;
  for (let i = 0; i < particles.length && lineCount < MAX_LINES; i++) {
    const a = particles[i];
    const gx = Math.floor(a.x / GRID_CELL);
    const gy = Math.floor(a.y / GRID_CELL);

    // Check neighboring cells
    for (let ny = gy - 1; ny <= gy + 1 && lineCount < MAX_LINES; ny++) {
      for (let nx = gx - 1; nx <= gx + 1 && lineCount < MAX_LINES; nx++) {
        if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
        const cell = grid[ny * gridW + nx];
        for (let k = 0; k < cell.length && lineCount < MAX_LINES; k++) {
          const j = cell[k];
          if (j <= i) continue;
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dSq = dx * dx + dy * dy;
          if (dSq < connectDistSq) {
            const proximity = 1 - Math.sqrt(dSq) / CONNECT_DIST;
            const alpha = proximity * 0.3 * Math.min(a.life, b.life);
            ctx.strokeStyle = `rgba(150, 180, 255, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            lineCount++;
          }
        }
      }
    }
  }

  // Draw particles
  for (let i = 0; i < particles.length; i++) {
    const part = particles[i];
    const alpha = Math.min(part.life, 1.0) * (part.isBurst ? 0.9 : 0.7);
    const lightness = part.isBurst ? 70 : 55;
    const [r, g, b] = hslToRgb(part.hue, 80, lightness);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(part.x, part.y, Math.max(part.size * 0.5, 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw attractor glows
  for (let b = 0; b < bandCount; b++) {
    const a = attractors[b];
    const amp = Math.min(amps[b] * scale, 1.0);
    const hue = BAND_HUES[b % BAND_HUES.length];
    const [r, g, gb] = hslToRgb(hue, 90, 50 + amp * 20);
    const baseSize = 8 + amp * 20;
    const tPulse = (transients[b] > 1.2) ? 1.5 : 1.0;

    // Outer glow
    ctx.fillStyle = `rgba(${r}, ${g}, ${gb}, ${0.08 * amp})`;
    ctx.beginPath();
    ctx.arc(a.x, a.y, baseSize * 3 * tPulse, 0, Math.PI * 2);
    ctx.fill();

    // Mid glow
    ctx.fillStyle = `rgba(${r}, ${g}, ${gb}, ${0.15 * amp})`;
    ctx.beginPath();
    ctx.arc(a.x, a.y, baseSize * 1.8 * tPulse, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.fillStyle = `rgba(${r}, ${g}, ${gb}, ${0.4 + amp * 0.5})`;
    ctx.beginPath();
    ctx.arc(a.x, a.y, baseSize * 0.5 * tPulse, 0, Math.PI * 2);
    ctx.fill();
  }

  // Blit offscreen to main canvas
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvas = (p as any).drawingContext as CanvasRenderingContext2D;
  canvas.drawImage(offscreenCanvas!, 0, 0, w, h);
}

// ── Reset ────────────────────────────────────────────────────────────────────

export function resetGravityWells(): void {
  particles = [];
  offscreenCanvas = null;
  offscreenCtx = null;
  lastBeatIndex = -1;
  beatFlashTimer = 0;
  globalRotation = 0;
  lastWidth = 0;
  lastHeight = 0;
}
