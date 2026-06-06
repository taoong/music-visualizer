/**
 * Knot — Torus knot mathematical visualization.
 *
 * Inspired by George W. Hart's topological mathematical sculptures at the
 * Bridges Conference on Mathematical Art (2017):
 * https://gallery.bridgesmathart.org/exhibitions/2017-bridges-conference/george-hart
 *
 * Three interleaved strands trace a torus knot T(2, q) in 3D space, rendered
 * as neon-glowing curves via perspective projection in pure p5.js 2D canvas
 * — no Three.js required. Each strand is colored by a different frequency
 * register (sub+bass → violet, mid → teal, high → amber). The Topology slider
 * sweeps q from trefoil (3) to septafoil (7). Beats fire angular impulses and
 * shift the colour palette; amplitude inflates the torus radii. Three-pass
 * phosphor glow (outer/mid/core) gives the appearance of glowing rope coiling
 * through space.
 *
 * Sliders
 *   Topology — q winding number (3 = trefoil, 5 = cinquefoil, 7 = septafoil)
 *   Glow     — neon glow intensity
 *   Speed    — camera orbit and rotation speed
 */

import { store } from '../state/store';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

const CURVE_PTS = isMobile ? 150 : 300;
const TWO_PI = Math.PI * 2;

// Base hues per strand: violet (sub/bass), teal (mid), amber (high)
const STRAND_BASE_HUES: [number, number, number] = [270, 170, 35];

let angleY = 0;
let angleX = 0.35;
let angVelY = 0;
let hueShift = 0;
let lastBeatIndex = -1;
let flashAlpha = 0;

// Parametric torus knot T(2, q): two loops around the symmetry axis,
// q loops around the tube.
function knotPoint(t: number, q: number, R: number, r: number): [number, number, number] {
  const theta = 2 * t;
  const phi = q * t;
  const cosPhi = Math.cos(phi);
  return [
    (R + r * cosPhi) * Math.cos(theta),
    (R + r * cosPhi) * Math.sin(theta),
    r * Math.sin(phi),
  ];
}

// Rotate around Y then X axis
function rotateYX(x: number, y: number, z: number, ay: number, ax: number): [number, number, number] {
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const rx = x * cy + z * sy;
  const rz = z * cy - x * sy;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const ry = y * cx - rz * sx;
  const rz2 = y * sx + rz * cx;
  return [rx, ry, rz2];
}

// Perspective projection from 3D to 2D screen coordinates
function project(x: number, y: number, z: number, fov: number, cx: number, cy: number): [number, number] {
  const d = fov / (z + fov * 2.2);
  return [cx + x * d, cy - y * d];
}

export function drawKnots(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const knotsTopology = config.knotsTopology; // 3→7
  const knotsGlow = config.knotsGlow;         // 0→2
  const knotsSpeed = config.knotsSpeed;       // 0→2

  // Beat detection
  if (state.beatIntervalSec > 0) {
    const playPos = state.isPlaying
      ? (performance.now() / 1000 - state.playStartedAt / 1000 + state.startOffset)
      : state.startOffset;
    const beatIdx = Math.floor((playPos - state.beatOffset) / state.beatIntervalSec);
    if (beatIdx > lastBeatIndex && lastBeatIndex >= 0) {
      angVelY += 0.15 + Math.random() * 0.12;
      hueShift = (hueShift + 40 + Math.random() * 50) % 360;
      flashAlpha = 35;
    }
    lastBeatIndex = beatIdx;
  }

  // Update rotation
  const avgAmp = amps.reduce((s, v) => s + v, 0) / BAND_COUNT;
  angVelY *= Math.pow(0.88, dt);
  angleY += (0.0025 * knotsSpeed + angVelY * 0.01 + avgAmp * 0.002) * dt;
  // Gentle wobble on tilt angle for natural feel
  angleX = 0.35 + Math.sin(angleY * 0.07) * 0.12;
  flashAlpha *= Math.pow(0.90, dt);

  const w = p.width, h = p.height;
  const cx = w / 2, cy = h / 2;
  const minDim = Math.min(w, h);
  const fov = minDim * 0.9;

  // Audio-reactive torus radii: bass drives overall size, sub drives tube girth
  const R = minDim * 0.22 + avgAmp * minDim * 0.04;
  const r = minDim * 0.09 + amps[1] * minDim * 0.025;

  // Background fade to leave a subtle trail
  p.background(5, 5, 12, 25);

  // White flash on beat
  if (flashAlpha > 1) {
    p.noStroke();
    p.fill(210, 210, 255, flashAlpha * 0.6);
    p.rect(0, 0, w, h);
  }

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.noFill();

  // Per-strand amplitude groups
  const strandAmps = [
    (amps[0] + amps[1]) / 2,
    (amps[2] + amps[3]) / 2,
    (amps[4] + amps[5] + amps[6]) / 3,
  ];

  // Three strands: equally spaced phase offsets along the knot curve.
  // For T(2,3) this creates a classic 3-strand braid; for other q the
  // interleaving shifts in musically interesting ways.
  const phaseOffsets: [number, number, number] = [0, TWO_PI / 3, (TWO_PI * 2) / 3];

  // Precompute projected 2D points for each strand once per frame
  const strandPts: Array<[number, number][]> = [];
  for (let s = 0; s < 3; s++) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= CURVE_PTS; i++) {
      const t = (i / CURVE_PTS) * TWO_PI + phaseOffsets[s];
      const [x3, y3, z3] = knotPoint(t, knotsTopology, R, r);
      const [rx, ry, rz] = rotateYX(x3, y3, z3, angleY, angleX);
      pts.push(project(rx, ry, rz, fov, cx, cy));
    }
    strandPts.push(pts);
  }

  // 3-pass glow: outer (thick+dim) → mid → core (thin+bright)
  const g = knotsGlow;
  const passParams: Array<{ weight: number; alpha: number }> = [
    { weight: 7 + g * 10,  alpha: 12 + g * 18 }, // outer glow
    { weight: 3 + g * 4,   alpha: 28 + g * 30 }, // mid glow
    { weight: 1.2,         alpha: 65 + g * 35 }, // core
  ];

  for (let pass = 0; pass < 3; pass++) {
    const { weight, alpha } = passParams[pass];
    p.strokeWeight(weight);

    for (let s = 0; s < 3; s++) {
      const pts = strandPts[s];
      const amp = strandAmps[s];
      const baseHue = (STRAND_BASE_HUES[s] + hueShift) % 360;
      const sat = 70 + amp * 30;
      const bri = 40 + amp * 60;

      for (let i = 0; i < pts.length - 1; i++) {
        // 60° hue gradient along the strand for iridescent ribbon look
        const hue = (baseHue + (i / CURVE_PTS) * 60 - 30 + 360) % 360;
        p.stroke(hue, sat, bri, alpha);
        p.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      }
    }
  }

  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}

export function resetKnots(): void {
  angleY = 0;
  angleX = 0.35;
  angVelY = 0;
  hueShift = 0;
  lastBeatIndex = -1;
  flashAlpha = 0;
}
