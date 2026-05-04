/**
 * Fisheye Pulse — barrel-distortion fisheye lens applied to user image.
 * Distortion strength pulses hard on every beat (center bulges toward viewer),
 * and continuously tracks bass amplitude. Chromatic aberration fringes each
 * beat punch. Vignette and lens-edge glow sell the optical effect.
 *
 * Algorithm: for each output pixel at normalized (nx, ny) ∈ [-1,1]²,
 * compute r² = nx² + ny², then scale = 1 − k·r² (barrel distortion).
 * Source is sampled at (nx·scale, ny·scale). Per-channel k offsets create
 * chromatic aberration. Bilinear sampling upscaled to full canvas.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImage, hasUserImage } from './userImage';
import { isMobile } from '../utils/constants';

const BUF_W = isMobile ? 192 : 320;
const BUF_H = isMobile ? 108 : 180;

let initialized = false;
let srcPixels: Uint8ClampedArray | null = null;
let outCanvas: HTMLCanvasElement | null = null;
let outCtx: CanvasRenderingContext2D | null = null;
let outData: ImageData | null = null;

let beatPulse = 0;
let lastBeatIndex = -1;
let imageUnsub: (() => void) | null = null;

// ── Source loading ────────────────────────────────────────────────────────────

function drawRainbow(ctx: CanvasRenderingContext2D): void {
  const grad = ctx.createLinearGradient(0, 0, BUF_W, BUF_H);
  for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 90%, 55%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, BUF_W, BUF_H);
}

function loadSource(): void {
  const tmp = document.createElement('canvas');
  tmp.width = BUF_W;
  tmp.height = BUF_H;
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;

  if (hasUserImage()) {
    const img = getUserImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcEl = img ? ((img as any).canvas || (img as any).elt) : null;
    if (img && srcEl) {
      const iw = img.width as number;
      const ih = img.height as number;
      const sa = iw / ih;
      const da = BUF_W / BUF_H;
      let dx: number, dy: number, dw: number, dh: number;
      if (sa > da) {
        dh = BUF_H; dw = BUF_H * sa; dx = (BUF_W - dw) / 2; dy = 0;
      } else {
        dw = BUF_W; dh = BUF_W / sa; dx = 0; dy = (BUF_H - dh) / 2;
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, BUF_W, BUF_H);
      ctx.drawImage(srcEl, dx, dy, dw, dh);
    } else {
      drawRainbow(ctx);
    }
  } else {
    drawRainbow(ctx);
  }

  srcPixels = ctx.getImageData(0, 0, BUF_W, BUF_H).data;
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init(): void {
  outCanvas = document.createElement('canvas');
  outCanvas.width = BUF_W;
  outCanvas.height = BUF_H;
  outCtx = outCanvas.getContext('2d')!;
  outData = outCtx.createImageData(BUF_W, BUF_H);

  loadSource();

  imageUnsub = store.on('imageChange', () => { setTimeout(loadSource, 100); });
  initialized = true;
}

// ── Bilinear sample (single channel) ─────────────────────────────────────────

// nx, ny in [-1, 1]. ch = 0/1/2 for R/G/B.
function sampleCh(src: Uint8ClampedArray, nx: number, ny: number, ch: number): number {
  const px = ((nx + 1) * 0.5) * (BUF_W - 1);
  const py = ((ny + 1) * 0.5) * (BUF_H - 1);
  const x0 = px < 0 ? 0 : px > BUF_W - 2 ? BUF_W - 2 : px | 0;
  const y0 = py < 0 ? 0 : py > BUF_H - 2 ? BUF_H - 2 : py | 0;
  const fx = px - x0;
  const fy = py - y0;
  const ifx = 1 - fx;
  const ify = 1 - fy;
  const r0 = y0 * BUF_W;
  const r1 = r0 + BUF_W;
  return (
    src[(r0 + x0) * 4 + ch] * ifx * ify +
    src[(r0 + x0 + 1) * 4 + ch] * fx * ify +
    src[(r1 + x0) * 4 + ch] * ifx * fy +
    src[(r1 + x0 + 1) * 4 + ch] * fx * fy
  );
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawFisheye(p: P5Instance, dt: number): void {
  if (!initialized) init();
  if (!srcPixels || !outCanvas || !outCtx || !outData) return;

  const { state, config } = store;
  const { amps } = getBandAverages(7);

  const strength    = config.fisheyeStrength    ?? 0.3;
  const beatSetting = config.fisheyeBeatPulse   ?? 1.0;
  const chromatic   = config.fisheyeChromatic   ?? 0.4;

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying && state.detectedBPM > 0) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const idx      = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (idx > lastBeatIndex && lastBeatIndex !== -1) {
      beatPulse = beatSetting;
    }
    if (idx !== lastBeatIndex) lastBeatIndex = idx;
  }
  // Exponential beat decay (feel the punch, then fall back)
  beatPulse = Math.max(0, beatPulse - dt * 0.055);

  // Total lens distortion = base + audio bass + beat pulse
  const bassBoost   = amps[1] * 0.35;
  const totalK      = Math.min(strength + bassBoost + beatPulse * 0.55, 2.0);

  // Chromatic aberration offset — only meaningful on beats
  const chromDelta  = chromatic * Math.min(beatPulse, 1.0) * 0.12;
  const kR = totalK + chromDelta;
  const kG = totalK;
  const kB = totalK - chromDelta;

  const W = BUF_W;
  const H = BUF_H;
  const out = outData.data;
  const src = srcPixels;

  for (let py = 0; py < H; py++) {
    const ny = (py / (H - 1)) * 2 - 1;

    for (let px = 0; px < W; px++) {
      const nx  = (px / (W - 1)) * 2 - 1;
      const r2  = nx * nx + ny * ny;

      // Barrel distortion: scale < 1 → sample from closer to center → bulge
      const scR = Math.max(0, 1 - kR * r2);
      const scG = Math.max(0, 1 - kG * r2);
      const scB = Math.max(0, 1 - kB * r2);

      const i = (py * W + px) << 2;
      out[i]     = sampleCh(src, nx * scR, ny * scR, 0);
      out[i + 1] = sampleCh(src, nx * scG, ny * scG, 1);
      out[i + 2] = sampleCh(src, nx * scB, ny * scB, 2);
      out[i + 3] = 255;
    }
  }

  outCtx.putImageData(outData, 0, 0);

  // Upscale to main canvas (cover-fit)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctxMain = (p as any).drawingContext as CanvasRenderingContext2D;
  ctxMain.fillStyle = '#000';
  ctxMain.fillRect(0, 0, p.width, p.height);

  const bufAspect = W / H;
  const dstAspect = p.width / p.height;
  let dW: number, dH: number, dX: number, dY: number;
  if (bufAspect > dstAspect) {
    dH = p.height; dW = p.height * bufAspect;
    dX = (p.width - dW) / 2; dY = 0;
  } else {
    dW = p.width; dH = p.width / bufAspect;
    dX = 0; dY = (p.height - dH) / 2;
  }
  ctxMain.imageSmoothingEnabled = true;
  ctxMain.imageSmoothingQuality = 'high';
  ctxMain.drawImage(outCanvas, dX, dY, dW, dH);

  // Vignette: subtle in-lens darkening at edges (always)
  const vignette = ctxMain.createRadialGradient(
    p.width / 2, p.height / 2, p.height * 0.15,
    p.width / 2, p.height / 2, p.height * 0.75
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctxMain.fillStyle = vignette;
  ctxMain.fillRect(0, 0, p.width, p.height);

  // Lens-edge glow ring on beat
  if (beatPulse > 0.05) {
    const alpha = beatPulse * 0.35;
    const hue   = (Date.now() / 30) % 360;
    const ring  = ctxMain.createRadialGradient(
      p.width / 2, p.height / 2, p.height * 0.55,
      p.width / 2, p.height / 2, p.height * 0.75
    );
    ring.addColorStop(0, `hsla(${hue}, 100%, 70%, ${alpha})`);
    ring.addColorStop(1, 'rgba(0,0,0,0)');
    ctxMain.fillStyle = ring;
    ctxMain.fillRect(0, 0, p.width, p.height);
  }

  // White flash at beat peak
  if (beatPulse > 0.8) {
    ctxMain.fillStyle = `rgba(255,255,255,${(beatPulse - 0.8) * 0.25 * beatSetting})`;
    ctxMain.fillRect(0, 0, p.width, p.height);
  }
}

export function resetFisheye(): void {
  beatPulse = 0;
  lastBeatIndex = -1;
  if (initialized) loadSource();
}

export function disposeFisheye(): void {
  imageUnsub?.();
  imageUnsub = null;
  initialized = false;
  srcPixels = null;
  outCanvas = null;
  outCtx = null;
  outData = null;
}
