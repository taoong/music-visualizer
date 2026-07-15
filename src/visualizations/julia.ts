/**
 * Julia Set — Audio-reactive complex-plane fractal visualizer.
 *
 * Inspired by Julius Horsthuis's cinematic fractal zoom animations
 * (https://www.julius-horsthuis.com/) and the rich tradition of
 * parameter-space art that exploded after Benoit Mandelbrot's 1980
 * discovery that the parameter space of Julia sets forms the Mandelbrot
 * set. The escape-time algorithm is the same one that produced the
 * famous "Fractint" fractal images of the 1980s–90s and the modern
 * ShaderToy fractal demos scene.
 *
 * Each pixel is colored by how many iterations z → z²+c takes to escape
 * |z| > 2, using smooth (continuous) coloring via fractional iteration
 * count. The parameter c slowly drifts through a curated path of
 * beautiful Julia set "genes" — on every beat it snaps to the next one
 * and eases in. Audio amplitude warps c away from the path, making the
 * fractal inhale and exhale with the music. The 7 frequency bands are
 * mapped to 7 hue ranges so different sonic registers paint different
 * regions of the escape-time spectrum.
 *
 * Rendering: offscreen pixel buffer at ¼ res (⅛ mobile), Uint8ClampedArray
 * with inline HSV→RGB conversion, p5.js image() for upscaling with
 * imageSmoothingEnabled.
 *
 * Sliders
 *   Zoom       — magnification (0=wide overview, 1=close detail)
 *   Iterations — maximum escape iterations (detail vs. speed trade-off)
 *   Hue        — overall palette rotation (cycles through rainbow)
 */

import { store } from '../state/store';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { getBandAverages } from './helpers';

const PIXEL_SCALE = isMobile ? 8 : 4;

// Curated list of beautiful Julia set c-parameters.
// Each entry produces a visually distinct fractal.
const JULIA_PRESETS: ReadonlyArray<readonly [number, number]> = [
  [-0.7269, 0.1889],   // Rabbit — dense dendrite spiral
  [-0.4,    0.6   ],   // Dendrite — classic branching fern
  [ 0.285,  0.01  ],   // Cauliflower — compact filled shape
  [-0.835, -0.2321],   // Sinaï — intricate sea-horse valleys
  [-0.8,    0.156 ],   // Spiral galaxy — elegant whorl
  [ 0.0,    0.8   ],   // Clover — four-fold symmetry
  [-0.7,    0.27  ],   // Border — thin filigree at the Mandelbrot boundary
  [ 0.36,   0.1   ],   // Snowflake — broad connected island
  [-0.12,  -0.77  ],   // Lotus — near-circle with filaments
  [-0.54,   0.54  ],   // Cobweb — square-ish lattice of spirals
];

// Per-band hue centers (degrees): sub-bass = violet, brilliance = magenta
const BAND_HUE = [270, 240, 200, 160, 100, 50, 10] as const;

// Module state
let _offscreen: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _imgData: ImageData | null = null;
let _rw = 0;
let _rh = 0;

let _presetIdx = 0;
let _cReal = JULIA_PRESETS[0][0];
let _cImag = JULIA_PRESETS[0][1];
let _targetCReal = JULIA_PRESETS[0][0];
let _targetCImag = JULIA_PRESETS[0][1];
let _lastBeat = -1;
let _hueShift = 0;

export function resetJulia(): void {
  _offscreen = null;
  _ctx = null;
  _imgData = null;
  _presetIdx = 0;
  _cReal = JULIA_PRESETS[0][0];
  _cImag = JULIA_PRESETS[0][1];
  _targetCReal = JULIA_PRESETS[0][0];
  _targetCImag = JULIA_PRESETS[0][1];
  _lastBeat = -1;
  _hueShift = 0;
}

/** Write HSV (h∈[0,360), s∈[0,1], v∈[0,1]) into pixels at byte offset. */
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

