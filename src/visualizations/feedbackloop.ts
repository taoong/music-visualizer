/**
 * Feedback — Video feedback loop visualization.
 *
 * Inspired by Steina & Woody Vasulka's "Violin Power" (1970–78),
 * https://vasulka.org/archive/RightsContacts/VasulkaSteina/Violin_Power.html
 * — one of the earliest audiovisual works to use video feedback as an
 * artistic medium, where a camera pointed at its own monitor creates
 * recursive spiraling patterns driven by sound. Steina performed violin
 * while Woody's custom video synthesizers modulated the feedback parameters
 * with the audio signal in real-time.
 *
 * Each frame the previous frame is scaled and rotated slightly, then seven
 * frequency-band rings are drawn on top. The recursive accumulation creates
 * converging spirals whose hue history is literally visible as concentric
 * colour layers spiraling toward (or away from) the centre.
 *
 * Technical approach: ping-pong pair of OffscreenCanvas buffers — one read
 * source, one write destination, swapped every frame. Additive ("lighter")
 * blend for the glowing ring strokes. Beat fires hue-palette jump + flash.
 *
 * Sliders
 *   Zoom    — feedback scale factor (0 = tight vortex, 1 = very slow fade)
 *   Spiral  — rotation added per frame (0 = concentric rings, 1 = tight spiral)
 *   Glow    — ring stroke weight and bloom intensity
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Hue per band: sub-bass=violet → brilliance=red/magenta
const BAND_HUES: readonly number[] = [280, 230, 175, 120, 55, 25, 330];

// ── Module state ──────────────────────────────────────────────────────────────

let fbSrc: OffscreenCanvas | HTMLCanvasElement | null = null;
let fbDst: OffscreenCanvas | HTMLCanvasElement | null = null;
let srcCtx: CanvasRenderingContext2D | null = null;
let dstCtx: CanvasRenderingContext2D | null = null;
let fbW = 0;
let fbH = 0;

let hueShift = 0;
let lastBeatIndex = -1;
let beatFlash = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCanvas(w: number, h: number): [OffscreenCanvas | HTMLCanvasElement, CanvasRenderingContext2D] {
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(w, h);
    return [oc, oc.getContext('2d') as unknown as CanvasRenderingContext2D];
  }
  const el = document.createElement('canvas');
  el.width = w; el.height = h;
  return [el, el.getContext('2d')!];
}

function ensureBuffers(w: number, h: number): void {
  // On mobile, use half-res internal buffer for performance
  const scale = isMobile ? 0.5 : 1.0;
  const bw = Math.floor(w * scale);
  const bh = Math.floor(h * scale);
  if (fbSrc && fbW === bw && fbH === bh) return;

  fbW = bw; fbH = bh;
  [fbSrc, srcCtx] = makeCanvas(bw, bh);
  [fbDst, dstCtx] = makeCanvas(bw, bh);

  // Start with black
  srcCtx!.fillStyle = '#000';
  srcCtx!.fillRect(0, 0, bw, bh);
  dstCtx!.fillStyle = '#000';
  dstCtx!.fillRect(0, 0, bw, bh);
}

/** Draw a glowing ring using additive ("lighter") compositing. */
function drawRing(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  radius: number,
  hue: number, brightness: number,
  baseWeight: number
): void {
  if (radius < 1 || brightness < 0.01) return;

  const passes = [
    { wMult: 6.0, alpha: 0.10 },
    { wMult: 2.5, alpha: 0.35 },
    { wMult: 1.0, alpha: 1.00 },
  ];

  for (const { wMult, alpha } of passes) {
    const a = Math.min(1, brightness * alpha);
    const r = Math.round(hsvR(hue, 100, 100) * 255);
    const g = Math.round(hsvG(hue, 100, 100) * 255);
    const b = Math.round(hsvB(hue, 100, 100) * 255);
    ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
    ctx.lineWidth = baseWeight * wMult;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
    ctx.stroke();
  }
}

