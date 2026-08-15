/**
 * Klimt — Audio-reactive golden mosaic.
 *
 * Inspired by Gustav Klimt's "The Tree of Life" (1905–09, Stoclet Frieze,
 * Brussels) and "Portrait of Adele Bloch-Bauer I" (1907, Neue Galerie,
 * New York) — where Byzantine gold-leaf tessellations, Art Nouveau spirals,
 * and ornamental motifs (nested squares, radial suns, almond eyes, interlaced
 * triangles) fuse into a shimmering decorative field. Klimt visited Ravenna
 * in 1903 and was transfixed by the golden mosaic tesserae of San Vitale;
 * that encounter seeded the golden-phase paintings.
 *
 * A dense grid of ornamental tiles fills the canvas. Seven column zones map
 * frequency bands left-to-right (sub-bass → brilliance); each tile's
 * brightness and scale pulse with its band's amplitude. A golden shimmer ring
 * radiates outward from canvas centre on every beat. Five Art Nouveau motifs —
 * nested squares, circles with radiating spokes, almond eyes (Klimt's
 * mandorla), equilateral triangles, and Archimedean spirals — are distributed
 * deterministically across the grid, composing an ever-shifting tessera.
 *
 * Sliders
 *   Tile Size   — mosaic grid density (0 = large bold tiles, 1 = fine tesserae)
 *   Gold        — palette warmth and saturation (0 = muted bronze, 1 = vivid gold)
 *   Complexity  — ornamental intricacy per tile (0 = spare, 1 = fully ornate)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

interface Tile {
  cx: number;    // centre x
  cy: number;    // centre y
  band: number;  // 0-6 frequency band index
  decor: number; // 0-4 decoration type
  phase: number; // static rotational phase offset
  baseHue: number; // warm gold base hue (HSB 25-65)
}

let tiles: Tile[] = [];
let lastTileSize = -1;
let lastW = 0;
let lastH = 0;

// Beat-driven shimmer ring
let shimmerR = 0;
let shimmerMaxR = 0;
let shimmerActive = false;
let hueShift = 0;
let lastBeat = -1;

// Mic/interactive fallback beat detection
let micPrevAmp = 0;

export function resetKlimt(): void {
  tiles = [];
  lastTileSize = -1;
  lastW = 0;
  lastH = 0;
  shimmerR = 0;
  shimmerMaxR = 0;
  shimmerActive = false;
  hueShift = 0;
  lastBeat = -1;
  micPrevAmp = 0;
}

function buildTiles(p: P5Instance, ts: number): void {
  tiles = [];
  const cols = Math.ceil(p.width / ts) + 1;
  const rows = Math.ceil(p.height / ts) + 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = col * ts + ts * 0.5;
      const cy = row * ts + ts * 0.5;
      const band = Math.min(BAND_COUNT - 1, Math.floor((col / cols) * BAND_COUNT));
      // Deterministic decoration spread across 5 motif types
      const decor = (col * 7 + row * 13) % 5;
      // Static phase offset gives each tile its own orientation
      const phase = ((col * 1.618 + row * 2.618) % 1.0) * Math.PI * 2;
      // Warm gold hue 25-65 with gentle spatial drift
      const baseHue = 25 + ((col * 3 + row * 7) % 40);

      tiles.push({ cx, cy, band, decor, phase, baseHue });
    }
  }
}

function fireBeat(): void {
  shimmerR = 0;
  shimmerActive = true;
  hueShift = (hueShift + 22) % 360;
}

export function drawKlimt(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  // Tile size: slider 0 = large tiles, slider 1 = small tesserae
  const minTs = isMobile ? 42 : 26;
  const maxTs = isMobile ? 88 : 72;
  const tileSize = Math.round(maxTs - config.klimtTileSize * (maxTs - minTs));

  if (tileSize !== lastTileSize || p.width !== lastW || p.height !== lastH) {
    buildTiles(p, tileSize);
    lastTileSize = tileSize;
    lastW = p.width;
    lastH = p.height;
    shimmerMaxR = Math.sqrt(p.width * p.width + p.height * p.height) * 0.52;
  }

  // Beat detection — BPM-driven with mic/interactive fallback
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const idx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (idx >= 0 && idx !== lastBeat) {
      lastBeat = idx;
      fireBeat();
    }
  } else {
    const totalAmp = amps.reduce((a: number, b: number) => a + b, 0) / BAND_COUNT;
    if (totalAmp > micPrevAmp * 1.55 + 0.1 && totalAmp > 0.25) {
      fireBeat();
    }
    micPrevAmp = micPrevAmp * 0.94 + totalAmp * 0.06;
  }

  // Expand shimmer ring at a pace proportional to canvas diagonal
  if (shimmerActive) {
    shimmerR += 0.055 * dt * shimmerMaxR;
    if (shimmerR > shimmerMaxR + tileSize * 3) {
      shimmerActive = false;
      shimmerR = 0;
    }
  }

  // Very dark warm brown-black background
  p.background(9, 5, 2);

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);

  const gold: number = config.klimtGold;
  const complexity: number = config.klimtComplexity;
  const halfW = p.width * 0.5;
  const halfH = p.height * 0.5;

  for (const tile of tiles) {
    const amp: number = amps[tile.band];

    // Shimmer ring falloff — tiles near the expanding ring get a brightness surge
    const dx = tile.cx - halfW;
    const dy = tile.cy - halfH;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const shimmerFac: number = shimmerActive
      ? Math.max(0, 1 - Math.abs(dist - shimmerR) / (tileSize * 2.2))
      : 0;

    const hue: number = (tile.baseHue + hueShift + amp * 14) % 360;
    const sat: number = 48 + gold * 46 + amp * 7;
    const bri: number = 16 + gold * 20 + amp * 52 + shimmerFac * 58;
    const alpha: number = 62 + amp * 38 + shimmerFac * 28;

    p.push();
    p.translate(tile.cx, tile.cy);
    drawDecor(p, tile.decor, tileSize, hue, sat, bri, alpha, amp, complexity, tile.phase);
    p.pop();
  }

  (p as any).colorMode(p['RGB'], 255);
}

function drawDecor(
  p: P5Instance,
  decor: number,
  size: number,
  hue: number,
  sat: number,
  bri: number,
  alpha: number,
  amp: number,
  complexity: number,
  phase: number
): void {
  const h = size * 0.46;
  const sw = 0.8 + amp * 1.8;

  // At low complexity only use the two simplest motifs (nested squares, circles)
  const type = complexity < 0.32 ? decor % 2 : decor;

  p.noFill();
  p.stroke(hue, sat, bri, alpha);
  p.strokeWeight(sw);

  switch (type) {
    case 0: {
      // Nested squares — Byzantine mosaic tile
      p.rect(-h, -h, h * 2, h * 2);
      if (complexity > 0.22) {
        const ih = h * 0.57;
        p.rect(-ih, -ih, ih * 2, ih * 2);
      }
      if (complexity > 0.62) {
        // Corner accent dots
        p.fill(hue, sat * 0.85, bri, alpha * 0.75);
        p.noStroke();
        const rd = h * 0.16;
        const off = h * 0.74;
        for (let sx = -1; sx <= 1; sx += 2) {
          for (let sy = -1; sy <= 1; sy += 2) {
            p.circle(sx * off, sy * off, rd * 2);
          }
        }
        p.noFill();
        p.stroke(hue, sat, bri, alpha);
        p.strokeWeight(sw);
      }
      break;
    }

    case 1: {
      // Circle with radiating spokes — solar / compass rose motif
      const r = h * (0.84 + amp * 0.16);
      p.circle(0, 0, r * 2);
      const spokeN = complexity < 0.48 ? 6 : 8 + Math.floor(complexity * 4);
      for (let i = 0; i < spokeN; i++) {
        const a = (i / spokeN) * Math.PI * 2 + phase * 0.06;
        const r0 = r * 0.40;
        p.line(r0 * Math.cos(a), r0 * Math.sin(a), r * Math.cos(a), r * Math.sin(a));
      }
      if (complexity > 0.58) {
        p.fill(hue, sat, bri, alpha * 0.68);
        p.noStroke();
        p.circle(0, 0, r * 0.28);
        p.noFill();
        p.stroke(hue, sat, bri, alpha);
        p.strokeWeight(sw);
      }
      break;
    }

    case 2: {
      // Almond eye — Klimt's mandorla / Byzantine vesica piscis
      const rw = h * (0.92 + amp * 0.10);
      const rh = h * (0.46 + amp * 0.08);
      p.ellipse(0, 0, rw * 2, rh * 2);
      if (complexity > 0.42) {
        p.fill(hue, sat * 0.72, bri * 0.65, alpha * 0.52);
        p.noStroke();
        p.ellipse(0, 0, rw * 0.38, rh * 0.46);
        p.noFill();
        p.stroke(hue, sat, bri, alpha);
        p.strokeWeight(sw);
      }
      break;
    }

    case 3: {
      // Equilateral triangle (optionally doubled for Star of David-like form)
      const ts = h * (0.86 + amp * 0.14);
      const apex = ts;
      const base = ts * 0.577;
      p.triangle(0, -apex, -apex * 0.866, base, apex * 0.866, base);
      if (complexity > 0.52) {
        // Inverted inner triangle
        const ts2 = ts * 0.50;
        const apex2 = ts2;
        const base2 = ts2 * 0.577;
        p.triangle(0, apex2, -apex2 * 0.866, -base2, apex2 * 0.866, -base2);
      }
      break;
    }

    default: {
      // Archimedean spiral — Art Nouveau / Celtic swirl
      const turns = 0.7 + complexity * 1.8;
      const steps = Math.floor(18 + complexity * 28);
      p.beginShape();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = t * turns * Math.PI * 2 + phase;
        const r = t * h * (0.88 + amp * 0.12);
        p.vertex(r * Math.cos(a), r * Math.sin(a));
      }
      p.endShape();
      break;
    }
  }

  // Bloom halo — soft additive glow ring at higher amplitudes
  if (amp > 0.22 && complexity > 0.18) {
    p.noFill();
    p.stroke(hue, sat * 0.55, bri, alpha * 0.22 * amp);
    p.strokeWeight(sw * 4);
    p.circle(0, 0, size * 0.7 + amp * size * 0.28);
  }
}
