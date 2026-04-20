/**
 * Waterfall — 3D scrolling spectrogram.
 *
 * A ring buffer of recent spectrum snapshots is rendered as stacked ribbons
 * in oblique projection: newest in front at full size, older ones recede
 * up-and-back with perspective scaling. Amplitude becomes ribbon height;
 * a plasma palette colors each bin along the ridge.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandData } from './helpers';
import { BAND_COUNT, SPIKES_PER_BAND, isMobile } from '../utils/constants';

// ── Snapshot ring buffer ────────────────────────────────────────────────────
// Count & per-ribbon sampling are the two biggest perf levers. A 3D
// waterfall reads well with fewer-but-clearer ribbons than a dense stack.
const MAX_SNAPSHOTS = isMobile ? 16 : 26;
const RIBBON_POINTS = isMobile ? 84 : 140;
const GRAD_STOPS = 6;

let snapshots: Float32Array[] = [];
let snapshotHead = 0;   // index of oldest entry
let snapshotCount = 0;
let captureAccum = 0;

let lastBeatIndex = -1;
let beatFlash = 0;

const scratchX = new Float32Array(RIBBON_POINTS);
const scratchY = new Float32Array(RIBBON_POINTS);

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

  const captureInterval = Math.max(1, 5 - config.waterfallScrollSpeed * 4);
  captureAccum += dt;

  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? BAND_COUNT : 5;
  const totalBins = bandCount * SPIKES_PER_BAND;

  // Downsample source bins → RIBBON_POINTS via max-pool. Point sampling
  // would drop spikes that don't land on a sample index; max-pool keeps
  // peaks, so the ridge stays spiky instead of flattening to an envelope.
  if (captureAccum >= captureInterval) {
    captureAccum = 0;
    const snap = new Float32Array(RIBBON_POINTS);
    for (let k = 0; k < RIBBON_POINTS; k++) {
      const i0 = Math.floor((k * totalBins) / RIBBON_POINTS);
      const i1 = Math.max(i0 + 1, Math.floor(((k + 1) * totalBins) / RIBBON_POINTS));
      let peak = 0;
      for (let i = i0; i < i1; i++) {
        const b = Math.min(bandCount - 1, Math.floor(i / SPIKES_PER_BAND));
        const j = i - b * SPIKES_PER_BAND;
        const { amp, tMult, delta } = getBandData(b, j);
        const v = amp * tMult + delta * 0.15;
        if (v > peak) peak = v;
      }
      snap[k] = peak;
    }
    pushSnapshot(snap);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.fillStyle = '#02020a';
  ctx.fillRect(0, 0, w, h);

  if (snapshotCount === 0) return;

  const gain = 0.5 + config.waterfallGain * 3.5;
  const baseY = h * 0.85;
  const horizonY = h * 0.22;
  const frontCenterX = w * 0.28;      // newest ribbon anchors lower-left
  const backCenterX = w * 0.86;       // oldest ribbon drifts to upper-right
  const plotWidthNear = w * 0.66;
  const perspectiveScale = 0.28;
  const ampHeightNear = h * 0.32;

  // Painter's-algorithm back-to-front.
  for (let s = 0; s < snapshotCount; s++) {
    const realIdx = (snapshotHead + s) % MAX_SNAPSHOTS;
    const snap = snapshots[realIdx];
    const depth = snapshotCount > 1 ? (snapshotCount - 1 - s) / (snapshotCount - 1) : 0;

    const scale = 1 - depth * (1 - perspectiveScale);
    const rowY = baseY + (horizonY - baseY) * depth;
    const centerX = frontCenterX + (backCenterX - frontCenterX) * depth;
    const plotWidth = plotWidthNear * scale;
    const xStart = centerX - plotWidth / 2;
    const ampHeight = ampHeightNear * scale;
    const foreground = 1 - depth;

    // Compute ridge points once, stash in scratch buffers.
    const span = RIBBON_POINTS - 1;
    for (let k = 0; k < RIBBON_POINTS; k++) {
      const amp = snap[k] * gain;
      const a = amp < 0 ? 0 : amp > 1 ? 1 : amp;
      scratchX[k] = xStart + (k / span) * plotWidth;
      scratchY[k] = rowY - a * ampHeight;
    }

    // Filled polygon (ridge → down to baseline corners) for occlusion.
    ctx.beginPath();
    ctx.moveTo(xStart, rowY);
    for (let k = 0; k < RIBBON_POINTS; k++) ctx.lineTo(scratchX[k], scratchY[k]);
    ctx.lineTo(xStart + plotWidth, rowY);
    ctx.closePath();
    const bgShade = 8 + foreground * 14;
    ctx.fillStyle = `rgba(${bgShade | 0},${bgShade | 0},${(bgShade + 6) | 0},${0.6 + foreground * 0.3})`;
    ctx.fill();

    // Ridge stroke with a sparse horizontal gradient — front ribbons get
    // coloring, back ribbons stay subtle.
    const strokeAlpha = 0.35 + foreground * 0.6;
    const grad = ctx.createLinearGradient(xStart, 0, xStart + plotWidth, 0);
    for (let k = 0; k <= GRAD_STOPS; k++) {
      const t = k / GRAD_STOPS;
      const idx = Math.min(RIBBON_POINTS - 1, Math.round(t * span));
      const amp = snap[idx] * gain;
      const a = amp < 0 ? 0 : amp > 1 ? 1 : amp;
      const o = ((a * 255) | 0) * 3;
      grad.addColorStop(t, `rgba(${COLOR_LUT[o]},${COLOR_LUT[o + 1]},${COLOR_LUT[o + 2]},${strokeAlpha})`);
    }

    ctx.beginPath();
    ctx.moveTo(scratchX[0], scratchY[0]);
    for (let k = 1; k < RIBBON_POINTS; k++) ctx.lineTo(scratchX[k], scratchY[k]);
    ctx.lineWidth = 0.6 + foreground * 1.6;
    ctx.strokeStyle = grad;
    ctx.stroke();
  }

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
