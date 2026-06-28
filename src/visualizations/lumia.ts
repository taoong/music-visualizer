/**
 * Lumia — Flowing translucent color forms with additive blending.
 *
 * Inspired by Thomas Wilfred's "Lumia" light art and his Clavilux
 * color organ (1920s-30s, Smithsonian American Art Museum,
 * https://americanart.si.edu/exhibitions/lumia). Wilfred coined the
 * term "Lumia" for what he called the eighth fine art — pure light,
 * shaped and set in motion, projected through reflectors and
 * stained-glass disks. Multiple large, soft luminous forms drift
 * across the canvas following Perlin noise paths. Forms are
 * translucent and blend additively where they overlap, creating
 * rich secondary colors. Each of 7 frequency bands drives one or
 * more forms. Amplitude controls form size and brightness; beats
 * trigger expansion pulses and hue palette shifts. Noise-deformed
 * shapes prevent mechanical uniformity.
 *
 * Sliders
 *   lumiaForms  — number of luminous forms (4–14)
 *   lumiaDrift  — movement speed / turbulence (0–1)
 *   lumiaGlow   — brightness / trail persistence (0–1)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const BASE_HUES: readonly number[] = [15, 40, 60, 170, 220, 275, 325];

interface LumiaForm {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phaseOffset: number;
  baseRadius: number;
}

let forms: LumiaForm[] = [];
let phase = 0;
let globalHueShift = 0;
let lastBeatIndex = -1;
let beatPulse = 0;
let trailBuffer: OffscreenCanvas | null = null;
let trailCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
let trailW = 0;
let trailH = 0;
let lastFormCount = 0;

function ensureTrailBuffer(w: number, h: number): void {
  const scale = isMobile ? 0.5 : 1;
  const tw = Math.floor(w * scale);
  const th = Math.floor(h * scale);
  if (trailBuffer && trailW === tw && trailH === th) return;
  trailW = tw;
  trailH = th;
  if (typeof OffscreenCanvas !== 'undefined') {
    trailBuffer = new OffscreenCanvas(tw, th);
  } else {
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    trailBuffer = c as unknown as OffscreenCanvas;
  }
  trailCtx = trailBuffer.getContext('2d') as CanvasRenderingContext2D;
  if (trailCtx) {
    (trailCtx as CanvasRenderingContext2D).fillStyle = '#000';
    (trailCtx as CanvasRenderingContext2D).fillRect(0, 0, tw, th);
  }
}

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
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hashNoise((xi + yi * 57) & 0xffff);
  const b = hashNoise((xi + 1 + yi * 57) & 0xffff);
  const c = hashNoise((xi + (yi + 1) * 57) & 0xffff);
  const d = hashNoise((xi + 1 + (yi + 1) * 57) & 0xffff);
  return a + u * (b - a) + v * (c - a) + u * v * (a - b - c + d);
}

function initForms(count: number, w: number, h: number): void {
  forms = [];
  for (let i = 0; i < count; i++) {
    forms.push({
      x: hashNoise(i * 137 + 1) * w,
      y: hashNoise(i * 137 + 2) * h,
      vx: 0,
      vy: 0,
      phaseOffset: i * 2.39996,
      baseRadius: 0.12 + hashNoise(i * 137 + 3) * 0.16,
    });
  }
  lastFormCount = count;
}

export function drawLumia(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;
  const minDim = Math.min(w, h);

  const formCount = Math.round(4 + config.lumiaForms * 10);
  const driftSpeed = 0.001 + config.lumiaDrift * 0.006;
  const glowIntensity = config.lumiaGlow;

  if (forms.length !== formCount || lastFormCount !== formCount) {
    initForms(formCount, w, h);
  }

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatPulse = 1.0;
      globalHueShift = (globalHueShift + 30) % 360;
    }
  }

  phase += driftSpeed * dt;
  beatPulse *= Math.pow(0.9, dt);
  if (beatPulse < 0.005) beatPulse = 0;

  if (state.isPlaying) {
    globalHueShift = (globalHueShift + 0.02 * dt) % 360;
  }

  ensureTrailBuffer(w, h);
  if (!trailCtx) return;

  const ctx = trailCtx as CanvasRenderingContext2D;
  const xScale = trailW / w;
  const yScale = trailH / h;

  ctx.globalCompositeOperation = 'source-over';
  const fadeAlpha = 0.015 + (1 - glowIntensity) * 0.06;
  ctx.fillStyle = `rgba(0, 0, 0, ${fadeAlpha})`;
  ctx.fillRect(0, 0, trailW, trailH);

  ctx.globalCompositeOperation = 'lighter';

  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    const bandIdx = i % BAND_COUNT;
    const amp = amps[bandIdx];
    const trans = transients[bandIdx];

    const nx = form.phaseOffset + phase * 3;
    const ny = form.phaseOffset * 1.7 + phase * 2;
    const dx = (noise2D(nx, ny) - 0.5) * 2;
    const dy = (noise2D(nx + 100, ny + 100) - 0.5) * 2;

    form.vx += dx * driftSpeed * 50 * dt;
    form.vy += dy * driftSpeed * 50 * dt;
    form.vx *= Math.pow(0.96, dt);
    form.vy *= Math.pow(0.96, dt);

    form.x += form.vx * dt;
    form.y += form.vy * dt;

    const margin = minDim * 0.35;
    if (form.x < -margin) form.x += w + margin * 2;
    if (form.x > w + margin) form.x -= w + margin * 2;
    if (form.y < -margin) form.y += h + margin * 2;
    if (form.y > h + margin) form.y -= h + margin * 2;

    const baseR = form.baseRadius * minDim;
    const ampBoost = 1 + amp * 1.8;
    const beatBoost = 1 + beatPulse * 0.5;
    const transBoost = trans > 1.2 ? 1 + (trans - 1) * 0.3 : 1;
    const radius = baseR * ampBoost * beatBoost * transBoost;

    const hue = (BASE_HUES[bandIdx] + globalHueShift) % 360;
    const sat = 55 + amp * 35;
    const lightness = 8 + amp * 32 + beatPulse * 15;
    const alpha = (0.05 + amp * 0.16 + beatPulse * 0.06) * (0.4 + glowIntensity * 0.6);

    const cx = form.x * xScale;
    const cy = form.y * yScale;
    const r = radius * Math.min(xScale, yScale);

    if (r < 2) continue;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const h0 = hue;
    const h1 = (hue + 25) % 360;
    const h2 = (hue + 50) % 360;
    grad.addColorStop(0, `hsla(${h0}, ${sat}%, ${Math.min(100, lightness + 20)}%, ${Math.min(1, alpha * 1.3)})`);
    grad.addColorStop(0.25, `hsla(${h0}, ${sat}%, ${Math.min(100, lightness + 10)}%, ${Math.min(1, alpha)})`);
    grad.addColorStop(0.5, `hsla(${h1}, ${sat * 0.85}%, ${lightness}%, ${Math.min(1, alpha * 0.65)})`);
    grad.addColorStop(0.75, `hsla(${h2}, ${sat * 0.6}%, ${lightness * 0.6}%, ${Math.min(1, alpha * 0.25)})`);
    grad.addColorStop(1, `hsla(${h2}, ${sat * 0.4}%, ${lightness * 0.3}%, 0)`);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    if (amp > 0.25 && glowIntensity > 0.3) {
      const r2 = r * 0.5;
      const hueInner = (hue + 70) % 360;
      const grad2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r2);
      grad2.addColorStop(0, `hsla(${hueInner}, ${sat}%, ${Math.min(100, lightness + 30)}%, ${Math.min(1, alpha * 0.7)})`);
      grad2.addColorStop(0.5, `hsla(${hueInner}, ${sat * 0.7}%, ${Math.min(100, lightness + 10)}%, ${Math.min(1, alpha * 0.3)})`);
      grad2.addColorStop(1, `hsla(${hueInner}, ${sat * 0.5}%, ${lightness * 0.5}%, 0)`);

      ctx.beginPath();
      ctx.arc(cx, cy, r2, 0, Math.PI * 2);
      ctx.fillStyle = grad2;
      ctx.fill();
    }
  }

  ctx.globalCompositeOperation = 'source-over';

  const pCtx: CanvasRenderingContext2D | null = (p as any).drawingContext || null;
  if (pCtx && trailBuffer) {
    pCtx.save();
    pCtx.globalCompositeOperation = 'source-over';
    pCtx.drawImage(trailBuffer as any, 0, 0, w, h);
    pCtx.restore();
  }
}

export function resetLumia(): void {
  forms = [];
  phase = 0;
  globalHueShift = 0;
  lastBeatIndex = -1;
  beatPulse = 0;
  trailBuffer = null;
  trailCtx = null;
  trailW = 0;
  trailH = 0;
  lastFormCount = 0;
}
