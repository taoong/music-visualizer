/**
 * Ribbons — sinuous luminous silk-ribbon strands
 *
 * N ribbon strands float horizontally across the canvas, each driven by a
 * frequency band.  Amplitude scales oscillation height; beats fire a
 * traveling snap-wave along the ribbon.  A horizontal canvas gradient fills
 * each ribbon with iridescent thin-film hues that ripple along the strand.
 *
 * Inspired by teamLab "Light Sculpture – Flow" series (2024)
 * https://www.teamlab.art
 *
 * Sliders
 *   Ribbons  — strand count (2–12)
 *   Wave     — oscillation density / amplitude (0.2–4)
 *   Shimmer  — iridescent hue-shift intensity (0–1)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Spine resolution — number of segments per ribbon
const SEGS = isMobile ? 40 : 80;

// Per-band base hues: violet → blue → teal → green → yellow → orange → red
const BAND_HUES = [280, 240, 175, 130, 75, 35, 5];

// Golden-angle increment for staggering ribbon phases
const PHI = 2.399963; // 2π / φ²

// ── module-scoped buffers (no per-frame allocation) ──────────────────────────
const _sx = new Float32Array(SEGS + 1);
const _sy = new Float32Array(SEGS + 1);
const _nx = new Float32Array(SEGS + 1);
const _ny = new Float32Array(SEGS + 1);
const _hw = new Float32Array(SEGS + 1);

// ── module-scoped state ──────────────────────────────────────────────────────
let time = 0;
const snapAmp   = new Float32Array(BAND_COUNT); // decaying beat-snap amplitude
const snapPhase = new Float32Array(BAND_COUNT); // traveling snap-wave phase
let lastBeatIndex = -1;

// ── helpers ──────────────────────────────────────────────────────────────────
/** Convert HSB (0–360, 0–100, 0–100) + alpha (0–1) to CSS rgba string. */
function hsba(h: number, s: number, b: number, a: number): string {
  const sn = s / 100;
  const bn = b / 100;
  const c  = bn * sn;
  const hh = ((h % 360) + 360) % 360;
  const x  = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m  = bn - c;
  let r = 0, g = 0, bv = 0;
  if      (hh < 60)  { r = c;  g = x;  bv = 0; }
  else if (hh < 120) { r = x;  g = c;  bv = 0; }
  else if (hh < 180) { r = 0;  g = c;  bv = x; }
  else if (hh < 240) { r = 0;  g = x;  bv = c; }
  else if (hh < 300) { r = x;  g = 0;  bv = c; }
  else               { r = c;  g = 0;  bv = x; }
  return `rgba(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((bv + m) * 255)},${a.toFixed(3)})`;
}

// ── reset ────────────────────────────────────────────────────────────────────
export function resetRibbons(): void {
  time = 0;
  snapAmp.fill(0);
  snapPhase.fill(0);
  lastBeatIndex = -1;
}

