/**
 * Risograph — layered screen-print aesthetic with overlapping neon geometric forms.
 *
 * Inspired by Corita Kent's "Handle with Care" (1967) serigraphy prints
 * (https://coritakent.org/) and the Risograph printing revival in independent
 * art and zine culture (2010s–2020s). Risograph printers lay down one ink color
 * per pass; where layers overprint they mix additively, producing vivid secondary
 * hues. Imperfect registration between passes is celebrated — a brief shift on
 * each beat reveals the layered nature of the image.
 *
 * Seven ink layers (one per frequency band) are rendered as bold flat-color
 * geometric shapes (circles, ellipses, rounded rectangles, pills) using additive
 * blending so overlapping regions compound into luminous whites. Each band's
 * amplitude scales shape size and brightness. A Perlin-noise field slowly drifts
 * shapes across the canvas. On every beat, ~60 % of layers receive an independent
 * registration offset that decays back to zero within ~0.5 s.
 *
 * Sliders
 *   Shapes — shapes per ink layer (1–4; mobile: 1–2)
 *   Shift  — mis-registration distance on beats (0 = none, 1 = wild)
 *   Bloom  — additive glow halo intensity (0 = sharp flat ink, 1 = neon bleed)
 */

import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

/** Risograph ink palette — one hue per frequency band (violet→blue→teal→…→magenta). */
const BAND_HUES: readonly number[] = [280, 330, 5, 33, 58, 172, 220];

const MAX_SHAPES = isMobile ? 2 : 4;

interface RisoShape {
  /** Perlin-noise seed for x position drift. */
  nx: number;
  /** Perlin-noise seed for y position drift. */
  ny: number;
  /** Half-width in canvas units. */
  hw: number;
  /** Half-height in canvas units. */
  hh: number;
  /** Current rotation angle in radians. */
  angle: number;
  /** Rotation speed in radians per unit dt. */
  rotSpeed: number;
  /** Shape type: 0=circle, 1=ellipse, 2=rounded-rect, 3=pill. */
  type: number;
}

interface Layer {
  shapes: RisoShape[];
  offsetX: number;
  offsetY: number;
}

// ── Module-scoped state ───────────────────────────────────────────────────────
let layers: Layer[] = [];
let timeBase = 0;
let prevShapeCount = -1;

function newShape(W: number, H: number): RisoShape {
  return {
    nx: Math.random() * 1000,
    ny: Math.random() * 1000,
    hw: W * (0.10 + Math.random() * 0.22),
    hh: H * (0.10 + Math.random() * 0.22),
    angle: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.010,
    type: Math.floor(Math.random() * 4),
  };
}

export function drawRisograph(p: P5Instance, dt: number): void {
  const { risographShapes, risographShift, risographBloom } = store.config;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const shapeCount = Math.max(1, Math.min(MAX_SHAPES, Math.round(risographShapes)));
  const shiftAmt   = risographShift;
  const bloomAmt   = risographBloom;

  // (Re)initialise layers if shape count changed or first run.
  if (shapeCount !== prevShapeCount) {
    layers = [];
    for (let b = 0; b < BAND_COUNT; b++) {
      layers.push({
        shapes: Array.from({ length: shapeCount }, () => newShape(p.width, p.height)),
        offsetX: 0,
        offsetY: 0,
      });
    }
    prevShapeCount = shapeCount;
  }

  timeBase += dt * 0.006;

  // Beat: apply mis-registration offsets to random layers.
  const maxT = Math.max(...transients);
  if (maxT > 1.35) {
    const d = shiftAmt * 60 * Math.min(maxT - 1, 2.5);
    for (const layer of layers) {
      if (Math.random() < 0.62) {
        const a = Math.random() * Math.PI * 2;
        layer.offsetX = Math.cos(a) * d;
        layer.offsetY = Math.sin(a) * d;
      }
    }
  }

  // Decay offsets toward zero.
  const decay = Math.pow(0.87, dt);
  for (const layer of layers) {
    layer.offsetX *= decay;
    layer.offsetY *= decay;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  p.background(8, 4, 12);
  p.colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();
  p.blendMode(p['ADD']);

  const t = timeBase;

  for (let b = 0; b < BAND_COUNT; b++) {
    const amp = amps[b];
    if (amp < 0.012) continue;

    const hue      = BAND_HUES[b];
    const layer    = layers[b];
    const ox       = layer.offsetX;
    const oy       = layer.offsetY;
    const sizeS    = 0.45 + amp * 0.90;
    const bri      = 18 + amp * 70;
    const sat      = 78 + amp * 20;
    const fillAlph = 20 + amp * 42;

    for (const sh of layer.shapes) {
      sh.angle += sh.rotSpeed * dt;

      // Perlin position drift — noise() returns [0,1], map to canvas.
      const px = p.noise(sh.nx + t)         * p.width;
      const py = p.noise(sh.ny + t * 0.75)  * p.height;

      const sw = sh.hw * sizeS;
      const sh2 = sh.hh * sizeS;

      p.push();
      p.translate(px + ox, py + oy);
      p.rotate(sh.angle);

      // Optional outer bloom pass (wide, transparent halo).
      if (bloomAmt > 0.05) {
        const gS = 1 + bloomAmt * 3.5;
        p.fill(hue, sat - 20, bri + 18, fillAlph * 0.26 * bloomAmt);
        drawShape(p, sh.type, sw * gS, sh2 * gS);
      }

      // Optional mid bloom pass.
      if (bloomAmt > 0.30) {
        const mS = 1 + bloomAmt * 1.6;
        p.fill(hue, sat - 10, bri + 8, fillAlph * 0.44 * bloomAmt);
        drawShape(p, sh.type, sw * mS, sh2 * mS);
      }

      // Core ink pass — flat, fully saturated.
      p.fill(hue, sat, bri, fillAlph);
      drawShape(p, sh.type, sw, sh2);

      p.pop();
    }
  }

  p.blendMode(p['BLEND']);
  p.colorMode(p['RGB'], 255, 255, 255, 255);
}

/** Draw the selected shape type centred on the current transform origin. */
function drawShape(p: P5Instance, type: number, w: number, h: number): void {
  switch (type) {
    case 0: // Circle
      p.ellipse(0, 0, w * 2, w * 2);
      break;
    case 1: // Ellipse
      p.ellipse(0, 0, w * 2, h * 2);
      break;
    case 2: // Rounded rectangle
      p.rect(-w, -h, w * 2, h * 2, w * 0.18);
      break;
    case 3: // Pill — tall narrow rounded rect
      p.rect(-w * 0.5, -h, w, h * 2, w * 0.5);
      break;
    default:
      p.ellipse(0, 0, w * 2, w * 2);
  }
}

export function resetRisograph(): void {
  layers = [];
  prevShapeCount = -1;
  timeBase = 0;
}
