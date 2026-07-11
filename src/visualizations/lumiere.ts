/**
 * Lumière — audio-reactive laser scan beams with reversal nodes.
 *
 * Inspired by Robert Henke's "Lumière" laser performance series
 * (Unsound Festival, Kraków 2013 — ongoing tours):
 * https://roberthenke.com/concerts/lumiere.html
 *
 * Henke controls a bank of high-power laser projectors in precise
 * synchrony with his electronic score. The visual language is austere:
 * combinations of primary geometric symbols — lines, circles, dots —
 * combined and permuted until complexity emerges from simplicity.
 * Hardware artefacts (mirror inertia, dwell time at reversal points,
 * phosphor persistence) are embraced as aesthetic features rather
 * than corrected away.
 *
 * N ultra-thin horizontal scan beams span the full canvas width; each
 * oscillates sinusoidally with amplitude driven by its frequency band.
 * Every beam is assigned a unique spatial frequency so adjacent beams
 * create interference-like moiré patterns. "Reversal nodes" — bright
 * glowing points at each wave peak/trough, where a real laser mirror
 * would dwell longest before reversing direction — punctuate the scan
 * lines with luminous hot-spots. Three-pass additive glow renders
 * each beam as a phosphor-lit neon needle on a pure black field.
 * Beats fire a brightness surge and shift the hue palette.
 *
 * Sliders
 *   Lines — scan beam count (4–48; fewer = dramatic, more = dense field)
 *   Drift — wave animation speed (0 = near-static standing waves,
 *           1 = fast-flowing river of light)
 *   Glow  — phosphor bloom intensity and trail persistence
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Per-band hues: violet → blue → teal → green → yellow → orange → red
const BAND_HUES = [280, 240, 175, 130, 75, 35, 5];

// Distinct spatial frequencies (cycles per canvas width) — chosen to avoid
// simple integer ratios so adjacent beams create rich interference patterns.
const SPATIAL_FREQS = [0.8, 1.3, 1.8, 2.3, 2.8, 3.3, 3.8];

const SEGS     = isMobile ? 60 : 120;  // sine spine resolution
const MAX_LINES = isMobile ? 24 : 48;

// ── Module state ─────────────────────────────────────────────────────────────
let time        = 0;
let hueShift    = 0;
let beatFlash   = 0;
let lastBeatIdx = -1;

// Reusable segment buffers (avoids per-frame allocation)
const _px = new Float32Array(SEGS + 1);
const _py = new Float32Array(SEGS + 1);

// ── Reset ────────────────────────────────────────────────────────────────────
export function resetLumiere(): void {
  time        = 0;
  hueShift    = 0;
  beatFlash   = 0;
  lastBeatIdx = -1;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function hsla(h: number, s: number, l: number, a: number): string {
  return `hsla(${((h % 360) + 360) % 360},${s.toFixed(0)}%,${l.toFixed(0)}%,${a.toFixed(3)})`;
}

// ── Draw ─────────────────────────────────────────────────────────────────────
export function drawLumiere(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const N     = Math.max(4, Math.min(MAX_LINES, Math.round(config.lumiereLines)));
  const drift = config.lumiereDrift;   // 0–1
  const glow  = config.lumiereGlow;   // 0–1

  // ── Beat detection ─────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      beatFlash   = 1.0;
      // Shift global hue palette slightly on each beat
      hueShift    = (hueShift + 42) % 360;
    }
  }

  time      += dt * (0.004 + drift * 0.028);
  beatFlash *= Math.pow(0.88, dt);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  const W   = p.width;
  const H   = p.height;

  // ── Phosphor persistence / background fade ─────────────────────────────────
  // High glow = slower fade = longer trail. Must use source-over so the black
  // overlay dims rather than additively adds.
  ctx.globalCompositeOperation = 'source-over';
  const fadeAlpha = 0.12 + (1 - glow) * 0.30;
  ctx.fillStyle = `rgba(0,0,0,${fadeAlpha.toFixed(3)})`;
  ctx.fillRect(0, 0, W, H);

  // Beat brightness surge
  if (beatFlash > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${(beatFlash * 0.10).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  // ── Render beams with additive blending ────────────────────────────────────
  ctx.globalCompositeOperation = 'lighter';

  // Distribute N beams with a top/bottom margin equal to half the inter-beam gap
  const spacing = H / (N + 1);
  // Max displacement: 45 % of spacing prevents beams crossing their neighbors
  const maxDisp = spacing * 0.45;

  for (let i = 0; i < N; i++) {
    const t       = N > 1 ? i / (N - 1) : 0.5;
    const bandIdx = Math.min(BAND_COUNT - 1, Math.floor(t * BAND_COUNT));
    const amp     = amps[bandIdx];
    const sf      = SPATIAL_FREQS[i % SPATIAL_FREQS.length];
    const hue     = (BAND_HUES[bandIdx] + hueShift) % 360;

    // Baseline Y — margin + even step
    const y0 = spacing * (i + 1);

    // Phase base: drifts over time; slight per-line multiplier staggers drift
    // rates so beams slowly de-synchronize and re-synchronize (moiré effect)
    const phaseBase = time * (1.0 + (i % 3) * 0.12) + i * 1.1;

    // ── Compute sine spine ─────────────────────────────────────────────────
    for (let s = 0; s <= SEGS; s++) {
      const x     = (s / SEGS) * W;
      const phase = (x / W) * Math.PI * 2 * sf + phaseBase;
      _px[s] = x;
      _py[s] = y0 + Math.sin(phase) * amp * maxDisp;
    }

    // ── 3-pass phosphor glow ───────────────────────────────────────────────
    const lw     = 1.0 + glow * 1.5;
    const bright = 0.28 + amp * 0.72;

    // Pass 1: wide dim outer halo
    ctx.lineWidth   = lw * 5.0;
    ctx.strokeStyle = hsla(hue, 90, 55, 0.05 + glow * 0.05);
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'butt';
    ctx.beginPath();
    ctx.moveTo(_px[0], _py[0]);
    for (let s = 1; s <= SEGS; s++) ctx.lineTo(_px[s], _py[s]);
    ctx.stroke();

    // Pass 2: medium mid bloom
    ctx.lineWidth   = lw * 2.0;
    ctx.strokeStyle = hsla(hue, 80, 65, 0.12 + glow * 0.10);
    ctx.beginPath();
    ctx.moveTo(_px[0], _py[0]);
    for (let s = 1; s <= SEGS; s++) ctx.lineTo(_px[s], _py[s]);
    ctx.stroke();

    // Pass 3: thin bright core
    ctx.lineWidth   = lw * 0.6;
    ctx.strokeStyle = hsla(hue, 55, 92, bright);
    ctx.beginPath();
    ctx.moveTo(_px[0], _py[0]);
    for (let s = 1; s <= SEGS; s++) ctx.lineTo(_px[s], _py[s]);
    ctx.stroke();

    // ── Reversal nodes (mirror-dwell hot-spots) ────────────────────────────
    // A real laser mirror dwells longest at each wave peak/trough before
    // reversing direction; these "knots" are brighter in practice.
    // Peaks of sin(phase(x)) = ±1 at phase = π/2 + n·π
    //   x_n = W · (0.5 + n − phaseBase/π) / (2·sf)
    if (amp > 0.05) {
      const phNormHalf = phaseBase / Math.PI;
      const nMin       = Math.ceil(phNormHalf - 0.5);
      const nMax       = Math.floor(phNormHalf - 0.5 + 2 * sf);
      const nodeR      = (2.0 + amp * 4.5 + glow * 2.0) * (isMobile ? 0.7 : 1.0);
      const nodeAlpha  = amp * (0.5 + glow * 0.5);

      for (let n = nMin; n <= nMax; n++) {
        const xp = W * (0.5 + n - phNormHalf) / (2 * sf);
        if (xp < 0 || xp > W) continue;

        const phAtPeak  = (xp / W) * Math.PI * 2 * sf + phaseBase;
        const sinAtPeak = Math.sin(phAtPeak);
        const yp        = y0 + sinAtPeak * amp * maxDisp;

        // Outer bloom
        ctx.fillStyle = hsla(hue, 80, 62, nodeAlpha * 0.25 * glow);
        ctx.beginPath();
        ctx.arc(xp, yp, nodeR * 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Inner glow
        ctx.fillStyle = hsla(hue, 90, 75, nodeAlpha * 0.55);
        ctx.beginPath();
        ctx.arc(xp, yp, nodeR * 1.2, 0, Math.PI * 2);
        ctx.fill();

        // Hot core
        ctx.fillStyle = hsla(hue, 40, 96, nodeAlpha * 0.88);
        ctx.beginPath();
        ctx.arc(xp, yp, nodeR * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Restore default compositing for subsequent p5.js operations
  ctx.globalCompositeOperation = 'source-over';
}
