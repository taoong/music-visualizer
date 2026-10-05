/**
 * Grid Warp — a live mesh grid that bends space itself.
 *
 * Inspired by real-time grid-manipulation tools (the kind used to stretch,
 * squeeze, and warp an image by dragging control points on a lattice) —
 * here the "dragging" is done by the music instead of a hand. A mesh of
 * control points spans the canvas; each node eases continuously toward a
 * target displacement built from slow Perlin drift plus a per-band pull
 * (sub-bass on the left through brilliance on the right, Gaussian-weighted
 * by column like the project's other column-zone vizzes). Beats don't snap
 * the grid to a new shape — they add a radial pressure wave that travels
 * outward from centre and decays, perturbing the already-flowing mesh.
 *
 * With no image loaded the mesh renders as a glowing cyan/white wireframe
 * lattice. With an image loaded, the image itself is warped through the
 * same mesh — each grid cell is split into two triangles and texture-mapped
 * with a per-triangle affine transform (the standard three-point-
 * correspondence trick for canvas 2D texture warping), so the picture
 * visibly stretches and bulges with the grid instead of just decorating it.
 *
 * Sliders
 *   Density — grid resolution (structural: coarse lattice to fine mesh)
 *   Warp    — displacement budget / audio pull sensitivity
 *   Flow    — ambient drift speed and node response rate
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';
import { getUserImage, hasUserImage } from './userImage';

let _cols = 0;
let _rows = 0;
let _dispX: Float32Array | null = null;
let _dispY: Float32Array | null = null;
let _noiseT = 0;
let _lastBeat = -1;
let _surgeAmp = 0;
let _surgeR = 0;

let _imgCanvas: HTMLCanvasElement | null = null;
let _imgCanvasW = 0;
let _imgCanvasH = 0;
let _imageUnsub: (() => void) | null = null;
let _imageInitialized = false;
let _imageDirty = true;

function rebuildImageCanvas(p: P5Instance): void {
  if (!hasUserImage()) {
    _imgCanvas = null;
    _imageDirty = false;
    return;
  }
  const img = getUserImage();
  if (!img) {
    _imgCanvas = null;
    _imageDirty = false;
    return;
  }

  const cw = Math.max(1, Math.round(p.width));
  const ch = Math.max(1, Math.round(p.height));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    _imgCanvas = null;
    _imageDirty = false;
    return;
  }

  const iw = img.width;
  const ih = img.height;
  const srcEl = (img as unknown as { canvas?: HTMLCanvasElement; elt?: HTMLCanvasElement }).canvas
    || (img as unknown as { canvas?: HTMLCanvasElement; elt?: HTMLCanvasElement }).elt;

  if (srcEl && iw > 0 && ih > 0) {
    const scale = Math.max(cw / iw, ch / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    const ox = (cw - sw) / 2;
    const oy = (ch - sh) / 2;
    ctx.drawImage(srcEl, ox, oy, sw, sh);
  }

  _imgCanvas = canvas;
  _imgCanvasW = cw;
  _imgCanvasH = ch;
  _imageDirty = false;
}

function initGridwarpImage(): void {
  if (_imageInitialized) return;
  _imageUnsub = store.on('imageChange', () => {
    _imageDirty = true;
  });
  _imageInitialized = true;
}

/** Texture-map one source triangle onto one destination triangle via a 3-point affine transform. */
function warpTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  dx0: number, dy0: number, dx1: number, dy1: number, dx2: number, dy2: number
): void {
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 1e-6) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();

  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const e = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / denom;
  const f = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / denom;

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

export function resetGridwarp(): void {
  _cols = 0;
  _rows = 0;
  _dispX = null;
  _dispY = null;
  _noiseT = 0;
  _lastBeat = -1;
  _surgeAmp = 0;
  _surgeR = 0;
  if (_imageUnsub) {
    _imageUnsub();
    _imageUnsub = null;
  }
  _imageInitialized = false;
  _imageDirty = true;
  _imgCanvas = null;
}

