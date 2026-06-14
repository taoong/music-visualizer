/**
 * Light Field — a suspended cubic lattice of glowing points through which
 * ripples of color travel, evoking Squidsoup's "Submergence" (2012– ), an
 * immersive field of over 8,000 individually addressable LED points
 * suspended in a dark room that visitors walk through as slow waves of
 * light drift past.
 * https://www.squidsoup.org/portfolio/submergence-2/
 * https://www.thisiscolossal.com/2013/01/submergence-an-immersive-field-of-8064-suspended-lights-by-squidsoup/
 *
 * A grid of points floats in 3D space, gently orbited by the camera and
 * drifting on Perlin noise for a weightless, underwater feel. Each of the 7
 * frequency bands drives a plane wave of brightness that sweeps through the
 * lattice along its own axis — sub-bass along X, bass vertically, low-mid in
 * depth, and the upper bands along diagonals at increasing spatial
 * frequency, so brilliance ripples through in fine detail. Beats fire a
 * spherical pulse that expands outward from the centre of the lattice
 * through the whole volume, briefly flaring every point it passes and
 * warming its hue.
 *
 * Sliders
 *   Grid — lattice density (a few floating points -> a dense starfield)
 *   Flow — wave speed through the lattice, drift turbulence, and camera orbit
 *   Glow — halo brightness around each point
 */
import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// Lattice density range (points per axis); the depth axis uses ~60% of this
const MIN_AXIS = 3;
const MAX_AXIS = isMobile ? 6 : 10;

// Per-band wave direction (normalized) and spatial frequency: sub-bass
// sweeps along X at the lowest frequency, brilliance ripples along the full
// diagonal at the highest frequency.
const WAVE_DIRS: readonly [number, number, number][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.7071, 0.7071, 0],
  [0, 0.7071, 0.7071],
  [0.7071, 0, 0.7071],
  [0.5774, 0.5774, 0.5774],
];
const WAVE_FREQ: readonly number[] = [1.4, 1.9, 2.4, 3.0, 3.6, 4.3, 5.2];

// Per-band hue: deep ocean blue (sub-bass) -> cyan -> violet/magenta (brilliance)
const BAND_HUES: readonly number[] = [225, 210, 196, 184, 172, 250, 286];

const PULSE_WIDTH = 0.32;
const CAM_DIST = 3.6;
const TILT = 0.4;

let camAngle = 0;
let driftTime = 0;
const phases = new Float32Array(BAND_COUNT);
let lastBeatIdx = -1;
let pulseTime = 999;
let pulseEnergy = 0;

export function resetLightField(): void {
  camAngle = 0;
  driftTime = Math.random() * 1000;
  phases.fill(0);
  lastBeatIdx = -1;
  pulseTime = 999;
  pulseEnergy = 0;
}

