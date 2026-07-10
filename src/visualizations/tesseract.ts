/**
 * Tesseract — Rotating 4D Hypercube Wireframe
 *
 * Inspired by Tony Robbin's "Fourfield: Computers, Art and the 4th Dimension"
 * (1992, https://www.tonyrobbin.net/fourfield.htm) and Henry Segerman's
 * mathematical art visualizing 4D geometry via stereographic projection
 * (https://henryseg.github.io/). Up to 5 nested 4D hypercubes (tesseracts)
 * rotate simultaneously in 4D space — the 6 rotation planes (XY, XZ, XW,
 * YZ, YW, ZW) are each driven by a different frequency band, creating
 * impossible-looking inner-through-outer "phase-passing" projections unique
 * to 4D geometry. Neon 3-pass glow per edge; vertex nodes at each projected
 * corner; beats fire angular impulses.
 *
 * Sliders: Layers (1–5 nested cubes), Spin (rotation speed), Glow (neon intensity)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Tesseract geometry ─────────────────────────────────────────────────────

// 16 vertices of the unit 4D hypercube at (±1, ±1, ±1, ±1)
const VERTS: readonly [number, number, number, number][] = (() => {
  const v: [number, number, number, number][] = [];
  for (let i = 0; i < 16; i++) {
    v.push([
      (i & 1) ? 1 : -1,
      (i & 2) ? 1 : -1,
      (i & 4) ? 1 : -1,
      (i & 8) ? 1 : -1,
    ]);
  }
  return v;
})();

// 32 edges: pairs of vertices differing in exactly one coordinate bit
const EDGES: readonly [number, number][] = (() => {
  const e: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const diff = i ^ j;
      // exactly one bit set → adjacent vertices
      if (diff !== 0 && (diff & (diff - 1)) === 0) {
        e.push([i, j]);
      }
    }
  }
  return e;
})();

// 6 rotation planes in 4D: each entry is [axis_a, axis_b]
// XY=0, XZ=1, XW=2, YZ=3, YW=4, ZW=5
const PLANES: readonly [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];

// Natural drift angular velocities (rad / dt-unit) for each rotation plane
const PLANE_DRIFT: readonly number[] = [0.0010, 0.0014, 0.0008, 0.0012, 0.0009, 0.0011];

// HSB hue per layer: violet → blue → teal → lime → magenta (inner → outer)
const LAYER_HUES: readonly number[] = [280, 210, 170, 100, 320];

// Size of each nested layer as fraction of the base canvas radius
const LAYER_SCALES: readonly number[] = [0.35, 0.52, 0.68, 0.84, 1.0];

// Phase offsets so nested layers rotate at slightly different speeds
const LAYER_PHASE: readonly number[] = [0, 0.18, -0.12, 0.25, -0.08];

const MAX_LAYERS = 5;

// ── Module-level state ─────────────────────────────────────────────────────

let planeAngles     = new Float32Array(6);
let planeVelocities = new Float32Array(6);
let initialised     = false;
let lastBeatIndex   = -1;

// Preallocated scratch buffers — reused every frame to avoid GC pressure
const scratch4D = new Float32Array(4);
const projX     = new Float32Array(16);
const projY     = new Float32Array(16);
const projZ3D   = new Float32Array(16); // z after 4D→3D step, used for depth-dimming
const planeCos  = new Float32Array(6);
const planeSin  = new Float32Array(6);

export function resetTesseract(): void {
  for (let i = 0; i < 6; i++) {
    planeAngles[i]     = Math.random() * Math.PI * 2;
    planeVelocities[i] = PLANE_DRIFT[i];
  }
  initialised   = true;
  lastBeatIndex = -1;
}

// ── Projection helper ──────────────────────────────────────────────────────

/**
 * Project all 16 tesseract vertices for one layer into projX/projY/projZ3D.
 * planeCos / planeSin must already be set for this layer's angles.
 */
function projectLayer(cx: number, cy: number, radius: number, w4d: number, z3d: number): void {
  for (let vi = 0; vi < 16; vi++) {
    const vert = VERTS[vi];
    scratch4D[0] = vert[0];
    scratch4D[1] = vert[1];
    scratch4D[2] = vert[2];
    scratch4D[3] = vert[3];

    // Apply all 6 rotation planes sequentially
    for (let pl = 0; pl < 6; pl++) {
      const a = PLANES[pl][0];
      const b = PLANES[pl][1];
      const va = scratch4D[a] * planeCos[pl] - scratch4D[b] * planeSin[pl];
      const vb = scratch4D[a] * planeSin[pl] + scratch4D[b] * planeCos[pl];
      scratch4D[a] = va;
      scratch4D[b] = vb;
    }

    // 4D → 3D perspective division
    const d4 = w4d - scratch4D[3];
    const x3 = scratch4D[0] / d4;
    const y3 = scratch4D[1] / d4;
    const z3 = scratch4D[2] / d4;

    // 3D → 2D perspective division
    const d3 = z3d - z3;
    projX[vi]   = cx + (x3 / d3) * radius * z3d;
    projY[vi]   = cy + (y3 / d3) * radius * z3d;
    projZ3D[vi] = z3;
  }
}