export function drawJulia(p: any, dt: number): void {
  const { config, state } = store;
  const { juliaZoom, juliaIterations, juliaHue } = config;

  // Get per-band averages via shared helper
  const { amps, transients } = getBandAverages(BAND_COUNT);

  // Beat detection — advance to next preset
  const playPos  = (state as any).playbackPosition ?? 0;
  const bpmData  = (state as any).bpmData ?? { bpm: 120, beatIntervalSec: 0.5, beatOffset: 0 };
  const beatIdx  = bpmData.beatIntervalSec > 0
    ? Math.floor((playPos - bpmData.beatOffset) / bpmData.beatIntervalSec)
    : -1;

  if (beatIdx !== _lastBeat && beatIdx >= 0) {
    _lastBeat = beatIdx;
    _presetIdx = (_presetIdx + 1) % JULIA_PRESETS.length;
    _targetCReal = JULIA_PRESETS[_presetIdx][0];
    _targetCImag = JULIA_PRESETS[_presetIdx][1];
    _hueShift = (_hueShift + 47) % 360;
  }

  // Ease c toward target (frame-rate independent)
  const easeK = 1 - Math.pow(0.1, dt / 400);
  _cReal += (_targetCReal - _cReal) * easeK;
  _cImag += (_targetCImag - _cImag) * easeK;

  // Audio warps c: amplitude bends around target
  const amp = amps.reduce((a, b) => a + b, 0) / amps.length;
  const transAmp = transients.reduce((a, b) => a + b, 0) / transients.length;
  const warpStrength = amp * 0.18 + transAmp * 0.12;
  const warpAngle = (amps[0] ?? 0) * Math.PI * 2;
  const cR = _cReal + Math.cos(warpAngle) * warpStrength;
  const cI = _cImag + Math.sin(warpAngle) * warpStrength;

  // Sub-bass breathes the zoom
  const subBass = amps[0] ?? 0;
  const zoomBase = 0.5 + juliaZoom * 2.0;  // range: 0.5 – 2.5
  const zoom = zoomBase * (1 + subBass * 0.25);

  // Max iterations from slider (20 – 80)
  const maxIter = Math.round(20 + juliaIterations * 60);

  // Global hue palette from slider + beat-triggered shift
  const globalHue = (juliaHue * 360 + _hueShift) % 360;

  // Lazy-init / resize offscreen buffer
  const rw = Math.max(1, Math.floor(p.width  / PIXEL_SCALE));
  const rh = Math.max(1, Math.floor(p.height / PIXEL_SCALE));
  if (!_offscreen || _rw !== rw || _rh !== rh) {
    _rw = rw;
    _rh = rh;
    _offscreen = document.createElement('canvas');
    _offscreen.width  = rw;
    _offscreen.height = rh;
    _ctx = _offscreen.getContext('2d')!;
    _imgData = _ctx.createImageData(rw, rh);
  }

  const px  = _imgData!.data;
  const inv = 1 / maxIter;
  const aspect = rw / rh;

  // Julia-set iteration: for each pixel compute escape time
  for (let py = 0; py < rh; py++) {
    for (let px2 = 0; px2 < rw; px2++) {
      // Map pixel → complex plane, centered, zoomed
      const zr0 = ((px2 / rw) - 0.5) * 2.6 * aspect / zoom;
      const zi0 = ((py / rh) - 0.5) * 2.6 / zoom;

      let zr = zr0;
      let zi = zi0;
      let iter = 0;
      while (iter < maxIter) {
        const zr2 = zr * zr;
        const zi2 = zi * zi;
        if (zr2 + zi2 > 4) break;
        zi = 2 * zr * zi + cI;
        zr = zr2 - zi2 + cR;
        iter++;
      }

      const off = (py * rw + px2) * 4;

      if (iter === maxIter) {
        // Interior — solid dark color with slight band tint
        px[off    ] = 5;
        px[off + 1] = 5;
        px[off + 2] = 10;
        px[off + 3] = 255;
      } else {
        // Smooth (continuous) iteration count for gradient coloring
        // log2(log2(|z|)) correction removes banding artifacts
        const zr2 = zr * zr;
        const zi2 = zi * zi;
        const log2mod = 0.5 * Math.log(zr2 + zi2) / Math.LN2;
        const smooth  = iter + 1 - Math.log(log2mod) / Math.LN2;
        const t = smooth * inv;             // 0 → 1 normalized escape time

        // Map t to one of 7 freq-band hue zones
        const bandIdx  = Math.min(6, (t * 7) | 0);
        const bandFrac = (t * 7) - bandIdx;
        const bandAmp  = amps[bandIdx] ?? 0;
        const nextAmp  = amps[Math.min(6, bandIdx + 1)] ?? 0;
        const blendAmp = bandAmp + (nextAmp - bandAmp) * bandFrac;

        const bandHue = BAND_HUE[bandIdx];
        const hue     = (bandHue + globalHue + t * 60) % 360;
        const sat     = 0.75 + blendAmp * 0.25;
        const val     = 0.2 + t * 0.5 + blendAmp * 0.3;

        hsv2px(hue, Math.min(1, sat), Math.min(1, val), px, off);
      }
    }
  }

  _ctx!.putImageData(_imgData!, 0, 0);

  // Render to canvas with smooth upscaling
  p.push();
  const nCtx: CanvasRenderingContext2D = (p as any).drawingContext;
  nCtx.imageSmoothingEnabled = true;
  nCtx.imageSmoothingQuality = 'low';
  nCtx.drawImage(_offscreen!, 0, 0, p.width, p.height);
  p.pop();
}
