/**
 * Geodesic — Audio-reactive nested wireframe crystal spheres.
 *
 * Inspired by teamLab's "Bubble Universe" (2024, Azabudai Hills, Tokyo):
 * https://www.teamlab.art/w/bubbleuniverse/
 * Crystalline light spheres organised by mathematical constraints. Here,
 * up to 5 nested icosahedral wireframe shells rotate independently — each
 * shell driven by a different audio frequency band — creating iridescent,
 * crystalline interference patterns. Neon glow rendered in 3 passes; vertex
 * nodes glow at each projected corner; beats fire angular impulses that
 * cause the shells to oscillate.
 *
 * Desktop: once-subdivided icosphere (120 edges/shell) for maximum richness.
 * Mobile:  base icosahedron (30 edges/shell) for performance.
 *
 * Sliders: Shells (1–5 nested spheres), Spin (rotation speed), Glow (neon intensity)
 */

import { store } from '../state/store';
import { audioEngine } from '../audio/engine';
import { getBandAverages } from './helpers';
import { BAND_COUNT, isMobile } from '../utils/constants';

// ── Icosahedron base geometry ──────────────────────────────────────────────

const PHI = (1 + Math.sqrt(5)) / 2;

// 12 vertices of a regular icosahedron projected onto the unit sphere
const ICO_VERTS: [number, number, number][] = (() => {
  const raw: [number, number, number][] = [
    [ 0,  1,  PHI], [ 0, -1,  PHI], [ 0,  1, -PHI], [ 0, -1, -PHI],
    [ 1,  PHI,  0], [-1,  PHI,  0], [ 1, -PHI,  0], [-1, -PHI,  0],
    [ PHI,  0,  1], [-PHI,  0,  1], [ PHI,  0, -1], [-PHI,  0, -1],
  ];
  return raw.map(([x, y, z]) => {
    const len = Math.sqrt(x * x + y * y + z * z);
    return [x / len, y / len, z / len];
  });
})();

// 20 triangular faces of the icosahedron (vertex-index triples)
const ICO_FACES: [number, number, number][] = [
  [0, 1, 8], [0, 1, 9], [0, 4, 5], [0, 4, 8], [0, 5, 9],
  [1, 6, 7], [1, 6, 8], [1, 7, 9],
  [2, 3, 10], [2, 3, 11], [2, 4, 5], [2, 4, 10], [2, 5, 11],
  [3, 6, 7], [3, 6, 10], [3, 7, 11],
  [4, 8, 10], [5, 9, 11],
  [6, 8, 10], [7, 9, 11],
];

// ── Geometry builder (optional subdivision) ────────────────────────────────

interface Geometry {
  verts: [number, number, number][];
  edges: [number, number][];
}

