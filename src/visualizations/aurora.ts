/**
 * Aurora — Flowing luminous curtains of light.
 *
 * Inspired by Refik Anadol's "Infinity Room" data sculpture at Dataland
 * (Los Angeles, 2026). Multiple layered ribbons of light sweep across
 * the canvas like aurora borealis or flowing data streams. Each of 7
 * layers corresponds to a frequency band, driving brightness, vertical
 * oscillation amplitude, and color. Perlin noise creates organic
 * undulation. Beats trigger a luminous surge ripple.
 *
 * Sliders
 *   auroraFlow    — Perlin noise speed/turbulence (0–1)
 *   auroraLayers  — number of curtain layers (3–12)
 *   auroraGlow    — bloom/halo intensity (0–1)
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const BAND_HUES: readonly number[] = [270, 220, 180, 160, 300, 330, 200];

let phase = 0;
let globalHueShift = 0;
let lastBeatIndex = -1;
let beatFlash = 0;
let trailBuffer: InstanceType<typeof OffscreenCanvas> | null = null;
let trailCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
let trailW = 0;
let trailH = 0;

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

function hashNoise(n: number): number {
  let x = ((n >> 13) ^ n) & 0xffff;
  x = (x * (x * x * 60493 + 19990303) + 1376312589) & 0x7fffffff;
  return (x & 0xffff) / 0xffff;
}

function fbm(x: number, y: number, octaves: number): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise2D(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2.0;
  }
  return val;
}

export function drawAurora(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  const flowSpeed = 0.002 + config.auroraFlow * 0.008;
  const layerCount = Math.round(3 + config.auroraLayers * 9);
  const glowIntensity = config.auroraGlow;

  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      beatFlash = 1.0;
      globalHueShift = (globalHueShift + 25) % 360;
    }
  }

  phase += flowSpeed * dt;
  beatFlash *= Math.pow(0.92, dt);
  if (beatFlash < 0.005) beatFlash = 0;

  if (state.isPlaying) {
    globalHueShift = (globalHueShift + 0.03 * dt) % 360;
  }

  ensureTrailBuffer(w, h);
  if (!trailCtx) return;

  const ctx = trailCtx as CanvasRenderingContext2D;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, trailW, trailH);

  ctx.globalCompositeOperation = 'lighter';

  const xScale = trailW / w;
  const yScale = trailH / h;

  const xStep = isMobile ? 4 : 2;

  for (let layer = 0; layer < layerCount; layer++) {
    const bandIdx = layer % BAND_COUNT;
    const amp = amps[bandIdx];
    const trans = transients[bandIdx];

    const layerFrac = layer / layerCount;
    const baseY = h * (0.15 + layerFrac * 0.7);
    const waveAmp = h * (0.03 + amp * 0.12);

    const hue = (BAND_HUES[bandIdx] + globalHueShift) % 360;
    const sat = 70 + amp * 30;
    const lightness = 15 + amp * 40 + beatFlash * 20 + (trans > 1.2 ? (trans - 1) * 15 : 0);
    const alpha = (0.15 + amp * 0.5 + beatFlash * 0.15) * (glowIntensity * 0.7 + 0.3);

    const phaseOffset = layer * 1.7;

    ctx.beginPath();
    let firstY = 0;
    for (let px = 0; px <= w; px += xStep) {
      const nx = px / w * 3.0 + phaseOffset;
      const ny = phase * 3.0 + layer * 0.5;
      const noiseVal = fbm(nx, ny, 3);
      const wave = Math.sin(px / w * Math.PI * (2 + bandIdx * 0.3) + phase * 2 + phaseOffset) * 0.5 + 0.5;
      const yOff = (noiseVal - 0.5) * waveAmp * 2 + wave * waveAmp * 0.5;
      const y = baseY + yOff;

      const sx = px * xScale;
      const sy = y * yScale;

      if (px === 0) {
        ctx.moveTo(sx, sy);
        firstY = sy;
      } else {
        ctx.lineTo(sx, sy);
      }
    }

    ctx.lineTo(trailW, trailH + 10);
    ctx.lineTo(0, trailH + 10);
    ctx.lineTo(0, firstY);
    ctx.closePath();

    const gradY1 = (baseY - waveAmp) * yScale;
    const gradY2 = Math.min(trailH, (baseY + waveAmp * 2) * yScale);
    const grad = ctx.createLinearGradient(0, gradY1, 0, gradY2);
    const hsla1 = `hsla(${hue}, ${sat}%, ${Math.min(100, lightness + 10)}%, ${Math.min(1, alpha * 0.8)})`;
    const hsla2 = `hsla(${hue}, ${sat}%, ${Math.min(100, lightness)}%, ${Math.min(1, alpha * 0.3)})`;
    const hsla3 = `hsla(${hue}, ${sat}%, ${lightness * 0.5}%, 0)`;
    grad.addColorStop(0, hsla1);
    grad.addColorStop(0.4, hsla2);
    grad.addColorStop(1, hsla3);
    ctx.fillStyle = grad;
    ctx.fill();

    if (glowIntensity > 0.2) {
      ctx.lineWidth = (1.5 + amp * 2) * xScale;
      ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${Math.min(100, lightness + 20)}%, ${Math.min(1, alpha * 0.6)})`;

      ctx.beginPath();
      for (let px = 0; px <= w; px += xStep) {
        const nx = px / w * 3.0 + phaseOffset;
        const ny = phase * 3.0 + layer * 0.5;
        const noiseVal = fbm(nx, ny, 3);
        const wave = Math.sin(px / w * Math.PI * (2 + bandIdx * 0.3) + phase * 2 + phaseOffset) * 0.5 + 0.5;
        const yOff = (noiseVal - 0.5) * waveAmp * 2 + wave * waveAmp * 0.5;
        const y = baseY + yOff;
        const sx = px * xScale;
        const sy = y * yScale;
        if (px === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
  }

  ctx.globalCompositeOperation = 'source-over';

  const canvas = (p as any).drawingContext?.canvas || (p as any).canvas;
  const pCtx: CanvasRenderingContext2D | null = (p as any).drawingContext || null;
  if (pCtx && trailBuffer) {
    pCtx.save();
    pCtx.globalCompositeOperation = 'source-over';
    pCtx.drawImage(trailBuffer as any, 0, 0, w, h);
    pCtx.restore();
  }
}

export function resetAurora(): void {
  phase = 0;
  globalHueShift = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  trailBuffer = null;
  trailCtx = null;
  trailW = 0;
  trailH = 0;
}
