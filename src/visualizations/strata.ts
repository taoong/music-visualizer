/**
 * Strata — Audio-reactive geological stratum visualizer.
 *
 * 7 layered rock strata fill the canvas from deep earth (sub-bass, bottom)
 * to crystalline surface (brilliance, top). Each stratum's thickness and
 * luminosity responds to its frequency band; sinusoidal boundary curves
 * undulate with audio energy; a seismic shudder ripples through all layers
 * on every beat.
 *
 * Inspired by Quayola "Strata #1" (2025) — a site-specific LED installation
 * at Palazzo Citterio, Milan, where computational algorithms dissolve
 * Baroque visual codes — forms, colors, geometries — into abstract layered
 * configurations akin to geological cross-sections.
 * https://palazzocitterio.org/en/news/event/quayola-strata-1/
 *
 * Sliders:
 *   Density  (strataDensity)  — scan-line grain; low=coarse sediment, high=fine crystal
 *   Swell    (strataSwell)    — how much each stratum breathes with its band's amplitude
 *   Hue      (strataHue)      — rotates the geological palette across the full spectrum
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Geological HSL palette: bottom (sub-bass) → top (brilliance) ─────────────
// Deep basalt → burnt sienna → amber → slate green → steel teal → blue → ice
const BASE_HUE = [350, 16, 36, 118, 186, 212, 198];
const BASE_SAT = [ 65, 72, 62,  42,  52,  58,  18];
const BASE_LIT = [ 10, 20, 32,  26,  34,  42,  76];

// ── Rendering constants ───────────────────────────────────────────────────────
const N_PTS = isMobile ? 32 : 64;   // boundary curve sample points

// ── Module state ──────────────────────────────────────────────────────────────
let t       = 0;
let lastBeat = -1;
let beatPulse = 0;
const smoothH = new Float32Array(BAND_COUNT);
let initH     = 0;          // canvas height at last init

export function resetStrata(): void {
  t         = 0;
  lastBeat  = -1;
  beatPulse = 0;
  initH     = 0;            // force re-init on next draw
}

// ── Draw ──────────────────────────────────────────────────────────────────────
export function drawStrata(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const w = p.width;
  const h = p.height;

  if (h !== initH) {
    smoothH.fill(h / BAND_COUNT);
    initH = h;
  }

  // Advance animation clock
  t += 0.007 * dt;

  // ── Beat detection ────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const bi       = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeat) {
      lastBeat  = bi;
      beatPulse = 1.0;
    }
  }
  beatPulse *= Math.pow(0.82, dt);

  // ── Slider parameters ─────────────────────────────────────────────────────
  const density  = 0.5 + config.strataDensity * 3.5;   // 0.5–4.0
  const swellAmt = config.strataSwell;                   // 0–1
  const hueOff   = config.strataHue * 360;              // 0–360°

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.globalAlpha = 1.0;
  ctx.globalCompositeOperation = 'source-over';

  // Background
  ctx.fillStyle = 'rgb(5, 4, 7)';
  ctx.fillRect(0, 0, w, h);

  // ── Dynamic stratum heights ───────────────────────────────────────────────
  // Each band's stratum swells in proportion to its amplitude.
  const baseH = h / BAND_COUNT;
  const sf    = 0.09 * dt;         // smoothing speed
  let total   = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    const target = baseH * (1 + amps[b] * swellAmt * 3.0);
    smoothH[b] += (target - smoothH[b]) * sf;
    total       += smoothH[b];
  }
  const normScale = h / total;     // keep all strata inside the canvas

  // boundaries[0] = h (canvas bottom), boundaries[BAND_COUNT] ≈ 0 (top)
  const boundaries = new Float32Array(BAND_COUNT + 1);
  boundaries[0] = h;
  for (let b = 0; b < BAND_COUNT; b++) {
    boundaries[b + 1] = boundaries[b] - smoothH[b] * normScale;
  }

  // ── Precompute shared boundary curves ────────────────────────────────────
  // lines[b] = Y values along the boundary between strata b-1 (below) and b (above)
  const lines: Float32Array[] = [];
  for (let b = 0; b <= BAND_COUNT; b++) {
    const pts   = new Float32Array(N_PTS + 1);
    const baseY = boundaries[b];

    // Boundary wave amplitude: zero at canvas edges, max at the middle bands
    const edge  = Math.sin((b / BAND_COUNT) * Math.PI);
    const ampL  = b > 0          ? amps[b - 1] : 0;
    const ampH  = b < BAND_COUNT ? amps[b]     : 0;
    const avgAmp = (ampL + ampH) * 0.5;
    const wA    = baseH * 0.09 * (0.2 + avgAmp * 0.8) * edge
                + beatPulse * baseH * 0.045 * edge;

    for (let i = 0; i <= N_PTS; i++) {
      const nx = i / N_PTS;
      const w1 = Math.sin(nx * Math.PI * 2 * (1.4 + b * 0.22) + t + b * 1.05);
      const w2 = Math.sin(nx * Math.PI * 2 * (2.6 + b * 0.14) - t * 0.71 + b * 0.63) * 0.42;
      pts[i]   = baseY + wA * (w1 + w2);
    }
    lines.push(pts);
  }

  // ── Render each stratum ───────────────────────────────────────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    const amp    = amps[b];
    const topLn  = lines[b + 1];   // smaller Y (higher on screen)
    const botLn  = lines[b];       // larger Y (lower on screen)
    const stratH = boundaries[b] - boundaries[b + 1];

    // Colour: geological base shifted by amplitude and hue slider
    const hue = (BASE_HUE[b] + hueOff) % 360;
    const sat = Math.min(100, BASE_SAT[b] + amp * 35);
    const lit = Math.min(90,  BASE_LIT[b] + amp * 30);

    // ── Fill polygon ────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(0, topLn[0]);
    for (let i = 1; i <= N_PTS; i++) ctx.lineTo((i / N_PTS) * w, topLn[i]);
    for (let i = N_PTS; i >= 0; i--) ctx.lineTo((i / N_PTS) * w, botLn[i]);
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue}, ${sat}%, ${lit}%)`;
    ctx.fill();

    // ── Scan-lines (clipped to stratum polygon, coarser at bottom) ─────────
    ctx.save();
    ctx.clip();
    // Higher bands → finer grain (smaller step)
    const lineStep = Math.max(1.2, (13 - b * 1.5) / density);
    const scanLit  = Math.min(100, lit + 20 + amp * 12);
    ctx.strokeStyle = `hsl(${hue}, ${Math.max(0, sat - 20)}%, ${scanLit}%)`;
    ctx.globalAlpha = 0.18 + amp * 0.22;
    ctx.lineWidth   = 0.6;
    ctx.beginPath();
    // Extend slightly beyond stratum bounds so clip edges are always covered
    for (let ly = boundaries[b + 1] - 24; ly <= boundaries[b] + 24; ly += lineStep) {
      ctx.moveTo(0, ly);
      ctx.lineTo(w, ly);
    }
    ctx.stroke();
    ctx.restore();

    // ── Glow on loud bands ──────────────────────────────────────────────────
    if (amp > 0.12) {
      const gs   = (amp - 0.12) / 0.88;
      const ga   = gs * 0.30;
      const topY = boundaries[b + 1];
      const grad = ctx.createLinearGradient(0, topY, 0, topY + stratH);
      grad.addColorStop(0,    `hsla(${hue},100%,78%,0)`);
      grad.addColorStop(0.25, `hsla(${hue},100%,78%,${ga})`);
      grad.addColorStop(0.75, `hsla(${hue},100%,78%,${ga})`);
      grad.addColorStop(1,    `hsla(${hue},100%,78%,0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle   = grad;
      ctx.fillRect(0, topY, w, stratH);
    }
  }

  // ── Seismic beat flash ────────────────────────────────────────────────────
  if (beatPulse > 0.06) {
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = beatPulse * 0.07;
    ctx.fillStyle   = 'rgba(255,255,255,1)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
  }
}