// ── draw ─────────────────────────────────────────────────────────────────────
export function drawRibbons(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const count   = Math.max(2, Math.min(isMobile ? 8 : 12, Math.round(config.ribbonsCount)));
  const wave    = config.ribbonsWave;    // 0.2–4.0
  const shimmer = config.ribbonsShimmer; // 0–1

  // ── beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIndex) {
      lastBeatIndex = bi;
      for (let b = 0; b < BAND_COUNT; b++) {
        snapAmp[b]   = 0.5 + amps[b] * 0.5;
        snapPhase[b] = 0;
      }
    }
  }

  // Advance time and snap decay
  time += dt * 0.012;
  for (let b = 0; b < BAND_COUNT; b++) {
    snapPhase[b] += dt * 0.15;
    snapAmp[b]   *= Math.pow(0.91, dt);
    if (snapAmp[b] < 0.002) snapAmp[b] = 0;
  }

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  const W   = p.width;
  const H   = p.height;
  const cy  = H / 2;

  // ── background fade ───────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(0,0,0,0.075)';
  ctx.fillRect(0, 0, W, H);

  // Vertical spacing between ribbon centre-lines (fill 72 % of canvas height)
  const spacing = count === 1 ? 0 : (H * 0.72) / (count - 1);

  // Beat flash: brief white glaze on the frame a beat lands
  let maxSnap = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    if (snapAmp[b] > maxSnap) maxSnap = snapAmp[b];
  }
  if (maxSnap > 0.6) {
    ctx.fillStyle = `rgba(255,255,255,${((maxSnap - 0.6) * 0.14).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // Glow passes: [width-multiplier, alpha, sat-factor, bri-factor]
  const passes: [number, number, number, number][] = [
    [3.8, 0.08, 0.50, 0.68],  // outer halo
    [2.0, 0.20, 0.78, 0.86],  // mid body
    [0.9, 0.70, 1.00, 1.00],  // bright core
  ];

  const STOPS = 14; // gradient colour stops per ribbon

  // ── draw each ribbon ──────────────────────────────────────────────────────
  for (let ri = 0; ri < count; ri++) {
    const bIdx    = ri % BAND_COUNT;
    const amp     = amps[bIdx];
    const baseHue = BAND_HUES[bIdx];
    const phOff   = ri * PHI; // unique phase per ribbon (golden angle)

    // Vertical centre-line for this ribbon
    const rowY = cy - ((count - 1) * spacing) / 2 + ri * spacing;

    // ── compute spine ─────────────────────────────────────────────────────
    const wc = wave * 2.5; // oscillation cycles across canvas width

    for (let s = 0; s <= SEGS; s++) {
      const t = s / SEGS;

      // Primary audio-driven oscillation
      const y0 = Math.sin(t * Math.PI * 2 * wc + time * 1.1 + phOff)
                 * amp * H * 0.13;
      // Secondary overtone (golden-ratio harmonic)
      const y1 = Math.sin(t * Math.PI * 2 * (wc * 1.618) + time * 0.65 + phOff * 1.4)
                 * amp * H * 0.055;
      // Ambient drift — present even at silence
      const yd = Math.sin(t * Math.PI * 2 * 1.3 + time * 0.3 + phOff * 0.7)
                 * H * 0.018;
      // Beat snap wave traveling left → right
      const ys = snapAmp[bIdx] * H * 0.09
                 * Math.sin(t * Math.PI * 8 - snapPhase[bIdx] * 5.5);

      _sx[s] = t * W;
      _sy[s] = rowY + y0 + y1 + yd + ys;
    }

    // ── compute unit normals (perpendicular to tangent) ───────────────────
    for (let s = 0; s <= SEGS; s++) {
      let tx: number, ty: number;
      if (s === 0) {
        tx = _sx[1] - _sx[0];       ty = _sy[1] - _sy[0];
      } else if (s === SEGS) {
        tx = _sx[SEGS] - _sx[SEGS - 1]; ty = _sy[SEGS] - _sy[SEGS - 1];
      } else {
        tx = _sx[s + 1] - _sx[s - 1]; ty = _sy[s + 1] - _sy[s - 1];
      }
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      _nx[s] = -ty / len;
      _ny[s] =  tx / len;
    }

    // ── half-width profile: thin tips, fat centre (bell curve) ────────────
    const maxHW = (isMobile ? 14 : 22) * (1 + amp * 1.6);
    for (let s = 0; s <= SEGS; s++) {
      _hw[s] = maxHW * Math.sin((s / SEGS) * Math.PI);
    }

    // ── 3-pass glow render ─────────────────────────────────────────────────
    const sat0 = 65 + amp * 30;
    const bri0 = 78 + amp * 20;

    for (const [wm, baseAlpha, satF, briF] of passes) {
      const sat = satF * sat0;
      const bri = briF * bri0;
      const al  = baseAlpha * (1 + amp * 0.5);

      // Build iridescent horizontal gradient (hue oscillates along ribbon)
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      for (let si = 0; si <= STOPS; si++) {
        const t      = si / STOPS;
        const hShift = shimmer * 72 * Math.sin(t * Math.PI * 5 + time * 0.85 + phOff * 0.5);
        const hue    = ((baseHue + hShift) % 360 + 360) % 360;
        grad.addColorStop(t, hsba(hue, sat, bri, al));
      }
      ctx.fillStyle = grad;

      // Draw ribbon polygon: top edge L→R, bottom edge R→L
      ctx.beginPath();
      ctx.moveTo(_sx[0] + _nx[0] * _hw[0] * wm, _sy[0] + _ny[0] * _hw[0] * wm);
      for (let s = 1; s <= SEGS; s++) {
        ctx.lineTo(_sx[s] + _nx[s] * _hw[s] * wm, _sy[s] + _ny[s] * _hw[s] * wm);
      }
      for (let s = SEGS; s >= 0; s--) {
        ctx.lineTo(_sx[s] - _nx[s] * _hw[s] * wm, _sy[s] - _ny[s] * _hw[s] * wm);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // Restore p5.js expected fill state
  ctx.fillStyle = '#000000';
}
