/**
 * Aurora — northern-lights curtains
 *
 * 7 translucent aurora bands span the full canvas width, one per frequency
 * band; sub-bass hangs at the bottom, brilliance crowns the top. Each band
 * is a sinusoidally-waving curtain filled with a luminous vertical gradient.
 * Screen-blending lets overlapping bands meld into white where multiple
 * frequencies peak simultaneously.  Stars drift in the dark-sky background.
 * Beat fires a cool-white brightness surge and rotates the hue palette.
 *
 * Inspired by James Turrell "Aurora B: Tall Glass" (2010)
 * https://turrell.utexas.edu/
 *
 * Sliders
 *   Intensity   — overall aurora brightness (0–2)
 *   Turbulence  — wave harmonic complexity (0–1)
 *   Drift       — animation speed (0–1)
 */
import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { audioEngine } from '../audio/engine';

// Horizontal segments for curtain wave resolution
const SEGS = isMobile ? 60 : 120;

// Per-band colour: sub-bass=deep-violet → bass=cobalt → low-mid=teal →
//   mid=emerald → upper-mid=lime → presence=rose → brilliance=ice-blue
const BAND_HUES = [268, 212, 168, 118, 80, 322, 198];
const BAND_SATS = [85,   80,  90,  85,  72,  87,  65];

// Stars
const STAR_COUNT = isMobile ? 80 : 190;
const starX   = new Float32Array(STAR_COUNT);
const starY   = new Float32Array(STAR_COUNT);
const starA   = new Float32Array(STAR_COUNT);
const starTwP = new Float32Array(STAR_COUNT); // twinkle phase

// Pre-allocated centre-line buffer
const _cx = new Float32Array(SEGS + 1);
const _cy = new Float32Array(SEGS + 1);

// Module state
let starsInited = false;
let time = 0;
let hueShift = 0;
let flashAmt = 0;
let lastBeatIdx = -1;

function initStars(): void {
  for (let i = 0; i < STAR_COUNT; i++) {
    starX[i]   = Math.random();
    starY[i]   = Math.random() * 0.85;
    starA[i]   = 0.3 + Math.random() * 0.7;
    starTwP[i] = Math.random() * 6.2832;
  }
  starsInited = true;
}

function hsba(h: number, s: number, b: number, a: number): string {
  const sn = s / 100;
  const bn = b / 100;
  const c  = bn * sn;
  const hh = ((h % 360) + 360) % 360;
  const xv = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m  = bn - c;
  let r = 0, g = 0, bv = 0;
  if      (hh < 60)  { r = c;  g = xv; bv = 0;  }
  else if (hh < 120) { r = xv; g = c;  bv = 0;  }
  else if (hh < 180) { r = 0;  g = c;  bv = xv; }
  else if (hh < 240) { r = 0;  g = xv; bv = c;  }
  else if (hh < 300) { r = xv; g = 0;  bv = c;  }
  else               { r = c;  g = 0;  bv = xv; }
  return `rgba(${Math.round((r+m)*255)},${Math.round((g+m)*255)},${Math.round((bv+m)*255)},${a.toFixed(3)})`;
}

export function resetAurora(): void {
  time = 0;
  hueShift = 0;
  flashAmt = 0;
  lastBeatIdx = -1;
  starsInited = false;
}

