/**
 * Newton Fractal: audio-reactive basins of attraction.
 *
 * Newton's method for z^n − 1 = 0 partitions the complex plane into n
 * coloured "basins of attraction" — regions where each starting point
 * converges to the same nth root of unity. The boundary between basins is
 * a fractal with infinite self-similar spiral structure unique to each n.
 *
 * With n = 7 (the default) each basin maps exactly to one frequency band,
 * so the fractal is literally a portrait of the music: band amplitudes drive
 * per-basin brightness, sub-bass breathes the zoom, beats kick a 45° hue
 * palette shift and give the plane a rotational impulse. The Roots slider
 * sweeps n from 2 (two half-plane basins) to 9 (nine petals), morphing the
 * symmetry live.
 *
 * Algorithm: z_{k+1} = ((n−1)·z^n + 1) / (n·z^(n−1))
 * Slow convergence (fractal boundary) is brightest; fast convergence
 * (basin interior) is darkest — the Glow slider amplifies this contrast,
 * burning the edges neon-white at high values.
 *
 * Rendering: ¼-res pixel buffer (⅛ mobile), Uint8ClampedArray,
 * p5.js image() with imageSmoothingEnabled.
 *
 * Inspired by Bahman Kalantari's "Polynomiography" art form (Rutgers
 * University, 2000s–2020s, https://polynomiography.com/) — a patented
 * technique that renders Newton's and other root-finding iterations as
 * richly coloured images, exhibited at the American Mathematical Society,
 * the Bridges Conference on Mathematical Art, and galleries worldwide.
 *
 * Sliders
 *   Zoom  — magnification (0 = wide overview, 1 = fine boundary detail)
 *   Roots — polynomial degree n: 2 = two basins, 9 = nine petals
 *   Glow  — boundary luminescence: neon-white burn on fractal edge regions
 */

import { store } from '../state/store';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { getBandAverages } from './helpers';

const PIXEL_SCALE = isMobile ? 8 : 4;
const MAX_ITER    = 42;

// Per-band hue centres (violet sub-bass → magenta brilliance)
const BAND_HUE: readonly number[] = [270, 240, 200, 160, 100, 50, 10];

// Module state
let _offscreen: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _imgData: ImageData | null = null;
let _rw = 0;
let _rh = 0;

let _lastBeat  = -1;
let _hueShift  = 0;
let _spinAngle = 0;   // slow rotation of the complex plane

export function resetNewton(): void {
  _offscreen = null;
  _ctx       = null;
  _imgData   = null;
  _rw        = 0;
  _rh        = 0;
  _lastBeat  = -1;
  _hueShift  = 0;
  _spinAngle = 0;
}

/** HSV (h∈[0,360), s∈[0,1], v∈[0,1]) → Uint8ClampedArray at byte offset. */
function hsv2px(
  h: number, s: number, v: number,
  px: Uint8ClampedArray, off: number,
): void {
  const h6 = ((h % 360) + 360) % 360 / 60;
  const i  = h6 | 0;
  const f  = h6 - i;
  const p  = v * (1 - s);
  const q  = v * (1 - s * f);
  const uv = v * (1 - s * (1 - f));
  let r: number, g: number, b: number;
  switch (i) {
    case 0:  r = v;  g = uv; b = p;  break;
    case 1:  r = q;  g = v;  b = p;  break;
    case 2:  r = p;  g = v;  b = uv; break;
    case 3:  r = p;  g = q;  b = v;  break;
    case 4:  r = uv; g = p;  b = v;  break;
    default: r = v;  g = p;  b = q;  break;
  }
  px[off    ] = (r * 255) | 0;
  px[off + 1] = (g * 255) | 0;
  px[off + 2] = (b * 255) | 0;
  px[off + 3] = 255;
}