function buildGeometry(doSubdivide: boolean): Geometry {
  let verts: [number, number, number][] = [...ICO_VERTS];
  let faces: [number, number, number][] = [...ICO_FACES];

  if (doSubdivide) {
    const midMap = new Map<string, number>();

    const getMid = (a: number, b: number): number => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (midMap.has(key)) return midMap.get(key)!;
      const va = verts[a], vb = verts[b];
      const mx = (va[0] + vb[0]) * 0.5;
      const my = (va[1] + vb[1]) * 0.5;
      const mz = (va[2] + vb[2]) * 0.5;
      const len = Math.sqrt(mx * mx + my * my + mz * mz);
      const idx = verts.length;
      verts.push([mx / len, my / len, mz / len]);
      midMap.set(key, idx);
      return idx;
    };

    const subFaces: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
      subFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = subFaces;
  }

  // Extract unique edges from faces
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  for (const [a, b, c] of faces) {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = x < y ? `${x}-${y}` : `${y}-${x}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([x, y]);
      }
    }
  }

  return { verts, edges };
}

// Precompute once at module load: richer on desktop, lighter on mobile
const GEO: Geometry = buildGeometry(!isMobile);
const N_VERTS = GEO.verts.length;

// ── Shell constants ────────────────────────────────────────────────────────

const MAX_SHELLS = 5;

// HSB hues per shell: violet → blue → teal → green → yellow (innermost → outermost)
const SHELL_HUES   = [270, 210, 170, 120, 60] as const;

// Radius of each shell as a fraction of the canvas' shorter half-side
const SHELL_SCALES = [0.22, 0.36, 0.50, 0.65, 0.82] as const;

// Frequency band index that drives each shell
const SHELL_BANDS  = [0, 1, 2, 3, 4] as const;

// Natural drift angular velocities for each shell (rad/frame at dt = 1)
const SHELL_DRIFT: [number, number, number][] = [
  [ 0.0012,  0.0020,  0.0008],
  [-0.0009,  0.0015, -0.0006],
  [ 0.0007, -0.0018,  0.0011],
  [-0.0015,  0.0010,  0.0007],
  [ 0.0010, -0.0012, -0.0009],
];

// ── Module state ───────────────────────────────────────────────────────────

interface ShellState {
  rx: number; ry: number; rz: number; // Euler angles (radians)
  vx: number; vy: number; vz: number; // angular velocity (rad / dt-unit)
}

let shells: ShellState[] = [];
let lastBeatIndex = -1;

export function resetGeodesic(): void {
  shells = Array.from({ length: MAX_SHELLS }, (_, i) => ({
    rx: Math.random() * Math.PI * 2,
    ry: Math.random() * Math.PI * 2,
    rz: Math.random() * Math.PI * 2,
    vx: SHELL_DRIFT[i][0],
    vy: SHELL_DRIFT[i][1],
    vz: SHELL_DRIFT[i][2],
  }));
  lastBeatIndex = -1;
}

// ── 3-D rotation helpers ───────────────────────────────────────────────────

function rotX(v: [number, number, number], c: number, s: number): [number, number, number] {
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotY(v: [number, number, number], c: number, s: number): [number, number, number] {
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}
function rotZ(v: [number, number, number], c: number, s: number): [number, number, number] {
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

// ── Draw ───────────────────────────────────────────────────────────────────

export function drawGeodesic(p: P5Instance, dt: number): void {
  const { state, config } = store;
  const { amps, transients } = getBandAverages(BAND_COUNT);

  const shellCount = Math.round(config.geodesicShells);
  const spinSpeed  = config.geodesicSpin;
  const glow       = config.geodesicGlow;

  if (shells.length === 0) resetGeodesic();

  // ── Beat detection ──────────────────────────────────────────────────────
  let onBeat = false;
  if (state.detectedBPM > 0 && state.isPlaying) {
    const pos      = audioEngine.getPlaybackPosition();
    const adjusted = pos - state.beatOffset;
    const beatIdx  = adjusted >= 0 ? Math.floor(adjusted / state.beatIntervalSec) : -1;
    if (beatIdx >= 0 && beatIdx !== lastBeatIndex) {
      lastBeatIndex = beatIdx;
      onBeat = true;
    }
  }

  // ── Clear ───────────────────────────────────────────────────────────────
  p.background(0);
  (p as any).colorMode(p['HSB'], 360, 100, 100, 100);
  p.blendMode(p['ADD']);
  p.noFill();

  const cx    = p.width  * 0.5;
  const cy    = p.height * 0.5;
  const baseR = Math.min(p.width, p.height) * 0.45;
  const fov   = 3.2; // perspective eye distance from origin

  // Per-frame projected vertex arrays (reused per shell to avoid allocation)
  const vpx = new Float32Array(N_VERTS);
  const vpy = new Float32Array(N_VERTS);
  const vpz = new Float32Array(N_VERTS);

  for (let si = 0; si < Math.min(shellCount, MAX_SHELLS); si++) {
    const shell  = shells[si];
    const band   = SHELL_BANDS[si];
    const amp    = Math.min(1, amps[band] * 1.5);
    const tMult  = Math.min(2.0, transients[band]); // transient flash
    const hue    = SHELL_HUES[si];
    const radius = SHELL_SCALES[si] * baseR * (1 + amp * 0.2);

    // ── Angular velocity update ──────────────────────────────────────────
    const drift    = SHELL_DRIFT[si];
    const targetVX = drift[0] * spinSpeed;
    const targetVY = drift[1] * spinSpeed;
    const targetVZ = drift[2] * spinSpeed;

    // Audio energy amplifies rotation speed
    const boost = amp * 0.004 * spinSpeed * dt;
    shell.vx += boost * 0.6;
    shell.vy += boost;
    shell.vz += boost * 0.4;

    // Relax toward natural drift (soft spring)
    shell.vx += (targetVX - shell.vx) * 0.025 * dt;
    shell.vy += (targetVY - shell.vy) * 0.025 * dt;
    shell.vz += (targetVZ - shell.vz) * 0.025 * dt;

    // Beat impulse: alternating direction per shell for visible contrast
    if (onBeat) {
      const dir = si % 2 === 0 ? 1 : -1;
      shell.vx += 0.06 * dir;
      shell.vy += 0.09;
      shell.vz += 0.03 * dir;
    }

    shell.rx += shell.vx * dt;
    shell.ry += shell.vy * dt;
    shell.rz += shell.vz * dt;

    // ── Project vertices to 2-D ──────────────────────────────────────────
    const cX = Math.cos(shell.rx), sX = Math.sin(shell.rx);
    const cY = Math.cos(shell.ry), sY = Math.sin(shell.ry);
    const cZ = Math.cos(shell.rz), sZ = Math.sin(shell.rz);

    for (let vi = 0; vi < N_VERTS; vi++) {
      let w = GEO.verts[vi];
      w = rotX(w, cX, sX);
      w = rotY(w, cY, sY);
      w = rotZ(w, cZ, sZ);
      const d = fov + w[2]; // perspective denominator
      vpx[vi] = cx + (w[0] / d) * radius * fov;
      vpy[vi] = cy + (w[1] / d) * radius * fov;
      vpz[vi] = w[2];
    }

    // ── Visual parameters ────────────────────────────────────────────────
    const bright    = Math.min(100, 50 + amp * 40 + (tMult - 1) * 25);
    const baseAlpha = 40 + amp * 30;
    const swBase    = Math.max(0.5, (p.width / 900) * (0.7 + glow * 0.4));

    // ── Draw edges ───────────────────────────────────────────────────────
    for (const [a, b] of GEO.edges) {
      const axp = vpx[a], ayp = vpy[a], azp = vpz[a];
      const bxp = vpx[b], byp = vpy[b], bzp = vpz[b];

      // Depth-based dimming: edges at the back of the sphere are more transparent
      const depthFac = 0.3 + ((azp + bzp) * 0.5 + 1) * 0.35; // [0.3, 1.0]
      const alpha    = depthFac * baseAlpha;

      // Outer glow halo
      p.strokeWeight(swBase * 5.5 * glow);
      p.stroke(hue, 80, bright, alpha * 0.07 * glow);
      p.line(axp, ayp, bxp, byp);

      // Mid-tone pass
      p.strokeWeight(swBase * 2.0);
      p.stroke(hue, 65, bright, alpha * 0.30);
      p.line(axp, ayp, bxp, byp);

      // Bright core (slightly shifted hue for iridescence)
      p.strokeWeight(swBase * 0.8);
      p.stroke((hue + 25) % 360, 35, 100, alpha * 0.88);
      p.line(axp, ayp, bxp, byp);
    }

    // ── Draw vertex nodes (original 12 icosahedron corners) ──────────────
    p.noStroke();
    const nodeSz = (2.5 + amp * 2.5) * swBase;
    const drawN  = Math.min(12, N_VERTS); // always the base icosahedron vertices
    for (let vi = 0; vi < drawN; vi++) {
      const vx  = vpx[vi], vy = vpy[vi], vz = vpz[vi];
      const df  = 0.35 + (vz + 1) * 0.325;
      const nA  = df * (baseAlpha + 20);

      // Outer glow blob
      p.fill(hue, 70, bright, nA * 0.10 * glow);
      p.circle(vx, vy, nodeSz * 5.5 * glow);

      // Bright core dot
      p.fill((hue + 20) % 360, 28, 100, nA * 0.9);
      p.circle(vx, vy, nodeSz);
    }
    p.noFill();
  }

  // ── Restore defaults ────────────────────────────────────────────────────
  p.blendMode(p['BLEND']);
  (p as any).colorMode(p['RGB'], 255, 255, 255, 255);
}