export function drawAurora(p: P5Instance, dt: number): void {
  if (!starsInited) initStars();

  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const intensity  = config.auroraIntensity;
  const turbulence = config.auroraTurbulence;
  const drift      = config.auroraDrift;

  // Beat detection
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi  = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      flashAmt = 0.55;
      hueShift = (hueShift + 18 + Math.random() * 22) % 360;
    }
  }

  time     += dt * (0.005 + drift * 0.020);
  flashAmt *= Math.pow(0.88, dt);
  if (flashAmt < 0.003) flashAmt = 0;

  const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
  const W = p.width;
  const H = p.height;

  // Dark sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0,   '#000511');
  sky.addColorStop(0.55, '#000920');
  sky.addColorStop(1,   '#010e1e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Stars
  for (let i = 0; i < STAR_COUNT; i++) {
    const tw    = 0.6 + 0.4 * Math.sin(starTwP[i] + time * 0.55);
    const alpha = starA[i] * tw * 0.72;
    ctx.beginPath();
    ctx.arc(starX[i] * W, starY[i] * H, 0.4 + starA[i] * 1.3, 0, 6.2832);
    ctx.fillStyle = `rgba(205,222,255,${alpha.toFixed(3)})`;
    ctx.fill();
  }

  // Aurora bands — screen composite for additive colour mixing
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'screen';

  const TOP_MARGIN = H * 0.06;
  const BOT_MARGIN = H * 0.11;
  const USABLE_H   = H - TOP_MARGIN - BOT_MARGIN;
  const SLOT_H     = USABLE_H / BAND_COUNT;

  // Glow passes: [halfHeight multiplier, alpha scale, brightness scale]
  const PASSES: [number, number, number][] = [
    [3.2, 0.055, 0.48], // outer halo
    [1.7, 0.20,  0.76], // mid body
    [0.75, 0.68, 1.00], // bright core
  ];

  const numH = Math.max(1, Math.round(1 + turbulence * 4)); // 1–5 harmonics

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = Math.max(amps[b], 0.04);

    // b=0 (sub) → bottom; b=BAND_COUNT-1 (brilliance) → top
    const slotT   = (BAND_COUNT - 1 - b) / (BAND_COUNT - 1); // 0=top, 1=bottom
    const centreY = TOP_MARGIN + USABLE_H * slotT + SLOT_H * 0.5;

    // Curtain half-height (can bleed into adjacent slot)
    const maxHH = SLOT_H * 1.5;
    const halfH  = maxHH * (0.08 + amp * 0.92);

    const hue = (BAND_HUES[b] + hueShift) % 360;
    const sat = BAND_SATS[b];
    const bri = 55 + amp * 38;

    // Compute sinusoidal centre line once per band
    for (let s = 0; s <= SEGS; s++) {
      const tx = s / SEGS;
      let wave = 0;
      for (let h = 1; h <= numH; h++) {
        const freq  = h + b * 0.35;
        const phase = time * (0.7 + h * 0.55 + b * 0.12);
        wave += Math.sin(tx * Math.PI * 2 * freq + phase) / h;
      }
      wave   *= 0.28 / numH; // keep wave offset < 30 % of halfH
      _cx[s]  = tx * W;
      _cy[s]  = centreY + wave * halfH;
    }

    for (const [hm, aM, bM] of PASSES) {
      const pH  = halfH * hm;
      const alp = aM * intensity * (0.2 + amp * 0.8);
      const pb  = bri * bM;

      // Gradient centred on the nominal centreY (small wave offset is fine)
      const gTop = centreY - pH;
      const gBot = centreY + pH;
      const grad = ctx.createLinearGradient(0, gTop, 0, gBot);
      grad.addColorStop(0,    hsba(hue, sat, pb, 0));
      grad.addColorStop(0.28, hsba(hue, sat, pb, alp * 0.72));
      grad.addColorStop(0.50, hsba(hue, sat, pb, alp));
      grad.addColorStop(0.72, hsba(hue, sat, pb, alp * 0.65));
      grad.addColorStop(1,    hsba(hue, sat, pb, 0));
      ctx.fillStyle = grad;

      // Curtain polygon: wavy top edge + wavy bottom edge
      ctx.beginPath();
      ctx.moveTo(_cx[0], _cy[0] - pH);
      for (let s = 1; s <= SEGS; s++) ctx.lineTo(_cx[s], _cy[s] - pH);
      for (let s = SEGS; s >= 0; s--) ctx.lineTo(_cx[s], _cy[s] + pH);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.globalCompositeOperation = prevOp;

  // Beat flash: cool-blue tint
  if (flashAmt > 0.01) {
    ctx.fillStyle = `rgba(150,210,255,${(flashAmt * 0.22).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.fillStyle = '#000000';
}
