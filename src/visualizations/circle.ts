/**
 * Circle visualization with frequency-driven spikes
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import {
  SPIKES_PER_BAND,
  DELTA_SPIKE_WIDTH_MIN,
  DELTA_SPIKE_WIDTH_MAX,
  DELTA_LENGTH_BOOST,
} from '../utils/constants';
import { getBandData } from './helpers';
import { getUserImage, hasUserImage } from './userImage';

// ── Image color sampling state ───────────────────────────────────────────────

const SAMPLE_SIZE = 256;
let sampleCanvas: HTMLCanvasElement | null = null;
let sampleCtx: CanvasRenderingContext2D | null = null;
let sampleImageData: ImageData | null = null;
let sampleW = 0;
let sampleH = 0;
let imageUnsub: (() => void) | null = null;
let imageInitialized = false;
let imageRotation = 0;

function loadCircleImage(): void {
  if (!hasUserImage()) {
    sampleImageData = null;
    return;
  }
  const img = getUserImage();
  if (!img) { sampleImageData = null; return; }

  const iw = img.width as number;
  const ih = img.height as number;
  const scale = Math.min(1, SAMPLE_SIZE / Math.max(iw, ih));
  const w = Math.round(iw * scale);
  const h = Math.round(ih * scale);

  if (!sampleCanvas || w !== sampleW || h !== sampleH) {
    sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = w;
    sampleCanvas.height = h;
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })!;
    sampleW = w;
    sampleH = h;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const srcCanvas = (img as any).canvas || (img as any).elt;
  if (srcCanvas) {
    sampleCtx!.drawImage(srcCanvas, 0, 0, w, h);
    sampleImageData = sampleCtx!.getImageData(0, 0, w, h);
  }
}

function initCircleImage(): void {
  if (imageInitialized) return;
  loadCircleImage();
  imageUnsub = store.on('imageChange', () => {
    setTimeout(() => loadCircleImage(), 100);
  });
  imageInitialized = true;
}

function sampleImageColor(angle: number): [number, number, number] | null {
  if (!sampleImageData) return null;
  const w = sampleW;
  const h = sampleH;
  // Map angle to a point on the circular edge of the image (cover-fit)
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy);
  const px = Math.round(cx + r * Math.cos(angle));
  const py = Math.round(cy + r * Math.sin(angle));
  // Clamp to image bounds
  const x = Math.max(0, Math.min(w - 1, px));
  const y = Math.max(0, Math.min(h - 1, py));
  const idx = (y * w + x) * 4;
  return [sampleImageData.data[idx], sampleImageData.data[idx + 1], sampleImageData.data[idx + 2]];
}

export function resetSpikeCircle(): void {
  if (imageUnsub) {
    imageUnsub();
    imageUnsub = null;
  }
  sampleCanvas = null;
  sampleCtx = null;
  sampleImageData = null;
  imageInitialized = false;
  imageRotation = 0;
}

export function drawSpikeCircle(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;

  // Accumulate independent image rotation offset
  imageRotation += (dt / 1000) * config.circleImageRotation;

  // Beat-reactive color: change hue on BPM grid (phase-aligned to first beat)
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== state.lastBeatIndex) {
      state.circleOutlineHue = (state.circleOutlineHue + 90 + Math.random() * 180) % 360;
      state.lastBeatIndex = currentBeatIndex;
    }
  }

  const cx = p.width / 2;
  const cy = p.height / 2;
  const minDim = Math.min(p.width, p.height);
  const baseRadius = minDim * 0.12;
  const maxSpikeLen = minDim * 0.35;

  const isFreqMode = state.mode === 'freq' || state.mode === 'mic';
  const bandCount = isFreqMode ? 7 : 5;
  const totalSpikes = SPIKES_PER_BAND * bandCount;

  const angleStep = (Math.PI * 2) / totalSpikes;
  const rotation = (p.millis() / 1000.0) * config.rotationSpeed * 0.4;

  // Initialize image sampling on first frame
  initCircleImage();

  p.push();
  p.translate(cx, cy + audioState.centroidYOffset);

  // Draw spikes as tapered triangles
  p.noStroke();
  for (let i = 0; i < totalSpikes; i++) {
    const angle = i * angleStep + rotation;
    const band = Math.floor(i / SPIKES_PER_BAND);
    const bandIdx = i % SPIKES_PER_BAND;

    const { amp: rawAmp, tMult, delta } = getBandData(band, bandIdx);

    const amp = rawAmp * config.spikeScale * tMult;

    const spikeLen = amp * maxSpikeLen * (1.0 + delta * DELTA_LENGTH_BOOST);
    if (spikeLen < 0.5) continue;

    // Spike base half-width — high delta = narrow/punchy, low delta = wide/sustained
    const widthFactor =
      DELTA_SPIKE_WIDTH_MAX - delta * (DELTA_SPIKE_WIDTH_MAX - DELTA_SPIKE_WIDTH_MIN);
    const halfBase = angleStep * (widthFactor + amp * 0.1);

    const innerR = baseRadius;
    const outerR = baseRadius + spikeLen;

    // Color: sample from image if available, otherwise grayscale
    // Subtract both spike rotation and image offset so colors stay locked to the image
    const sampled = sampleImageColor(angle - rotation - imageRotation);
    if (sampled) {
      const factor = 0.3 + Math.min(amp, 1.0) * 0.7;
      p.fill(sampled[0] * factor, sampled[1] * factor, sampled[2] * factor);
    } else {
      const brightness = 120 + Math.min(amp, 1.0) * 135 + delta * 30;
      p.fill(brightness);
    }

    p.beginShape();
    p.vertex(Math.cos(angle - halfBase) * innerR, Math.sin(angle - halfBase) * innerR);
    p.vertex(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
    p.vertex(Math.cos(angle + halfBase) * innerR, Math.sin(angle + halfBase) * innerR);
    p.endShape(0); // CLOSE constant
  }

  // Draw base circle on top (beat-reactive color)
  p.noFill();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100);
  p.stroke(state.circleOutlineHue, 85, 100);
  p.strokeWeight(2);
  p.ellipse(0, 0, baseRadius * 2, baseRadius * 2);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['RGB'], 255);

  // Draw user image clipped to center circle (rotated)
  const userImg = getUserImage();
  if (userImg) {
    const ctx = p.drawingContext;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(rotation + imageRotation);

    const r = baseRadius - 2;
    const imgAspect = userImg.width / userImg.height;
    let drawW: number, drawH: number;
    if (imgAspect > 1) {
      drawH = r * 2;
      drawW = drawH * imgAspect;
    } else {
      drawW = r * 2;
      drawH = drawW / imgAspect;
    }
    ctx.drawImage(userImg.canvas, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  }

  p.pop();
}
