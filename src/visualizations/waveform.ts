/**
 * Waveform visualization — scrolling EKG-style oscilloscope with image tearing effect.
 *
 * Maintains a circular history buffer of waveform samples. New samples are pushed each frame,
 * creating continuous right-to-left scrolling (newest on right, oldest on left).
 * Speed slider controls how many samples are ingested per frame.
 *
 * Without image: glowing oscilloscope line centered on screen, hue driven by spectral centroid.
 * With image: waveform acts as a cut line; top half shifts up, bottom half shifts down,
 * revealing a glowing waveform in the gap. Displacement driven by bass/sub amplitude.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImage, hasUserImage } from './userImage';

// Circular buffer state
const BUFFER_CAPACITY = 2000;
const buffer = new Float32Array(BUFFER_CAPACITY);
let bufferLen = 0;
let writePtr = 0;

// Beat flash state
let lastBeatIndex = -1;
let beatFlash = 0;

export function resetWaveform(): void {
  buffer.fill(0);
  bufferLen = 0;
  writePtr = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
}

/**
 * Read from the circular buffer in oldest→newest order.
 * Returns the sample at logical index i (0 = oldest, bufferLen-1 = newest).
 */
function readBuffer(i: number): number {
  if (bufferLen < BUFFER_CAPACITY) {
    return buffer[i];
  }
  return buffer[(writePtr + i) % BUFFER_CAPACITY];
}

export function drawWaveform(p: P5Instance, dt: number): void {
  const { state, config, audioState } = store;
  const waveData = audioState.waveformData;
  const N = waveData.length;
  if (N === 0) return;

  const cy = p.height / 2;

  // Push new samples into the circular buffer (frame-rate independent)
  if (state.isPlaying) {
    const samplesPerFrame = Math.max(1, Math.round(4 * config.waveformSpeed * dt));
    const step = N / samplesPerFrame;
    for (let s = 0; s < samplesPerFrame; s++) {
      const srcIdx = Math.min(Math.floor(s * step), N - 1);
      buffer[writePtr] = waveData[srcIdx];
      writePtr = (writePtr + 1) % BUFFER_CAPACITY;
      if (bufferLen < BUFFER_CAPACITY) bufferLen++;
    }
  }

  if (bufferLen === 0) return;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const currentBeatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (currentBeatIndex >= 0 && currentBeatIndex !== lastBeatIndex) {
      beatFlash = 1.0;
      lastBeatIndex = currentBeatIndex;
    }
  }

  // Decay beat flash
  beatFlash *= Math.pow(0.85, dt);
  if (beatFlash < 0.001) beatFlash = 0;

  // Displacement from sub + bass (bands 0 and 1)
  const bandCount = (state.mode === 'freq' || state.mode === 'mic') ? 7 : 5;
  const { amps } = getBandAverages(bandCount);
  const bassAmp = Math.min((amps[0] + amps[1]) / 2 * config.spikeScale, 1.0);
  const displace = bassAmp * p.height * 0.18;
  const gap = bassAmp * p.height * 0.04 + 1;

  // Waveform amplitude scaling
  const waveAmp = p.height * 0.28 * config.spikeScale;

  // HSB color mode with alpha channel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  const hue = audioState.smoothedCentroid * 360;

  // Pre-compute screen points from buffer
  const points: { x: number; y: number }[] = new Array(bufferLen);
  for (let i = 0; i < bufferLen; i++) {
    points[i] = {
      x: (i / (bufferLen - 1)) * p.width,
      y: cy + readBuffer(i) * waveAmp,
    };
  }

  const img = hasUserImage() ? getUserImage() : null;

  if (img) {
    // Image tearing mode: draw two clipped halves of the image

    // Compute image cover-fit dimensions
    const canvasAspect = p.width / p.height;
    const imgAspect = img.width / img.height;
    let drawW: number, drawH: number, drawX: number, drawY: number;
    if (canvasAspect > imgAspect) {
      drawW = p.width;
      drawH = p.width / imgAspect;
      drawX = 0;
      drawY = (p.height - drawH) / 2;
    } else {
      drawH = p.height;
      drawW = p.height * imgAspect;
      drawX = (p.width - drawW) / 2;
      drawY = 0;
    }

    const ctx = p.drawingContext as CanvasRenderingContext2D;

    // Top half: clip to everything above (waveY - gap), image shifts up
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(p.width, 0);
    // Walk right-to-left along the waveform upper boundary
    for (let i = bufferLen - 1; i >= 0; i--) {
      ctx.lineTo(points[i].x, points[i].y - gap);
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img.canvas, drawX, drawY - displace, drawW, drawH);
    ctx.restore();

    // Bottom half: clip to everything below (waveY + gap), image shifts down
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, p.height);
    ctx.lineTo(p.width, p.height);
    // Walk right-to-left along the waveform lower boundary
    for (let i = bufferLen - 1; i >= 0; i--) {
      ctx.lineTo(points[i].x, points[i].y + gap);
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img.canvas, drawX, drawY + displace, drawW, drawH);
    ctx.restore();
  }

  // Draw glowing waveform line (4 passes: outer glow to sharp core)
  p.noFill();
  const glowLayers: { weight: number; alpha: number }[] = [
    { weight: 20, alpha: 4 },
    { weight: 10, alpha: 12 },
    { weight: 4,  alpha: 35 },
    { weight: 1.5, alpha: 100 },
  ];

  for (const layer of glowLayers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).stroke(hue, 70, 100, layer.alpha);
    p.strokeWeight(layer.weight);
    p.beginShape();
    for (let i = 0; i < bufferLen; i++) {
      p.vertex(points[i].x, points[i].y);
    }
    p.endShape();
  }

  // Beat flash: subtle full-screen color overlay
  if (beatFlash > 0.01) {
    p.noStroke();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).fill(hue, 60, 100, beatFlash * 20);
    p.rect(0, 0, p.width, p.height);
  }

  // Reset to RGB color mode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).colorMode(p['RGB'], 255);
}
