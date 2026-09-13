/**
 * Meander — Audio-reactive sand-spline visualization.
 *
 * Seven Catmull-Rom spline paths drift slowly via Perlin noise, one path per
 * frequency band.  Each frame, particles spray perpendicular to each path with
 * a Gaussian scatter radius that scales with band amplitude: quiet passages
 * leave razor-sharp hairlines while loud passages swell into diffuse luminous
 * clouds.  Dots accumulate with additive blending on an offscreen trail buffer,
 * building a richly-layered chalk-pastel painting that shifts and breathes with
 * the music.  Beat fires hue-palette jump and a brief scatter burst.
 *
 * Inspired by Inconvergent / Anders Hoff's "Sand" series (2016–2020)
 * https://inconvergent.net/generative/sand-spline/
 * The sand-spline technique reveals structure through density of micro-marks
 * rather than explicit outline — the same principle as chalk smearing on dark
 * paper, where accumulated dots form gradient-smooth forms.
 *
 * Sliders:
 *   Scatter (meanderScatter) — perpendicular spread; 0 = hairline, 1 = diffuse cloud
 *   Density (meanderDensity) — particles per frame; 0 = sparse dots, 1 = solid fill
 *   Flow    (meanderFlow)    — path drift speed; 0 = nearly still, 1 = dynamic
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Constants ──────────────────────────────────────────────────────────────────
const N_CTRL  = 5;                          // control points per spline
const MAX_PPF = isMobile ? 80 : 220;        // max particles per band per frame

// Hue per band: violet → indigo → cyan → green → yellow → orange → red
const BASE_HUES = [270, 230, 185, 120, 60, 30, 0] as const;

// ── Module state ───────────────────────────────────────────────────────────────
interface CtrlPt { x: number; y: number; nx: number; ny: number; }
interface SplinePath { pts: CtrlPt[]; }

let paths:       SplinePath[] = [];
let pg:          any          = null;
let hueShift     = 0;
let beatBurst    = 0;
let lastBeatIdx  = -1;
let globalT      = 0;
let initialized  = false;
let prevW        = 0;
let prevH        = 0;

// ── Gaussian RNG (Box-Muller) ──────────────────────────────────────────────────
function gaussRand(): number {
  const u = 1 - Math.random(); // keep away from 0 for log safety
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Catmull-Rom interpolation ──────────────────────────────────────────────────
function catmullRom(
  t: number,
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
): [number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * (2*x1 + (-x0 + x2)*t + (2*x0 - 5*x1 + 4*x2 - x3)*t2 + (-x0 + 3*x1 - 3*x2 + x3)*t3),
    0.5 * (2*y1 + (-y0 + y2)*t + (2*y0 - 5*y1 + 4*y2 - y3)*t2 + (-y0 + 3*y1 - 3*y2 + y3)*t3),
  ];
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
export function resetMeander(): void {
  paths       = [];
  pg          = null;
  hueShift    = 0;
  beatBurst   = 0;
  lastBeatIdx = -1;
  globalT     = 0;
  initialized = false;
}

function init(w: number, h: number, p: P5Instance): void {
  paths = [];
  for (let b = 0; b < BAND_COUNT; b++) {
    const pts: CtrlPt[] = [];
    for (let i = 0; i < N_CTRL; i++) {
      // Spread noise seeds widely so each point + band follows a unique trajectory
      pts.push({
        x: 0, y: 0,
        nx: b * 31.7 + i * 17.3 + Math.random() * 5,
        ny: b * 23.1 + i * 41.9 + Math.random() * 5,
      });
    }
    paths.push({ pts });
  }
  // Offscreen trail buffer
  pg = (p as any).createGraphics(w, h);
  (pg as any).background(0);
  prevW = w;
  prevH = h;
  initialized = true;
}

// ── Draw ───────────────────────────────────────────────────────────────────────
export function drawMeander(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps }          = getBandAverages(BAND_COUNT);
  const w = p.width, h = p.height;

  if (!initialized || prevW !== w || prevH !== h) init(w, h, p);

  // Slider → working ranges
  const scatter   = config.meanderScatter;            // 0–1
  const density   = config.meanderDensity;            // 0–1
  const flowSpeed = 0.25 + config.meanderFlow * 1.75; // 0.25–2.0

  // ── Beat detection ──────────────────────────────────────────────────────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const bi  = Math.floor((pos - state.beatOffset) / state.beatIntervalSec);
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      beatBurst   = 1.0;
      hueShift    = (hueShift + 47 + Math.random() * 40) % 360;
    }
  }
  beatBurst *= Math.pow(0.87, dt);

  // Advance Perlin time
  globalT += 0.002 * flowSpeed * dt;

  // ── Update control points via Perlin noise ──────────────────────────────────
  // Positions are fully determined by noise so they drift smoothly forever
  for (const path of paths) {
    for (const pt of path.pts) {
      pt.x = p.noise(pt.nx + globalT, 0.3) * w * 1.3 - w * 0.15;
      pt.y = p.noise(0.3, pt.ny + globalT) * h * 1.3 - h * 0.15;
    }
  }

  // ── Trail fade ──────────────────────────────────────────────────────────────
  // Slow fade toward black; at low density trails persist longer for atmosphere
  const ctx = (pg as any).drawingContext as CanvasRenderingContext2D;
  const fadeAlpha = 0.006 + (1 - density) * 0.028;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = fadeAlpha;
  ctx.fillStyle   = '#000000';
  ctx.fillRect(0, 0, w, h);

  // Additive blend: chalk dots accumulate to brightness
  ctx.globalCompositeOperation = 'lighter';

  // ── Spray particles ──────────────────────────────────────────────────────────
  const maxSigma = Math.min(w, h) * 0.11; // max perpendicular scatter in px

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.015) continue;

    const path   = paths[b];
    const n      = N_CTRL;
    const hue    = (BASE_HUES[b] + hueShift) % 360;
    const sigma  = amp * scatter * maxSigma + beatBurst * maxSigma * 0.12;
    const numPts = Math.max(1, Math.floor(amp * density * MAX_PPF));
    const bright = Math.min(80, 35 + amp * 45);

    for (let i = 0; i < numPts; i++) {
      // Random parameter in [0, n-1]
      const tGlobal = Math.random() * (n - 1);
      const seg     = Math.floor(tGlobal);
      const tLocal  = tGlobal - seg;

      // Clamped Catmull-Rom indices
      const i0 = Math.max(0, seg - 1);
      const i1 = seg;
      const i2 = Math.min(n - 1, seg + 1);
      const i3 = Math.min(n - 1, seg + 2);

      const [spx, spy] = catmullRom(
        tLocal,
        path.pts[i0].x, path.pts[i0].y,
        path.pts[i1].x, path.pts[i1].y,
        path.pts[i2].x, path.pts[i2].y,
        path.pts[i3].x, path.pts[i3].y,
      );

      // Approximate tangent: ½ * (p_{i+1} - p_{i-1}) — standard Catmull-Rom
      const tdx  = path.pts[i2].x - path.pts[i0].x;
      const tdy  = path.pts[i2].y - path.pts[i0].y;
      const tLen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
      // Perpendicular (rotate 90°)
      const perpX = -tdy / tLen;
      const perpY =  tdx / tLen;

      // Gaussian offset — weight alpha so core is bright, halo is dim
      const g      = gaussRand();
      const offset = g * sigma;
      const pAlpha = Math.exp(-0.5 * g * g) * (0.20 + amp * 0.18);

      const px = spx + perpX * offset;
      const py = spy + perpY * offset;

      if (px < 0 || px >= w || py < 0 || py >= h) continue;

      ctx.globalAlpha = pAlpha;
      ctx.fillStyle   = `hsl(${hue}, 85%, ${bright}%)`;
      ctx.fillRect(Math.floor(px), Math.floor(py), 2, 2);
    }
  }

  // ── Reset context ────────────────────────────────────────────────────────────
  ctx.globalAlpha              = 1.0;
  ctx.globalCompositeOperation = 'source-over';

  // ── Blit trail to main canvas ────────────────────────────────────────────────
  p.background(0);
  p.image(pg, 0, 0);

  // Soft bloom pass: slightly scaled at low alpha for luminous glow
  (p as any).blendMode((p as any)['ADD']);
  (p as any).tint(255, 40);
  p.image(pg, -w * 0.02, -h * 0.02, w * 1.04, h * 1.04);
  (p as any).noTint();
  (p as any).blendMode((p as any)['BLEND']);
}