export function drawGridwarp(p: P5Instance, dt: number): void {
  initGridwarpImage();

  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const density = config.gridwarpDensity;
  const warp = config.gridwarpWarp;
  const flow = config.gridwarpFlow;

  const maxCols = isMobile ? 18 : 34;
  const cols = Math.max(7, Math.round(7 + density * (maxCols - 7)));
  const rows = Math.max(5, Math.round(cols * (p.height / p.width)));
  const pointsX = cols + 1;
  const pointsY = rows + 1;

  if (_cols !== cols || _rows !== rows || !_dispX || !_dispY) {
    _cols = cols;
    _rows = rows;
    _dispX = new Float32Array(pointsX * pointsY);
    _dispY = new Float32Array(pointsX * pointsY);
  }

  const useImage = hasUserImage();
  if (useImage && (_imageDirty || !_imgCanvas || _imgCanvasW !== Math.round(p.width) || _imgCanvasH !== Math.round(p.height))) {
    rebuildImageCanvas(p);
  }

  // Beat detection — fires a radial pressure wave from centre, decaying as it travels.
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const beatIdx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== _lastBeat) {
      _lastBeat = beatIdx;
      _surgeAmp = 1.0;
      _surgeR = 0;
    }
  }

  const pace = 0.3 + flow * 1.3;
  _surgeR = Math.min(1.6, _surgeR + 0.03 * pace * dt);
  _surgeAmp *= Math.pow(0.92, dt);
  _noiseT += 0.0022 * pace * dt;

  const respRate = Math.min(1, (0.05 + flow * 0.32) * dt);

  const cellW = p.width / cols;
  const cellH = p.height / rows;
  const cellMin = Math.min(cellW, cellH);
  const warpScale = cellMin * (0.4 + warp * 1.6);
  const ambientAmp = warpScale * 0.32;
  const pullAmp = warpScale * 0.85;
  const surgeMaxDisp = warpScale * 1.3;

  const px = new Float32Array(pointsX * pointsY);
  const py = new Float32Array(pointsX * pointsY);

  for (let j = 0; j < pointsY; j++) {
    const ny = j / rows;
    for (let i = 0; i < pointsX; i++) {
      const nx = i / cols;
      const idx = j * pointsX + i;

      let bandPull = 0;
      for (let b = 0; b < BAND_COUNT; b++) {
        const bx = (b + 0.5) / BAND_COUNT;
        const d = (nx - bx) * BAND_COUNT;
        bandPull += amps[b] * Math.exp(-d * d * 1.6);
      }
      bandPull = Math.min(1.3, bandPull * 0.85);

      const dx = nx - 0.5;
      const dy = ny - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const invLen = dist > 1e-4 ? 1 / dist : 0;
      const ux = dx * invLen;
      const uy = dy * invLen;

      const n1 = ((p as any).noise(nx * 2.1 + 50, ny * 2.1 + 50, _noiseT) as number) - 0.5;
      const n2 = ((p as any).noise(nx * 2.1 - 50, ny * 2.1 - 50, _noiseT + 100) as number) - 0.5;

      const surgeArg = (dist - _surgeR) * (dist - _surgeR);
      const surge = _surgeAmp * Math.exp(-surgeArg * 55);

      const targetX = n1 * ambientAmp + ux * bandPull * pullAmp + ux * surge * surgeMaxDisp;
      const targetY = n2 * ambientAmp + uy * bandPull * pullAmp + uy * surge * surgeMaxDisp;

      _dispX![idx] += (targetX - _dispX![idx]) * respRate;
      _dispY![idx] += (targetY - _dispY![idx]) * respRate;

      px[idx] = nx * p.width + _dispX![idx];
      py[idx] = ny * p.height + _dispY![idx];
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
  p.background(6, 8, 12);

  if (useImage && _imgCanvas) {
    const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const i00 = j * pointsX + i;
        const i10 = j * pointsX + (i + 1);
        const i01 = (j + 1) * pointsX + i;
        const i11 = (j + 1) * pointsX + (i + 1);

        const sx00 = (i / cols) * p.width, sy00 = (j / rows) * p.height;
        const sx10 = ((i + 1) / cols) * p.width, sy10 = (j / rows) * p.height;
        const sx01 = (i / cols) * p.width, sy01 = ((j + 1) / rows) * p.height;
        const sx11 = ((i + 1) / cols) * p.width, sy11 = ((j + 1) / rows) * p.height;

        warpTriangle(
          ctx, _imgCanvas,
          sx00, sy00, sx10, sy10, sx01, sy01,
          px[i00], py[i00], px[i10], py[i10], px[i01], py[i01]
        );
        warpTriangle(
          ctx, _imgCanvas,
          sx10, sy10, sx11, sy11, sx01, sy01,
          px[i10], py[i10], px[i11], py[i11], px[i01], py[i01]
        );
      }
    }

    // Faint grid overlay so the warp mechanism stays legible on top of the image.
    ctx.save();
    ctx.globalAlpha = 0.16 + _surgeAmp * 0.25;
    ctx.strokeStyle = '#eafcff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let j = 0; j < pointsY; j++) {
      for (let i = 0; i < pointsX - 1; i++) {
        const a = j * pointsX + i, b = j * pointsX + (i + 1);
        ctx.moveTo(px[a], py[a]);
        ctx.lineTo(px[b], py[b]);
      }
    }
    for (let i = 0; i < pointsX; i++) {
      for (let j = 0; j < pointsY - 1; j++) {
        const a = j * pointsX + i, b = (j + 1) * pointsX + i;
        ctx.moveTo(px[a], py[a]);
        ctx.lineTo(px[b], py[b]);
      }
    }
    ctx.stroke();
    ctx.restore();
  } else {
    const ctx = (p as any).drawingContext as CanvasRenderingContext2D;
    const hue = 196;
    const flash = Math.min(1, _surgeAmp * 0.6);

    ctx.save();
    ctx.lineCap = 'round';

    // Outer soft glow pass.
    ctx.shadowBlur = isMobile ? 6 : 14;
    ctx.shadowColor = `hsla(${hue}, 90%, 65%, 0.55)`;
    ctx.strokeStyle = `hsla(${hue}, 75%, ${55 + flash * 25}%, 0.55)`;
    ctx.lineWidth = 1.4;
    drawGridLines(ctx, px, py, pointsX, pointsY, cols, rows);

    // Bright core pass.
    ctx.shadowBlur = isMobile ? 0 : 4;
    ctx.strokeStyle = `hsla(${hue}, 40%, ${80 + flash * 20}%, 0.9)`;
    ctx.lineWidth = 0.8;
    drawGridLines(ctx, px, py, pointsX, pointsY, cols, rows);

    ctx.restore();
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  px: Float32Array,
  py: Float32Array,
  pointsX: number,
  pointsY: number,
  cols: number,
  rows: number
): void {
  ctx.beginPath();
  for (let j = 0; j < pointsY; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * pointsX + i, b = j * pointsX + (i + 1);
      ctx.moveTo(px[a], py[a]);
      ctx.lineTo(px[b], py[b]);
    }
  }
  for (let i = 0; i < pointsX; i++) {
    for (let j = 0; j < rows; j++) {
      const a = j * pointsX + i, b = (j + 1) * pointsX + i;
      ctx.moveTo(px[a], py[a]);
      ctx.lineTo(px[b], py[b]);
    }
  }
  ctx.stroke();
}