// ── Draw ───────────────────────────────────────────────────────────────────

export function drawTesseract(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const layerCount = Math.max(1, Math.min(MAX_LAYERS, Math.round(config.tesseractLayers)));
  const spinSpeed  = config.tesseractSpin;
  const glow       = config.tesseractGlow;

  if (!initialised) resetTesseract();

  // ── Beat detection ──────────────────────────────────────────────────────
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      onBeat        = true;
    }
  }

  // ── Update rotation velocities (one set shared across all layers) ───────
  for (let pl = 0; pl < 6; pl++) {
    const bandIdx = Math.min(pl, BAND_COUNT - 1);
    const amp     = amps[bandIdx];

    // Audio energy nudges the plane's rotation faster
    planeVelocities[pl] += amp * 0.005 * spinSpeed * dt;

    // Soft relaxation back to natural drift speed
    const target = PLANE_DRIFT[pl] * spinSpeed;
    planeVelocities[pl] += (target - planeVelocities[pl]) * 0.02 * dt;

    // Beat impulse: alternate CW/CCW per plane for visual contrast
    if (onBeat) {
      const dir = (pl % 2 === 0) ? 1 : -1;
      planeVelocities[pl] += 0.06 * dir * Math.min(2, transients[bandIdx]);
    }

    planeAngles[pl] += planeVelocities[pl] * dt;
  }

  // ── Clear ───────────────────────────────────────────────────────────────
  p.background(0);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.blendMode(p['ADD']);
  p.noFill();

  const cx    = p.width  * 0.5;
  const cy    = p.height * 0.5;
  const baseR = Math.min(p.width, p.height) * 0.38;
  const w4d   = 2.5;  // 4D viewer distance
  const z3d   = 2.5;  // 3D viewer distance

  const glowPasses = isMobile ? 2 : 3;

  // ── Draw layers (innermost first so outer layers render on top) ─────────
  for (let li = 0; li < layerCount; li++) {
    const hue      = LAYER_HUES[li];
    const radius   = baseR * LAYER_SCALES[li];
    const phaseOff = LAYER_PHASE[li];
    const bandIdx  = li % BAND_COUNT;
    const amp      = Math.min(1, amps[bandIdx] * 1.4);
    const tMult    = Math.min(2, transients[bandIdx]);

    // Precompute cos/sin for this layer's rotated angles (12 trig calls per layer)
    for (let pl = 0; pl < 6; pl++) {
      const theta    = planeAngles[pl] + phaseOff;
      planeCos[pl]   = Math.cos(theta);
      planeSin[pl]   = Math.sin(theta);
    }

    // Project all 16 vertices into projX / projY / projZ3D
    projectLayer(cx, cy, radius * (1 + amp * 0.12), w4d, z3d);

    const bright    = Math.min(100, 48 + amp * 42 + (tMult - 1) * 18);
    const baseAlpha = 30 + amp * 35;
    const swBase    = Math.max(0.4, (p.width / 900) * (0.75 + glow * 0.45));

    // ── Edges ─────────────────────────────────────────────────────────────
    for (let ei = 0; ei < EDGES.length; ei++) {
      const a = EDGES[ei][0];
      const b = EDGES[ei][1];
      const ax = projX[a], ay = projY[a], az = projZ3D[a];
      const bx = projX[b], by = projY[b], bz = projZ3D[b];

      // Depth factor: edges toward viewer are brighter
      const depthFac = 0.28 + ((az + bz) * 0.5 + 1) * 0.36;
      const alpha    = depthFac * baseAlpha;

      if (glowPasses >= 3) {
        // Wide outer halo
        p.strokeWeight(swBase * 5.5 * glow);
        p.stroke(hue, 90, bright, alpha * 0.055 * glow);
        p.line(ax, ay, bx, by);
      }

      // Mid-tone glow
      p.strokeWeight(swBase * 2.0);
      p.stroke(hue, 70, bright, alpha * 0.30);
      p.line(ax, ay, bx, by);

      // Bright core (slight hue shift for iridescence)
      p.strokeWeight(swBase * 0.85);
      p.stroke((hue + 22) % 360, 30, 100, alpha * 0.88);
      p.line(ax, ay, bx, by);
    }

    // ── Vertex nodes ───────────────────────────────────────────────────────
    p.noStroke();
    const nodeSz = (2.5 + amp * 3) * swBase;

    for (let vi = 0; vi < 16; vi++) {
      const vx = projX[vi];
      const vy = projY[vi];
      const vz = projZ3D[vi];
      const df = 0.28 + (vz + 1) * 0.36;
      const nA = df * (baseAlpha + 22);

      // Outer glow blob
      p.fill(hue, 75, bright, nA * 0.09 * glow);
      p.circle(vx, vy, nodeSz * 5 * glow);

      // Bright core dot
      p.fill((hue + 18) % 360, 22, 100, nA * 0.88);
      p.circle(vx, vy, nodeSz);
    }
    p.noFill();
  }

  // ── Restore rendering defaults ───────────────────────────────────────────
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