export function drawLightField(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps } = getBandAverages(BAND_COUNT);

  const W = p.width;
  const H = p.height;

  const gridAmt = config.lightfieldGrid; // 0-1
  const flow = config.lightfieldFlow;    // 0-1
  const glow = config.lightfieldGlow;    // 0-2

  const axis = Math.round(MIN_AXIS + gridAmt * (MAX_AXIS - MIN_AXIS));
  const nx = axis;
  const ny = axis;
  const nz = Math.max(2, Math.round(axis * 0.6));

  // ── beat: fire an expanding spherical pulse through the lattice ──────────
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos = audioEngine.getPlaybackPosition();
    const adj = pos - state.beatOffset;
    const bi = adj >= 0 ? Math.floor(adj / state.beatIntervalSec) : -1;
    if (bi >= 0 && bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      pulseTime = 0;
      pulseEnergy = 1;
    }
  }
  pulseTime += dt;
  pulseEnergy *= Math.pow(0.95, dt);
  const pulseRadius = pulseTime * (0.045 + flow * 0.08);

  // ── per-band wave phases, drift, and camera orbit ─────────────────────────
  for (let b = 0; b < BAND_COUNT; b++) {
    phases[b] += dt * (0.02 + flow * 0.08) * (0.5 + amps[b] * 1.5);
  }
  driftTime += dt * (0.002 + flow * 0.01);
  camAngle += dt * (0.0012 + flow * 0.003);

  const jitterAmt = 0.03 + flow * 0.12;
  const cosA = Math.cos(camAngle);
  const sinA = Math.sin(camAngle);
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  const scale = Math.min(W, H) * 0.34;

  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.background(224, 65, 3);
  p.noStroke();
  p.blendMode(p['ADD']);

  for (let i = 0; i < nx; i++) {
    const bx = (i / (nx - 1)) * 2 - 1;
    for (let j = 0; j < ny; j++) {
      const by = (j / (ny - 1)) * 2 - 1;
      for (let k = 0; k < nz; k++) {
        const bz = (k / (nz - 1)) * 2 - 1;

        const n1 = p.noise(i * 0.37, j * 0.37 + 4.1, driftTime) - 0.5;
        const n2 = p.noise(j * 0.37 + 50.3, k * 0.37 + 8.7, driftTime) - 0.5;
        const n3 = p.noise(k * 0.37 + 100.9, i * 0.37 + 17.2, driftTime) - 0.5;

        const wx = bx + n1 * jitterAmt;
        const wy = by + n2 * jitterAmt;
        const wz = bz + n3 * jitterAmt;

        // ── per-band plane waves ───────────────────────────────────────────
        let energy = 0;
        let bestBand = 0;
        let bestVal = -1;
        for (let b = 0; b < BAND_COUNT; b++) {
          const dir = WAVE_DIRS[b];
          const d = wx * dir[0] + wy * dir[1] + wz * dir[2];
          const wave = Math.sin(d * WAVE_FREQ[b] - phases[b]) * 0.5 + 0.5;
          const contrib = wave * amps[b];
          energy += contrib;
          if (contrib > bestVal) {
            bestVal = contrib;
            bestBand = b;
          }
        }
        energy /= BAND_COUNT;

        // ── beat pulse shell ────────────────────────────────────────────────
        const dist = Math.sqrt(wx * wx + wy * wy + wz * wz);
        const pd = Math.abs(dist - pulseRadius);
        const pulseAmt = pd < PULSE_WIDTH ? (1 - pd / PULSE_WIDTH) * pulseEnergy : 0;

        // ── project 3D -> 2D (orbiting camera with fixed tilt) ──────────────
        const rx = wx * cosA + wz * sinA;
        const rzA = -wx * sinA + wz * cosA;
        const ry = wy * cosT - rzA * sinT;
        const rz = wy * sinT + rzA * cosT;
        const persp = CAM_DIST / (CAM_DIST + rz);
        const sx = W / 2 + rx * persp * scale;
        const sy = H / 2 - ry * persp * scale;

        // ── color & size ─────────────────────────────────────────────────
        let bri = 6 + energy * 170 + pulseAmt * 75 + n1 * 5;
        bri = Math.max(2, Math.min(100, bri));
        const sat = Math.max(15, 70 - bri * 0.45);
        const hue = (BAND_HUES[bestBand] + pulseAmt * 40) % 360;
        const size = (1.0 + energy * 3.2 + pulseAmt * 2.5) * persp;

        // 3-pass additive glow: outer halo, mid bloom, bright core
        p.fill(hue, sat, bri, Math.min(100, bri * 0.10 * glow));
        p.circle(sx, sy, size * 6);
        p.fill(hue, sat, bri, Math.min(100, bri * 0.32 * glow));
        p.circle(sx, sy, size * 2.4);
        p.fill(hue, sat * 0.6, Math.min(100, bri * 1.2), Math.min(100, bri));
        p.circle(sx, sy, size);
      }
    }
  }

  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
