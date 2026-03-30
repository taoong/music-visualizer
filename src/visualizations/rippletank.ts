/**
 * Ripple Tank — Physics-inspired wave interference visualization.
 *
 * 7 frequency bands become 7 point-sources emitting circular waves.
 * Wave superposition creates interference patterns; beats trigger shockwaves.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT } from '../utils/constants';
import { isMobile } from '../utils/constants';

// ── Wave parameters per band ─────────────────────────────────────────────────
const WAVE_CONFIG = [
  { wavelength: 120, speed: 0.8 },  // Sub:        slow, long waves
  { wavelength: 90,  speed: 1.0 },  // Bass
  { wavelength: 70,  speed: 1.2 },  // Low-Mid
  { wavelength: 50,  speed: 1.5 },  // Mid
  { wavelength: 35,  speed: 1.8 },  // Upper-Mid
  { wavelength: 25,  speed: 2.2 },  // Presence
  { wavelength: 18,  speed: 2.8 },  // Brilliance: fast, short waves
];

// ── Color palette (navy trough → blue zero → cyan-white peak) ────────────────
// Precomputed as 512-entry RGB LUT mapping [-1,1] → color
const COLOR_LUT = new Uint8Array(512 * 3);

function buildColorLUT(): void {
  for (let i = 0; i < 512; i++) {
    const t = (i / 511) * 2 - 1; // -1 to 1
    let r: number, g: number, b: number;
    if (t < 0) {
      // Trough (dark navy) → zero (medium blue)
      const s = t + 1; // 0 to 1
      r = Math.round(5 + s * 15);
      g = Math.round(10 + s * 40);
      b = Math.round(40 + s * 100);
    } else {
      // Zero (medium blue) → peak (bright cyan-white)
      r = Math.round(20 + t * 235);
      g = Math.round(50 + t * 205);
      b = Math.round(140 + t * 115);
    }
    COLOR_LUT[i * 3] = r;
    COLOR_LUT[i * 3 + 1] = g;
    COLOR_LUT[i * 3 + 2] = b;
  }
}
buildColorLUT();

// ── Module state ─────────────────────────────────────────────────────────────
const PIXEL_SCALE = isMobile ? 6 : 4;

let initialized = false;
let time = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

interface Shockwave {
  cx: number;  // center x in reduced coords
  cy: number;  // center y in reduced coords
  radius: number;
  amplitude: number;
}
let shockwaves: Shockwave[] = [];

// Source positions (7 points in a circle, reduced-res coords)
let sourceX: Float64Array = new Float64Array(0);
let sourceY: Float64Array = new Float64Array(0);

// Precomputed distance tables: distances[source][pixelIndex]
let distances: Float32Array[] = [];

// Offscreen pixel buffer
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;
let renderWidth = 0;
let renderHeight = 0;

// ── Initialization ───────────────────────────────────────────────────────────

function computeSourcePositions(rw: number, rh: number, count: number): void {
  sourceX = new Float64Array(count);
  sourceY = new Float64Array(count);
  const cx = rw / 2;
  const cy = rh / 2;
  const radius = Math.min(rw, rh) * 0.32;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    sourceX[i] = cx + Math.cos(angle) * radius;
    sourceY[i] = cy + Math.sin(angle) * radius;
  }
}

function precomputeDistances(rw: number, rh: number, count: number): void {
  const total = rw * rh;
  distances = new Array(count);
  for (let s = 0; s < count; s++) {
    distances[s] = new Float32Array(total);
    const sx = sourceX[s];
    const sy = sourceY[s];
    for (let y = 0; y < rh; y++) {
      const dy = y - sy;
      const dy2 = dy * dy;
      const rowOff = y * rw;
      for (let x = 0; x < rw; x++) {
        const dx = x - sx;
        distances[s][rowOff + x] = Math.sqrt(dx * dx + dy2);
      }
    }
  }
}

function initOffscreen(canvasW: number, canvasH: number, bandCount: number): void {
  renderWidth = Math.max(1, Math.floor(canvasW / PIXEL_SCALE));
  renderHeight = Math.max(1, Math.floor(canvasH / PIXEL_SCALE));
  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = renderWidth;
  offscreenCanvas.height = renderHeight;
  offscreenCtx = offscreenCanvas.getContext('2d')!;

  computeSourcePositions(renderWidth, renderHeight, bandCount);
  precomputeDistances(renderWidth, renderHeight, bandCount);
  initialized = true;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawRippleTank(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;

  // Init / resize check
  const needW = Math.max(1, Math.floor(p.width / PIXEL_SCALE));
  const needH = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!initialized || needW !== renderWidth || needH !== renderHeight) {
    initOffscreen(p.width, p.height, bandCount);
  }

  // Audio data
  const { amps } = getBandAverages(bandCount);
  const scale = config.spikeScale;

  // Config-driven controls
  const beatFreq = Math.max(1, Math.round(config.rippletankBeatFreq)); // every Nth beat
  const waterSpeed = 0.2 + config.rippletankWaterSpeed * 7.0; // 0.2–7.2 multiplier

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      // Spawn shockwave only on every Nth beat
      if (currentBeatIndex % beatFreq === 0) {
        beatFlash = 1.0;
        shockwaves.push({
          cx: renderWidth / 2,
          cy: renderHeight / 2,
          radius: 0,
          amplitude: 0.6,
        });
      }
    }
  }

  // Advance time (scaled by water speed)
  time += dt * 0.05 * waterSpeed;

  // Update shockwaves
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const sw = shockwaves[i];
    sw.radius += dt * 4.0 * waterSpeed;
    sw.amplitude *= Math.pow(0.97, dt);
    if (sw.amplitude < 0.01) {
      shockwaves.splice(i, 1);
    }
  }

  // Decay beat flash
  beatFlash *= Math.pow(0.92, dt);

  // Precompute wave numbers and angular frequencies
  const waveK = new Float64Array(bandCount);
  const waveOmega = new Float64Array(bandCount);
  const waveAmp = new Float64Array(bandCount);
  const configCount = WAVE_CONFIG.length;
  for (let b = 0; b < bandCount; b++) {
    const cfg = WAVE_CONFIG[Math.min(b, configCount - 1)];
    waveK[b] = (2 * Math.PI) / cfg.wavelength;
    waveOmega[b] = cfg.speed * waveK[b];
    waveAmp[b] = Math.min(amps[b] * scale, 1.0);
  }

  // Pixel rendering
  const imageData = offscreenCtx!.createImageData(renderWidth, renderHeight);
  const pixels = imageData.data;
  const total = renderWidth * renderHeight;

  // Vignette precompute
  const cx = renderWidth / 2;
  const cy = renderHeight / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  for (let idx = 0; idx < total; idx++) {
    const px = idx % renderWidth;
    const py = (idx - px) / renderWidth;

    // Sum wave contributions from all sources
    let height = 0;
    for (let b = 0; b < bandCount; b++) {
      if (waveAmp[b] < 0.001) continue;
      const dist = distances[b][idx];
      height += waveAmp[b] * Math.sin(waveK[b] * dist - waveOmega[b] * time);
    }

    // Add shockwave contributions
    for (let s = 0; s < shockwaves.length; s++) {
      const sw = shockwaves[s];
      const sdx = px - sw.cx;
      const sdy = py - sw.cy;
      const sDist = Math.sqrt(sdx * sdx + sdy * sdy);
      const ringDist = Math.abs(sDist - sw.radius);
      if (ringDist < 8) {
        height += sw.amplitude * (1 - ringDist / 8) * Math.sin(sDist * 0.5);
      }
    }

    // Soft clamp
    const clamped = Math.tanh(height);

    // Map to color LUT index [0, 511]
    const lutIdx = Math.round((clamped + 1) * 255.5);
    const lutOff = lutIdx * 3;

    // Vignette
    const vdx = px - cx;
    const vdy = py - cy;
    const vDist = Math.sqrt(vdx * vdx + vdy * vdy) / maxDist;
    const vignette = 1 - vDist * vDist * 0.5;

    // Beat flash brightness boost
    const flashBoost = 1 + beatFlash * 0.4;

    const off = idx * 4;
    pixels[off] = Math.min(255, Math.round(COLOR_LUT[lutOff] * vignette * flashBoost));
    pixels[off + 1] = Math.min(255, Math.round(COLOR_LUT[lutOff + 1] * vignette * flashBoost));
    pixels[off + 2] = Math.min(255, Math.round(COLOR_LUT[lutOff + 2] * vignette * flashBoost));
    pixels[off + 3] = 255;
  }

  // Blit to offscreen, then scale to main canvas
  offscreenCtx!.putImageData(imageData, 0, 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvas = (p as any).drawingContext as CanvasRenderingContext2D;
  canvas.imageSmoothingEnabled = true;
  canvas.drawImage(offscreenCanvas!, 0, 0, p.width, p.height);

}

// ── Reset ────────────────────────────────────────────────────────────────────

export function resetRippleTank(): void {
  initialized = false;
  time = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
  shockwaves = [];
  sourceX = new Float64Array(0);
  sourceY = new Float64Array(0);
  distances = [];
  offscreenCanvas = null;
  offscreenCtx = null;
  renderWidth = 0;
  renderHeight = 0;
}