// HSV helpers (h in [0,360], s/v in [0,100])
function hsvR(h: number, s: number, v: number): number {
  const k = (n: number) => (n + h / 60) % 6;
  return (v / 100) * (1 - (s / 100) * Math.max(0, Math.min(1, Math.min(k(5), 4 - k(5)))));
}
function hsvG(h: number, s: number, v: number): number {
  const k = (n: number) => (n + h / 60) % 6;
  return (v / 100) * (1 - (s / 100) * Math.max(0, Math.min(1, Math.min(k(3), 4 - k(3)))));
}
function hsvB(h: number, s: number, v: number): number {
  const k = (n: number) => (n + h / 60) % 6;
  return (v / 100) * (1 - (s / 100) * Math.max(0, Math.min(1, Math.min(k(1), 4 - k(1)))));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function resetFeedbackLoop(): void {
  // Wipe buffers to black so the new session starts clean
  if (srcCtx) { srcCtx.fillStyle = '#000'; srcCtx.fillRect(0, 0, fbW, fbH); }
  if (dstCtx) { dstCtx.fillStyle = '#000'; dstCtx.fillRect(0, 0, fbW, fbH); }
  hueShift = 0;
  lastBeatIndex = -1;
  beatFlash = 0;
}

export function drawFeedbackLoop(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;
  const minDim = Math.min(W, H);

  ensureBuffers(W, H);
  const dc = dstCtx!;
  const bx = fbW / 2;
  const by = fbH / 2;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.isPlaying && state.detectedBPM > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const bi = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      beatFlash = 1.0;
      hueShift = (hueShift + 37 + Math.random() * 18) % 360;
    }
  }
  beatFlash = Math.max(0, beatFlash - dt * 0.05);

  // ── Config ────────────────────────────────────────────────────────────────
  // Zoom: 0.90 (tight vortex) → 0.998 (very slow convergence)
  const zoomFactor = 0.90 + config.feedbackZoom * 0.098;
  // Spiral: 0 → 0.04 radians per frame (independent of dt)
  const spinAngle = config.feedbackSpiral * 0.04;
  const glowAmt = 0.3 + config.feedbackGlow * 1.2;

  const flashBright = 1.0 + beatFlash * 0.6;
  const anyTransient = transients.some(t => t > 1.2);

  // ── Step 1: Build new frame in dstCtx ────────────────────────────────────

  // Fill destination with black (background beneath the scaled copy)
  dc.globalCompositeOperation = 'source-over';
  dc.globalAlpha = 1.0;
  dc.fillStyle = '#000000';
  dc.fillRect(0, 0, fbW, fbH);

  // Draw source (previous frame) scaled + rotated → creates feedback convergence
  dc.save();
  dc.globalAlpha = 0.96;  // slight fade so content eventually decays
  dc.globalCompositeOperation = 'source-over';
  dc.translate(bx, by);
  dc.rotate(spinAngle);
  dc.scale(zoomFactor, zoomFactor);
  dc.translate(-bx, -by);
  dc.drawImage(fbSrc as CanvasImageSource, 0, 0);
  dc.restore();
  dc.globalAlpha = 1.0;

  // ── Step 2: Draw fresh audio rings onto destination ───────────────────────

  dc.globalCompositeOperation = 'lighter';  // additive for glow

  // Max ring radius = 45% of shorter dimension, divided among 7 bands
  const maxR = minDim * 0.5 * (fbW / W);  // scale to buffer coords

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.02) continue;

    // Each band gets a radial "slot" — sub-bass at outermost, brilliance near center
    const slotFrac = (BAND_COUNT - b) / BAND_COUNT;  // 1.0 → 1/7
    const baseR = slotFrac * maxR;
    // Amplitude modulates radius ±10% within the slot
    const radius = baseR * (0.90 + amp * 0.15);

    const hue = (BAND_HUES[b] + hueShift) % 360;
    const bright = amp * flashBright * (anyTransient ? 1.3 : 1.0);
    const weight = (1.5 + amp * 6 * glowAmt) * (fbW / W);

    drawRing(dc, bx, by, radius, hue, bright, weight);
  }

  // Central glow pulse on beat
  if (beatFlash > 0.1) {
    const gr = dc.createRadialGradient(bx, by, 0, bx, by, maxR * 0.25 * beatFlash);
    gr.addColorStop(0, `rgba(255,255,255,${beatFlash * 0.5})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    dc.globalCompositeOperation = 'lighter';
    dc.fillStyle = gr;
    dc.beginPath();
    dc.arc(bx, by, maxR * 0.25 * beatFlash, 0, Math.PI * 2);
    dc.fill();
  }

  dc.globalCompositeOperation = 'source-over';

  // ── Step 3: Blit dstCtx to main p5 canvas ────────────────────────────────
  p.background(0);
  const mainCtx = p.drawingContext as unknown as CanvasRenderingContext2D;
  mainCtx.drawImage(fbDst as CanvasImageSource, 0, 0, W, H);

  // Slight overall flash on beat (drawn on main canvas)
  if (beatFlash > 0.05) {
    mainCtx.globalCompositeOperation = 'lighter';
    mainCtx.globalAlpha = beatFlash * 0.12;
    mainCtx.fillStyle = `hsl(${(hueShift + 30) % 360}, 80%, 60%)`;
    mainCtx.fillRect(0, 0, W, H);
    mainCtx.globalAlpha = 1.0;
    mainCtx.globalCompositeOperation = 'source-over';
  }

  // ── Step 4: Swap buffers — dstCtx becomes srcCtx for next frame ──────────
  const tmpCanvas = fbSrc;
  const tmpCtx   = srcCtx;
  fbSrc = fbDst;
  srcCtx = dstCtx;
  fbDst = tmpCanvas;
  dstCtx = tmpCtx;

}
