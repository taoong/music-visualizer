/**
 * Liquify — feedback-warp image distortion.
 *
 * The user image continuously melts through a non-linear warp field driven by
 * the spectrum: 7 swirl centers (one per band) wander around the canvas,
 * twisting pixels rotationally around themselves with strength = band
 * amplitude. Bass adds a radial breath, treble adds high-frequency jitter.
 * On each beat, a shockwave pushes pixels outward from a random point.
 *
 * Two ping-pong buffers hold the previous frame; each output pixel is
 * bilinearly resampled from the previous buffer through the warp field, then
 * the source image is alpha-blended on top so the picture is continuously
 * re-fed into the system but immediately starts melting again.
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { getUserImage, hasUserImage } from './userImage';
import { isMobile } from '../utils/constants';

// Internal buffer size — small enough for per-pixel JS at 60fps,
// large enough to keep the upscaled result readable.
const BUF_W = isMobile ? 192 : 320;
const BUF_H = isMobile ? 108 : 180;
const SWIRL_COUNT = 7;

interface Buffer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  data: ImageData;
}

interface Swirl {
  phase: number;
}

let initialized = false;
let bufA: Buffer | null = null;
let bufB: Buffer | null = null;
let writeIsA = true;
let sourceCanvas: HTMLCanvasElement | null = null;
let sourceCtx: CanvasRenderingContext2D | null = null;
let sourceImageData: ImageData | null = null;

let swirls: Swirl[] = [];
const swirlX = new Float32Array(SWIRL_COUNT);
const swirlY = new Float32Array(SWIRL_COUNT);
const swirlStrength = new Float32Array(SWIRL_COUNT);

let lastBeatIndex = -1;
let shockX = 0.5;
let shockY = 0.5;
let shockT = 0;
let hueShift = 0;
let timeAccum = 0;

let imageUnsub: (() => void) | null = null;

// Per-row sin / per-col cos cache for the domain-warp jitter, so we don't
// call trig 50k+ times per frame.
const jitterRow = new Float32Array(BUF_H);
const jitterCol = new Float32Array(BUF_W);

// ── Init ─────────────────────────────────────────────────────────────────────

function makeBuffer(): Buffer {
  const canvas = document.createElement('canvas');
  canvas.width = BUF_W;
  canvas.height = BUF_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, BUF_W, BUF_H);
  return { canvas, ctx, data: ctx.getImageData(0, 0, BUF_W, BUF_H) };
}

function initSwirls(): void {
  swirls = [];
  for (let i = 0; i < SWIRL_COUNT; i++) {
    swirls.push({ phase: i * 0.83 });
  }
}

function drawRainbow(): void {
  if (!sourceCtx) return;
  const grad = sourceCtx.createLinearGradient(0, 0, BUF_W, BUF_H);
  for (let i = 0; i <= 6; i++) {
    grad.addColorStop(i / 6, `hsl(${i * 60}, 90%, 55%)`);
  }
  sourceCtx.fillStyle = grad;
  sourceCtx.fillRect(0, 0, BUF_W, BUF_H);
}

function loadSource(): void {
  if (!sourceCanvas || !sourceCtx) {
    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = BUF_W;
    sourceCanvas.height = BUF_H;
    sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true })!;
  }
  sourceCtx.clearRect(0, 0, BUF_W, BUF_H);

  if (hasUserImage()) {
    const img = getUserImage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcCanvas = img ? ((img as any).canvas || (img as any).elt) : null;
    if (img && srcCanvas) {
      const iw = img.width as number;
      const ih = img.height as number;
      const srcAspect = iw / ih;
      const dstAspect = BUF_W / BUF_H;
      let dx: number, dy: number, dw: number, dh: number;
      if (srcAspect > dstAspect) {
        dh = BUF_H; dw = BUF_H * srcAspect;
        dx = (BUF_W - dw) / 2; dy = 0;
      } else {
        dw = BUF_W; dh = BUF_W / srcAspect;
        dx = 0; dy = (BUF_H - dh) / 2;
      }
      sourceCtx.fillStyle = '#000';
      sourceCtx.fillRect(0, 0, BUF_W, BUF_H);
      sourceCtx.drawImage(srcCanvas, dx, dy, dw, dh);
    } else {
      drawRainbow();
    }
  } else {
    drawRainbow();
  }

  sourceImageData = sourceCtx.getImageData(0, 0, BUF_W, BUF_H);
}

function seedBuffers(): void {
  if (!bufA || !bufB || !sourceImageData) return;
  bufA.data.data.set(sourceImageData.data);
  bufB.data.data.set(sourceImageData.data);
  bufA.ctx.putImageData(bufA.data, 0, 0);
  bufB.ctx.putImageData(bufB.data, 0, 0);
}

function init(): void {
  bufA = makeBuffer();
  bufB = makeBuffer();
  initSwirls();
  loadSource();
  seedBuffers();
  imageUnsub = store.on('imageChange', () => {
    setTimeout(() => {
      loadSource();
      seedBuffers();
    }, 100);
  });
  initialized = true;
}

// ── Draw ─────────────────────────────────────────────────────────────────────

export function drawLiquify(p: P5Instance, dt: number): void {
  if (!initialized) init();
  if (!bufA || !bufB || !sourceImageData) return;

  const { state, config } = store;
  const { amps } = getBandAverages(7);

  const flow = config.liquifyFlow ?? 0.5;
  const persistenceSlider = config.liquifyPersistence ?? 0.7;
  const beatSurge = config.liquifyBeatSurge ?? 0.5;
  // Cap: at slider=1.0 persistence is 0.95, never 1.0, so feedback can't lock.
  const persistence = 0.55 + persistenceSlider * 0.4;

  // Beat detection
  if (state.beatIntervalSec > 0 && state.isPlaying && state.detectedBPM > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIndex = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIndex > lastBeatIndex && lastBeatIndex !== -1 && beatSurge > 0.01) {
      shockX = 0.25 + Math.random() * 0.5;
      shockY = 0.25 + Math.random() * 0.5;
      shockT = 1.0;
      hueShift += (Math.random() < 0.5 ? -1 : 1) * 14 * beatSurge;
    }
    if (beatIndex !== lastBeatIndex) lastBeatIndex = beatIndex;
  }
  shockT = Math.max(0, shockT - dt * 0.05);

  timeAccum += dt;

  // Swirl center positions follow circular Lissajous-style paths so they
  // wander predictably without needing a noise impl.
  for (let i = 0; i < SWIRL_COUNT; i++) {
    const t = timeAccum * 0.012 + swirls[i].phase;
    swirlX[i] = (0.5 + Math.cos(t * (1 + i * 0.13) + i) * 0.35) * BUF_W;
    swirlY[i] = (0.5 + Math.sin(t * (0.9 + i * 0.17) + i * 1.3) * 0.32) * BUF_H;
    // Cap at 0.4 so small-angle approx stays accurate near swirl centers.
    swirlStrength[i] = Math.min(0.4, amps[i] * flow * 0.5);
  }

  // Bass radial breath
  const bassAmp = amps[0] * flow;
  const breathPhase = Math.sin(timeAccum * 0.04);
  const breathK = bassAmp * breathPhase * 0.04;

  // Treble jitter
  const trebleAmp = amps[6] * flow;
  const jitterAmp = (0.06 + trebleAmp * 0.4) * 12;

  // Cache per-row sin and per-col cos for the jitter — saves O(W*H) trig.
  const jitterRowK = 0.05;
  const jitterColK = 0.05;
  const jitterPhaseY = timeAccum * 0.1;
  const jitterPhaseX = timeAccum * 0.13;
  for (let y = 0; y < BUF_H; y++) {
    jitterRow[y] = Math.sin(y * jitterRowK + jitterPhaseY) * jitterAmp;
  }
  for (let x = 0; x < BUF_W; x++) {
    jitterCol[x] = Math.cos(x * jitterColK + jitterPhaseX) * jitterAmp;
  }

  // Shockwave
  const shockPxX = shockX * BUF_W;
  const shockPxY = shockY * BUF_H;
  const shockMag = shockT * shockT * beatSurge * 0.018;
  const shockRadius = (1 - shockT) * Math.max(BUF_W, BUF_H);
  const shockSigma = 0.0008;
  const shockActive = shockMag > 0.0005;

  const cx = BUF_W * 0.5;
  const cy = BUF_H * 0.5;

  // Image re-injection alpha (small audio modulation)
  const midAmp = (amps[2] + amps[3]) * 0.5;
  const injectAlpha = Math.min(0.32, 0.14 + midAmp * 0.07);
  const oneMinusAlpha = 1 - injectAlpha;

  // Read from prev, write to next
  const readBuf = writeIsA ? bufB : bufA;
  const writeBuf = writeIsA ? bufA : bufB;
  const src = readBuf.data.data;
  const dst = writeBuf.data.data;
  const srcImg = sourceImageData.data;

  const W = BUF_W;
  const H = BUF_H;
  const wMinus1 = W - 1;
  const hMinus1 = H - 1;

  let p_ = 0;
  for (let y = 0; y < H; y++) {
    const rowJitterY = jitterRow[y];
    const bdy = y - cy;
    for (let x = 0; x < W; x++) {
      let dx = jitterCol[x];
      let dy = rowJitterY;

      // Swirl rotations (small-angle: rotate by θ around (sx,sy) ≈ adds (-rdy*θ, rdx*θ))
      for (let i = 0; i < SWIRL_COUNT; i++) {
        const rdx = x - swirlX[i];
        const rdy = y - swirlY[i];
        const r2 = rdx * rdx + rdy * rdy;
        const theta = swirlStrength[i] / (1 + r2 * 0.0008);
        dx -= rdy * theta;
        dy += rdx * theta;
      }

      // Radial breath
      const bdx = x - cx;
      dx += bdx * breathK;
      dy += bdy * breathK;

      // Shockwave: pulse pushes outward in a thin ring around shockRadius.
      if (shockActive) {
        const sdx = x - shockPxX;
        const sdy = y - shockPxY;
        const sr = Math.sqrt(sdx * sdx + sdy * sdy) + 0.5;
        const ringDist = sr - shockRadius;
        const ring = Math.exp(-ringDist * ringDist * shockSigma);
        const push = ring * shockMag * Math.max(W, H) / sr;
        // Pull pixels INTO the warp source from outside the ring → image
        // appears pushed outward by the ring.
        dx -= sdx * push;
        dy -= sdy * push;
      }

      // Sample prev buffer at warped coords (bilinear, clamped).
      let sx = x + dx;
      let sy = y + dy;
      if (sx < 0) sx = 0; else if (sx > wMinus1) sx = wMinus1;
      if (sy < 0) sy = 0; else if (sy > hMinus1) sy = hMinus1;

      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 < wMinus1 ? x0 + 1 : x0;
      const y1 = y0 < hMinus1 ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const ifx = 1 - fx;
      const ify = 1 - fy;
      const w00 = ifx * ify;
      const w10 = fx * ify;
      const w01 = ifx * fy;
      const w11 = fx * fy;

      const i00 = (y0 * W + x0) << 2;
      const i10 = (y0 * W + x1) << 2;
      const i01 = (y1 * W + x0) << 2;
      const i11 = (y1 * W + x1) << 2;

      const sr0 = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      const sg0 = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      const sb0 = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;

      // Persistence fade + source re-injection (manual alpha blend).
      const r1 = sr0 * persistence;
      const g1 = sg0 * persistence;
      const b1 = sb0 * persistence;

      dst[p_]     = r1 * oneMinusAlpha + srcImg[p_]     * injectAlpha;
      dst[p_ + 1] = g1 * oneMinusAlpha + srcImg[p_ + 1] * injectAlpha;
      dst[p_ + 2] = b1 * oneMinusAlpha + srcImg[p_ + 2] * injectAlpha;
      dst[p_ + 3] = 255;

      p_ += 4;
    }
  }

  writeBuf.ctx.putImageData(writeBuf.data, 0, 0);
  writeIsA = !writeIsA;

  // Decay hue shift
  hueShift *= Math.pow(0.93, dt);
  if (Math.abs(hueShift) < 0.5) hueShift = 0;

  // Upscale to main canvas (cover-fit)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctxMain = (p as any).drawingContext as CanvasRenderingContext2D;
  ctxMain.fillStyle = '#000';
  ctxMain.fillRect(0, 0, p.width, p.height);

  const aspect = W / H;
  const dstAspect = p.width / p.height;
  let dW: number, dH: number, dX: number, dY: number;
  if (aspect > dstAspect) {
    dH = p.height;
    dW = p.height * aspect;
    dX = (p.width - dW) / 2;
    dY = 0;
  } else {
    dW = p.width;
    dH = p.width / aspect;
    dX = 0;
    dY = (p.height - dH) / 2;
  }

  ctxMain.imageSmoothingEnabled = true;
  ctxMain.imageSmoothingQuality = 'high';
  if (hueShift !== 0) ctxMain.filter = `hue-rotate(${hueShift.toFixed(2)}deg)`;
  ctxMain.drawImage(writeBuf.canvas, dX, dY, dW, dH);
  if (hueShift !== 0) ctxMain.filter = 'none';

  // Beat flash overlay
  if (shockT > 0.5) {
    ctxMain.fillStyle = `rgba(255,255,255,${(shockT - 0.5) * beatSurge * 0.18})`;
    ctxMain.fillRect(0, 0, p.width, p.height);
  }
}

export function resetLiquify(): void {
  if (initialized) {
    seedBuffers();
  }
  lastBeatIndex = -1;
  shockT = 0;
  hueShift = 0;
}

export function disposeLiquify(): void {
  if (imageUnsub) {
    imageUnsub();
    imageUnsub = null;
  }
  bufA = null;
  bufB = null;
  sourceCanvas = null;
  sourceCtx = null;
  sourceImageData = null;
  swirls = [];
  initialized = false;
  lastBeatIndex = -1;
  shockT = 0;
  hueShift = 0;
  timeAccum = 0;
}
