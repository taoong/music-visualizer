/**
 * Waterfall — 3D scrolling spectrogram.
 *
 * A ring buffer of recent spectrum snapshots is rendered as stacked ribbons
 * in oblique projection: the newest snapshot sits in front at full size,
 * older ones recede up-and-back with depth scaling. Amplitude becomes the
 * ribbon's height; a plasma palette colors each bin across the x axis.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandData } from './helpers';
import { BAND_COUNT, SPIKES_PER_BAND, isMobile } from '../utils/constants';

// ── Snapshot ring buffer ────────────────────────────────────────────────────
const MAX_SNAPSHOTS = isMobile ? 32 : 56;
let snapshots: Float32Array[] = [];
let snapshotHead = 0;   // index of oldest entry
let snapshotCount = 0;
let captureAccum = 0;

let lastBeatIndex = -1;
let beatFlash = 0;

// ── Color LUT (256 × RGB) ────────────────────────────────────────────────────
const COLOR_LUT = new Uint8Array(256 * 3);
let currentHueShift = -1;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [
    Math.max(0, Math.min(255, Math.round((r + m) * 255))),
    Math.max(0, Math.min(255, Math.round((g + m) * 255))),
    Math.max(0, Math.min(255, Math.round((b + m) * 255))),
  ];
}

function buildLUT(hueShift: number): void {
  const baseHue = (270 + hueShift * 360) % 360;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const hue = ((baseHue - t * 210) % 360 + 360) % 360;
    const sat = 0.6 + t * 0.4;
    const light = t * t * 0.55 + t * 0.1;
    const [r, g, b] = hslToRgb(hue, sat, light);
    COLOR_LUT[i * 3] = r;
    COLOR_LUT[i * 3 + 1] = g;
    COLOR_LUT[i * 3 + 2] = b;
  }
  currentHueShift = hueShift;
}

function pushSnapshot(snap: Float32Array): void {
  if (snapshotCount < MAX_SNAPSHOTS) {
    snapshots.push(snap);
    snapshotCount++;
  } else {
    snapshots[snapshotHead] = snap;
    snapshotHead = (snapshotHead + 1) % MAX_SNAPSHOTS;
  }
}

// ── Draw ─────────────────────────────────────────────────────────────────────
export function drawWaterfall(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const w = p.width;
  const h = p.height;

  if (currentHueShift !== config.waterfallHue) buildLUT(config.waterfallHue);

  // Beat tracking — tick on index advance, decay each frame.
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      lastBeatIndex = currentBeatIndex;
      beatFlash = 1.0;
    }
  }
  beatFlash *= Math.pow(0.85, dt);
  if (beatFlash < 0.001) beatFlash = 0;

  // Capture a new snapshot at a rate set by scroll-speed slider.
  // captureInterval is in frames; 1 = every frame, 5 = every 5 frames.
  const captureInterval = Math.max(1, 5 - config.waterfallScrollSpeed * 4);
  captureAccum += dt;

  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;
  const totalBins = bandCount * SPIKES_PER_BAND;

  if (captureAccum >= captureInterval) {
    captureAccum = 0;
    const snap = new Float32Array(totalBins);
    for (let b = 0; b < bandCount; b++) {
      for (let i = 0; i < SPIKES_PER_BAND; i++) {
        const { amp, tMult, delta } = getBandData(b, i);
        snap[b * SPIKES_PER_BAND + i] = amp * tMult + delta * 0.15;
      }
    }
    pushSnapshot(snap);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.fillStyle = '#02020a';
  ctx.fillRect(0, 0, w, h);

  if (snapshotCount === 0) return;

  // ── Projection parameters ────────────────────────────────────────────────
  const gain = 0.5 + config.waterfallGain * 3.5;
  const baseY = h * 0.82;                // front row baseline
  const horizonY = h * 0.18;              // back row baseline
  const plotWidthNear = w * 0.92;
  const perspectiveScale = 0.28;          // back row this fraction of front
  const ampHeightNear = h * 0.32;

  // Draw painter's-algorithm back-to-front.
  for (let s = 0; s < snapshotCount; s++) {
    const realIdx = (snapshotHead + s) % MAX_SNAPSHOTS;
    const snap = snapshots[realIdx];
    // depth = 0 at newest (front), 1 at oldest (back)
    const depth = snapshotCount > 1 ? (snapshotCount - 1 - s) / (snapshotCount - 1) : 0;

    const scale = 1 - depth * (1 - perspectiveScale);
    const rowY = baseY + (horizonY - baseY) * depth;
    const plotWidth = plotWidthNear * scale;
    const xStart = (w - plotWidth) / 2;
    const ampHeight = ampHeightNear * scale;

    // Opacity + line weight fall off with depth for atmospheric haze.
    const foreground = 1 - depth;
    const fillAlpha = 0.55 + foreground * 0.3;
    const strokeAlpha = 0.35 + foreground * 0.6;
    const lineWidth = 0.6 + foreground * 1.6;

    // Build the ribbon polygon (under-curve area).
    ctx.beginPath();
    ctx.moveTo(xStart, rowY);
    const span = totalBins - 1;
    for (let i = 0; i < totalBins; i++) {
      const x = xStart + (i / span) * plotWidth;
      const amp = Math.min(1, snap[i] * gain);
      ctx.lineTo(x, rowY - amp * ampHeight);
    }
    ctx.lineTo(xStart + plotWidth, rowY);
    ctx.closePath();

    // Occlusion fill — darker in back, slightly lifted in front.
    const bgShade = Math.round(8 + foreground * 14);
    ctx.fillStyle = `rgba(${bgShade},${bgShade},${bgShade + 6},${fillAlpha})`;
    ctx.fill();

    // Stroke the top edge in per-bin color via a horizontal gradient.
    const stops = Math.min(24, totalBins);
    const grad = ctx.createLinearGradient(xStart, 0, xStart + plotWidth, 0);
    for (let k = 0; k <= stops; k++) {
      const binIdx = Math.min(totalBins - 1, Math.round((k / stops) * span));
      const amp = Math.min(1, snap[binIdx] * gain);
      const o = Math.min(255, Math.round(amp * 255)) * 3;
      grad.addColorStop(k / stops, `rgba(${COLOR_LUT[o]},${COLOR_LUT[o + 1]},${COLOR_LUT[o + 2]},${strokeAlpha})`);
    }

    // Trace just the top outline (not the baseline) so we get a colored ridge.
    ctx.beginPath();
    for (let i = 0; i < totalBins; i++) {
      const x = xStart + (i / span) * plotWidth;
      const amp = Math.min(1, snap[i] * gain);
      const y = rowY - amp * ampHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = grad;
    ctx.stroke();
  }

  // Beat flash glazes the whole scene.
  if (beatFlash > 0.1) {
    ctx.fillStyle = `rgba(255,255,255,${beatFlash * 0.12})`;
    ctx.fillRect(0, 0, w, h);
  }
}

export function resetWaterfall(): void {
  snapshots = [];
  snapshotHead = 0;
  snapshotCount = 0;
  captureAccum = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
}
