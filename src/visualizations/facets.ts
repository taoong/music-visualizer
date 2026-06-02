/**
 * Facets — Crystalline gem visualization.
 *
 * Inspired by Quayola's "Strata" series (2010–)
 * https://quayola.com/strata/
 *
 * A jittered triangular mesh spans the full canvas. Each facet's hue maps to
 * one of 7 frequency bands (amethyst → sapphire → aquamarine → emerald →
 * topaz → amber → ruby, left to right). Two slowly orbiting virtual light
 * sources sweep caustic highlights across the surface — a large soft fill
 * light plus a tight, fast-moving specular spot. Perlin noise undulates every
 * vertex continuously; audio amplitude raises each band's facets from dark to
 * brilliant. Beats burst all vertices radially outward then spring back, and
 * flash the whole surface blue-white.
 *
 * Sliders
 *   Density — grid resolution (few large facets ↔ many small facets)
 *   Shimmer — vertex displacement amplitude (subtle breathing ↔ wild deformation)
 *   Glow    — wireframe edge brightness
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Gem hues per band: amethyst, sapphire, aquamarine, emerald, topaz, amber, ruby
const GEM_HUES: readonly number[] = [280, 220, 185, 140, 55, 30, 0];

interface Vertex {
  x: number; y: number;    // current position
  ox: number; oy: number;  // base (jittered grid) position
  nx: number; ny: number;  // Perlin noise seeds
  bvx: number; bvy: number; // beat burst velocity
}

type Tri = readonly [number, number, number];

let verts: Vertex[] = [];
let tris: Tri[] = [];
let lastW = 0;
let lastH = 0;
let lastDensity = -1;
let hueShift = 0;
let flashAlpha = 0;
let lastBeatIndex = -1;

export function resetFacets(): void {
  verts = [];
  tris = [];
  lastW = 0;
  lastH = 0;
  lastDensity = -1;
  hueShift = 0;
  flashAlpha = 0;
  lastBeatIndex = -1;
}

function buildMesh(W: number, H: number, density: number): void {
  // cellSize: large = few big facets, small = many fine facets
  const maxCell = isMobile ? 85 : 75;
  const minCell = isMobile ? 38 : 24;
  const cellSize = maxCell - density * (maxCell - minCell);

  const cols = Math.ceil(W / cellSize) + 1;
  const rows = Math.ceil(H / cellSize) + 1;

  verts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bx = c * cellSize;
      const by = r * cellSize;
      // Random jitter breaks the grid regularity for a natural lowpoly look
      const jx = (Math.random() - 0.5) * cellSize * 0.38;
      const jy = (Math.random() - 0.5) * cellSize * 0.38;
      verts.push({
        x: bx + jx, y: by + jy,
        ox: bx + jx, oy: by + jy,
        nx: Math.random() * 300,
        ny: Math.random() * 300 + 300,
        bvx: 0, bvy: 0,
      });
    }
  }

  tris = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i0 = r * cols + c;
      const i1 = r * cols + c + 1;
      const i2 = (r + 1) * cols + c;
      const i3 = (r + 1) * cols + c + 1;
      // Alternate diagonal direction between cells for a more organic tessellation
      if ((r + c) % 2 === 0) {
        tris.push([i0, i1, i3]);
        tris.push([i0, i3, i2]);
      } else {
        tris.push([i0, i1, i2]);
        tris.push([i1, i3, i2]);
      }
    }
  }

  lastW = W;
  lastH = H;
  lastDensity = density;
}

export function drawFacets(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);
  const W = p.width;
  const H = p.height;
  const density = config.facetsDensity;

  // Rebuild mesh when canvas size or density changes significantly
  if (verts.length === 0 || lastW !== W || lastH !== H ||
      Math.abs(lastDensity - density) > 0.04) {
    buildMesh(W, H, density);
  }

  // Beat detection — burst + flash
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bidx = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bidx >= 0 && bidx !== lastBeatIndex) {
      lastBeatIndex = bidx;
      hueShift = (hueShift + 22 + Math.floor(amps[0] * 40)) % 360;
      flashAlpha = 0.45 + amps[0] * 0.35;
      const cx = W * 0.5;
      const cy = H * 0.5;
      const burstStr = 7 + amps[0] * 22;
      for (const v of verts) {
        const dx = v.ox - cx;
        const dy = v.oy - cy;
        const len = Math.sqrt(dx * dx + dy * dy) + 0.5;
        v.bvx = (dx / len) * burstStr * (0.5 + Math.random() * 0.9);
        v.bvy = (dy / len) * burstStr * (0.5 + Math.random() * 0.9);
      }
    }
  }

  flashAlpha *= Math.pow(0.84, dt);

  const shimmerAmt = config.facetsShimmer * (isMobile ? 11 : 17);
  const t = p.frameCount * 0.0024;
  const beatDecay = Math.pow(0.88, dt);
  const springK = 0.020 * dt;

  // Update vertex positions: Perlin noise + audio-reactive wiggle + beat spring
  for (const v of verts) {
    const band = Math.min(BAND_COUNT - 1, Math.floor((v.ox / W) * BAND_COUNT));
    const audioWiggle = amps[band] * shimmerAmt;

    // Spring toward rest
    v.bvx += (0 - v.bvx) * springK;
    v.bvy += (0 - v.bvy) * springK;
    v.bvx *= beatDecay;
    v.bvy *= beatDecay;

    v.x = v.ox
      + (p.noise(v.nx, t) * 2 - 1) * shimmerAmt * 0.55
      + (p.noise(v.nx + 500, t * 1.3) * 2 - 1) * audioWiggle * 0.85
      + v.bvx;
    v.y = v.oy
      + (p.noise(v.ny, t + 40) * 2 - 1) * shimmerAmt * 0.48
      + (p.noise(v.ny + 500, t * 1.3 + 40) * 2 - 1) * audioWiggle * 0.70
      + v.bvy;
  }

  // Two orbiting virtual light sources
  const lt = p.frameCount * 0.0038;
  // Large fill light — slow, wide orbit
  const l1x = W * (0.5 + Math.cos(lt) * 0.40);
  const l1y = H * (0.5 + Math.sin(lt * 0.63) * 0.32);
  const l1r = Math.max(W, H) * 0.55;
  // Tight specular spot — faster, tighter orbit
  const l2x = W * (0.5 + Math.cos(lt * 1.9 + 1.1) * 0.28);
  const l2y = H * (0.5 + Math.sin(lt * 2.3 + 0.7) * 0.22);
  const l2r = Math.max(W, H) * 0.20;

  const glowStr = config.facetsGlow;

  p.background(5, 2, 8);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noStroke();

  // ── Fill pass ──────────────────────────────────────────────────────────────
  for (let ti = 0; ti < tris.length; ti++) {
    const [i0, i1, i2] = tris[ti];
    const v0 = verts[i0];
    const v1 = verts[i1];
    const v2 = verts[i2];

    const cx = (v0.x + v1.x + v2.x) / 3;
    const cy = (v0.y + v1.y + v2.y) / 3;

    const band = Math.min(BAND_COUNT - 1, Math.floor((cx / W) * BAND_COUNT));
    const amp = amps[band];

    // Large fill light contribution (soft quadratic falloff)
    const d1 = Math.sqrt((cx - l1x) * (cx - l1x) + (cy - l1y) * (cy - l1y));
    const l1fac = Math.max(0, 1 - d1 / l1r) ** 2 * 38;

    // Tight specular highlight (sharper falloff)
    const d2 = Math.sqrt((cx - l2x) * (cx - l2x) + (cy - l2y) * (cy - l2y));
    const l2fac = Math.max(0, 1 - d2 / l2r) ** 3 * 32;

    const hue = (GEM_HUES[band] + hueShift) % 360;
    const sat = 62 + amp * 30;
    const bri = 8 + amp * 54 + l1fac + l2fac;

    p.fill(hue, sat, Math.min(bri, 97));
    p.triangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);
  }

  // ── Wireframe glow ──────────────────────────────────────────────────────────
  if (glowStr > 0.02) {
    p.noFill();

    // Pass 1: wide outer halo
    p.strokeWeight(2.8 * glowStr);
    for (let ti = 0; ti < tris.length; ti++) {
      const [i0, i1, i2] = tris[ti];
      const v0 = verts[i0];
      const v1 = verts[i1];
      const v2 = verts[i2];
      const cx = (v0.x + v1.x + v2.x) / 3;
      const band = Math.min(BAND_COUNT - 1, Math.floor((cx / W) * BAND_COUNT));
      const hue = (GEM_HUES[band] + hueShift) % 360;
      const a = (10 + amps[band] * 28) * glowStr;
      p.stroke(hue, 50, 88, Math.min(a, 70));
      p.triangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);
    }

    // Pass 2: bright core line
    p.strokeWeight(0.75 * glowStr);
    for (let ti = 0; ti < tris.length; ti++) {
      const [i0, i1, i2] = tris[ti];
      const v0 = verts[i0];
      const v1 = verts[i1];
      const v2 = verts[i2];
      const cx = (v0.x + v1.x + v2.x) / 3;
      const band = Math.min(BAND_COUNT - 1, Math.floor((cx / W) * BAND_COUNT));
      const hue = (GEM_HUES[band] + hueShift) % 360;
      const a = (30 + amps[band] * 58) * glowStr;
      p.stroke(hue, 35, 100, Math.min(a, 94));
      p.triangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);
    }

    p.noStroke();
  }

  // ── Beat flash overlay ──────────────────────────────────────────────────────
  if (flashAlpha > 0.01) {
    (p as any).colorMode(p['RGB'], 255);
    p.noStroke();
    p.fill(195, 215, 255, flashAlpha * 185);
    p.rect(0, 0, W, H);
  }

  (p as any).colorMode(p['RGB'], 255);
}
