/**
 * Delaunay — Simultaneous-contrast concentric colour rings.
 *
 * Inspired by Sonia Delaunay, "Prismes Électriques" (Electric Prisms), 1914,
 * oil on canvas, 250×250 cm, Centre Pompidou, Paris. Orphism / Simultaneism.
 * https://www.wikiart.org/en/sonia-delaunay/electric-prisms-1
 *
 * 7 concentric ring-bands (one per frequency band) are divided into N sectors
 * that alternate between a hue and its chromatic complement — replicating
 * Delaunay's "simultaneous contrast" principle, where adjacent complementary
 * colours appear to vibrate at their shared edges. Each ring counter-rotates
 * relative to its neighbours; bass rings drift slowly, treble rings spin fast.
 * Beat detection fires a global hue-palette shift and brightness flash.
 *
 * Sliders
 *   Sectors  — arc divisions per ring (3–12)
 *   Spin     — rotation speed multiplier
 *   Contrast — ring boundary edge brightness (simultaneous-contrast shimmer)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const TWO_PI = Math.PI * 2;

// Primary HSL hue per band (sub-bass→brilliance) — Delaunay's electric palette
const BAND_HUES = [288, 232, 185, 130, 68, 32, 4];

// Relative rotation speed per band: outer bass rings slow, inner treble rings fast
const SPEED_RATIOS = [0.28, 0.44, 0.60, 0.80, 1.00, 1.28, 1.58];

let angles: number[] = new Array(BAND_COUNT).fill(0);
let lastBeatIndex = -1;
let hueShift = 0;
let flashBright = 0;

export function resetDelaunay(): void {
  angles = new Array(BAND_COUNT).fill(0);
  lastBeatIndex = -1;
  hueShift = 0;
  flashBright = 0;
}

export function drawDelaunay(p: P5Instance, dt: number): void {
  const W = p.width;
  const H = p.height;
  const cx = W / 2;
  const cy = H / 2;
  const minDim = Math.min(W, H);

  const { amps: bands } = getBandAverages(BAND_COUNT);
  const totalAmp = bands.reduce((s, v) => s + v, 0) / BAND_COUNT;

  const cfg = store.config;
  const sectorCount  = Math.max(3, Math.round(cfg.delaunaySectors ?? 6));
  const spinSpeed    = cfg.delaunaySpin     ?? 0.4;
  const contrastAmt  = cfg.delaunayContrast ?? 0.6;

  // Beat detection
  const { beatIntervalSec, beatOffset } = store.state;
  if (beatIntervalSec > 0) {
    const pos = audioEngine.getPlaybackPosition();
    const beatIndex = Math.floor((pos - beatOffset) / beatIntervalSec);
    if (beatIndex !== lastBeatIndex && lastBeatIndex >= 0) {
      hueShift    = (hueShift + 45) % 360;
      flashBright = 1.0;
    }
    lastBeatIndex = beatIndex;
  }

  flashBright *= Math.pow(0.87, dt);

  // Advance ring angles — alternating CW / CCW, amplitude-modulated
  for (let i = 0; i < BAND_COUNT; i++) {
    const dir   = i % 2 === 0 ? 1 : -1;
    const speed = SPEED_RATIOS[i] * spinSpeed * (0.35 + totalAmp * 0.5 + bands[i] * 0.45);
    angles[i]   = (angles[i] + dir * speed * dt * 0.013) % TWO_PI;
  }

  // Background: deep indigo-black
  p.background(11, 8, 20);

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx.save();

  const scale    = isMobile ? 0.44 : 0.46;
  const outerR   = minDim * scale;
  const centerR  = minDim * 0.034;
  const ringW    = (outerR - centerR) / BAND_COUNT;
  const sectorArc = TWO_PI / sectorCount;

  for (let i = 0; i < BAND_COUNT; i++) {
    // Ring 0 = outermost = sub-bass; Ring 6 = innermost = brilliance
    const bandIdx = i;
    const rOuter  = outerR - i * ringW;
    const rInner  = rOuter - ringW;          // rings are fully adjacent
    const amp     = bands[bandIdx];
    const baseHue = (BAND_HUES[bandIdx] + hueShift) % 360;
    const compHue = (baseHue + 180) % 360;

    const sat      = 68 + amp * 32;                          // always vivid
    const litBase  = 18 + amp * 32 + flashBright * 14;      // darkens when quiet
    const litBoost = 16 + amp * 14;
    const alpha    = 0.72 + amp * 0.28;
    const ringAngle = angles[bandIdx];

    for (let j = 0; j < sectorCount; j++) {
      const startA = ringAngle + j * sectorArc;
      const endA   = startA + sectorArc;
      const hue    = j % 2 === 0 ? baseHue : compHue;
      const lit    = j % 2 === 0 ? litBase : litBase + litBoost;

      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, startA, endA);
      ctx.arc(cx, cy, rInner, endA, startA, true);
      ctx.closePath();
      ctx.fillStyle = `hsla(${hue.toFixed(0)},${sat.toFixed(0)}%,${Math.min(lit, 82).toFixed(0)}%,${alpha.toFixed(2)})`;
      ctx.fill();
    }

    // Simultaneous-contrast boundary ring — the "electric" edge Delaunay painted
    if (contrastAmt > 0.02) {
      const edgeHue   = (baseHue + 28) % 360;
      const edgeSat   = 18 + amp * 20;
      const edgeLit   = 58 + amp * 28 + flashBright * 18;
      const edgeAlpha = contrastAmt * (0.30 + amp * 0.42);
      const edgeW     = Math.max(0.5, contrastAmt * 2.8 * (1 + amp * 0.6));

      ctx.beginPath();
      ctx.arc(cx, cy, rInner, 0, TWO_PI);
      ctx.strokeStyle = `hsla(${edgeHue.toFixed(0)},${edgeSat.toFixed(0)}%,${Math.min(edgeLit, 96).toFixed(0)}%,${edgeAlpha.toFixed(2)})`;
      ctx.lineWidth   = edgeW;
      ctx.stroke();
    }
  }

  // Dark centre void — focal point anchoring the composition
  ctx.beginPath();
  ctx.arc(cx, cy, centerR, 0, TWO_PI);
  ctx.fillStyle = '#0a0814';
  ctx.fill();

  // Subtle centre pulse with total amplitude
  if (totalAmp > 0.04) {
    const pulseR = centerR * (0.6 + totalAmp * 1.4 + flashBright * 0.8);
    const pulseHue = (hueShift + 60) % 360;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(pulseR, centerR * 2.2), 0, TWO_PI);
    ctx.fillStyle = `hsla(${pulseHue.toFixed(0)},70%,70%,${(totalAmp * 0.55).toFixed(2)})`;
    ctx.fill();
  }

  // Beat brightness flash over whole canvas
  if (flashBright > 0.015) {
    ctx.fillStyle = `rgba(255,255,255,${(flashBright * 0.06).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.restore();
}
