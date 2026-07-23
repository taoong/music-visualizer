/**
 * Plaid: audio-reactive luminous tartan/plaid weave.
 *
 * Inspired by Sean Scully's "Plaid" paintings (1974) — the Irish-American abstract
 * painter known for his sustained investigation of crossing horizontal and vertical
 * bands of colour. Scully's band paintings bridge the systematic and the emotional,
 * using hard-edge geometry to produce surprisingly warm canvases.
 * https://www.seanscully.com/
 *
 * Seven frequency bands each own a thread-colour in a repeating sett (the tartan
 * "recipe"). Band amplitude drives thread width: sub-bass swells the deep violet
 * horizontals, brilliance fattens the red verticals, and everything in between
 * pulses in proportion. Canvas API additive blending makes thread crossings glow
 * brighter than either parent thread, producing a luminous grid of mixed colours
 * that changes character with every bar of the music. Beat fires a global
 * brightness surge that momentarily saturates all crossings to white.
 *
 * Sliders
 *   Scale — base thread width (fine weave ↔ bold tartan slabs)
 *   Weave — horizontal vs vertical thread dominance (H only ↔ equal ↔ V only)
 *   Hue   — palette rotation; shifts all thread hues around the colour wheel
 */

import { store }           from '../state/store';
import { audioEngine }     from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Base HSL hue per band, sub-bass (violet) → brilliance (red)
const BASE_HUES = [270, 230, 195, 145, 75, 30, 355];

// Relative thickness bias per band so all bands are visually legible at mid amplitude
const THICK_BIAS = [1.15, 1.05, 1.0, 1.0, 1.0, 1.05, 1.10];

let lastBeatIndex = -1;
let beatPulse     = 0;
let huePhase      = 0; // slow autonomous palette drift

export function resetPlaid(): void {
  lastBeatIndex = -1;
  beatPulse     = 0;
  huePhase      = 0;
}

export function drawPlaid(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;

  const { amps: bands } = getBandAverages(BAND_COUNT);

  const cfg     = store.config;
  const scale   = cfg.plaidScale  ?? 0.5;  // 0–1
  const weave   = cfg.plaidWeave  ?? 0.5;  // 0=H only, 0.5=equal, 1=V only
  const hueRot  = cfg.plaidHue    ?? 0;    // 0–1

  // Beat detection
  const { beatIntervalSec, beatOffset } = store.state;
  if (beatIntervalSec > 0) {
    const pos       = audioEngine.getPlaybackPosition();
    const beatIndex = Math.floor((pos - beatOffset) / beatIntervalSec);
    if (beatIndex !== lastBeatIndex && lastBeatIndex >= 0) {
      beatPulse = 1.0;
    }
    lastBeatIndex = beatIndex;
  }
  beatPulse *= Math.pow(0.87, dt);

  // Slow autonomous hue drift (independent of audio)
  huePhase = (huePhase + dt * 0.003) % 360;

  // Background: near-black indigo
  p.background(4, 3, 12);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.save();

  // Base thread width – larger canvas dimension gives thicker threads on desktop
  const minDim = Math.min(W, H);
  const baseW  = minDim * (isMobile ? 0.045 : 0.038) * (0.4 + scale * 2.2);

  // Per-band thread widths driven by amplitude
  const widths: number[] = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    widths[i] = baseW * THICK_BIAS[i] * (0.28 + bands[i] * 1.55 + beatPulse * 0.45);
  }

  const settSize = widths.reduce((s, w) => s + w, 0);
  if (settSize < 1) { ctx.restore(); return; }

  // Per-channel alpha from weave slider
  // weave 0 → alphaH=0.70, alphaV=0
  // weave 0.5 → both 0.62
  // weave 1 → alphaH=0, alphaV=0.70
  const alphaH = weave <= 0.5
    ? 0.62 + (0.5 - weave) * 0.16
    : 0.62 * (1 - (weave - 0.5) * 2);
  const alphaV = weave >= 0.5
    ? 0.62 + (weave - 0.5) * 0.16
    : 0.62 * weave * 2;

  ctx.globalCompositeOperation = 'lighter'; // additive — crossings add colours

  // Draw horizontal strips (tile from top to bottom)
  if (alphaH > 0.005) {
    let y = 0;
    let guard = 0;
    while (y < H + settSize && guard < 60) {
      for (let i = 0; i < BAND_COUNT; i++) {
        const tw  = widths[i];
        const hue = (BASE_HUES[i] + hueRot * 360 + huePhase) % 360;
        const sat = 78 + bands[i] * 22;
        const litC = 18 + bands[i] * 38 + beatPulse * 22; // centre lightness
        const litE = litC * 0.18;                           // edge (near 0)

        const grad = ctx.createLinearGradient(0, y, 0, y + tw);
        grad.addColorStop(0,    `hsla(${hue},${sat}%,${litE.toFixed(1)}%,0)`);
        grad.addColorStop(0.22, `hsla(${hue},${sat}%,${litC.toFixed(1)}%,${alphaH.toFixed(3)})`);
        grad.addColorStop(0.50, `hsla(${hue},${sat}%,${Math.min(litC * 1.22, 92).toFixed(1)}%,${alphaH.toFixed(3)})`);
        grad.addColorStop(0.78, `hsla(${hue},${sat}%,${litC.toFixed(1)}%,${alphaH.toFixed(3)})`);
        grad.addColorStop(1,    `hsla(${hue},${sat}%,${litE.toFixed(1)}%,0)`);

        ctx.fillStyle = grad;
        ctx.fillRect(0, y, W, tw);
        y += tw;
      }
      guard++;
    }
  }

  // Draw vertical strips (tile from left to right)
  if (alphaV > 0.005) {
    let x = 0;
    let guard = 0;
    while (x < W + settSize && guard < 60) {
      for (let i = 0; i < BAND_COUNT; i++) {
        const tw  = widths[i];
        const hue = (BASE_HUES[i] + hueRot * 360 + huePhase) % 360;
        const sat = 78 + bands[i] * 22;
        const litC = 18 + bands[i] * 38 + beatPulse * 22;
        const litE = litC * 0.18;

        const grad = ctx.createLinearGradient(x, 0, x + tw, 0);
        grad.addColorStop(0,    `hsla(${hue},${sat}%,${litE.toFixed(1)}%,0)`);
        grad.addColorStop(0.22, `hsla(${hue},${sat}%,${litC.toFixed(1)}%,${alphaV.toFixed(3)})`);
        grad.addColorStop(0.50, `hsla(${hue},${sat}%,${Math.min(litC * 1.22, 92).toFixed(1)}%,${alphaV.toFixed(3)})`);
        grad.addColorStop(0.78, `hsla(${hue},${sat}%,${litC.toFixed(1)}%,${alphaV.toFixed(3)})`);
        grad.addColorStop(1,    `hsla(${hue},${sat}%,${litE.toFixed(1)}%,0)`);

        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, tw, H);
        x += tw;
      }
      guard++;
    }
  }

  // Beat flash: brief white veil over entire canvas
  if (beatPulse > 0.02) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(255,255,255,${(beatPulse * 0.07).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.restore();
}