export function drawNewton(p: any, dt: number): void {
  const { config, state } = store;
  const { newtonZoom, newtonRoots, newtonGlow } = config;

  const { amps } = getBandAverages(BAND_COUNT);

  // Beat detection
  const playPos = (state as any).playbackPosition ?? 0;
  const bpmData = (state as any).bpmData ?? { beatIntervalSec: 0.5, beatOffset: 0 };
  const beatIdx = bpmData.beatIntervalSec > 0
    ? Math.floor((playPos - bpmData.beatOffset) / bpmData.beatIntervalSec)
    : -1;

  if (beatIdx !== _lastBeat && beatIdx >= 0) {
    _lastBeat  = beatIdx;
    _hueShift  = (_hueShift + 45) % 360;
    // Tiny kick: advance spin by 1/n of a full turn (visually subtle)
    _spinAngle += (Math.PI * 2) / 14;
  }

  // Slow autonomous spin; amplitude accelerates it
  const amp = amps.reduce((a, b) => a + b, 0) / amps.length;
  _spinAngle += dt * 0.00007 * (0.25 + amp * 2.0);

  // Polynomial degree n from slider (2 – 9)
  const n = Math.max(2, Math.min(9, 2 + Math.round(newtonRoots * 7)));

  // Zoom: sub-bass breathes inward
  const subBass = amps[0] ?? 0;
  const zoomBase = 0.35 + newtonZoom * 2.6;
  const zoom     = zoomBase * (1 + subBass * 0.18);

  // Lazy init / resize offscreen pixel buffer
  const rw = Math.max(1, (p.width  / PIXEL_SCALE) | 0);
  const rh = Math.max(1, (p.height / PIXEL_SCALE) | 0);
  if (!_offscreen || _rw !== rw || _rh !== rh) {
    _rw = rw; _rh = rh;
    _offscreen       = document.createElement('canvas');
    _offscreen.width  = rw;
    _offscreen.height = rh;
    _ctx     = _offscreen.getContext('2d')!;
    _imgData = _ctx.createImageData(rw, rh);
  }

  const px     = _imgData!.data;
  const aspect = rw / rh;
  const cosA   = Math.cos(_spinAngle);
  const sinA   = Math.sin(_spinAngle);
  const nm1    = n - 1;

  // Precompute roots of unity: e^(2πik/n)
  const rootsR = new Float32Array(n);
  const rootsI = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    rootsR[k] = Math.cos(2 * Math.PI * k / n);
    rootsI[k] = Math.sin(2 * Math.PI * k / n);
  }

  // Per-basin amplitude (cycles through 7 freq bands when n > 7)
  const basinAmp = new Float32Array(n);
  for (let k = 0; k < n; k++) basinAmp[k] = amps[k % BAND_COUNT] ?? 0;

  for (let py = 0; py < rh; py++) {
    for (let px2 = 0; px2 < rw; px2++) {
      // Map pixel → complex plane, apply rotation
      const sx = ((px2 / rw) - 0.5) * 3.8 * aspect / zoom;
      const sy = ((py / rh) - 0.5) * 3.8 / zoom;
      let zr   = cosA * sx - sinA * sy;
      let zi   = sinA * sx + cosA * sy;

      // Newton iteration: z_{k+1} = ((n−1)·z^n + 1) / (n·z^(n−1))
      let iter    = 0;
      let rootIdx = 0;

      while (iter < MAX_ITER) {
        // Compute z^(n-1) via repeated complex multiplication
        let pr = 1.0, pi = 0.0;
        for (let k = 0; k < nm1; k++) {
          const nr = pr * zr - pi * zi;
          const ni = pr * zi + pi * zr;
          pr = nr;
          pi = ni;
        }
        // z^n = z^(n-1) · z
        const znr = pr * zr - pi * zi;
        const zni = pr * zi + pi * zr;

        // Numerator: (n−1)·z^n + 1
        const numR = nm1 * znr + 1.0;
        const numI = nm1 * zni;
        // Denominator: n·z^(n-1)
        const denR = n * pr;
        const denI = n * pi;
        const den2 = denR * denR + denI * denI;
        if (den2 < 1e-18) break;          // at or near origin

        zr = (numR * denR + numI * denI) / den2;
        zi = (numI * denR - numR * denI) / den2;

        // Check convergence: find closest root of unity
        let minD2   = Infinity;
        let closest = 0;
        for (let k = 0; k < n; k++) {
          const dr = zr - rootsR[k];
          const di = zi - rootsI[k];
          const d2 = dr * dr + di * di;
          if (d2 < minD2) { minD2 = d2; closest = k; }
        }
        if (minD2 < 1e-7) { rootIdx = closest; break; }
        iter++;
      }

      const off = (py * rw + px2) * 4;

      // t ∈ [0,1]: boundary = 1 (bright), interior = 0 (dark)
      const t    = iter / MAX_ITER;
      const bAmp = basinAmp[rootIdx];

      const bandIdx = rootIdx % BAND_COUNT;
      const hue     = (BAND_HUE[bandIdx]! + _hueShift) % 360;
      const sat     = 0.60 + bAmp * 0.40;
      const val     = Math.min(1.0,
        0.08 + (1.0 - t) * (0.35 + bAmp * 0.45)  // interior brightness
        + t * newtonGlow * 2.6,                     // boundary glow boost
      );

      hsv2px(hue, sat, val, px, off);
    }
  }

  _ctx!.putImageData(_imgData!, 0, 0);

  // Upscale to full canvas with smooth interpolation
  p.push();
  const ctx2d = (p as any).drawingContext as CanvasRenderingContext2D;
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.imageSmoothingQuality = 'low';
  ctx2d.drawImage(_offscreen!, 0, 0, p.width, p.height);
  p.pop();
}
